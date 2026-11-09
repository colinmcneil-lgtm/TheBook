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
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');

const hashPassword = (pw, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
function verifyPassword(pw, stored) {
  const [salt, hex] = String(stored).split(':');
  if (!salt || !hex) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 32), Buffer.from(hex, 'hex'));
}

const publicUser = (u) => u && { id: u.id, name: u.name, email: u.email, role: u.role, client_id: u.client_id, title: u.title, active: u.active };
function publicClient(c, user) {
  if (isAgency(user)) return c;
  const { monthly_retainer, fee_percent, engagement_model, ...rest } = c;
  return rest;
}

// Small in-memory limiter for the unauthenticated endpoints (login, public applications).
const hits = new Map();
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    if (hits.size > 10000) hits.clear();
    const key = `${name}:${req.ip}`;
    const recent = (hits.get(key) || []).filter((t) => t > Date.now() - windowMs);
    if (recent.length >= max) return res.status(429).json({ error: 'Too many attempts. Please try again in a few minutes.' });
    recent.push(Date.now());
    hits.set(key, recent);
    next();
  };
}

const ALLOWED_RESUME = ['.pdf', '.doc', '.docx', '.rtf', '.txt'];
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
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
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}${secure}`);
}

// ---------- unauthenticated: setup + login ----------
api.get('/bootstrap', (req, res) => {
  res.json({ needsSetup: !q.get('SELECT 1 AS x FROM users LIMIT 1'), agencyName: getSetting('agency_name', '') });
});

api.post('/setup', (req, res) => {
  if (q.get('SELECT 1 AS x FROM users LIMIT 1')) bad('This workspace is already set up.', 403);
  const { agencyName, name, email, password } = req.body || {};
  if (!str(agencyName) || !str(name) || !validEmail(email)) bad('Agency name, your name and a valid email are required.');
  if (!password || password.length < 8) bad('Choose a password of at least 8 characters.');
  setSetting('agency_name', str(agencyName));
  const id = q.insert('INSERT INTO users (email, password_hash, name, role, title, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    email.trim().toLowerCase(), hashPassword(password), str(name), 'admin', 'Founder', now());
  startSession(req, res, id);
  res.json({ ok: true });
});

api.post('/login', rateLimit('login', 20, 10 * 60000), (req, res) => {
  const { email, password } = req.body || {};
  const user = q.get('SELECT * FROM users WHERE email = ? AND active = 1', String(email || '').trim().toLowerCase());
  if (!user || !password || !verifyPassword(password, user.password_hash)) bad('That email and password do not match.', 401);
  startSession(req, res, user.id);
  res.json({ ok: true });
});

// ---------- unauthenticated: public careers site ----------
const publicJobCols = `id, title, department, location, work_mode, employment_type,
  CASE WHEN salary_public = 1 THEN salary_min END AS salary_min, CASE WHEN salary_public = 1 THEN salary_max END AS salary_max`;
function careersClient(slug) {
  const c = q.get(`SELECT id, name, slug, brand_color, tagline, about, website, location, industry, currency FROM clients WHERE slug = ? AND status != 'ended'`, slug);
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
  res.json({ client, job });
});

api.post('/public/careers/:slug/jobs/:id/apply', rateLimit('apply', 10, 10 * 60000), upload.single('resume'), async (req, res) => {
  const fail = (message, status) => { removeUpload(req.file?.filename); bad(message, status); };
  const client = q.get(`SELECT * FROM clients WHERE slug = ? AND status != 'ended'`, req.params.slug);
  const job = client && q.get(`SELECT * FROM jobs WHERE id = ? AND client_id = ? AND status = 'open'`, int(req.params.id), client.id);
  if (!job) fail('This role is no longer open.', 404);
  const b = req.body || {};
  if (b.company_website) return res.json({ ok: true }); // honeypot field, filled only by bots
  const email = String(b.email || '').trim().toLowerCase();
  if (!str(b.name) || !validEmail(email)) fail('Please enter your name and a valid email address.');
  if (b.consent !== 'yes') fail('Please confirm that we may process your application.');

  const questions = json(job.questions, []);
  const given = json(b.answers, {});
  const answers = [];
  for (const question of questions) {
    const answer = str(given[question.id]);
    if (question.required && !answer) fail(`Please answer: ${question.label}`);
    answers.push({ question: question.label, answer: answer ? answer.slice(0, 4000) : '' });
  }
  const source = Object.hasOwn(SOURCE_LABELS, b.source) ? b.source : 'careers_page';

  const result = tx(() => {
    let cand = q.get('SELECT * FROM candidates WHERE client_id = ? AND email = ?', client.id, email);
    if (cand) {
      if (q.get('SELECT 1 AS x FROM applications WHERE candidate_id = ? AND job_id = ?', cand.id, job.id)) return { duplicate: true };
      q.run('UPDATE candidates SET name = ?, phone = COALESCE(?, phone), linkedin = COALESCE(?, linkedin), location = COALESCE(?, location) WHERE id = ?',
        str(b.name), str(b.phone), str(b.linkedin), str(b.location), cand.id);
    } else {
      const id = q.insert('INSERT INTO candidates (client_id, name, email, phone, linkedin, location, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        client.id, str(b.name), email, str(b.phone), str(b.linkedin), str(b.location), now());
      cand = { id };
    }
    const stage = q.get(`SELECT id FROM stages WHERE job_id = ? AND kind = 'applied'`, job.id);
    const t = now();
    const appId = q.insert(
      `INSERT INTO applications (candidate_id, job_id, stage_id, source, answers, cover_note, resume_file, resume_name, applied_at, stage_entered_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      cand.id, job.id, stage.id, source, JSON.stringify(answers), str(b.cover_note)?.slice(0, 6000) ?? null,
      req.file?.filename ?? null, req.file?.originalname?.slice(0, 200) ?? null, t, t, t);
    q.run('INSERT INTO stage_history (application_id, stage_id, entered_at) VALUES (?, ?, ?)', appId, stage.id, t);
    logActivity(appId, null, 'applied', `Applied via ${SOURCE_LABELS[source].toLowerCase()}`);
    return { appId };
  });

  if (result.duplicate) removeUpload(req.file?.filename);
  else await sendTemplate('application_received', {
    applicationId: result.appId, to: email,
    vars: { candidate_first_name: str(b.name).split(' ')[0], candidate_name: str(b.name), job_title: job.title, company: client.name, sender_name: client.name },
  });
  res.json({ ok: true });
});

