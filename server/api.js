import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { q, now, tx, scrub, keepForAgency, UPLOAD_DIR, getSetting, setSetting, createStages, agencyStageName, DEFAULT_CRITERIA, DEFAULT_INTERVIEW_STAGES } from './db.js';
import { sendMail, sendTemplate, sendTest, foldedInto, mailConfigured, candidateMailOn, notify, appUrl } from './mail.js';
import { registerAutofill } from './autofill.js';
import { registerOracle, callFilesOf, removeCallFiles, detachCallsFrom, forgetDraftsFor, moveCalls, moveCallsToEntry, moveEntryCallsToRecord, forgetSavedNote } from './oracle.js';
import { registerMetaview, conversationsWith, forgetConversations } from './metaview.js';
import { webUrl, checkLink, profileUrl, identityKey } from './links.js';
import * as reporting from './reporting.js';
import * as todos from './todos.js';
import { registerCycles } from './cycles.js';
import * as board from './board.js';
import * as reviews from './reviews.js';
import * as messages from './messages.js';
import * as jobDescription from './jobdescription.js';
import { registerNoteMail, noteWritten } from './note-mail.js';

export const api = express.Router();
// Parsed here rather than app-wide, so a malformed body is answered by this router's error handler and its contents
// (which may include a password) never reach the server log.
api.use(express.json({ limit: '1mb' }));

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
/** Refuse the request. `extra` adds fields to the answer for screens that can do more than show the message. */
const bad = (message, status = 400, extra) => { throw new HttpError(status, message, extra); };
const isAgency = (u) => u.role !== 'client';
// Someone saved to The Book without a job has no client at all: only the agency sees them.
const canSee = (u, clientId) => isAgency(u) || (clientId != null && u.client_id === clientId);
const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : null) || null;
const int = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));
const json = (v, fallback) => { try { return JSON.parse(v); } catch { return fallback; } };
const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
// Invisible and control characters are refused as well as spaces, so an address cannot be dressed up to look like another one.
const validEmail = (e) => typeof e === 'string' && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !/[\p{Cc}\p{Cf}\p{Z}]/u.test(e);
/** An email address as typed into a form. Anything that is not text counts as not given. */
const emailOf = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
/** Single-line text from untrusted input: control characters removed, whitespace collapsed, length capped. */
const clean = (v, max = 200) =>
  (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '') || null;
/** Multi-line free text with a length cap. */
const text = (v, max = 6000) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '') || null;
/** Links are only stored when they are http(s); a bare domain gets https:// in front. */
const safeUrl = (v) => webUrl(clean(v, 300));
/** For forms filled in by the agency: a link that was typed but is not a usable web address is refused, not silently dropped. */
function linkField(value, label) {
  const url = safeUrl(value);
  if (clean(value, 300) && !url) bad(`${label} does not look like a web address.`);
  return url;
}
/** The profile link on a form the agency fills in. One that cannot be stored whole is refused with the reason, never cut short. */
function profileField(value) {
  const { url, problem } = checkLink(value);
  if (problem === 'too_long') bad('That link is too long. Paste the address of the profile page itself, without the extra text after it.');
  if (problem) bad('The profile link does not look like a web address.');
  return url;
}
/** A name reduced to its words: lower case, accents and punctuation removed. */
const nameWords = (name) =>
  String(name || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/**
 * Could these two names belong to one person? Yes when the first and last names agree, or when one name is the
 * other with something added ("Ana Ruiz" and "Ana Ruiz Ortega", "Dr Sam Cole" and "Sam Cole"). Anything else is
 * treated as a different person, which is the safe answer: the caller then asks instead of merging two people.
 */
function samePerson(a, b) {
  const x = nameWords(a), y = nameWords(b);
  if (!x.length || !y.length) return false;
  if (x[0] === y[0] && x.at(-1) === y.at(-1)) return true;
  const [few, many] = x.length <= y.length ? [x, y] : [y, x];
  return few.every((word) => many.includes(word));
}
const pw = (v) => (typeof v === 'string' ? v : '');
const isStr = (v) => typeof v === 'string';
/** A first name is only used in emails when it is plainly a name; otherwise the greeting stays neutral. */
const greetingName = (name) => {
  const first = String(name || '').split(/\s+/)[0];
  return /^[\p{L}\p{M}'’-]{1,40}$/u.test(first) ? first : 'there';
};
/** Rate limits count per IPv4 address, or per /64 for IPv6 (one subscriber controls a whole /64). */
function addressKey(ip = '') {
  if (!ip.includes(':')) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).join(':')}::/64`;
}

const hashPassword = (pw, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
function verifyPassword(pw, stored) {
  const [salt, hex] = String(stored).split(':');
  if (!salt || !hex) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 32), Buffer.from(hex, 'hex'));
}
// Checked when no account matches, so a wrong email costs the same time as a wrong password.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

const publicUser = (u) => u && { id: u.id, name: u.name, email: u.email, role: u.role, client_id: u.client_id, title: u.title, active: u.active };
function publicClient(c, user) {
  if (isAgency(user)) return c;
  const { monthly_retainer, fee_percent, engagement_model, ...rest } = c;
  return rest;
}

// Small in-memory limiter for the unauthenticated endpoints (login, public applications).
const hits = new Map();
const recentHits = (key, windowMs) => (hits.get(key) || []).filter((t) => t > Date.now() - windowMs);
function pruneHits() {
  const cutoff = Date.now() - 3600000;
  for (const [key, times] of hits) if (!times.some((t) => t > cutoff)) hits.delete(key);
}
setInterval(pruneHits, 10 * 60000).unref();
/** Record one hit for `key`; false when it already has `max` hits inside the window. */
function takeHit(key, max, windowMs) {
  if (hits.size > 50000) pruneHits();
  if (hits.size > 50000) {
    // Still full of live entries: drop the oldest tenth so memory stays bounded and genuine newcomers are never refused.
    let drop = 5000;
    for (const k of hits.keys()) { if (drop-- <= 0) break; hits.delete(k); }
  }
  const recent = recentHits(key, windowMs);
  if (recent.length >= max) return false;
  recent.push(Date.now());
  hits.set(key, recent);
  return true;
}
const TOO_MANY = 'Too many attempts. Please try again in a few minutes.';
const rateLimit = (name, max, windowMs) => (req, res, next) =>
  takeHit(`${name}:${addressKey(req.ip)}`, max, windowMs) ? next() : res.status(429).json({ error: TOO_MANY });

const ALLOWED_RESUME = ['.pdf', '.doc', '.docx', '.rtf', '.txt'];
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase()),
  }),
  // Every limit is explicit: multer's defaults allow unlimited text fields, which would let one request exhaust memory.
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 30, parts: 32, fieldSize: 200 * 1024, fieldNameSize: 100 },
  defParamCharset: 'utf8', // browsers send file names in UTF-8; read as Latin-1, "résumé.pdf" is stored as "rÃ©sumÃ©.pdf"
  fileFilter: (req, file, cb) =>
    ALLOWED_RESUME.includes(path.extname(file.originalname).toLowerCase())
      ? cb(null, true)
      : cb(new HttpError(400, 'Résumé must be a PDF, Word, RTF or text file.')),
});
const removeUpload = (name) => { if (name) fs.rm(path.join(UPLOAD_DIR, path.basename(name)), { force: true }, () => {}); };
/** Whether two uploaded files hold exactly the same bytes. A file that cannot be read counts as different. */
function sameUpload(one, other) {
  try {
    const [a, b] = [one, other].map((name) => path.join(UPLOAD_DIR, path.basename(name)));
    return fs.statSync(a).size === fs.statSync(b).size && fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch { return false; }
}
/** The SHA-256 of an uploaded file's bytes, or null when it cannot be read (which then matches nothing). */
function uploadHash(name) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(UPLOAD_DIR, path.basename(name)))).digest('hex'); } catch { return null; }
}
/**
 * Somebody sent this client this résumé themselves, with their own application (inside the transaction that saves
 * it): its fingerprint is kept in sent_resumes (see db.js and clientsCopy). A file that cannot be read keeps nothing.
 */
function recordSent(clientId, file, at) {
  const hash = uploadHash(file);
  if (hash) q.run('INSERT INTO sent_resumes (client_id, hash, sent_at) VALUES (?, ?, ?)', clientId, hash, at);
}

// Candidate photos. Only real JPEG, PNG or WebP files are kept: the type is checked from the file's first bytes,
// not its name, because the file is later shown inside the workspace.
const PHOTO_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const MAX_PHOTO = 3 * 1024 * 1024;
const candidateUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 2, fields: 30, parts: 34, fieldSize: 200 * 1024, fieldNameSize: 100 },
  defParamCharset: 'utf8',
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.fieldname === 'photo') return Object.hasOwn(PHOTO_TYPES, ext) ? cb(null, true) : cb(new HttpError(400, 'Photos need to be JPEG, PNG or WebP images.'));
    return ALLOWED_RESUME.includes(ext) ? cb(null, true) : cb(new HttpError(400, 'Résumé must be a PDF, Word, RTF or text file.'));
  },
}).fields([{ name: 'resume', maxCount: 1 }, { name: 'photo', maxCount: 1 }]);

const MAX_PHOTO_PIXELS = 40_000_000; // far beyond any portrait; a picture larger than this is only there to use up memory
/**
 * The width and height an image file states, read from its own structure (JPEG frame header, PNG IHDR, WebP
 * VP8/VP8L/VP8X), or null when it has none: a file that only starts with an image's first bytes is not an image.
 */
function imageSize(buf) {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && buf.toString('latin1', 12, 16) === 'IHDR') {
    return { type: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return { type: 'image/webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8L' && buf[20] === 0x2f) { const bits = buf.readUInt32LE(21); return { type: 'image/webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }; }
    if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) return { type: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    return null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    // Walk the segments to the frame header (SOF0 to SOF15, apart from the three markers in that range that are tables).
    for (let at = 2; at + 9 < buf.length;) {
      if (buf[at] !== 0xff) return null;
      const marker = buf[at + 1];
      if (marker === 0xff) { at++; continue; } // padding
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { type: 'image/jpeg', width: buf.readUInt16BE(at + 7), height: buf.readUInt16BE(at + 5) };
      if (marker === 0xd9 || marker === 0xda) return null; // the picture data starts, and no frame header came first
      at += 2 + ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 ? 0 : buf.readUInt16BE(at + 2));
    }
  }
  return null;
}

/** The uploaded photo's file name if it really is an image of the type its name says, of a sane size in bytes and pixels; otherwise it is deleted. */
function acceptPhoto(file) {
  if (!file) return null;
  let ok = false;
  try {
    // The frame header of a JPEG follows its metadata, which cameras and phones can make long.
    const head = Buffer.alloc(Math.min(file.size, 512 * 1024));
    const fd = fs.openSync(file.path, 'r');
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const image = imageSize(head);
    ok = Boolean(image) && image.type === PHOTO_TYPES[path.extname(file.filename)] && file.size <= MAX_PHOTO
      && image.width > 0 && image.height > 0 && image.width * image.height <= MAX_PHOTO_PIXELS;
  } catch { ok = false; }
  if (!ok) removeUpload(file.filename);
  return ok ? file.filename : null;
}
/** Whether this person may see candidate photos: the agency always; client users unless the agency has switched it off. */
const seesPhotos = (user) => isAgency(user) || getSetting('client_photos', '1') === '1';
/** Lists carry a short version tag for the photo instead of the file name; it changes when the photo does. */
const photoTag = (file) => (file ? file.slice(0, 8) : null);
const hidePhotos = (rows, user) => (seesPhotos(user) ? rows : rows.map((r) => ({ ...r, photo: null })));

/**
 * A line for a profile's history. `at` gives it a moment other than now. `agencyOnly` keeps it from the client's
 * hiring team by writing it to the agency's own table (see agency_activities in db.js): the hiring team is shown
 * from `activities` and nothing else, so such a line is never where it could be shown to them.
 */
const logActivity = (applicationId, userId, type, detail, { at = now(), agencyOnly = false } = {}) =>
  q.run(`INSERT INTO ${agencyOnly ? 'agency_activities' : 'activities'} (application_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)`, applicationId, userId, type, detail, at);

const SOURCE_LABELS = {
  careers_page: 'Careers page', agency_sourced: 'Agency sourced', referral: 'Referral',
  linkedin: 'LinkedIn', job_board: 'Job board', other: 'Other',
  // The agency's own job board (see board.js). Only an application made there carries it: it is not offered when a
  // candidate is added by hand.
  [board.SOURCE]: 'Our website',
};
/** A source as this person reads it. "Our website" is the agency's; to a client's hiring team it is the agency's website, not theirs. */
const sourceLabel = (source, user) => (source === board.SOURCE && !isAgency(user) ? 'Agency website' : SOURCE_LABELS[source] || source);

// ---------- session ----------
function readSession(req) {
  const match = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (!match) return null;
  const row = q.get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`,
    match[1], now());
  if (row) row.sid = match[1];
  return row || null;
}
function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  q.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, new Date(Date.now() + 30 * DAY).toISOString());
  // A wrong "https" claim cannot hurt here: a browser on plain http simply refuses to store a Secure cookie.
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}${secure}`);
}

// ---------- unauthenticated: setup + login ----------
api.get('/bootstrap', (req, res) => {
  res.json({ needsSetup: !q.get('SELECT 1 AS x FROM users LIMIT 1'), agencyName: getSetting('agency_name', '') });
});

api.post('/setup', (req, res) => {
  if (q.get('SELECT 1 AS x FROM users LIMIT 1')) bad('This workspace is already set up.', 403);
  const { agencyName, name, email, password } = req.body || {};
  if (!clean(agencyName) || !clean(name) || !validEmail(email)) bad('Agency name, your name and a valid email are required.');
  if (pw(password).length < 8) bad('Choose a password of at least 8 characters.');
  setSetting('agency_name', clean(agencyName, 120));
  const id = q.insert('INSERT INTO users (email, password_hash, name, role, title, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    email.trim().toLowerCase(), hashPassword(password), clean(name, 120), 'admin', 'Founder', now());
  startSession(req, res, id);
  res.json({ ok: true });
});

api.post('/login', rateLimit('login', 20, 10 * 60000), (req, res) => {
  const { email, password } = req.body || {};
  // An account request that is still waiting is not an account yet: it has no password, and it answers exactly like
  // an address nobody has registered, so signing in cannot be used to find out who has asked for access.
  const user = q.get('SELECT * FROM users WHERE email = ? AND pending = 0', emailOf(email).slice(0, 200));
  const matches = verifyPassword(pw(password), user ? user.password_hash : DUMMY_HASH);
  if (!user || !matches) bad('That email and password do not match.', 401);
  // Only someone who knows the password learns the state of the account.
  if (!user.active) bad('This account has been deactivated.', 403);
  startSession(req, res, user.id);
  res.json({ ok: true });
});

// ---------- unauthenticated: creating an account ----------
const PENDING_DAYS = 14;
/** Requests nobody has answered are dropped after two weeks, so abandoned or junk ones cannot pile up and close sign-up. */
const expireAccountRequests = () => q.run('DELETE FROM users WHERE pending = 1 AND created_at < ?', daysAgo(PENDING_DAYS));
expireAccountRequests();
/** Never matches any password. Stored on an account request, which has no password until its owner sets one from the approval link. */
const unusableHash = () => `!${crypto.randomBytes(16).toString('hex')}`;
/** Anything in typed text that an email program would turn into a link: an address with a scheme, a www. name, or a bare domain. */
const LINK_LIKE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*|(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}(?:[/:?#]\S*)?/giu;
const withoutLinks = (value) => (value ? value.replace(LINK_LIKE, '[link removed]') : value);

// Anyone may ask for an account. A request is not an account: it holds no password and cannot sign in. When an agency
// user approves it, the person is sent a one-time link to set their password, so only whoever reads that mailbox can
// take up the access that was approved.
api.post('/signup', (req, res) => {
  if (!q.get('SELECT 1 AS x FROM users LIMIT 1')) bad('This workspace has not been set up yet.', 403);
  const b = req.body || {};
  const email = emailOf(b.email);
  const name = clean(b.name, 120), company = clean(b.company, 160), title = clean(b.title, 120);
  if (!name || !validEmail(email)) bad('Your name and a valid email are required.');
  // Counted only once the form is complete, so a typing mistake does not use up an office's allowance.
  if (!takeHit(`signup:${addressKey(req.ip)}`, 20, 60 * 60000)) bad('Too many account requests have come from your network. Please try again in about an hour.', 429);
  expireAccountRequests();
  if (q.get('SELECT COUNT(*) AS n FROM users WHERE pending = 1').n >= 200) bad('Account requests are paused for now. Please contact the agency directly.', 429);
  // Same answer whether or not the address is already known, and a write either way so the two cases take the same time.
  if (q.get('SELECT 1 AS x FROM users WHERE email = ?', email)) {
    q.run('UPDATE users SET email = email WHERE email = ?', email);
  } else {
    q.run(`INSERT INTO users (email, password_hash, name, role, client_id, title, active, pending, requested_company, created_at)
           VALUES (?, ?, ?, 'client', NULL, ?, 0, 1, ?, ?)`, email, unusableHash(), name, title, company, now());
    // Tell the agency's admins. Not awaited (the response must take the same time either way) and capped per hour,
    // so a burst of fake sign-ups cannot flood their inboxes.
    if (takeHit('notify:signup', 20, 60 * 60000)) {
      const admins = q.all(`SELECT email FROM users WHERE role = 'admin' AND active = 1`).map((u) => u.email);
      const link = appUrl() ? `${appUrl()}/settings?tab=team` : 'Settings, then Team, in your hiring workspace';
      // The message goes out under the agency's own name, so nothing the visitor typed is allowed to steer it: the
      // subject is fixed, each typed value sits on its own labelled line, and links are taken out of the free text.
      notify({
        to: admins,
        subject: 'New account request',
        body: `Someone has asked for an account in your hiring workspace. They typed these details, and none of them have been verified:\n\n` +
          `Name: ${withoutLinks(name)}\nEmail: ${email}\nCompany: ${withoutLinks(company) || 'not given'}\nJob title: ${withoutLinks(title) || 'not given'}\n\n` +
          `Nothing is granted until you approve the request. If you approve it, the person is sent a link to set their password at the email address above.\n\n` +
          `Approve or decline: ${link}\n`,
      });
    }
  }
  res.json({ ok: true });
});

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
// An invitation is only as good as the person behind it: it stops working when its creator is deactivated or
// removed, and one that grants agency access also stops if its creator is no longer an admin.
const INVITER_STILL_ALLOWED = `u.active = 1 AND (i.role = 'client' OR u.role = 'admin')`;
function loadInvite(token) {
  const inv = /^[a-f0-9]{48}$/.test(token || '')
    ? q.get(`SELECT i.*, c.name AS client_name, (${INVITER_STILL_ALLOWED}) AS inviter_ok
             FROM invites i LEFT JOIN clients c ON c.id = i.client_id LEFT JOIN users u ON u.id = i.created_by WHERE i.token_hash = ?`, hashToken(token))
    : null;
  if (!inv || inv.used_at || inv.expires_at < now() || !inv.inviter_ok || (inv.role === 'client' && !inv.client_id)) bad('This invitation link is no longer valid. Please ask for a new one.', 404);
  return inv;
}
/** Store a new one-time invitation and return the token for its link. Only the token's hash is kept. */
function createInvite({ role, clientId, email, createdBy }) {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * DAY).toISOString();
  q.run('INSERT INTO invites (token_hash, role, client_id, email, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    hashToken(token), role, clientId, email, createdBy, now(), expiresAt);
  return { token, expires_at: expiresAt };
}

api.get('/invites/:token', rateLimit('invite', 40, 10 * 60000), (req, res) => {
  const inv = loadInvite(req.params.token);
  res.json({ role: inv.role, clientName: inv.client_name, email: inv.email, agencyName: getSetting('agency_name', '') });
});

api.post('/invites/:token/accept', rateLimit('invite', 40, 10 * 60000), (req, res) => {
  const inv = loadInvite(req.params.token);
  const b = req.body || {};
  const email = inv.email || emailOf(b.email);
  const name = clean(b.name, 120);
  if (!name || !validEmail(email)) bad('Your name and a valid email are required.');
  if (pw(b.password).length < 8) bad('Choose a password of at least 8 characters.');
  const clientId = inv.role === 'client' ? inv.client_id : null;
  let theirJobs = [];   // the jobs a deactivated person coming back was account executive of
  const id = tx(() => {
    const existing = q.get('SELECT * FROM users WHERE email = ?', email);
    // A deactivated account comes back only when the agency invited that exact address: an open link must not be
    // a way to take over whichever old account its holder happens to name.
    const reactivate = existing && !existing.pending && !existing.active && Boolean(inv.email);
    if (existing && !existing.pending && !reactivate) {
      // An open link could otherwise be used to test which addresses have accounts; a handful of tries is plenty for a typing mistake.
      if (!inv.email && !takeHit(`invite-taken:${inv.id}`, 5, 60 * 60000)) bad(TOO_MANY, 429);
      bad('An account with this email already exists. Sign in instead, or ask for it to be reactivated.');
    }
    // Claim the invitation first; if another request used it a moment ago, nothing is created.
    if (!q.run('UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL', now(), inv.id).changes) bad('This invitation link has already been used.', 404);
    if (reactivate) {
      q.run('UPDATE users SET password_hash = ?, name = ?, role = ?, client_id = ?, title = ?, active = 1 WHERE id = ?',
        hashPassword(b.password), name, inv.role, clientId, clean(b.title, 120) ?? existing.title, existing.id);
      q.run('DELETE FROM sessions WHERE user_id = ?', existing.id);
      // An account executive is somebody on the agency's team. Whoever comes back as a client's user is no longer one.
      // Either way their jobs' people to prep and debrief change hands (see after the change is saved).
      theirJobs = q.all('SELECT id FROM jobs WHERE account_executive_id = ?', existing.id).map((j) => j.id);
      if (inv.role === 'client') q.run('UPDATE jobs SET account_executive_id = NULL WHERE account_executive_id = ?', existing.id);
      return existing.id;
    }
    if (existing) q.run('DELETE FROM users WHERE id = ? AND pending = 1', existing.id); // an unanswered request for the same address is settled by this invitation
    return q.insert('INSERT INTO users (email, password_hash, name, role, client_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      email, hashPassword(b.password), name, inv.role, clientId, clean(b.title, 120), now());
  });
  // Back on the team, their jobs' people to prep and debrief come back to them; back as a client's user, those
  // jobs have no account executive now and the items go to the recruiter who owns each candidate.
  for (const jobId of theirJobs) todos.accountExecutiveChanged(jobId);
  startSession(req, res, id);
  if (clientId) board.clientChanged(clientId); // somebody new at a client: their name must not be in a confidential post either
  res.json({ ok: true });
});

// ---------- unauthenticated: public careers site ----------
// A job is on its client's careers page while it is open, unless the agency advertises it on its own job board only
// (see board.js). Such a job is left out here exactly as a job that is not open is, with nothing to say why.
const ON_CAREERS = `status = 'open' AND id NOT IN (${board.OFF_CAREERS})`;
const publicJobCols = `id, title, department, location, work_mode, employment_type,
  CASE WHEN salary_public = 1 THEN salary_min END AS salary_min, CASE WHEN salary_public = 1 THEN salary_max END AS salary_max`;
function careersClient(slug) {
  const c = q.get(`SELECT id, name, slug, brand_color, tagline, about, website, privacy_url, location, industry, currency FROM clients WHERE slug = ? AND status != 'ended'`, slug);
  if (!c) bad('This careers page does not exist.', 404);
  return c;
}

api.get('/public/careers/:slug', (req, res) => {
  const client = careersClient(req.params.slug);
  const jobs = q.all(`SELECT ${publicJobCols} FROM jobs WHERE client_id = ? AND ${ON_CAREERS} ORDER BY department, title`, client.id);
  res.json({ client, jobs });
});

api.get('/public/careers/:slug/jobs/:id', (req, res) => {
  const client = careersClient(req.params.slug);
  const job = q.get(`SELECT ${publicJobCols}, description, questions FROM jobs WHERE id = ? AND client_id = ? AND ${ON_CAREERS}`, int(req.params.id), client.id);
  if (!job) bad('This role is no longer open.', 404);
  job.questions = json(job.questions, []);
  res.json({ client, job, agencyName: getSetting('agency_name', '') });
});

const PUBLIC_SOURCES = ['careers_page', 'linkedin', 'job_board', 'referral'];

/**
 * Save an application made on a public form: the client's careers page, or the agency's own job board. Resolves to
 * { appId }, or to { duplicate: <the application's id> } when this address is already in the job, in which case
 * nothing is saved. `detail` is the line for the candidate's history; `also` runs with the new application's id
 * before the save is final, for a caller that has something of its own to store with it.
 */
function receiveApplication({ client, job, name, email, phone, linkedin, location, answers, coverNote, file, source, detail, also }) {
  return tx(() => {
    let cand = q.get('SELECT * FROM candidates WHERE client_id = ? AND email = ?', client.id, email);
    const existing = cand;
    if (cand) {
      const already = q.get('SELECT id FROM applications WHERE candidate_id = ? AND job_id = ?', cand.id, job.id);
      if (already) return { duplicate: already.id };
      // An anonymous form must never change an existing person's record: nobody has shown they own this address.
    } else {
      const id = q.insert('INSERT INTO candidates (client_id, name, email, phone, linkedin, location, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        client.id, name, email, phone, linkedin, location, now());
      cand = { id };
    }
    const stage = q.get(`SELECT id FROM stages WHERE job_id = ? AND kind = 'applied'`, job.id);
    const t = now();
    const appId = q.insert(
      `INSERT INTO applications (candidate_id, job_id, stage_id, source, answers, cover_note, resume_file, resume_name, consent_at, applied_at, stage_entered_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      cand.id, job.id, stage.id, source, JSON.stringify(answers), coverNote,
      file?.filename ?? null, clean(file?.originalname, 200), t, t, t, t);
    q.run('INSERT INTO stage_history (application_id, stage_id, entered_at) VALUES (?, ?, ?)', appId, stage.id, t);
    logActivity(appId, null, 'applied', detail);
    // They sent this client this résumé themselves: its fingerprint is kept (see clientsCopy).
    if (file) recordSent(client.id, file.filename, t);
    // Anyone can type any link here, so it never joins this applicant to an existing record. If it is the profile
    // link of someone already on file, both records are kept and the team is told, so a person can decide.
    const key = existing ? null : identityKey(linkedin);
    const twin = key && q.get('SELECT name FROM candidates WHERE client_id = ? AND linkedin = ? AND id != ? ORDER BY id LIMIT 1', client.id, key, cand.id);
    if (twin) logActivity(appId, null, 'applied', `Possible duplicate of ${twin.name} (same LinkedIn link)`);
    if (existing) {
      const given = [existing.name !== name && `name “${name}”`, phone && phone !== existing.phone && `phone ${phone}`,
        linkedin && linkedin !== existing.linkedin && `link ${linkedin}`, location && location !== existing.location && `location ${location}`].filter(Boolean);
      if (given.length) logActivity(appId, null, 'applied', `Details typed on this application differ from the record and were not applied (unverified): ${given.join(', ')}`);
    }
    also?.(appId);
    return { appId };
  });
}
/**
 * How many e-mails this address has been sent in the last hour. The address on a public form is unverified, so
 * confirmations to any one address are capped. What the agency sent somebody before they were put on a job is kept in
 * a table of its own (see agency_emails in db.js) and counts the same.
 */
