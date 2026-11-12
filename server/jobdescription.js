// A job's description, to download from its Brief: as a PDF made from the advert saved on the job, with or without
// the client's name, and as the client's own file when one was kept with the job.
//
// Everything here is the agency's. Every route is for the agency only, and finds the job through loadJob as the
// job's own routes do. A client's user is refused on all of them, and nothing they can fetch says whether a file is
// kept (see withoutClientFile in api.js).
//
// The PDF without the client's name has one rule, the confidential post's: nothing in it may give the client away
// that the recruiter has not been warned about. So it is made from the confidential post's own wording when the job
// has one (written and checked for the public), and the text that goes in the file is searched by the post's own
// check first (board.js). What the check finds is listed for the recruiter, who has to say they want the file
// anyway; a request that does not say so is refused with the same list, so a link made by hand cannot skip it.
import crypto from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { q, now, tx, getSetting, UPLOAD_DIR } from './db.js';
import * as board from './board.js';
import { jobMeta, salaryRange } from './jobwords.js';
import { makePdf, printable, MAX_TEXT } from './jobpdf.js';

const FIELD = { title: 'title', location: 'location', description: 'description' };
// What each kind of find is, in a few plain words. `client` is the client's name.
const WHAT = {
  name: () => 'the client’s name',
  word: (client) => `part of the client’s name (${client})`,
  short_name: (client) => `a short form of the client’s name (${client})`,
  initials: (client) => `the initials of the client’s name (${client})`,
  other_name: () => 'one of the other names you listed for this client',
  slug: () => 'the address of the client’s careers page',
  website: () => 'the client’s website',
  person: () => 'the name of somebody at the client',
  email_domain: () => 'where the client’s people have their e-mail',
  link: () => 'a link, which may lead to the client',
  email: () => 'an e-mail address, which may be the client’s',
  phone: () => 'a phone number, which may be the client’s',
  handle: () => 'a hashtag or social-media handle, which may be the client’s',
  mixed_letters: () => 'a word that mixes two alphabets that look alike, which can hide a name',
};
const times = (n) => (n === 1 ? '' : n === 2 ? ' twice' : ` ${n} times`);

// Finds about the client's own careers page, where the job's advert is shown under the client's name while the job
// is open: a sentence each, since they are about the whole file rather than a word in it.
const CAREERS = {
  same_title: (client) => `The title is the same as on ${client}’s own careers page, where this job is advertised in their name while it is open. Anybody who searches for it finds them.`,
  same_salary: (client) => `The pay range is the same as on ${client}’s own careers page. To somebody comparing the two it is as good as a name. Leave the pay range out.`,
  similar_salary: (client) => `The pay range is the one on ${client}’s own careers page, rounded. Somebody comparing the two could still match them by it. Leave the pay range out.`,
  same_text: (client, g) => `${g.count === 1 ? 'One sentence of the description is' : `${g.count} sentences of the description are`} word for word the same as on ${client}’s own careers page${g.count === 1 ? '' : ', for example'}: “${g.found}”${/[.!?…]$/.test(g.found) ? '' : '.'} Anybody who searches for ${g.count === 1 ? 'it' : 'one of them'} finds the client.`,
};

/** What the check found, one line per thing found in one place, with how many times: "The description mentions “Lumen” 3 times: part of the client’s name (Lumen Health)." */
function findingsOf(problems, clientName) {
  const groups = new Map();
  for (const p of problems) {
    const key = `${p.field}\u0000${p.kind}\u0000${String(p.found ?? '').toLowerCase()}`;
    if (groups.has(key)) groups.get(key).count++;
    else groups.set(key, { field: p.field, kind: p.kind, found: p.found ?? '', count: p.count ?? 1 });
  }
  return [...groups.values()].map((g) => ({
    ...g,
    message: CAREERS[g.kind] ? CAREERS[g.kind](clientName, g)
      : `The ${FIELD[g.field] ?? g.field} mentions “${g.found}”${times(g.count)}: ${(WHAT[g.kind] ?? (() => 'something that may give the client away'))(clientName)}.`,
  }));
}

/** The agency's name, as it heads the PDF and its footer. */
const agencyName = () => getSetting('agency_name', '') || 'Agency';
/** Text for a file name: one line, nothing invisible, none of the characters file systems refuse, not too long. */
const forFileName = (s, max) => {
  const flat = printable(s).text.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max).trimEnd() : flat;
};
const today = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Exactly what goes in a job's PDF, made in one place for the check and for the file. `named` is whether it gives
 * the client's name; `pay` whether it shows the pay range. With the client's name, it is the job as the careers
 * page shows it. Without, it is the confidential post's wording when the post has all three of a title, a location
 * and a text, and the job's own otherwise; the heading says "with our client"; the pay range is the post's (rounded,
 * when the post rounds it).
 */