// ---------- everything below requires a signed-in user ----------
api.use((req, res, next) => {
  req.user = readSession(req);
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
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
  if (!verifyPassword(current || '', req.user.password_hash)) bad('Your current password is not correct.');
  if (!next || next.length < 8) bad('Choose a password of at least 8 characters.');
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
    scorecards_due: count(`SELECT COUNT(*) n FROM interviews i JOIN interview_panel p ON p.interview_id = i.id
      WHERE p.user_id = ? AND i.status != 'cancelled' AND i.starts_at < ?
      AND NOT EXISTS (SELECT 1 FROM scorecards sc WHERE sc.interview_id = i.id AND sc.user_id = p.user_id)`, req.user.id, now()),
  });
});

// ---------- settings + templates ----------
api.put('/settings', adminOnly, (req, res) => {
  if (!str(req.body?.agencyName)) bad('Agency name is required.');
  setSetting('agency_name', str(req.body.agencyName));
  res.json({ ok: true });
});

api.get('/templates', (req, res) => res.json(q.all('SELECT * FROM email_templates ORDER BY key IS NULL, id')));
api.post('/templates', agencyOnly, (req, res) => {
  const { name, subject, body } = req.body || {};
  if (!str(name) || !str(subject) || !str(body)) bad('Name, subject and body are required.');
  res.json({ id: q.insert('INSERT INTO email_templates (name, subject, body) VALUES (?, ?, ?)', str(name), str(subject), body) });
});
api.put('/templates/:id', agencyOnly, (req, res) => {
  const { name, subject, body } = req.body || {};
  if (!str(name) || !str(subject) || !str(body)) bad('Name, subject and body are required.');
  q.run('UPDATE email_templates SET name = ?, subject = ?, body = ? WHERE id = ?', str(name), str(subject), body, int(req.params.id));
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
  const cols = `u.id, u.name, u.email, u.role, u.client_id, u.title, u.active, c.name AS client_name`;
  let rows;
  if (isAgency(req.user) && !cid) rows = q.all(`SELECT ${cols} FROM users u LEFT JOIN clients c ON c.id = u.client_id ORDER BY u.role = 'client', u.name`);
  else rows = q.all(`SELECT ${cols} FROM users u LEFT JOIN clients c ON c.id = u.client_id
    WHERE u.active = 1 AND (u.role != 'client' OR u.client_id = ?) ORDER BY u.role = 'client' DESC, u.name`, cid);
  res.json(rows);
});

