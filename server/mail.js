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

export async function sendMail({ applicationId, to, subject, body, userId = null }) {
  subject = String(subject).replace(/[\r\n]+/g, ' ').slice(0, 300);
  body = String(body);
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
  const id = q.insert(
    'INSERT INTO emails (application_id, to_email, subject, body, sent_by, delivery, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    applicationId, to, subject, body, userId, delivery, now());
  return { id, delivery };
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
export async function sendTemplate(key, { applicationId, to, vars, userId = null, allow = null }) {
  const tpl = q.get('SELECT * FROM email_templates WHERE key = ?', key);
  if (!tpl) return null;
  const subject = renderTemplate(tpl.subject, vars), body = renderTemplate(tpl.body, vars);
  if (allow && !allow(subject, body)) return { held: true };
  return sendMail({ applicationId, to, userId, subject, body });
}
