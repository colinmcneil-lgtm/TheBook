// Popup for The Book extension. It reads the profile in the current tab (only when the recruiter opens this popup),
// and saves the person to their workspace: into a job's pipeline at a chosen stage, or just to The Book with no job
// yet. It talks only to the workspace address the recruiter entered, using the session they are already signed in with there.
// Anything that comes from the page or the workspace is put on screen as plain text (value / textContent), never as markup.

const $ = (id) => document.getElementById(id);
const VIEWS = ['loading', 'setup', 'signin', 'form', 'done'];
const show = (name) => VIEWS.forEach((v) => { $(`view-${v}`).hidden = v !== name; });
const setError = (id, message) => { $(id).textContent = message || ''; $(id).hidden = !message; };
const LINK_MAX = 300; // the longest link the workspace stores

let base = '';        // the workspace origin, e.g. https://hiring.youragency.com
let jobs = [];
let known = [];       // where this person already is in the workspace
let lastStages = {};  // remembered stage per job
const BOOK = 'book';  // the Job choice that means "no job yet: just add to The Book"
const toBook = () => $('f-job').value === BOOK;
let photo = null;     // the person's picture, ready to send: { blob, preview }
let photoFrom = null; // where it can be fetched from: { url, tabId }

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
    err.data = data;
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

/** Does this address answer like a hiring workspace? Returns the agency's name when it does. */
async function checkWorkspace(origin) {
  let res;
  try {
    res = await fetch(`${origin}/api/bootstrap`);
  } catch {
    return { ok: false, message: 'Could not reach that address. Check it and your connection, then try again.' };
  }
  try {
    const info = await res.json();
    if (typeof info.needsSetup !== 'boolean') throw new Error('not a workspace');
    return { ok: true, name: typeof info.agencyName === 'string' ? info.agencyName.trim() : '' };
  } catch {
    return { ok: false, message: 'That address did not answer like a hiring workspace. Check it and try again.' };
  }
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
  // When the popup is opened again, start() finds the address and the permission, checks the address and carries on.
  const previous = base;
  const changes = [chrome.storage.local.set({ base: origin })];
  if (origin !== previous) {
    // Another workspace has its own jobs and stages, and has to be checked before it is used.
    changes.push(chrome.storage.local.remove(['verified', 'lastJob', 'lastStages']));
    // The old address no longer needs to be reachable, so the permission for it is given back.
    if (previous) changes.push(chrome.permissions.remove({ origins: [`${previous}/*`] }).catch(() => {}));
  }
  await Promise.all(changes);
  const origins = [`${origin}/*`];
  const granted = (await chrome.permissions.contains({ origins })) || (await chrome.permissions.request({ origins }));
  if (!granted) { base = origin; return setError('setup-error', 'Chrome needs your permission to connect to that address.'); }
  start();
});

$('open-settings').addEventListener('click', () => { $('base-url').value = base; setError('setup-error', ''); $('connected').hidden = true; show('setup'); });
$('open-workspace').addEventListener('click', () => chrome.tabs.create({ url: base }));
$('retry').addEventListener('click', start);
$('close').addEventListener('click', () => window.close());

// ---------- reading the page ----------
const READ = ['name', 'title', 'company', 'location', 'email', 'phone'];

async function readPage() {
  // ?tabId= lets the popup be opened as an ordinary tab against a chosen tab (used for testing).
  let tabId = Number(new URLSearchParams(location.search).get('tabId')) || null;
  let frames;
  try {
    if (!tabId) tabId = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    // Every frame is read, because LinkedIn sometimes draws the profile inside a frame of its own. Frames from other
    // sites (adverts, embedded players) are not covered by the click that opened this popup, and the reader ignores them.
    frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['extract.js'] });
  } catch {
    try {
      frames = await chrome.scripting.executeScript({ target: { tabId }, files: ['extract.js'] });
    } catch {
      return null; // pages Chrome does not let extensions read (new tab page, the Web Store, PDFs)
    }
  }
  const read = frames.filter((f) => f && f.result && typeof f.result === 'object').sort((a, b) => a.frameId - b.frameId);
  const top = read.find((f) => f.frameId === 0)?.result;
  if (!top) return null;
  // The frame that holds the profile is the one where most was found; the tab itself wins a tie.
  const filled = (r) => READ.filter((k) => r[k]).length;
  const best = read.map((f) => f.result).reduce((a, b) => (filled(b) > filled(a) ? b : a), top);
  const page = { ...top };
  for (const k of READ) page[k] = [best, ...read.map((f) => f.result)].map((r) => r[k]).find((v) => typeof v === 'string' && v) || '';
  // The photo comes only from the frame the profile was read from: a picture in another frame (a chat box, say) is somebody else.
  page.photo = typeof best.photo === 'string' ? best.photo : '';
  page.tabId = tabId;
  return page;
}

