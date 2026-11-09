import nodemailer from 'nodemailer';
import { q, now, getSetting } from './db.js';

// Delivery is optional. Set SMTP_URL (e.g. smtps://user:pass@smtp.example.com) and MAIL_FROM to send
// real email; without them every message is still recorded against the candidate, marked as not delivered.
const transport = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;

export const mailConfigured = () => Boolean(transport);

export const renderTemplate = (text, vars) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (vars[key] ?? m));

export async function sendMail({ applicationId, to, subject, body, userId = null }) {
  subject = String(subject).replace(/[\r\n]+/g, ' ').slice(0, 300);
  body = String(body);
  let delivery = 'not_configured';
  if (transport) {
    try {
      const from = process.env.MAIL_FROM || `"${getSetting('agency_name', 'Recruiting')}" <no-reply@localhost>`;
      // subject and body are plain strings by the time they get here; the two flags make the mail library refuse to
      // read files or fetch URLs even if something else were ever passed.
      await transport.sendMail({ from, to, subject: String(subject), text: String(body), disableFileAccess: true, disableUrlAccess: true });
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
 * Resolves to true when it was handed to the mail server, false when delivery is not connected or failed.
 */
export async function notify({ to, subject, body }) {
  const recipients = [].concat(to).filter(Boolean);
  if (!transport || !recipients.length) return false;
  try {
    const from = process.env.MAIL_FROM || `"${getSetting('agency_name', 'Recruiting')}" <no-reply@localhost>`;
    await transport.sendMail({ from, to: recipients, subject: String(subject).replace(/[\r\n]+/g, ' ').slice(0, 300), text: String(body), disableFileAccess: true, disableUrlAccess: true });
    return true;
  } catch (err) {
    console.error('Notification email failed:', err.message);
    return false;
  }
}

/** Send one of the built-in templates (application_received, rejection, interview_invite). */
export async function sendTemplate(key, { applicationId, to, vars, userId = null }) {
  const tpl = q.get('SELECT * FROM email_templates WHERE key = ?', key);
  if (!tpl) return null;
  return sendMail({ applicationId, to, userId, subject: renderTemplate(tpl.subject, vars), body: renderTemplate(tpl.body, vars) });
}