const recentlyMailed = (email) => q.get(
  `SELECT (SELECT COUNT(*) FROM emails WHERE to_email = ?1 AND created_at > ?2) + (SELECT COUNT(*) FROM agency_emails WHERE to_email = ?1 AND created_at > ?2) AS n`,
  email, new Date(Date.now() - 3600000).toISOString()).n;

api.post('/public/careers/:slug/jobs/:id/apply', rateLimit('apply', 10, 10 * 60000), upload.single('resume'), async (req, res) => {
  let stored = false; // true once the uploaded résumé belongs to a saved application
  try {
    const client = q.get(`SELECT * FROM clients WHERE slug = ? AND status != 'ended'`, req.params.slug);
    const job = client && q.get(`SELECT * FROM jobs WHERE id = ? AND client_id = ? AND ${ON_CAREERS}`, int(req.params.id), client.id);
    if (!job) bad('This role is no longer open.', 404);
    const b = req.body || {};
    if (b.company_website) return res.json({ ok: true }); // honeypot field, filled only by bots
    const email = emailOf(b.email);
    const name = clean(b.name, 120);
    if (!name || /:\/\/|www\./i.test(name) || !validEmail(email)) bad('Please enter your name and a valid email address.');
    if (b.consent !== 'yes') bad('Please confirm that we may process your application.');

    const questions = json(job.questions, []);
    const parsed = json(b.answers, {});
    const given = parsed && typeof parsed === 'object' ? parsed : {};
    const answers = [];
    for (const question of questions) {
      const answer = text(given[question.id], 4000);
      if (question.required && !answer) bad(`Please answer: ${question.label}`);
      answers.push({ question: question.label, answer: answer || '' });
    }
    const source = PUBLIC_SOURCES.includes(b.source) ? b.source : 'careers_page';

    const result = receiveApplication({
      client, job, name, email, phone: clean(b.phone, 40), linkedin: profileUrl(b.linkedin), location: clean(b.location, 120),
      answers, coverNote: text(b.cover_note, 6000), file: req.file, source, detail: `Applied via ${SOURCE_LABELS[source].toLowerCase()}`,
    });
    stored = Boolean(result.appId);

    // Somebody already in this job is not written to again, with one exception: a person who came through the
    // agency's confidential post has not been told that it is this job, so the first time they apply here this form
    // answers them exactly as it would a new applicant. Otherwise the missing confirmation would tell them which
    // employer the post was for. After that first time they are a repeat applicant here like any other.
    const confirm = result.appId ?? board.appliedAgainDirectly(result.duplicate, logActivity);
    // The address is unverified, so cap how many confirmations any one address can be sent.
    if (confirm && recentlyMailed(email) < 3) {
      await sendTemplate('application_received', {
        applicationId: confirm, to: email,
        vars: { candidate_first_name: greetingName(name), candidate_name: name, job_title: job.title, company: client.name, sender_name: client.name },
      });
    }
    res.json({ ok: true });
  } finally {
    if (!stored) removeUpload(req.file?.filename);
  }
});

// The agency's own job board: its public pages, feed and application form. No sign-in, like the careers pages above.
board.registerPublicBoard(api, { bad, clean, text, emailOf, validEmail, greetingName, rateLimit, upload, removeUpload, logActivity, receiveApplication, recentlyMailed, profileUrl, PHOTO_TYPES });

// ---------- everything below requires a signed-in user ----------
api.use((req, res, next) => {
  req.user = readSession(req);
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  // A client user with no client would otherwise be scoped to "everything". That state should never exist; refuse it outright.
  if (req.user.role === 'client' && !req.user.client_id) return res.status(403).json({ error: 'This account is not linked to a company yet.' });
  next();
});
api.use((req, res, next) => {
  for (const value of Object.values(req.query)) if (typeof value !== 'string') return res.status(400).json({ error: 'That request could not be read.' });
  next();
});
const agencyOnly = (req, res, next) => (isAgency(req.user) ? next() : res.status(403).json({ error: 'Only the agency team can do this.' }));
const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Only an agency admin can do this.' }));

// Drafting a job from a job description and intake notes lives in its own module.
registerAutofill(api, { agencyOnly, bad, clean, text, takeHit, briefFields: (b) => briefFields(b) });
// Otterview (recording calls with candidates, transcripts, notes and submission drafts) lives in its own module too.
registerOracle(api, { agencyOnly, bad, clean, int, takeHit, logActivity, loadApp: (id, user) => loadApp(id, user) });
// Metaview in Otterview (the agency's conversations recorded in Metaview, listed and brought in as calls) is a module of its own as well.
registerMetaview(api, { agencyOnly, adminOnly, bad, clean, int, takeHit });
// Reporting (the Individual and Clients reports, and the record of the moments they count) is a module of its own too.
// The routes below tell it when one of those moments happens: each call to `reporting.` is one of them.
reporting.registerReporting(api, { agencyOnly, adminOnly, bad, int, loadApp: (id, user) => loadApp(id, user) });
// To do (each agency user's own list of jobs to work on and people to prep and debrief) is a module of its own as well.
// The routes below tell it when an interview is scheduled, changed or cancelled: each call to `todos.` is one of those.
todos.registerTodos(api, { agencyOnly, bad, clean, text, int });
// Cycles (the whole team's view of which open jobs have been worked on: a job ticked on somebody's Jobs to work on is
// one cycle) reads what To do writes, and is a module of its own too.
registerCycles(api, { agencyOnly, bad, int });
// Jobs on our website (the agency's confidential adverts and what the agency does with them) is a module of its own too.
// The routes below tell it when a job, a client or somebody at a client changes, because a post has to be checked
// again each time, and ask it before anything is e-mailed to somebody who applied through a post.
board.registerBoard(api, { agencyOnly, adminOnly, bad, clean, text, int, takeHit, linkField, candidateUpload, acceptPhoto, removeUpload, logActivity,
  loadJob: (id, user) => loadJob(id, user), loadApp: (id, user) => loadApp(id, user) });
// Asking somebody on the team to review a candidate is a module of its own too. The routes below tell it when an
// application is folded into another, so that the requests about it move with it.
reviews.registerReviews(api, { agencyOnly, bad, text, int, loadApp: (id, user) => loadApp(id, user), scopeOf: (req) => scopeOf(req) });
// Messages between people on the agency team are a module of their own as well. The routes below tell it when an
// application is folded into another, so that messages about it stay on the person's profile.
messages.registerMessages(api, { agencyOnly, bad });
// E-mails to the team about notes on candidates are a module of their own too: each person's switch for them is there,
// and the routes below that write a note somebody chose to write tell it (each call to `noteWritten`).
registerNoteMail(api, { agencyOnly, bad });
// A job's description as a PDF, and the client's own file kept with the job, are a module of their own too. Both are
// the agency's: every route there is for the agency only and finds the job through loadJob, as the job's own routes do.
jobDescription.registerJobDescription(api, { agencyOnly, bad, clean, takeHit, removeUpload, ALLOWED_RESUME, HttpError,
  loadJob: (id, user) => loadJob(id, user), ownsJob: (user, job) => ownsJob(user, job), downloadAs: (name) => downloadAs(name) });

/** Client the request is scoped to: forced for client users, optional (?client_id=) for the agency. */
const scopeOf = (req) => (isAgency(req.user) ? int(req.query.client_id) : req.user.client_id);

