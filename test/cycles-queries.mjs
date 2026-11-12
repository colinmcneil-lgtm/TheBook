// For the cycles tests: runs one route of cycles.js in this process, against a copy of a test server's database,
// and says how many SQL statements it ran and how long it took. A server cannot be asked that from outside, and the
// Cycles page must ask the database a fixed number of times however many jobs there are, not once more for each row.
//
// Run as: DATA_DIR=<a copy of the data folder> node test/cycles-queries.mjs <what> <user id> [<request as JSON>]
//   <what> is "page" (GET /cycles) or "job" (GET /cycles/jobs/:id). The request is { query, params }.
// Prints one line of JSON: { statements, ms, plans, answer }.
import { q } from '../server/db.js';
import { registerCycles } from '../server/cycles.js';

const [what, userId, extra] = process.argv.slice(2);
const input = extra ? JSON.parse(extra) : {};

// Every route, by method and path, as cycles.js hands it over; only the last handler (after agencyOnly) is kept.
const routes = {};
const api = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [method, (path, ...handlers) => { routes[`${method} ${path}`] = handlers.at(-1); }]));
const int = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));
registerCycles(api, { agencyOnly: () => {}, int, bad: (message, status = 400) => { throw Object.assign(new Error(message), { status }); } });

let statements = 0;
const asked = []; // each SELECT run, with its values, for the plans below
const originals = {};
for (const name of ['all', 'get', 'run', 'insert']) {
  const original = (originals[name] = q[name]);
  q[name] = (...args) => { statements += 1; asked.push(args); return original(...args); };
}

const user = q.get('SELECT * FROM users WHERE id = ?', Number(userId));
const route = { page: 'get /cycles', job: 'get /cycles/jobs/:id' }[what];
const ask = () => {
  let answer;
  routes[route]({ user, query: input.query || {}, params: input.params || {} }, { json: (value) => { answer = value; } });
  return answer;
};
ask(); // once to warm up: the first run of any statement is slower while SQLite prepares it
statements = 0;
asked.length = 0;
const started = process.hrtime.bigint();
const answer = ask();
const ms = Number(process.hrtime.bigint() - started) / 1e6;
// How SQLite went about each statement (EXPLAIN QUERY PLAN), so that a test can see an index is used rather than
// trust a time measured on a busy machine.
const plans = asked.filter(([sql]) => /^\s*SELECT/i.test(sql)).map(([sql, ...values]) => originals.all(`EXPLAIN QUERY PLAN ${sql}`, ...values).map((r) => r.detail));
console.log(JSON.stringify({ statements, ms, plans, answer }));
