import nodemailer from 'nodemailer';
import { q, now, getSetting } from './db.js';

// Delivery is optional and there are two ways to connect it:
//   RESEND_API_KEY + MAIL_FROM   sends through Resend's web API (https). Use this on hosts that block SMTP,
//                                which includes Railway's Hobby plan.
//   SMTP_URL (+ MAIL_FROM)       sends through any SMTP server, e.g. smtps://user:pass@smtp.example.com
// Without either, every candidate email is still recorded on the candidate, marked as not delivered.
const resendKey = (process.env.RESEND_API_KEY || '').trim();
const transport = !resendKey && process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;
const RESEND_URL = process.env.RESEND_API_URL || 'https://api.resend.com/emails';

export const mailConfigured = () => Boolean((resendKey && process.env.MAIL_FROM) || transport);
export const mailProvider = () => (resendKey && process.env.MAIL_FROM ? 'Resend' : transport ? 'SMTP' : null);

export const renderTemplate = (text, vars) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (vars[key] ?? m));

/** Hand one plain-text message to whichever provider is connected. Throws if delivery fails. */
async function deliver({ to, subject, body }) {
  const recipients = [].concat(to);
  const from = process.env.MAIL_FROM || `"${getSetting('agency_name', 'Recruiting')}" <no-reply@localhost>`;
  if (resendKey) {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: recipients, subject, text: body }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Resend answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return;
  }
  // subject and body are plain strings by the time they get here; the two flags make the mail library refuse to
  // read files or fetch URLs even if something else were ever passed.
  await transport.sendMail({ from, to: recipients, subject, text: body, disableFileAccess: true, disableUrlAccess: true });
}

/**
 * An entry in The Book that was folded into another application, and the application it went to (see foldEntry and
 * entryIntoApplication in api.js). A message can be with the mail provider while that happens; it is recorded once
 * the provider has answered, on the application the entry went to. Held in memory only: it matters for the seconds
 * a send takes, and ids are never used twice.
 */
const folded = new Map();
export const foldedInto = (fromId, intoId) => { folded.set(fromId, intoId); };

/**
 * Send one message to a candidate and record it on their application. Resolves to the record's id (below zero when
 * it is one of the agency's own, as the profile numbers them; null when the application has gone), how delivery
 * went, and where and when it was recorded, so that the caller's history line can be written beside it.
 *
 * Delivery can take seconds, and the application can change meanwhile. Somebody in The Book can be put on a job:
 * what was sent to them before that is the agency's business, so the record goes to the agency's own table, never
 * where the client's hiring team is shown from. Their entry can be folded into another application: the record
 * goes there. And the application can be deleted: then there is nothing to record on.
 */
export async function sendMail({ applicationId, to, subject, body, userId = null }) {
  subject = String(subject).replace(/[\r\n]+/g, ' ').slice(0, 300);
  body = String(body);
  const began = now();
  const wasInBook = q.get('SELECT job_id FROM applications WHERE id = ?', applicationId)?.job_id == null;
  let delivery = 'not_configured';
  if (mailConfigured()) {
    try {
      await deliver({ to, subject, body });
      delivery = 'sent';
    } catch (err) {
      console.error('Email delivery failed:', err.message);
      delivery = 'failed';
    }
  }
  const find = (id) => q.get('SELECT id, job_id, general_until FROM applications WHERE id = ?', id);
  let app = find(applicationId);
  for (let id = applicationId; !app && folded.has(id);) { id = folded.get(id); app = find(id); }
  if (!app) return { id: null, delivery, applicationId: null, agencyOnly: false, at: began };
  // On a job now, and sent before they were on it: from The Book, or from a job they have since left for another.
  const agencyOnly = app.job_id != null && (wasInBook || (app.general_until != null && app.general_until > began));
  const at = agencyOnly ? began : now();
  const id = q.insert(
    `INSERT INTO ${agencyOnly ? 'agency_emails' : 'emails'} (application_id, to_email, subject, body, sent_by, delivery, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    app.id, to, subject, body, userId, delivery, at);
  return { id: agencyOnly ? -id : id, delivery, applicationId: app.id, agencyOnly, at };
}

/** Where the workspace lives, for links in emails. Never taken from the request, which a sender could forge. */
export const appUrl = () =>
  (process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/+$/, '');

/**
 * An email to people on the team (not to a candidate, so it is not kept on any candidate's record).
 * Resolves to true when it was handed to the mail provider, false when delivery is not connected or failed.
 */
export async function notify({ to, subject, body }) {
  const recipients = [].concat(to).filter(Boolean);
  if (!mailConfigured() || !recipients.length) return false;
  try {
    await deliver({ to: recipients, subject: String(subject).replace(/[\r\n]+/g, ' ').slice(0, 300), body: String(body) });
    return true;
  } catch (err) {
    console.error('Notification email failed:', err.message);
    return false;
  }
}

/**
 * Send one of the built-in templates (application_received, rejection, interview_invite). `allow`, when given, is
 * shown the finished subject and message and can hold the e-mail back: nothing is sent or recorded, and the answer
 * is { held: true }. It is how an e-mail that would name the client is kept from somebody who applied through a
 * confidential post (see board.js).
 */
export async function sendTemplate(key, { applicationId, to, vars, userId = null, allow = null, reword = null }) {
  const tpl = q.get('SELECT * FROM email_templates WHERE key = ?', key);
  if (!tpl) return null;
  // `reword`, when given, puts the filled-in wording right before it is looked at or sent (see ourClientWording in board.js).
  const finish = (text) => (reword ? reword(renderTemplate(text, vars)) : renderTemplate(text, vars));
  const subject = finish(tpl.subject), body = finish(tpl.body);
  if (allow && !allow(subject, body)) return { held: true };
  return sendMail({ applicationId, to, userId, subject, body });
}
