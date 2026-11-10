// Reading a calendar link somebody pasted, from this server, without letting that link be used to reach the server's
// own network. A recruiter pastes any address they like, and the answer can redirect anywhere, so nothing about the
// link is trusted.
//
// What is enforced:
//   - https only (webcal:// is the same thing under another name and is rewritten); no user name or password in the
//     link; the standard port only.
//   - The host name is looked up once and EVERY address it has must be a public one: no loopback, private,
//     link-local (where cloud hosts keep their metadata service), carrier NAT, multicast or documentation ranges,
//     and no IPv4 address hidden inside an IPv6 one. The connection is then made to one of exactly those checked
//     addresses, so a name that answers "public" when checked and "private" a moment later gains nothing.
//   - Redirects are followed by hand, at most five, and each hop goes through all of the above again.
//   - No cookies, no sign-in header, no proxy, a fresh connection every time.
//   - Limits on size (also after decompression) and on time: the whole read, the wait for an answer, silence in
//     the middle, and the name look-up itself.
//   - What comes back has to be a calendar.
//   - No error message or description ever contains the link: the path of a private calendar link is the secret.
//
// Uses only Node's own modules.
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promises as dnsPromises } from 'node:dns';

/** Why a link could not be read. `message` is a plain sentence that is safe to show (it never contains the link); `code` is for the program. */
export class FeedFetchError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'FeedFetchError';
    this.code = code;
    Object.assign(this, extra);
  }
}
/**
 * What is thrown when the calendar's own server answers with anything but the calendar. It carries that server's
 * status (`status`), which is the calendar's, never the status our own answer should have.
 */
export const httpStatusError = (status) => new FeedFetchError('http_status',
  status === 404 || status === 410 ? 'That calendar link no longer works. It may have been reset or switched off: copy the link again from your calendar\'s settings.'
    : status === 401 || status === 403 ? 'Your calendar refused that link. Copy the link again from your calendar\'s settings.'
      : `Your calendar answered with an error (${status}). Try again in a few minutes.`, { status });

// ---------- which addresses may be reached ----------
const blocked = new net.BlockList();
const V4 = [
  ['0.0.0.0', 8, 'this network'], ['10.0.0.0', 8, 'private'], ['100.64.0.0', 10, 'carrier NAT'],
  ['127.0.0.0', 8, 'loopback'], ['169.254.0.0', 16, 'link-local'], ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'], ['192.0.2.0', 24, 'documentation'], ['192.88.99.0', 24, 'relay'],
  ['192.168.0.0', 16, 'private'], ['198.18.0.0', 15, 'benchmarking'], ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'], ['224.0.0.0', 4, 'multicast'], ['240.0.0.0', 4, 'reserved'],
];
const V6 = [
  ['::', 128, 'unspecified'], ['::1', 128, 'loopback'], ['64:ff9b:1::', 48, 'local translation'],
  ['100::', 64, 'discard'], ['2001::', 23, 'reserved'], ['2001:db8::', 32, 'documentation'], ['3fff::', 20, 'documentation'],
  ['2002::', 16, 'tunnel'], ['fc00::', 7, 'private'], ['fe80::', 10, 'link-local'],
  ['fec0::', 10, 'site-local'], ['ff00::', 8, 'multicast'],
];
// Every real public IPv6 address is inside 2000::/3. This is used as an allow list: anything outside it that is not
// named above (leftover reserved space, future allocations) is refused, never assumed to be public.
const publicV6 = new net.BlockList();
publicV6.addSubnet('2000::', 3, 'ipv6');
const reasons = [];
for (const [list, family] of [[V4, 'ipv4'], [V6, 'ipv6']]) {
  for (const [address, prefix, why] of list) {
    blocked.addSubnet(address, prefix, family);
    const one = new net.BlockList();
    one.addSubnet(address, prefix, family);
    reasons.push([one, family, why]);
  }
}

