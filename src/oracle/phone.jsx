// Phone calls placed through The Book's own number: finding who to call, following the call while it is under way,
// and the "Call a candidate" card on The Oracle.
//
// The conversation itself happens on the recruiter's own phone: The Book rings their mobile first, they press 1, and
// the other person is rung. So what is on screen here is only a view of what the phone service reports, asked for
// about once a second. Closing a dialog or leaving a page never ends a call.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, ChevronDown, CircleCheck, Hash, Phone, PhoneCall, PhoneForwarded, PhoneIncoming, PhoneOff, PhoneOutgoing, Search, Smartphone, X } from 'lucide-react';
import { useApp, useApi } from '../state.jsx';
import { api, url, ago, firstName, jobLine, photoUrl } from '../lib.js';
import { WAITING_WORDS, followed, headline, isOver, personFor, showNumber, telHref, typedNumber } from './calls.js';
import { Avatar, Button, Card, Checkbox, Input, Loading, Modal, useAction, cx } from '../ui.jsx';
import { useRecorder } from './RecorderProvider.jsx';
import { formatElapsed } from './recorder.js';
import { CardIntro, Notice, useLive } from './bits.jsx';

const NONE = {
  status: null, statusError: null, call: null, live: false, dialogOpen: false, cannotCall: null, cannotRecord: null, hangingUp: false,
  reloadStatus: async () => null, openDialer: () => {}, hangUp: async () => {}, dismiss: () => {}, redial: async () => {},
  place: async () => { throw new Error('Phone calls are not available here.'); },
};
const PhoneContext = createContext(NONE);
/** The phone line for the whole app: whether it is connected, and the call under way (if any). Client users get an empty one. */
export const usePhone = () => useContext(PhoneContext);

const UNREACHABLE = 'The Book could not be reached. Check your connection and try again.';
/** A sentence for a request that failed: the server's own words when it answered, ours when it could not be reached. */
const problemOf = (err) => (err?.status || !(err instanceof TypeError) ? err.message : UNREACHABLE);

/** The names of the settings that connect the phone line, for admins. */
export const PHONE_SETTINGS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_NUMBER'];
/** With APP_URL, the public address Twilio reports to: the phone line needs all four. */
const ALL_PHONE_SETTINGS = [...PHONE_SETTINGS, 'APP_URL'];
const code = (text) => <code key={text} className="rounded bg-stone-200/70 px-1 py-0.5 text-xs text-stone-800">{text}</code>;
export const settingNames = (names) => names.map((name, i) => <React.Fragment key={name}>{i > 0 && (i === names.length - 1 ? ' and ' : ', ')}{code(name)}</React.Fragment>);

// ---- who can be called ----------------------------------------------------------------------------------------------------
/**
 * A candidate's profile, as the call dialog wants it: who they are, their number, and the jobs they are being
 * considered for. Someone saved to The Book without a job has one entry with no job or client in it.
 */
export function personOf(profile) {
  const { application: app, candidate, job, client, others = [] } = profile;
  const phone = String(candidate.phone || '').trim() || null;
  return {
    candidate_id: candidate.id, name: candidate.name, photo: candidate.photo ?? null, phone, phone_display: phone,
    applications: [{ id: app.id, job_title: job?.title ?? null, client_name: client?.name ?? null, status: app.status },
      ...others.map((o) => ({ id: o.id, job_title: o.job_title ?? null, client_name: client?.name ?? null, status: o.status }))],
  };
}
// A profile looked up for its phone number is kept for a minute, so a day of events does not ask for the same person over and over.
const people = new Map();
export function loadPerson(applicationId) {
  const kept = people.get(applicationId);
  if (kept && Date.now() - kept.at < 60_000) return kept.person;
  const person = api.get(`/applications/${applicationId}`).then(personOf);
  person.catch(() => people.delete(applicationId));
  people.set(applicationId, { at: Date.now(), person });
  return person;
}
/** The person behind an application, once loaded; null until then, or when `applicationId` is empty. */
export function usePerson(applicationId) {
  const [found, setFound] = useState(null);
  useEffect(() => {
    if (!applicationId) return undefined;
    let live = true;
    loadPerson(applicationId).then((person) => live && setFound({ applicationId, person })).catch(() => {});
    return () => { live = false; };
  }, [applicationId]);
  return personFor(found, applicationId);
}

