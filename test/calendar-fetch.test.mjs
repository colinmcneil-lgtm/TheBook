// Attacks on the reader of calendar links (server/calendar-fetch.js). A recruiter pastes any link they like and the
// answer can send the reader anywhere, so the reader must never be talked into reaching this server's own network.
//
// Everything here runs against servers started by the test, on this machine:
//   the "calendar"    plain http on 127.0.0.77 and 127.0.0.79. The test's address rule lets ONLY these (and one
//                     address where nothing listens) count as public; everything else is judged by the real rule.
//   the same in https on 127.0.0.77, with a certificate for the name calendar.test from a throwaway authority.
//   the "internal"    server on 127.0.0.1. It stands for something private. It must never receive a request.
// Name look-ups are answered by the test. Links tried with the reader's real settings (https only, standard port)
// are all refused before any connection is made.
//
// Not covered: a real Google, Outlook or iCloud link; a live IPv6 connection (the machine this was written on has
// no IPv6, so IPv6 cases prove "refused before connecting", or "failed to connect without harm").
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { safeFetchIcs, blockedReason, normalizeFeedUrl, providerOf, createFeedCache, FeedFetchError } from '../server/calendar-fetch.js';
import { CALENDARS, PORTS } from './calendar-helpers.mjs';

const ICS = fs.readFileSync(path.join(CALENDARS, 'google-like.ics'));
// The https "calendar" needs a certificate. It is made fresh for each run with the openssl command, because a private
// key does not belong in the repository, even a throwaway one.
const CERTS = fs.mkdtempSync(path.join(os.tmpdir(), 'thebook-test-certs-'));
const openssl = (...args) => execFileSync('openssl', args, { cwd: CERTS, stdio: 'ignore' });
openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Throwaway test authority for The Book calendar tests');
openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=calendar.test');
fs.writeFileSync(path.join(CERTS, 'san.cnf'), 'subjectAltName=DNS:calendar.test\n');
openssl('x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.pem', '-days', '2', '-extfile', 'san.cnf');
const cert = (name) => fs.readFileSync(path.join(CERTS, name));
process.on('exit', () => fs.rmSync(CERTS, { recursive: true, force: true }));
const SECRET = 'private-0123456789abcdef0123456789abcdef';   // stands for the secret part of a calendar link
const PUB = '127.0.0.77', PUB2 = '127.0.0.79', DEAD = '127.0.0.78';
const P = PORTS.feeds, PT = PORTS.feedsTls, PS = PORTS.internal;

let internalHits = 0, etagHits = 0, down = false, sentOfBig = 0, bomb = null;
const seen = [];                      // every request that reached the "calendar"
const leaks = [];                     // errors whose text contained the secret part of a link
const uncaught = [];                  // errors nobody was listening for; each one would have stopped a real server
const onUncaught = (err) => uncaught.push(err);