// ---------- their photo ----------
// The page only gives the picture's address. The picture is fetched here, cropped to a small square and sent with the
// candidate, so the workspace keeps its own copy and never loads anything from LinkedIn later.
const PHOTO_SIZE = 320;
const MAX_PICTURE = 6 * 1024 * 1024;

/**
 * { blob } when the picture was fetched and can be used. Otherwise { reached }: true when the picture's site did
 * answer (the picture is missing, is not an image or is too large), false when Chrome would not let it be read.
 */
async function fetchPicture({ url, tabId }) {
  const usable = (blob) => blob && blob.type.startsWith('image/') && blob.size <= MAX_PICTURE;
  // From here: works when the picture's site lets anyone read it, or once Chrome has been allowed to reach that site.
  try {
    const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    const blob = res.ok ? await res.blob() : null;
    return usable(blob) ? { blob } : { reached: true };
  } catch { /* try from the page instead */ }
  // From the page the recruiter is on, which the picture's site may allow when it does not allow everyone.
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [url, MAX_PICTURE],
      func: async (address, max) => {
        try {
          const res = await fetch(address, { credentials: 'omit' });
          const blob = res.ok ? await res.blob() : null;
          if (!blob || !blob.type.startsWith('image/') || blob.size > max) return 'unusable';
          return await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => resolve('');
            reader.readAsDataURL(blob);
          });
        } catch { return ''; }
      },
    });
    const data = frame && frame.result;
    if (data === 'unusable') return { reached: true };
    if (typeof data === 'string' && data.startsWith('data:image/')) {
      const blob = await (await fetch(data)).blob();
      return usable(blob) ? { blob } : { reached: true };
    }
  } catch { /* the page could not be asked */ }
  return { reached: false };
}

/** A square JPEG cut from the middle of the picture. */
async function squarePicture(blob) {
  const image = await createImageBitmap(blob);
  const side = Math.min(image.width, image.height);
  if (side < 40) throw new Error('too small to be a photo');
  const size = Math.min(PHOTO_SIZE, side);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, size, size);
  image.close?.();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
}

async function loadPhoto() {
  if (photo) URL.revokeObjectURL(photo.preview);
  photo = null;
  const row = $('photo-row');
  row.hidden = true;
  $('allow-photo').hidden = true;
  if (!photoFrom) return;
  let blob = null, reached = false;
  try {
    const fetched = await fetchPicture(photoFrom);
    reached = Boolean(fetched.blob || fetched.reached);
    if (fetched.blob) blob = await squarePicture(fetched.blob);
  } catch { blob = null; }
  if (blob) {
    photo = { blob, preview: URL.createObjectURL(blob) };
    $('photo-preview').src = photo.preview;
    $('photo-preview').hidden = false;
    $('photo-choice').hidden = false;
    $('photo-blocked').hidden = true;
    row.hidden = false;
    return;
  }
  // The picture was read and is not a usable photo (missing, tiny, not an image): permission would change nothing.
  if (reached) return;
  // Chrome would not hand the picture over. It will once the recruiter allows the site the picture is kept on.
  let origin = '';
  try { origin = new URL(photoFrom.url).origin; } catch { return; }
  if (await chrome.permissions.contains({ origins: [`${origin}/*`] }).catch(() => true)) return; // allowed already: the picture itself is the problem
  $('photo-preview').hidden = true;
  $('photo-choice').hidden = true;
  $('photo-blocked').hidden = false;
  $('allow-photo').hidden = false;
  $('allow-photo').onclick = async () => {
    // Chrome's prompt can close this popup; opening it again picks the photo up.
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
    if (granted) loadPhoto();
  };
  row.hidden = false;
}

$('f-photo').addEventListener('change', () => chrome.storage.local.set({ savePhoto: $('f-photo').checked }));

// ---------- the form ----------
function fillJobs(preferred) {
  const select = $('f-job');
  select.replaceChildren();
  // First, and so the choice a new install starts on: save the person without deciding which job they are for.
  const book = document.createElement('option');
  book.value = BOOK;
  book.textContent = 'No job yet: just add to The Book';
  select.append(book);
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
  else select.value = BOOK;
}

