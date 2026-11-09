import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { q, now, tx, UPLOAD_DIR, getSetting, setSetting, createStages, DEFAULT_CRITERIA, DEFAULT_INTERVIEW_STAGES } from './db.js';
import { sendMail, sendTemplate, mailConfigured } from './mail.js';

export const api = express.Router();

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (message, status = 400) => { throw new HttpError(status, message); };
const isAgency = (u) => u.role !== 'client';
const canSee = (u, clientId) => isAgency(u) || u.client_id === clientId;
const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? null : String(v)) || null;
const int = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));
const json = (v, fallback) => { try { return JSON.parse(v); } catch { return fallback; } };
const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const validEmail = (e) => typeof e === 'string' && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
/** Single-line text from untrusted input: control characters removed, whitespace collapsed, length capped. */
const clean = (v, max = 200) =>
  (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '') || null;
/** Multi-line free text with a length cap. */
const text = (v, max = 6000) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '') || null;
/** Links are only stored when they are http(s); a bare domain gets https:// in front. */
function safeUrl(v) {
  const s = clean(v, 300);
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
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
  fileFilter: (req, file, cb) =>
    ALLOWED_RESUME.includes(path.extname(file.originalname).toLowerCase())
      ? cb(null, true)
      : cb(new HttpError(400, 'Résumé must be a PDF, Word, RTF or text file.')),
});
const removeUpload = (name) => { if (name) fs.rm(path.join(UPLOAD_DIR, path.basename(name)), { force: true }, () => {}); };

const logActivity = (applicationId, userId, type, detail) =>
  q.run('INSERT INTO activities (application_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)', applicationId, userId, type, detail, now());

const SOURCE_LABELS = {
  careers_page: 'Careers page', agency_sourced: 'Agency sourced', referral: 'Referral',
  linkedin: 'LinkedIn', job_board: 'Job board', other: 'Other',
};

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
  const address = String(email || '').trim().toLowerCase().slice(0, 200);
  const user = q.get('SELECT * FROM users WHERE email = ?', address);
  const matches = verifyPassword(pw(password), user ? user.password_hash : DUMMY_HASH);
  if (!user || !matches) bad('That email and password do not match.', 401);
  // Only someone who knows the password learns the state of the account.
  if (user.pending) bad(`Your account is waiting for approval by ${getSetting('agency_name', 'the agency')}. You will be able to sign in once it is approved.`, 403);
  if (!user.active) bad('This account has been deactivated.', 403);
  startSession(req, res, user.id);
  res.json({ ok: true });
});

// ---------- unauthenticated: creating an account ----------
// Anyone may ask for an account. It stays locked (it cannot sign in or see anything) until an agency user approves it
// and decides which client's hiring team it belongs to.
api.post('/signup', rateLimit('signup', 5, 60 * 60000), (req, res) => {
  if (!q.get('SELECT 1 AS x FROM users LIMIT 1')) bad('This workspace has not been set up yet.', 403);
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const name = clean(b.name, 120);
  if (!name || !validEmail(email)) bad('Your name and a valid email are required.');
  if (pw(b.password).length < 8) bad('Choose a password of at least 8 characters.');
  if (q.get('SELECT COUNT(*) AS n FROM users WHERE pending = 1').n >= 200) bad('Account requests are paused for now. Please contact the agency directly.', 429);
  const hash = hashPassword(b.password); // always computed, so the response time does not reveal whether the address is registered
  // Same answer whether or not the address already has an account, for the same reason.
  if (!q.get('SELECT 1 AS x FROM users WHERE email = ?', email)) {
    q.run(`INSERT INTO users (email, password_hash, name, role, client_id, title, active, pending, requested_company, created_at)
           VALUES (?, ?, ?, 'client', NULL, ?, 0, 1, ?, ?)`, email, hash, name, clean(b.title, 120), clean(b.company, 160), now());
  }
  res.json({ ok: true });
});

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
function loadInvite(token) {
  const inv = /^[a-f0-9]{48}$/.test(token || '')
    ? q.get(`SELECT i.*, c.name AS client_name FROM invites i LEFT JOIN clients c ON c.id = i.client_id WHERE i.token_hash = ?`, hashToken(token))
    : null;
  if (!inv || inv.used_at || inv.expires_at < now() || (inv.role === 'client' && !inv.client_id)) bad('This invitation link is no longer valid. Please ask for a new one.', 404);
  return inv;
}

api.get('/invites/:token', rateLimit('invite', 40, 10 * 60000), (req, res) => {
  const inv = loadInvite(req.params.token);
  res.json({ role: inv.role, clientName: inv.client_name, email: inv.email, agencyName: getSetting('agency_name', '') });
});