const internal = http.createServer((req, res) => { internalHits++; res.end('BEGIN:VCALENDAR\r\nINTERNAL SECRET\r\nEND:VCALENDAR'); });
function handler(req, res) {
  seen.push({ url: req.url, headers: req.headers });
  const p = new URL(req.url, 'http://x').pathname;
  const to = (location, status = 302, extra = {}) => { res.writeHead(status, { location, ...extra }); res.end(); };
  let m;
  if (down) return req.socket.destroy();
  if (p.endsWith('/ok.ics')) { res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' }); return res.end(ICS); }
  if (p === '/gz.ics') { res.writeHead(200, { 'content-type': 'text/calendar', 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync(ICS)); }
  if (p === '/bom.ics') { res.writeHead(200, { 'content-type': 'text/calendar' }); return res.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), ICS])); }
  if (p === '/redirect-ok') return to(`/${SECRET}/ok.ics`, 302, { 'set-cookie': 'session=abc; Path=/' });
  if (p === '/redirect-http-downgrade') return to(`http://feeds.test:${P}/ok.ics`);
  if ((m = /^\/chain\/(\d+)$/.exec(p))) return to(+m[1] > 1 ? `/chain/${+m[1] - 1}` : '/ok.ics');            // /chain/N is exactly N redirects
  if ((m = /^\/hosts\/(\d+)$/.exec(p))) return to(+m[1] > 1 ? `http://${+m[1] % 2 ? 'feeds.test' : 'other.test'}:${P}/hosts/${+m[1] - 1}` : `http://feeds.test:${P}/ok.ics`);
  if (p === '/loop-a') return to('/loop-b');
  if (p === '/loop-b') return to('/loop-a', 301);
  if (p === '/self') return to('/self', 308);
  if (p === '/third-hop-private') return to('/third-hop-private-2');
  if (p === '/third-hop-private-2') return to(`http://intranet.test:${PS}/secret`);
  if (p === '/to-same-name') return to(`http://hopflip.test:${PS}/secret`);
  // Any redirect a test asks for. Sent as raw bytes, as a real server could send them.
  if ((m = /^\/to\/(.+)$/.exec(p))) return to(Buffer.from(decodeURIComponent(m[1]), 'utf8').toString('latin1'));
  if (p === '/big-declared') { res.writeHead(200, { 'content-type': 'text/calendar', 'content-length': 50 * 1024 * 1024 }); return res.write('BEGIN:VCALENDAR\r\n'); }
  if (p === '/big-chunked') {
    res.writeHead(200, { 'content-type': 'text/calendar' });
    const chunk = Buffer.alloc(64 * 1024, 'X');
    let sent = 0;
    res.write('BEGIN:VCALENDAR\r\n');
    const pump = () => { while (sent < 50 * 1024 * 1024) { sent += chunk.length; if (!res.write(chunk)) return res.once('drain', pump); } res.end(); };
    res.on('close', () => { sentOfBig = sent; });
    return pump();
  }
  if (p === '/gzip-bomb') {
    res.writeHead(200, { 'content-type': 'text/calendar', 'content-encoding': 'gzip' });
    return res.end(bomb ??= zlib.gzipSync(Buffer.concat([Buffer.from('BEGIN:VCALENDAR\r\n'), Buffer.alloc(200 * 1024 * 1024, 0x20)])));
  }
  if (p === '/deflate') { res.writeHead(200, { 'content-type': 'text/calendar', 'content-encoding': 'br' }); return res.end(zlib.brotliCompressSync(ICS)); }
  if (p === '/slow-headers') return undefined;                                                       // never answers
  if (p === '/slow-drip') { res.writeHead(200, { 'content-type': 'text/calendar' }); res.write('BEGIN:VCALENDAR\r\n'); const t = setInterval(() => res.write('X'), 300); return res.on('close', () => clearInterval(t)); }
  if (p === '/stall') { res.writeHead(200, { 'content-type': 'text/calendar' }); return res.write('BEGIN:VCALENDAR\r\n'); }   // then silence
  if (p === '/html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!DOCTYPE html><title>Sign in</title>'); }
  if (p === '/gone') { res.writeHead(404); return res.end('nope'); }
  if (p === '/forbidden') { res.writeHead(403); return res.end('no'); }
  if (p === '/broken') { res.writeHead(500); return res.end('oops'); }
  if (p === '/etag.ics') {
    etagHits++;
    if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304, { etag: '"v1"' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/calendar', etag: '"v1"' });
    return res.end(ICS);
  }
  res.writeHead(404);
  return res.end();
}
const pub = http.createServer(handler), pub2 = http.createServer(handler);
const pubTls = https.createServer({ key: cert('srv.key'), cert: cert('srv.pem') }, handler);
const servers = [internal, pub, pub2, pubTls];
const listen = (server, host, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });

