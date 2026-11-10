// What the Metaview tests share: their ports, a way to start the real server pointed at the stand-in for Metaview
// (test/metaview-standin.mjs), and a workspace with the people the stand-in's interviewers are.
//
// The real Metaview is never called by any test: the server is always started with METAVIEW_API_URL set to the
// stand-in. So the tests cannot prove how the real service behaves beyond what was seen when the stand-in was written.
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, session, PORTS as SHARED } from './oracle-helpers.mjs';
import { GOOD_KEY } from './metaview-standin.mjs';

// Ten ports in a row (see oracle-helpers.mjs for who uses which): servers first, then the stand-ins.
export const PORTS = {
  main: SHARED.metaview, restart: SHARED.metaview + 1, auto: SHARED.metaview + 2, legacy: SHARED.metaview + 3, large: SHARED.metaview + 4,
  standIn: SHARED.metaview + 5, standInRestart: SHARED.metaview + 6, standInAuto: SHARED.metaview + 7, standInLarge: SHARED.metaview + 8, anthropic: SHARED.metaview + 9,
};
export { GOOD_KEY };

/**
 * Start the real server reading the stand-in. Everything Metaview-related is made quick: the list is looked at
 * every 300 ms where the real thing waits ten minutes, and notes are asked for again after 60 ms, not 30 seconds.
 */
export const startBook = ({ port, dataDir, standIn, env = {} }) => startServer({
  port, dataDir,
  env: {
    METAVIEW_API_URL: standIn.url, METAVIEW_POLL_MS: '300', METAVIEW_PAGE_PAUSE_MS: '15', METAVIEW_START_MS: '30', METAVIEW_BACKOFF_MS: '80',
    METAVIEW_NOTES_PACE: '0.002', METAVIEW_RETRY_MS: '20', METAVIEW_TIMEOUT_MS: '700', ...env,
  },
});

/**
 * The owner (an admin), two recruiters and a client's hiring manager, one client and two open jobs. The owner and
 * the recruiters have the names and addresses of the stand-in's first three interviewers. `candidate` adds a
 * person to a job and resolves to { application_id, candidate_id }.
 */
export async function workspace(base) {
  const owner = session(base);
  assert.equal((await owner.post('/setup', { agencyName: 'Harbour Talent', name: 'Alex Morgan', email: 'alex@agency.example', password: 'demo1234' })).status, 200);
  const clientId = (await owner.post('/clients', { name: 'Kestrel Logistics', engagement_model: 'per_hire', fee_percent: 20 })).body.id;
  const otherClientId = (await owner.post('/clients', { name: 'Lumen Health', engagement_model: 'per_hire', fee_percent: 20 })).body.id;
  const join = async (role, name, email, extra = {}) => {
    const { token } = (await owner.post('/invites', { role, email, ...extra })).body;
    const person = session(base);
    assert.equal((await person.post(`/invites/${token}/accept`, { name, password: 'demo1234' })).status, 200);
    return person;
  };
  const newJob = async (title, client = clientId) => (await owner.post('/jobs', { client_id: client, title, status: 'open', location: 'Toronto', description: 'A role.' })).body.id;
  const job = await newJob('Head of Sales'), otherJob = await newJob('Sales Manager'), elsewhere = await newJob('Clinic Manager', otherClientId);
  let made = 0;
  /** Add somebody to a job. With no address they are told apart by a profile link, as the form requires. */
  const candidate = async ({ name, email, phone, jobId = job }) => {
    const added = await owner.upload('/applications', { job_id: jobId, name, email, phone, linkedin: email ? undefined : `https://www.linkedin.com/in/invented-person-${++made}` });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const application_id = added.body.id;
    return { application_id, candidate_id: (await owner.get(`/applications/${application_id}`)).body.candidate.id };
  };
  return {
    owner, clientId, otherClientId, job, otherJob, elsewhere, candidate,
    priya: await join('recruiter', 'Priya Nair', 'priya@agency.example'),
    sam: await join('recruiter', 'Sam Okoro', 'sam@agency.example'),
    maya: await join('client', 'Maya Okonkwo', 'maya@kestrel.example', { client_id: clientId }),
  };
}

/** Connect the workspace to the stand-in as the owner, and resolve to the status that comes back. */
export async function connect(owner, key = GOOD_KEY) {
  const answer = await owner.putJson('/metaview/key', { key });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body;
}

/** Read a database the server has open, without changing it: `read` is given all(sql, ...values), which resolves to plain rows. */
export function look(dataDir, read) {
  const db = new DatabaseSync(path.join(dataDir, 'app.db'), { readOnly: true });
  try { return read((sql, ...values) => db.prepare(sql).all(...values).map((row) => ({ ...row }))); } finally { db.close(); }
}