api.post('/invites/:token/accept', rateLimit('invite', 40, 10 * 60000), (req, res) => {
  const inv = loadInvite(req.params.token);
  const b = req.body || {};
  const email = inv.email || String(b.email || '').trim().toLowerCase();
  const name = clean(b.name, 120);
  if (!name || !validEmail(email)) bad('Your name and a valid email are required.');
  if (pw(b.password).length < 8) bad('Choose a password of at least 8 characters.');
  if (q.get('SELECT 1 AS x FROM users WHERE email = ?', email)) bad('An account with this email already exists. Sign in instead, or ask for it to be reactivated.');
  const id = tx(() => {
    // Claim the invitation first; if another request used it a moment ago, nothing is created.
    if (!q.run('UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL', now(), inv.id).changes) bad('This invitation link has already been used.', 404);
    return q.insert('INSERT INTO users (email, password_hash, name, role, client_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      email, hashPassword(b.password), name, inv.role, inv.role === 'client' ? inv.client_id : null, clean(b.title, 120), now());
  });
  startSession(req, res, id);
  res.json({ ok: true });
});

// ---------- unauthenticated: public careers site ----------
const publicJobCols = `id, title, department, location, work_mode, employment_type,
  CASE WHEN salary_public = 1 THEN salary_min END AS salary_min, CASE WHEN salary_public = 1 THEN salary_max END AS salary_max`;
function careersClient(slug) {
  const c = q.get(`SELECT id, name, slug, brand_color, tagline, about, website, privacy_url, location, industry, currency FROM clients WHERE slug = ? AND status != 'ended'`, slug);
  if (!c) bad('This careers page does not exist.', 404);
  return c;
}

api.get('/public/careers/:slug', (req, res) => {
  const client = careersClient(req.params.slug);
  const jobs = q.all(`SELECT ${publicJobCols} FROM jobs WHERE client_id = ? AND status = 'open' ORDER BY department, title`, client.id);
  res.json({ client, jobs });
});

api.get('/public/careers/:slug/jobs/:id', (req, res) => {
  const client = careersClient(req.params.slug);
  const job = q.get(`SELECT ${publicJobCols}, description, questions FROM jobs WHERE id = ? AND client_id = ? AND status = 'open'`, int(req.params.id), client.id);
  if (!job) bad('This role is no longer open.', 404);
  job.questions = json(job.questions, []);
  res.json({ client, job, agencyName: getSetting('agency_name', '') });
});

const PUBLIC_SOURCES = ['careers_page', 'linkedin', 'job_board', 'referral'];

api.post('/public/careers/:slug/jobs/:id/apply', rateLimit('apply', 10, 10 * 60000), upload.single('resume'), async (req, res) => {
  let stored = false; // true once the uploaded résumé belongs to a saved application
  try {
    const client = q.get(`SELECT * FROM clients WHERE slug = ? AND status != 'ended'`, req.params.slug);
    const job = client && q.get(`SELECT * FROM jobs WHERE id = ? AND client_id = ? AND status = 'open'`, int(req.params.id), client.id);
    if (!job) bad('This role is no longer open.', 404);
    const b = req.body || {};
    if (b.company_website) return res.json({ ok: true }); // honeypot field, filled only by bots
    const email = String(b.email || '').trim().toLowerCase();
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
    const phone = clean(b.phone, 40), linkedin = safeUrl(b.linkedin), location = clean(b.location, 120);

    const result = tx(() => {
      let cand = q.get('SELECT * FROM candidates WHERE client_id = ? AND email = ?', client.id, email);
      if (cand) {
        if (q.get('SELECT 1 AS x FROM applications WHERE candidate_id = ? AND job_id = ?', cand.id, job.id)) return { duplicate: true };
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
        cand.id, job.id, stage.id, source, JSON.stringify(answers), text(b.cover_note, 6000),
        req.file?.filename ?? null, clean(req.file?.originalname, 200), t, t, t, t);
      q.run('INSERT INTO stage_history (application_id, stage_id, entered_at) VALUES (?, ?, ?)', appId, stage.id, t);
      logActivity(appId, null, 'applied', `Applied via ${SOURCE_LABELS[source].toLowerCase()}`);
      return { appId };
    });
    stored = Boolean(result.appId);

    // The address is unverified, so cap how many confirmations any one address can be sent.
    const recent = q.get('SELECT COUNT(*) AS n FROM emails WHERE to_email = ? AND created_at > ?', email, new Date(Date.now() - 3600000).toISOString()).n;
    if (result.appId && recent < 3) {
      await sendTemplate('application_received', {
        applicationId: result.appId, to: email,
        vars: { candidate_first_name: greetingName(name), candidate_name: name, job_title: job.title, company: client.name, sender_name: client.name },
      });
    }
    res.json({ ok: true });
  } finally {
    if (!stored) removeUpload(req.file?.filename);
  }
});

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
  res.json({ user: publicUser(req.user), agencyName: getSetting('agency_name', 'Agency'), clients, mailConfigured: mailConfigured() });
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
  });
});

