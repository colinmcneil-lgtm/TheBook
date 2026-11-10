// Twilio webhook signatures, dependency-free (Node built-ins only).
//
// Written from twilio-node's own implementation: twilio/twilio-node, src/webhooks/webhooks.ts, commit 8cae578
// (v6.3.0, 2026-11-06). The algorithm:
//
//   signature = base64( HMAC-SHA1( authToken, url + k1 + v1 + k2 + v2 ... ) )
//
// where `url` is the full URL Twilio requested (scheme, host, path and query string, exactly as it was given to
// Twilio) and k/v are the POST parameters sorted by name, with no separators. A parameter that appears more than
// once contributes each distinct value once, sorted, each prefixed with the name. A GET request has no POST
// parameters: everything is already in the URL.
//
// JSON webhooks (not used by Voice) carry ?bodySHA256=<hex sha256 of the raw body> in the URL; the signature is
// then over the URL alone and the body is checked against that hash.
import crypto from 'node:crypto';
import { parse as legacyParse, stringify as legacyStringify } from 'node:querystring';

export const SIGNATURE_HEADER = 'X-Twilio-Signature';
// Present only when a Twilio "Webhooks Rule" signs with a SharedKey instead of the Auth Token:
//   X-Twilio-Webhooks-Signature-Settings: key=<sharedKeyId>,algorithm=HMAC_SHA256
export const SIGNATURE_SETTINGS_HEADER = 'X-Twilio-Webhooks-Signature-Settings';

function hashName(algorithm) {
  if (!algorithm || String(algorithm).toUpperCase() === 'HMAC_SHA1') return 'sha1';
  if (String(algorithm).toUpperCase() === 'HMAC_SHA256') return 'sha256';
  return null;
}

/** Reads `algorithm=` from the settings header; missing or empty means HMAC_SHA1 (the Auth Token signature). */
export function signatureAlgorithm(settingsHeader) {
  for (const part of String(settingsHeader || '').split(',')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === 'algorithm' && part.slice(eq + 1).trim()) return part.slice(eq + 1).trim();
  }
  return 'HMAC_SHA1';
}

function paramString(name, value) {
  if (Array.isArray(value)) return [...new Set(value)].sort().map((v) => paramString(name, v)).join('');
  return name + value;
}

/**
 * Produces the signature Twilio would send.
 * @param {string} authToken  the account's Auth Token (or a SharedKey secret)
 * @param {string} url        the full URL, with query string, exactly as Twilio was given it
 * @param {object} params     POST parameters (name -> string, or array of strings for repeated names); {} for GET
 * @param {string} [algorithm] 'HMAC_SHA1' (default) or 'HMAC_SHA256'
 */
export function twilioSignature(authToken, url, params = {}, algorithm) {
  const hash = hashName(algorithm);
  if (!hash) throw new Error(`Unsupported webhook signature algorithm: ${algorithm}`);
  const p = params || {};
  const data = Object.keys(p).sort().reduce((acc, key) => acc + paramString(key, p[key]), url);
  return crypto.createHmac(hash, authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

// Splits a URL without normalising it, so the path and query keep the exact characters Twilio signed.
function splitUrl(url) {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)/i.exec(url);
  if (!m) return null;
  const [prefix, scheme, authority] = m;
  const at = authority.lastIndexOf('@');
  const hostPort = authority.slice(at + 1);
  const colon = hostPort.indexOf(':', hostPort.lastIndexOf(']') + 1); // a colon inside an IPv6 literal is not a port
  return {
    scheme, userInfo: authority.slice(0, at + 1),
    host: colon === -1 ? hostPort : hostPort.slice(0, colon),
    port: colon === -1 ? '' : hostPort.slice(colon),
    rest: url.slice(prefix.length),
  };
}
function addPort(url) {
  const p = splitUrl(url);
  if (!p || p.port) return url;
  return p.scheme + p.userInfo + p.host + (p.scheme.toLowerCase() === 'https://' ? ':443' : ':80') + p.rest;
}
function removePort(url) {
  const p = splitUrl(url);
  return p ? p.scheme + p.userInfo + p.host + p.rest : url;
}
function withLegacyQuerystring(url) {
  const q = url.indexOf('?');
  if (q === -1 || q === url.length - 1) return url;
  return url.slice(0, q) + '?' + legacyStringify(legacyParse(url.slice(q + 1)));
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Checks a form-encoded (or GET) webhook. Tries, in twilio-node's order: the URL without its port, the URL with
 * the standard port added (:443 / :80), then the same two for the URL as normalised by `new URL()`, then those
 * with the query string re-encoded the way Node's legacy querystring module does.
 */
export function validateTwilioSignature(authToken, signatureHeader, url, params = {}, algorithm) {
  const sig = signatureHeader || '';
  if (!hashName(algorithm)) return false;
  const matches = (u) => safeEqual(sig, twilioSignature(authToken, u, params, algorithm));
  if ([removePort(url), addPort(url)].some(matches)) return true;
  let normal;
  try { normal = new URL(url).toString(); } catch { return false; }
  const a = removePort(normal), b = addPort(normal);
  return [a, b, withLegacyQuerystring(a), withLegacyQuerystring(b)].some(matches);
}

/** sha256 hex of the raw body, compared with the bodySHA256 query parameter (JSON webhooks only). */
export function validateBodyHash(rawBody, bodySHA256) {
  const expected = crypto.createHash('sha256').update(Buffer.from(rawBody, 'utf-8')).digest('hex');
  return safeEqual(bodySHA256 || '', expected);
}

/** JSON webhook: signature over the URL alone, plus the body hash carried in the URL. */
export function validateTwilioSignatureWithBody(authToken, signatureHeader, url, rawBody, algorithm) {
  let hash;
  try { hash = new URL(url).searchParams.get('bodySHA256') || ''; } catch { return false; }
  return validateTwilioSignature(authToken, signatureHeader, url, {}, algorithm) && validateBodyHash(rawBody, hash);
}

/**
 * Convenience for an Express-style handler.
 *   publicBase  the address Twilio was given, e.g. process.env.APP_URL ("https://thebook.example.com"), no trailing slash
 *   originalUrl req.originalUrl ("/api/twilio/voice?c=42"): path and query exactly as received
 *   params      req.body parsed by express.urlencoded({ extended: false }) for POST; {} for GET
 *   rawBody     only needed when the URL carries bodySHA256
 *   settingsHeader, sharedKeySecret  only if a Twilio "Webhooks Rule" signs with a SharedKey: the request then
 *               carries X-Twilio-Webhooks-Signature-Settings and the secret is the SharedKey's, not the Auth Token
 */
export function validateWebhook({ authToken, signature, publicBase, originalUrl, params, rawBody, settingsHeader, sharedKeySecret }) {
  const url = String(publicBase).replace(/\/+$/, '') + originalUrl;
  const secret = settingsHeader ? sharedKeySecret : authToken;   // the choice twilio-node's webhook() middleware makes
  if (!secret) return false;
  const algorithm = signatureAlgorithm(settingsHeader);
  if (url.includes('bodySHA256')) return validateTwilioSignatureWithBody(secret, signature, url, rawBody ?? '{}', algorithm);
  return validateTwilioSignature(secret, signature, url, params || {}, algorithm);
}