api.post('/users', agencyOnly, (req, res) => {
  const b = req.body || {};
  const role = ['admin', 'recruiter', 'client'].includes(b.role) ? b.role : 'client';
  if (role !== 'client' && req.user.role !== 'admin') bad('Only an agency admin can add agency team members.', 403);
  const email = String(b.email || '').trim().toLowerCase();
  if (!str(b.name) || !validEmail(email)) bad('Name and a valid email are required.');
  if (!b.password || b.password.length < 8) bad('Set a temporary password of at least 8 characters.');
  const clientId = role === 'client' ? int(b.client_id) : null;
  if (role === 'client' && !q.get('SELECT 1 AS x FROM clients WHERE id = ?', clientId)) bad('Choose the client this person belongs to.');
  if (q.get('SELECT 1 AS x FROM users WHERE email = ?', email)) bad('Someone with that email already has an account.');
  const id = q.insert('INSERT INTO users (email, password_hash, name, role, client_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    email, hashPassword(b.password), str(b.name), role, clientId, str(b.title), now());
  res.json({ id });
});

api.patch('/users/:id', agencyOnly, (req, res) => {
  const target = q.get('SELECT * FROM users WHERE id = ?', int(req.params.id));
  if (!target) bad('Not found', 404);
  if (target.role !== 'client' && req.user.role !== 'admin') bad('Only an agency admin can change agency team members.', 403);
  const b = req.body || {};
  if (b.active === false && target.id === req.user.id) bad('You cannot deactivate your own account.');
  q.run('UPDATE users SET name = ?, title = ?, active = ? WHERE id = ?',
    str(b.name) ?? target.name, b.title !== undefined ? str(b.title) : target.title, b.active === undefined ? target.active : b.active ? 1 : 0, target.id);
  if (b.password) {
    if (b.password.length < 8) bad('Passwords need at least 8 characters.');
    q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(b.password), target.id);
    q.run('DELETE FROM sessions WHERE user_id = ?', target.id);
  }
  if (b.active === false) q.run('DELETE FROM sessions WHERE user_id = ?', target.id);
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
  return {
    name: str(b.name), brand_color: /^#[0-9a-f]{6}$/i.test(b.brand_color || '') ? b.brand_color : '#1f5443',
    website: str(b.website), industry: str(b.industry), location: str(b.location), tagline: str(b.tagline), about: str(b.about),
    status: ['active', 'paused', 'ended'].includes(b.status) ? b.status : 'active',
    engagement_model: ['retainer', 'per_hire', 'hybrid'].includes(b.engagement_model) ? b.engagement_model : 'retainer',
    monthly_retainer: int(b.monthly_retainer) ?? 0, fee_percent: Number(b.fee_percent) || 0,
    currency: /^[A-Z]{3}$/.test(b.currency || '') ? b.currency : 'USD', started_at: str(b.started_at),
  };
}

api.post('/clients', agencyOnly, (req, res) => {
  const f = clientFields(req.body || {});
  if (!f.name) bad('Company name is required.');
  let slug = slugify(req.body.slug || f.name) || 'company';
  for (let n = 2; q.get('SELECT 1 AS x FROM clients WHERE slug = ?', slug); n++) slug = `${slugify(req.body.slug || f.name)}-${n}`;
  const id = q.insert(
    `INSERT INTO clients (name, slug, brand_color, website, industry, location, tagline, about, status, engagement_model, monthly_retainer, fee_percent, currency, started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    f.name, slug, f.brand_color, f.website, f.industry, f.location, f.tagline, f.about, f.status, f.engagement_model, f.monthly_retainer, f.fee_percent, f.currency,
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
    `UPDATE clients SET name = ?, slug = ?, brand_color = ?, website = ?, industry = ?, location = ?, tagline = ?, about = ?, status = ?,
       engagement_model = ?, monthly_retainer = ?, fee_percent = ?, currency = ?, started_at = ? WHERE id = ?`,
    f.name, slug, f.brand_color, f.website, f.industry, f.location, f.tagline, f.about, f.status, f.engagement_model, f.monthly_retainer, f.fee_percent, f.currency, f.started_at, id);
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
const hydrateJob = (j) => ({ ...j, questions: json(j.questions, []), criteria: json(j.criteria, []) });

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
  res.json(rows.map(hydrateJob));
});

function jobFields(b) {
  const questions = (Array.isArray(b.questions) ? b.questions : [])
    .filter((x) => str(x?.label))
    .map((x) => ({ id: str(x.id) || crypto.randomBytes(4).toString('hex'), label: str(x.label), type: ['short', 'long', 'yesno'].includes(x.type) ? x.type : 'short', required: Boolean(x.required) }));
  const criteria = (Array.isArray(b.criteria) ? b.criteria : []).map(str).filter(Boolean).slice(0, 12);
  return {
    title: str(b.title), department: str(b.department), location: str(b.location),
    work_mode: ['onsite', 'hybrid', 'remote'].includes(b.work_mode) ? b.work_mode : 'hybrid',
    employment_type: ['full_time', 'part_time', 'contract'].includes(b.employment_type) ? b.employment_type : 'full_time',
    salary_min: int(b.salary_min), salary_max: int(b.salary_max), salary_public: b.salary_public === false ? 0 : 1,
    description: str(b.description), ideal_profile: str(b.ideal_profile),
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
  const stageNames = (Array.isArray(b.interview_stages) ? b.interview_stages : []).map((s) => str(s?.name)).filter(Boolean);
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
  const job = hydrateJob(loadJob(req.params.id, req.user));
  if (!isAgency(req.user)) delete job.ideal_profile;
  const stages = q.all('SELECT * FROM stages WHERE job_id = ? ORDER BY position', job.id);
  res.json({ job, stages });
});

api.put('/jobs/:id', agencyOnly, (req, res) => {
  const job = loadJob(req.params.id, req.user);
  const b = req.body || {};
  const f = jobFields(b);
  if (!f.title) bad('Job title is required.');
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
      const wanted = b.interview_stages.filter((s) => str(s?.name));
      if (!wanted.length) bad('Keep at least one interview stage.');
      const existing = q.all(`SELECT * FROM stages WHERE job_id = ? AND kind = 'interview'`, job.id);
      const keep = new Set(wanted.map((s) => int(s.id)).filter(Boolean));
      for (const s of existing) {
        if (keep.has(s.id)) continue;
        if (q.get('SELECT 1 AS x FROM applications WHERE stage_id = ?', s.id)) bad(`Move candidates out of “${s.name}” before removing it.`);
        q.run('DELETE FROM stage_history WHERE stage_id = ?', s.id);
        q.run('DELETE FROM stages WHERE id = ?', s.id);
      }
      wanted.forEach((s, i) => {
        const own = existing.find((e) => e.id === int(s.id));
        if (own) q.run('UPDATE stages SET name = ?, position = ? WHERE id = ?', str(s.name), i + 1, own.id);
        else q.run(`INSERT INTO stages (job_id, name, kind, position) VALUES (?, ?, 'interview', ?)`, job.id, str(s.name), i + 1);
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
  if (str(req.query.q)) {
    where.push(`(c.name LIKE ? OR c.email LIKE ? OR c.current_company LIKE ? OR c.current_title LIKE ?)`);
    const like = `%${str(req.query.q)}%`;
    p.push(like, like, like, like);
  }
  const order = req.query.sort === 'oldest' ? 'a.applied_at ASC' : 'a.applied_at DESC';
  res.json(q.all(`${appSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 500`, ...p));
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
  candidate_first_name: a.candidate_name.split(' ')[0], candidate_name: a.candidate_name,
  job_title: a.job_title, company: a.client_name, sender_name: user.name,
});

function moveToStage(app, stageId, user) {
  const stage = q.get('SELECT * FROM stages WHERE id = ? AND job_id = ?', int(stageId), app.job_id);
  if (!stage) bad('That stage does not belong to this job.');
  if (stage.id === app.stage_id && app.status === 'active') return stage;
  const t = now();
  const hired = stage.kind === 'hired';
  q.run(`UPDATE applications SET stage_id = ?, stage_entered_at = ?, updated_at = ?, status = ?, hired_at = ?, reject_reason = NULL WHERE id = ?`,
    stage.id, t, t, hired ? 'hired' : 'active', hired ? t : null, app.id);
  q.run('INSERT INTO stage_history (application_id, stage_id, entered_at) VALUES (?, ?, ?)', app.id, stage.id, t);
  logActivity(app.id, user.id, hired ? 'hired' : 'stage', hired ? 'Marked as hired' : `Moved to ${stage.name}`);
  return stage;
}

api.post('/applications', agencyOnly, upload.single('resume'), (req, res) => {
  const b = req.body || {};
  const fail = (message) => { removeUpload(req.file?.filename); bad(message); };
  const job = q.get('SELECT * FROM jobs WHERE id = ?', int(b.job_id));
  if (!job) fail('Choose a job for this candidate.');
  const email = String(b.email || '').trim().toLowerCase();
  if (!str(b.name) || !validEmail(email)) fail('Name and a valid email are required.');
  const source = Object.hasOwn(SOURCE_LABELS, b.source) ? b.source : 'agency_sourced';
  const id = tx(() => {
    let cand = q.get('SELECT * FROM candidates WHERE client_id = ? AND email = ?', job.client_id, email);
    if (cand && q.get('SELECT 1 AS x FROM applications WHERE candidate_id = ? AND job_id = ?', cand.id, job.id)) fail('This person is already in the pipeline for this job.');
    if (!cand) {
      cand = { id: q.insert(
        'INSERT INTO candidates (client_id, name, email, phone, linkedin, location, current_title, current_company, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        job.client_id, str(b.name), email, str(b.phone), str(b.linkedin), str(b.location), str(b.current_title), str(b.current_company), now()) };
    }
    const stage = q.get('SELECT * FROM stages WHERE id = ? AND job_id = ?', int(b.stage_id), job.id)
      ?? q.get(`SELECT * FROM stages WHERE job_id = ? AND kind = 'applied'`, job.id);
    const t = now();
    const appId = q.insert(
      `INSERT INTO applications (candidate_id, job_id, stage_id, source, cover_note, resume_file, resume_name, applied_at, stage_entered_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      cand.id, job.id, stage.id, source, str(b.cover_note), req.file?.filename ?? null, req.file?.originalname?.slice(0, 200) ?? null, t, t, t);
    q.run('INSERT INTO stage_history (application_id, stage_id, entered_at) VALUES (?, ?, ?)', appId, stage.id, t);
    logActivity(appId, req.user.id, 'added', `Added to the pipeline (${SOURCE_LABELS[source].toLowerCase()})`);
    return appId;
  });
  res.json({ id });
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
    const c = b.candidate;
    const email = String(c.email || '').trim().toLowerCase();
    if (!str(c.name) || !validEmail(email)) bad('Name and a valid email are required.');
    if (q.get('SELECT 1 AS x FROM candidates WHERE client_id = ? AND email = ? AND id != ?', a.client_id, email, a.candidate_id)) bad('Another candidate at this client already uses that email.');
    q.run('UPDATE candidates SET name = ?, email = ?, phone = ?, linkedin = ?, location = ?, current_title = ?, current_company = ? WHERE id = ?',
      str(c.name), email, str(c.phone), str(c.linkedin), str(c.location), str(c.current_title), str(c.current_company), a.candidate_id);
  }
  res.json({ ok: true });
});