// ---------- settings + templates ----------
api.put('/settings', adminOnly, (req, res) => {
  if (!clean(req.body?.agencyName)) bad('Agency name is required.');
  setSetting('agency_name', clean(req.body.agencyName, 120));
  res.json({ ok: true });
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

// Approve a self-registered account and decide what it can see.
api.post('/users/:id/approve', agencyOnly, (req, res) => {
  const target = q.get('SELECT * FROM users WHERE id = ?', int(req.params.id));
  if (!target || !target.pending) bad('This request has already been handled.', 404);
  const { role, clientId } = accessFrom(req.body || {}, req.user);
  q.run('UPDATE users SET role = ?, client_id = ?, active = 1, pending = 0 WHERE id = ? AND pending = 1', role, clientId, target.id);
  res.json({ ok: true });
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
     WHERE i.used_at IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC`, now()));
});

api.post('/invites', agencyOnly, (req, res) => {
  const b = req.body || {};
  const { role, clientId } = accessFrom(b, req.user);
  const email = String(b.email || '').trim().toLowerCase() || null;
  if (email && !validEmail(email)) bad('That email address does not look right.');
  if (email && q.get('SELECT 1 AS x FROM users WHERE email = ?', email)) bad('Someone with that email already has an account.');
  if (q.get('SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL AND expires_at > ?', now()).n >= 500) bad('There are too many unused invitations. Revoke some first.');
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * DAY).toISOString();
  q.run('INSERT INTO invites (token_hash, role, client_id, email, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    hashToken(token), role, clientId, email, req.user.id, now(), expiresAt);
  res.json({ token, expires_at: expiresAt }); // the only time the link can be read; just its hash is stored
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
  res.json({ ok: true });
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
    website: safeUrl(b.website), privacy_url: safeUrl(b.privacy_url), industry: clean(b.industry, 120), location: clean(b.location, 120),
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
  res.json({ ok: true });
});

// ---------- jobs ----------
const jobSelect = `
  SELECT j.*, cl.name AS client_name, cl.brand_color, cl.slug AS client_slug, cl.currency, u.name AS hiring_manager_name,
    (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS total_applicants,
    (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status = 'active') AS active_candidates,
    (SELECT COUNT(*) FROM applications a JOIN stages s ON s.id = a.stage_id WHERE a.job_id = j.id AND a.status = 'active' AND s.kind = 'applied') AS new_applicants,
    (SELECT COUNT(*) FROM applications a JOIN stages s ON s.id = a.stage_id WHERE a.job_id = j.id AND a.status = 'active' AND s.kind = 'interview') AS interviewing,
    (SELECT COUNT(*) FROM applications a JOIN stages s ON s.id = a.stage_id WHERE a.job_id = j.id AND a.status = 'active' AND s.kind = 'offer') AS offers,
    (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status = 'hired') AS hires
  FROM jobs j JOIN clients cl ON cl.id = j.client_id LEFT JOIN users u ON u.id = j.hiring_manager_id`;
/** Parse the JSON columns and drop the agency-only internal brief for client users. */
function hydrateJob(j, user) {
  const { ideal_profile, ...rest } = j;
  return { ...rest, ...(isAgency(user) ? { ideal_profile } : {}), questions: json(j.questions, []), criteria: json(j.criteria, []) };
}
/** A hiring manager must be an active agency user or belong to the job's own client. */
function checkHiringManager(userId, clientId) {
  if (userId == null) return;
  const u = q.get('SELECT role, client_id FROM users WHERE id = ? AND active = 1', userId);
  if (!u || (u.role === 'client' && u.client_id !== clientId)) bad('Choose a hiring manager from this client or your own team.');
}

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
  const rows = q.all(`${jobSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE j.status WHEN 'open' THEN 0 WHEN 'draft' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, j.created_at DESC`, ...p);
  res.json(rows.map((j) => hydrateJob(j, req.user)));
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

api.post('/jobs', agencyOnly, (req, res) => {
  const b = req.body || {};
  const f = jobFields(b);
  const clientId = int(b.client_id);
  if (!q.get('SELECT 1 AS x FROM clients WHERE id = ?', clientId)) bad('Choose a client for this role.');
  if (!f.title) bad('Job title is required.');
  checkHiringManager(f.hiring_manager_id, clientId);
  const stageNames = (Array.isArray(b.interview_stages) ? b.interview_stages : []).map((s) => clean(s?.name, 80)).filter(Boolean).slice(0, 12);
  const id = tx(() => {
    const t = now();
    const jobId = q.insert(
      `INSERT INTO jobs (client_id, title, department, location, work_mode, employment_type, salary_min, salary_max, salary_public, description, ideal_profile,
         status, hiring_manager_id, openings, questions, criteria, created_by, created_at, opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      clientId, f.title, f.department, f.location, f.work_mode, f.employment_type, f.salary_min, f.salary_max, f.salary_public, f.description, f.ideal_profile,
      f.status, f.hiring_manager_id, f.openings, f.questions, f.criteria, req.user.id, t, f.status === 'open' ? t : null);
    createStages(jobId, stageNames.length ? stageNames : DEFAULT_INTERVIEW_STAGES);
    return jobId;
  });
  res.json({ id });
});

api.get('/jobs/:id', (req, res) => {
  const job = hydrateJob(loadJob(req.params.id, req.user), req.user);
  const stages = q.all('SELECT * FROM stages WHERE job_id = ? ORDER BY position', job.id);
  res.json({ job, stages });
});

api.put('/jobs/:id', agencyOnly, (req, res) => {
  const job = loadJob(req.params.id, req.user);
  const b = req.body || {};
  const f = jobFields(b);
  if (!f.title) bad('Job title is required.');
  if (f.hiring_manager_id !== job.hiring_manager_id) checkHiringManager(f.hiring_manager_id, job.client_id);
  tx(() => {
    const t = now();
    q.run(
      `UPDATE jobs SET title = ?, department = ?, location = ?, work_mode = ?, employment_type = ?, salary_min = ?, salary_max = ?, salary_public = ?,
         description = ?, ideal_profile = ?, status = ?, hiring_manager_id = ?, openings = ?, questions = ?, criteria = ?,
         opened_at = ?, closed_at = ? WHERE id = ?`,
      f.title, f.department, f.location, f.work_mode, f.employment_type, f.salary_min, f.salary_max, f.salary_public, f.description, f.ideal_profile,
      f.status, f.hiring_manager_id, f.openings, f.questions, f.criteria,
      job.opened_at ?? (f.status === 'open' ? t : null), f.status === 'closed' ? job.closed_at ?? t : null, job.id);

    if (Array.isArray(b.interview_stages)) {
      const wanted = b.interview_stages.map((s) => ({ id: int(s?.id), name: clean(s?.name, 80) })).filter((s) => s.name).slice(0, 12);
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
        if (own) q.run('UPDATE stages SET name = ?, position = ? WHERE id = ?', s.name, i + 1, own.id);
        else q.run(`INSERT INTO stages (job_id, name, kind, position) VALUES (?, ?, 'interview', ?)`, job.id, s.name, i + 1);
      });
      q.run(`UPDATE stages SET position = ? WHERE job_id = ? AND kind = 'offer'`, wanted.length + 1, job.id);
      q.run(`UPDATE stages SET position = ? WHERE job_id = ? AND kind = 'hired'`, wanted.length + 2, job.id);
    }
  });
  res.json({ ok: true });
});

