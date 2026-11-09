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
    if (res.status === 401 && !/^\/(login|me|setup|signup|bootstrap|public)\b/.test(path)) window.dispatchEvent(new Event('auth:expired'));
    const err = new Error(data?.error || 'Something went wrong. Please try again.');
    err.status = res.status;
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
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? null : `https://${s}`;
}
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
export const ENGAGEMENTS = { retainer: 'Monthly retainer', per_hire: 'Fee per hire', hybrid: 'Retainer + fee per hire' };