// ---- the phone line, for the whole app --------------------------------------------------------------------------------------
export function PhoneProvider({ children }) {
  const { version } = useApp();
  const recorder = useRecorder();
  const { pathname } = useLocation();
  const [status, setStatus] = useState(null); // what GET /phone/status says; null until it has answered
  const [statusError, setStatusError] = useState(null);
  // The call being followed: what the server says about it, plus `talkingSince` (when this page saw the two connected),
  // `target` (what was asked for, so it can be called again), `eventKey` and `lost` (the server stopped answering).
  const [call, setCall] = useState(null);
  const [dialog, setDialog] = useState(null); // { preset } while the "Find & call" dialog is open
  const latest = useRef(null);
  latest.current = call;

  const reloadStatus = useCallback(() => api.get('/phone/status')
    .then((s) => { setStatus(s); setStatusError(null); return s; })
    .catch((err) => { setStatusError(problemOf(err)); return null; }), []);
  useEffect(() => { reloadStatus(); }, [reloadStatus, version]);

  // Follow the call: once a second while it is live. After it ends a recorded call is looked at for a few minutes
  // more, because its recording takes a moment to reach The Oracle and the sentence about it changes when it does.
  const id = call?.id ?? null;
  const over = call ? isOver(call) : false;
  useEffect(() => {
    if (!id) return undefined;
    let stopped = false, timer, misses = 0, looks = 0;
    const look = async () => {
      looks += 1;
      if (over && (looks > 45 || (looks > 1 && !latest.current?.recorded))) return;
      try {
        const fresh = await api.get(`/phone/calls/${id}`);
        if (stopped) return;
        misses = 0;
        setCall((was) => (was?.id !== id ? was : followed(was, fresh)));
      } catch (err) {
        if (stopped) return;
        if (err.status === 404) {
          setCall((was) => (was?.id !== id ? was : { ...was, status: 'failed', outcome: was.outcome ?? 'failed', message: isOver(was) ? was.message : 'This call is no longer on record.', lost: false }));
          return;
        }
        if (++misses >= 3) setCall((was) => (was?.id === id && !was.lost ? { ...was, lost: true } : was));
      }
      timer = setTimeout(look, over ? 4000 : 1000);
    };
    timer = setTimeout(look, over ? 1500 : 700);
    return () => { stopped = true; clearTimeout(timer); };
  }, [id, over]);

  // A call can start without this page: rung in from the recruiter's own phone, somebody ringing The Book's number,
  // or Call pressed in another tab. Looked for when The Book is opened or comes back into view, and every so often
  // while The Oracle is on screen, so the card there shows it and a recording is not started over the top of it.
  const configured = Boolean(status?.configured);
  const onOracle = pathname === '/oracle';
  useEffect(() => {
    if (!configured) return undefined;
    const look = async () => {
      if (latest.current && !isOver(latest.current)) return;
      try {
        const found = (await api.get('/phone/calls?limit=5')).find((c) => !isOver(c));
        if (found && !(latest.current && !isOver(latest.current))) setCall({ ...found, talkingSince: null, target: null, eventKey: null });
      } catch { /* looked for again next time */ }
    };
    const seen = () => { if (document.visibilityState === 'visible') look(); };
    look();
    const timer = onOracle ? setInterval(seen, 20_000) : null;
    document.addEventListener('visibilitychange', seen);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', seen); };
  }, [configured, onOracle]);

  const live = Boolean(call && !over);
  // One call at a time. A phone call is recorded on the phone line and a browser recording by the microphone; running
  // both would give two recordings of one conversation, or a recording of someone who never heard the notice.
  const recording = recorder.live || recorder.state === 'starting' || recorder.state === 'stopping';
  const cannotCall = recording ? 'You are recording a call in your browser. Stop that recording before you place a phone call, so each call has its own recording and notes.' : null;
  const cannotRecord = !live ? null
    : call.recorded ? 'You are on a phone call, and it is already being recorded on the phone line. Record now is ready again when the call ends.'
    : 'You are on a phone call that is not being recorded. To record it, hang up and call again with “Record this call” ticked, so the other person hears the notice first.';

  const place = useCallback(async (target) => {
    if (cannotCall) throw new Error(cannotCall);
    if (latest.current && !isOver(latest.current)) throw new Error('You already have a call under way. Hang up first, or wait for it to end.');
    const { application_id, candidate_id, to, record = true, event_key, name, to_display, title } = target;
    const made = await api.post('/phone/calls', {
      application_id: application_id || undefined, candidate_id: candidate_id || undefined, to: to || undefined, record, event_key: event_key || undefined, title: title || undefined,
    });
    setCall({
      id: made.id, call_id: made.call_id ?? null, status: made.status || 'ringing_you', outcome: null, message: '', to_display: to_display || null,
      candidate_name: name || null, recorded: record, duration_sec: null, talkingSince: null, target, eventKey: event_key || null, lost: false,
    });
    return made;
  }, [cannotCall]);

  const [hangUp, hangingUp] = useAction(async () => { if (latest.current) await api.post(`/phone/calls/${latest.current.id}/hangup`); });
  const [redial] = useAction(async () => { if (latest.current?.target) await place(latest.current.target); });

  const value = useMemo(() => ({
    status, statusError, reloadStatus, call, live, cannotCall, cannotRecord, place, hangUp, hangingUp, redial,
    dialogOpen: Boolean(dialog),
    dismiss: () => setCall(null),
    openDialer: (preset = {}) => setDialog({ preset }),
  }), [status, statusError, reloadStatus, call, live, cannotCall, cannotRecord, place, hangingUp, dialog]);

  return (
    <PhoneContext.Provider value={value}>
      {children}
      {dialog && <CallDialog preset={dialog.preset} onClose={() => setDialog(null)} />}
    </PhoneContext.Provider>
  );
}