api.patch('/jobs/:id/status', agencyOnly, (req, res) => {
  const job = loadJob(req.params.id, req.user);
  const status = req.body?.status;
  if (!['draft', 'open', 'paused', 'closed'].includes(status)) bad('Unknown status.');
  const t = now();
  q.run('UPDATE jobs SET status = ?, opened_at = ?, closed_at = ? WHERE id = ?',
    status, job.opened_at ?? (status === 'open' ? t : null), status === 'closed' ? t : null, job.id);
  res.json({ ok: true });
});

api.delete('/jobs/:id', adminOnly, (req, res) => {
  const job = loadJob(req.params.id, req.user);
  for (const a of q.all('SELECT resume_file FROM applications WHERE job_id = ?', job.id)) removeUpload(a.resume_file);
  tx(() => {
    q.run('DELETE FROM applications WHERE job_id = ?', job.id);
    q.run('DELETE FROM jobs WHERE id = ?', job.id);
    q.run('DELETE FROM candidates WHERE id NOT IN (SELECT candidate_id FROM applications)');
  });
  res.json({ ok: true });
});

// ---------- applications (a candidate in a job's pipeline) ----------
const appSelect = `
  SELECT a.id, a.status, a.source, a.rating, a.applied_at, a.stage_entered_at, a.updated_at, a.review_status, a.stage_id, a.reject_reason, a.hired_at,
    a.resume_file IS NOT NULL AS has_resume,
    c.id AS candidate_id, c.name, c.email, c.current_title, c.current_company, c.location,
    j.id AS job_id, j.title AS job_title, j.client_id, cl.name AS client_name, cl.brand_color,
    s.name AS stage_name, s.kind AS stage_kind, s.position AS stage_position,
    (SELECT MIN(i.starts_at) FROM interviews i WHERE i.application_id = a.id AND i.status = 'scheduled' AND i.starts_at >= ?) AS next_interview
  FROM applications a
  JOIN candidates c ON c.id = a.candidate_id
  JOIN jobs j ON j.id = a.job_id
  JOIN clients cl ON cl.id = j.client_id
  JOIN stages s ON s.id = a.stage_id`;

api.get('/applications', (req, res) => {
  const cid = scopeOf(req);
  const where = [], p = [now()];
  if (cid) { where.push('j.client_id = ?'); p.push(cid); }
  if (int(req.query.job_id)) { where.push('a.job_id = ?'); p.push(int(req.query.job_id)); }
  if (req.query.status && req.query.status !== 'all') { where.push('a.status = ?'); p.push(req.query.status); }
  if (req.query.stage_kind) { where.push('s.kind = ?'); p.push(req.query.stage_kind); }
  if (req.query.review) { where.push('a.review_status = ?'); p.push(req.query.review); }
  if (clean(req.query.q)) {
    where.push(`(c.name LIKE ? OR c.email LIKE ? OR c.current_company LIKE ? OR c.current_title LIKE ?)`);
    const like = `%${clean(req.query.q, 100)}%`;
    p.push(like, like, like, like);
  }
  const order = req.query.sort === 'oldest' ? 'a.applied_at ASC' : 'a.applied_at DESC';
  // Cross-job lists stop at 500 rows (the screens say so); one job's pipeline is returned whole so the board never hides anyone.
  const limit = int(req.query.job_id) ? 20000 : 500;
  res.json(q.all(`${appSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ${limit}`, ...p));
});