api.post('/logout', (req, res) => {
  q.run('DELETE FROM sessions WHERE token = ?', req.user.sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

api.get('/me', (req, res) => {
  const clients = isAgency(req.user)
    ? q.all(`SELECT id, name, slug, brand_color, currency, status FROM clients ORDER BY name`)
    : q.all(`SELECT id, name, slug, brand_color, currency, status FROM clients WHERE id = ?`, req.user.client_id);
  res.json({ user: publicUser(req.user), agencyName: getSetting('agency_name', 'Agency'), clients, mailConfigured: mailConfigured(), candidateMail: candidateMailOn(), clientPhotos: getSetting('client_photos', '1') === '1' });
});

api.post('/me/password', (req, res) => {
  const { current, next } = req.body || {};
  if (!verifyPassword(pw(current), req.user.password_hash)) bad('Your current password is not correct.');
  if (pw(next).length < 8) bad('Choose a password of at least 8 characters.');
  q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(next), req.user.id);
  q.run('DELETE FROM sessions WHERE user_id = ? AND token != ?', req.user.id, req.user.sid);
  res.json({ ok: true });
});

api.get('/nav', (req, res) => {
  const cid = scopeOf(req);
  const where = cid ? 'AND j.client_id = ?' : '';
  const p = cid ? [cid] : [];
  const count = (sql, ...params) => q.get(sql, ...params).n;
  res.json({
    new_applicants: count(`SELECT COUNT(*) n FROM applications a JOIN jobs j ON j.id = a.job_id JOIN stages s ON s.id = a.stage_id
      WHERE a.status = 'active' AND s.kind = 'applied' ${where}`, ...p),
    pending_review: count(`SELECT COUNT(*) n FROM applications a JOIN jobs j ON j.id = a.job_id
      WHERE a.status = 'active' AND a.review_status = 'pending' ${where}`, ...p),
    pending_accounts: isAgency(req.user) ? count('SELECT COUNT(*) n FROM users WHERE pending = 1') : 0,
    scorecards_due: count(`SELECT COUNT(*) n FROM interviews i JOIN interview_panel p ON p.interview_id = i.id
      JOIN applications a ON a.id = i.application_id JOIN jobs j ON j.id = a.job_id
      WHERE p.user_id = ? AND i.status != 'cancelled' AND i.starts_at < ?
      AND NOT EXISTS (SELECT 1 FROM scorecards sc WHERE sc.interview_id = i.id AND sc.user_id = p.user_id) ${where}`, req.user.id, now(), ...p),
    // What is still on this person's own to-do list, whichever client the workspace is showing. The agency's only.
    ...(isAgency(req.user) ? { todo: todos.openCount(req.user.id) } : {}),
    // Confidential posts that are switched on but not public: the check, or a change to the job, stands in their way. The agency's only.
    ...(isAgency(req.user) ? { board_down: board.postsDown() } : {}),
    // Candidates somebody on the team asked this person to review, and answers that have come back to them, in view of
    // the client chosen as the Inbox shows them (`reviews`), and of those the ones for them to answer (`to_review`). The agency's only.
    ...(isAgency(req.user) ? reviews.waitingOn(req.user.id, cid) : {}),
    // Messages from the rest of the team this person has not read yet, in every conversation they are in, whichever
    // client the workspace is showing. The agency's only: a client's user is not told that messages exist.
    ...(isAgency(req.user) ? { messages: messages.unreadFor(req.user.id) } : {}),
  });
});

// ---------- settings + templates ----------
api.put('/settings', adminOnly, (req, res) => {
  if (!clean(req.body?.agencyName)) bad('Agency name is required.');
  setSetting('agency_name', clean(req.body.agencyName, 120));
  if (typeof req.body.clientPhotos === 'boolean') setSetting('client_photos', req.body.clientPhotos ? '1' : '0');
  // Whether the workspace writes to candidates at all (see candidateMailOn in mail.js). Off until an admin says so.
  if (typeof req.body.candidateMail === 'boolean') setSetting('candidate_mail', req.body.candidateMail ? '1' : '0');
  res.json({ ok: true });
});

// "Send me a test e-mail" in Settings: one e-mail to the admin who pressed it, and to nobody else. What the mail
// provider says when it refuses (a domain that is not verified yet, a wrong key) is passed on, so it can be put right.
api.post('/settings/test-email', adminOnly, rateLimit('test-email', 5, 10 * 60000), async (req, res) => {
  if (!mailConfigured()) bad('Email delivery is not connected yet.');
  try {
    await sendTest(req.user.email, getSetting('agency_name', 'your agency'));
  } catch (err) {
    console.error('Test email failed:', err.message);
    // Resend answers in JSON; its own sentence is the useful part ("The example.com domain is not verified...").
    let said = String(err.message);
    const answer = /^Resend answered (\d+): ([\s\S]*)$/.exec(said);
    try { if (answer) said = `Resend answered: ${JSON.parse(answer[2]).message || answer[2]}`; } catch { /* not JSON: said as it came */ }
    bad(`The test email was not sent. ${said.slice(0, 400)}`, 502);
  }
  res.json({ ok: true, to: req.user.email });
});

api.get('/templates', (req, res) => res.json(q.all('SELECT * FROM email_templates ORDER BY key IS NULL, id')));
api.post('/templates', agencyOnly, (req, res) => {
  const { name, subject, body } = req.body || {};
  if (!clean(name) || !clean(subject) || !text(body)) bad('Name, subject and body are required.');
  res.json({ id: q.insert('INSERT INTO email_templates (name, subject, body) VALUES (?, ?, ?)', clean(name, 120), clean(subject, 300), text(body, 20000)) });
});
api.put('/templates/:id', agencyOnly, (req, res) => {
  const { name, subject, body } = req.body || {};
  if (!clean(name) || !clean(subject) || !text(body)) bad('Name, subject and body are required.');
  q.run('UPDATE email_templates SET name = ?, subject = ?, body = ? WHERE id = ?', clean(name, 120), clean(subject, 300), text(body, 20000), int(req.params.id));
  res.json({ ok: true });
});
api.delete('/templates/:id', agencyOnly, (req, res) => {
  const t = q.get('SELECT * FROM email_templates WHERE id = ?', int(req.params.id));
  if (t?.key) bad('Built-in templates can be edited but not deleted.');
  q.run('DELETE FROM email_templates WHERE id = ?', int(req.params.id));
  res.json({ ok: true });
});

// ---------- users ----------
api.get('/users', (req, res) => {
  const cid = scopeOf(req);
  const cols = `u.id, u.name, u.email, u.role, u.client_id, u.title, u.active, u.pending, u.requested_company, u.created_at, c.name AS client_name`;
  let rows;
  if (isAgency(req.user) && !cid) rows = q.all(`SELECT ${cols} FROM users u LEFT JOIN clients c ON c.id = u.client_id ORDER BY u.role = 'client', u.name`);
  else rows = q.all(`SELECT ${cols} FROM users u LEFT JOIN clients c ON c.id = u.client_id
    WHERE u.active = 1 AND (u.role != 'client' OR u.client_id = ?) ORDER BY u.role = 'client' DESC, u.name`, cid);
  res.json(rows);
});

/** Validate the access being granted: client users need a real client; only an admin may add agency team members. */
function accessFrom(b, user) {
  const role = ['admin', 'recruiter', 'client'].includes(b.role) ? b.role : 'client';
  if (role !== 'client' && user.role !== 'admin') bad('Only an agency admin can add agency team members.', 403);
  const clientId = role === 'client' ? int(b.client_id) : null;
  if (role === 'client' && !q.get('SELECT 1 AS x FROM clients WHERE id = ?', clientId)) bad('Choose the client this person belongs to.');
  return { role, clientId };
}

// Approve an account request and decide what the person will see. Approval does not switch an account on: the
// request is replaced by a one-time invitation tied to the address it named, and the person sets their own password
// from that link. Whoever asked can only use the access if they can read that mailbox (or are handed the link).
api.post('/users/:id/approve', agencyOnly, async (req, res) => {
  const target = q.get('SELECT * FROM users WHERE id = ?', int(req.params.id));
  if (!target || !target.pending) bad('This request has already been handled.', 404);
  const { role, clientId } = accessFrom(req.body || {}, req.user);
  const invite = tx(() => {
    if (!q.run('DELETE FROM users WHERE id = ? AND pending = 1', target.id).changes) bad('This request has already been handled.', 404);
    return createInvite({ role, clientId, email: target.email, createdBy: req.user.id });
  });
  // Email the link when delivery is connected and the workspace knows its own address. The response says whether
  // that happened and carries the link, so the approver can pass it on themselves when it did not.
  const agency = getSetting('agency_name', 'the agency');
  const notified = appUrl() ? await notify({
    to: target.email,
    subject: `Your ${agency} account request was approved`,
    body: `Hi ${greetingName(target.name)},\n\nYour request for an account has been approved. Open this link to choose your password and sign in:\n\n` +
      `${appUrl()}/join/${invite.token}\n\nThe link works once and expires in 7 days. If you did not ask for an account, you can ignore this email.\n\n${agency}\n`,
  }) : false;
  res.json({ ok: true, notified, ...invite });
});

// Decline a self-registered account. Approved accounts are deactivated instead, so their history stays attributed.
api.delete('/users/:id', agencyOnly, (req, res) => {
  const target = q.get('SELECT * FROM users WHERE id = ?', int(req.params.id));
  if (!target || !target.pending) bad('Only account requests that are still waiting can be removed.', 404);
  q.run('DELETE FROM users WHERE id = ? AND pending = 1', target.id);
  res.json({ ok: true });
});

// ---------- invitations ----------
api.get('/invites', agencyOnly, (req, res) => {
  res.json(q.all(
    `SELECT i.id, i.role, i.client_id, i.email, i.created_at, i.expires_at, c.name AS client_name, u.name AS created_by_name
     FROM invites i LEFT JOIN clients c ON c.id = i.client_id LEFT JOIN users u ON u.id = i.created_by
     WHERE i.used_at IS NULL AND i.expires_at > ? AND ${INVITER_STILL_ALLOWED} ORDER BY i.created_at DESC`, now()));
});

api.post('/invites', agencyOnly, (req, res) => {
  const b = req.body || {};
  const { role, clientId } = accessFrom(b, req.user);
  const email = emailOf(b.email) || null;
  if (email && !validEmail(email)) bad('That email address does not look right.');
  // Only a working account stands in the way. Someone whose request is still waiting, or whose old account was
  // deactivated (the way back in after a forgotten password), can be invited at that address.
  if (email && q.get('SELECT 1 AS x FROM users WHERE email = ? AND active = 1', email)) bad('Someone with that email already has an account.');
  if (q.get('SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL AND expires_at > ?', now()).n >= 500) bad('There are too many unused invitations. Revoke some first.');
  res.json(createInvite({ role, clientId, email, createdBy: req.user.id })); // the only time the link can be read; just its hash is stored
});

api.delete('/invites/:id', agencyOnly, (req, res) => {
  const inv = q.get('SELECT * FROM invites WHERE id = ?', int(req.params.id));
  if (inv && inv.role !== 'client' && req.user.role !== 'admin') bad('Only an agency admin can revoke this invitation.', 403);
  q.run('DELETE FROM invites WHERE id = ?', int(req.params.id));
  res.json({ ok: true });
});

api.patch('/users/:id', agencyOnly, (req, res) => {
  const target = q.get('SELECT * FROM users WHERE id = ?', int(req.params.id));
  if (!target) bad('Not found', 404);
  if (target.role !== 'client' && req.user.role !== 'admin') bad('Only an agency admin can change agency team members.', 403);
  if (target.pending) bad('Approve or decline this account request first.');
  const b = req.body || {};
  if (b.active !== undefined && typeof b.active !== 'boolean') bad('active must be true or false.');
  if (b.active === false && target.id === req.user.id) bad('You cannot deactivate your own account.');
  if (b.password !== undefined && pw(b.password).length < 8) bad('Passwords need at least 8 characters.');
  q.run('UPDATE users SET name = ?, title = ?, active = ? WHERE id = ?',
    clean(b.name, 120) ?? target.name, b.title !== undefined ? clean(b.title, 120) : target.title, b.active === undefined ? target.active : b.active ? 1 : 0, target.id);
  if (b.password !== undefined) q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(b.password), target.id);
  if (b.password !== undefined || b.active === false) q.run('DELETE FROM sessions WHERE user_id = ?', target.id);
  // Links this person handed out stop working with them, so nobody can be let in on their say-so after they have left.
  if (b.active === false) q.run('DELETE FROM invites WHERE created_by = ? AND used_at IS NULL', target.id);
  // A deactivated account executive cannot have a to-do list: the people to prep and debrief on their jobs go to
  // whoever has them instead, and come back to them if they are made active again.
  if (b.active !== undefined && Boolean(b.active) !== Boolean(target.active) && target.role !== 'client') {
    for (const j of q.all('SELECT id FROM jobs WHERE account_executive_id = ?', target.id)) todos.accountExecutiveChanged(j.id);
  }
  // A changed name is checked for in that client's confidential posts, and whoever changed it is told if one came down.
  res.json({ ok: true, ...(target.client_id ? board.clientChanged(target.client_id) : {}) });
});

// ---------- clients ----------
const clientStats = `
  (SELECT COUNT(*) FROM jobs j WHERE j.client_id = cl.id AND j.status = 'open') AS open_jobs,
  (SELECT COUNT(*) FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.client_id = cl.id AND a.status = 'active') AS active_candidates,
  (SELECT COUNT(*) FROM applications a JOIN jobs j ON j.id = a.job_id JOIN stages s ON s.id = a.stage_id
     WHERE j.client_id = cl.id AND a.status = 'active' AND s.kind = 'applied') AS new_applicants,
  (SELECT COUNT(*) FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.client_id = cl.id AND a.status = 'hired') AS hires,
  (SELECT COUNT(*) FROM interviews i JOIN applications a ON a.id = i.application_id JOIN jobs j ON j.id = a.job_id
     WHERE j.client_id = cl.id AND i.status = 'scheduled' AND i.starts_at >= ?) AS upcoming_interviews`;

api.get('/clients', (req, res) => {
  const rows = isAgency(req.user)
    ? q.all(`SELECT cl.*, ${clientStats} FROM clients cl ORDER BY cl.status != 'active', cl.name`, now())
    : q.all(`SELECT cl.*, ${clientStats} FROM clients cl WHERE cl.id = ?`, now(), req.user.client_id);
  res.json(rows.map((c) => publicClient(c, req.user)));
});

function clientFields(b) {
  const model = ['retainer', 'per_hire', 'hybrid'].includes(b.engagement_model) ? b.engagement_model : 'retainer';
  return {
    name: clean(b.name, 120), brand_color: isStr(b.brand_color) && /^#[0-9a-f]{6}$/i.test(b.brand_color) ? b.brand_color : '#1f5443',
    website: linkField(b.website, 'The website'), privacy_url: linkField(b.privacy_url, 'The privacy notice link'), industry: clean(b.industry, 120), location: clean(b.location, 120),
    tagline: clean(b.tagline, 200), about: text(b.about, 6000),
    status: ['active', 'paused', 'ended'].includes(b.status) ? b.status : 'active',
    engagement_model: model,
    // Only the terms that belong to the chosen model are kept, so revenue never counts a figure the form no longer shows.
    monthly_retainer: model === 'per_hire' ? 0 : Math.max(0, int(b.monthly_retainer) ?? 0),
    fee_percent: model === 'retainer' ? 0 : Math.min(100, Math.max(0, Number(b.fee_percent) || 0)),
    currency: isStr(b.currency) && /^[A-Z]{3}$/.test(b.currency) ? b.currency : 'USD',
    started_at: isStr(b.started_at) && /^\d{4}-\d{2}-\d{2}$/.test(b.started_at) ? b.started_at : null,
  };
}

api.post('/clients', agencyOnly, (req, res) => {
  const f = clientFields(req.body || {});
  if (!f.name) bad('Company name is required.');
  let slug = slugify(req.body.slug || f.name) || 'company';
  for (let n = 2; q.get('SELECT 1 AS x FROM clients WHERE slug = ?', slug); n++) slug = `${slugify(req.body.slug || f.name)}-${n}`;
  const id = q.insert(
    `INSERT INTO clients (name, slug, brand_color, website, privacy_url, industry, location, tagline, about, status, engagement_model, monthly_retainer, fee_percent, currency, started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    f.name, slug, f.brand_color, f.website, f.privacy_url, f.industry, f.location, f.tagline, f.about, f.status, f.engagement_model, f.monthly_retainer, f.fee_percent, f.currency,
    f.started_at ?? now().slice(0, 10), now());
  res.json({ id });
});

api.get('/clients/:id', (req, res) => {
  const id = int(req.params.id);
  if (!canSee(req.user, id)) bad('Not found', 404);
  const client = q.get(`SELECT cl.*, ${clientStats} FROM clients cl WHERE cl.id = ?`, now(), id);
  if (!client) bad('Not found', 404);
  const team = q.all(`SELECT id, name, email, title, active FROM users WHERE client_id = ? ORDER BY active DESC, name`, id);
  res.json({ client: publicClient(client, req.user), team });
});

api.put('/clients/:id', agencyOnly, (req, res) => {
  const id = int(req.params.id);
  const existing = q.get('SELECT * FROM clients WHERE id = ?', id);
  if (!existing) bad('Not found', 404);
  const f = clientFields(req.body || {});
  if (!f.name) bad('Company name is required.');
  const slug = slugify(req.body.slug || existing.slug);
  if (!slug) bad('The careers page address cannot be empty.');
  if (q.get('SELECT 1 AS x FROM clients WHERE slug = ? AND id != ?', slug, id)) bad('Another client already uses that careers page address.');
  q.run(
    `UPDATE clients SET name = ?, slug = ?, brand_color = ?, website = ?, privacy_url = ?, industry = ?, location = ?, tagline = ?, about = ?, status = ?,
       engagement_model = ?, monthly_retainer = ?, fee_percent = ?, currency = ?, started_at = ? WHERE id = ?`,
    f.name, slug, f.brand_color, f.website, f.privacy_url, f.industry, f.location, f.tagline, f.about, f.status, f.engagement_model, f.monthly_retainer, f.fee_percent, f.currency, f.started_at, id);
  // A new name, careers address or website is looked for in this client's confidential posts at once; one that now gives the client away comes down.
  res.json({ ok: true, ...board.clientChanged(id) });
});

// ---------- jobs ----------
const jobSelect = `
  SELECT j.*, cl.name AS client_name, cl.brand_color, cl.slug AS client_slug, cl.currency, cl.fee_percent, u.name AS hiring_manager_name, cu.name AS created_by_name,
    ae.name AS account_executive_name, ae.active AS account_executive_active,
    (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS total_applicants,
    (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status = 'active') AS active_candidates,
    (SELECT COUNT(*) FROM applications a JOIN stages s ON s.id = a.stage_id WHERE a.job_id = j.id AND a.status = 'active' AND s.kind = 'applied') AS new_applicants,
    (SELECT COUNT(*) FROM applications a JOIN stages s ON s.id = a.stage_id WHERE a.job_id = j.id AND a.status = 'active' AND s.kind = 'interview') AS interviewing,
    (SELECT COUNT(*) FROM applications a JOIN stages s ON s.id = a.stage_id WHERE a.job_id = j.id AND a.status = 'active' AND s.kind = 'offer') AS offers,
    (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status = 'hired') AS hires,
    j.id IN (${board.OFF_CAREERS}) AS off_careers
  FROM jobs j JOIN clients cl ON cl.id = j.client_id LEFT JOIN users u ON u.id = j.hiring_manager_id LEFT JOIN users cu ON cu.id = j.created_by
    LEFT JOIN users ae ON ae.id = j.account_executive_id`;
/**
 * Who a job belongs to inside the agency is the agency's own business: its account executive, and who created it
 * (the same person until the job is handed on). The client's hiring team is never sent either.
 */
const withoutAgencyPeople = ({ created_by, created_by_name, account_executive_id, account_executive_name, account_executive_active, ...job }) => withoutClientFile(job);
/**
 * The client's own job description file is the agency's (see jobdescription.js): a client's user is never told
 * whether there is one. Nobody is sent where it is kept; the agency is sent what it needs on the job itself
 * (GET /jobs/:id), and the job lists leave it out for everybody.
 */
const withoutClientFile = ({ jd_file, jd_file_name, jd_file_size, jd_file_by, jd_file_at, ...job }) => job;
/** Changes whenever the brief or the ideal profile is saved, so a form opened on an older copy can be refused instead of overwriting the newer one. */
const briefVersion = (j) => crypto.createHash('sha1').update(`${j.brief ?? ''}\n${j.ideal_profile ?? ''}`).digest('hex').slice(0, 16);
/** Parse the JSON columns and drop what is the agency's alone for client users: the internal brief, the fee and who the job belongs to. */
function hydrateJob(j, user) {
  const { ideal_profile, brief, fee_percent, off_careers, ...rest } = withoutClientFile(j); // agency-only: the brief, and the fee the client pays
  const shown = isAgency(user) ? { ...rest, ideal_profile, brief: json(brief, {}), brief_version: briefVersion(j), fee_percent } : withoutAgencyPeople(rest);
  // careers_page: whether the job is listed on the client's careers page while it is open. Everybody is told that much, and not why.
  return { ...shown, careers_page: !off_careers, questions: json(j.questions, []), criteria: json(j.criteria, []) };
}

// The recruiter brief: free-text sections and one-item-per-line lists. Only these keys are stored.
const BRIEF_TEXT = ['about', 'locations', 'search_string', 'search_location', 'pay_notes', 'pay_flex', 'process_notes'];
const BRIEF_LISTS = ['must_haves', 'nice_to_haves', 'not_a_fit', 'target_companies', 'where_to_look', 'search_titles', 'search_keywords', 'selling_points', 'screening_questions'];
const BRIEF_MAX = { text: 6000, item: 300, items: 60 };
// What the brief form calls each section, for telling the person which one is too long.
const BRIEF_NAMES = { about: 'The role, the team and why it is open', locations: 'Where they can be based', search_string: 'Search string', search_location: 'Search location', pay_notes: 'Bonus, equity and benefits', pay_flex: 'Room to move',
  process_notes: 'Process notes', must_haves: 'Must-haves', nice_to_haves: 'Nice to have', not_a_fit: 'Not a fit', target_companies: 'Companies to look in', where_to_look: 'Places to find them',
  search_titles: 'Job titles', search_keywords: 'Keywords', selling_points: 'How to sell it', screening_questions: 'Questions for the first call' };
const tooLong = (name, what, length, max) => bad(`“${name}” ${what} (${length.toLocaleString('en-GB')}; the limit is ${max.toLocaleString('en-GB')}). Shorten it and save again: nothing has been saved.`);
/**
 * The brief as stored. A draft from autofill is cut to the limits. With `strict`, for what a person typed into the
 * brief form, anything over a limit is refused with the section named: saving it short without saying so loses the
 * end of a pasted transcript or company list unnoticed.
 */
function briefFields(input, strict = false) {
  const b = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const key of BRIEF_TEXT) {
    const value = text(b[key], strict ? Infinity : BRIEF_MAX.text);
    if (value && value.length > BRIEF_MAX.text) tooLong(BRIEF_NAMES[key], 'is too long to save, in characters', value.length, BRIEF_MAX.text);
    if (value) out[key] = value;
  }
  for (const key of BRIEF_LISTS) {
    const items = (Array.isArray(b[key]) ? b[key] : []).map((item) => clean(item, strict ? Infinity : BRIEF_MAX.item)).filter(Boolean);
    if (strict && items.length > BRIEF_MAX.items) tooLong(BRIEF_NAMES[key], 'has too many lines', items.length, BRIEF_MAX.items);
    const long = strict && items.find((item) => item.length > BRIEF_MAX.item);
    if (long) tooLong(BRIEF_NAMES[key], `has a line that is too long, in characters (“${long.slice(0, 40)}…”)`, long.length, BRIEF_MAX.item);
    if (items.length) out[key] = items.slice(0, BRIEF_MAX.items);
  }
  return out;
}
/** A hiring manager must be an active agency user or belong to the job's own client. */
function checkHiringManager(userId, clientId) {
  if (userId == null) return;
  const u = q.get('SELECT role, client_id FROM users WHERE id = ? AND active = 1', userId);
  if (!u || (u.role === 'client' && u.client_id !== clientId)) bad('Choose a hiring manager from this client or your own team.');
}

/** A job's account executive has to be somebody active on the agency's own team. */
function checkAccountExecutive(userId) {
  if (userId == null || !q.get(`SELECT 1 AS x FROM users WHERE id = ? AND active = 1 AND role != 'client'`, userId)) {
    bad('Choose an account executive from the people active on your team.');
  }
}
/**
 * The person a job form named as account executive: their id, as a whole number or as the digits a form sends.
 * Anything else (true, a list, a word, half a number) is refused rather than read as somebody it happens to look like.
 */
function namedAccountExecutive(value) {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id)) bad('Choose an account executive from the people active on your team.');
  return id;
}
/** The job's brief, and the job itself to hand on, belong to its account executive. An admin can do both as well. */
const ownsJob = (user, job) => user.role === 'admin' || (job.account_executive_id != null && job.account_executive_id === user.id);

/** A stage as this person is sent it. Whether it is an interview with the client only matters to the agency's reports, so the client's hiring team is not sent that. */
const stageFor = ({ with_client, ...stage }, user) => (isAgency(user) ? { ...stage, with_client } : stage);
/** A job's stages in order. */
const stagesOf = (jobId, user) => q.all('SELECT * FROM stages WHERE job_id = ? ORDER BY position', jobId).map((s) => stageFor(s, user));
/** The interview stages a job form sent: a name each, and the "Interview with the client" tick when the form had one. */
const stagesFrom = (list) => (Array.isArray(list) ? list : [])
  .map((s) => ({ id: int(s?.id), name: clean(s?.name, 80), with_client: typeof s?.with_client === 'boolean' ? s.with_client : undefined })).filter((s) => s.name).slice(0, 12);

function loadJob(id, user) {
  const job = q.get(`${jobSelect} WHERE j.id = ?`, int(id));
  if (!job || !canSee(user, job.client_id)) bad('Not found', 404);
  return job;
}

api.get('/jobs', (req, res) => {
  const cid = scopeOf(req);
  const where = [], p = [];
  if (cid) { where.push('j.client_id = ?'); p.push(cid); }
  if (req.query.status) { where.push('j.status = ?'); p.push(req.query.status); }
  // The agency can narrow the list to one account executive's jobs, or (with "none") to the jobs that have nobody.
  // From a client's user the filter is ignored: what it found or did not find would tell them whose job it is.
  if (isAgency(req.user) && req.query.account_executive) {
    if (req.query.account_executive === 'none') where.push('j.account_executive_id IS NULL');
    else { where.push('j.account_executive_id = ?'); p.push(int(req.query.account_executive)); }
  }
  const rows = q.all(`${jobSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE j.status WHEN 'open' THEN 0 WHEN 'draft' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, j.created_at DESC`, ...p);
  res.json(rows.map((j) => hydrateJob(j, req.user)).map(({ brief, ...j }) => ({ ...j, has_brief: brief ? Object.keys(brief).length > 0 : undefined })));
});

function jobFields(b) {
  const questions = (Array.isArray(b.questions) ? b.questions : [])
    .filter((x) => str(x?.label))
    .slice(0, 25)
    .map((x) => ({ id: clean(x.id, 20) || crypto.randomBytes(4).toString('hex'), label: clean(x.label, 300), type: ['short', 'long', 'yesno'].includes(x.type) ? x.type : 'short', required: Boolean(x.required) }));
  const criteria = (Array.isArray(b.criteria) ? b.criteria : []).map((c) => clean(c, 80)).filter(Boolean).slice(0, 12);
  return {
    title: clean(b.title, 160), department: clean(b.department, 120), location: clean(b.location, 120),
    work_mode: ['onsite', 'hybrid', 'remote'].includes(b.work_mode) ? b.work_mode : 'hybrid',
    employment_type: ['full_time', 'part_time', 'contract'].includes(b.employment_type) ? b.employment_type : 'full_time',
    salary_min: int(b.salary_min), salary_max: int(b.salary_max), salary_public: b.salary_public === false ? 0 : 1,
    description: text(b.description, 20000), ideal_profile: text(b.ideal_profile, 6000),
    status: ['draft', 'open', 'paused', 'closed'].includes(b.status) ? b.status : 'draft',
    hiring_manager_id: int(b.hiring_manager_id), openings: Math.max(1, int(b.openings) ?? 1),
    questions: JSON.stringify(questions), criteria: JSON.stringify(criteria.length ? criteria : DEFAULT_CRITERIA),
  };
}

// Who can be a job's account executive, for the picker on the job form and the filter on the Jobs page: everyone
// active on the agency team, plus anyone who still has a job in view (somebody since deactivated), so their jobs stay
// reachable until they are handed on. `none` is how many jobs in view have no account executive at all.
api.get('/account-executives', agencyOnly, (req, res) => {
  const cid = scopeOf(req);
  const inView = cid ? 'AND j.client_id = ?' : '', p = cid ? [cid] : [];
  const people = q.all(
    `SELECT u.id, u.name, u.active FROM users u
     WHERE (u.role != 'client' AND u.active = 1)
        OR u.id IN (SELECT j.account_executive_id FROM jobs j WHERE j.account_executive_id IS NOT NULL ${inView})
     ORDER BY u.active DESC, u.name`, ...p);
  res.json({ people, none: q.get(`SELECT COUNT(*) AS n FROM jobs j WHERE j.account_executive_id IS NULL ${inView}`, ...p).n });
});

api.post('/jobs', agencyOnly, (req, res) => {
  const b = req.body || {};
  const f = jobFields(b);
  const clientId = int(b.client_id);
  if (!q.get('SELECT 1 AS x FROM clients WHERE id = ?', clientId)) bad('Choose a client for this role.');
  if (!f.title) bad('Job title is required.');
  checkHiringManager(f.hiring_manager_id, clientId);
  // The job's account executive is whoever creates it. An admin can create a job for somebody else on the team; a
  // recruiter cannot.
  const named = b.account_executive_id == null || b.account_executive_id === '' ? req.user.id : namedAccountExecutive(b.account_executive_id);
  if (named !== req.user.id) {
    if (req.user.role !== 'admin') bad('Only an admin can make somebody else the account executive of a new job. You are the account executive of the jobs you create.', 403);
    checkAccountExecutive(named);
  }
  const interviewStages = stagesFrom(b.interview_stages);
  const id = tx(() => {
    const t = now();
    const jobId = q.insert(
      `INSERT INTO jobs (client_id, title, department, location, work_mode, employment_type, salary_min, salary_max, salary_public, description, ideal_profile,
         status, hiring_manager_id, openings, questions, criteria, created_by, account_executive_id, created_at, opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      clientId, f.title, f.department, f.location, f.work_mode, f.employment_type, f.salary_min, f.salary_max, f.salary_public, f.description, f.ideal_profile,
      f.status, f.hiring_manager_id, f.openings, f.questions, f.criteria, req.user.id, named, t, f.status === 'open' ? t : null);
    createStages(jobId, interviewStages.length ? interviewStages : DEFAULT_INTERVIEW_STAGES);
    reporting.searchOpened(jobId, f.status);
    // A brief drafted while filling in the form (from an intake call or job description) is saved with the new job.
    if (b.brief && typeof b.brief === 'object') q.run('UPDATE jobs SET brief = ? WHERE id = ?', JSON.stringify(briefFields(b.brief)), jobId);
    return jobId;
  });
  res.json({ id });
});

api.get('/jobs/:id', (req, res) => {
  const row = loadJob(req.params.id, req.user);
  const job = hydrateJob(row, req.user);
  // The client's own file, for the agency only: its name, size, and who added it when (see jobdescription.js).
  if (isAgency(req.user)) job.client_file = jobDescription.fileView(row);
  res.json({ job, stages: stagesOf(job.id, req.user) });
});

api.put('/jobs/:id', agencyOnly, (req, res) => {
  const job = loadJob(req.params.id, req.user);
  const b = req.body || {};
  const f = jobFields(b);
  if (!f.title) bad('Job title is required.');
  if (f.hiring_manager_id !== job.hiring_manager_id) checkHiringManager(f.hiring_manager_id, job.client_id);
  // Handing the job to another account executive: only looked at when the form names somebody other than the one it
  // has, so saving a job leaves it with whoever has it (a person since deactivated included). It is for the account
  // executive, or an admin, to do, and a job cannot be left with nobody.
  let accountExecutive = job.account_executive_id;
  if (b.account_executive_id !== undefined) {
    const named = b.account_executive_id === null || b.account_executive_id === '' ? null : namedAccountExecutive(b.account_executive_id);
    if (named !== job.account_executive_id) {
      if (!ownsJob(req.user, job)) bad('Only this job’s account executive, or an admin, can hand it to somebody else.', 403);
      checkAccountExecutive(named);
      accountExecutive = named;
    }
  }
  tx(() => {
    const t = now();
    q.run(
      `UPDATE jobs SET title = ?, department = ?, location = ?, work_mode = ?, employment_type = ?, salary_min = ?, salary_max = ?, salary_public = ?,
         description = ?, ideal_profile = ?, status = ?, hiring_manager_id = ?, openings = ?, questions = ?, criteria = ?,
         account_executive_id = ?, opened_at = ?, closed_at = ? WHERE id = ?`,
      f.title, f.department, f.location, f.work_mode, f.employment_type, f.salary_min, f.salary_max, f.salary_public, f.description,
      // Part of the brief, which is edited on its own page and belongs to the job's account executive: left alone
      // unless it is sent by them or by an admin.
      b.ideal_profile !== undefined && ownsJob(req.user, job) ? f.ideal_profile : job.ideal_profile,
      f.status, f.hiring_manager_id, f.openings, f.questions, f.criteria, accountExecutive,
      job.opened_at ?? (f.status === 'open' ? t : null), f.status === 'closed' ? job.closed_at ?? t : null, job.id);
    reporting.searchOpened(job.id, f.status, job);

    if (Array.isArray(b.interview_stages)) {
      const wanted = stagesFrom(b.interview_stages);
      if (!wanted.length) bad('Keep at least one interview stage.');
      const existing = q.all(`SELECT * FROM stages WHERE job_id = ? AND kind = 'interview' ORDER BY position`, job.id);
      const applied = q.get(`SELECT * FROM stages WHERE job_id = ? AND kind = 'applied'`, job.id);
      const keep = new Set(wanted.map((s) => s.id).filter(Boolean));
      for (const s of existing) {
        if (keep.has(s.id)) continue;
        if (q.get(`SELECT 1 AS x FROM applications WHERE stage_id = ? AND status IN ('active', 'hired')`, s.id)) bad(`Move candidates out of “${s.name}” before removing it.`);
        // Rejected and withdrawn candidates should not block the change: park them in the nearest earlier stage that survives.
        const fallback = existing.filter((e) => keep.has(e.id) && e.position < s.position).at(-1) ?? applied;
        q.run('UPDATE applications SET stage_id = ? WHERE stage_id = ?', fallback.id, s.id);
        q.run('DELETE FROM stage_history WHERE stage_id = ?', s.id);
        q.run('DELETE FROM stages WHERE id = ?', s.id);
      }
      wanted.forEach((s, i) => {
        const own = existing.find((e) => e.id === s.id);
        // A stage keeps its tick unless the form sends one; a new stage with no tick goes by what its name says.
        if (own) q.run('UPDATE stages SET name = ?, position = ?, with_client = ? WHERE id = ?', s.name, i + 1, (s.with_client ?? Boolean(own.with_client)) ? 1 : 0, own.id);
        else q.run(`INSERT INTO stages (job_id, name, kind, position, with_client) VALUES (?, ?, 'interview', ?, ?)`, job.id, s.name, i + 1, (s.with_client ?? !agencyStageName(s.name)) ? 1 : 0);
      });
      q.run(`UPDATE stages SET position = ? WHERE job_id = ? AND kind = 'offer'`, wanted.length + 1, job.id);
      q.run(`UPDATE stages SET position = ? WHERE job_id = ? AND kind = 'hired'`, wanted.length + 2, job.id);
    }
  });
  // Handed to another account executive: the people they are to prep and debrief go with the job at once.
  if (accountExecutive !== job.account_executive_id) todos.accountExecutiveChanged(job.id);
  // The job's confidential post, if it has one, is checked again: a new hiring manager's name may be in it, and a job that is no longer open is not advertised.
  res.json({ ok: true, ...board.jobChanged(job.id) });
});

// The recruiter brief is saved on its own, from the job's Brief page. It belongs to the job's account executive
// (whoever created the job, until it is handed to somebody else): they or an admin can change it; the rest of the
// team reads it.
api.put('/jobs/:id/brief', agencyOnly, (req, res) => {
  const job = loadJob(req.params.id, req.user);
  if (!ownsJob(req.user, job)) bad('Only this job’s account executive, or an admin, can edit its brief.', 403);
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  // The form sends the version of the brief it was opened on. If the brief has been saved since, this save would
  // undo that one without either person knowing.
  if (b.version !== undefined && b.version !== briefVersion(job)) {
    bad('This brief was changed by someone else after you opened it, so your version was not saved. Copy what you added, close this form and open it again to see theirs.', 409);
  }
  // Each of the two is replaced only when it is sent, and the brief only by a set of sections: a request without
  // one (or with something else in its place) must not empty what is stored.
  if (b.brief !== undefined && (b.brief === null || typeof b.brief !== 'object' || Array.isArray(b.brief))) bad('The brief was not sent in a form that can be saved.');
  const profile = typeof b.ideal_profile === 'string' ? b.ideal_profile.replace(/\r\n?/g, '\n').trim() : '';
  if (profile.length > BRIEF_MAX.text) tooLong('Who we are looking for', 'is too long to save, in characters', profile.length, BRIEF_MAX.text);
  q.run('UPDATE jobs SET brief = ?, ideal_profile = ? WHERE id = ?',
    b.brief !== undefined ? JSON.stringify(briefFields(b.brief, true)) : job.brief, b.ideal_profile !== undefined ? profile || null : job.ideal_profile, job.id);
  res.json({ ok: true });
});

api.patch('/jobs/:id/status', agencyOnly, (req, res) => {
  const job = loadJob(req.params.id, req.user);
  const status = req.body?.status;
  if (!['draft', 'open', 'paused', 'closed'].includes(status)) bad('Unknown status.');
  const t = now();
  q.run('UPDATE jobs SET status = ?, opened_at = ?, closed_at = ? WHERE id = ?',
    status, job.opened_at ?? (status === 'open' ? t : null), status === 'closed' ? t : null, job.id);
  reporting.searchOpened(job.id, status, job);
  res.json({ ok: true, ...board.jobChanged(job.id) });
});

// Delete a job with its pipeline. People who were only ever in this job go with it. People who were in The Book
// before they were put on it do not: they go back to The Book without a job, with everything the agency kept on them.
api.delete('/jobs/:id', adminOnly, (req, res) => {
  const job = loadJob(req.params.id, req.user);
  const made = []; // files copied along the way, to be removed again if the deletion is not saved
  let gone;
  try {
    gone = tx(() => {
      const files = [];
      for (const a of q.all('SELECT * FROM applications WHERE job_id = ?', job.id)) {
        if (cameFromBook(a)) {
          files.push(...returnToBook(a, req.user, `Back in The Book without a job: ${job.title} at ${job.client_name} was deleted`, made));
          continue;
        }
        // Calls recorded for this job stay with people who are in other jobs too, without the write-up drafted for this one.
        detachCallsFrom(a.id);
        files.push(a.resume_file, ...earlierResumeFiles('a.id = ?', a.id));
      }
      q.run('DELETE FROM applications WHERE job_id = ?', job.id);
      q.run('DELETE FROM jobs WHERE id = ?', job.id);
      // People who were only in this job go with it, and so do their photos and their recorded calls. Only this
      // client's own records are looked at: people saved to The Book without a job belong to no client and stay.
      const alone = 'client_id = ? AND id NOT IN (SELECT candidate_id FROM applications)';
      const orphans = q.all(`SELECT id, photo_file FROM candidates WHERE ${alone}`, job.client_id);
      const calls = callFilesOf(orphans.map((c) => c.id));
      q.run(`DELETE FROM candidates WHERE ${alone}`, job.client_id);
      // The client's own job description file goes with its job.
      return { files: [...files, ...orphans.map((c) => c.photo_file), job.jd_file], calls };
    });
  } catch (err) {
    made.forEach(removeUpload);
    throw err;
  }
  gone.files.forEach(removeUpload);
  removeCallFiles(gone.calls);
  res.json({ ok: true });
});

// ---------- applications (a candidate in a job's pipeline) ----------
const appSelect = `
  SELECT a.id, a.status, a.source, a.rating, a.applied_at, a.stage_entered_at, a.updated_at, a.review_status, a.stage_id, a.reject_reason, a.hired_at,
    a.resume_file IS NOT NULL AS has_resume, a.owner_id, ou.name AS owner_name,
    c.id AS candidate_id, c.name, c.email, c.current_title, c.current_company, c.location, substr(c.photo_file, 1, 8) AS photo,
    j.id AS job_id, j.title AS job_title, j.client_id, cl.name AS client_name, cl.brand_color,
    s.name AS stage_name, s.kind AS stage_kind, s.position AS stage_position, a.job_id IS NULL AS general,
    (SELECT MIN(i.starts_at) FROM interviews i WHERE i.application_id = a.id AND i.status = 'scheduled' AND i.starts_at >= ?) AS next_interview
  FROM applications a
  JOIN candidates c ON c.id = a.candidate_id
  -- Someone saved to The Book without a job has an entry with no job, client or stage: those columns come back empty.
  LEFT JOIN jobs j ON j.id = a.job_id
  LEFT JOIN clients cl ON cl.id = j.client_id
  LEFT JOIN stages s ON s.id = a.stage_id
  LEFT JOIN users ou ON ou.id = a.owner_id`;
/** Rows of appSelect as the screens get them: `general` as true or false, and photos only for those who may see them. */
const appRows = (rows, user) => hidePhotos(rows, user).map((r) => ({ ...r, general: Boolean(r.general) }));

api.get('/applications', (req, res) => {
  const cid = scopeOf(req);
  const where = [], p = [now()];
  if (cid) { where.push('j.client_id = ?'); p.push(cid); }
  if (int(req.query.job_id)) { where.push('a.job_id = ?'); p.push(int(req.query.job_id)); }
  // People saved without a job: only them (general=1), or everyone but them (general=0). A list for one client or
  // one job never holds any, since they belong to neither; that also keeps them from every client user.
  if (req.query.general === '1') where.push('a.job_id IS NULL');
  else if (req.query.general === '0') where.push('a.job_id IS NOT NULL');
  if (req.query.status && req.query.status !== 'all') { where.push('a.status = ?'); p.push(req.query.status); }
  if (req.query.stage_kind) { where.push('s.kind = ?'); p.push(req.query.stage_kind); }
  if (req.query.review) { where.push('a.review_status = ?'); p.push(req.query.review); }
  if (req.query.owner === 'none') where.push('a.owner_id IS NULL');
  else if (req.query.owner === 'me') { where.push('a.owner_id = ?'); p.push(req.user.id); }
  else if (int(req.query.owner)) { where.push('a.owner_id = ?'); p.push(int(req.query.owner)); }
  if (clean(req.query.q)) {
    where.push(`(c.name LIKE ? OR c.email LIKE ? OR c.current_company LIKE ? OR c.current_title LIKE ?)`);
    const like = `%${clean(req.query.q, 100)}%`;
    p.push(like, like, like, like);
  }
  const order = req.query.sort === 'oldest' ? 'a.applied_at ASC' : 'a.applied_at DESC';
  // Cross-job lists stop at 500 rows (the screens say so); one job's pipeline is returned whole so the board never hides anyone.
  const limit = int(req.query.job_id) ? 20000 : 500;
  res.json(appRows(q.all(`${appSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ${limit}`, ...p), req.user));
});

/**
 * One application, for someone allowed to see it. The entry of a person saved to The Book without a job is loaded
 * the same way, with its job, client and stage empty; it belongs to the agency, so a client user is told it does not exist.
 */
function loadApp(id, user) {
  const a = q.get(
    `SELECT a.*, j.client_id, j.title AS job_title, c.name AS candidate_name, c.email AS candidate_email, cl.name AS client_name
     FROM applications a JOIN candidates c ON c.id = a.candidate_id LEFT JOIN jobs j ON j.id = a.job_id LEFT JOIN clients cl ON cl.id = j.client_id
     WHERE a.id = ?`, int(id));
  if (!a || !canSee(user, a.client_id)) bad('Not found', 404);
  return a;
}
/** Whether this is the entry of someone saved to The Book without a job. */
const isGeneral = (a) => a.job_id == null;
/**
 * Whether this application holds what the agency kept on somebody in The Book before they were on the job: their
 * entry became this application, or was joined to it (which always leaves a line in the agency's own history).
 * Such a person goes back to The Book when the job goes, where anyone else in the job is deleted with it.
 */
const cameFromBook = (a) => !isGeneral(a) && Boolean(a.general_until || q.get('SELECT 1 AS x FROM agency_activities WHERE application_id = ? LIMIT 1', a.id));
/**
 * An application the person made themselves, on a client's careers page or on the agency's own website: it carries
 * the consent they ticked there, or failing that says where it was made. What they wrote on it was written for that
 * client, and stays apart from what the agency holds on them (see returnToBook).
 */
const OWN_APPLICATION = `(consent_at IS NOT NULL OR source IN ('careers_page', '${board.SOURCE}'))`;
const ownApplication = (a) => Boolean(a.consent_at) || a.source === 'careers_page' || a.source === board.SOURCE;
/** Stages, rejections, the hiring team, interviews and offers all belong to a job, so they wait until the person is on one. */
const needsJob = (a) => { if (isGeneral(a)) bad('Add them to a job first.'); };
// Somebody who applied through the agency's confidential post and has not been told who the client is gets the
// title they saw and no company name (see board.js); everybody else gets the job and the client as they are.
const mailVars = (a, user) => board.mailVars(a, {
  candidate_first_name: greetingName(a.candidate_name), candidate_name: a.candidate_name,
  job_title: a.job_title, company: a.client_name, sender_name: user.name,
});

/** The activity type for arriving in a stage. The kind of stage is part of it, so the dashboard can pick out interview and offer moves. */
const arrivalType = (stage) => (stage.kind === 'hired' ? 'hired' : stage.kind === 'interview' ? 'stage_interview' : stage.kind === 'offer' ? 'stage_offer' : 'stage');

/**
 * Somebody starts in a job at this stage: added straight into it, or put on the job from The Book. In an interview
 * stage, Offer or Hired that is the same news as being moved there, so it gets a line of its own for the dashboard
 * to pick out. `at` gives the line the moment of the lines written with it.
 */
function logArrival(applicationId, userId, stage, at) {
  if (stage.kind === 'applied') return;
  logActivity(applicationId, userId, arrivalType(stage), stage.kind === 'hired' ? 'Marked as hired' : `Started at ${stage.name}`, at ? { at } : undefined);
}

/** `quiet` leaves the activity line to the caller, who is writing one of its own about the same event. */
function moveToStage(app, stageId, user, { quiet = false } = {}) {
  const stage = q.get('SELECT * FROM stages WHERE id = ? AND job_id = ?', int(stageId), app.job_id);
  if (!stage) bad('That stage does not belong to this job.');
  if (stage.id === app.stage_id && (app.status === 'active' || app.status === 'hired')) return stage;
  const from = q.get('SELECT position FROM stages WHERE id = ?', app.stage_id);
  const t = now();
  const hired = stage.kind === 'hired';
  q.run(`UPDATE applications SET stage_id = ?, stage_entered_at = ?, updated_at = ?, status = ?, hired_at = ?, reject_reason = NULL WHERE id = ?`,
    stage.id, t, t, hired ? 'hired' : 'active', hired ? t : null, app.id);
  q.run('INSERT INTO stage_history (application_id, stage_id, entered_at) VALUES (?, ?, ?)', app.id, stage.id, t);
  // A move to an earlier stage (a card dropped in the wrong column and put back, a hire that fell through) is not
  // progress, so it gets a type of its own that the dashboard does not highlight.
  const back = from && stage.position < from.position;
  if (!quiet) logActivity(app.id, user.id, back ? 'stage_back' : arrivalType(stage), back ? `Moved back to ${stage.name}` : hired ? 'Marked as hired' : `Moved to ${stage.name}`);
  // An applicant nobody owns yet becomes the responsibility of the recruiter who first takes them forward.
  if (!app.owner_id && isAgency(user) && stage.kind !== 'applied') q.run('UPDATE applications SET owner_id = ? WHERE id = ? AND owner_id IS NULL', user.id, app.id);
  reporting.arrivedIn(app.id, stage, app); // after the owner is settled: a placement is credited to whoever owns the candidate now
  return stage;
}

/** Contact details as stored: single-line, capped, and links restricted to http(s). */
const candidateFields = (c) => ({
  name: clean(c.name, 120), phone: clean(c.phone, 40), linkedin: profileField(c.linkedin), location: clean(c.location, 120),
  current_title: clean(c.current_title, 160), current_company: clean(c.current_company, 160),
});
/**
 * What a person's contact details must be when the agency changes them on their profile (Edit details, or a résumé
 * dropped on the profile): a name, an e-mail address that looks like one, an address or a profile link to tell them
 * apart by, and an address that no other record at the same client (or, for somebody on no job, no other entry in
 * The Book) already has.
 */
function checkContact(a, c, email) {
  if (!c.name) bad('A name is required.');
  if (email && !validEmail(email)) bad('That email address does not look right.');
  if (!email && !c.linkedin) bad('Keep an email address or a profile link, so this person can be told apart from others.');
  if (email && q.get('SELECT 1 AS x FROM candidates WHERE client_id IS ? AND email = ? AND id != ?', a.client_id, email, a.candidate_id)) {
    bad(isGeneral(a) ? 'Someone else saved to The Book without a job already uses that email.' : 'Another candidate at this client already uses that email.');
  }
}

/**
 * Put a newly uploaded résumé on an application that may already have one (inside a transaction). The one it had is
 * never deleted: it is kept as an earlier résumé, which the agency can still download. A file that is the same as
 * the one on file changes nothing. Answers what happened ('added', 'replaced' or 'unchanged'), the name of the
 * résumé that was kept, and the upload that is not needed after all.
 */
function putResume(app, file, userId, at) {
  if (!app.resume_file) {
    q.run('UPDATE applications SET resume_file = ?, resume_name = ? WHERE id = ?', file.filename, clean(file.originalname, 200), app.id);
    return { change: 'added' };
  }
  if (sameUpload(app.resume_file, file.filename)) return { change: 'unchanged', spare: file.filename };
  q.run('INSERT INTO earlier_resumes (application_id, resume_file, resume_name, kept_at, kept_by) VALUES (?, ?, ?, ?, ?)', app.id, app.resume_file, app.resume_name, at, userId);
  q.run('UPDATE applications SET resume_file = ?, resume_name = ? WHERE id = ?', file.filename, clean(file.originalname, 200), app.id);
  return { change: 'replaced', earlier: app.resume_name || 'résumé' };
}
/** The files of the earlier résumés kept for these applications, to be removed once the applications have gone. */
const earlierResumeFiles = (where, ...p) =>
  q.all(`SELECT r.resume_file FROM earlier_resumes r JOIN applications a ON a.id = r.application_id WHERE ${where}`, ...p).map((r) => r.resume_file);

/**
 * The entry in The Book of the person being added to a job, if they have one. They are found by their e-mail
 * address or LinkedIn link, and only when the name agrees, so a mistyped address never moves somebody else's entry.
 */
function bookEntryOf({ email, linkedin, name }) {
  const key = identityKey(linkedin);
  const people = [
    ...(email ? q.all('SELECT * FROM candidates WHERE client_id IS NULL AND email = ?', email) : []),
    ...(key ? q.all('SELECT * FROM candidates WHERE client_id IS NULL AND linkedin = ? ORDER BY id', key) : []),
  ];
  for (const person of people.filter((p) => samePerson(p.name, name))) {
    const entry = q.get('SELECT * FROM applications WHERE candidate_id = ? AND job_id IS NULL', person.id);
    if (entry) return { entry, person };
  }
  return null;
}

// Add a person: to a job's pipeline, or, with no job chosen, to The Book on their own ("a general entry") to be put
// on a job later. Either way the same person is recognised and joined to the record they already have. Somebody
// who is in The Book without a job and is now added to one is not given a second record: their entry goes on the job.
api.post('/applications', agencyOnly, candidateUpload, (req, res) => {
  let stored = false;
  req.file = req.files?.resume?.[0];
  let photo = acceptPhoto(req.files?.photo?.[0]);
  const photoRejected = Boolean(req.files?.photo?.[0]) && !photo; // the person is still added; the answer says the photo was not kept
  try {
    const b = req.body || {};
    const general = b.job_id == null || b.job_id === '';
    const job = general ? null : q.get('SELECT j.*, cl.name AS client_name FROM jobs j JOIN clients cl ON cl.id = j.client_id WHERE j.id = ?', int(b.job_id));
    if (!general && !job) bad('That job was not found. It may have been removed.');
    // A person is told apart from others within one client. People saved without a job have no client, and are told
    // apart among themselves (`client_id IS ?` finds them when this is empty).
    const clientId = job?.client_id ?? null;
    const email = emailOf(b.email) || null;
    const c = candidateFields(b);
    if (!c.name) bad('A name is required.');
    if (email && !validEmail(email)) bad('That email address does not look right.');
    if (!email && !c.linkedin) bad('Add an email address or a profile link, so this person can be told apart from others.');
    const source = isStr(b.source) && Object.hasOwn(SOURCE_LABELS, b.source) && b.source !== board.SOURCE ? b.source : 'agency_sourced';
    const result = tx(() => {
      /** The records a refusal points at, each with its applications, so the screen can offer to open them. */
      const recordsAt = (where, ...p) => q.all(
        `SELECT a.id AS application_id, j.id AS job_id, j.title AS job_title, cl.name AS client_name, c.name, a.job_id IS NULL AS general
         FROM candidates c JOIN applications a ON a.candidate_id = c.id LEFT JOIN jobs j ON j.id = a.job_id LEFT JOIN clients cl ON cl.id = j.client_id
         WHERE ${where} ORDER BY a.applied_at DESC LIMIT 20`, ...p).map((m) => ({ ...m, general: Boolean(m.general) }));
      // The same person is recognised by email, or failing that by a LinkedIn profile link. No other kind of link
      // identifies anyone, and a link alone is not trusted when the name on the record is plainly someone else's
      // (a mistyped or shared link, or one an applicant typed on the public form): that is put to the recruiter.
      let cand = email ? q.get('SELECT * FROM candidates WHERE client_id IS ? AND email = ?', clientId, email) ?? null : null;
      // Among people saved without a job, an address under a plainly different name is put to the recruiter as well.
      // Saving again adds a résumé, a photo and a note to the entry, and those must not land on somebody else.
      if (general && cand && !samePerson(cand.name, c.name)) {
        bad(`This email address is already on ${cand.name}'s entry in The Book. Open their entry, or check the address.`, 409, { code: 'link_conflict', matches: recordsAt('c.id = ?', cand.id) });
      }
      const key = cand ? null : identityKey(c.linkedin);
      if (key) {
        const sameLink = q.all('SELECT * FROM candidates WHERE client_id IS ? AND linkedin = ? ORDER BY id', clientId, key);
        cand = sameLink.find((other) => samePerson(other.name, c.name)) ?? null;
        if (!cand && sameLink.length) {
          bad(`This LinkedIn link is already on ${sameLink[0].name}'s record. Open their record, or check the link.`, 409, { code: 'link_conflict', matches: recordsAt('c.client_id IS ? AND c.linkedin = ?', clientId, key) });
        }
      }
      // Already in The Book without a job, and now being added to one: the entry they have is what goes on the job,
      // with its notes, résumé, calls and history. It joins the client's own record of them when there is one. A
      // client record under a plainly different name is left to today's rule, and their entry stays where it is.
      let book = job ? bookEntryOf({ email, linkedin: c.linkedin, name: c.name }) : null;
      if (book && cand && !samePerson(cand.name, c.name)) book = null;
      // The entry may carry an address that was not typed this time (they were found by their link). If the client
      // has a record under that address, that record is theirs: one address is one record at a client.
      let viaBook = false;
      if (book && !cand && book.person.email) {
        const theirs = q.get('SELECT * FROM candidates WHERE client_id = ? AND email = ?', clientId, book.person.email);
        if (theirs && samePerson(theirs.name, c.name)) { cand = theirs; viaBook = true; }
        else if (theirs) book = null;
      }
      const known = Boolean(cand);
      const remarks = []; // what the record's history should say about how this person was matched
      /** The agency is adding them again, so its details are the newer ones: fill in what was missing and refresh the role. */
      const refresh = (id) => q.run(
        `UPDATE candidates SET email = COALESCE(email, ?), phone = COALESCE(phone, ?), linkedin = COALESCE(linkedin, ?), location = COALESCE(?, location),
           current_title = COALESCE(?, current_title), current_company = COALESCE(?, current_company) WHERE id = ?`,
        email && !q.get('SELECT 1 AS x FROM candidates WHERE client_id IS ? AND email = ?', clientId, email) ? email : null,
        c.phone, c.linkedin, c.location, c.current_title, c.current_company, id);
      if (cand) {
        const dup = job && q.get(`SELECT a.id, s.name AS stage_name FROM applications a JOIN stages s ON s.id = a.stage_id WHERE a.candidate_id = ? AND a.job_id = ?`, cand.id, job.id);
        if (dup) bad(`${cand.name} is already in the pipeline for this job (${dup.stage_name}).`, 409);
        if (viaBook) remarks.push(`Recognised as ${cand.name} by the email address on their entry in The Book, and added to their existing record`);
        else if (key) remarks.push(`Recognised as ${cand.name} by LinkedIn link and added to their existing record`);
        else if (!samePerson(cand.name, c.name)) remarks.push(`Entered as “${c.name}”; this email address belongs to ${cand.name}, so they were added to that record`);
        if (email && cand.email && cand.email !== email) remarks.push(`A different email address was entered (${email}); the record keeps ${cand.email}`);
      } else if (book) {
        // Their entry in The Book is what goes on the job, and it keeps its own address. When they were found by
        // their link and another address was typed, the history says so, as it does for a client's record: an
        // address a recruiter typed is not dropped without a word.
        const theirs = book.person;
        if (!(email && theirs.email === email)) remarks.push(`Recognised as ${theirs.name} by LinkedIn link: their entry in The Book was put on the job`);
        if (email && theirs.email && theirs.email !== email) remarks.push(`A different email address was entered (${email}); the record keeps ${theirs.email}`);
      }
      let t = now();
      let appId, resumeChange = null, sparePhoto = null;
      // Someone saved without a job has one entry, however often they are saved.
      const entry = general && known ? q.get('SELECT * FROM applications WHERE candidate_id = ? AND job_id IS NULL', cand.id) : null;
      if (book) {
        const stage = q.get('SELECT * FROM stages WHERE id = ? AND job_id = ?', int(b.stage_id), job.id)
          ?? q.get(`SELECT * FROM stages WHERE job_id = ? AND kind = 'applied'`, job.id);
        const went = entryToJob({ entry: book.entry, person: book.person, job, stage, into: cand, user: req.user });
        t = went.at;
        sparePhoto = went.sparePhoto;
        cand = cand ?? book.person;
        refresh(cand.id);
        appId = book.entry.id;
        if (req.file) {
          resumeChange = putResume(book.entry, req.file, req.user.id, t);
          // Where the earlier résumés are kept is the agency's business, so the hiring team is not shown this line.
          if (resumeChange.change === 'replaced') logActivity(appId, req.user.id, 'added', `A newer résumé was added. The one they had (${resumeChange.earlier}) is kept under Earlier résumés`, { at: t, agencyOnly: true });
        }
      } else if (entry) {
        // Already in The Book: nothing new is made. What was sent this time is added to the entry they have. A
        // résumé sent now becomes the one on their profile, and the one they had is kept as an earlier résumé.
        refresh(cand.id);
        appId = entry.id;
        if (req.file) resumeChange = putResume(entry, req.file, req.user.id, t);
        q.run('UPDATE applications SET owner_id = COALESCE(owner_id, ?), updated_at = ? WHERE id = ?', req.user.id, t, appId);
        logActivity(appId, req.user.id, 'added', `Saved to The Book again${{
          added: ', with their résumé',
          replaced: `, with a newer résumé. The one they had (${resumeChange?.earlier}) is kept under Earlier résumés`,
          unchanged: ', with the résumé they already had',
        }[resumeChange?.change] ?? ''}`);
      } else {
        if (cand) refresh(cand.id);
        else {
          cand = { name: c.name, id: q.insert(
            'INSERT INTO candidates (client_id, name, email, phone, linkedin, location, current_title, current_company, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            clientId, c.name, email, c.phone, c.linkedin, c.location, c.current_title, c.current_company, now()) };
        }
        const resume = [req.file?.filename ?? null, clean(req.file?.originalname, 200)];
        if (general) {
          // No job, so no stage and nothing for a pipeline to count: the entry simply holds the person.
          appId = q.insert(
            `INSERT INTO applications (candidate_id, job_id, stage_id, status, source, cover_note, resume_file, resume_name, applied_at, stage_entered_at, updated_at, owner_id)
             VALUES (?, NULL, NULL, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
            cand.id, source, text(b.cover_note, 6000), ...resume, t, t, t, req.user.id);
          // The same moment as the entry itself: "added" on an entry is read back from this line when they return from a job.
          logActivity(appId, req.user.id, 'added', `Added to The Book (${SOURCE_LABELS[source].toLowerCase()})`, { at: t });
        } else {
          const stage = q.get('SELECT * FROM stages WHERE id = ? AND job_id = ?', int(b.stage_id), job.id)
            ?? q.get(`SELECT * FROM stages WHERE job_id = ? AND kind = 'applied'`, job.id);
          const hired = stage.kind === 'hired';
          appId = q.insert(
            `INSERT INTO applications (candidate_id, job_id, stage_id, status, source, cover_note, resume_file, resume_name, applied_at, stage_entered_at, updated_at, hired_at, owner_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            cand.id, job.id, stage.id, hired ? 'hired' : 'active', source, text(b.cover_note, 6000), ...resume, t, t, t, hired ? t : null, req.user.id);
          q.run('INSERT INTO stage_history (application_id, stage_id, entered_at) VALUES (?, ?, ?)', appId, stage.id, t);
          logActivity(appId, req.user.id, 'added', `Added to the pipeline (${SOURCE_LABELS[source].toLowerCase()})`);
          logArrival(appId, req.user.id, stage);
          reporting.arrivedIn(appId, stage);
          onPostsJob(appId, job, req.user);
        }
      }
      // How somebody who came from The Book was matched is the agency's business, so the hiring team is not shown those lines.
      for (const remark of remarks) logActivity(appId, req.user.id, 'added', remark, { at: t, agencyOnly: Boolean(book) });
      const note = text(b.note, 10000);
      // A note on someone who is on no job is the agency's own, whatever the form said: no client was in view when it was written.
      const agencyOnlyNote = general || b.note_private === 'true' || b.note_private === true;
      const noteId = note ? q.insert('INSERT INTO notes (application_id, user_id, body, private, created_at) VALUES (?, ?, ?, ?, ?)', appId, req.user.id, note, agencyOnlyNote ? 1 : 0, t) : null;
      // A photo sent with them becomes the record's photo (replacing an older one).
      let replaced = null;
      if (photo) {
        replaced = q.get('SELECT photo_file FROM candidates WHERE id = ?', cand.id)?.photo_file ?? null;
        q.run('UPDATE candidates SET photo_file = ? WHERE id = ?', photo, cand.id);
      }
      // `name` is the name on the record they ended up on, which is not always the one that was typed. `moved` says
      // their entry in The Book went on the job (`joined`: onto the client's own record of them), and `resume` what
      // became of a résumé sent for somebody who already had an entry.
      return {
        id: appId, known: known || Boolean(book), merged: known || Boolean(book), name: cand.name, general,
        ...(book ? { moved: true, joined: known } : {}), ...(resumeChange ? { resume: resumeChange.change } : {}),
        spare: [replaced, resumeChange?.spare, sparePhoto], noteId, note,
      };
    });
    stored = true;
    photo = null; // it belongs to the record now
    result.spare.forEach(removeUpload);
    delete result.spare;
    // A note written with them is told to their owner and the job's account executive, as one written on the profile is.
    if (result.noteId) noteWritten({ applicationId: result.id, noteId: result.noteId, writer: req.user, body: result.note });
    delete result.noteId;
    delete result.note;
    res.json(photoRejected ? { ...result, photo_rejected: true } : result);
  } finally {
    if (!stored) removeUpload(req.file?.filename);
    removeUpload(photo); // only still set when it never reached a record
  }
});

// Has this person (by LinkedIn profile link or email) already been added anywhere? Used by the browser extension before adding.
api.get('/candidates/lookup', agencyOnly, (req, res) => {
  const link = identityKey(req.query.linkedin);
  const email = emailOf(req.query.email);
  if (!link && !validEmail(email)) return res.json([]);
  // Someone saved to The Book without a job is found too, with no job, client or stage to name.
  res.json(q.all(
    `SELECT a.id AS application_id, a.status, c.name, j.id AS job_id, j.title AS job_title, cl.name AS client_name, s.name AS stage_name, a.job_id IS NULL AS general
     FROM candidates c JOIN applications a ON a.candidate_id = c.id LEFT JOIN jobs j ON j.id = a.job_id
     LEFT JOIN clients cl ON cl.id = j.client_id LEFT JOIN stages s ON s.id = a.stage_id
     WHERE c.linkedin = ? OR c.email = ? ORDER BY a.applied_at DESC LIMIT 20`, link ?? '', validEmail(email) ? email : '')
    .map((row) => ({ ...row, general: Boolean(row.general) })));
});

// Who can own a candidate, for the owner filter and the owner picker: everyone active on the agency team, plus
// anyone who still owns someone in view (a recruiter who has since been deactivated), so their candidates stay reachable.
api.get('/owners', (req, res) => {
  const cid = scopeOf(req);
  // With no client chosen, "in view" takes in people saved without a job, so whoever owns them is listed as well.
  const owning = cid ? 'SELECT a.owner_id FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.owner_id IS NOT NULL AND j.client_id = ?'
    : 'SELECT a.owner_id FROM applications a WHERE a.owner_id IS NOT NULL';
  res.json(q.all(
    `SELECT u.id, u.name, u.active FROM users u
     WHERE (u.role != 'client' AND u.active = 1) OR u.id IN (${owning})
     ORDER BY u.active DESC, u.name`, ...(cid ? [cid] : [])));
});

/**
 * The other records that are, or look like, this same person: the ones with their e-mail address or their LinkedIn
 * link that belong somewhere else (another client's record of them, or their own record in The Book without a
 * job). Each client keeps its own record of a person and The Book keeps its own, so one person can be on file
 * several times, and a request to be erased has to reach every one of them. For the agency only.
 */
function recordsElsewhere(person) {
  const key = identityKey(person.linkedin);
  if (!person.email && !key) return [];
  return q.all(
    `SELECT c.id AS candidate_id, c.name, c.client_id, cl.name AS client_name, a.id AS application_id, j.title AS job_title,
       ?1 != '' AND c.email IS NOT NULL AND c.email = ?1 AS same_email
     FROM candidates c LEFT JOIN clients cl ON cl.id = c.client_id
     LEFT JOIN applications a ON a.id = (SELECT x.id FROM applications x WHERE x.candidate_id = c.id ORDER BY x.applied_at DESC, x.id DESC LIMIT 1)
     LEFT JOIN jobs j ON j.id = a.job_id
     WHERE c.id != ?3 AND c.client_id IS NOT ?4 AND ((?1 != '' AND c.email = ?1) OR (?2 != '' AND c.linkedin = ?2))
     ORDER BY c.client_id IS NOT NULL, cl.name, c.id LIMIT 20`, person.email ?? '', key ?? '', person.id, person.client_id)
    .map((r) => ({ ...r, same_email: Boolean(r.same_email) }));
}

api.get('/applications/:id', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  const agency = isAgency(req.user);
  const { photo_file, ...candidate } = q.get('SELECT * FROM candidates WHERE id = ?', a.candidate_id);
  candidate.photo = seesPhotos(req.user) ? photoTag(photo_file) : null;
  // A record that came from The Book was made when the agency first saved the person. To the hiring team it begins
  // with their first application at this client: the earlier date would say they were in The Book before. That holds
  // for every record, whether or not an application that came from The Book is still on it: the one that came from
  // The Book may have left (removed from its job, or the job deleted) while the record stays for another job.
  if (!agency) {
    const first = q.get('SELECT MIN(applied_at) AS at FROM applications WHERE candidate_id = ?', candidate.id).at;
    if (first > candidate.created_at) candidate.created_at = first;
  }
  // The entry of someone saved to The Book without a job has no job, client or stages; the rest is as for anyone.
  const general = isGeneral(a);
  const job = general ? null : q.get('SELECT id, title, client_id, criteria, status, location FROM jobs WHERE id = ?', a.job_id);
  if (job) job.criteria = json(job.criteria, []);
  const client = general ? null : q.get('SELECT id, name, brand_color, currency, fee_percent FROM clients WHERE id = ?', a.client_id);
  if (client && !agency) delete client.fee_percent;
  const stages = general ? [] : stagesOf(a.job_id, req.user);
  // What was written while the person was in The Book without a job was written for the agency. Once they are on a
  // job, the client's hiring team sees this entry's notes, history and e-mails from that moment on, and nothing earlier.
  // (The earlier history and e-mails are no longer in the tables read here at all, and the earlier notes are all
  // agency only. Asking by the date as well costs nothing and holds even if a row were ever left behind.)
  const sinceJob = (column) => (agency || !a.general_until ? { sql: '', p: [] } : { sql: `AND ${column} >= ?`, p: [a.general_until] });
  const notes = q.all(
    `SELECT n.*, u.name AS user_name, u.role AS user_role FROM notes n LEFT JOIN users u ON u.id = n.user_id
     WHERE n.application_id = ? ${agency ? '' : 'AND n.private = 0'} ${sinceJob('n.created_at').sql} ORDER BY n.created_at DESC`, a.id, ...sinceJob('n.created_at').p);
  // The agency reads the history and the e-mails from two places: the tables the hiring team is shown from, and its
  // own (what was written before the person was on this job, and how they were matched). The agency's own lines are
  // numbered below zero, so that no two lines of one list share a number. The hiring team is only ever read the
  // first of the two. That a call was recorded is the agency's business as well: clients never see anything of
  // Otterview, that line included. The same goes for what the agency notes about its own confidential post (whether
  // the candidate knows who the client is).
  const both = (shown, kept, columns) =>
    `(SELECT id, application_id, ${columns}, created_at, 0 AS agency_only FROM ${shown} WHERE application_id = ?1
      UNION ALL SELECT -id, application_id, ${columns}, created_at, 1 FROM ${kept} WHERE application_id = ?1)`;
  const newestFirst = 'ORDER BY x.created_at DESC, x.agency_only, ABS(x.id) DESC';
  const activities = agency
    ? q.all(`SELECT x.*, u.name AS user_name FROM ${both('activities', 'agency_activities', 'user_id, type, detail')} x LEFT JOIN users u ON u.id = x.user_id ${newestFirst}`, a.id)
    : q.all(
      `SELECT ac.id, ac.application_id, ac.user_id, ac.type, ac.detail, ac.created_at, u.name AS user_name FROM activities ac LEFT JOIN users u ON u.id = ac.user_id
       WHERE ac.application_id = ? AND ac.type NOT IN ('call', 'board') ${sinceJob('ac.created_at').sql} ORDER BY ac.created_at DESC, ac.id DESC`, a.id, ...sinceJob('ac.created_at').p);
  const interviews = q.all('SELECT * FROM interviews WHERE application_id = ? ORDER BY starts_at DESC', a.id).map((i) => ({
    ...i,
    panel: q.all(`SELECT u.id, u.name, u.title, u.role FROM interview_panel p JOIN users u ON u.id = p.user_id WHERE p.interview_id = ?`, i.id),
    scorecards: q.all(`SELECT sc.*, u.name AS user_name FROM scorecards sc JOIN users u ON u.id = sc.user_id WHERE sc.interview_id = ?`, i.id)
      .map((sc) => ({ ...sc, ratings: json(sc.ratings, {}) })),
  }));
  // The columns the profile has always shown. When the offer was accepted is kept for the reports alone (see reporting.js).
  const offer = q.get('SELECT id, application_id, salary, start_date, status, notes, created_at, updated_at FROM offers WHERE application_id = ?', a.id) || null;
  const emails = agency
    ? q.all(`SELECT x.*, u.name AS sent_by_name FROM ${both('emails', 'agency_emails', 'to_email, subject, body, sent_by, delivery')} x LEFT JOIN users u ON u.id = x.sent_by ${newestFirst}`, a.id)
    : q.all(
      `SELECT e.id, e.application_id, e.to_email, e.subject, e.body, e.sent_by, e.delivery, e.created_at, u.name AS sent_by_name FROM emails e LEFT JOIN users u ON u.id = e.sent_by
       WHERE e.application_id = ? ${sinceJob('e.created_at').sql} ORDER BY e.created_at DESC, e.id DESC`, a.id, ...sinceJob('e.created_at').p);
  const others = q.all(
    `SELECT a.id, a.status, a.job_id, j.title AS job_title, s.name AS stage_name FROM applications a JOIN jobs j ON j.id = a.job_id JOIN stages s ON s.id = a.stage_id
     WHERE a.candidate_id = ? AND a.id != ?`, a.candidate_id, a.id);
  // Other records at this client that carry the same LinkedIn profile link: probably the same person entered twice
  // (sourced, then applied on the careers page). Each is shown with their latest application so it can be opened.
  // For someone saved without a job, the others are people saved without a job (`client_id IS ?` with nothing).
  const key = identityKey(candidate.linkedin);
  const duplicates = key ? q.all(
    `SELECT c.id AS candidate_id, c.name, a.id AS application_id, j.title AS job_title, s.name AS stage_name, a.status
     FROM candidates c JOIN applications a ON a.id = (SELECT x.id FROM applications x WHERE x.candidate_id = c.id ORDER BY x.applied_at DESC, x.id DESC LIMIT 1)
     LEFT JOIN jobs j ON j.id = a.job_id LEFT JOIN stages s ON s.id = a.stage_id
     WHERE c.client_id IS ? AND c.linkedin = ? AND c.id != ? ORDER BY c.id LIMIT 20`, a.client_id, key, candidate.id) : [];
  // The same person on file somewhere else: on another client's record, or in The Book without a job. The agency
  // is shown them on the profile, and asked about them before "Delete all data on this person". Never a client user.
  const elsewhere = agency ? recordsElsewhere(candidate) : [];
  const names = (id) => (id ? q.get('SELECT name FROM users WHERE id = ?', id)?.name ?? null : null);
  const { client_id, job_title, candidate_name, candidate_email, client_name, ...application } = a;
  if (agency) {
    // Removing them from the job, or deleting it, sends them back to The Book: the screens say so before asking.
    application.from_book = cameFromBook(a);
  } else {
    delete application.general_until; // that they were in The Book before this job is the agency's business
    // An entry that became this job's application holds nothing the person wrote to this client: they never applied
    // here themselves. A covering note, screening answers or a consent date still on it would be from The Book, or
    // from another client's job they were on before, so none of the three is passed on. (None should be there: each
    // is taken off the application when it goes back to The Book or onto a job. This is the second lock.)
    if (a.general_until) Object.assign(application, { cover_note: null, answers: '[]', consent_at: null });
  }
  // Résumés that a newer one took the place of. They were the agency's to keep, so only the agency is given them.
  const earlier_resumes = agency ? q.all('SELECT id, resume_name AS name, kept_at FROM earlier_resumes WHERE application_id = ? ORDER BY kept_at DESC, id DESC', a.id) : [];
  res.json({
    application: { ...application, general, answers: json(application.answers, []), submitted_by_name: names(a.submitted_by), reviewed_by_name: names(a.reviewed_by), owner_name: names(a.owner_id) },
    candidate, job, client, stages, notes, activities, interviews, offer, emails, others, duplicates, earlier_resumes,
    ...(agency ? { elsewhere } : {}),
    ...(agency ? { placement: reporting.placementOf(a.id) } : {}), // the fee recorded when they were hired: the agency's business only
    ...(agency ? { board: board.applicationFacts(a.id) } : {}),     // came through the agency's confidential post, and whether they know who the client is
  });
});

api.patch('/applications/:id', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  const b = req.body || {};
  if (b.rating !== undefined) {
    needsJob(a); // a rating says how well someone fits a job
    const rating = int(b.rating);
    q.run('UPDATE applications SET rating = ?, updated_at = ? WHERE id = ?', rating >= 1 && rating <= 5 ? rating : null, now(), a.id);
  }
  if (b.owner_id !== undefined && isAgency(req.user)) {
    // Anyone active on the agency team, or whoever owns them now: saving the form must not fail just because the current owner has since been deactivated.
    const owner = b.owner_id === null || b.owner_id === ''
      ? null
      : q.get(`SELECT id, name FROM users WHERE id = ? AND ((active = 1 AND role != 'client') OR id = ?)`, int(b.owner_id), a.owner_id);
    if (owner === undefined) bad('Choose someone on your own team as the owner.');
    if ((owner?.id ?? null) !== a.owner_id) {
      q.run('UPDATE applications SET owner_id = ?, updated_at = ? WHERE id = ?', owner?.id ?? null, now(), a.id);
      logActivity(a.id, req.user.id, 'owner', owner ? `Assigned to ${owner.name}` : 'Owner removed');
    }
  }
  if (b.candidate && isAgency(req.user)) {
    const c = candidateFields(b.candidate);
    const email = emailOf(b.candidate.email) || null;
    checkContact(a, c, email);
    q.run('UPDATE candidates SET name = ?, email = ?, phone = ?, linkedin = ?, location = ?, current_title = ?, current_company = ? WHERE id = ?',
      c.name, email, c.phone, c.linkedin, c.location, c.current_title, c.current_company, a.candidate_id);
  }
  res.json({ ok: true });
});

api.post('/applications/:id/move', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  needsJob(a);
  const stage = tx(() => moveToStage(a, req.body?.stage_id, req.user));
  res.json({ ok: true, stage: stageFor(stage, req.user) });
});

/** A candidate who has left the pipeline should not keep interviews in people's diaries. */
function cancelUpcomingInterviews(appId, userId) {
  const cancelled = q.run(`UPDATE interviews SET status = 'cancelled' WHERE application_id = ? AND status = 'scheduled' AND starts_at >= ?`, appId, now()).changes;
  if (cancelled) logActivity(appId, userId, 'interview', cancelled === 1 ? 'Cancelled the upcoming interview' : `Cancelled ${cancelled} upcoming interviews`);
  todos.interviewChanged(appId);
}

api.post('/applications/:id/reject', async (req, res) => {
  const a = loadApp(req.params.id, req.user);
  needsJob(a);
  const reason = clean(req.body?.reason, 300) || 'Not specified';
  tx(() => {
    q.run(`UPDATE applications SET status = 'rejected', reject_reason = ?, updated_at = ? WHERE id = ?`, reason, now(), a.id);
    logActivity(a.id, req.user.id, 'rejected', `Rejected: ${reason}`);
    cancelUpcomingInterviews(a.id, req.user.id);
    reporting.leftPipeline(a.id);
  });
  const sent = req.body?.send_email === true && a.candidate_email
    ? await sendTemplate('rejection', { applicationId: a.id, to: a.candidate_email, vars: mailVars(a, req.user), userId: req.user.id, allow: board.mayBeSent(a), reword: board.reword(a) }) : null;
  res.json({ ok: true, ...board.heldNotice(sent, req.user) });
});

api.post('/applications/:id/restore', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  needsJob(a);
  if (a.status === 'active' || a.status === 'hired') return res.json({ ok: true });
  const stage = q.get('SELECT kind FROM stages WHERE id = ?', a.stage_id);
  const hired = stage.kind === 'hired';
  q.run(`UPDATE applications SET status = ?, hired_at = ?, reject_reason = NULL, updated_at = ? WHERE id = ?`,
    hired ? 'hired' : 'active', hired ? a.hired_at ?? a.stage_entered_at : null, now(), a.id);
  logActivity(a.id, req.user.id, 'restored', 'Returned to the pipeline');
  reporting.returned(a.id);
  res.json({ ok: true });
});

api.post('/applications/:id/withdraw', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  needsJob(a);
  const reason = clean(req.body?.reason, 300);
  tx(() => {
    q.run(`UPDATE applications SET status = 'withdrawn', reject_reason = ?, updated_at = ? WHERE id = ?`, reason, now(), a.id);
    logActivity(a.id, req.user.id, 'withdrawn', `Candidate withdrew${reason ? `: ${reason}` : ''}`);
    cancelUpcomingInterviews(a.id, req.user.id);
    reporting.leftPipeline(a.id);
  });
  res.json({ ok: true });
});