/** An IPv6 address written out as its eight groups of four hex digits, or null when it is not one. */
function expandV6(ip) {
  let s = ip.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (!net.isIPv6(s)) return null;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) s = s.slice(0, v4.index) + ((+v4[1] << 8) | +v4[2]).toString(16) + ':' + ((+v4[3] << 8) | +v4[4]).toString(16);
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
  const groups = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return null;
  return groups.map((g) => g.padStart(4, '0'));
}
/** The IPv4 address hidden inside an IPv6 one, in any of the forms that carry one; null when there is none. */
function embeddedIPv4(ip6) {
  const full = expandV6(ip6);
  if (!full) return null;
  const hex = full.join('');
  const tail = () => [0, 2, 4, 6].map((i) => parseInt(hex.slice(24 + i, 26 + i), 16)).join('.');
  if (hex.startsWith('00000000000000000000ffff')) return tail();          // ::ffff:a.b.c.d
  if (hex.startsWith('0000000000000000ffff0000')) return tail();          // ::ffff:0:a.b.c.d
  if (hex.startsWith('0064ff9b0000000000000000')) return tail();          // 64:ff9b::a.b.c.d
  if (hex.startsWith('000000000000000000000000') && hex !== '0'.repeat(32) && hex !== '0'.repeat(31) + '1') return tail(); // ::a.b.c.d
  return null;
}

/** Null when `ip` is a public address, otherwise a word or two saying what kind of address it is. */
export function blockedReason(ip) {
  const addr = String(ip).replace(/^\[|\]$/g, '').split('%')[0];
  const fam = net.isIP(addr);
  if (fam === 0) return 'not an address';
  if (fam === 6) {
    const inner = embeddedIPv4(addr);
    if (inner) return blockedReason(inner);
  }
  const family = fam === 4 ? 'ipv4' : 'ipv6';
  if (!blocked.check(addr, family)) return fam === 6 && !publicV6.check(addr, 'ipv6') ? 'not public' : null;
  return reasons.find(([list, f]) => f === family && list.check(addr, family))?.[2] ?? 'not public';
}