function loadApp(id, user) {
  const a = q.get(
    `SELECT a.*, j.client_id, j.title AS job_title, c.name AS candidate_name, c.email AS candidate_email, cl.name AS client_name
     FROM applications a JOIN jobs j ON j.id = a.job_id JOIN candidates c ON c.id = a.candidate_id JOIN clients cl ON cl.id = j.client_id
     WHERE a.id = ?`, int(id));
  if (!a || !canSee(user, a.client_id)) bad('Not found', 404);
  return a;
}
const mailVars = (a, user) => ({
  candidate_first_name: greetingName(a.candidate_name), candidate_name: a.candidate_name,
  job_title: a.job_title, company: a.client_name, sender_name: user.name,
});

function moveToStage(app, stageId, user) {
  const stage = q.get('SELECT * FROM stages WHERE id = ? AND job_id = ?', int(stageId), app.job_id);
  if (!stage) bad('That stage does not belong to this job.');
  if (stage.id === app.stage_id && (app.status === 'active' || app.status === 'hired')) return stage;
  const t = now();
  const hired = stage.kind === 'hired';
  q.run(`UPDATE applications SET stage_id = ?, stage_entered_at = ?, updated_at = ?, status = ?, hired_at = ?, reject_reason = NULL WHERE id = ?`,
    stage.id, t, t, hired ? 'hired' : 'active', hired ? t : null, app.id);
  q.run('INSERT INTO stage_history (application_id, stage_id, entered_at) VALUES (?, ?, ?)', app.id, stage.id, t);
  logActivity(app.id, user.id, hired ? 'hired' : 'stage', hired ? 'Marked as hired' : `Moved to ${stage.name}`);
  return stage;
}

/** Contact details as stored: single-line, capped, and links restricted to http(s). */
const candidateFields = (c) => ({
  name: clean(c.name, 120), phone: clean(c.phone, 40), linkedin: safeUrl(c.linkedin), location: clean(c.location, 120),
  current_title: clean(c.current_title, 160), current_company: clean(c.current_company, 160),
});