// Agency -> client hand-off: the recruiter submits a shortlisted candidate with a write-up, the hiring team approves or declines.
api.post('/applications/:id/submit', agencyOnly, (req, res) => {
  const a = loadApp(req.params.id, req.user);
  needsJob(a);
  if (a.status !== 'active') bad('Return this candidate to the pipeline before submitting them to the hiring team.');
  const note = text(req.body?.note, 6000);
  if (!note) bad('Add a short write-up so the hiring team knows why this candidate is worth meeting.');
  reporting.submitted(a, req.user.id); // before the update below: only a first submission counts
  q.run(`UPDATE applications SET review_status = 'pending', submission_note = ?, submitted_by = ?, review_note = NULL, reviewed_by = NULL, reviewed_at = NULL, updated_at = ? WHERE id = ?`,
    note, req.user.id, now(), a.id);
  logActivity(a.id, req.user.id, 'submitted', 'Submitted to the hiring team for review');
  res.json({ ok: true });
});

api.post('/applications/:id/review', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  needsJob(a);
  if (a.review_status !== 'pending') bad('This candidate is not waiting for review.');
  if (a.status !== 'active') bad('This candidate is no longer in the pipeline.');
  const approve = req.body?.decision === 'approved';
  if (!approve && req.body?.decision !== 'declined') bad('Choose approve or decline.');
  const note = text(req.body?.note, 4000);
  if (!approve && !note) bad('Please say why, so the recruiter can calibrate the search.');
  tx(() => {
    const t = now();
    q.run('UPDATE applications SET review_status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?',
      approve ? 'approved' : 'declined', note, req.user.id, t, t, a.id);
    if (approve) {
      const current = q.get('SELECT * FROM stages WHERE id = ?', a.stage_id);
      const next = q.get(`SELECT * FROM stages WHERE job_id = ? AND position > ? AND kind = 'interview' ORDER BY position LIMIT 1`, a.job_id, current.position);
      const moves = next && current.kind !== 'offer' && current.kind !== 'hired';
      // One click, one line: the approval says where the candidate went.
      logActivity(a.id, req.user.id, 'review', moves ? `Approved for interview and moved to ${next.name}` : 'Approved for interview');
      if (moves) moveToStage(a, next.id, req.user, { quiet: true });
    } else {
      // The whole note is on the candidate; the activity line carries its opening.
      const line = note.replace(/\s+/g, ' ');
      logActivity(a.id, req.user.id, 'review', `Declined at review: ${line.length > 200 ? `${line.slice(0, 200).trimEnd()}…` : line}`);
      q.run(`UPDATE applications SET status = 'rejected', reject_reason = 'Declined by hiring team at review' WHERE id = ?`, a.id);
      cancelUpcomingInterviews(a.id, req.user.id);
    }
  });
  res.json({ ok: true });
});