// ---- what is missing before a call can be placed --------------------------------------------------------------------------
/**
 * Says exactly what stands between this person and placing a call, and where to put it right: the phone line is not
 * connected (admins are told which settings), or they have not saved the mobile The Book is to ring. Nothing when all is well.
 */
export function PhoneSetup({ onNavigate, className }) {
  const { isAdmin } = useApp();
  const { status, statusError, reloadStatus } = usePhone();
  const link = 'font-medium text-brand-700 hover:underline';
  if (statusError && !status) {
    return <Notice tone="bad" className={className}>The phone connection could not be checked. {statusError} <button type="button" onClick={reloadStatus} className="font-medium underline underline-offset-2">Try again</button></Notice>;
  }
  if (!status) return null;
  if (!status.configured) {
    return (
      <Notice className={className}>
        <span className="font-medium text-stone-900">Phone calls are not connected to this workspace yet.</span>{' '}
        {isAdmin
          // When some of the settings are in, say which thing is still missing rather than listing what is already set.
          ? <>{status.problem && status.missing?.length < 4 ? status.problem : <>To connect them, set {settingNames(ALL_PHONE_SETTINGS)} where the app is hosted.</>} Then restart the app. <Link to="/settings?tab=agency#phone-connection" onClick={onNavigate} className={link}>What each one is</Link></>
          : <>An admin can connect them in the app’s hosting settings. <Link to="/settings?tab=agency#phone-connection" onClick={onNavigate} className={link}>What is needed</Link></>}
      </Notice>
    );
  }
  if (!status.my_phone) {
    return (
      <Notice tone="warn" className={className}>
        <span className="font-medium">Save your mobile number first.</span> The Book rings your own phone and then connects you to the candidate, so it needs to know which phone that is.{' '}
        <Link to="/settings?tab=account#phone" onClick={onNavigate} className="font-medium text-amber-950 underline underline-offset-2">Add your mobile number</Link>
      </Notice>
    );
  }
  return null;
}

// ---- the call while it is under way -----------------------------------------------------------------------------------------
/** "02:13" since the two were connected. It redraws itself. */
function TalkClock({ since }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 500); return () => clearInterval(t); }, []);
  return <span className="tabular" role="timer" aria-label="Time on the call">{formatElapsed(Date.now() - since)}</span>;
}

/**
 * The call under way, or how the last one ended: stage, who, the time on the call, Hang up; and once it is over one
 * plain sentence, with a link to the call in The Oracle when it was recorded. `onDone` closes whatever it is shown in.
 */