api.post('/applications', agencyOnly, upload.single('resume'), (req, res) => {
  let stored = false;
  try {
    const b = req.body || {};
    const job = q.get('SELECT * FROM jobs WHERE id = ?', int(b.job_id));
    if (!job) bad('Choose a job for this candidate.');
    const email = String(b.email || '').trim().toLowerCase();
    const c = candidateFields(b);
    if (!c.name || !validEmail(email)) bad('Name and a valid email are required.');
    const source = isStr(b.source) && Object.hasOwn(SOURCE_LABELS, b.source) ? b.source : 'agency_sourced';
    const id = tx(() => {
      let cand = q.get('SELECT * FROM candidates WHERE client_id = ? AND email = ?', job.client_id, email);
      if (cand && q.get('SELECT 1 AS x FROM applications WHERE candidate_id = ? AND job_id = ?', cand.id, job.id)) bad('This person is already in the pipeline for this job.');
      if (!cand) {
        cand = { id: q.insert(
          'INSERT INTO candidates (client_id, name, email, phone, linkedin, location, current_title, current_company, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          job.client_id, c.name, email, c.phone, c.linkedin, c.location, c.current_title, c.current_company, now()) };
      }
      const stage = q.get('SELECT * FROM stages WHERE id = ? AND job_id = ?', int(b.stage_id), job.id)
        ?? q.get(`SELECT * FROM stages WHERE job_id = ? AND kind = 'applied'`, job.id);
      const t = now();
      const hired = stage.kind === 'hired';
      const appId = q.insert(
        `INSERT INTO applications (candidate_id, job_id, stage_id, status, source, cover_note, resume_file, resume_name, applied_at, stage_entered_at, updated_at, hired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        cand.id, job.id, stage.id, hired ? 'hired' : 'active', source, text(b.cover_note, 6000), req.file?.filename ?? null, clean(req.file?.originalname, 200), t, t, t, hired ? t : null);
      q.run('INSERT INTO stage_history (application_id, stage_id, entered_at) VALUES (?, ?, ?)', appId, stage.id, t);
      logActivity(appId, req.user.id, 'added', `Added to the pipeline (${SOURCE_LABELS[source].toLowerCase()})`);
      return appId;
    });
    stored = true;
    res.json({ id });
  } finally {
    if (!stored) removeUpload(req.file?.filename);
  }
});

api.get('/applications/:id', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  const agency = isAgency(req.user);
  const candidate = q.get('SELECT * FROM candidates WHERE id = ?', a.candidate_id);
  const job = q.get('SELECT id, title, client_id, criteria, status, location FROM jobs WHERE id = ?', a.job_id);
  job.criteria = json(job.criteria, []);
  const client = q.get('SELECT id, name, brand_color, currency, fee_percent FROM clients WHERE id = ?', a.client_id);
  if (!agency) delete client.fee_percent;
  const stages = q.all('SELECT * FROM stages WHERE job_id = ? ORDER BY position', a.job_id);
  const notes = q.all(
    `SELECT n.*, u.name AS user_name, u.role AS user_role FROM notes n LEFT JOIN users u ON u.id = n.user_id
     WHERE n.application_id = ? ${agency ? '' : 'AND n.private = 0'} ORDER BY n.created_at DESC`, a.id);
  const activities = q.all(
    `SELECT ac.*, u.name AS user_name FROM activities ac LEFT JOIN users u ON u.id = ac.user_id WHERE ac.application_id = ? ORDER BY ac.created_at DESC, ac.id DESC`, a.id);
  const interviews = q.all('SELECT * FROM interviews WHERE application_id = ? ORDER BY starts_at DESC', a.id).map((i) => ({
    ...i,
    panel: q.all(`SELECT u.id, u.name, u.title, u.role FROM interview_panel p JOIN users u ON u.id = p.user_id WHERE p.interview_id = ?`, i.id),
    scorecards: q.all(`SELECT sc.*, u.name AS user_name FROM scorecards sc JOIN users u ON u.id = sc.user_id WHERE sc.interview_id = ?`, i.id)
      .map((sc) => ({ ...sc, ratings: json(sc.ratings, {}) })),
  }));
  const offer = q.get('SELECT * FROM offers WHERE application_id = ?', a.id) || null;
  const emails = q.all(`SELECT e.*, u.name AS sent_by_name FROM emails e LEFT JOIN users u ON u.id = e.sent_by WHERE e.application_id = ? ORDER BY e.created_at DESC`, a.id);
  const others = q.all(
    `SELECT a.id, a.status, j.title AS job_title, s.name AS stage_name FROM applications a JOIN jobs j ON j.id = a.job_id JOIN stages s ON s.id = a.stage_id
     WHERE a.candidate_id = ? AND a.id != ?`, a.candidate_id, a.id);
  const names = (id) => (id ? q.get('SELECT name FROM users WHERE id = ?', id)?.name ?? null : null);
  const { client_id, job_title, candidate_name, candidate_email, client_name, ...application } = a;
  res.json({
    application: { ...application, answers: json(a.answers, []), submitted_by_name: names(a.submitted_by), reviewed_by_name: names(a.reviewed_by) },
    candidate, job, client, stages, notes, activities, interviews, offer, emails, others,
  });
});

api.patch('/applications/:id', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  const b = req.body || {};
  if (b.rating !== undefined) {
    const rating = int(b.rating);
    q.run('UPDATE applications SET rating = ?, updated_at = ? WHERE id = ?', rating >= 1 && rating <= 5 ? rating : null, now(), a.id);
  }
  if (b.candidate && isAgency(req.user)) {
    const c = candidateFields(b.candidate);
    const email = String(b.candidate.email || '').trim().toLowerCase();
    if (!c.name || !validEmail(email)) bad('Name and a valid email are required.');
    if (q.get('SELECT 1 AS x FROM candidates WHERE client_id = ? AND email = ? AND id != ?', a.client_id, email, a.candidate_id)) bad('Another candidate at this client already uses that email.');
    q.run('UPDATE candidates SET name = ?, email = ?, phone = ?, linkedin = ?, location = ?, current_title = ?, current_company = ? WHERE id = ?',
      c.name, email, c.phone, c.linkedin, c.location, c.current_title, c.current_company, a.candidate_id);
  }
  res.json({ ok: true });
});

api.post('/applications/:id/move', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  const stage = tx(() => moveToStage(a, req.body?.stage_id, req.user));
  res.json({ ok: true, stage });
});

/** A candidate who has left the pipeline should not keep interviews in people's diaries. */
function cancelUpcomingInterviews(appId, userId) {
  const cancelled = q.run(`UPDATE interviews SET status = 'cancelled' WHERE application_id = ? AND status = 'scheduled' AND starts_at >= ?`, appId, now()).changes;
  if (cancelled) logActivity(appId, userId, 'interview', cancelled === 1 ? 'Cancelled the upcoming interview' : `Cancelled ${cancelled} upcoming interviews`);
}

api.post('/applications/:id/reject', async (req, res) => {
  const a = loadApp(req.params.id, req.user);
  const reason = clean(req.body?.reason, 300) || 'Not specified';
  tx(() => {
    q.run(`UPDATE applications SET status = 'rejected', reject_reason = ?, updated_at = ? WHERE id = ?`, reason, now(), a.id);
    logActivity(a.id, req.user.id, 'rejected', `Rejected: ${reason}`);
    cancelUpcomingInterviews(a.id, req.user.id);
  });
  if (req.body?.send_email === true) await sendTemplate('rejection', { applicationId: a.id, to: a.candidate_email, vars: mailVars(a, req.user), userId: req.user.id });
  res.json({ ok: true });
});

api.post('/applications/:id/restore', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  if (a.status === 'active' || a.status === 'hired') return res.json({ ok: true });
  const stage = q.get('SELECT kind FROM stages WHERE id = ?', a.stage_id);
  const hired = stage.kind === 'hired';
  q.run(`UPDATE applications SET status = ?, hired_at = ?, reject_reason = NULL, updated_at = ? WHERE id = ?`,
    hired ? 'hired' : 'active', hired ? a.hired_at ?? a.stage_entered_at : null, now(), a.id);
  logActivity(a.id, req.user.id, 'restored', 'Returned to the pipeline');
  res.json({ ok: true });
});

api.post('/applications/:id/withdraw', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  const reason = clean(req.body?.reason, 300);
  tx(() => {
    q.run(`UPDATE applications SET status = 'withdrawn', reject_reason = ?, updated_at = ? WHERE id = ?`, reason, now(), a.id);
    logActivity(a.id, req.user.id, 'withdrawn', `Candidate withdrew${reason ? `: ${reason}` : ''}`);
    cancelUpcomingInterviews(a.id, req.user.id);
  });
  res.json({ ok: true });
});

// Agency -> client hand-off: the recruiter submits a shortlisted candidate with a write-up, the hiring team approves or declines.
api.post('/applications/:id/submit', agencyOnly, (req, res) => {
  const a = loadApp(req.params.id, req.user);
  if (a.status !== 'active') bad('Return this candidate to the pipeline before submitting them to the hiring team.');
  const note = text(req.body?.note, 6000);
  if (!note) bad('Add a short write-up so the hiring team knows why this candidate is worth meeting.');
  q.run(`UPDATE applications SET review_status = 'pending', submission_note = ?, submitted_by = ?, review_note = NULL, reviewed_by = NULL, reviewed_at = NULL, updated_at = ? WHERE id = ?`,
    note, req.user.id, now(), a.id);
  logActivity(a.id, req.user.id, 'submitted', 'Submitted to the hiring team for review');
  res.json({ ok: true });
});

api.post('/applications/:id/review', (req, res) => {
  const a = loadApp(req.params.id, req.user);
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
    logActivity(a.id, req.user.id, 'review', approve ? 'Approved for interview' : `Declined at review: ${note}`);
    if (approve) {
      const current = q.get('SELECT * FROM stages WHERE id = ?', a.stage_id);
      const next = q.get(`SELECT * FROM stages WHERE job_id = ? AND position > ? AND kind = 'interview' ORDER BY position LIMIT 1`, a.job_id, current.position);
      if (next && current.kind !== 'offer' && current.kind !== 'hired') moveToStage(a, next.id, req.user);
    } else {
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
  const id = q.insert('INSERT INTO notes (application_id, user_id, body, private, created_at) VALUES (?, ?, ?, ?, ?)',
    a.id, req.user.id, body, isAgency(req.user) && req.body.private ? 1 : 0, now());
  q.run('UPDATE applications SET updated_at = ? WHERE id = ?', now(), a.id);
  res.json({ id });
});

api.delete('/notes/:id', (req, res) => {
  const note = q.get('SELECT * FROM notes WHERE id = ?', int(req.params.id));
  if (!note || note.user_id !== req.user.id) bad('You can only delete your own notes.', 403);
  q.run('DELETE FROM notes WHERE id = ?', note.id);
  res.json({ ok: true });
});

api.post('/applications/:id/emails', async (req, res) => {
  const a = loadApp(req.params.id, req.user);
  // Both must be plain strings. Anything else (an object, say) must never reach the mail library, which would treat it as a file or URL to read.
  const subject = clean(req.body?.subject, 300);
  const body = text(req.body?.body, 20000);
  if (!subject || !body) bad('Subject and message are required.');
  const result = await sendMail({ applicationId: a.id, to: a.candidate_email, subject, body, userId: req.user.id });
  logActivity(a.id, req.user.id, 'email', `Emailed candidate: ${subject}`);
  res.json(result);
});

api.put('/applications/:id/offer', agencyOnly, (req, res) => {
  const a = loadApp(req.params.id, req.user);
  const b = req.body || {};
  const status = ['draft', 'sent', 'accepted', 'declined'].includes(b.status) ? b.status : 'draft';
  const existing = q.get('SELECT * FROM offers WHERE application_id = ?', a.id);
  const t = now();
  const startDate = isStr(b.start_date) && /^\d{4}-\d{2}-\d{2}$/.test(b.start_date) ? b.start_date : null;
  if (existing) q.run('UPDATE offers SET salary = ?, start_date = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?', int(b.salary), startDate, status, text(b.notes, 4000), t, existing.id);
  else q.run('INSERT INTO offers (application_id, salary, start_date, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', a.id, int(b.salary), startDate, status, text(b.notes, 4000), t, t);
  if (!existing || existing.status !== status) logActivity(a.id, req.user.id, 'offer', `Offer ${status === 'draft' ? 'drafted' : status}`);
  res.json({ ok: true });
});

api.get('/applications/:id/resume', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  if (!a.resume_file) bad('No résumé on file.', 404);
  const safeName = (a.resume_name || 'resume').replace(/[^\w.\- ]+/g, '_');
  // Always a download, never rendered inside this site: the file came from an anonymous upload.
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.sendFile(path.join(UPLOAD_DIR, path.basename(a.resume_file)), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'The résumé file is missing.' });
  });
});

// Remove one application (and the candidate record if this was their only one).
api.delete('/applications/:id', agencyOnly, (req, res) => {
  const a = loadApp(req.params.id, req.user);
  tx(() => {
    q.run('DELETE FROM applications WHERE id = ?', a.id);
    if (!q.get('SELECT 1 AS x FROM applications WHERE candidate_id = ?', a.candidate_id)) q.run('DELETE FROM candidates WHERE id = ?', a.candidate_id);
  });
  removeUpload(a.resume_file);
  res.json({ ok: true });
});

// Erase a person completely: every application they made at this client, with its notes, scorecards, interviews,
// emails and résumé files, and their contact record.
api.delete('/candidates/:id', agencyOnly, (req, res) => {
  const cand = q.get('SELECT * FROM candidates WHERE id = ?', int(req.params.id));
  if (!cand || !canSee(req.user, cand.client_id)) bad('Not found', 404);
  const files = q.all('SELECT resume_file FROM applications WHERE candidate_id = ?', cand.id).map((r) => r.resume_file);
  tx(() => {
    q.run('DELETE FROM applications WHERE candidate_id = ?', cand.id);
    q.run('DELETE FROM candidates WHERE id = ?', cand.id);
  });
  files.forEach(removeUpload);
  res.json({ ok: true });
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
    logActivity(a.id, req.user.id, 'interview', `Scheduled ${title}`);
    return iid;
  });
  if (b.notify) await sendTemplate('interview_invite', {
    applicationId: a.id, to: a.candidate_email, userId: req.user.id,
    vars: { ...mailVars(a, req.user), interview_time: clean(b.time_label, 120) || starts.toUTCString(), interview_format: KIND_LABELS[kind], interview_location: clean(b.location, 300) || 'Details to follow' },
  });
  res.json({ id });
});

api.patch('/interviews/:id', (req, res) => {
  const i = loadInterview(req.params.id, req.user);
  const b = req.body || {};
  tx(() => {
    if (b.status && ['scheduled', 'completed', 'cancelled'].includes(b.status) && b.status !== i.status) {
      q.run('UPDATE interviews SET status = ? WHERE id = ?', b.status, i.id);
      logActivity(i.application_id, req.user.id, 'interview', `${i.title} marked ${b.status}`);
    }
    if (b.starts_at) {
      const starts = new Date(b.starts_at);
      if (Number.isNaN(starts.getTime())) bad('That start time is not valid.');
      q.run('UPDATE interviews SET title = ?, kind = ?, starts_at = ?, duration_min = ?, location = ?, notes = ? WHERE id = ?',
        clean(b.title, 160) ?? i.title, isStr(b.kind) && Object.hasOwn(KIND_LABELS, b.kind) ? b.kind : i.kind, starts.toISOString(),
        Math.min(480, Math.max(10, int(b.duration_min) ?? i.duration_min)), clean(b.location, 300), text(b.notes, 4000), i.id);
      if (starts.toISOString() !== i.starts_at) logActivity(i.application_id, req.user.id, 'interview', `Rescheduled ${i.title}`);
    }
    if (Array.isArray(b.panel)) setPanel(i.id, i.client_id, b.panel.slice(0, 20));
  });
  res.json({ ok: true });
});

api.get('/interviews/:id/ics', (req, res) => {
  const i = loadInterview(req.params.id, req.user);
  const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s) => String(s || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const end = new Date(new Date(i.starts_at).getTime() + i.duration_min * 60000);
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Embed//Recruiting//EN', 'BEGIN:VEVENT',
    `UID:interview-${i.id}@embed`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(i.starts_at)}`, `DTEND:${stamp(end)}`,
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
  });
  res.json({ ok: true });
});

// ---------- dashboard ----------
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
    .map(({ description, ideal_profile, questions, criteria, ...j }) => j);
  const recent = q.all(
    `SELECT ac.id, ac.type, ac.detail, ac.created_at, ac.application_id, u.name AS user_name, c.name AS candidate_name, j.title AS job_title, cl.name AS client_name
     FROM activities ac JOIN applications a ON a.id = ac.application_id JOIN candidates c ON c.id = a.candidate_id
     JOIN jobs j ON j.id = a.job_id JOIN clients cl ON cl.id = j.client_id LEFT JOIN users u ON u.id = ac.user_id
     WHERE 1 = 1 ${w} ORDER BY ac.created_at DESC, ac.id DESC LIMIT 10`, ...p);
  const stale = q.all(
    `${appSelect} WHERE a.status = 'active' AND s.kind IN ('interview', 'offer') AND a.stage_entered_at < ? ${w}
     AND NOT EXISTS (SELECT 1 FROM interviews i WHERE i.application_id = a.id AND i.status = 'scheduled' AND i.starts_at >= ?)
     ORDER BY a.stage_entered_at LIMIT 5`, now(), daysAgo(7), ...p, now());
  res.json({ stats, upcoming, jobs, recent, stale });
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
    const row = (bySource[a.source] ||= { source: a.source, label: SOURCE_LABELS[a.source] || a.source, applicants: 0, interviewed: 0, hired: 0 });
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
      ...h, source: SOURCE_LABELS[h.source] || h.source,
      days_to_hire: Math.max(0, Math.round((new Date(h.hired_at) - new Date(h.applied_at)) / DAY)),
      fee: h.salary && h.fee_percent ? Math.round((h.salary * h.fee_percent) / 100) : 0,
    }));
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
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: 'That request could not be read.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side.' });
});