export function documentFor(job, { named, pay }) {
  const agency = agencyName();
  const post = named ? null : board.savedPost(job.id);
  const usesPost = Boolean(post && [post.title, post.location, post.description].every((v) => String(v ?? '').trim()));
  // The text that goes in, as it will be printed: what the check is run on is then exactly what is in the file.
  const from = usesPost ? post : job;
  const printed = {
    title: printable(from.title), location: printable(from.location), description: printable(String(from.description ?? '').slice(0, MAX_TEXT)),
  };
  const fields = Object.fromEntries(Object.entries(printed).map(([k, v]) => [k, v.text.trim()]));
  const hasPay = Boolean(job.salary_min || job.salary_max);
  const range = pay && hasPay ? (usesPost && post.round_salary ? board.roundedRange(job.salary_min, job.salary_max) : { min: job.salary_min, max: job.salary_max }) : { min: null, max: null };
  const facts = jobMeta({ location: fields.location, work_mode: job.work_mode, employment_type: job.employment_type, salary_min: range.min, salary_max: range.max }, job.currency);
  const client = named ? printable(job.client_name).text.trim() : null;
  return {
    named, usesPost, fields, agency,
    // Whether the file shows the pay range and whether rounded, for the check (the same as the post's own choices).
    pay: { pay: range.min != null || range.max != null, round: Boolean(usesPost && post.round_salary) },
    // Whether some characters (emoji, say) cannot be printed and are left out.
    dropped: Object.values(printed).some((v) => v.dropped),
    pdf: {
      agency, title: fields.title, subtitle: named ? client : 'With our client', facts,
      note: named ? null : 'The employer’s name is kept confidential at this stage.',
      description: fields.description, date: today(),
      info: { Title: named ? `${fields.title} - ${client}` : fields.title, Author: agency, Subject: 'Job description' },
    },
    fileName: named ? `${forFileName(client, 80) || 'Client'} - ${forFileName(fields.title, 120) || 'Job'}.pdf`
      : `${forFileName(fields.title, 120) || 'Job'} - ${forFileName(agency, 80) || 'Agency'}.pdf`,
  };
}

/** A file's name cut to 200 characters with its extension kept, so the saved download still opens by a double click. */
export function keptName(name, ext) {
  if (name.length <= 200) return name;
  const end = ext && name.toLowerCase().endsWith(ext) ? name.slice(-ext.length) : '';
  return name.slice(0, 200 - end.length).trimEnd() + end;
}

/** The client's own file as the agency is shown it, or null when none is kept. */
export function fileView(job) {
  if (!job.jd_file) return null;
  const by = job.jd_file_by != null ? q.get('SELECT name FROM users WHERE id = ?', job.jd_file_by)?.name ?? null : null;
  return { name: job.jd_file_name, size: job.jd_file_size, added_by: by, added_at: job.jd_file_at };
}