async function loadStages() {
  const jobId = Number($('f-job').value);
  const select = $('f-stage');
  select.replaceChildren();
  // Someone saved without a job has no stage to be at, so the field goes away and Source takes the whole row.
  $('stage-field').hidden = toBook();
  $('stage-row').classList.toggle('single', toBook());
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

/** Two spellings of one person's name: the same first and last name, or one name inside the other. Case and accents are ignored. */
function sameName(a, b) {
  const words = (s) => String(s || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const x = words(a), y = words(b);
  if (!x.length || !y.length) return true; // nothing to compare yet
  const one = x.join(' '), other = y.join(' ');
  return one.includes(other) || other.includes(one) || (x[0] === y[0] && x.at(-1) === y.at(-1));
}

/** Where a person's profile opens in the workspace: inside their job, or on the Candidates page when they are not on one. */
const profileUrl = (jobId, applicationId) => (jobId ? `${base}/jobs/${Number(jobId)}?c=${Number(applicationId)}` : `${base}/candidates?c=${Number(applicationId)}`);

/** A notice: one sentence, then the records it is about as links that open in the workspace. */
function fillNotice(box, lead, records) {
  const strong = document.createElement('strong');
  strong.textContent = lead;
  const list = document.createElement('ul');
  const named = new Set(records.map((r) => r.name)).size > 1; // say who each record is when it is not all one person
  for (const r of records) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = '#';
    // Someone in The Book without a job has no job or client to name, and their profile opens from the Candidates page.
    const where = r.job_id ? [r.job_title, r.client_name] : [records.length === 1 && !named ? 'Open their profile' : 'In The Book, not on a job yet'];
    link.textContent = [named && r.name, ...where].filter(Boolean).join(' · ');
    link.addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: profileUrl(r.job_id, r.application_id) }); });
    const stage = !r.job_id ? '' : r.status && r.status !== 'active' ? r.status : r.stage_name;
    item.append(link, stage ? ` (${stage})` : '');
    list.append(item);
  }
  box.replaceChildren(strong, ...(records.length ? [list] : []));
  box.hidden = false;
}

/**
 * Show where this person already is, and stop them being added twice: to the selected job, or to The Book when they
 * are in it already. Someone who is in The Book without a job can still be added to a job from here.
 */
function markKnown() {
  const box = $('known');
  box.replaceChildren();
  box.hidden = true;
  const book = toBook();
  const jobId = Number($('f-job').value);
  const names = [...new Set(known.map((k) => k.name).filter(Boolean))];
  const who = names.length === 1 ? names[0] : '';
  // The email address or link belongs to somebody with another name: adding would go onto that person's record.
  const someoneElse = Boolean(who) && !sameName(who, $('f-name').value);
  const noJobYet = known.length > 0 && known.every((k) => !k.job_id); // in The Book, but not on any job
  // "Just add to The Book" has nothing to add for a person who is in it already, with a job or without one. A
  // record under another name is not this person: that is left to the workspace to answer, as it is for a job.
  const here = book ? !someoneElse && (known.find((k) => !k.job_id) || known[0]) : known.find((k) => k.job_id === jobId);
  $('submit').disabled = Boolean(here);
  $('submit').textContent = book ? (here ? 'Already in The Book' : 'Add to The Book') : here ? 'Already in this job' : 'Add to pipeline';
  if (!known.length) return;
  let lead = 'Already in your workspace';
  if (someoneElse) {
    lead = `This email address or profile link is on ${who}'s record. Check it before you add this person.`;
  } else if (who && book) {
    // With no job in the workspace there is nothing below to choose.
    lead = `${who} is already in The Book${noJobYet ? ', not on a job yet' : ''}.${jobs.length ? ' To add them to a job, choose the job below.' : ''}`;
  } else if (who) {
    lead = here ? `${who} is already in this job.`
      : noJobYet ? `${who} is already in The Book, not on a job yet. This adds them to the job you chose.`
      : `${who} is already in your workspace; this adds them to another job.`;
  }
  fillNotice(box, lead, known);
}

