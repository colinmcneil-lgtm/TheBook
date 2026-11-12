// For the messages tests: runs one route of messages.js in this process, against a copy of a test server's database,
// and says how many SQL statements it ran. A server cannot be asked that from outside, and the conversation list is
// asked for every twenty seconds by every open Messages page, so it must not ask the database once more for each row.
//
// Run as: DATA_DIR=<a copy of the data folder> node test/messages-queries.mjs <what> <user id> [<query as JSON>]
//   <what> is "list" (GET /messages/conversations), "about" (GET /messages/about) or "send" (POST a message, with
//   e-mail delivery not connected, for which the answer also gives the conversation's rows afterwards).
// Prints one line of JSON: { statements, answer, members? }.
import { q } from '../server/db.js';
import { registerMessages } from '../server/messages.js';

const [what, userId, extra] = process.argv.slice(2);
const input = extra ? JSON.parse(extra) : {};

// Every route, by method and path, as messages.js hands it over; only the last handler (after agencyOnly) is kept.
const routes = {};
const api = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [method, (path, ...handlers) => { routes[`${method} ${path}`] = handlers.at(-1); }]));
registerMessages(api, { agencyOnly: () => {}, bad: (message, status = 400) => { throw Object.assign(new Error(message), { status }); } });

let statements = 0;
for (const name of ['all', 'get', 'run', 'insert']) {
  const original = q[name];
  q[name] = (...args) => { statements += 1; return original(...args); };
}

const user = q.get('SELECT * FROM users WHERE id = ?', Number(userId));
statements = 0;
let answer;
const res = { json: (value) => { answer = value; } };
const route = { list: 'get /messages/conversations', about: 'get /messages/about', send: 'post /messages/conversations/:id/messages' }[what];
await routes[route]({ user, query: input.query || {}, params: input.params || {}, body: input.body || {} }, res);
const counted = statements;
// An e-mail is handed over after the answer; give it the moment it needs, then read what was noted.
await new Promise((resolve) => setTimeout(resolve, 50));
const members = what === 'send' ? q.all('SELECT user_id, mailed_at, mailed_id FROM conversation_members WHERE conversation_id = ? ORDER BY user_id', Number(input.params.id)) : undefined;
console.log(JSON.stringify({ statements: counted, answer, members }));