api.post('/applications/:id/notes', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  const body = text(req.body?.body, 10000);
  if (!body) bad('Write a note first.');
  // A note on someone who is on no job is always the agency's own: no client is in view, and it must not turn up in
  // front of one when the person is later put on that client's job.
  const id = q.insert('INSERT INTO notes (application_id, user_id, body, private, created_at) VALUES (?, ?, ?, ?, ?)',
    a.id, req.user.id, body, isAgency(req.user) && (req.body.private || isGeneral(a)) ? 1 : 0, now());
  q.run('UPDATE applications SET updated_at = ? WHERE id = ?', now(), a.id);
  res.json({ id });
  // The candidate's owner and their job's account executive are told by e-mail, after the answer has gone (note-mail.js).
  noteWritten({ applicationId: a.id, noteId: id, writer: req.user, body });
});

api.delete('/notes/:id', (req, res) => {
  const note = q.get('SELECT * FROM notes WHERE id = ?', int(req.params.id));
  // A note on somebody the user can no longer open (they left the client's job for The Book, or for another client's
  // job) answers as a note that does not exist: the answer must not say that the person is still on file.
  const on = note && q.get('SELECT j.client_id FROM applications a LEFT JOIN jobs j ON j.id = a.job_id WHERE a.id = ?', note.application_id);
  if (!note || note.user_id !== req.user.id || !canSee(req.user, on?.client_id)) bad('You can only delete your own notes.', 403);
  tx(() => {
    q.run('DELETE FROM notes WHERE id = ?', note.id);
    forgetSavedNote(note.id); // a call whose summary was saved as this note must not write over whatever is written next
  });
  res.json({ ok: true });
});

api.post('/applications/:id/emails', async (req, res) => {
  const a = loadApp(req.params.id, req.user);
  // Both must be plain strings. Anything else (an object, say) must never reach the mail library, which would treat it as a file or URL to read.
  const subject = clean(req.body?.subject, 300);
  const body = text(req.body?.body, 20000);
  if (!subject || !body) bad('Subject and message are required.');
  if (!a.candidate_email) bad('There is no email address on file for this candidate. Add one under Edit details first.');
  // A message that names the client, to somebody who applied through the confidential post and has not been told
  // who the client is, is only sent when the recruiter has seen the warning and said so.
  const tells = board.handWritten(a, `${subject}\n${body}`, req.user, req.body?.names_client_ok === true, bad);
  // The message is recorded when the mail provider has answered, on the application as it is by then (see sendMail):
  // the history line goes where the record went, or nowhere when the application was deleted meanwhile.
  const sent = await sendMail({ applicationId: a.id, to: a.candidate_email, subject, body, userId: req.user.id });
  if (sent.applicationId) logActivity(sent.applicationId, req.user.id, 'email', `Emailed candidate: ${subject}`, { at: sent.at, agencyOnly: sent.agencyOnly });
  // Delivered, it has told them. The tick is only made on the application that came through the post: if they
  // left that job while the message was on its way, the post's record of them went with it and nothing is ticked.
  if (tells && sent.delivery === 'sent') board.clientNowKnown(a.id, req.user.id, 'Told who the client is, by e-mail', logActivity);
  res.json({ id: sent.id, delivery: sent.delivery });
});