/** A link is never cut short to fit: the part after "?" goes first, and one that is still too long is refused. */
function tidyLink(value) {
  const typed = value.trim();
  if (typed.length <= LINK_MAX) return typed;
  const short = typed.replace(/[?#].*$/, '');
  if (short.length > LINK_MAX) throw new Error('That link is too long. Paste the person\'s public profile link instead.');
  return short;
}

async function lookUp() {
  let link = '';
  try { link = tidyLink($('f-link').value); } catch { /* said when the form is sent */ }
  const email = $('f-email').value.trim();
  if (!link && !email) { known = []; return markKnown(); }
  try {
    const found = await api(`/candidates/lookup?${new URLSearchParams({ linkedin: link, email })}`);
    known = Array.isArray(found) ? found : [];
  } catch {
    known = [];
  }
  markKnown();
}

const clearConflict = () => { $('conflict').hidden = true; $('conflict').replaceChildren(); };
$('f-job').addEventListener('change', () => { clearConflict(); loadStages(); });
$('f-link').addEventListener('change', () => { clearConflict(); lookUp(); });
$('f-email').addEventListener('change', () => { clearConflict(); lookUp(); });
$('f-name').addEventListener('change', () => { clearConflict(); markKnown(); });

/**
 * Send the form. One request does it all: for somebody who is in The Book without a job and is now given one, the
 * workspace puts the entry they have on the job (with its notes, résumé, calls and history) and adds what was typed
 * here to it, or refuses and changes nothing.
 */
async function send() {
  setError('form-error', '');
  clearConflict();
  const book = toBook();
  const jobId = book ? '' : Number($('f-job').value);
  const stageId = book ? '' : Number($('f-stage').value) || '';
  let link;
  try { link = tidyLink($('f-link').value); } catch (err) { return setError('form-error', err.message); }
  const body = new FormData();
  // With no job sent, the workspace saves the person to The Book without one.
  const fields = {
    job_id: jobId, stage_id: stageId, source: $('f-source').value, name: $('f-name').value, email: $('f-email').value,
    linkedin: link, location: $('f-location').value, current_title: $('f-title').value, current_company: $('f-company').value,
    note: $('f-note').value, note_private: 'true',
  };
  for (const [key, value] of Object.entries(fields)) if (String(value).trim()) body.append(key, String(value).trim());
  if (photo && $('f-photo').checked) body.append('photo', photo.blob, 'photo.jpg');
  const typed = $('f-name').value.trim();
  const job = jobs.find((j) => j.id === jobId);
  $('submit').disabled = true;
  try {
    const result = await api('/applications', { method: 'POST', body });
    if (!book) lastStages[jobId] = stageId || undefined;
    // The choice is remembered either way: a job, or "no job yet".
    await chrome.storage.local.set({ lastJob: book ? BOOK : jobId, lastStages });
    // When the person was already in the workspace the job goes onto their record, under the name stored there.
    const stored = (typeof result.name === 'string' && result.name) || (job && known.find((k) => k.client_name === job.client_name)?.name) || typed;
    const where = job && `${job.title} · ${job.client_name} · ${$('f-stage').selectedOptions[0]?.textContent || 'Applied'}`;
    if (book) {
      // Someone the workspace already had in The Book is not saved twice: what was sent is added to the entry they have.
      $('done-title').textContent = result.known ? `${stored} was already in The Book` : `${typed} added to The Book`;
      $('done-text').textContent = result.known
        ? 'Nothing new was made. What you sent was added to the entry they already have.'
        : 'They are not on a job yet. You can add them to one from their profile.';
    } else if (result.moved) {
      // They were in The Book without a job: the entry they had is what went on the job, not a second record.
      $('done-title').textContent = result.joined ? `Added to ${stored}'s existing record` : `${stored} added to the job`;
      $('done-text').textContent = `${where}. ${result.joined
        ? 'What was saved on them in The Book was moved onto that record.'
        : 'Their notes, résumé and calls in The Book came with them.'}`;
    } else {
      $('done-title').textContent = result.known ? `Added to ${stored}'s existing record` : `${typed} added`;
      $('done-text').textContent = where;
    }
    // A picture the workspace would not keep is said plainly, so nobody looks for it later.
    if (result.photo_rejected) $('done-text').textContent += ' Their photo could not be kept, so none was saved.';
    $('open-candidate').onclick = () => chrome.tabs.create({ url: profileUrl(jobId, result.id) });
    show('done');
  } catch (err) {
    if (err.status === 401) return start();
    const code = err.status === 409 && err.data ? err.data.code : null;
    const rows = (list) => (Array.isArray(list) ? list.filter((m) => m && typeof m === 'object').slice(0, 10) : []);
    if (code === 'link_conflict') {
      // The link or address is on somebody else's record. Nothing was added; show whose, so the recruiter can open it or fix it.
      fillNotice($('conflict'), err.message, rows(err.data.matches));
    } else {
      setError('form-error', err.message);
    }
    $('submit').disabled = false;
    // A refusal usually means the workspace has changed since this was opened (a colleague added them meanwhile):
    // look again, so the notice at the top and the button say how things stand now.
    if (err.status === 409) await lookUp();
  }
}
$('add-form').addEventListener('submit', (e) => { e.preventDefault(); send(); });

// ---------- is this copy up to date? ----------
// The extension is loaded from a folder, so Chrome never updates it. The workspace says which version it has ready
// for download; when that is newer than this copy, a line across the top says so and how to replace it.
const newer = (theirs, mine) => {
  const [a, b] = [theirs, mine].map((v) => String(v).split('.').map(Number));
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
};
async function checkVersion() {
  $('outdated').hidden = true;
  try {
    const res = await fetch(`${base}/the-book-extension.json`, { cache: 'no-store' });
    const ready = res.ok ? (await res.json()).version : null;
    if (typeof ready === 'string' && /^\d+(\.\d+)*$/.test(ready) && newer(ready, chrome.runtime.getManifest().version)) $('outdated').hidden = false;
  } catch { /* a workspace that does not say, or cannot be reached: nothing to show */ }
}
$('get-update').addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: `${base}/settings?tab=extension` }); });

