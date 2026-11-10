// What the phone tests share: where each server listens, a place for e-mail to land, and a few ways of speaking to
// the real server that the Oracle's helpers do not have.
//
// Twilio is played by the stand-in in test/twilio-standin/ (see the note at the top of standin.mjs): it sends the
// same signed webhooks Twilio's descriptions say Twilio sends, and follows the instructions the app answers with.
// Twilio itself is never called, so these tests cannot show that a real call behaves this way.
import http from 'node:http';
import { PORTS } from './oracle-helpers.mjs';

// Seven ports, straight after the five the Oracle tests use (so 3615 to 3621 unless ORACLE_TEST_PORT is set).
const BASE = PORTS.anthropic + 1;
export const PHONE_PORTS = { main: BASE, limits: BASE + 1, bare: BASE + 2, twilio: BASE + 3, deepgram: BASE + 4, anthropic: BASE + 5, mail: BASE + 6 };

/** The Book's own number in the tests, and the address Twilio is told to call for it. */
export const BOOK_NUMBER = '+16475550100';

/**
 * Somewhere for e-mail to go: a stand-in for the mail provider's web API (the server is pointed at it with
 * RESEND_API_URL). Every message handed over is kept in `sent` as { from, to, subject, text }.
 */
export async function mailSink(port = PHONE_PORTS.mail) {
  const sent = [];
  const sink = { failures: 0, refused: 0 }; // `failures`: how many of the next messages the provider answers 500 to, taking nothing
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (sink.failures > 0) {
        sink.failures--; sink.refused++;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Internal server error' }));
      }
      try { sent.push(JSON.parse(raw)); } catch { /* not a message */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `mail_${sent.length}` }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return Object.assign(sink, {
    sent, url: `http://127.0.0.1:${port}/emails`,
    env: () => ({ RESEND_API_KEY: 're_test', RESEND_API_URL: `http://127.0.0.1:${port}/emails`, MAIL_FROM: 'The Book <book@agency.example>' }),
    stop: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  });
}

/** PUT with a JSON body, as the signed-in person `who` (a session from oracle-helpers). */
export async function putJson(who, base, pathname, json) {
  const res = await fetch(`${base}/api${pathname}`, { method: 'PUT', headers: { Cookie: who.cookie(), 'Content-Type': 'application/json' }, body: JSON.stringify(json) });
  return { status: res.status, body: await res.json() };
}

/** Somebody rings The Book's number. `digits` is what they key in at each prompt, in turn. Resolves when the call has played out. */
export async function ringIn(twilio, appBase, from, digits) {
  const res = await fetch(`${twilio.baseUrl}/_standin/inbound`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, digits, voiceUrl: `${appBase}/api/phone/twilio/inbound`, statusCallback: `${appBase}/api/phone/twilio/status` }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`The stand-in refused the call: ${JSON.stringify(body)}`);
  await twilio.idle();
  return body.callSid;
}

/** What the stand-in logged since `mark` (an index into its entries), narrowed to one kind of webhook or request. */
export const webhooks = (twilio, mark, what) => twilio.entries.slice(mark).filter((e) => e.kind === 'webhook' && (!what || e.what.startsWith(what)));
export const restCalls = (twilio, mark, pattern) => twilio.entries.slice(mark).filter((e) => e.kind === 'rest' && (!pattern || pattern.test(`${e.method} ${e.path}`)));
/** Things the stand-in says Twilio would have logged as an error or a warning about the app's instructions. */
export const complaints = (twilio, mark) => twilio.entries.slice(mark).filter((e) => (e.kind === 'note' && e.twilioErrorCode) || (e.kind === 'rest' && e.warnings?.length));
