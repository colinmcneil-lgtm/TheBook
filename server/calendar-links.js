// Finding the call inside a calendar event: the link to join a video meeting, and any phone numbers.
//
// Everything in an event is text a stranger controls, because anyone can send a recruiter an invitation. So only the
// first 20,000 characters of anything are ever looked at, the patterns below are written so that no input can make
// them slow, and the only links ever handed back are https links to the four meeting services named here: an event
// cannot smuggle any other kind of link into a "Join" button.

/** The most text of any one field that is ever scanned. */
export const MAX_SCAN_CHARS = 20000;
export const clip = (s, max = MAX_SCAN_CHARS) => { const t = s == null ? '' : String(s); return t.length > max ? t.slice(0, max) : t; };

const TAIL = String.raw`[^\s<>"'\\)\]]*`; // the rest of a link, up to a space, a quote or a bracket
const SERVICES = [
  { kind: 'meet', re: new RegExp(String.raw`https://meet\.google\.com/(?:_meet/|lookup/)?[a-z0-9][a-z0-9-]{2,}` + TAIL, 'i') },
  { kind: 'zoom', re: new RegExp(String.raw`https://(?:[a-z0-9-]+\.)*(?:zoom(?:-x)?\.(?:us|com|com\.cn|de)|zoomgov\.com)/(?:j|my|w|s|wc|webinar)/` + TAIL, 'i') },
  { kind: 'teams', re: new RegExp(String.raw`https://(?:(?:gov\.|dod\.)?teams\.microsoft\.(?:com|us)|teams\.live\.com)/(?:l/meetup-join/|meet/)` + TAIL, 'i') },
  { kind: 'webex', re: new RegExp(String.raw`https://(?:[a-z0-9-]+\.)*webex\.com/(?:meet/|join/|[a-z0-9-]+/j\.php\?|wbxmjs/joinservice/|weblink/)` + TAIL, 'i') },
];

/** Mail systems wrap links in a redirect of their own (Outlook Safe Links, Google, Proofpoint). This gives back the link inside. */
export function unwrapUrl(url) {
  try {
    const u = new URL(url);
    if (/\.safelinks\.protection\.outlook\.com$/i.test(u.hostname) && u.searchParams.get('url')) return u.searchParams.get('url');
    if (/^(www\.)?google\.com$/i.test(u.hostname) && u.pathname === '/url' && (u.searchParams.get('q') || u.searchParams.get('url'))) return u.searchParams.get('q') || u.searchParams.get('url');
    if (/^urldefense\.proofpoint\.com$/i.test(u.hostname) && u.searchParams.get('u')) return decodeURIComponent(u.searchParams.get('u').replace(/-/g, '%').replace(/_/g, '/'));
  } catch { /* not a link, or not one of those wrappers */ }
  return url;
}
const cleanUrl = (u) => u.replace(/[.,;:!?]+$/, '').replace(/&amp;/g, '&');

/** Plain text out of a description that may be a web page (Outlook sends one); the targets of links are kept. */
export function toText(s) {
  if (!s) return '';
  let t = clip(s);
  // Inside a tag "[^<>]" is used, never "[^>]": with the second, a long run of "<" makes the pattern read to the
  // end of the text from every one of them, and a single event could keep the server busy for over a minute.
  if (/<\w+[^<>]*>/.test(t)) {
    t = t.replace(/<a\b[^<>]*?href\s*=\s*["']([^"'<>]+)["'][^<>]*>/gi, ' $1 ').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n').replace(/<[^<>]+>/g, ' ');
    t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  }
  return t;
}

/**
 * The link to join the meeting, or null. Looked for where it is most trustworthy first: the line a calendar adds
 * for its own meetings (`conferenceProps`), then the location, the event's own link, and last the description.
 * @returns {{ kind: 'meet'|'zoom'|'teams'|'webex', url: string } | null}
 */
export function findJoinLink(ev) {
  const places = [...(ev.conferenceProps || []), ev.location, ev.url, toText(ev.description)];
  for (const raw of places) {
    if (!raw) continue;
    const text = clip(raw);
    // Wrapped links are unwrapped first, so the patterns see where they really lead.
    const candidates = [...(text.match(/https?:\/\/[^\s<>"']+/gi) || []).map((x) => unwrapUrl(cleanUrl(x))), text];
    for (const candidate of candidates) {
      for (const service of SERVICES) {
        const m = service.re.exec(candidate);
        if (m) return { kind: service.kind, url: cleanUrl(m[0]) };
      }
    }
  }
  return null;
}

// ---------- phone numbers ----------
// Numbers in Canada and the United States in the usual spellings, numbers written with another country's code, and
// tel: links.
const NANP = String.raw`(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\-]?([2-9]\d{2})[\s.\-]?(\d{4})`;
const PHONE_RE = new RegExp(String.raw`(?<![\w+])(?:tel:)?(?:${NANP}|(\+(?!1\b)\d[\d\s.\-]{6,16}\d))(?:\s*(?:[,;]+|x|ext\.?|#)\s*(\d{1,12})#?)?(?![\w])`, 'gi');
// Words that mean the number belongs to the meeting, not to a person.
const DIAL_IN = /(dial[\s-]?in|or dial|one tap|pin\b|passcode|access code|conference id|phone conference|meeting id|toll[\s-]?free|find your local number|join by phone|audio only)/i;
// The block of joining instructions Meet, Teams and Zoom add to a description begins with one of these.
const JOINING_BLOCK = /-::~:~::~|_{20,}|Microsoft Teams (meeting|Need help)|is inviting you to a scheduled Zoom meeting/i;

/** A phone number in the international form ("+14165550142"), or null when it cannot be read as one. Ten digits are taken to be Canada or the United States. */
export function toE164(s) {
  const d = String(s || '').slice(0, 60).replace(/[^\d+]/g, '');
  if (/^\+\d{8,15}$/.test(d)) return d;
  const digits = d.replace(/\D/g, '');
  if (digits.length === 10 && /^[2-9]\d{2}[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && /^1[2-9]\d{2}[2-9]/.test(digits)) return `+${digits}`;
  return null;
}

/**
 * Phone numbers written in an event's location, title or description.
 * `person` is false for a number that sits in the meeting's joining instructions or beside words such as "PIN" or
 * "dial in": those reach a conference bridge and must never be used to work out who the event is with.
 * @returns {{ e164: string, person: boolean }[]}
 */
export function findPhones(ev) {
  const out = [], seen = new Set();
  for (const raw of [ev.location, ev.title, toText(ev.description)]) {
    if (!raw) continue;
    const lines = clip(raw).split(/\r?\n/);
    let inJoiningBlock = false;
    lines.forEach((line, i) => {
      if (JOINING_BLOCK.test(line)) inJoiningBlock = true;
      PHONE_RE.lastIndex = 0;
      let m;
      while ((m = PHONE_RE.exec(line))) {
        const e164 = toE164(m[4] ? m[4] : `${m[1]}${m[2]}${m[3]}`);
        if (!e164 || seen.has(e164)) continue;
        // Ten or eleven digits in a row with nothing between them are more often a meeting number than a phone number.
        if (!/[\s().\-+]/.test(m[0].trim()) && !/tel:/i.test(m[0])) continue;
        const dialIn = inJoiningBlock || DIAL_IN.test(`${lines[i - 1] || ''} ${line}`) || m[5]?.length > 6;
        seen.add(e164);
        out.push({ e164, person: !dialIn });
      }
    });
  }
  return out;
}
