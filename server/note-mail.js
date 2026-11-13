// E-mails to the agency team about notes on candidates. When somebody writes a note on a candidate, two people are told
// by e-mail: the candidate's owner (applications.owner_id) and the account executive of the job they are on
// (jobs.account_executive_id; nobody for somebody in The Book on no job). One person who is both gets one e-mail.
//
// Four rules shape everything here.
//  1. It is the agency's business alone. Only people active on the agency team are e-mailed (never a client's user,
//     somebody deactivated, or somebody still waiting for their account), and the switch for it is offered to the
//     agency only. A note written by a client's hiring team on their own job is told to the agency like any other; a
//     note for the agency only is told too, since only the agency is told anything.
//  2. Never the person who wrote it, and none at all to somebody who has switched "Email me about notes on my
//     candidates and jobs" off in Settings.
//  3. Not too many: after an e-mail about a candidate, further notes on that candidate send that person nothing for 15
//     minutes. The table note_mail remembers when (see db.js), so this holds after a restart too. A person is noted as
//     told before the e-mail is handed over, so a second note a moment later sends nothing more. An e-mail that did
//     not go (the provider refused it) is not counted, so the next note tries again; with delivery not connected,
//     nothing is noted at all.
//  4. A note is saved whatever happens to the e-mail. The work here runs after the note's answer has gone, and
//     nothing it does can turn that answer into an error.
//
// Only notes somebody chose to write count: the Notes box on a profile, a note written when adding somebody, a debrief
// written from To do, and a call's notes saved to the profile from Otterview (the first time; saving it again changes
// the same note). Notes The Book files by itself (a covering note kept when somebody in The Book goes on a job, what is
// kept for the agency when they come back from one) are not told to anybody. The routes that write a note call
// noteWritten() for the ones that count.
import { q, tx, now, getSetting } from './db.js';
import { notify, appUrl, mailConfigured } from './mail.js';

/** How long after an e-mail about a candidate further notes on them send that person nothing. */
const WINDOW = 15 * 60 * 1000;
/** Somebody who can be e-mailed: active on the agency team (the same as in messages.js). */
const ON_TEAM = `u.role != 'client' AND u.active = 1 AND u.pending = 0`;
const firstName = (name) => String(name || '').split(/\s+/)[0];

/**
 * A note was just written: tell the people it is for, after the answer to the request has gone. `writer` is the
 * person who wrote it (the signed-in user), `body` its words.
 */
export function noteWritten({ applicationId, noteId, writer, body }) {
  setImmediate(() => {
    try {
      tell({ applicationId, noteId, writer, body: String(body ?? '') });
    } catch (err) {
      console.error('Could not e-mail about a note:', err.message);
    }
  });
}

function tell({ applicationId, noteId, writer, body }) {
  // With delivery not connected nothing would go, and nobody may be noted as told.
  if (!mailConfigured()) return;
  const app = q.get(
    `SELECT a.id, a.owner_id, a.job_id, c.name AS candidate_name, j.title AS job_title, j.account_executive_id, cl.name AS client_name
     FROM applications a JOIN candidates c ON c.id = a.candidate_id LEFT JOIN jobs j ON j.id = a.job_id LEFT JOIN clients cl ON cl.id = j.client_id
     WHERE a.id = ?`, applicationId);
  // A note deleted again before this ran is not told about.
  const note = q.get('SELECT private FROM notes WHERE id = ?', noteId);
  if (!app || !note) return;
  const at = now();
  const people = tx(() => {
    q.run('DELETE FROM note_mail WHERE mailed_at <= ?', new Date(Date.parse(at) - WINDOW).toISOString());
    const ids = [...new Set([app.owner_id, app.account_executive_id].filter((id) => id != null && id !== writer.id))];
    if (!ids.length) return [];
    const due = q.all(
      `SELECT u.id, u.name, u.email FROM users u
       WHERE u.id IN (${ids.map(() => '?').join(', ')}) AND ${ON_TEAM} AND u.note_mail = 1
         AND NOT EXISTS (SELECT 1 FROM note_mail n WHERE n.user_id = u.id AND n.application_id = ?)`, ...ids, app.id);
    for (const p of due) {
      q.run(`INSERT INTO note_mail (user_id, application_id, note_id, mailed_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (user_id, application_id) DO UPDATE SET note_id = excluded.note_id, mailed_at = excluded.mailed_at`, p.id, app.id, noteId, at);
    }
    return due;
  });
  if (!people.length) return;

  const agency = getSetting('agency_name', 'The Book');
  const writerClient = writer.role === 'client' ? q.get('SELECT name FROM clients WHERE id = ?', writer.client_id)?.name : null;
  const who = writerClient ? `${writer.name} (hiring team at ${writerClient})` : writer.name;
  const words = body.trim();
  // Counted in characters, so a character such as an emoji is never cut in half.
  const chars = Array.from(words);
  const excerpt = chars.length > 200 ? `${chars.slice(0, 200).join('')}…` : words;
  const onJob = app.job_id != null;
  const where = onJob ? `, on ${app.job_title} at ${app.client_name}` : ', who is in The Book on no job';
  const path = onJob ? `/jobs/${app.job_id}?c=${app.id}` : `/candidates?c=${app.id}`;
  const link = appUrl() ? `Open their profile: ${appUrl()}${path}`
    : onJob ? `You will find them on the ${app.job_title} job, under Jobs.` : 'You will find them under Candidates.';
  for (const person of people) {
    const owner = person.id === app.owner_id, executive = onJob && person.id === app.account_executive_id;
    const why = owner && executive ? `You are getting this because ${app.candidate_name} is your candidate and you are the account executive on ${app.job_title}.`
      : owner ? `You are getting this because ${app.candidate_name} is your candidate.`
      : `You are getting this because you are the account executive on ${app.job_title}.`;
    const sent = notify({
      to: person.email,
      subject: `${writer.name} wrote a note on ${app.candidate_name}${onJob ? ` (${app.job_title})` : ''}`,
      body: `Hi ${firstName(person.name)},\n\n${who} wrote a note on ${app.candidate_name}${where}. ${why}${note.private ? ' The note is for the agency only.' : ''}\n\n${excerpt}\n\n${link}\n\n` +
        `You will not be e-mailed about notes on ${app.candidate_name} again for 15 minutes. ` +
        'To stop these e-mails, switch off "Email me about notes on my candidates and jobs" in Settings, under Your account.\n\n' +
        `${agency}\n`,
    });
    sent.then((handedOver) => {
      if (!handedOver) q.run('DELETE FROM note_mail WHERE user_id = ? AND application_id = ? AND note_id = ?', person.id, app.id, noteId);
    }).catch(() => {});
  }
}

export function registerNoteMail(api, { agencyOnly, bad }) {
  // The signed-in person's own choice about e-mails for notes on their candidates and jobs. Kept apart from /me, which
  // a client's user is sent too.
  api.get('/note-mail/settings', agencyOnly, (req, res) => res.json({ email: req.user.note_mail !== 0 }));
  api.put('/note-mail/settings', agencyOnly, (req, res) => {
    if (typeof req.body?.email !== 'boolean') bad('email must be true or false.');
    q.run('UPDATE users SET note_mail = ? WHERE id = ?', req.body.email ? 1 : 0, req.user.id);
    res.json({ email: req.body.email });
  });
}