api.put('/applications/:id/offer', agencyOnly, (req, res) => {
  const a = loadApp(req.params.id, req.user);
  needsJob(a);
  const b = req.body || {};
  const status = ['draft', 'sent', 'accepted', 'declined'].includes(b.status) ? b.status : 'draft';
  const existing = q.get('SELECT * FROM offers WHERE application_id = ?', a.id);
  const t = now();
  const startDate = isStr(b.start_date) && /^\d{4}-\d{2}-\d{2}$/.test(b.start_date) ? b.start_date : null;
  if (existing) q.run('UPDATE offers SET salary = ?, start_date = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?', int(b.salary), startDate, status, text(b.notes, 4000), t, existing.id);
  else q.run('INSERT INTO offers (application_id, salary, start_date, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', a.id, int(b.salary), startDate, status, text(b.notes, 4000), t, t);
  if (!existing || existing.status !== status) logActivity(a.id, req.user.id, 'offer', `Offer ${status === 'draft' ? 'drafted' : status}`);
  reporting.offerSaved(a.id);
  res.json({ ok: true });
});

/**
 * The header that makes a résumé a download under the name it was uploaded with. Always a download, never rendered
 * inside this site: the file came from an anonymous upload. The name is given twice: plain letters for old
 * software, and in full (accents, other alphabets) for every current browser.
 */
function downloadAs(name) {
  const safeName = (name || 'resume').replace(/[^\w.\- ]+/g, '_');
  const fullName = encodeURIComponent((name || 'resume').replace(/[\u0000-\u001f\u007f\\/]+/g, '_')).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${safeName}"; filename*=UTF-8''${fullName}`;
}

api.get('/applications/:id/resume', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  if (!a.resume_file) bad('No résumé on file.', 404);
  res.setHeader('Content-Disposition', downloadAs(a.resume_name));
  // Sent by name from the uploads folder, so a data folder under a hidden folder (~/.thebook, say) is served like any other.
  res.sendFile(path.basename(a.resume_file), { root: UPLOAD_DIR, dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'The résumé file is missing.' });
  });
});

// A résumé this application had before a newer one took its place. Agency only.
api.get('/applications/:id/resumes/:earlier', agencyOnly, (req, res) => {
  const a = loadApp(req.params.id, req.user);
  const kept = q.get('SELECT * FROM earlier_resumes WHERE id = ? AND application_id = ?', int(req.params.earlier), a.id);
  if (!kept) bad('That résumé is no longer on file.', 404);
  res.setHeader('Content-Disposition', downloadAs(kept.resume_name)); // always a download, under its whole name, as for the résumé on file
  res.sendFile(path.basename(kept.resume_file), { root: UPLOAD_DIR, dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'The résumé file is missing.' });
  });
});

