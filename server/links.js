// How web addresses typed into the workspace are stored, and when a profile link identifies a person.
// Kept free of imports so the database migrations can use the same rule as the API.

const MAX_LINK = 300;
const tidy = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim() : '');

/** Typed text as an http(s) address, or null when it is not one. A bare domain gets https:// in front. */
function parse(value) {
  const s = tidy(value);
  if (!s || s.length > 4000) return null;
  // "example.com:8080/x" is a host and port, not a scheme; only "scheme://" and the well-known non-web schemes count as one.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(javascript|data|vbscript|mailto|tel|file|blob|about):/i.test(s);
  try {
    const u = new URL(hasScheme ? s : `https://${s}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch { return null; }
}
const asTyped = (u) => (u.pathname === '/' && !u.search && !u.hash ? u.origin : u.href); // no stray trailing slash on a bare site address

/** Any web address (a company site, a privacy notice): http(s) only, otherwise null. */
export function webUrl(value) {
  const u = parse(value);
  return u ? asTyped(u) : null;
}

/**
 * A LinkedIn member profile, however its address was copied (country subdomain, capitals, tracking text, a sub-page
 * of the profile), becomes https://www.linkedin.com/in/<slug>. The old /pub/ form carries the member's id in its
 * later segments, so it is kept whole. Every other address is stored as typed.
 */
function stored(u) {
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return asTyped(u);
  const member = /^\/in\/([^/]+)/i.exec(u.pathname);
  if (member) {
    let slug = member[1];
    try { slug = decodeURIComponent(slug); } catch { /* keep the text as it came */ }
    slug = slug.toLowerCase();
    if ([...slug].length >= 3) return `https://www.linkedin.com/in/${encodeURIComponent(slug)}`;
  }
  if (/^\/pub\/[^/]/i.test(u.pathname)) return `https://www.linkedin.com${u.pathname.toLowerCase().replace(/\/+$/, '')}`;
  return asTyped(u);
}

/**
 * Read a profile link from a form. `url` is what to store (null when nothing usable was typed); `problem` says why
 * something that was typed cannot be stored: 'invalid' (not a web address) or 'too_long'. A long address is never
 * cut short, because half a link opens nothing: its tracking text goes first, and if that is not enough it is refused.
 */
export function checkLink(value) {
  const typed = tidy(value);
  if (!typed) return { url: null, problem: null };
  const u = parse(typed);
  if (!u) return { url: null, problem: typed.length > 4000 ? 'too_long' : 'invalid' };
  let url = stored(u);
  if (url.length > MAX_LINK) {
    u.search = '';
    u.hash = '';
    url = stored(u);
  }
  return url.length > MAX_LINK ? { url: null, problem: 'too_long' } : { url, problem: null };
}

/** A profile link in the form it is stored in, or null when it cannot be stored. */
export const profileUrl = (value) => checkLink(value).url;

const MEMBER_PROFILE = /^https:\/\/www\.linkedin\.com\/in\/[^/?#]{3,}$/;
/**
 * The key two records must share to be treated as the same person: the canonical link of a LinkedIn member profile.
 * Null for everything else. A personal site, a GitHub page, a company's team page or a Recruiter search result can
 * be shared by many people, so those links are kept for reference and never used to match anyone.
 */
export function identityKey(storedUrl) {
  const url = profileUrl(storedUrl);
  return url && MEMBER_PROFILE.test(url) ? url : null;
}