api.post('/applications/:id/move', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  const stage = tx(() => moveToStage(a, req.body?.stage_id, req.user));
  res.json({ ok: true, stage });
});

api.post('/applications/:id/reject', async (req, res) => {
  const a = loadApp(req.params.id, req.user);
  const reason = str(req.body?.reason) || 'Not specified';
  q.run(`UPDATE applications SET status = 'rejected', reject_reason = ?, hired_at = NULL, updated_at = ? WHERE id = ?`, reason, now(), a.id);
  logActivity(a.id, req.user.id, 'rejected', `Rejected: ${reason}`);
  if (req.body?.send_email) await sendTemplate('rejection', { applicationId: a.id, to: a.candidate_email, vars: mailVars(a, req.user), userId: req.user.id });
  res.json({ ok: true });
});

api.post('/applications/:id/restore', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  if (a.status === 'active') return res.json({ ok: true });
  const stage = q.get('SELECT kind FROM stages WHERE id = ?', a.stage_id);
  q.run(`UPDATE applications SET status = ?, reject_reason = NULL, updated_at = ? WHERE id = ?`, stage.kind === 'hired' ? 'hired' : 'active', now(), a.id);
  logActivity(a.id, req.user.id, 'restored', 'Returned to the pipeline');
  res.json({ ok: true });
});

