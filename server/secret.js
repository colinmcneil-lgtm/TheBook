// One secret for this server, made the first time it is needed and kept in the data folder beside the database.
// Other keys are worked out from it, one per purpose, so that a value sealed for one use cannot be opened by
// another. It never leaves this file except as those keys, and it is never written to a log.
//
// It lives in a file of its own, not in the database, so that a copy of the database alone (a download, an export)
// is not enough to open what was sealed with it. Back the data folder up as a whole and the two stay together. If the
// file is lost, nothing breaks: whatever was sealed can no longer be opened and has to be entered again.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

const FILE = path.join(DATA_DIR, 'server-secret');
let secret = null;

function serverSecret() {
  if (secret) return secret;
  const read = () => Buffer.from(fs.readFileSync(FILE, 'utf8').trim(), 'hex');
  try {
    // "wx" fails when the file is already there, so two servers started together cannot each write a different one.
    fs.writeFileSync(FILE, `${crypto.randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  secret = read();
  if (secret.length !== 32) throw new Error(`The file ${FILE} is damaged. Remove it and restart; saved calendar links will have to be pasted in again.`);
  return secret;
}

const keys = new Map();
/** A 32-byte key for one purpose ("calendar-link", "calendar-event-key"...). The same purpose always gives the same key. */
export function keyFor(purpose) {
  if (!keys.has(purpose)) keys.set(purpose, Buffer.from(crypto.hkdfSync('sha256', serverSecret(), Buffer.alloc(0), purpose, 32)));
  return keys.get(purpose);
}

/** Seal a short piece of text so that only this server can read it back (AES-256-GCM: a changed value is refused, not misread). */
export function seal(text, purpose) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(purpose), iv);
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

/** Open what `seal` made. Null when it cannot be opened (the secret file was replaced, or the value was changed). */
export function unseal(sealed, purpose) {
  try {
    const [version, iv, tag, body] = String(sealed).split('.');
    if (version !== 'v1') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(purpose), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