// ---------- the link ----------
/** Turn what was pasted into a checked https address. Throws FeedFetchError with a sentence for the person. */
export function normalizeFeedUrl(raw, { allowHttpForTests = false, allowedPorts = [443] } = {}) {
  if (typeof raw !== 'string') throw new FeedFetchError('bad_link', 'That is not a link.');
  let s = raw.trim().replace(/^<|>$/g, '');
  if (!s) throw new FeedFetchError('bad_link', 'Paste your calendar link first.');
  if (s.length > 2048) throw new FeedFetchError('bad_link', 'That link is too long to be a calendar link.');
  if (/[\u0000- \u007f]/.test(s)) throw new FeedFetchError('bad_link', 'That link has a space or a line break in it. Copy it again and paste the whole link.');
  s = s.replace(/^webcals?:\/\//i, 'https://');
  let u;
  try { u = new URL(s); } catch { throw new FeedFetchError('bad_link', 'That does not look like a link. It should start with https:// or webcal://.'); }
  if (u.protocol !== 'https:' && !(allowHttpForTests && u.protocol === 'http:')) {
    throw new FeedFetchError('not_https', 'Calendar links must start with https:// or webcal://.');
  }
  if (u.username || u.password) throw new FeedFetchError('bad_link', 'Links with a user name or password in them are not accepted.');
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (allowedPorts && !allowedPorts.includes(port)) throw new FeedFetchError('bad_port', 'That link uses an unusual port, so it was not read.');
  if (!u.hostname) throw new FeedFetchError('bad_link', 'That link has no web address in it.');
  u.hash = '';
  return u;
}

const PROVIDERS = [
  [/(^|\.)calendar\.google\.com$/i, 'google'],
  [/(^|\.)outlook\.office365\.com$|(^|\.)outlook\.office\.com$|(^|\.)outlook\.live\.com$/i, 'outlook'],
  [/(^|\.)icloud\.com$/i, 'icloud'],
];
/** Whose calendar a link is, going by its host: 'google', 'outlook', 'icloud' or 'other'. */
export const providerOf = (url) => PROVIDERS.find(([re]) => re.test(url.hostname))?.[1] ?? 'other';

// ---------- the read ----------
// Looking a name up borrows one of the four helper threads Node shares with file work, and the operating system's
// look-up cannot be cancelled once begun. At most two run at a time, so links pointing at a name server that never
// answers cannot hold up the saving of recordings.
let lookupsRunning = 0;
const lookupQueue = [];
function systemLookup(host) {
  return new Promise((resolve, reject) => {
    const run = () => {
      lookupsRunning++;
      dnsPromises.lookup(host, { all: true, verbatim: true }).then(resolve, reject).finally(() => {
        lookupsRunning--;
        lookupQueue.shift()?.();
      });
    };
    if (lookupsRunning < 2) run(); else lookupQueue.push(run);
  });
}

const DEFAULTS = {
  maxBytes: 10 * 1024 * 1024,   // after decompression
  totalTimeoutMs: 15000,        // the whole read, redirects included
  headerTimeoutMs: 8000,        // connecting and waiting for the answer to begin, per hop
  idleTimeoutMs: 5000,          // silence in the middle of the answer
  maxRedirects: 5,
  allowedPorts: [443],
  userAgent: 'TheBook-Calendar/1.0 (calendar reader)',
  // ----- what follows exists for the tests, which have no real internet to talk to; the server never sets it -----
  lookup: systemLookup,
  addressPolicy: blockedReason,
  allowHttpForTests: false,
  tls: {},
};

/** Every address of a host, each one checked. Throws when the name is unknown, slow, or has any address that is not public. */
async function resolvePublic(hostname, o, deadline) {
  const bare = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');   // "localhost." is the same host as "localhost"
  let addrs;
  if (net.isIP(bare)) addrs = [{ address: bare, family: net.isIP(bare) }];
  else {
    // The look-up gets a time limit of its own: a name server that never answers would otherwise hold the request for ever.
    let timer;
    const limit = Math.max(1, Math.min(o.headerTimeoutMs, deadline - Date.now()));
    const tooSlow = new Promise((_, reject) => { timer = setTimeout(() => reject(new FeedFetchError('timeout', 'Finding the calendar\'s server took too long. Try again in a minute.')), limit); });
    try {
      const looking = Promise.resolve(o.lookup(bare));
      looking.catch(() => {});                                           // a failure that arrives after the time limit is nobody's to handle
      addrs = await Promise.race([looking, tooSlow]);
    } catch (err) {
      if (err instanceof FeedFetchError) throw err;
      throw new FeedFetchError('dns_failed', 'The web address in that link could not be found. Check that the whole link was copied.');
    } finally { clearTimeout(timer); }
    if (!Array.isArray(addrs)) addrs = [addrs];
  }
  if (!addrs.length) throw new FeedFetchError('dns_failed', 'The web address in that link could not be found. Check that the whole link was copied.');
  for (const a of addrs) {
    if (o.addressPolicy(a.address)) throw new FeedFetchError('blocked_address', 'That link points to a private or internal address, so it was not read. Calendar links have to be on the public internet.');
  }
  // All of them passed, so all of them may be tried, IPv4 first: a host whose first address is dead or cannot be
  // reached from here (IPv6 on a machine without it) still opens, as it would in a browser.
  return [...addrs.filter((a) => net.isIP(a.address) === 4), ...addrs.filter((a) => net.isIP(a.address) !== 4)]
    .map((a) => ({ address: a.address, family: net.isIP(a.address) }));
}

/** One request to one checked host. Resolves to { redirect }, { notModified } or { body, etag, lastModified }. */
function oneHop(u, pinned, o, deadline, conditional) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    let done = false, idle, req;
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(idle); clearTimeout(hdr); clearTimeout(total); fn(value); };
    const fail = (code, message, extra) => { req?.destroy(); finish(reject, new FeedFetchError(code, message, extra)); };
    const total = setTimeout(() => fail('timeout', 'Your calendar took too long to answer. Try again in a minute.'), Math.max(1, deadline - Date.now()));
    const hdr = setTimeout(() => fail('timeout', 'Your calendar did not answer in time. Try again in a minute.'), o.headerTimeoutMs);
    const tooLarge = () => fail('too_large', 'That calendar is too large to read (the limit is 10 MB).');
    req = mod.request({
      protocol: u.protocol,
      host,                                                  // the Host header and, over https, the name the certificate must be for
      servername: net.isIP(host) ? undefined : host,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'user-agent': o.userAgent,
        accept: 'text/calendar, text/plain;q=0.5, */*;q=0.1',
        'accept-encoding': 'gzip',
        connection: 'close',
        ...(conditional?.etag ? { 'if-none-match': conditional.etag } : {}),
        ...(conditional?.lastModified ? { 'if-modified-since': conditional.lastModified } : {}),
      },
      agent: false,                                          // a fresh connection, never one left over from another read
      // Connect only to the addresses that were checked, whatever the name answers a moment later.
      // The answer has to be given a tick later, not inside this call. Given at once, a connection that fails at once
      // (an IPv6-only host, on a machine with no IPv6) raises its error before the request has anything listening
      // for it, and an error nobody listens for stops the whole server.
      lookup: (hostname, opts, cb) => setImmediate(() => (opts?.all
        ? cb(null, pinned.map((a) => ({ address: a.address, family: a.family })))
        : cb(null, pinned[0].address, pinned[0].family))),
      ...o.tls,
    }, (res) => {
      clearTimeout(hdr);
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.resume(); req.destroy();
        return finish(resolve, { redirect: res.headers.location || '' });
      }
      if (status === 304 && conditional) { res.resume(); req.destroy(); return finish(resolve, { notModified: true }); }
      if (status !== 200) {
        res.resume();
        req?.destroy();
        return finish(reject, httpStatusError(status));
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > o.maxBytes) return tooLarge();
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc && enc !== 'identity') return fail('bad_encoding', 'Your calendar sent its answer in a form this reader does not accept.');
      const chunks = [];
      let size = 0, wire = 0;
      const bump = () => { clearTimeout(idle); idle = setTimeout(() => fail('timeout', 'Your calendar stopped answering part of the way through. Try again in a minute.'), o.idleTimeoutMs); };
      bump();
      const broken = () => fail('bad_body', 'Your calendar could not be read: the connection broke part of the way through. Try again in a minute.');
      res.on('data', (c) => { wire += c.length; if (wire > o.maxBytes) tooLarge(); });
      stream.on('data', (c) => {
        size += c.length;
        if (size > o.maxBytes) return tooLarge();
        chunks.push(c); bump();
      });
      stream.on('error', broken);
      res.on('error', broken);
      res.on('aborted', broken);
      stream.on('end', () => finish(resolve, { body: Buffer.concat(chunks), etag: res.headers.etag, lastModified: res.headers['last-modified'], bytes: size }));
    });
    req.on('error', (err) => {
      const certificate = /CERT|SSL|TLS|self.signed|altnames/i.test(`${err.code} ${err.message}`);
      finish(reject, new FeedFetchError(certificate ? 'tls_failed' : 'connect_failed', certificate
        ? 'The security certificate of that calendar\'s server could not be checked, so the link was not read.'
        : 'Your calendar\'s server could not be reached. Try again in a minute.'));
    });
    req.end();
  });
}