api.post('/applications/:id/withdraw', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  q.run(`UPDATE applications SET status = 'withdrawn', reject_reason = ?, hired_at = NULL, updated_at = ? WHERE id = ?`, str(req.body?.reason), now(), a.id);
  logActivity(a.id, req.user.id, 'withdrawn', `Candidate withdrew${str(req.body?.reason) ? `: ${str(req.body.reason)}` : ''}`);
  res.json({ ok: true });
});

// Agency -> client hand-off: the recruiter submits a shortlisted candidate with a write-up, the hiring team approves or declines.
api.post('/applications/:id/submit', agencyOnly, (req, res) => {
  const a = loadApp(req.params.id, req.user);
  if (!str(req.body?.note)) bad('Add a short write-up so the hiring team knows why this candidate is worth meeting.');
  q.run(`UPDATE applications SET review_status = 'pending', submission_note = ?, submitted_by = ?, review_note = NULL, reviewed_by = NULL, reviewed_at = NULL, updated_at = ? WHERE id = ?`,
    str(req.body.note), req.user.id, now(), a.id);
  logActivity(a.id, req.user.id, 'submitted', 'Submitted to the hiring team for review');
  res.json({ ok: true });
});

api.post('/applications/:id/review', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  if (a.review_status !== 'pending') bad('This candidate is not waiting for review.');
  const approve = req.body?.decision === 'approved';
  if (!approve && req.body?.decision !== 'declined') bad('Choose approve or decline.');
  const note = str(req.body?.note);
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
    }
  });
  res.json({ ok: true });
});

