// Popup for The Book extension. It reads the profile in the current tab (only when the recruiter opens this popup),
// lets them pick a job and stage, and adds the person to that pipeline in their workspace. It talks only to the
// workspace address the recruiter entered, using the session they are already signed in with there.

const $ = (id) => document.getElementById(id);
const VIEWS = ['loading', 'setup', 'signin', 'form', 'done'];
const show = (name) => VIEWS.forEach((v) => { $(`view-${v}`).hidden = v !== name; });
const setError = (id, message) => { $(id).textContent = message || ''; $(id).hidden = !message; };

let base = '';        // the workspace origin, e.g. https://hiring.youragency.com
let jobs = [];
let known = [];       // where this person already is in the workspace
let lastStages = {};  // remembered stage per job

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(`${base}/api${path}`, { credentials: 'include', ...options });
  } catch {
    throw new Error('Could not reach your workspace. Check your connection and the workspace address.');
  }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) {
    const err = new Error((data && data.error) || `Your workspace answered with an error (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- connecting to a workspace ----------
function parseBase(value) {
  const typed = value.trim();
  // No scheme typed: assume https, except for a workspace running on this computer.
  const url = new URL(/^https?:\/\//i.test(typed) ? typed : `${/^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(typed) ? 'http' : 'https'}://${typed}`);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new Error('The workspace address needs to start with https://');
  return url.origin;
}

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('setup-error', '');
  let origin;
  try {
    origin = parseBase($('base-url').value);
  } catch (err) {
    return setError('setup-error', err.message.includes('https') ? err.message : 'That does not look like a web address.');
  }
  // Saved before asking: Chrome's permission prompt can close this popup, and the address must survive that.
  // When the popup is opened again, start() finds the address and the permission and carries on.
  await chrome.storage.local.set({ base: origin });
  const origins = [`${origin}/*`];
  const granted = (await chrome.permissions.contains({ origins })) || (await chrome.permissions.request({ origins }));
  if (!granted) return setError('setup-error', 'Chrome needs your permission to connect to that address.');
  try {
    const res = await fetch(`${origin}/api/bootstrap`);
    const info = await res.json();
    if (typeof info.needsSetup !== 'boolean') throw new Error('not a workspace');
  } catch {
    return setError('setup-error', 'That address did not answer like a hiring workspace. Check it and try again.');
  }
  start();
});

$('open-settings').addEventListener('click', () => { $('base-url').value = base; show('setup'); });
$('open-workspace').addEventListener('click', () => chrome.tabs.create({ url: base }));
$('retry').addEventListener('click', start);
$('close').addEventListener('click', () => window.close());

// ---------- reading the page ----------
async function readPage() {
  try {
    // ?tabId= lets the popup be opened as an ordinary tab against a chosen tab (used for testing).
    let tabId = Number(new URLSearchParams(location.search).get('tabId')) || null;
    if (!tabId) tabId = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    const [injected] = await chrome.scripting.executeScript({ target: { tabId }, files: ['extract.js'] });
    return (injected && injected.result) || null;
  } catch {
    return null; // pages Chrome does not let extensions read (new tab page, the Web Store, PDFs)
  }
}

// ---------- the form ----------
function fillJobs(preferred) {
  const select = $('f-job');
  select.replaceChildren();
  const byClient = new Map();
  for (const job of jobs) {
    if (!byClient.has(job.client_name)) byClient.set(job.client_name, []);
    byClient.get(job.client_name).push(job);
  }
  for (const [client, list] of byClient) {
    const group = document.createElement('optgroup');
    group.label = client;
    for (const job of list) {
      const option = document.createElement('option');
      option.value = job.id;
      option.textContent = job.status === 'open' ? job.title : `${job.title} (${job.status})`;
      group.append(option);
    }
    select.append(group);
  }
  if (preferred && jobs.some((j) => j.id === preferred)) select.value = preferred;
}

async function loadStages() {
  const jobId = Number($('f-job').value);
  const select = $('f-stage');
  select.replaceChildren();
  markKnown();
  if (!jobId) return;
  try {
    const { stages } = await api(`/jobs/${jobId}`);
    if (Number($('f-job').value) !== jobId) return; // the job was changed while this was loading
    for (const stage of stages.filter((s) => s.kind !== 'hired')) {
      const option = document.createElement('option');
      option.value = stage.id;
      option.textContent = stage.name;
      select.append(option);
    }
    if (lastStages[jobId] && stages.some((s) => s.id === lastStages[jobId])) select.value = lastStages[jobId];
  } catch (err) {
    setError('form-error', err.message);
  }
}