export function registerJobDescription(api, { agencyOnly, bad, clean, takeHit, removeUpload, ALLOWED_RESUME, HttpError, loadJob, ownsJob, downloadAs }) {
  // The same types and size as a résumé: a PDF, Word, RTF or text file, up to 8 MB.
  const upload = multer({
    storage: multer.diskStorage({
      destination: UPLOAD_DIR,
      filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase()),
    }),
    limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 10, parts: 12, fieldSize: 10 * 1024, fieldNameSize: 100 },
    defParamCharset: 'utf8',
    fileFilter: (req, file, cb) =>
      ALLOWED_RESUME.includes(path.extname(file.originalname).toLowerCase())
        ? cb(null, true)
        : cb(new HttpError(400, 'The job description has to be a PDF, a Word document (.doc or .docx), an RTF or a text file.')),
  });

  /** The job, for somebody who may change its file: its account executive or an admin, as for its brief. Checked before anything is read from the request. */
  const owned = (req, res, next) => {
    const job = loadJob(req.params.id, req.user);
    if (!ownsJob(req.user, job)) {
      bad(job.account_executive_name
        ? `Only ${job.account_executive_name} (this job’s account executive) or an admin can change the client’s file.`
        : 'This job has no account executive, so only an admin can change the client’s file.', 403);
    }
    req.job = job;
    next();
  };

  // What the Brief's card needs: whether a PDF can be made each way, the confidential post's choices, and the file.
  api.get('/jobs/:id/job-description', agencyOnly, (req, res) => {
    const job = loadJob(req.params.id, req.user);
    const post = board.savedPost(job.id);
    const without = documentFor(job, { named: false, pay: false });
    res.json({
      with: Boolean(String(job.description ?? '').trim()),
      without: Boolean(without.fields.description),
      pay_range: salaryRange(job.salary_min, job.salary_max, job.currency) || null,
      post: post ? { enabled: Boolean(post.enabled), wording: without.usesPost, show_salary: Boolean(post.show_salary), round_salary: Boolean(post.round_salary) } : null,
      file: fileView(job),
      can_change: ownsJob(req.user, job),
      account_executive: job.account_executive_name ?? null,
    });
  });

  /** The choices in a PDF request: whether it names the client (asked every time: there is no default) and whether it shows the pay. */
  const choices = (query) => {
    if (!['with', 'without'].includes(query.name)) bad('Choose whether the PDF gives the client’s name.');
    return { named: query.name === 'with', pay: query.pay === '1' };
  };
  /** What the check finds in the PDF without the client's name. Nothing is looked for in one that gives it. */
  const findingsFor = (job, made) => {
    if (made.named) return { findings: [], overruled: 0 };
    const { problems, overruled } = board.checkDocument(job.id, made.fields, made.pay);
    return { findings: findingsOf(problems, job.client_name), overruled: overruled.length };
  };
  const noDescription = 'This job has no description to make a PDF from. Add one first: Edit, then the Job advert box.';

  api.get('/jobs/:id/job-description/check', agencyOnly, (req, res) => {
    const job = loadJob(req.params.id, req.user);
    const made = documentFor(job, choices(req.query));
    if (!made.fields.description) bad(noDescription);
    res.json({ ...findingsFor(job, made), uses_post: made.usesPost, dropped: made.dropped });
  });

  api.get('/jobs/:id/job-description/pdf', agencyOnly, async (req, res) => {
    const job = loadJob(req.params.id, req.user);
    const made = documentFor(job, choices(req.query));
    if (!made.fields.description) bad(noDescription);
    const { findings } = findingsFor(job, made);
    if (findings.length && req.query.anyway !== '1') {
      bad('This PDF could give the client away. Look at what was found, then download it anyway or change the advert first.', 409, { findings });
    }
    if (!takeHit(`jd-pdf:${req.user.id}`, 120, 10 * 60000)) bad('That is a lot of PDFs in a few minutes. Try again shortly.', 429);
    const pdf = await makePdf(made.pdf);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', downloadAs(made.fileName));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(pdf);
  });

  // ----- the client's own file -----
  api.get('/jobs/:id/job-description/file', agencyOnly, (req, res) => {
    const job = loadJob(req.params.id, req.user);
    if (!job.jd_file) bad('No file from the client is kept with this job.', 404);
    // Always a download under the name it came with, never shown inside the site: as a résumé is sent.
    res.setHeader('Content-Disposition', downloadAs(job.jd_file_name));
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.basename(job.jd_file), { root: UPLOAD_DIR, dotfiles: 'allow' }, (err) => {
      // The answer is not the file, so it must not be saved under the file's name.
      if (err && !res.headersSent) {
        res.removeHeader('Content-Disposition');
        res.status(404).json({ error: 'The file is missing from the server.' });
      }
    });
  });

  // Keep the client's file with the job, or put a new one in its place. A job that has one already keeps it unless
  // the request says to replace it: the screen asks first, and nothing is ever replaced without that.
  api.put('/jobs/:id/job-description/file', agencyOnly, owned, upload.single('file'), (req, res) => {
    let kept = false;
    try {
      const job = req.job;
      if (!req.file) bad('Choose the file to keep with the job.');
      if (!req.file.size) bad('That file is empty.');
      const ext = path.extname(req.file.originalname).toLowerCase();
      // The name as it came, without anything that cannot be seen (a right-to-left mark can make "fdp.exe" read as "exe.pdf").
      const name = keptName(clean(String(req.file.originalname).replace(/\p{Cf}/gu, ''), 1000) || '', ext) || `Job description${ext}`;
      const had = q.get('SELECT jd_file, jd_file_name FROM jobs WHERE id = ?', job.id);
      if (had.jd_file && req.body?.replace !== '1') {
        bad(`This job already has the client’s file (${had.jd_file_name}). Replace it, or keep the one it has.`, 409, { file: had.jd_file_name });
      }
      tx(() => q.run('UPDATE jobs SET jd_file = ?, jd_file_name = ?, jd_file_size = ?, jd_file_by = ?, jd_file_at = ? WHERE id = ?',
        req.file.filename, name, req.file.size, req.user.id, now(), job.id));
      kept = true;
      removeUpload(had.jd_file); // the one it replaces goes from the disk
      res.json({ ok: true, replaced: Boolean(had.jd_file), file: fileView(q.get('SELECT * FROM jobs WHERE id = ?', job.id)) });
    } finally {
      if (!kept) removeUpload(req.file?.filename);
    }
  });

  api.delete('/jobs/:id/job-description/file', agencyOnly, owned, (req, res) => {
    const had = q.get('SELECT jd_file FROM jobs WHERE id = ?', req.job.id);
    if (!had.jd_file) bad('No file from the client is kept with this job.', 404);
    q.run('UPDATE jobs SET jd_file = NULL, jd_file_name = NULL, jd_file_size = NULL, jd_file_by = NULL, jd_file_at = NULL WHERE id = ?', req.job.id);
    removeUpload(had.jd_file);
    res.json({ ok: true });
  });
}