/**
 * Read a calendar link safely. `conditional` ({ etag, lastModified } from the last read) lets the server answer
 * "not changed". Resolves to { text, etag, lastModified, bytes } or { notModified: true }; throws FeedFetchError.
 */
export async function safeFetchIcs(rawUrl, options = {}, conditional = null) {
  const o = { ...DEFAULTS, ...options };
  const deadline = Date.now() + o.totalTimeoutMs;
  let u = normalizeFeedUrl(rawUrl, o);
  for (let hop = 0; hop <= o.maxRedirects; hop++) {
    if (Date.now() >= deadline) throw new FeedFetchError('timeout', 'Your calendar took too long to answer. Try again in a minute.');
    const pinned = await resolvePublic(u.hostname, o, deadline);
    const r = await oneHop(u, pinned, o, deadline, hop === 0 ? conditional : null);
    if (r.redirect !== undefined) {
      let next;
      try { next = new URL(r.redirect, u); } catch { throw new FeedFetchError('bad_redirect', 'Your calendar sent the reader somewhere that could not be followed.'); }
      u = normalizeFeedUrl(next.href.replace(/^webcals?:/i, 'https:'), o);   // the same rules on every hop
      continue;
    }
    if (r.notModified) return { notModified: true, hops: hop };
    let text = r.body.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (!/^\s*BEGIN:VCALENDAR/i.test(text.slice(0, 200))) {
      throw new FeedFetchError('not_a_calendar', 'That link did not open a calendar. Make sure you copied the iCal (.ics) link from your calendar\'s settings, not the address of the calendar page.');
    }
    return { text, etag: r.etag, lastModified: r.lastModified, bytes: r.bytes, hops: hop };
  }
  throw new FeedFetchError('too_many_redirects', 'That link was passed on too many times without reaching a calendar.');
}