/** The contact details a résumé dropped on a profile may fill in, with the words the history uses for each. Never the name. */
const RESUME_DETAILS = [['email', 'email'], ['phone', 'phone'], ['location', 'location'], ['current_title', 'current title'], ['current_company', 'company'], ['linkedin', 'LinkedIn link']];
/** "phone", "phone and location", "phone, location and company". */
const inWords = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// A résumé dropped on a candidate's profile (or chosen there), with the contact details the recruiter chose to take
// from it. The file goes on this application and the details on the person's record in one go, or nothing is kept:
// the details are checked as Edit details checks them, and a profile link that is already on another record at the
// same client (or another entry in The Book) is refused too, since a link is how a person is told apart. A résumé
// that was there is never written over: it is kept under Earlier résumés for the agency (see putResume), and the
// same file sent again is kept once. It is then the application's résumé like any other, and going back to The Book
// treats it as it treats one attached any other way (see returnToBook). Nothing is sent to anybody. The name is never
// changed here: the screen asks before attaching a résumé that has somebody else's name on it.
api.put('/applications/:id/resume', agencyOnly, upload.single('resume'), (req, res) => {
  let stored = false;
  try {
    const a = loadApp(req.params.id, req.user);
    if (!req.file) bad('Choose a résumé to attach.');
    const b = req.body || {};
    const person = q.get('SELECT * FROM candidates WHERE id = ?', a.candidate_id);
    // A detail that was not sent, or was sent empty, stays as it is: the résumé only ever adds or replaces.
    const value = {};
    for (const [key] of RESUME_DETAILS) {
      if (!isStr(b[key]) || !b[key].trim()) continue;
      value[key] = key === 'email' ? emailOf(b[key]) : candidateFields({ [key]: b[key] })[key];
    }
    const filled = RESUME_DETAILS.filter(([key]) => value[key] && value[key] !== person[key]);
    const email = value.email ?? person.email;
    checkContact(a, { name: person.name, linkedin: value.linkedin ?? person.linkedin }, email);
    const key = value.linkedin ? identityKey(value.linkedin) : null;
    if (key && key !== identityKey(person.linkedin)) {
      const other = q.get('SELECT name FROM candidates WHERE client_id IS ? AND linkedin = ? AND id != ? ORDER BY id LIMIT 1', a.client_id, key, a.candidate_id);
      if (other) bad(isGeneral(a) ? `That LinkedIn link is already on ${other.name}'s entry in The Book. Untick it, or check the link.` : `That LinkedIn link is already on ${other.name}'s record at this client. Untick it, or check the link.`);
    }
    const t = now();
    const done = tx(() => {
      const change = putResume(q.get('SELECT * FROM applications WHERE id = ?', a.id), req.file, req.user.id, t);
      if (filled.length) q.run(`UPDATE candidates SET ${filled.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, ...filled.map(([k]) => value[k]), a.candidate_id);
      q.run('UPDATE applications SET updated_at = ? WHERE id = ?', t, a.id);
      // One line, written like the agency's other changes to a profile. It says which details were filled in and not
      // what they were, and nothing about Earlier résumés, which are the agency's business.
      const what = inWords(filled.map(([, label]) => label));
      const said = change.change === 'unchanged'
        ? what && `Filled in ${what} from the résumé on file`
        : `${change.change === 'added' ? 'Résumé added' : 'Résumé replaced'}${what ? `; filled in ${what} from it` : ''}`;
      if (said) logActivity(a.id, req.user.id, 'resume', said, { at: t });
      return change;
    });
    stored = true;
    removeUpload(done.spare); // the same file as the one on file: kept once
    res.json({ ok: true, resume: done.change, filled: filled.map(([k]) => k) });
  } finally {
    if (!stored) removeUpload(req.file?.filename);
  }
});

// Remove one application (and the candidate record if this was their only one). For someone saved to The Book
// without a job, their entry is the only one, so this removes the person with their résumé, photo and calls.
// Somebody who was in The Book before they were put on this job is not deleted: they go back to The Book without a
// job (the answer says `returned`), and only what belonged to the job goes.
api.delete('/applications/:id', agencyOnly, (req, res) => {
  const a = loadApp(req.params.id, req.user);
  if (cameFromBook(a)) {
    const made = [];
    let spare;
    try {
      spare = tx(() => returnToBook(a, req.user, `Removed from ${a.job_title} at ${a.client_name}: back in The Book without a job`, made));
    } catch (err) {
      made.forEach(removeUpload);
      throw err;
    }
    spare.forEach(removeUpload);
    // Their entry keeps its id unless The Book already had an entry for them, which it was then folded into.
    const entry = q.get('SELECT id FROM applications WHERE id = ?', a.id)
      ?? q.get('SELECT a.id FROM applications a JOIN candidates c ON c.id = a.candidate_id WHERE a.job_id IS NULL AND c.client_id IS NULL AND c.email = ?', a.candidate_email);
    return res.json({ ok: true, returned: true, id: entry?.id ?? null });
  }
  const photo = q.get('SELECT photo_file FROM candidates WHERE id = ?', a.candidate_id)?.photo_file;
  const calls = callFilesOf([a.candidate_id]);
  const earlier = earlierResumeFiles('a.id = ?', a.id);
  const inMetaview = conversationsWith(a.candidate_id);
  const gone = tx(() => {
    // Calls recorded with this person stay on their record while they are in another job; they go when the person does.
    detachCallsFrom(a.id);
    q.run('DELETE FROM applications WHERE id = ?', a.id);
    if (q.get('SELECT 1 AS x FROM applications WHERE candidate_id = ?', a.candidate_id)) return false;
    forgetConversations(inMetaview);   // what The Book remembered about their conversations in Metaview goes with them
    q.run('DELETE FROM candidates WHERE id = ?', a.candidate_id);
    return true;
  });
  [a.resume_file, ...earlier].forEach(removeUpload);
  if (gone) { removeUpload(photo); removeCallFiles(calls); scrub(); }
  res.json({ ok: true });
});

// Erase a person completely: every application they made at this client (or their entry in The Book, if they are
// on no job), with its notes, scorecards, interviews, emails and résumé files, their recorded calls (audio,
// transcripts and notes), their contact record, and what The Book remembered about their conversations in Metaview.
// (The conversations themselves stay in Metaview.)
//
// One person can be on file more than once: each client keeps its own record of them, and The Book its own. `also`
// names other records of the same person to erase in the same go (candidate ids, separated by commas). Only records
// the profile showed as theirs are accepted (see recordsElsewhere); anything else is refused and nothing is deleted.
api.delete('/candidates/:id', agencyOnly, (req, res) => {
  const cand = q.get('SELECT * FROM candidates WHERE id = ?', int(req.params.id));
  if (!cand || !canSee(req.user, cand.client_id)) bad('Not found', 404);
  const asked = [...new Set(String(req.query.also ?? '').split(',').map((v) => v.trim()).filter(Boolean).map(int))];
  const theirs = asked.length ? recordsElsewhere(cand) : [];
  if (asked.some((id) => !theirs.some((r) => r.candidate_id === id))) {
    bad('One of the other records is no longer on file as this person’s. Nothing has been deleted: open the profile again and choose once more.', 409);
  }
  const people = [cand, ...asked.map((id) => q.get('SELECT * FROM candidates WHERE id = ?', id))];
  const ids = people.map((p) => p.id);
  const files = people.flatMap((p) => [...q.all('SELECT resume_file FROM applications WHERE candidate_id = ?', p.id).map((r) => r.resume_file), ...earlierResumeFiles('a.candidate_id = ?', p.id)]);
  const calls = callFilesOf(ids);
  const inMetaview = people.flatMap((p) => conversationsWith(p.id));
  // The fingerprints of what they sent clients go with the files (see clientsCopy): every row with the fingerprint of
  // a file removed here.
  const fingerprints = [...new Set(files.filter(Boolean).map(uploadHash).filter(Boolean))];
  tx(() => {
    forgetConversations(inMetaview);
    for (const hash of fingerprints) q.run('DELETE FROM sent_resumes WHERE hash = ?', hash);
    for (const id of ids) {
      q.run('DELETE FROM applications WHERE candidate_id = ?', id);
      q.run('DELETE FROM candidates WHERE id = ?', id); // their calls are removed with them
    }
  });
  files.forEach(removeUpload);
  people.forEach((p) => removeUpload(p.photo_file));
  removeCallFiles(calls);
  scrub();   // what was deleted is not left readable in the database's files
  res.json({ ok: true, erased: ids.length });
});

// A candidate's photo. Shown inside the workspace only, to people who can see that candidate.
api.get('/candidates/:id/photo', (req, res) => {
  const cand = q.get('SELECT client_id, photo_file FROM candidates WHERE id = ?', int(req.params.id));
  if (!cand || !cand.photo_file || !canSee(req.user, cand.client_id) || !seesPhotos(req.user)) bad('Not found', 404);
  // The address changes with the photo, so a copy of the picture never goes stale. Only the picture itself is
  // given that long life: "the file is missing" must not be remembered by the browser for a week.
  const headers = { 'Content-Type': PHOTO_TYPES[path.extname(cand.photo_file)] || 'application/octet-stream', 'Cache-Control': 'private, max-age=604800' };
  res.sendFile(path.basename(cand.photo_file), { root: UPLOAD_DIR, dotfiles: 'allow', headers, cacheControl: false }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Not found' });
  });
});

api.put('/candidates/:id/photo', agencyOnly, candidateUpload, (req, res) => {
  const photo = acceptPhoto(req.files?.photo?.[0]);
  removeUpload(req.files?.resume?.[0]?.filename); // nothing else is expected on this route
  const cand = q.get('SELECT id, client_id, photo_file FROM candidates WHERE id = ?', int(req.params.id));
  if (!cand || !canSee(req.user, cand.client_id)) { removeUpload(photo); bad('Not found', 404); }
  if (!photo) bad('That file is not a JPEG, PNG or WebP image under 3 MB.');
  q.run('UPDATE candidates SET photo_file = ? WHERE id = ?', photo, cand.id);
  removeUpload(cand.photo_file);
  res.json({ ok: true, photo: photoTag(photo) });
});

api.delete('/candidates/:id/photo', agencyOnly, (req, res) => {
  const cand = q.get('SELECT id, client_id, photo_file FROM candidates WHERE id = ?', int(req.params.id));
  if (!cand || !canSee(req.user, cand.client_id)) bad('Not found', 404);
  q.run('UPDATE candidates SET photo_file = NULL WHERE id = ?', cand.id);
  removeUpload(cand.photo_file);
  res.json({ ok: true });
});

/**
 * One record of a person goes and another is kept (inside a transaction, once the applications have been moved).
 * The recorded calls move across, the record that goes is removed, and the kept record takes only the contact
 * details it was missing. Returns what the record that went had and the kept one did not take ("email a@b.c",
 * "phone 555 0100"), so the history can say so and nothing a recruiter typed disappears without trace.
 */
function absorbRecord(from, into) {
  moveCalls(from.id, into.id); // before the record goes, or its recorded calls would go with it
  q.run('DELETE FROM candidates WHERE id = ?', from.id); // gone before its email is copied, so the address is never held twice
  const email = into.email || !from.email || q.get('SELECT 1 AS x FROM candidates WHERE client_id IS ? AND email = ?', into.client_id, from.email) ? into.email : from.email;
  q.run('UPDATE candidates SET email = ?, phone = ?, linkedin = ?, location = ?, current_title = ?, current_company = ?, photo_file = ? WHERE id = ?',
    email, into.phone || from.phone, into.linkedin || from.linkedin, into.location || from.location,
    into.current_title || from.current_title, into.current_company || from.current_company, into.photo_file || from.photo_file, into.id);
  const kept = q.get('SELECT * FROM candidates WHERE id = ?', into.id);
  const fields = [['name', 'name'], ['email', 'email'], ['phone', 'phone'], ['linkedin', 'profile link'], ['location', 'location'], ['current_title', 'title'], ['current_company', 'company']];
  return fields.filter(([key]) => from[key] && from[key] !== kept[key]).map(([key, label]) => `${label} ${from[key]}`);
}
/** The end of a history line that says what a joined record had and the kept record did not take; empty when there was nothing. */
const alsoHad = (left, whose) => (left.length ? `. ${whose} also had: ${left.join(', ')}` : '');

// Join two records that turned out to be one person (sourced without an email, then applied on the careers page,
// say). Everything on :id moves to `into`: its applications with their notes, interviews and emails, and its
// recorded calls. `into` keeps its own details and takes only the contact details it was missing.
api.post('/candidates/:id/merge', agencyOnly, (req, res) => {
  const from = q.get('SELECT * FROM candidates WHERE id = ?', int(req.params.id));
  const into = q.get('SELECT * FROM candidates WHERE id = ?', int(req.body?.into));
  if (!from || !into) bad('Not found', 404);
  if (from.id === into.id) bad('Choose a different record to merge with.');
  if (from.client_id !== into.client_id) {
    bad(from.client_id == null || into.client_id == null
      ? 'One of these is in The Book without a job and the other is on a client’s record. Add the first to a job at that client, and join the two records there.'
      : 'Only records at the same client can be merged.');
  }
  const spare = tx(() => {
    const clash = q.get(
      `SELECT j.title FROM applications a JOIN applications b ON b.job_id = a.job_id AND b.candidate_id = ? JOIN jobs j ON j.id = a.job_id
       WHERE a.candidate_id = ? ORDER BY a.id LIMIT 1`, into.id, from.id);
    if (clash) bad(`Both records are in ${clash.title}. Remove one of them from that job first.`, 409);
    // Two people saved without a job have an entry each, and one person can only have one: the entry of the record
    // that goes is folded into the entry of the record that is kept.
    const entry = (candidateId) => q.get('SELECT * FROM applications WHERE candidate_id = ? AND job_id IS NULL', candidateId);
    const going = entry(from.id), kept = entry(into.id);
    const spareResume = going && kept ? foldEntry(going, kept, req.user.id) : null;
    const moved = going && kept ? [kept] : q.all('SELECT id FROM applications WHERE candidate_id = ?', from.id);
    q.run('UPDATE applications SET candidate_id = ?, updated_at = ? WHERE candidate_id = ?', into.id, now(), from.id);
    const left = absorbRecord(from, into);
    // Among people saved without a job only the agency reads the history, so it also says what the other record
    // had that this one did not take. A client's record keeps the line it has always had.
    for (const app of moved) logActivity(app.id, req.user.id, 'merged', going && kept ? `Merged with ${from.name}'s record${alsoHad(left, 'That record')}` : `Merged with ${into.name}'s record`);
    return spareResume;
  });
  removeUpload(spare);
  if (into.photo_file && from.photo_file) removeUpload(from.photo_file); // the kept record already had its own
  res.json({ ok: true, id: into.id });
});

/**
 * The résumé of an entry that is being folded into another application (inside a transaction). The application
 * that is kept takes it if it has none; otherwise it is kept as an earlier résumé, so neither file is lost. Earlier
 * résumés the entry already had move across too. Returns a file to remove once the change is saved, which there
 * only is when both held the very same file.
 */
function carryResume(going, kept, userId) {
  q.run('UPDATE earlier_resumes SET application_id = ? WHERE application_id = ?', kept.id, going.id);
  if (!going.resume_file) return null;
  if (!kept.resume_file) {
    q.run('UPDATE applications SET resume_file = ?, resume_name = ? WHERE id = ?', going.resume_file, going.resume_name, kept.id);
    return null;
  }
  if (sameUpload(going.resume_file, kept.resume_file)) return going.resume_file;
  q.run('INSERT INTO earlier_resumes (application_id, resume_file, resume_name, kept_at, kept_by) VALUES (?, ?, ?, ?, ?)', kept.id, going.resume_file, going.resume_name, now(), userId);
  return null;
}

/**
 * Two entries of one person saved without a job become one. The notes, history, e-mails and calls on `going` move
 * to `kept`, which keeps its own résumé, owner and covering note and takes the other's where it had none; a second
 * résumé is kept as an earlier one. Returns a résumé file to remove once the change is saved (see carryResume).
 */
function foldEntry(going, kept, userId) {
  for (const table of ['notes', 'activities', 'emails', 'agency_activities', 'agency_emails']) q.run(`UPDATE ${table} SET application_id = ? WHERE application_id = ?`, kept.id, going.id);
  moveCallsToEntry(going.id, kept.id);
  const spare = carryResume(going, kept, userId);
  q.run('UPDATE applications SET cover_note = COALESCE(cover_note, ?), owner_id = COALESCE(owner_id, ?), updated_at = ? WHERE id = ?', going.cover_note, going.owner_id, now(), kept.id);
  board.entryFolded(going.id, kept.id); // what the board had noted about a post they once applied through stays set aside, on the entry that is kept
  reviews.entryFolded(going.id, kept.id, userId); // anybody asked to review them is asked about the entry that is kept
  messages.entryFolded(going.id, kept.id); // and the team's messages about them stay on their profile
  q.run('DELETE FROM applications WHERE id = ?', going.id);
  foldedInto(going.id, kept.id); // a message still on its way to them is recorded there
  return spare;
}

/** A second copy of an uploaded file under a name of its own; null when there is nothing to copy or it cannot be read. */
function copyUpload(name) {
  if (!name) return null;
  const copy = crypto.randomBytes(16).toString('hex') + path.extname(name).toLowerCase();
  try {
    fs.copyFileSync(path.join(UPLOAD_DIR, path.basename(name)), path.join(UPLOAD_DIR, copy));
    return copy;
  } catch { return null; }
}

/**
 * The agency has put somebody on a job, and this is their application in it (inside a transaction). Every way of
 * doing that comes through here: an entry that becomes the job's application, an entry joined to the application
 * the client's record already has in the job, and a new application for somebody on the client's record.
 *
 * Back on the very job they once applied for through its confidential post, they are that post's applicant again,
 * told or not told who the client is as they were when they left it for The Book (see leftJob and putOnJob in
 * board.js). So what The Book sends them by itself still keeps the client's name from somebody who has not been
 * told. On any other job, nothing of the post. The line in the history is one of the board's own, which the client's
 * hiring team is never shown.
 */
function onPostsJob(applicationId, job, user, { at, appliedDirectlyAt = null } = {}) {
  const viaPost = board.putOnJob(applicationId, job.id, appliedDirectlyAt);
  if (!viaPost) return;
  logActivity(applicationId, user.id, 'board', `Applied for this job through your confidential post “${viaPost.title}” before: ${
    viaPost.client_known ? 'they have been told who the client is' : 'they have not been told who the client is'}`, at ? { at } : undefined);
}

/**
 * The entry of someone in The Book becomes a job's application (inside a transaction). It keeps its id, so the
 * notes, résumé and calls on it stay where they are, and the agency goes on reading its whole history. The person
 * takes the job's client; or, when `into` is that client's own record of them, the entry moves onto that record and
 * theirs in The Book is absorbed.
 *
 * From this moment the application is one a client's hiring team can open, so what the agency wrote before it is
 * taken off it first: the history and the e-mails go to the agency's own tables, the notes are made agency only,
 * and a covering note saved with the entry becomes an agency-only note. None of it is left where the hiring team is
 * shown from, whichever version of the code does the showing.
 *
 * Returns the moment they joined the job, and the photo file that is left over when both records had one.
 */
function entryToJob({ entry, person, job, stage, into, user }) {
  // An entry goes on one job. Where two copies of the server share the data folder for a moment (a deploy), the
  // other may have put this one on a job since it was read.
  if (q.get('SELECT job_id FROM applications WHERE id = ?', entry.id)?.job_id !== null) bad(`${person.name} was put on a job a moment ago. Open their profile again.`, 409);
  const hired = stage.kind === 'hired';
  // The moment they join the job, set after everything already written on the entry. The client's hiring team is
  // shown the entry's history from this moment on, so what is written here carries exactly this time.
  const last = q.get(
    `SELECT MAX(at) AS at FROM (SELECT MAX(created_at) AS at FROM activities WHERE application_id = ?1
     UNION ALL SELECT MAX(created_at) FROM agency_activities WHERE application_id = ?1
     UNION ALL SELECT MAX(created_at) FROM notes WHERE application_id = ?1
     UNION ALL SELECT MAX(created_at) FROM emails WHERE application_id = ?1
     UNION ALL SELECT MAX(created_at) FROM agency_emails WHERE application_id = ?1)`, entry.id).at;
  const at = new Date(Math.max(Date.now(), (Date.parse(last) || 0) + 1)).toISOString();
  keepForAgency('x.application_id = ?', [entry.id]);
  if (entry.cover_note) {
    q.run('INSERT INTO notes (application_id, user_id, body, private, created_at) VALUES (?, ?, ?, 1, ?)', entry.id, user.id, `Saved with their entry in The Book: ${entry.cover_note}`, at);
    q.run('UPDATE applications SET cover_note = NULL WHERE id = ?', entry.id);
  }
  if (into) {
    q.run('UPDATE applications SET candidate_id = ? WHERE id = ?', into.id, entry.id);
    // The client's record keeps its own details and takes only what it was missing. That the two were joined, and
    // what the entry had besides, is the agency's business: the hiring team is not shown this line.
    const left = absorbRecord(person, into);
    logActivity(entry.id, user.id, 'merged', `Joined to ${into.name}'s record at ${job.client_name}${alsoHad(left, 'Their entry in The Book')}`, { at, agencyOnly: true });
  } else {
    q.run('UPDATE candidates SET client_id = ? WHERE id = ?', job.client_id, person.id);
  }
  q.run(
    `UPDATE applications SET job_id = ?, stage_id = ?, status = ?, applied_at = ?, stage_entered_at = ?, updated_at = ?, hired_at = ?, general_until = ?,
       owner_id = COALESCE(owner_id, ?) WHERE id = ?`,
    job.id, stage.id, hired ? 'hired' : 'active', at, at, at, hired ? at : null, at, user.id, entry.id);
  q.run('INSERT INTO stage_history (application_id, stage_id, entered_at) VALUES (?, ?, ?)', entry.id, stage.id, at);
  // Notes on someone without a job are always the agency's own; this makes sure of it before a client can open the entry.
  q.run('UPDATE notes SET private = 1 WHERE application_id = ?', entry.id);
  logActivity(entry.id, user.id, 'added', `Added to ${job.title} at ${stage.name}`, { at });
  logArrival(entry.id, user.id, stage, at);
  reporting.arrivedIn(entry.id, stage); // put straight into Hired, they are a placement like anyone added there
  onPostsJob(entry.id, job, user, { at });
  return { at, sparePhoto: into?.photo_file && person.photo_file ? person.photo_file : null };
}

/**
 * The entry of someone in The Book is joined to the application the client's record of them already has in the job
 * (inside a transaction). One person cannot be in a job twice, so the entry does not become a second application:
 * everything on it moves onto the one that is there. Its notes stay agency only, and its history and e-mails go to
 * the agency's own tables under that application, never among the lines the hiring team is shown. What the hiring
 * team does get to see from the entry is what the client's record was missing: contact details, a photo, and the
 * résumé when the application had none (the screen says so before asking). Returns files to remove.
 */
function entryIntoApplication({ entry, person, into, there, job, user }) {
  q.run('UPDATE notes SET application_id = ?, private = 1 WHERE application_id = ?', there.id, entry.id);
  keepForAgency('x.application_id = ?', [entry.id], there.id);
  for (const table of ['agency_activities', 'agency_emails']) q.run(`UPDATE ${table} SET application_id = ? WHERE application_id = ?`, there.id, entry.id);
  moveCallsToEntry(entry.id, there.id);
  // When the application has a résumé of its own, the one the entry brought is set aside as an earlier résumé. It is
  // marked as set aside (nobody "sent a newer one"), so that it can be put back if they return to The Book.
  const spareResume = carryResume(entry, there, null);
  // A covering note saved with the entry was never the candidate's word to this client, so it becomes an agency-only note.
  if (entry.cover_note) q.run('INSERT INTO notes (application_id, user_id, body, private, created_at) VALUES (?, ?, ?, 1, ?)', there.id, user.id, `Saved with their entry in The Book: ${entry.cover_note}`, now());
  q.run('UPDATE applications SET owner_id = COALESCE(owner_id, ?), updated_at = ? WHERE id = ?', entry.owner_id, now(), there.id);
  board.entryFolded(entry.id, there.id); // what the board had set aside for the entry is kept with the application it is folded into
  reviews.entryFolded(entry.id, there.id, user.id); // and so are the requests for somebody on the team to review them, which only the agency reads
  messages.entryFolded(entry.id, there.id); // and the team's messages about them, which only the agency reads as well
  q.run('DELETE FROM applications WHERE id = ?', entry.id);
  foldedInto(entry.id, there.id); // a message still on its way to them is recorded there, for the agency
  const left = absorbRecord(person, into);
  logActivity(there.id, user.id, 'merged', `Joined with their entry in The Book, which had no job${alsoHad(left, 'That entry')}`, { agencyOnly: true });
  // The entry may be that of somebody who applied for this very job through its confidential post and has not been
  // told who the client is. Folded into an application the board has no record of, they are still that person.
  // (An application they made on the client's careers page carries the consent they gave there, and when.)
  onPostsJob(there.id, job, user, { appliedDirectlyAt: there.consent_at ?? null });
  return [spareResume, into.photo_file && person.photo_file ? person.photo_file : null];
}

/**
 * Whether a résumé is one the person sent a client themselves, and so must not be left on their profile when they go
 * back to The Book from application `a`, where the next client's hiring team would be shown it. It is not inferred
 * from what else is on file: it is looked up in what was recorded when they sent it. Each time somebody attaches a
 * résumé to their own application (on a client's careers page, or through the agency's post) the client and the
 * file's SHA-256 are kept in sent_resumes: a fingerprint, which cannot be turned back into the file. The rows go when
 * the person is erased (DELETE /candidates/:id), not when an application of theirs is removed or a job deleted.
 *
 * C is the client whose record the application is on (failing that, the client of its job). A file is held back,
 * and kept under Earlier résumés instead (see returnToBook), where only the agency sees it and nothing is lost, when
 * its fingerprint
 *   (1) was recorded as sent to C, or
 *   (2) was recorded as sent to any client (one no longer known among them) and is the very same file as one of
 *       this application's earlier résumés: what they sent a client before, set aside when they last went back to
 *       The Book, and now attached again on another client's job.
 * Nothing else counts here. A résumé the agency found or made is the agency's, however often the person went back
 * and forth, and goes on to the next client (unless returnToBook's own rule, from before, takes it off: the same file
 * on an application on the client's record that they made themselves). Rule (1) is for one client only: a file they sent client A, held by the
 * agency on an entry that was never on A's record, goes on to client B as before.
 *
 * The limits. What was sent before this version and deleted since is not known: at the first start of this version
 * the résumés then on file on people's own applications were recorded (with their client), and the earlier résumés
 * set aside when an application of somebody's own went back to The Book (with no client: see recordSentBefore); a
 * file deleted before that left no fingerprint. And a file the agency attaches to somebody's entry once they
 * are back in The Book is the agency's choice, and is not checked: rule (2) looks only at the earlier résumés of the
 * application leaving a client's job, and only when it leaves.
 *
 * Answers a test for one file: true when it is to be held back. `row` is the earlier résumé being tested, which is
 * not compared with itself. A file that cannot be read matches nothing. Call it before anything is moved.
 */
function clientsCopy(a) {
  const client = q.get('SELECT client_id FROM candidates WHERE id = ?', a.candidate_id)?.client_id
    ?? q.get('SELECT client_id FROM jobs WHERE id = ?', a.job_id)?.client_id ?? null;
  const earlier = q.all('SELECT id, resume_file FROM earlier_resumes WHERE application_id = ?', a.id)
    .map((r) => ({ id: r.id, hash: uploadHash(r.resume_file) })).filter((r) => r.hash);
  const sentTo = (hash) => q.get('SELECT 1 AS x FROM sent_resumes WHERE hash = ? AND client_id = ? LIMIT 1', hash, client);
  const sentToAny = (hash) => q.get('SELECT 1 AS x FROM sent_resumes WHERE hash = ? LIMIT 1', hash);
  return (file, row = null) => {
    const hash = uploadHash(file);
    if (!hash) return false;
    if (sentTo(hash)) return true;                                                                       // (1)
    return Boolean(sentToAny(hash)) && earlier.some((r) => r.hash === hash && (row === null || r.id !== row)); // (2)
  };
}

/**
 * Once, at the first start of this version: what people sent clients before anything was recorded (see clientsCopy).
 * The résumé on each application they made themselves that is on a job, with that job's client. And, with no client,
 * each earlier résumé that was set aside when an application they had made themselves went back to The Book: that
 * return left the agency's note "From their own application for ..." on it, written at the same moment as the file
 * was set aside. Other earlier résumés are not recorded: before this version a file was also set aside when
 * somebody was saved again with a newer résumé or two of their records were joined, and those are the agency's own.
 * Files no longer on disk are skipped. A setting says it has been done, so it is done once.
 */
function recordSentBefore() {
  if (getSetting('sent_resumes_backfilled')) return;
  tx(() => {
    const t = now();
    const own = q.all(`SELECT resume_file, (SELECT client_id FROM jobs WHERE jobs.id = applications.job_id) AS client_id FROM applications
      WHERE job_id IS NOT NULL AND resume_file IS NOT NULL AND ${OWN_APPLICATION}`);
    for (const r of own) recordSent(r.client_id, r.resume_file, t);
    const theirs = q.all(`SELECT r.resume_file FROM earlier_resumes r WHERE r.kept_by IS NOT NULL AND EXISTS (
      SELECT 1 FROM notes n WHERE n.application_id = r.application_id AND n.created_at = r.kept_at AND n.body LIKE 'From their own application for %')`);
    for (const r of theirs) recordSent(null, r.resume_file, t);
    setSetting('sent_resumes_backfilled', t);
  });
}
recordSentBefore();

/**
 * The résumé on application `a` is kept as one of its earlier résumés (inside a transaction), unless the very same
 * file is among them already: the same file is kept once. Returns the file to remove then, once the change is saved.
 */
function setAside(a, at, userId) {
  const hash = uploadHash(a.resume_file);
  const there = hash && q.all('SELECT resume_file FROM earlier_resumes WHERE application_id = ?', a.id).some((r) => uploadHash(r.resume_file) === hash);
  if (!there) {
    q.run('INSERT INTO earlier_resumes (application_id, resume_file, resume_name, kept_at, kept_by) VALUES (?, ?, ?, ?, ?)', a.id, a.resume_file, a.resume_name, at, userId);
    return [];
  }
  const elsewhere = q.get('SELECT 1 AS x FROM applications WHERE resume_file = ?1 AND id != ?2 UNION ALL SELECT 1 FROM earlier_resumes WHERE resume_file = ?1', a.resume_file, a.id);
  return elsewhere ? [] : [a.resume_file];
}

/**
 * Somebody who was in The Book before they were put on a job goes back to it, instead of being deleted, when that
 * job is deleted or they are removed from it (inside a transaction). What belonged to the job goes with the job:
 * its stage, interviews and scorecards, offer, rating and the write-up for the hiring team. Everything else stays
 * on their entry: notes, résumé, e-mails, calls and history, with `said` added to the history.
 *
 * Their record goes back with them when this was its only application. When the client's record is still needed
 * for another of its jobs, The Book gets a record of its own for the entry, with a copy of the details and photo.
 * And when The Book already has an entry under their e-mail address (they were saved again in the meantime), this
 * one is folded into it, since one person has one entry.
 *
 * `made` collects files copied here, to be removed if the change is not saved. Returns files to remove if it is.
 */
function returnToBook(a, user, said, made) {
  // Every way back to The Book comes through here (removed from the job, the job deleted), and so through clientsCopy.
  const spare = [];
  const person = q.get('SELECT * FROM candidates WHERE id = ?', a.candidate_id);
  const t = now();
  q.run('DELETE FROM interviews WHERE application_id = ?', a.id); // their panels and scorecards go with them
  q.run('DELETE FROM offers WHERE application_id = ?', a.id);
  q.run('DELETE FROM stage_history WHERE application_id = ?', a.id);
  forgetDraftsFor(a.id);
  // What the reports counted for them in this job goes too, as it does when anyone else is removed from a job: the
  // entry keeps its id, and what it is counted for on the next job must start from nothing.
  reporting.leftJob(a.id);
  todos.leftJob(a.id); // and nobody has them to prep or debrief for that job any more
  // "Added" on an entry is the day the person was first saved, which is the first line of its history.
  const first = q.get(
    `SELECT MIN(at) AS at FROM (SELECT MIN(created_at) AS at FROM activities WHERE application_id = ?1
     UNION ALL SELECT MIN(created_at) FROM agency_activities WHERE application_id = ?1)`, a.id).at ?? a.applied_at;
  // What the person wrote to this client when they applied here themselves (the entry was joined to an application
  // they had made): their answers to this client's questions, their covering note, and the consent they gave on
  // this client's form. None of it may travel on the application to the next job, which can be another client's. It
  // is kept for the agency as a note, and the application goes back to The Book without it.
  const given = json(a.answers, []);
  const answers = (Array.isArray(given) ? given : []).filter((x) => x && (x.question || x.answer));
  // An application made through the agency's confidential post has a record of that on the board's side: the title
  // they saw and whether they have been told who the client is. That belongs to this job and goes with it. The
  // agency's note says what it was; nothing of it is on the entry that goes on to the next job. (The board sets it
  // aside where only onPostsJob looks, and puts it back if they are put on this same job again.)
  const viaPost = board.leftJob(a.id);
  if (answers.length || a.cover_note || a.consent_at || viaPost) {
    const where = q.get('SELECT j.title, cl.name AS client FROM jobs j JOIN clients cl ON cl.id = j.client_id WHERE j.id = ?', a.job_id);
    const whose = where ? `${where.title} at ${where.client}` : 'the job they were on';
    // Somebody the agency put back on the job they had once applied for through its post has nothing of their own
    // on the application this time: only the board's record of them, which is set aside again.
    const theirs = answers.length || a.cover_note || ownApplication(a);
    const kept = [
      `${theirs ? 'From their own application for' : 'From their time on'} ${whose}${a.consent_at ? `, where they agreed to their data being processed on ${a.consent_at.slice(0, 10)}` : ''}. Kept for the agency only.`,
      viaPost,
      answers.length ? `Screening answers:\n${answers.map((x) => `${x.question || 'Question'}\n${x.answer || '(no answer)'}`).join('\n\n')}` : null,
      a.cover_note ? `Note from the candidate:\n${a.cover_note}` : null,
    ].filter(Boolean).join('\n\n');
    q.run('INSERT INTO notes (application_id, user_id, body, private, created_at) VALUES (?, ?, ?, 1, ?)', a.id, user.id, kept, t);
  }
  // The résumé is the same question. An application the client's record already had kept its own résumé when the
  // entry was joined to it, and the one the entry brought was set aside as an earlier résumé (see
  // entryIntoApplication). Back in The Book the entry has the résumé it brought again, and the application's own is
  // kept as an earlier résumé, which only the agency is given: it was that client's, and left as the entry's résumé
  // it would be shown to the next client's hiring team. When the entry brought none, a résumé the person sent this
  // client with their own application is still taken off (also the copy of it that went with them to another of the
  // client's jobs), and the entry goes back without one. A résumé the agency attached on the profile is treated the
  // same way as any other. Last, whichever file would be on the profile in The Book is held to clientsCopy below.
  const brought = q.get('SELECT * FROM earlier_resumes WHERE application_id = ? AND kept_by IS NULL ORDER BY kept_at DESC, id DESC LIMIT 1', a.id);
  const theirOwn = a.resume_file && (ownApplication(a)
    || q.all(`SELECT resume_file FROM applications WHERE candidate_id = ? AND id != ? AND resume_file IS NOT NULL AND ${OWN_APPLICATION}`, a.candidate_id, a.id)
      .some((other) => sameUpload(other.resume_file, a.resume_file)));
  const isClients = clientsCopy(a);
  if (brought || theirOwn || (a.resume_file && isClients(a.resume_file))) {
    if (a.resume_file) spare.push(...setAside(a, t, user.id));
    // The résumé the entry brought goes back on the profile, unless it is the client's too: then it stays aside.
    const back = brought && !isClients(brought.resume_file, brought.id) ? brought : null;
    q.run('UPDATE applications SET resume_file = ?, resume_name = ? WHERE id = ?', back?.resume_file ?? null, back?.resume_name ?? null, a.id);
    if (back) q.run('DELETE FROM earlier_resumes WHERE id = ?', back.id);
  }
  q.run('UPDATE earlier_resumes SET kept_by = ? WHERE application_id = ? AND kept_by IS NULL', user.id, a.id); // nothing stays set aside in The Book
  // Folded into another entry of theirs (below), that entry's résumé is the one on the profile: it is held to the same test.
  const twinsCopy = clientsCopy({ ...a, ...q.get('SELECT resume_file FROM applications WHERE id = ?', a.id) });
  q.run(
    `UPDATE applications SET job_id = NULL, stage_id = NULL, status = 'active', rating = NULL, reject_reason = NULL, review_status = NULL, submission_note = NULL,
       review_note = NULL, submitted_by = NULL, reviewed_by = NULL, reviewed_at = NULL, hired_at = NULL, general_until = NULL,
       answers = '[]', cover_note = NULL, consent_at = NULL,
       -- They applied to that client themselves; in The Book they are somebody the agency holds.
       source = CASE WHEN ${OWN_APPLICATION} THEN 'agency_sourced' ELSE source END,
       applied_at = ?, stage_entered_at = ?, updated_at = ? WHERE id = ?`, first, t, t, a.id);
  // Notes on someone without a job are the agency's own, including any the hiring team could read while they were on the job.
  q.run('UPDATE notes SET private = 1 WHERE application_id = ?', a.id);
  logActivity(a.id, user.id, 'returned', said, { at: t });

  const elsewhere = q.get('SELECT 1 AS x FROM applications WHERE candidate_id = ? AND id != ?', person.id, a.id);
  const twin = person.email ? q.get('SELECT * FROM candidates WHERE client_id IS NULL AND email = ?', person.email) : null;
  /** Fill in what a record in The Book is missing from the client's record, which stays as it is. */
  const lend = (toId, photo) => q.run(
    `UPDATE candidates SET phone = COALESCE(phone, ?), linkedin = COALESCE(linkedin, ?), location = COALESCE(location, ?), current_title = COALESCE(current_title, ?),
       current_company = COALESCE(current_company, ?), photo_file = COALESCE(photo_file, ?) WHERE id = ?`,
    person.phone, person.linkedin, person.location, person.current_title, person.current_company, photo, toId);
  const copyPhoto = () => { const copy = copyUpload(person.photo_file); if (copy) made.push(copy); return copy; };
  if (twin) {
    const theirs = q.get('SELECT * FROM applications WHERE candidate_id = ? AND job_id IS NULL', twin.id);
    if (theirs?.resume_file && twinsCopy(theirs.resume_file)) {
      // Kept with the others under Earlier résumés (once); the entry then takes the résumé this application has, if any.
      q.run('UPDATE applications SET resume_file = NULL, resume_name = NULL WHERE id = ?', theirs.id);
      spare.push(...setAside({ ...theirs, id: a.id }, t, user.id));
    }
    if (theirs) spare.push(foldEntry(q.get('SELECT * FROM applications WHERE id = ?', a.id), q.get('SELECT * FROM applications WHERE id = ?', theirs.id), user.id));
    else q.run('UPDATE applications SET candidate_id = ? WHERE id = ?', twin.id, a.id);
    if (elsewhere) {
      moveEntryCallsToRecord(theirs?.id ?? a.id, twin.id);
      lend(twin.id, twin.photo_file ? null : copyPhoto());
    } else {
      absorbRecord(person, twin);
      if (twin.photo_file && person.photo_file) spare.push(person.photo_file);
    }
  } else if (elsewhere) {
    const id = q.insert(
      'INSERT INTO candidates (client_id, name, email, phone, linkedin, location, current_title, current_company, photo_file, created_at) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      person.name, person.email, person.phone, person.linkedin, person.location, person.current_title, person.current_company, copyPhoto(), t);
    q.run('UPDATE applications SET candidate_id = ? WHERE id = ?', id, a.id);
    moveEntryCallsToRecord(a.id, id);
  } else {
    q.run('UPDATE candidates SET client_id = NULL WHERE id = ?', person.id);
  }
  return spare;
}

// Put somebody who is already in The Book on a job.
//
// Someone saved without a job: their entry becomes that job's application. It keeps its id, so the notes, résumé,
// calls and history written on it stay where they are, and the person takes the job's client. If that client already
// has a record of the same person (same e-mail or LinkedIn link), nothing is done until the request says which
// record to join them to (`into`); the entry then moves to that record with everything on it. When that record is
// in the job already, the entry is folded into the application it has there, since nobody can be in a job twice.
//
// Someone already on a job: they are added to another job of the same client as a new application. Each client
// keeps its own record of a person, so a job of another client is refused.
api.post('/applications/:id/add-to-job', agencyOnly, (req, res) => {
  const a = loadApp(req.params.id, req.user);
  const b = req.body || {};
  const job = q.get('SELECT j.id, j.title, j.client_id, cl.name AS client_name FROM jobs j JOIN clients cl ON cl.id = j.client_id WHERE j.id = ?', int(b.job_id));
  if (!job) bad('Choose a job to add them to.');
  const stage = b.stage_id == null || b.stage_id === ''
    ? q.get('SELECT * FROM stages WHERE job_id = ? ORDER BY position LIMIT 1', job.id)
    : q.get('SELECT * FROM stages WHERE id = ? AND job_id = ?', int(b.stage_id), job.id);
  if (!stage) bad('That stage does not belong to this job.');
  const hired = stage.kind === 'hired';
  /** The application this record has in the job, if it is in it already. */
  const inJob = (record) => q.get('SELECT a.*, s.name AS stage_name FROM applications a JOIN stages s ON s.id = a.stage_id WHERE a.candidate_id = ? AND a.job_id = ?', record.id, job.id);
  /** Refuse because this record is in the job already, and say which application that is so the screen can open it. */
  const refuseInJob = (record, there, extra) =>
    bad(`${record.name} is already in the pipeline for ${job.title} (${there.stage_name}).`, 409, { code: 'already_in_job', id: there.id, ...extra });

  if (!isGeneral(a)) {
    if (job.client_id !== a.client_id) {
      bad(`${a.candidate_name} is on ${a.client_name}'s record, and ${job.title} is a job at ${job.client_name}. Each client keeps its own record of a person, so add them to that job as a new candidate.`);
    }
    const self = { id: a.candidate_id, name: a.candidate_name };
    const there = inJob(self);
    if (there) refuseInJob(self, there);
    // "Our website" is only ever an application somebody made on the agency's board: nobody is put on a job under it.
    const source = isStr(b.source) && Object.hasOwn(SOURCE_LABELS, b.source) && b.source !== board.SOURCE ? b.source : 'agency_sourced';
    // Their résumé goes with them as a copy of its own, because each application's file is removed with that application.
    const resume = copyUpload(a.resume_file);
    try {
      const id = tx(() => {
        const t = now();
        const appId = q.insert(
          `INSERT INTO applications (candidate_id, job_id, stage_id, status, source, resume_file, resume_name, applied_at, stage_entered_at, updated_at, hired_at, owner_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          a.candidate_id, job.id, stage.id, hired ? 'hired' : 'active', source, resume, resume ? a.resume_name : null, t, t, t, hired ? t : null, req.user.id);
        q.run('INSERT INTO stage_history (application_id, stage_id, entered_at) VALUES (?, ?, ?)', appId, stage.id, t);
        logActivity(appId, req.user.id, 'added', `Added to ${job.title} at ${stage.name}`, { at: t });
        logArrival(appId, req.user.id, stage, t);
        reporting.arrivedIn(appId, stage);
        onPostsJob(appId, job, req.user, { at: t });
        return appId;
      });
      return res.json({ id, merged: false });
    } catch (err) {
      removeUpload(resume);
      throw err;
    }
  }

  const person = q.get('SELECT * FROM candidates WHERE id = ?', a.candidate_id);
  // The client's own records of this person: the one with their e-mail address, and any with their LinkedIn link.
  const key = identityKey(person.linkedin);
  const records = new Map();
  if (person.email) for (const r of q.all('SELECT * FROM candidates WHERE client_id = ? AND email = ?', job.client_id, person.email)) records.set(r.id, r);
  if (key) for (const r of q.all('SELECT * FROM candidates WHERE client_id = ? AND linkedin = ? ORDER BY id LIMIT 20', job.client_id, key)) records.set(r.id, r);
  const into = b.into == null || b.into === '' ? null
    : records.get(int(b.into)) ?? bad(`The record you chose is not one of ${job.client_name}'s records of this person. Go back and choose again.`);
  // A record of theirs that is in the job already. The entry can be joined to it (`join` says to which record), and
  // until the request asks for exactly that, nothing is done.
  for (const record of records.values()) {
    const there = inJob(record);
    if (there && record.id !== into?.id) refuseInJob(record, there, { join: { candidate_id: record.id, name: record.name } });
  }
  if (records.size && !into) {
    // A record with no application at all is still a record of them, so it is listed too, with no job to name.
    const matches = q.all(
      `SELECT c.id AS candidate_id, c.name, a.id AS application_id, j.title AS job_title, s.name AS stage_name
       FROM candidates c LEFT JOIN applications a ON a.id = (SELECT x.id FROM applications x WHERE x.candidate_id = c.id ORDER BY x.applied_at DESC, x.id DESC LIMIT 1)
       LEFT JOIN jobs j ON j.id = a.job_id LEFT JOIN stages s ON s.id = a.stage_id
       WHERE c.id IN (${[...records.keys()].join(',')}) ORDER BY c.id`); // whole numbers from our own table
    bad(`${job.client_name} already has a record of ${matches[0]?.name ?? person.name}. Join this entry to that record to add them to ${job.title}.`, 409, { code: 'duplicate_in_client', matches });
  }

  const there = into && inJob(into);
  if (there) {
    const spare = tx(() => entryIntoApplication({ entry: a, person, into, there, job, user: req.user }));
    spare.forEach(removeUpload);
    return res.json({ id: there.id, merged: true });
  }
  const { sparePhoto } = tx(() => entryToJob({ entry: a, person, job, stage, into, user: req.user }));
  removeUpload(sparePhoto); // the client's record already had its own
  res.json({ id: a.id, merged: Boolean(into) });
});

// ---------- interviews + scorecards ----------
const interviewSelect = `
  SELECT i.*, c.name AS candidate_name, j.id AS job_id, j.title AS job_title, cl.id AS client_id, cl.name AS client_name, cl.brand_color
  FROM interviews i
  JOIN applications a ON a.id = i.application_id
  JOIN candidates c ON c.id = a.candidate_id
  JOIN jobs j ON j.id = a.job_id
  JOIN clients cl ON cl.id = j.client_id`;

function withPanels(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id).join(',');
  const panel = q.all(
    `SELECT p.interview_id, u.id, u.name, u.role,
       EXISTS (SELECT 1 FROM scorecards sc WHERE sc.interview_id = p.interview_id AND sc.user_id = u.id) AS submitted
     FROM interview_panel p JOIN users u ON u.id = p.user_id WHERE p.interview_id IN (${ids})`);
  return rows.map((r) => ({ ...r, panel: panel.filter((p) => p.interview_id === r.id) }));
}

api.get('/interviews', (req, res) => {
  const cid = scopeOf(req);
  const where = [], p = [];
  if (cid) { where.push('cl.id = ?'); p.push(cid); }
  if (req.query.when === 'upcoming') { where.push(`i.status = 'scheduled' AND i.starts_at >= ? AND a.status IN ('active', 'hired')`); p.push(new Date(Date.now() - 3600000).toISOString()); }
  if (req.query.when === 'past') { where.push(`(i.status != 'scheduled' OR i.starts_at < ? OR a.status NOT IN ('active', 'hired'))`); p.push(new Date(Date.now() - 3600000).toISOString()); }
  if (req.query.when === 'feedback') {
    where.push(`i.status != 'cancelled' AND i.starts_at < ? AND EXISTS (SELECT 1 FROM interview_panel p WHERE p.interview_id = i.id AND p.user_id = ?)
      AND NOT EXISTS (SELECT 1 FROM scorecards sc WHERE sc.interview_id = i.id AND sc.user_id = ?)`);
    p.push(now(), req.user.id, req.user.id);
  }
  const order = req.query.when === 'upcoming' ? 'ASC' : 'DESC';
  res.json(withPanels(q.all(`${interviewSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.starts_at ${order} LIMIT 200`, ...p)));
});

function loadInterview(id, user) {
  const i = q.get(`${interviewSelect} WHERE i.id = ?`, int(id));
  if (!i || !canSee(user, i.client_id)) bad('Not found', 404);
  return i;
}
function setPanel(interviewId, clientId, userIds) {
  q.run('DELETE FROM interview_panel WHERE interview_id = ?', interviewId);
  for (const uid of new Set((userIds || []).map(int).filter(Boolean))) {
    const u = q.get('SELECT * FROM users WHERE id = ? AND active = 1', uid);
    if (u && (u.role !== 'client' || u.client_id === clientId)) q.run('INSERT INTO interview_panel (interview_id, user_id) VALUES (?, ?)', interviewId, uid);
  }
}
const KIND_LABELS = { phone: 'Phone call', video: 'Video call', onsite: 'On-site', technical: 'Technical interview' };

api.post('/interviews', async (req, res) => {
  const b = req.body || {};
  const a = loadApp(b.application_id, req.user);
  needsJob(a);
  const starts = new Date(b.starts_at);
  const title = clean(b.title, 160);
  if (!title || Number.isNaN(starts.getTime())) bad('Give the interview a title and a start time.');
  if (a.status !== 'active' && a.status !== 'hired') bad('Return this candidate to the pipeline before scheduling an interview.');
  const kind = isStr(b.kind) && Object.hasOwn(KIND_LABELS, b.kind) ? b.kind : 'video';
  const id = tx(() => {
    const iid = q.insert(
      `INSERT INTO interviews (application_id, title, kind, starts_at, duration_min, location, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.id, title, kind, starts.toISOString(), Math.min(480, Math.max(10, int(b.duration_min) ?? 45)), clean(b.location, 300), text(b.notes, 4000), req.user.id, now());
    setPanel(iid, a.client_id, Array.isArray(b.panel) ? b.panel.slice(0, 20) : []);
    logActivity(a.id, req.user.id, 'interview_booked', `Scheduled ${title}`); // its own type: a title can start with "Scheduled" too
    reporting.interviewScheduled(a.id);
    todos.interviewChanged(a.id);
    return iid;
  });
  const sent = b.notify && a.candidate_email ? await sendTemplate('interview_invite', {
    applicationId: a.id, to: a.candidate_email, userId: req.user.id, allow: board.mayBeSent(a), reword: board.reword(a),
    vars: { ...mailVars(a, req.user), interview_time: clean(b.time_label, 120) || starts.toUTCString(), interview_format: KIND_LABELS[kind], interview_location: clean(b.location, 300) || 'Details to follow' },
  }) : null;
  res.json({ id, ...board.heldNotice(sent, req.user) });
});

api.patch('/interviews/:id', async (req, res) => {
  const i = loadInterview(req.params.id, req.user);
  const b = req.body || {};
  let changed = null; // the interview as it now stands, when its details were edited
  tx(() => {
    if (b.status && ['scheduled', 'completed', 'cancelled'].includes(b.status) && b.status !== i.status) {
      q.run('UPDATE interviews SET status = ? WHERE id = ?', b.status, i.id);
      logActivity(i.application_id, req.user.id, 'interview', `${i.title} marked ${b.status}`);
    }
    if (b.starts_at) {
      const starts = new Date(b.starts_at);
      if (Number.isNaN(starts.getTime())) bad('That start time is not valid.');
      const title = clean(b.title, 160) ?? i.title;
      q.run('UPDATE interviews SET title = ?, kind = ?, starts_at = ?, duration_min = ?, location = ?, notes = ? WHERE id = ?',
        title, isStr(b.kind) && Object.hasOwn(KIND_LABELS, b.kind) ? b.kind : i.kind, starts.toISOString(),
        Math.min(480, Math.max(10, int(b.duration_min) ?? i.duration_min)), clean(b.location, 300), text(b.notes, 4000), i.id);
      changed = q.get('SELECT title, kind, starts_at, duration_min, location FROM interviews WHERE id = ?', i.id);
      if (starts.toISOString() !== i.starts_at) logActivity(i.application_id, req.user.id, 'interview', `Rescheduled ${title}`);
      // A new place, length, format or name is worth a line too, so the history says the details were changed and by whom.
      else if (['title', 'kind', 'duration_min', 'location'].some((k) => (changed[k] ?? '') !== (i[k] ?? ''))) logActivity(i.application_id, req.user.id, 'interview', `Updated ${title}`);
    }
    if (Array.isArray(b.panel)) setPanel(i.id, i.client_id, b.panel.slice(0, 20));
    todos.interviewChanged(i.application_id);
  });
  // Asked for, the candidate is sent the invitation again with the details as they now are.
  let sent = null;
  if (changed && b.notify) {
    const a = loadApp(i.application_id, req.user);
    if (a.candidate_email) sent = await sendTemplate('interview_invite', {
      applicationId: a.id, to: a.candidate_email, userId: req.user.id, allow: board.mayBeSent(a), reword: board.reword(a),
      vars: { ...mailVars(a, req.user), interview_time: clean(b.time_label, 120) || new Date(changed.starts_at).toUTCString(), interview_format: KIND_LABELS[changed.kind], interview_location: changed.location || 'Details to follow' },
    });
  }
  res.json({ ok: true, ...board.heldNotice(sent, req.user) });
});

api.get('/interviews/:id/ics', (req, res) => {
  const i = loadInterview(req.params.id, req.user);
  const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s) => String(s || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const end = new Date(new Date(i.starts_at).getTime() + i.duration_min * 60000);
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Book//Recruiting//EN', 'BEGIN:VEVENT',
    `UID:interview-${i.id}@thebook`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(i.starts_at)}`, `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(`${i.title}: ${i.candidate_name} (${i.job_title})`)}`, `LOCATION:${esc(i.location)}`, `DESCRIPTION:${esc(i.notes)}`,
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="interview-${i.id}.ics"`);
  res.send(ics);
});

api.post('/interviews/:id/scorecard', (req, res) => {
  const i = loadInterview(req.params.id, req.user);
  const b = req.body || {};
  if (!['strong_yes', 'yes', 'no', 'strong_no'].includes(b.recommendation)) bad('Choose an overall recommendation.');
  const ratings = {};
  for (const [k, v] of Object.entries(b.ratings && typeof b.ratings === 'object' ? b.ratings : {}).slice(0, 20)) if (int(v) >= 1 && int(v) <= 4) ratings[String(k).slice(0, 80)] = int(v);
  const label = { strong_yes: 'Strong yes', yes: 'Yes', no: 'No', strong_no: 'Strong no' }[b.recommendation];
  tx(() => {
    q.run(
      `INSERT INTO scorecards (interview_id, user_id, recommendation, ratings, notes, submitted_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(interview_id, user_id) DO UPDATE SET recommendation = excluded.recommendation, ratings = excluded.ratings, notes = excluded.notes, submitted_at = excluded.submitted_at`,
      i.id, req.user.id, b.recommendation, JSON.stringify(ratings), text(b.notes, 10000), now());
    q.run('INSERT OR IGNORE INTO interview_panel (interview_id, user_id) VALUES (?, ?)', i.id, req.user.id);
    if (i.status === 'scheduled') q.run(`UPDATE interviews SET status = 'completed' WHERE id = ?`, i.id);
    logActivity(i.application_id, req.user.id, 'scorecard', `Submitted a scorecard for ${i.title}: ${label}`);
    todos.interviewChanged(i.application_id); // a scorecard marks the interview completed
  });
  res.json({ ok: true });
});

// ---------- dashboard ----------
/**
 * The job board on the agency's dashboard: one column for each account executive, with their jobs in it. Open jobs,
 * and paused and draft ones as well when asked for; a closed job is never on it. The signed-in person's own column
 * comes first, then the others by name, and jobs with no account executive are in a last column of their own. Nobody
 * has a column without a job in view. Somebody who has been deactivated keeps theirs, marked, until their jobs are
 * handed on. In a column: open jobs first, the one open longest at the top, then paused ones, then drafts.
 */
function jobBoard(user, clientId, withPausedAndDraft) {
  const statuses = withPausedAndDraft ? ['open', 'paused', 'draft'] : ['open'];
  const rows = q.all(
    `${jobSelect} WHERE j.status IN (${statuses.map(() => '?').join(', ')}) ${clientId ? 'AND j.client_id = ?' : ''}
     ORDER BY CASE j.status WHEN 'open' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, j.opened_at IS NULL, j.opened_at, j.id`, ...statuses, ...(clientId ? [clientId] : []));
  const columns = new Map();
  for (const j of rows) {
    const key = j.account_executive_id ?? 'none';
    if (!columns.has(key)) columns.set(key, { id: j.account_executive_id, name: j.account_executive_name, active: j.account_executive_active, you: j.account_executive_id === user.id, jobs: [] });
    columns.get(key).jobs.push({
      id: j.id, title: j.title, status: j.status, client_id: j.client_id, client_name: j.client_name, brand_color: j.brand_color, opened_at: j.opened_at,
      openings: j.openings, hires: j.hires, in_pipeline: j.active_candidates, interviewing: j.interviewing, offers: j.offers,
    });
  }
  const place = (c) => (c.you ? 0 : c.id == null ? 2 : 1);
  return [...columns.values()].sort((a, b) => place(a) - place(b) || String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }) || a.id - b.id);
}

// The most people named under one stage when a card on the job board drops its pipeline down (see JobBoard.jsx).
const BOARD_PEOPLE = 8;
/**
 * One job's pipeline for its card on the job board: every stage in order, how many people are in it, and the first
 * few of them, newest first. The people are those the job's own Pipeline tab shows: in the pipeline, or hired; not
 * those rejected or withdrawn. Kept small, because every open card asks for it again whenever something is saved.
 * The board is the agency's, so this is too.
 */
api.get('/jobs/:id/pipeline', agencyOnly, (req, res) => {
  const job = loadJob(req.params.id, req.user);
  const people = hidePhotos(q.all(
    `SELECT a.id, a.stage_id, a.status, c.id AS candidate_id, c.name, c.current_title, c.current_company, substr(c.photo_file, 1, 8) AS photo
     FROM applications a JOIN candidates c ON c.id = a.candidate_id
     WHERE a.job_id = ? AND a.status IN ('active', 'hired') ORDER BY a.applied_at DESC, a.id DESC`, job.id), req.user);
  const stages = q.all('SELECT id, name, kind FROM stages WHERE job_id = ? ORDER BY position', job.id).map((stage) => {
    const here = people.filter((a) => a.stage_id === stage.id);
    return { ...stage, count: here.length, people: here.slice(0, BOARD_PEOPLE).map(({ stage_id, ...a }) => a) };
  });
  res.json({ stages });
});

api.get('/dashboard', (req, res) => {
  const cid = scopeOf(req);
  const w = cid ? 'AND j.client_id = ?' : '';
  const p = cid ? [cid] : [];
  const n = (sql, ...params) => q.get(sql, ...params).n;
  const appJoin = 'FROM applications a JOIN jobs j ON j.id = a.job_id JOIN stages s ON s.id = a.stage_id';
  const stats = {
    open_jobs: n(`SELECT COUNT(*) n FROM jobs j WHERE j.status = 'open' ${w}`, ...p),
    active_candidates: n(`SELECT COUNT(*) n ${appJoin} WHERE a.status = 'active' ${w}`, ...p),
    new_applicants: n(`SELECT COUNT(*) n ${appJoin} WHERE a.status = 'active' AND s.kind = 'applied' ${w}`, ...p),
    interviews_week: n(`SELECT COUNT(*) n FROM interviews i JOIN applications a ON a.id = i.application_id JOIN jobs j ON j.id = a.job_id
      WHERE i.status = 'scheduled' AND a.status IN ('active', 'hired') AND i.starts_at >= ? AND i.starts_at < ? ${w}`, now(), new Date(Date.now() + 7 * DAY).toISOString(), ...p),
    offers_out: n(`SELECT COUNT(*) n ${appJoin} WHERE a.status = 'active' AND s.kind = 'offer' ${w}`, ...p),
    hires_90d: n(`SELECT COUNT(*) n ${appJoin} WHERE a.status = 'hired' AND a.hired_at >= ? ${w}`, daysAgo(90), ...p),
    pending_review: n(`SELECT COUNT(*) n ${appJoin} WHERE a.status = 'active' AND a.review_status = 'pending' ${w}`, ...p),
  };
  const upcoming = withPanels(q.all(
    `${interviewSelect} WHERE i.status = 'scheduled' AND i.starts_at >= ? AND a.status IN ('active', 'hired') ${cid ? 'AND cl.id = ?' : ''} ORDER BY i.starts_at LIMIT 6`,
    new Date(Date.now() - 3600000).toISOString(), ...p));
  const jobs = q.all(`${jobSelect} WHERE j.status = 'open' ${w} ORDER BY new_applicants DESC, j.opened_at LIMIT 8`, ...p)
    .map(({ description, ideal_profile, brief, fee_percent, questions, criteria, off_careers, ...j }) => (isAgency(req.user) ? withoutClientFile(j) : withoutAgencyPeople(j)));
  const recent = q.all(
    `SELECT ac.id, ac.type, ac.detail, ac.created_at, ac.application_id, u.name AS user_name, c.name AS candidate_name, j.title AS job_title, cl.name AS client_name,
       -- The moments worth shouting about: into an interview stage, an interview booked, approved by the hiring team,
       -- an offer made or accepted, a hire. Each is told by its type (older rows are given theirs when the database opens).
       -- A line from before somebody was put on this job is not this job's news: they were in The Book then, or on
       -- an earlier job they came back from, and its interviews and offers were that job's. Such lines are not in
       -- this table once the person is on a job (they are the agency's own, see agency_activities), so they are in
       -- nobody's feed, the agency's included; the date is asked as well in case one ever were.
       CASE
         WHEN a.general_until IS NOT NULL AND ac.created_at < a.general_until THEN NULL
         WHEN ac.type = 'hired' THEN 'hired'
         WHEN ac.type = 'stage_interview' THEN 'interview'
         WHEN ac.type = 'stage_offer' THEN 'offer'
         WHEN ac.type = 'interview_booked' THEN 'booked'
         WHEN ac.type = 'review' AND ac.detail LIKE 'Approved%' THEN 'approved'
         WHEN ac.type = 'offer' AND ac.detail = 'Offer sent' THEN 'sent'
         WHEN ac.type = 'offer' AND ac.detail = 'Offer accepted' THEN 'accepted'
       END AS milestone
     FROM activities ac JOIN applications a ON a.id = ac.application_id JOIN candidates c ON c.id = a.candidate_id
     JOIN jobs j ON j.id = a.job_id JOIN clients cl ON cl.id = j.client_id LEFT JOIN users u ON u.id = ac.user_id
     WHERE ${isAgency(req.user) ? '1 = 1' : `ac.type NOT IN ('call', 'board') AND (a.general_until IS NULL OR ac.created_at >= a.general_until)`} ${w} ORDER BY ac.created_at DESC, ac.id DESC LIMIT 15`, ...p);
  const stale = q.all(
    `${appSelect} WHERE a.status = 'active' AND s.kind IN ('interview', 'offer') AND a.stage_entered_at < ? ${w}
     AND NOT EXISTS (SELECT 1 FROM interviews i WHERE i.application_id = a.id AND i.status = 'scheduled' AND i.starts_at >= ?)
     ORDER BY a.stage_entered_at LIMIT 5`, now(), daysAgo(7), ...p, now());
  // The job board is the agency's: a client's user is sent nothing of it. `board=all` adds paused and draft jobs.
  const board = isAgency(req.user) ? { board: jobBoard(req.user, cid, req.query.board === 'all') } : {};
  res.json({ stats, upcoming, jobs, recent, stale: appRows(stale, req.user), ...board });
});

// ---------- reports ----------
const RANK = { applied: 0, interview: 1, offer: 2, hired: 3 };

api.get('/reports', (req, res) => {
  const cid = scopeOf(req);
  const jobId = int(req.query.job_id);
  if (jobId) loadJob(jobId, req.user);
  const days = Math.min(3650, Math.max(0, int(req.query.days) ?? 0));
  const since = days ? daysAgo(days) : '1970-01-01';
  const where = [], p = [];
  if (cid) { where.push('j.client_id = ?'); p.push(cid); }
  if (jobId) { where.push('j.id = ?'); p.push(jobId); }
  const scope = where.length ? 'AND ' + where.join(' AND ') : '';

  const apps = q.all(
    `SELECT a.id, a.source, a.status, a.applied_at, a.hired_at, a.job_id FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.applied_at >= ? ${scope}`, since, ...p);
  const history = q.all(
    `SELECT h.application_id, s.kind, s.position FROM stage_history h JOIN stages s ON s.id = h.stage_id
     JOIN applications a ON a.id = h.application_id JOIN jobs j ON j.id = a.job_id WHERE a.applied_at >= ? ${scope}`, since, ...p);
  const reached = new Map(); // application id -> furthest point reached
  for (const h of history) {
    const cur = reached.get(h.application_id) || { rank: 0, position: 0 };
    reached.set(h.application_id, { rank: Math.max(cur.rank, RANK[h.kind]), position: Math.max(cur.position, h.position) });
  }
  const at = (id) => reached.get(id) || { rank: 0, position: 0 };

  let funnel;
  if (jobId) {
    funnel = q.all('SELECT name, position FROM stages WHERE job_id = ? ORDER BY position', jobId)
      .map((s) => ({ label: s.name, count: apps.filter((a) => at(a.id).position >= s.position).length }));
  } else {
    funnel = [['Applied', 0], ['Interviewed', 1], ['Offer', 2], ['Hired', 3]]
      .map(([label, rank]) => ({ label, count: apps.filter((a) => at(a.id).rank >= rank).length }));
  }

  const bySource = {};
  for (const a of apps) {
    const row = (bySource[a.source] ||= { source: a.source, label: sourceLabel(a.source, req.user), applicants: 0, interviewed: 0, hired: 0 });
    row.applicants++;
    if (at(a.id).rank >= 1) row.interviewed++;
    if (a.status === 'hired') row.hired++;
  }

  const weeks = Array.from({ length: 12 }, (_, i) => ({ start: new Date(Date.now() - (11 - i) * 7 * DAY - 6 * DAY).toISOString().slice(0, 10), count: 0 }));
  const recentApps = q.all(`SELECT a.applied_at FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.applied_at >= ? ${scope}`, daysAgo(84), ...p);
  for (const a of recentApps) {
    const idx = 11 - Math.floor((Date.now() - new Date(a.applied_at).getTime()) / (7 * DAY));
    if (weeks[idx]) weeks[idx].count++;
  }

  const hires = q.all(
    `SELECT a.id, c.name, j.title AS job_title, cl.name AS client_name, cl.fee_percent, cl.currency, a.source, a.applied_at, a.hired_at, o.salary
     FROM applications a JOIN candidates c ON c.id = a.candidate_id JOIN jobs j ON j.id = a.job_id JOIN clients cl ON cl.id = j.client_id
     LEFT JOIN offers o ON o.application_id = a.id
     WHERE a.status = 'hired' AND a.hired_at >= ? ${scope} ORDER BY a.hired_at DESC`, since, ...p)
    .map((h) => ({
      ...h, source: sourceLabel(h.source, req.user),
      days_to_hire: Math.max(0, Math.round((new Date(h.hired_at) - new Date(h.applied_at)) / DAY)),
      fee: h.salary && h.fee_percent ? Math.round((h.salary * h.fee_percent) / 100) : 0,
    }))
    // For the agency, a hire whose fee was recorded when it happened shows that figure, so this page, the Clients
    // report and the candidate's profile agree. The estimate above stays for hires from before counting started.
    .map((h) => (isAgency(req.user) ? { ...h, ...reporting.recordedFee(h.id) } : h));
  const offerStats = q.get(
    `SELECT SUM(o.status = 'accepted') AS accepted, SUM(o.status = 'declined') AS declined
     FROM offers o JOIN applications a ON a.id = o.application_id JOIN jobs j ON j.id = a.job_id WHERE o.updated_at >= ? ${scope}`, since, ...p);
  const decided = (offerStats.accepted || 0) + (offerStats.declined || 0);

  const openRoles = q.all(`${jobSelect} WHERE j.status = 'open' ${scope} ORDER BY j.opened_at`, ...p).map((j) => ({
    id: j.id, title: j.title, client_name: j.client_name, openings: j.openings, hires: j.hires,
    days_open: j.opened_at ? Math.round((Date.now() - new Date(j.opened_at)) / DAY) : 0,
    new_applicants: j.new_applicants, interviewing: j.interviewing, offers: j.offers,
  }));

  const out = {
    totals: {
      applicants: apps.length,
      interviewed: apps.filter((a) => at(a.id).rank >= 1).length,
      hires: hires.length,
      avg_days_to_hire: hires.length ? Math.round(hires.reduce((sum, h) => sum + h.days_to_hire, 0) / hires.length) : null,
      offer_acceptance: decided ? Math.round(((offerStats.accepted || 0) / decided) * 100) : null,
    },
    funnel, sources: Object.values(bySource).sort((a, b) => b.applicants - a.applicants), weeks, openRoles,
    hires: hires.map(({ fee, fee_percent, salary, ...h }) => (isAgency(req.user) ? { ...h, fee, salary } : h)),
  };
  if (isAgency(req.user)) {
    // Grouped by currency, because clients can be billed in different ones.
    const byCurrency = {};
    const bucket = (currency) => (byCurrency[currency] ||= { currency, monthly_retainers: 0, placement_fees: 0 });
    for (const r of q.all(`SELECT currency, SUM(monthly_retainer) AS total FROM clients cl WHERE cl.status = 'active' ${cid ? 'AND cl.id = ?' : ''} GROUP BY currency`, ...(cid ? [cid] : [])))
      if (r.total) bucket(r.currency).monthly_retainers = r.total;
    for (const h of hires) if (h.fee) bucket(h.currency).placement_fees += h.fee;
    out.revenue = Object.values(byCurrency);
  }
  res.json(out);
});

// ---------- errors ----------
api.use((req, res) => res.status(404).json({ error: 'Not found' }));
api.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than 8 MB.' : 'Upload failed.' });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: 'That request could not be read.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side.' });
});