export function LiveCall({ onDone, className }) {
  const { call, hangUp, hangingUp, redial, dismiss, cannotCall } = usePhone();
  if (!call) return null;
  const over = isOver(call);
  const talking = call.status === 'in_call';
  const good = over && call.outcome === 'completed';
  const Icon = over ? (good ? CircleCheck : PhoneOff) : talking ? PhoneCall : call.status === 'calling_them' ? PhoneForwarded : PhoneOutgoing;
  const who = [call.candidate_name, call.to_display].filter(Boolean).join(' · ');
  const done = () => { dismiss(); onDone?.(); };
  return (
    <div className={cx('flex flex-col items-center text-center', className)}>
      <span className={cx('relative flex size-14 items-center justify-center rounded-full',
        over ? (good ? 'bg-brand-50 text-brand-700 ring-1 ring-brand-200' : 'bg-stone-100 text-stone-600 ring-1 ring-stone-200') : talking ? 'bg-brand-700 text-white' : 'bg-brand-950 text-gold')}>
        {!over && !talking && <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-400/30" aria-hidden="true" />}
        <Icon className="relative size-6" />
      </span>
      <div role="status" aria-live="polite">
        <p className="mt-3 text-lg font-semibold tracking-tight text-stone-900">
          {headline(call)}{talking && call.talkingSince ? <>, <TalkClock since={call.talkingSince} /></> : null}
        </p>
        {who && <p className="text-sm font-medium text-stone-700">{who}</p>}
        <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-stone-600">{call.message || WAITING_WORDS[call.status] || ''}</p>
      </div>
      {call.lost && !over && <Notice tone="warn" className="mt-3 text-left">The Book has lost touch with this call. It carries on on your phone; what is shown here may be out of date until the connection is back.</Notice>}
      {!over ? (
        <>
          <Button variant="dangerSolid" icon={PhoneOff} busy={hangingUp} onClick={hangUp} className="mt-4 !h-12 w-full max-w-xs !text-[15px]">Hang up</Button>
          <p className="mt-2 text-xs text-stone-500">Hanging up on your phone ends the call too.{call.recorded ? ' The call is recorded and written up in The Oracle afterwards.' : ''}</p>
        </>
      ) : (
        <>
          {call.recorded && call.call_id && (
            <Link to={`/oracle/${call.call_id}`} onClick={done} className="mt-4 inline-flex h-11 w-full max-w-xs items-center justify-center gap-1.5 rounded-lg bg-brand-700 px-4 text-[15px] font-medium text-white shadow-sm hover:bg-brand-800">
              Open the call in The Oracle
            </Link>
          )}
          <div className="mt-3 flex w-full max-w-xs gap-2">
            {call.target && <Button icon={Phone} disabled={Boolean(cannotCall)} onClick={redial} className="!h-11 flex-1">Call again</Button>}
            <Button onClick={done} className="!h-11 flex-1">Done</Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A slim bar across the top of the workspace for a phone call the recruiter is not looking at: the dialog was closed,
 * or they went to another page. On The Oracle itself the card shows the call, so the bar stays away.
 */
export function PhoneStrip() {
  const { call, live, hangUp, hangingUp, dismiss, dialogOpen } = usePhone();
  const { pathname } = useLocation();
  if (!call || dialogOpen || pathname === '/oracle') return null;
  if (live) {
    return (
      <div role="region" aria-label="Phone call" className="no-print flex h-11 items-center gap-3 bg-brand-800 px-3 text-sm text-white sm:px-4">
        <Link to="/oracle" title="Open The Oracle" className="flex min-w-0 items-center gap-2.5 rounded-md hover:opacity-90">
          <PhoneCall className="size-4 shrink-0 text-gold" />
          <span className="font-semibold whitespace-nowrap">{headline(call)}</span>
          {call.status === 'in_call' && call.talkingSince && <TalkClock since={call.talkingSince} />}
          <span className="hidden min-w-0 truncate text-white/85 sm:block">{call.candidate_name || call.to_display}</span>
        </Link>
        <span className="flex-1" />
        <button type="button" onClick={hangUp} disabled={hangingUp} className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-white px-2.5 text-[13px] font-medium text-red-800 hover:bg-red-50 disabled:opacity-60">
          <PhoneOff className="size-3.5" />Hang up
        </button>
      </div>
    );
  }
  return (
    <div role="status" className="no-print flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-brand-200 bg-brand-50 px-4 py-2.5 text-sm text-brand-950">
      <Phone className="size-4 shrink-0 text-brand-700" />
      <span className="min-w-0 flex-1 basis-64">{call.message || headline(call)}</span>
      {call.recorded && call.call_id && <Link to={`/oracle/${call.call_id}`} onClick={dismiss} className="font-medium text-brand-800 underline underline-offset-2 hover:text-brand-950">Open the call</Link>}
      <button type="button" onClick={dismiss} aria-label="Dismiss" className="rounded-md p-1 text-brand-700 hover:bg-brand-100"><X className="size-4" /></button>
    </div>
  );
}

// ---- finding who to call, and placing the call ----------------------------------------------------------------------------
const STANDING = { hired: 'Hired', rejected: 'Rejected', withdrawn: 'Withdrawn' };

/** Search by name or by number, or type a number nobody in The Book has. */
function FindSomeone({ note, onPerson, onNumber }) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(text.trim()), 250); return () => clearTimeout(t); }, [text]);
  const searching = query.length >= 2;
  const { data: found, loading, error } = useApi(searching ? url('/phone/lookup', { q: query }) : null);
  const number = typedNumber(text);
  const jobs = (p) => (p.applications.length === 1 ? jobLine(p.applications[0]) : p.applications.length ? `Being considered for ${p.applications.length} jobs` : '');
  return (
    <>
      {note && <Notice tone="warn">{note}</Notice>}
      <label className="relative block">
        <span className="sr-only">Name or phone number</span>
        <Search className="pointer-events-none absolute top-3.5 left-3 size-4 text-stone-400" />
        {/* 16px text: phones zoom the page in on anything smaller when the box is tapped. */}
        <Input value={text} onChange={(e) => setText(e.target.value)} autoFocus autoComplete="off" enterKeyHint="search" placeholder="Name or phone number"
          className="!h-11 pl-9 !text-base" onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
      </label>
      {!searching && !number ? (
        <p className="text-[13px] leading-relaxed text-stone-500">Type at least two letters of a name, or part of a number. Candidates are listed when they have a phone number on their profile. You can also type any number in full to call it.</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line" aria-label="Who to call">
          {number && (
            <li>
              <button type="button" onClick={() => onNumber(number)} className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left hover:bg-stone-50">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700 ring-1 ring-brand-100 ring-inset"><Hash className="size-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-stone-900">Call {number}</span>
                  <span className="block text-[13px] text-stone-500">A number you typed. It does not have to be a candidate’s.</span>
                </span>
              </button>
            </li>
          )}
          {searching && (error ? <li className="px-3 py-3 text-sm text-red-700">{error}</li>
            : !found && loading ? <li className="px-3 py-3 text-sm text-stone-500">Searching…</li>
            : !found?.length ? <li className="px-3 py-3 text-sm text-stone-500">Nobody with a phone number on their profile matches “{query}”.</li>
            : found.map((p) => (
              <li key={p.candidate_id}>
                <button type="button" onClick={() => onPerson(p)} className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left hover:bg-stone-50">
                  <Avatar name={p.name} size={36} src={photoUrl(p.candidate_id, p.photo)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-stone-900">{p.name}</span>
                    <span className="block truncate text-[13px] text-stone-600"><span className="tabular">{p.phone_display}</span>{jobs(p) ? ` · ${jobs(p)}` : ''}</span>
                  </span>
                  <Phone className="size-4 shrink-0 text-brand-600" />
                </button>
              </li>
            )))}
        </ul>
      )}
    </>
  );
}

/**
 * "Find & call candidate". Three steps in one dialog: find the person (or type a number), check who will be rung and
 * whether the call is recorded, then the call itself. `preset` starts it further along: `person` (already known, as
 * from their profile), `application_id` (looked up here), `to` (a number, as from a calendar event) and `event_key`.
 */
function CallDialog({ preset, onClose }) {
  const phone = usePhone();
  const { status, call, cannotCall } = phone;
  const [person, setPerson] = useState(preset.person || null);
  const [number, setNumber] = useState(preset.person ? null : preset.to || null);
  const [applicationId, setApplicationId] = useState(preset.application_id || preset.person?.applications[0]?.id || null);
  const [looking, setLooking] = useState(Boolean(preset.application_id && !preset.person));
  const [note, setNote] = useState(null); // why the person asked for is not shown, when they could not be
  const [record, setRecord] = useState(true);
  const [problem, setProblem] = useState(null);
  const [placing, setPlacing] = useState(false);
  // A call already under way when the dialog opens is shown rather than a second one offered. Once the dialog has
  // shown a call it follows whichever call is current, so "Call again" stays here with its Hang up.
  const [showing, setShowing] = useState(phone.live);

  useEffect(() => {
    if (!looking) return undefined;
    let live = true;
    loadPerson(preset.application_id)
      .then((found) => {
        if (!live) return;
        if (found.phone) setPerson(found);
        else if (!preset.to) setNote(`${found.name} has no phone number on their profile yet. Add one under “Edit details” on their profile, or type a number here.`);
      })
      .catch(() => { if (live && !preset.to) setNote('That candidate could not be opened. Search for them here instead.'); })
      .finally(() => live && setLooking(false));
    return () => { live = false; };
  }, []);

  // The number came from a calendar event or from the list of recent calls (and has not been swapped for another):
  // said so, since nobody typed it.
  const given = Boolean(preset.to && number === preset.to);
  const fromEvent = given && Boolean(preset.event_key);
  const whose = fromEvent ? `The number in “${preset.event_title || 'this event'}”.` : given && preset.to_from ? preset.to_from : 'A number you typed.';
  const choose = (found) => { setPerson(found); setNumber(null); setApplicationId(found.applications[0]?.id ?? null); setProblem(null); };
  const back = () => { setPerson(null); setNumber(null); setProblem(null); };
  const callNow = async () => {
    if (placing) return;
    setProblem(null);
    setPlacing(true);
    try {
      await phone.place(person
        ? { application_id: applicationId || undefined, candidate_id: applicationId ? undefined : person.candidate_id, name: person.name, to_display: person.phone_display, record, event_key: preset.event_key }
        : { to: number, to_display: showNumber(number), record, event_key: preset.event_key, title: fromEvent ? preset.event_title : undefined });
      setShowing(true);
    } catch (err) { setProblem(problemOf(err)); }
    setPlacing(false);
  };

  if (showing && call) {
    return (
      <Modal title="Phone call" subtitle={isOver(call) ? undefined : 'Closing this does not end the call.'} size="sm" onClose={onClose}>
        <LiveCall onDone={onClose} className="py-2" />
      </Modal>
    );
  }
  if (looking) return <Modal title="Call a candidate" size="sm" onClose={onClose}><Loading className="!py-10" /></Modal>;
  if (!person && !number) {
    return (
      <Modal title="Find & call candidate" subtitle="Search by name or number, or type a new number." size="sm" onClose={onClose}>
        <PhoneSetup onNavigate={onClose} />
        <FindSomeone note={note} onPerson={choose} onNumber={(n) => { setNumber(n); setProblem(null); }} />
      </Modal>
    );
  }

  const ready = Boolean(status?.configured && status?.my_phone);
  const them = person ? firstName(person.name) : 'this number';
  const jobs = person?.applications || [];
  return (
    <Modal title={person ? `Call ${person.name}` : 'Call this number'} size="sm" onClose={onClose} onSubmit={callNow}
      footer={<>
        <Button icon={ArrowLeft} onClick={back} className="mr-auto !h-11">Someone else</Button>
        <Button type="submit" variant="primary" icon={Phone} busy={placing} disabled={!ready || Boolean(cannotCall)} className="!h-11 !px-5 !text-[15px]">Call</Button>
      </>}>
      <div className="flex items-center gap-3 rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2.5">
        {person ? <Avatar name={person.name} size={44} src={photoUrl(person.candidate_id, person.photo)} />
          : <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-white text-brand-700 ring-1 ring-brand-200"><Hash className="size-5" /></span>}
        <span className="min-w-0 flex-1">
          <span className="tabular block truncate text-[15px] font-semibold text-stone-900">{person ? person.name : showNumber(number)}</span>
          <span className={cx('block text-sm text-stone-600', person && 'tabular truncate')}>
            {person ? person.phone_display : `${whose} If it is one candidate’s number, the call goes on their profile.`}
          </span>
          {jobs.length === 1 && <span className="block truncate text-[13px] text-stone-500">{jobs[0].job_title ? `About ${jobLine(jobs[0])}` : jobLine(jobs[0])}</span>}
        </span>
      </div>

      {jobs.length > 1 && (
        <fieldset className="min-w-0">
          <legend className="mb-1.5 text-[13px] font-medium text-stone-700">{person.name.split(' ')[0]} is being considered for {jobs.length} jobs. Which one is this call about?</legend>
          <div className="space-y-1.5">
            {jobs.map((a) => (
              <label key={a.id} className={cx('flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm', applicationId === a.id ? 'border-brand-300 bg-brand-50/60' : 'border-line hover:bg-stone-50')}>
                <input type="radio" name="call-about" checked={applicationId === a.id} onChange={() => setApplicationId(a.id)} className="size-4 accent-brand-700" />
                <span className="min-w-0 flex-1 truncate font-medium text-stone-800">{jobLine(a)}</span>
                {STANDING[a.status] && <span className="shrink-0 text-xs text-stone-500">{STANDING[a.status]}</span>}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="rounded-lg border border-line bg-stone-50 px-3 py-2.5">
        <Checkbox checked={record} onChange={(e) => setRecord(e.target.checked)} label="Record this call"
          hint={!record ? 'This call will not be recorded, so there will be no transcript or notes from it.'
            : status?.notice === false ? 'The spoken notice is switched off for this workspace, so tell them yourself at the start that the call is recorded.'
            : 'Both sides hear a short notice that the call is recorded before you are connected.'} />
      </div>

      <PhoneSetup onNavigate={onClose} />
      {cannotCall && <Notice tone="warn">{cannotCall}</Notice>}
      {problem && <Notice tone="bad">{problem}</Notice>}
      {ready && !cannotCall && (
        <p className="text-[13px] leading-relaxed text-stone-500">
          The Book rings your mobile, <span className="tabular font-medium text-stone-700">{showNumber(status.my_phone)}</span>, first. Pick up and press 1, and it calls {them}. They see The Book’s number, <span className="tabular">{status.number_display}</span>.
        </p>
      )}
    </Modal>
  );
}

// ---- the card on The Oracle -------------------------------------------------------------------------------------------------
/** How to place a call with no screen at all: ring The Book's number from the saved mobile, PIN, then the number. */
function Switchboard() {
  const { status } = usePhone();
  const { isAdmin } = useApp();
  if (!status?.configured || !status.number) return null;
  const step = (n, children) => (
    <li className="flex gap-3">
      <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-950 text-xs font-semibold text-gold">{n}</span>
      <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-stone-700">{children}</div>
    </li>
  );
  return (
    <details className="group mt-3 rounded-lg border border-line">
      <summary className="flex min-h-11 list-none items-center gap-2 px-3 text-[13px] font-medium text-stone-700 hover:bg-stone-50 [&::-webkit-details-marker]:hidden">
        <Smartphone className="size-4 text-stone-500" />Or call from your own phone
        <ChevronDown className="ml-auto size-4 text-stone-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-3 border-t border-line px-3 py-3">
        <p className="text-[13px] leading-relaxed text-stone-600">No screen needed, so it works while you are walking. The call is recorded, and its transcript and notes appear here in The Oracle.</p>
        <ol className="space-y-3">
          {step(1, <>
            Ring The Book{status.my_phone ? <> from your mobile, <span className="tabular whitespace-nowrap">{showNumber(status.my_phone)}</span></> : ' from your mobile'}:
            <a href={telHref(status.number)} className="tabular mt-1 flex w-fit items-center gap-2 rounded-lg text-2xl font-semibold tracking-tight text-brand-800 hover:text-brand-950">
              <Phone className="size-5 text-gold" />{status.number_display || showNumber(status.number)}
            </a>
          </>)}
          {step(2, <>Key in your PIN, then press <b className="font-semibold">#</b>.</>)}
          {step(3, <>Key in the number you want to call, then press <b className="font-semibold">#</b>. You are connected, and the other person hears that the call is recorded.</>)}
        </ol>
        {!status.my_phone ? (
          <Notice tone="warn">The Book only takes calls like this from the mobile saved in your account, and you have not saved one. <Link to="/settings?tab=account#phone" className="font-medium text-amber-950 underline underline-offset-2">Add your mobile number and a PIN</Link></Notice>
        ) : !status.my_pin_set ? (
          <Notice tone="warn">You need a PIN before this works, so nobody else can place calls from your phone. <Link to="/settings?tab=account#phone" className="font-medium text-amber-950 underline underline-offset-2">Choose your PIN</Link></Notice>
        ) : (
          <p className="text-xs text-stone-500">Your PIN is set (<Link to="/settings?tab=account#phone" className="font-medium text-brand-700 hover:underline">change it</Link>). Save the number above in your phone as “The Book” so it is one tap away.</p>
        )}
        {/* The Book cannot tell whether the number has been pointed at it at Twilio, so it says what to do if it has not. */}
        <p className="text-xs text-stone-500">
          If the number does not answer “This is The Book”, one set-up step at Twilio is still to do.{' '}
          {isAdmin ? <Link to="/settings?tab=agency#phone-connection" className="font-medium text-brand-700 hover:underline">See the two addresses to enter there</Link> : 'Ask an admin to finish it under Settings, Agency.'}
        </p>
      </div>
    </details>
  );
}

/**
 * The last few phone calls, each in one sentence. A call that reached nobody leaves nothing in The Oracle, so this
 * is the only place a missed call (somebody rang back and left no message) can be seen, and returned.
 */
function RecentCalls() {
  const phone = usePhone();
  // Read again whenever a call starts or ends, and every minute while the card is on screen (calls can come in).
  const recent = useLive('/phone/calls?limit=6', () => true, 60_000);
  useEffect(() => { recent.reload(); }, [phone.live]);
  const calls = (recent.data || []).filter((c) => isOver(c)).slice(0, 5);
  if (!calls.length) return null;
  const ready = Boolean(phone.status?.configured && phone.status?.my_phone) && !phone.cannotCall && !phone.live;
  return (
    <div className="mt-4">
      <h3 className="text-[13px] font-medium text-stone-700">Your recent calls</h3>
      <ul className="mt-1.5 divide-y divide-line overflow-hidden rounded-lg border border-line">
        {calls.map((c) => {
          const missed = c.direction === 'inbound' && c.outcome === 'no_answer';
          return (
            <li key={c.id} className="flex items-start gap-2.5 px-3 py-2">
              <span className={cx('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full', missed ? 'bg-amber-100 text-amber-800' : 'bg-stone-100 text-stone-500')}>
                {c.direction === 'inbound' ? <PhoneIncoming className="size-3.5" /> : <PhoneOutgoing className="size-3.5" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className={cx('text-[13px] leading-snug', missed ? 'font-medium text-stone-900' : 'text-stone-700')}>{c.message}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-stone-500">
                  <span>{ago(c.started_at)}{!c.candidate_name && c.to_display ? <> · <span className="tabular">{c.to_display}</span></> : null}</span>
                  {c.recorded && c.call_id && <Link to={`/oracle/${c.call_id}`} className="font-medium text-brand-700 hover:underline">Open the call</Link>}
                  {ready && c.to_display && (c.outcome !== 'completed' || c.direction === 'inbound') && (
                    <button type="button" onClick={() => phone.openDialer({ to: c.to_display, to_from: c.candidate_name ? `${c.candidate_name}’s number, from your recent calls.` : 'The number from your recent calls.' })}
                      className="font-medium text-brand-700 hover:underline">{c.direction === 'inbound' ? 'Call back' : 'Call again'}</button>
                  )}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** "Call a candidate": one obvious button, what is missing when a call cannot be placed, and the call while it is under way. */
export function CallCard() {
  const phone = usePhone();
  const { status, call, cannotCall } = phone;
  const ready = Boolean(status?.configured && status?.my_phone);
  return (
    <Card className={cx('p-4 sm:p-5', phone.live && 'border-brand-300 ring-2 ring-brand-100')}>
      <CardIntro icon={Phone} title="Call a candidate">Search by name or number, or type a new number. The Book rings your mobile, then connects you.</CardIntro>
      {/* A call that came in, or was rung in from the recruiter's own phone, cannot be held back the way Call is. */}
      {phone.live && cannotCall && <Notice tone="warn" className="mt-4">You are also recording in your browser. This phone call {call.recorded ? 'is recorded on the phone line by itself' : 'is not being recorded on the phone line'}, so you may want to stop the browser recording.</Notice>}
      {call ? <LiveCall className="mt-4 rounded-xl border border-line bg-stone-50 px-4 py-5" /> : (
        <>
          <PhoneSetup className="mt-4" />
          {cannotCall && ready && <Notice tone="warn" className="mt-4">{cannotCall}</Notice>}
          <Button variant="primary" icon={Search} disabled={!ready || Boolean(cannotCall)} onClick={() => phone.openDialer()} className="mt-4 !h-11 w-full !text-[15px]">Find &amp; call candidate</Button>
          <Switchboard />
        </>
      )}
      {status?.configured && <RecentCalls />}
    </Card>
  );
}