// ---------- start ----------
// What to say under the profile link when the page has no address that identifies the person.
const LINK_HINTS = {
  seat: 'LinkedIn Recruiter and Sales Navigator pages do not have a link that identifies the person. Paste their public profile link (linkedin.com/in/…) here.',
  other: 'This page is not one person\'s profile, so nothing was filled in. Open their profile and click the extension again, or paste their public profile link here.',
};

async function start() {
  show('loading');
  $('connected').hidden = true;
  const saved = await chrome.storage.local.get(['base', 'verified', 'lastJob', 'lastStages', 'savePhoto']);
  base = saved.base || '';
  lastStages = saved.lastStages || {};
  $('open-settings').hidden = !base;
  if (!base || !(await chrome.permissions.contains({ origins: [`${base}/*`] }))) {
    $('base-url').value = base;
    return show('setup');
  }
  // An address is checked once before it is trusted. The check is here and not in the Connect handler because
  // Chrome's permission prompt can close the popup the moment Connect is pressed; it then runs on the next open.
  if (saved.verified !== base) {
    const found = await checkWorkspace(base);
    if (!found.ok) {
      $('base-url').value = base;
      setError('setup-error', found.message);
      return show('setup');
    }
    await chrome.storage.local.set({ verified: base });
    $('connected').textContent = `Connected to ${found.name || 'your workspace'}`;
    $('connected').hidden = false;
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
  checkVersion();
  if (me.user.role === 'client') {
    $('signin-text').textContent = 'You are signed in with a client account. Only the agency team can add candidates.';
    return show('signin');
  }

  const [allJobs, page] = await Promise.all([api('/jobs').catch(() => null), readPage()]);
  jobs = (allJobs || []).filter((j) => j.status !== 'closed');
  // With no job to choose, people can still be saved to The Book: say why that is the only choice.
  const jobHint = !allJobs ? 'Your jobs could not be loaded, so only The Book is offered. Close this and open it again to try once more.'
    : !jobs.length ? 'There are no open jobs in your workspace yet, so people are saved to The Book without one.' : '';
  $('job-hint').textContent = jobHint;
  $('job-hint').hidden = !jobHint;
  const onLinkedIn = page && /(^|\.)linkedin\.com$/i.test(page.site);
  $('f-name').value = (page && page.name) || '';
  $('f-title').value = (page && page.title) || '';
  $('f-company').value = (page && page.company) || '';
  $('f-location').value = (page && page.location) || '';
  $('f-email').value = (page && page.email) || '';
  $('f-link').value = page && /^https?:/.test(page.url) ? page.url : '';
  $('f-source').value = onLinkedIn ? 'linkedin' : 'agency_sourced';
  const hint = (page && !$('f-link').value && Object.hasOwn(LINK_HINTS, page.kind) && LINK_HINTS[page.kind]) || '';
  $('link-hint').textContent = hint;
  $('link-hint').hidden = !hint;
  fillJobs(saved.lastJob);
  clearConflict();
  $('f-photo').checked = saved.savePhoto !== false;
  photoFrom = page && page.photo && page.tabId ? { url: page.photo, tabId: page.tabId } : null;
  show('form');
  setError('form-error', page ? '' : 'This page could not be read, so fill in the details yourself.');
  await Promise.all([loadStages(), lookUp(), loadPhoto()]);
  if (!$('f-name').value) $('f-name').focus();
}

start();