// ---------- keeping what was read for a few minutes ----------
/**
 * A small store of calendars already read, one per owner (a user's number). The link is kept only as a hash, to
 * tell when the owner has saved a different one.
 *   - For `ttlMs` after a read, the same text is handed back without asking the calendar again.
 *   - After that the calendar is asked whether it has changed (ETag / Last-Modified); "no" costs almost nothing.
 *   - If the calendar cannot be reached, the last copy is handed back for up to `staleMs`, marked `stale` with the
 *     reason, unless the link now points somewhere private, which is never served from memory.
 *   - After a read has failed, the calendar is left alone for `retryMs` and the same answer is given meanwhile, so
 *     a calendar that is down is not waited for (up to fifteen seconds) every time its owner looks at their day.
 *     `force` reads it regardless.
 *   - Two requests for the same owner at once share one read.
 *   - It holds at most `maxEntries` calendars and `maxBytes` of text; the ones not asked for longest go first.
 *   - A calendar nobody has read for `staleMs` is dropped, so the calendar of someone who has left does not linger.
 * `forget(owner)` drops an owner's calendar and gives back the version of the text that was held, if any.
 */
export function createFeedCache({ ttlMs = 5 * 60000, staleMs = 6 * 3600000, retryMs = 60000, maxEntries = 200, maxBytes = 64 * 1024 * 1024, fetchOptions = {}, fetcher = safeFetchIcs, now = Date.now } = {}) {
  const store = new Map();
  const inFlight = new Map();
  const failures = new Map();              // owner -> { link, at, error }: the last read that failed
  let bytes = 0;
  const hashOf = (url) => crypto.createHash('sha256').update(String(url)).digest('hex');
  const drop = (owner) => { const had = store.get(owner); if (had) { bytes -= had.size; store.delete(owner); } failures.delete(owner); return had?.version ?? null; };
  function keep(owner, entry) {
    drop(owner);
    store.set(owner, entry);
    bytes += entry.size;
    // Oldest first; the one just read is never the one thrown out.
    for (const key of store.keys()) {
      if (store.size <= maxEntries && bytes <= maxBytes) break;
      if (key !== owner) drop(key);
    }
  }
  const sweep = () => {
    for (const [owner, entry] of store) if (now() - entry.fetchedAt >= staleMs) drop(owner);
    for (const [owner, failure] of failures) if (now() - failure.at >= retryMs) failures.delete(owner);
  };
  setInterval(sweep, 10 * 60000).unref();
  const answer = (entry, extra) => ({ text: entry.text, version: entry.version, fetchedAt: entry.fetchedAt, stale: false, error: null, ...extra });

  async function get(owner, url, { force = false } = {}) {
    const link = hashOf(url);
    let hit = store.get(owner);
    if (hit && hit.link !== link) { drop(owner); hit = undefined; }       // the owner saved a different link
    if (hit && !force && now() - hit.fetchedAt < ttlMs) {
      store.delete(owner); store.set(owner, hit);                          // asked for just now: last in line to be thrown out
      return answer(hit);
    }
    // What to do when the calendar cannot be read: the last copy if there is one that may be served, or the reason.
    const failed = (err) => {
      if (hit && now() - hit.fetchedAt < staleMs && err.code !== 'blocked_address') return answer(hit, { stale: true, error: err });
      throw err;
    };
    const failure = failures.get(owner);
    if (failure && failure.link === link && !force && now() - failure.at < retryMs) return failed(failure.error);
    const flight = `${owner}:${link}`;
    if (inFlight.has(flight)) return inFlight.get(flight);
    const reading = (async () => {
      try {
        const r = await fetcher(url, fetchOptions, hit ? { etag: hit.etag, lastModified: hit.lastModified } : null);
        const entry = r.notModified ? { ...hit, fetchedAt: now() }
          : { link, text: r.text, size: Buffer.byteLength(r.text), version: hashOf(r.text).slice(0, 16), etag: r.etag, lastModified: r.lastModified, fetchedAt: now() };
        keep(owner, entry);
        failures.delete(owner);
        return answer(entry);
      } catch (err) {
        if (failures.size > 5000) failures.clear();
        failures.set(owner, { link, at: now(), error: err });
        return failed(err);
      } finally { inFlight.delete(flight); }
    })();
    inFlight.set(flight, reading);
    return reading;
  }
  return { get, forget: drop, sweep, size: () => store.size, bytes: () => bytes };
}