/** Show where this person already is, and stop a duplicate being added to the selected job. */
function markKnown() {
  const box = $('known');
  box.replaceChildren();
  box.hidden = !known.length;
  const jobId = Number($('f-job').value);
  const here = known.find((k) => k.job_id === jobId);
  $('submit').disabled = Boolean(here);
  $('submit').textContent = here ? 'Already in this job' : 'Add to pipeline';
  if (!known.length) return;
  const lead = document.createElement('strong');
  lead.textContent = 'Already in your workspace';
  const list = document.createElement('ul');
  for (const k of known) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = `${k.job_title} · ${k.client_name}`;
    link.addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: `${base}/jobs/${k.job_id}?c=${k.application_id}` }); });
    item.append(link, ` (${k.status === 'active' ? k.stage_name : k.status})`);
    list.append(item);
  }
  box.append(lead, list);
}

async function lookUp() {
  const link = $('f-link').value.trim();
  const email = $('f-email').value.trim();
  if (!link && !email) { known = []; return markKnown(); }
  try {
    known = await api(`/candidates/lookup?${new URLSearchParams({ linkedin: link, email })}`);
  } catch {
    known = [];
  }
  markKnown();
}

$('f-job').addEventListener('change', loadStages);
$('f-link').addEventListener('change', lookUp);
$('f-email').addEventListener('change', lookUp);

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('form-error', '');
  const jobId = Number($('f-job').value);
  const stageId = Number($('f-stage').value) || '';
  const body = new FormData();
  const fields = {
    job_id: jobId, stage_id: stageId, source: $('f-source').value, name: $('f-name').value, email: $('f-email').value,
    linkedin: $('f-link').value, location: $('f-location').value, current_title: $('f-title').value, current_company: $('f-company').value,
    note: $('f-note').value, note_private: 'true',
  };
  for (const [key, value] of Object.entries(fields)) if (String(value).trim()) body.append(key, String(value).trim());
  $('submit').disabled = true;
  try {
    const { id } = await api('/applications', { method: 'POST', body });
    lastStages[jobId] = stageId || undefined;
    await chrome.storage.local.set({ lastJob: jobId, lastStages });
    const job = jobs.find((j) => j.id === jobId);
    $('done-title').textContent = `${$('f-name').value.trim()} added`;
    $('done-text').textContent = `${job.title} · ${job.client_name} · ${$('f-stage').selectedOptions[0]?.textContent || 'Applied'}`;
    $('open-candidate').onclick = () => chrome.tabs.create({ url: `${base}/jobs/${jobId}?c=${id}` });
    show('done');
  } catch (err) {
    if (err.status === 401) return start();
    setError('form-error', err.message);
    $('submit').disabled = false;
  }
});

// ---------- start ----------
async function start() {
  show('loading');
  const saved = await chrome.storage.local.get(['base', 'lastJob', 'lastStages']);
  base = saved.base || '';
  lastStages = saved.lastStages || {};
  $('open-settings').hidden = !base;
  if (!base || !(await chrome.permissions.contains({ origins: [`${base}/*`] }))) {
    $('base-url').value = base;
    return show('setup');
  }

  let me;
  try {
    me = await api('/me');
  } catch (err) {
    $('signin-text').textContent = err.status === 401 || err.status === 403
      ? `Sign in to ${new URL(base).host} in this browser, then come back to this page and open the extension again.`
      : err.message;
    return show('signin');
  }
  $('workspace-name').textContent = me.agencyName || 'The Book';
  if (me.user.role === 'client') {
    $('signin-text').textContent = 'You are signed in with a client account. Only the agency team can add candidates.';
    return show('signin');
  }

  const [allJobs, page] = await Promise.all([api('/jobs').catch(() => []), readPage()]);
  jobs = allJobs.filter((j) => j.status !== 'closed');
  if (!jobs.length) {
    $('signin-text').textContent = 'There are no jobs to add people to yet. Create a job in your workspace first.';
    return show('signin');
  }
  const onLinkedIn = page && /(^|\.)linkedin\.com$/i.test(page.site);
  $('f-name').value = (page && page.name) || '';
  $('f-title').value = (page && page.title) || '';
  $('f-company').value = (page && page.company) || '';
  $('f-location').value = (page && page.location) || '';
  $('f-email').value = (page && page.email) || '';
  $('f-link').value = page && /^https?:/.test(page.url) ? page.url : '';
  $('f-source').value = onLinkedIn ? 'linkedin' : 'agency_sourced';
  fillJobs(saved.lastJob);
  show('form');
  if (!page) setError('form-error', 'This page could not be read, so fill in the details yourself.');
  await Promise.all([loadStages(), lookUp()]);
  if (!$('f-name').value) $('f-name').focus();
}

start();