api.post('/applications/:id/notes', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  if (!str(req.body?.body)) bad('Write a note first.');
  const id = q.insert('INSERT INTO notes (application_id, user_id, body, private, created_at) VALUES (?, ?, ?, ?, ?)',
    a.id, req.user.id, str(req.body.body), isAgency(req.user) && req.body.private ? 1 : 0, now());
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
  if (!str(req.body?.subject) || !str(req.body?.body)) bad('Subject and message are required.');
  const result = await sendMail({ applicationId: a.id, to: a.candidate_email, subject: str(req.body.subject), body: req.body.body, userId: req.user.id });
  logActivity(a.id, req.user.id, 'email', `Emailed candidate: ${str(req.body.subject)}`);
  res.json(result);
});

api.put('/applications/:id/offer', agencyOnly, (req, res) => {
  const a = loadApp(req.params.id, req.user);
  const b = req.body || {};
  const status = ['draft', 'sent', 'accepted', 'declined'].includes(b.status) ? b.status : 'draft';
  const existing = q.get('SELECT * FROM offers WHERE application_id = ?', a.id);
  const t = now();
  if (existing) q.run('UPDATE offers SET salary = ?, start_date = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?', int(b.salary), str(b.start_date), status, str(b.notes), t, existing.id);
  else q.run('INSERT INTO offers (application_id, salary, start_date, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', a.id, int(b.salary), str(b.start_date), status, str(b.notes), t, t);
  if (!existing || existing.status !== status) logActivity(a.id, req.user.id, 'offer', `Offer ${status === 'draft' ? 'drafted' : status}`);
  res.json({ ok: true });
});

api.get('/applications/:id/resume', (req, res) => {
  const a = loadApp(req.params.id, req.user);
  if (!a.resume_file) bad('No résumé on file.', 404);
  const safeName = (a.resume_name || 'resume').replace(/[^\w.\- ]+/g, '_');
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
  res.sendFile(path.join(UPLOAD_DIR, path.basename(a.resume_file)));
});

