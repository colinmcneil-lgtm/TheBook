// API client, formatting helpers and shared labels.

async function request(method, path, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    // A 401 on anything but the sign-in calls means the session ended: tell the app so it shows the sign-in screen.
    if (res.status === 401 && path !== '/me' && !/^\/(login|setup|signup|bootstrap|public|invites\/[a-f0-9]{48})\b/.test(path)) window.dispatchEvent(new Event('auth:expired'));
    const err = new Error(data?.error || 'Something went wrong. Please try again.');
    err.status = res.status;
    err.data = data; // some refusals carry details to act on, such as the records a link is already on
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b = {}) => request('PUT', p, b),
  patch: (p, b = {}) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
};

// Parts of the app that load on first use (the résumé reader, the PDF viewer) live in files whose names change with
// every release, so a tab left open across an update asks for files that are no longer there. The build announces each
// such failed load on the window; counting them lets a screen tell "the app was updated" from "this file is broken".
let missedLoads = 0;
const online = () => typeof navigator === 'undefined' || navigator.onLine !== false; // offline is a connection problem, not an update
if (typeof window !== 'undefined') window.addEventListener('vite:preloadError', () => { if (online()) missedLoads++; });
/** Call before using a part that loads on first use. The function it returns says afterwards whether that part was missing. */
export function watchForUpdate() {
  const before = missedLoads;
  return (err) => missedLoads > before || (online() && /dynamically imported module|module script failed/i.test(String(err?.message)));
}

/** Something small this browser keeps for next time (the client chosen in the sidebar, the last tab used). Null when it has nothing, or may not keep things. */
export const remembered = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
export const remember = (key, value) => { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* storage unavailable */ } };

/** Build a path with query parameters, skipping empty values. */
export function url(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') qs.set(k, v);
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

const DAY = 86400000;
/** Date-only values ("2026-12-01") mean that calendar day wherever you are, so read them as local, not UTC. */
const parseDate = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00`) : new Date(d));
export const todayLocal = () => {
  const x = new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
export const fmtDate = (d, withYear = false) =>
  d ? parseDate(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) }) : '';
export const fmtTime = (d) => new Date(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
export const fmtDateTime = (d) => `${new Date(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${fmtTime(d)}`;
/** The same, with the year when it is not this year: for lists that go back a long way. */
export const fmtWhen = (d) => {
  const date = new Date(d);
  if (date.getFullYear() === new Date().getFullYear()) return fmtDateTime(d);
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${fmtTime(d)}`;
};
export const fmtDay = (d) => {
  const date = new Date(d), today = new Date();
  const diff = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
};
export const daysSince = (d) => Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / DAY));
export function ago(d) {
  const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  const days = Math.floor(mins / 1440);
  if (days < 30) return `${days}d ago`;
  return fmtDate(d, new Date(d).getFullYear() !== new Date().getFullYear());
}
/** A duration since `d`, e.g. "5m", "3h", "42d". */
export function since(d) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
}
/** A safe link target for a URL someone typed: http(s) only, with https:// added to a bare domain. Null otherwise. */
export function extUrl(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  // "example.com:8080" is a host and port, not a scheme.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(javascript|data|vbscript|mailto|tel|file|blob|about):/i.test(s) ? null : `https://${s}`;
}
/** A tap-to-call address for a phone number however it was typed. */
export const telHref = (number) => `tel:${String(number || '').replace(/[^\d+]/g, '')}`;
export const toLocalInput = (d) => {
  const x = new Date(d);
  const pad = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
};
export const money = (amount, currency = 'USD') =>
  amount == null ? '' : new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
export const salaryRange = (min, max, currency) =>
  min && max ? `${money(min, currency)} – ${money(max, currency)}` : min ? `From ${money(min, currency)}` : max ? `Up to ${money(max, currency)}` : '';
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
export const firstName = (name) => String(name || '').split(' ')[0];
export const renderTemplate = (text, vars) => String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => vars[k] ?? m);

export const SOURCES = {
  careers_page: 'Careers page', agency_sourced: 'Agency sourced', referral: 'Referral',
  linkedin: 'LinkedIn', job_board: 'Job board', other: 'Other',
};
/** Somebody who applied on the agency's own job board. It is never chosen by hand, so it is not among the sources above. */
export const BOARD_SOURCE = 'our_website';
/** A source as this person reads it. "Our website" is the agency's; to a client's hiring team it is the agency's website, not theirs. */
export const sourceName = (source, isAgency) => (source === BOARD_SOURCE ? (isAgency ? 'Our website' : 'Agency website') : SOURCES[source] || source);
/** Copy something to the clipboard; where the browser will not, show it to be copied by hand. */
export async function copyText(text, toast, done = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(done); } catch { window.prompt('Copy this', text); }
}
export const WORK_MODES = { onsite: 'On-site', hybrid: 'Hybrid', remote: 'Remote' };
export const EMPLOYMENT = { full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract' };
export const JOB_STATUS = {
  open: { label: 'Open', tone: 'green' }, draft: { label: 'Draft', tone: 'gray' },
  paused: { label: 'Paused', tone: 'amber' }, closed: { label: 'Closed', tone: 'gray' },
};
export const INTERVIEW_KINDS = { phone: 'Phone call', video: 'Video call', onsite: 'On-site', technical: 'Technical' };
export const RECOMMENDATIONS = {
  strong_yes: { label: 'Strong yes', tone: 'green' }, yes: { label: 'Yes', tone: 'green' },
  no: { label: 'No', tone: 'red' }, strong_no: { label: 'Strong no', tone: 'red' },
};
export const REJECT_REASONS = [
  'Not enough relevant experience', 'Skills not a match for this role', 'Salary expectations too far apart',
  'Location or right-to-work mismatch', 'Stronger candidates in process', 'Role closed or on hold', 'Other',
];
/**
 * Is this the name of an interview stage the agency holds itself ("Recruiter screen", "Agency interview")? Such a
 * stage starts with "Interview with the client" unticked on the job form. The server uses the same rule (db.js).
 */
export const agencyStageName = (name) => /recruiter|screen|agency/i.test(String(name || ''));
export const ENGAGEMENTS = { retainer: 'Monthly retainer', per_hire: 'Fee per hire', hybrid: 'Retainer + fee per hire' };

/** Where a candidate's photo is served from, or null when they have none. `tag` changes whenever the photo does. */
export const photoUrl = (candidateId, tag) => (tag ? `/api/candidates/${candidateId}/photo?v=${tag}` : null);

/** Shrink a chosen image to a square JPEG (cropped from the centre) so photos stay small and uniform. */
export async function squarePhoto(file, size = 400) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.min(size, side);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // JPEG has no transparency: without this a cut-out portrait gets a black background
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('That image could not be read.'))), 'image/jpeg', 0.88));
}