// ---------- the test's name look-ups ----------
const zone = {
  'feeds.test': [PUB], 'other.test': [PUB2], 'calendar.test': [DEAD, PUB], 'wrongname.test': [DEAD, PUB], 'starter.test': [PUB],
  'intranet.test': ['10.0.0.5'], 'ten.test': ['10.1.2.3'], 'loop.test': ['127.0.0.1'], 'meta.test': ['169.254.169.254'], 'cgnat.test': ['100.64.1.1'], 'v4unspec.test': ['0.0.0.0'],
  // IPv6 loopback, and an IPv4 address hidden inside an IPv6 one, in every spelling
  'v6loop.test': ['::1'], 'v6loop-long.test': ['0:0:0:0:0:0:0:1'], 'mapped-dotted.test': ['::ffff:127.0.0.1'], 'mapped-hex.test': ['::ffff:7f00:1'], 'mapped-long.test': ['0:0:0:0:0:ffff:7f00:1'],
  'mapped-upper.test': ['::FFFF:127.0.0.1'], 'mapped-private.test': ['::ffff:10.0.0.5'], 'mapped-meta.test': ['::ffff:a9fe:a9fe'], 'compat.test': ['::7f00:1'], 'siit.test': ['::ffff:0:7f00:1'],
  'nat64.test': ['64:ff9b::7f00:1'], 'nat64-meta.test': ['64:ff9b::a9fe:a9fe'], 'sixtofour.test': ['2002:7f00:1::1'], 'teredo.test': ['2001:0:7f00:1::1'], 'scoped.test': ['fe80::1%lo'],
  'unspec.test': ['::'], 'ula.test': ['fd12:3456:789a::1'], 'aws6.test': ['fd00:ec2::254'],
  // a public address and a private one in the same answer, in several orders
  'pub-then-priv.test': [PUB, '127.0.0.1'], 'priv-then-pub.test': ['127.0.0.1', PUB], 'pub4-then-loop6.test': [PUB, '::1'], 'pub-then-mapped.test': [PUB, '::ffff:127.0.0.1'], 'pub-pub-priv.test': [PUB, PUB2, '192.168.0.10'],
  'dead-then-live.test': [DEAD, PUB],
  'garbage.test': ['not-an-ip'], 'empty.test': [],
  // public as far as the rule is concerned, but in the range set aside for documentation, so it leads nowhere
  'v6only.test': ['2001:db8::1'],
};
const lookups = {};
let neverAnswered = null;
const lookup = async (host) => {
  lookups[host] = (lookups[host] || 0) + 1;
  // Public the first time it is asked, private every time after: what a "DNS rebinding" name does.
  if (host === 'flip.test' || host === 'hopflip.test') return [{ address: lookups[host] === 1 ? PUB : '127.0.0.1', family: 4 }];
  if (host === 'never.test') return new Promise((resolve) => { neverAnswered = resolve; });
  if (host === 'slowdns.test') { await new Promise((resolve) => setTimeout(resolve, 2500)); return [{ address: PUB, family: 4 }]; }
  if (!zone[host]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return zone[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
// The real rule, except that the stand-in addresses count as public.
const addressPolicy = (ip) => ([PUB, PUB2, DEAD].includes(ip) ? null : blockedReason(ip));
const T = { lookup, addressPolicy, allowHttpForTests: true, allowedPorts: [P, PT, PS, 443], totalTimeoutMs: 4000, headerTimeoutMs: 1500, idleTimeoutMs: 1200 };
const TLS = { ...T, allowHttpForTests: false, tls: { ca: cert('ca.pem') } };
const base = `http://feeds.test:${P}`;

/** The link must be refused, with one of these reasons, by an error that is safe to show. */
async function refused(url, options, codes, name = url) {
  const want = [].concat(codes);
  await assert.rejects(safeFetchIcs(url, options), (err) => {
    assert.ok(err instanceof FeedFetchError, `${name}: failed with ${err?.name}: ${err?.message}`);
    assert.ok(want.includes(err.code), `${name}: refused as "${err.code}", expected ${want.join(' or ')}`);
    if (`${err.message} ${err.stack} ${JSON.stringify(err)}`.includes(SECRET)) leaks.push(name);
    assert.doesNotMatch(err.message, /\.test\b|example\.com|127\.0\.0|:\d{4}|\/secret|ok\.ics/, `${name}: the sentence names the link or its server`);
    return true;
  }, name);
}
/** The link must be read. */
async function reads(url, options) {
  const r = await safeFetchIcs(url, options);
  assert.match(r.text, /^BEGIN:VCALENDAR/);
  return r;
}

let ready = true;
before(async () => {
  process.on('uncaughtException', onUncaught);
  try {
    await listen(internal, '127.0.0.1', PS);
    await listen(pub, PUB, P);
    await listen(pub2, PUB2, P);
    await listen(pubTls, PUB, PT);
  } catch (err) {
    // 127.0.0.77 is this machine on Linux. Where it is not (macOS, unless it has been added), these tests cannot run.
    if (err.code !== 'EADDRNOTAVAIL') throw err;
    ready = false;
  }
});
after(async () => {
  neverAnswered?.([]);
  for (const server of servers) { server.closeAllConnections?.(); if (server.listening) await new Promise((resolve) => server.close(resolve)); }
  process.off('uncaughtException', onUncaught);
});
const attack = (name, fn) => test(name, async (t) => (ready ? fn(t) : t.skip('this machine cannot listen on 127.0.0.77')));

attack('links that are refused before anything is fetched (the reader\'s real settings)', async () => {
  const P0 = { totalTimeoutMs: 3000, headerTimeoutMs: 2000 };
  for (const [url, code] of [
    ['http://example.com/cal.ics', 'not_https'], ['ftp://example.com/cal.ics', 'not_https'], ['file:///etc/passwd', 'not_https'], ['javascript:alert(1)', 'not_https'], ['data:text/calendar,BEGIN:VCALENDAR', 'not_https'],
    ['https://user:pw@example.com/cal.ics', 'bad_link'], ['https://example.com:8443/cal.ics', 'bad_port'], ['https://example.com:22/', 'bad_port'], ['not a link', 'bad_link'], ['', 'bad_link'],
    [`https://example.com/${'a'.repeat(3000)}`, 'bad_link'], ['https://exa mple.com/cal.ics', 'bad_link'], ['https://example.com/cal.ics\r\nHost: evil', 'bad_link'],
  ]) await refused(url, P0, code);
  await assert.rejects(safeFetchIcs(null), (err) => err instanceof FeedFetchError && err.code === 'bad_link');
  // Private, loopback and link-local addresses, in every spelling of them that a link can carry.
  for (const url of ['https://127.0.0.1/cal.ics', 'https://2130706433/cal.ics', 'https://0x7f.1/cal.ics', 'https://0177.0.0.1/c.ics', 'https://127.1/c.ics', 'https://0x7f000001/c.ics', 'https://017700000001/c.ics',
    'https://①②⑦.⓪.⓪.①/c.ics', 'https://127。0。0。1/c.ics', 'https://0/c.ics', 'https://0.0.0.0/cal.ics', 'https://10.0.0.1/', 'https://172.16.0.1/', 'https://192.168.1.1/cal.ics', 'https://100.64.0.1/',
    'https://169.254.169.254/latest/meta-data/', 'https://[::1]/cal.ics', 'https://[0:0:0:0:0:0:0:1]/c.ics', 'https://[0000:0000:0000:0000:0000:0000:0000:0001]/c.ics', 'https://[::ffff:127.0.0.1]/cal.ics',
    'https://[::ffff:7f00:1]/c.ics', 'https://[0:0:0:0:0:ffff:127.0.0.1]/c.ics', 'https://[::FFFF:7F00:0001]/c.ics', 'https://[::127.0.0.1]/c.ics', 'https://[::ffff:0:127.0.0.1]/c.ics', 'https://[::ffff:a00:1]/cal.ics',
    'https://[64:ff9b::127.0.0.1]/c.ics', 'https://[64:ff9b::a9fe:a9fe]/c.ics', 'https://[64:ff9b:1::7f00:1]/c.ics', 'https://[2002:7f00:1::1]/c.ics', 'https://[2001:0:7f00:1::1]/c.ics', 'https://[::ffff:169.254.169.254]/c.ics',
    'https://[::ffff:10.0.0.1]/c.ics', 'https://[::ffff:192.168.1.1]/c.ics', 'https://[::ffff:0.0.0.0]/c.ics', 'https://[::ffff:100.64.0.1]/c.ics', 'https://[fd00::1]/cal.ics', 'https://[fd00:ec2::254]/c.ics',
    'https://[::]/c.ics', 'https://[fe80::1]/cal.ics', 'https://[fec0::1]/c.ics', 'https://[ff02::1]/c.ics', 'https://[fe80::1%25eth0]/c.ics', 'https://[3fff::1]/c.ics', 'https://[4000::1]/c.ics',
  ]) await refused(url, P0, ['blocked_address', 'bad_link']);
  // "localhost" is looked up for real. Whatever this machine answers, the link is refused.
  for (const url of ['https://localhost/cal.ics', 'webcal://localhost/cal.ics', 'https://localhost./cal.ics', 'https://LOCALHOST/c.ics']) await refused(url, P0, ['blocked_address', 'dns_failed']);
});

attack('what a pasted link is turned into, and whose calendar it is', () => {
  assert.equal(normalizeFeedUrl('webcal://p12-caldav.icloud.com/published/2/abc').href, 'https://p12-caldav.icloud.com/published/2/abc');
  assert.equal(normalizeFeedUrl('WEBCALS://Example.com/x.ics#frag').href, 'https://example.com/x.ics');
  assert.equal(normalizeFeedUrl('  <https://calendar.google.com/calendar/ical/a%40b.ca/private-x/basic.ics>  ').href, 'https://calendar.google.com/calendar/ical/a%40b.ca/private-x/basic.ics');
  const of = (link) => providerOf(normalizeFeedUrl(link));
  assert.equal(of('https://calendar.google.com/calendar/ical/dana%40agency.ca/private-abc/basic.ics'), 'google');
  assert.equal(of('https://outlook.office365.com/owa/calendar/abc@agency.ca/def/calendar.ics'), 'outlook');
  assert.equal(of('https://outlook.live.com/owa/calendar/abc/def/calendar.ics'), 'outlook');
  assert.equal(of('webcal://p12-caldav.icloud.com/published/2/abc'), 'icloud');
  assert.equal(of('https://calendar.google.com.evil.example/x.ics'), 'other');
  assert.equal(of('https://example.com/feed.ics'), 'other');
  // The addresses that count as public, and a few that do not.
  for (const ip of ['8.8.8.8', '142.250.69.78', '2607:f8b0:400b:80f::200e', '2a00:1450:4001::1', '::ffff:8.8.8.8', '64:ff9b::808:808']) assert.equal(blockedReason(ip), null, ip);
  for (const ip of ['127.0.0.1', '10.255.255.255', '172.31.255.255', '192.168.0.1', '169.254.0.1', '100.127.0.1', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.18.0.1', '::1', '::', 'fc00::1', 'fdff::1',
    'fe80::1', 'ff00::1', '2001:db8::1', '2002::1', '100::1', '::ffff:0:10.0.0.1', '1::1', '4000::', 'e000::1', 'not-an-ip', '']) assert.ok(blockedReason(ip), ip);
});

attack('a name that leads to a private address is refused', async () => {
  for (const host of ['ten.test', 'loop.test', 'meta.test', 'cgnat.test', 'v4unspec.test', 'v6loop.test', 'v6loop-long.test', 'mapped-dotted.test', 'mapped-hex.test', 'mapped-long.test', 'mapped-upper.test',
    'mapped-private.test', 'mapped-meta.test', 'compat.test', 'siit.test', 'nat64.test', 'nat64-meta.test', 'sixtofour.test', 'teredo.test', 'scoped.test', 'unspec.test', 'ula.test', 'aws6.test', 'garbage.test',
    // one private address among public ones is enough
    'pub-then-priv.test', 'priv-then-pub.test', 'pub4-then-loop6.test', 'pub-then-mapped.test', 'pub-pub-priv.test']) await refused(`http://${host}:${PS}/secret`, T, 'blocked_address');
  await refused(`http://empty.test:${PS}/secret`, T, 'dns_failed');
  await refused(`http://nosuch.test:${P}/x`, T, 'dns_failed');
});

attack('a name that is public when checked and private a moment later gains nothing', async () => {
  const before = seen.length;
  await reads(`http://flip.test:${P}/${SECRET}/ok.ics`, T);
  assert.equal(lookups['flip.test'], 1, 'the name was looked up once, and the checked address was the one connected to');
  assert.equal(seen.length - before, 1);
  // The same name again, now answering "private": refused, not remembered as safe.
  await refused(`http://flip.test:${PS}/secret`, T, 'blocked_address');
  // A redirect back to a name that was public on the first hop and is private on the second.
  await reads(`http://hopflip.test:${P}/ok.ics`, T);
  await refused(`http://starter.test:${P}/to-same-name`, T, 'blocked_address');
});

attack('every redirect is checked like the link itself', async () => {
  const before = seen.length;
  const r = await reads(`${base}/redirect-ok`, T);
  assert.equal(r.hops, 1);
  const second = seen.at(-1);
  assert.equal(seen.length - before, 2);
  assert.equal(second.headers.cookie, undefined, 'the cookie the first answer set was not sent on');
  assert.equal(second.headers.authorization, undefined);
  for (const location of [`http://127.0.0.1:${PS}/secret`, `http://intranet.test:${PS}/secret`, `http://169.254.169.254:${P}/latest/meta-data/`, `http://[::1]:${PS}/secret`, `http://2130706433:${PS}/secret`,
    `http://[::ffff:127.0.0.1]:${PS}/secret`, `http://[::ffff:7f00:1]:${PS}/secret`, `http://[0:0:0:0:0:ffff:7f00:1]:${PS}/secret`, `http://[::127.0.0.1]:${PS}/secret`, `http:\\\\127.0.0.1:${PS}\\secret`,
    `http://feeds.test@127.0.0.1:${PS}/secret`, `http://127.1:${PS}/secret`, `http://0177.0.0.1:${PS}/secret`, `//127.0.0.1:${PS}/secret`, `http://①②⑦.⓪.⓪.①:${PS}/secret`, 'file:///etc/passwd', 'gopher://127.0.0.1/',
    `http://feeds.test:22/`]) {
    await refused(`${base}/to/${encodeURIComponent(location)}`, T, ['blocked_address', 'bad_link', 'not_https', 'bad_port', 'dns_failed', 'bad_redirect'], `redirect to ${location}`);
  }
  await refused(`${base}/third-hop-private`, T, 'blocked_address');
  // Five redirects are followed and no more, however they are arranged.
  assert.equal((await reads(`${base}/chain/5`, T)).hops, 5);
  for (const tooMany of ['/chain/6', '/chain/10', '/hosts/10', '/loop-a', '/self']) {
    const at = seen.length;
    await refused(`${base}${tooMany}`, T, 'too_many_redirects');
    assert.equal(seen.length - at, 6, `${tooMany}: six requests were made, then it stopped`);
  }
});

attack('size and time limits', async () => {
  let started = Date.now();
  await refused(`${base}/big-declared`, T, 'too_large');                 // 50 MB announced up front
  assert.ok(Date.now() - started < 1000);
  await refused(`${base}/big-chunked`, T, 'too_large');                  // 50 MB sent without saying how much is coming
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(sentOfBig < 20 * 1024 * 1024, `the server got ${Math.round(sentOfBig / 1048576)} MB out before the reader hung up`);
  await refused(`${base}/gzip-bomb`, T, 'too_large');                    // 200 MB of spaces squeezed into 200 kB
  await refused(`${base}/deflate`, T, 'bad_encoding');                   // a compression that was not asked for
  for (const slow of ['/slow-headers', '/slow-drip', '/stall']) {
    started = Date.now();
    await refused(`${base}${slow}`, T, 'timeout');
    assert.ok(Date.now() - started < 6000, `${slow} was given up on in ${Date.now() - started} ms`);
  }
  // The name look-up is inside the time limit too: a name server that is slow, or never answers at all.
  started = Date.now();
  await refused(`http://slowdns.test:${P}/ok.ics`, T, 'timeout');
  assert.ok(Date.now() - started < 2400);
  started = Date.now();
  await refused(`http://never.test:${P}/ok.ics`, T, 'timeout');
  assert.ok(Date.now() - started < 2400);
});

attack('what comes back has to be a calendar', async () => {
  assert.equal((await reads(`${base}/${SECRET}/ok.ics`, T)).bytes, ICS.length);
  assert.equal((await reads(`${base}/gz.ics`, T)).bytes, ICS.length);    // compressed
  assert.match((await reads(`${base}/bom.ics`, T)).text, /^BEGIN/);      // a byte-order mark in front is removed
  await refused(`${base}/html?token=${SECRET}`, T, 'not_a_calendar');    // a sign-in page
  await refused(`${base}/gone?token=${SECRET}`, T, 'http_status');
  await refused(`${base}/forbidden`, T, 'http_status');
  await refused(`${base}/broken`, T, 'http_status');
  down = true;
  await refused(`${base}/ok.ics`, T, ['connect_failed', 'bad_body']);
  down = false;
});

attack('an address that cannot be reached does not stop the read, or the server', async () => {
  // The first address is dead and the second alive, as when a host has an IPv6 address and this machine has no IPv6.
  await reads(`http://dead-then-live.test:${P}/ok.ics`, T);
  // A host with only an IPv6 address. Without IPv6 the connection fails the instant it is tried; that used to raise
  // an error nobody was listening for, which stops a Node server dead. It must be an ordinary refusal.
  await refused(`http://v6only.test:${P}/ok.ics`, { ...T, addressPolicy: (ip) => (ip === '2001:db8::1' ? null : addressPolicy(ip)), totalTimeoutMs: 2500, headerTimeoutMs: 1500 }, ['connect_failed', 'timeout']);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(uncaught, []);
});

attack('https: the certificate is checked against the name, though the address was chosen for it', async () => {
  // Two addresses for the name, the first one dead.
  await reads(`https://calendar.test:${PT}/${SECRET}/ok.ics`, TLS);
  await refused(`https://wrongname.test:${PT}/ok.ics`, TLS, 'tls_failed');                    // the certificate is for another name
  await refused(`https://calendar.test:${PT}/ok.ics`, { ...TLS, tls: {} }, 'tls_failed');     // an authority nobody trusts
  await refused(`https://calendar.test:${PT}/redirect-http-downgrade`, TLS, 'not_https');     // https that redirects down to http
});

attack('what was read is kept for a few minutes, asked about after that, and bounded', async () => {
  let clock = 1000000;
  const cache = createFeedCache({ ttlMs: 5 * 60000, fetchOptions: T, now: () => clock });
  const url = `${base}/etag.ics`;
  const first = await cache.get(7, url), again = await cache.get(7, url);
  assert.equal(etagHits, 1, 'two reads inside five minutes made one request');
  assert.equal(again.text, first.text);
  assert.match(first.version, /^[0-9a-f]{16}$/);
  // After six minutes the calendar is asked whether it changed. It says no, and the same text is used.
  clock += 6 * 60000;
  const later = await cache.get(7, url);
  assert.equal(etagHits, 2);
  assert.deepEqual([later.text === first.text, later.version, later.stale], [true, first.version, false]);
  // Two people asking at the same moment each make their own read; the same person asking twice shares one.
  clock += 6 * 60000;
  await Promise.all([cache.get(7, url), cache.get(7, url)]);
  assert.equal(etagHits, 3);
  // The calendar cannot be reached: the last copy is handed back, marked as old, with the reason.
  down = true; clock += 6 * 60000;
  let asked = seen.length;
  const stale = await cache.get(7, url);
  assert.deepEqual([stale.stale, stale.error instanceof FeedFetchError, stale.text === first.text, seen.length - asked], [true, true, true, 1]);
  // For the next minute the calendar is left alone and the same answer is given, unless a fresh read is asked for.
  clock += 30000; asked = seen.length;
  assert.deepEqual([(await cache.get(7, url)).stale, seen.length - asked], [true, 0]);
  assert.deepEqual([(await cache.get(7, url, { force: true })).stale, seen.length - asked], [true, 1]);
  clock += 61000;
  assert.deepEqual([(await cache.get(7, url)).stale, seen.length - asked], [true, 2]);
  // The same goes for a calendar that has never been read: the refusal is repeated, not the attempt.
  asked = seen.length;
  for (let i = 0; i < 3; i++) await assert.rejects(cache.get(9, `${base}/ok.ics`), FeedFetchError);
  assert.equal(seen.length - asked, 1);
  // ...but not for ever.
  clock += 7 * 3600000;
  await assert.rejects(cache.get(7, url), FeedFetchError);
  down = false;
  // A different link for the same person replaces the old one; forgetting drops it.
  await cache.get(7, `${base}/ok.ics`);
  assert.equal(cache.size(), 1);
  assert.match(cache.forget(7), /^[0-9a-f]{16}$/);                       // forgetting says which text was held
  assert.deepEqual([cache.size(), cache.bytes(), cache.forget(7)], [0, 0, null]);
  // A calendar nobody has read for six hours is dropped by itself.
  await cache.get(8, `${base}/ok.ics`);
  clock += 5 * 3600000; cache.sweep();
  assert.equal(cache.size(), 1);
  clock += 2 * 3600000; cache.sweep();
  assert.equal(cache.size(), 0);

  // A kept calendar whose name later turns private is refused, and the old copy is NOT served in its place.
  let flipped = false;
  const turning = createFeedCache({ fetchOptions: { ...T, lookup: async (host) => (host === 'cacheflip.test' ? [{ address: flipped ? '127.0.0.1' : PUB, family: 4 }] : lookup(host)) }, now: () => clock });
  await turning.get(1, `http://cacheflip.test:${P}/ok.ics`);
  flipped = true; clock += 6 * 60000;
  await assert.rejects(turning.get(1, `http://cacheflip.test:${P}/ok.ics`), (err) => err.code === 'blocked_address');

  // The store is capped by number and by size; the calendars not asked for longest go first.
  const text = `BEGIN:VCALENDAR\r\n${'X'.repeat(1000)}`;
  const small = createFeedCache({ maxEntries: 3, maxBytes: 2500, fetcher: async () => ({ text }) });
  for (const owner of [1, 2, 3, 4]) await small.get(owner, `https://example.com/${owner}.ics`);
  assert.equal(small.size(), 2, 'two calendars of about 1 kB fit under 2,500 bytes');
  assert.ok(small.bytes() <= 2500);
  const big = createFeedCache({ maxEntries: 3, fetcher: async () => ({ text }) });
  for (const owner of [1, 2, 3]) await big.get(owner, `https://example.com/${owner}.ics`);
  await big.get(1, 'https://example.com/1.ics');                         // person 1 asked again, so person 2 is now the oldest
  await big.get(4, 'https://example.com/4.ics');
  let fetched = 0;
  const counting = createFeedCache({ maxEntries: 3, fetcher: async () => { fetched++; return { text }; } });
  assert.equal(big.size(), 3);
  await counting.get(1, 'https://example.com/1.ics'); await counting.get(1, 'https://example.com/1.ics');
  assert.equal(fetched, 1);
});

attack('nothing reached the internal server, and no error gave a link away', () => {
  assert.equal(internalHits, 0, 'the internal server must never receive a request');
  assert.deepEqual(leaks, []);
  assert.deepEqual(uncaught, []);
});