// Permanently erase a candidate's application (and the candidate record if this was their only one).
api.delete('/applications/:id', agencyOnly, (req, res) => {
  const a = loadApp(req.params.id, req.user);
  removeUpload(a.resume_file);
  tx(() => {
    q.run('DELETE FROM applications WHERE id = ?', a.id);
    if (!q.get('SELECT 1 AS x FROM applications WHERE candidate_id = ?', a.candidate_id)) q.run('DELETE FROM candidates WHERE id = ?', a.candidate_id);
  });
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
  if (req.query.when === 'upcoming') { where.push(`i.status = 'scheduled' AND i.starts_at >= ?`); p.push(new Date(Date.now() - 3600000).toISOString()); }
  if (req.query.when === 'past') { where.push(`(i.status != 'scheduled' OR i.starts_at < ?)`); p.push(new Date(Date.now() - 3600000).toISOString()); }
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
  if (!str(b.title) || Number.isNaN(starts.getTime())) bad('Give the interview a title and a start time.');
  const kind = Object.hasOwn(KIND_LABELS, b.kind) ? b.kind : 'video';
  const id = tx(() => {
    const iid = q.insert(
      `INSERT INTO interviews (application_id, title, kind, starts_at, duration_min, location, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.id, str(b.title), kind, starts.toISOString(), Math.max(10, int(b.duration_min) ?? 45), str(b.location), str(b.notes), req.user.id, now());
    setPanel(iid, a.client_id, b.panel);
    logActivity(a.id, req.user.id, 'interview', `Scheduled ${str(b.title)}`);
    return iid;
  });
  if (b.notify) await sendTemplate('interview_invite', {
    applicationId: a.id, to: a.candidate_email, userId: req.user.id,
    vars: { ...mailVars(a, req.user), interview_time: str(b.time_label) || starts.toUTCString(), interview_format: KIND_LABELS[kind], interview_location: str(b.location) || 'Details to follow' },
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
        str(b.title) ?? i.title, Object.hasOwn(KIND_LABELS, b.kind) ? b.kind : i.kind, starts.toISOString(),
        Math.max(10, int(b.duration_min) ?? i.duration_min), str(b.location), str(b.notes), i.id);
      if (starts.toISOString() !== i.starts_at) logActivity(i.application_id, req.user.id, 'interview', `Rescheduled ${i.title}`);
    }
    if (Array.isArray(b.panel)) setPanel(i.id, i.client_id, b.panel);
  });
  res.json({ ok: true });
});

api.get('/interviews/:id/ics', (req, res) => {
  const i = loadInterview(req.params.id, req.user);
  const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s) => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
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
  for (const [k, v] of Object.entries(b.ratings || {})) if (int(v) >= 1 && int(v) <= 4) ratings[String(k).slice(0, 80)] = int(v);
  const label = { strong_yes: 'Strong yes', yes: 'Yes', no: 'No', strong_no: 'Strong no' }[b.recommendation];
  tx(() => {
    q.run(
      `INSERT INTO scorecards (interview_id, user_id, recommendation, ratings, notes, submitted_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(interview_id, user_id) DO UPDATE SET recommendation = excluded.recommendation, ratings = excluded.ratings, notes = excluded.notes, submitted_at = excluded.submitted_at`,
      i.id, req.user.id, b.recommendation, JSON.stringify(ratings), str(b.notes), now());
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
      WHERE i.status = 'scheduled' AND i.starts_at >= ? AND i.starts_at < ? ${w}`, now(), new Date(Date.now() + 7 * DAY).toISOString(), ...p),
    offers_out: n(`SELECT COUNT(*) n ${appJoin} WHERE a.status = 'active' AND s.kind = 'offer' ${w}`, ...p),
    hires_90d: n(`SELECT COUNT(*) n ${appJoin} WHERE a.status = 'hired' AND a.hired_at >= ? ${w}`, daysAgo(90), ...p),
    pending_review: n(`SELECT COUNT(*) n ${appJoin} WHERE a.status = 'active' AND a.review_status = 'pending' ${w}`, ...p),
  };
  const upcoming = withPanels(q.all(
    `${interviewSelect} WHERE i.status = 'scheduled' AND i.starts_at >= ? ${cid ? 'AND cl.id = ?' : ''} ORDER BY i.starts_at LIMIT 6`,
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
  const days = int(req.query.days);
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
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side.' });
});
