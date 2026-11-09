import nodemailer from 'nodemailer';
import { q, now, getSetting } from './db.js';

// Delivery is optional. Set SMTP_URL (e.g. smtps://user:pass@smtp.example.com) and MAIL_FROM to send
// real email; without them every message is still recorded against the candidate, marked as not delivered.
const transport = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;

export const mailConfigured = () => Boolean(transport);

export const renderTemplate = (text, vars) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (vars[key] ?? m));

export async function sendMail({ applicationId, to, subject, body, userId = null }) {
  let delivery = 'not_configured';
  if (transport) {
    try {
      const from = process.env.MAIL_FROM || `"${getSetting('agency_name', 'Recruiting')}" <no-reply@localhost>`;
      await transport.sendMail({ from, to, subject, text: body });
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

/** Send one of the built-in templates (application_received, rejection, interview_invite). */
export async function sendTemplate(key, { applicationId, to, vars, userId = null }) {
  const tpl = q.get('SELECT * FROM email_templates WHERE key = ?', key);
  if (!tpl) return null;
  return sendMail({ applicationId, to, userId, subject: renderTemplate(tpl.subject, vars), body: renderTemplate(tpl.body, vars) });
}
