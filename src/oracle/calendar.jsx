// The recruiter's day in The Oracle: the "Your calendar" card, the reminder when an added event is about to start,
// and starting a recording or a phone call for an event.
//
// The server reads the recruiter's own calendar link and The Book's interviews and hands back one day at a time.
// Reminders are worked out here in the page from today's events, so they only happen while The Book is open in a tab.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AudioLines, BellRing, CalendarClock, CalendarDays, Check, ChevronLeft, ChevronRight, ExternalLink, Mic, Phone, Plus, RefreshCw, Video, X } from 'lucide-react';
import { api, url, extUrl, fmtTime, jobLine, photoUrl, todayLocal } from '../lib.js';
import { Avatar, Button, Card, Loading, Modal, useAction, useToast, cx } from '../ui.jsx';
import { CONSENT_WORDING, useRecorder } from './RecorderProvider.jsx';
import { CallRecorder } from './recorder.js';
import { usePerson, usePhone } from './phone.jsx';
import { showNumber, telHref } from './calls.js';
import { MINUTE, dayLabel, dueNow, endsAt, isNear, lengthOf, reminderOf, shiftDay, startsAt } from './day.js';
import { CandidatePicker, CardIntro, ConsentTick, Notice, useLive } from './bits.jsx';

const JOIN_KINDS = { meet: 'Google Meet', zoom: 'Zoom', teams: 'Teams', webex: 'Webex' };
const HOW = {
  email: 'Matched by their email address on the invitation', phone: 'Matched by their phone number in the event', name: 'Matched by their name in the event',
  interview: 'An interview scheduled in The Book', chosen: 'Chosen by you',
};

/** The time zone this browser is in, which is the zone the recruiter reads their day in. */
export const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const dayPath = (date, refresh) => url('/calendar/day', { date, tz: browserZone(), refresh: refresh ? 1 : '' });
// Which reminders were already shown or closed, kept for the life of the tab so a reload does not bring them back.
const kept = (name) => { try { return JSON.parse(sessionStorage.getItem(name)) || []; } catch { return []; } };
const keep = (name, list) => { try { sessionStorage.setItem(name, JSON.stringify(list.slice(-200))); } catch { /* storage unavailable: reminders may repeat after a reload */ } };
const flag = (name, value) => { try { if (value === undefined) return localStorage.getItem(name); localStorage.setItem(name, value); } catch { /* storage unavailable */ } return null; };
/** 'granted', 'denied', 'default' (not asked yet), or 'unsupported' where a page cannot show desktop notifications at all. */
const notifyState = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

const NONE = { today: null, now: 0, prompt: null, permission: 'unsupported', explaining: false, sync: () => {}, dismiss: () => {}, record: () => {}, offerReminders: () => {}, allow: async () => {}, notNow: () => {} };
const CalendarContext = createContext(NONE);
export const useCalendar = () => useContext(CalendarContext);

/**
 * Keeps today's events for the whole app, so the reminder for an added event shows wherever the recruiter is working:
 * a banner inside The Book and, when they have allowed it, a desktop notification.
 */
export function CalendarProvider({ children }) {
  const recorder = useRecorder();
  const phone = usePhone();
  const navigate = useNavigate();
  const [today, setToday] = useState(null); // the day as the server gives it, for today's date in this browser
  const [now, setNow] = useState(() => Date.now()); // the clock the reminders go by, moved on every few seconds
  const [dismissed, setDismissed] = useState(() => new Set(kept('oracle.reminders.closed')));
  const notified = useRef(new Set(kept('oracle.reminders.shown')));
  const [permission, setPermission] = useState(notifyState);
  const [explaining, setExplaining] = useState(false); // the sentence about why notifications are asked for is on show
  const [recording, setRecording] = useState(null); // the event a recording is about to be started for
  const asked = useRef(0);

  const shown = useRef(null); // the date of the day held in `today`
  const loadToday = useCallback(() => {
    asked.current = Date.now();
    return api.get(dayPath(todayLocal())).then((day) => { shown.current = day.date; setToday(day); }).catch(() => { /* the card says why; the reminders simply wait for the next read */ });
  }, []);
  // Read again when a recording or a phone call ends: the event it was made for now has its call.
  useEffect(() => { loadToday(); }, [loadToday, recorder.live, phone.live]);
  useEffect(() => {
    // Browsers slow timers down in a tab that is not being looked at, so the clock is compared every few seconds
    // rather than a timer being set for the start time, and looked at again the moment the tab comes back.
    // The day is read again every five minutes, and straight away when midnight has passed and "today" is a new day.
    const tick = () => { setNow(Date.now()); if (Date.now() - asked.current > 5 * MINUTE || (shown.current && shown.current !== todayLocal())) loadToday(); };
    const seen = () => { if (document.visibilityState === 'visible') tick(); };
    const timer = setInterval(tick, 15_000);
    window.addEventListener('focus', seen);
    document.addEventListener('visibilitychange', seen);
    return () => { clearInterval(timer); window.removeEventListener('focus', seen); document.removeEventListener('visibilitychange', seen); };
  }, [loadToday]);

  // Closed and shown reminders are remembered by event and start time: an event that is moved is reminded about again.
  const dismiss = useCallback((event) => setDismissed((was) => { const next = new Set(was).add(reminderOf(event)); keep('oracle.reminders.closed', [...next]); return next; }), []);
  // The call being made for an event right now, if any: no reminder for that one. A phone call that has just ended
  // and was recorded still counts, until the day is read again and the event shows its call; one that reached nobody
  // does not, so the reminder comes back.
  const busyWith = recorder.session?.eventKey || (phone.call && (phone.live || phone.call.recorded) ? phone.call.eventKey : null);
  const due = useMemo(() => dueNow(today?.events, now, { closed: dismissed, busyWith }), [today, now, dismissed, busyWith]);

  useEffect(() => {
    if (permission !== 'granted') return;
    for (const event of due) {
      if (notified.current.has(reminderOf(event))) continue;
      notified.current.add(reminderOf(event));
      keep('oracle.reminders.shown', [...notified.current]);
      try {
        const note = new Notification(`${event.title} ${Date.now() >= startsAt(event) ? 'has started' : `starts at ${fmtTime(event.start)}`}`, {
          body: `${event.match ? `With ${event.match.name}. ` : ''}Open The Book to record or call.`, tag: `the-book-${event.key}`, icon: '/logo-180.png', requireInteraction: true,
        });
        note.onclick = () => { window.focus(); navigate('/oracle'); note.close(); };
      } catch { /* phones do not let a page show notifications: the banner inside The Book is the reminder there */ }
    }
  }, [due, permission]);

  const value = useMemo(() => ({
    today, now, prompt: due[0] || null, permission, explaining, dismiss,
    /** The card has a fresher copy of a day (it loaded it, or an event on it changed): take it if it is today. */
    sync: (day) => { if (day?.date === todayLocal()) { shown.current = day.date; setToday(day); } },
    record: (event) => setRecording(event),
    /** Called the first time an event is added: explain what a notification is for before the browser asks. */
    offerReminders: () => { if (notifyState() === 'default' && !flag('oracle.reminders.asked')) setExplaining(true); },
    allow: async () => {
      flag('oracle.reminders.asked', '1');
      let answer = 'default';
      try { answer = await Notification.requestPermission(); } catch { /* treated as not allowed */ }
      setPermission(answer === 'default' ? notifyState() : answer);
      setExplaining(false);
      return answer;
    },
    notNow: () => { flag('oracle.reminders.asked', '1'); setExplaining(false); },
  }), [today, now, due, permission, explaining, dismiss]);

  return (
    <CalendarContext.Provider value={value}>
      {children}
      {recording && <RecordEventModal event={recording} onClose={() => setRecording(null)} onStarted={() => { dismiss(recording); setRecording(null); }} />}
    </CalendarContext.Provider>
  );
}

// ---- what can be done about an event ------------------------------------------------------------------------------------------
/**
 * Record, Join and Call for an event. Call is offered when there is a number to ring: the candidate's own, from their
 * profile, or one written in the event. With the phone line connected it opens the call dialog with them chosen;
 * without it, it is an ordinary link that dials from the recruiter's device. `dark` is for the banner.
 */
export function EventActions({ event, dark, className }) {
  const phone = usePhone();
  const calendar = useCalendar();
  const person = usePerson(event.match?.application_id);
  const join = extUrl(event.join_url);
  const number = person?.phone || event.phone || null;
  const connected = Boolean(phone.status?.configured);
  // A meeting with a link is recorded in the browser; a plain phone appointment is better placed as a phone call.
  const callFirst = Boolean(number) && !join;
  const plain = dark ? 'border-white/25 bg-white/10 text-white hover:bg-white/20' : 'border-line bg-white text-stone-800 shadow-sm hover:bg-stone-50';
  const strong = dark ? 'border-transparent bg-gold text-brand-950 hover:brightness-105' : 'border-transparent bg-brand-700 text-white shadow-sm hover:bg-brand-800';
  const button = 'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium whitespace-nowrap transition-colors max-sm:h-10';
  const call = () => {
    phone.openDialer(person?.phone ? { person, application_id: event.match.application_id, event_key: event.key }
      // A number that is only written in the event: the dialog says where it came from, and the call takes the event's name.
      : { to: event.phone, event_key: event.key, event_title: event.title });
  };
  const callButton = !number ? null : connected
    ? <button key="call" type="button" onClick={call} className={cx(button, callFirst ? strong : plain)}><Phone className="size-4" />Call</button>
    : <a key="call" href={telHref(number)} className={cx(button, callFirst ? strong : plain)}><Phone className="size-4" />Call</a>;
  const recordButton = <button key="record" type="button" onClick={() => calendar.record(event)} className={cx(button, callFirst ? plain : strong)}><Mic className="size-4" />Record</button>;
  return (
    <div className={cx('flex flex-wrap items-center gap-2', className)}>
      {callFirst ? [callButton, recordButton] : [recordButton, callButton]}
      {join && <a href={join} target="_blank" rel="noopener noreferrer" className={cx(button, plain)} title="Opens the meeting in a new tab">Join<ExternalLink className="size-3.5" /></a>}
    </div>
  );
}

/** The few lines that say what an event is, used at the top of the dialogs about it. */
function EventSummary({ event }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2.5">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white text-brand-700 ring-1 ring-brand-200"><CalendarClock className="size-5" /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-stone-900">{event.title}</span>
        <span className="block truncate text-[13px] text-stone-600">
          {event.all_day ? 'All day' : `${fmtTime(event.start)} to ${fmtTime(event.end)}`}{event.match ? ` · with ${event.match.name}` : ''}
        </span>
      </span>
    </div>
  );
}

/**
 * Start recording for an event. A recording always needs the recruiter's word that everyone has agreed, so this asks
 * for it, and for a meeting with a link it says how the other side gets into the recording.
 */
function RecordEventModal({ event, onClose, onStarted }) {
  const recorder = useRecorder();
  const { cannotRecord } = usePhone();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [agreed, setAgreed] = useState(false);
  const [missing, setMissing] = useState(false);
  const [problem, setProblem] = useState(null);
  const join = extUrl(event.join_url);
  const where = JOIN_KINDS[event.join_kind] || 'your browser';
  const busy = recorder.live || recorder.state === 'stopping' ? 'A call is already being recorded. Stop that recording first.' : cannotRecord;
  const begin = async () => {
    if (!agreed) return setMissing(true);
    setProblem(null);
    try {
      await recorder.start({
        consent: { confirmed: true, wording: CONSENT_WORDING }, application_id: event.match?.application_id, event_key: event.key,
        // With a candidate the call is named after them, as any other call is; without one, after the event.
        title: event.match ? '' : event.title.slice(0, 120),
        subject: event.match ? { name: event.match.name, job_title: event.match.job_title } : null,
      });
      onStarted();
      // The recording controls, with "Add the other side of the call", are on The Oracle.
      if (pathname !== '/oracle') navigate('/oracle');
    } catch (err) { setProblem(err.message); }
  };
  return (
    <Modal title="Record this call" size="sm" onClose={onClose} onSubmit={begin}
      footer={<>
        <Button onClick={onClose} className="!h-11">Cancel</Button>
        <Button type="submit" variant="primary" busy={recorder.state === 'starting'} disabled={Boolean(busy)} className="!h-11 !px-5 !text-[15px]">
          {recorder.state !== 'starting' && <span className="size-2.5 rounded-full bg-red-500 ring-2 ring-white/30" aria-hidden="true" />}Record now
        </Button>
      </>}>
      <EventSummary event={event} />
      {!event.match && <p className="text-[13px] text-stone-500">No candidate is chosen for this event. The call is still recorded, and you can add it to a candidate afterwards.</p>}
      {join && (
        <div className="rounded-lg border border-line bg-stone-50 px-3 py-2.5 text-[13px] leading-relaxed text-stone-700">
          {/* Sharing a tab's sound only exists in desktop browsers. Elsewhere the microphone has to hear both sides. */}
          {CallRecorder.canShareCallAudio()
            ? <p><span className="font-medium text-stone-900">This call is in {where}.</span> Join it in a tab of this browser. Once you are recording, press “Add the other side of the call”, choose that tab and tick “Also share tab audio”. Without that only your microphone is recorded.</p>
            : <p><span className="font-medium text-stone-900">This call is in {where}.</span> This browser cannot record a meeting’s own sound, so put the call on speaker and the microphone picks up both sides.</p>}
          <a href={join} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">Join the meeting in a new tab<ExternalLink className="size-3.5" /></a>
        </div>
      )}
      <ConsentTick checked={agreed} onChange={(v) => { setAgreed(v); if (v) setMissing(false); }} missing={missing} wording={CONSENT_WORDING} />
      {busy && <Notice tone="warn">{busy}</Notice>}
      {problem && <Notice tone="bad">{problem}</Notice>}
    </Modal>
  );
}

/** Say who an event is with: one of the people it might be, or anyone found by searching. */
function ChooseCandidateModal({ event, onClose, onSave }) {
  const [picked, setPicked] = useState(null);
  const [save, busy] = useAction(async (applicationId) => { await onSave(applicationId); onClose(); });
  return (
    <Modal title="Who is this with?" size="sm" onClose={onClose} onSubmit={() => picked && save(picked.application_id)}
      footer={<>
        {event.match?.how === 'chosen' && <Button variant="ghost" onClick={() => save(null)} className="mr-auto">Clear my choice</Button>}
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" busy={busy} disabled={!picked}>Save</Button>
      </>}>
      <EventSummary event={event} />
      {event.suggestions?.length > 0 && !picked && (
        <div>
          <span className="mb-1 block text-[13px] font-medium text-stone-700">It could be</span>
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
            {event.suggestions.map((s) => (
              <li key={s.application_id}>
                <button type="button" disabled={busy} onClick={() => save(s.application_id)} className="flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left hover:bg-stone-50">
                  <Avatar name={s.name} size={30} src={photoUrl(s.candidate_id, s.photo)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-stone-900">{s.name}</span>
                    <span className="block truncate text-[13px] text-stone-600">{jobLine(s)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <CandidatePicker value={picked} onChange={setPicked} label={event.suggestions?.length ? 'Or search for someone else' : 'Search for the candidate'} hint="Type at least two letters of their name." autoFocus={!event.suggestions?.length} />
    </Modal>
  );
}

// ---- the reminder across the top of the workspace ---------------------------------------------------------------------------
/** "Call Kevin starts at 2:00 pm", with Record and Call, on whatever page the recruiter is on. */
export function EventPrompt() {
  const { prompt, now, dismiss } = useCalendar();
  if (!prompt) return null;
  return (
    <div role="region" aria-label="An event is starting" className="no-print flex flex-wrap items-center gap-x-3 gap-y-2 bg-brand-900 px-3 py-2 text-sm text-white sm:px-4">
      <CalendarClock className="size-4 shrink-0 text-gold" />
      <span className="min-w-0 flex-1 basis-56 max-sm:basis-0">
        <span className="font-semibold">{prompt.title}</span>{' '}
        {now >= startsAt(prompt) ? `started at ${fmtTime(prompt.start)}` : `starts at ${fmtTime(prompt.start)}`}
        {prompt.match ? <span className="text-white/80"> · with {prompt.match.name}</span> : null}
      </span>
      {/* On a phone the words and the close button share the first line and the actions take the second. */}
      <EventActions event={prompt} dark className="max-sm:order-last max-sm:basis-full" />
      <button type="button" onClick={() => dismiss(prompt)} aria-label="Dismiss this reminder" className="rounded-md p-1.5 text-white/80 hover:bg-white/10 hover:text-white max-sm:p-2.5"><X className="size-4" /></button>
    </div>
  );
}

// ---- the card on The Oracle -----------------------------------------------------------------------------------------------------
function EventRow({ event, now, onChange, onChoose }) {
  const recorder = useRecorder();
  const phone = usePhone();
  const [toggle, busy] = useAction(() => onChange(event, { added: !event.added }));
  // The call for this event may be the one under way this minute: then it is not "recorded" yet.
  const underWay = event.call_id && recorder.session?.callId === event.call_id ? 'Being recorded now'
    : phone.live && (phone.call.eventKey === event.key || (event.call_id && phone.call.call_id === event.call_id)) ? 'On the phone now' : null;
  const past = !event.all_day && now >= endsAt(event);
  const under = !event.all_day && now >= startsAt(event) && !past;
  const where = JOIN_KINDS[event.join_kind];
  const guests = event.guests.map((g) => g.name || g.email).filter(Boolean);
  // "Choose candidate" is offered where it helps: the event might be one of a few people, or it has been added (so a
  // call will be made for it). A team meeting nobody added is not asked about.
  const canChoose = !event.all_day && (event.added || event.suggestions?.length > 0);
  return (
    <li className={cx('flex gap-3 px-4 py-3 sm:px-5', under && 'bg-brand-50/70')}>
      <div className={cx('tabular w-[68px] shrink-0 text-[13px]', past && 'opacity-60')}>
        <div className="font-medium text-stone-900">{event.all_day ? 'All day' : fmtTime(event.start)}</div>
        {!event.all_day && <div className="text-xs text-stone-500">{under ? 'Now' : lengthOf(event)}</div>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className={cx('min-w-0 flex-1', past && 'opacity-60')}>
            <p className="line-clamp-2 text-sm font-medium break-words text-stone-900" title={event.title}>{event.title}</p>
            {event.match ? (
              <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px]" title={HOW[event.match.how]}>
                <Avatar name={event.match.name} size={20} src={photoUrl(event.match.candidate_id, event.match.photo)} />
                <Link to={`?c=${event.match.application_id}`} className="max-w-[calc(100%-26px)] min-w-0 truncate font-medium text-stone-800 hover:text-brand-700 hover:underline">{event.match.name}</Link>
                {event.source !== 'interview' && <button type="button" onClick={onChoose} className="shrink-0 text-xs text-stone-500 underline underline-offset-2 hover:text-stone-800">Change</button>}
              </p>
            ) : canChoose || guests.length > 0 ? (
              <p className="mt-0.5 flex items-center gap-1.5 text-[13px]">
                {canChoose && <button type="button" onClick={onChoose} className="shrink-0 font-medium text-brand-700 hover:underline max-sm:py-1">Choose candidate</button>}
                {event.suggestions?.length > 0 ? <span className="truncate text-stone-500 max-sm:hidden">· {event.suggestions.length === 1 ? `could be ${event.suggestions[0].name}` : `could be one of ${event.suggestions.length}`}</span>
                  : guests.length > 0 ? <span className="truncate text-stone-500">{canChoose ? '· with' : 'With'} {guests.join(', ')}</span> : null}
              </p>
            ) : null}
            {(where || event.phone) && (
              <p className="mt-0.5 flex items-center gap-1 text-xs text-stone-500">
                {where ? <><Video className="size-3.5" />{where}</> : <><Phone className="size-3.5" /><span className="tabular">{showNumber(event.phone)}</span></>}
              </p>
            )}
          </div>
          {/* An all-day event has no moment to be reminded of, or to record or call at, so there is nothing to add it for.
              One that was added before can still be taken off. */}
          {(!event.all_day || event.added) && (
            <Button size="sm" busy={busy} icon={event.added ? Check : Plus} aria-pressed={event.added} onClick={toggle} title={event.added ? 'Take this event off your list' : undefined}
              className={cx('max-sm:!h-10 max-sm:!px-3', event.added && '!border-brand-200 !bg-brand-50 !text-brand-800')}>{event.added ? 'Added' : 'Add'}</Button>
          )}
        </div>
        {underWay ? (
          <p className="mt-1.5 inline-flex min-h-8 items-center gap-2 text-[13px] font-medium text-red-700"><span className="size-2 rounded-full bg-red-600" aria-hidden="true" />{underWay}</p>
        ) : event.call_id ? (
          <Link to={`/oracle/${event.call_id}`} className="mt-1.5 inline-flex min-h-8 items-center gap-1.5 text-[13px] font-medium text-brand-700 hover:underline"><AudioLines className="size-4" />Open the recorded call</Link>
        ) : event.added && isNear(event, now) ? <EventActions event={event} className="mt-2" /> : null}
      </div>
    </li>
  );
}

/** What the card says about reminders, once, and where the recruiter is asked whether they want desktop notifications too. */
function Reminders() {
  const { permission, explaining, allow, notNow } = useCalendar();
  const toast = useToast();
  const [turnOn, asking] = useAction(async () => {
    const answer = await allow();
    if (answer === 'granted') toast('Desktop notifications are on');
  });
  if (explaining) {
    return (
      <div className="border-t border-line bg-brand-50/60 px-4 py-3 sm:px-5">
        <p className="flex items-start gap-2 text-[13px] leading-relaxed text-stone-700">
          <BellRing className="mt-0.5 size-4 shrink-0 text-brand-700" />
          <span><span className="font-medium text-stone-900">Want a notification on your desktop too?</span> Two minutes before an added event starts, The Book reminds you with a banner. If you allow notifications it can also tell you when you are looking at another tab or window. Your browser will ask you to confirm.</span>
        </p>
        <div className="mt-2 flex gap-2 pl-6">
          <Button size="sm" variant="primary" busy={asking} onClick={turnOn} className="max-sm:!h-10">Allow notifications</Button>
          <Button size="sm" onClick={notNow} className="max-sm:!h-10">Not now</Button>
        </div>
      </div>
    );
  }
  return (
    <p className="border-t border-line px-4 py-2.5 text-xs leading-relaxed text-stone-500 sm:px-5">
      You are reminded two minutes before an added event starts{permission === 'granted' ? ', here and with a desktop notification' : ''}. The Book has to be open in a tab for that.
      {permission === 'default' && <> <button type="button" onClick={turnOn} className="font-medium text-brand-700 hover:underline">Turn on desktop notifications</button></>}
      {permission === 'denied' && ' Desktop notifications are blocked for this site in your browser, so the reminder shows inside The Book.'}
    </p>
  );
}

/** "Your calendar": the signed-in person's day, a day at a time, with "+ Add" on each event. */
export function CalendarCard({ className }) {
  const calendar = useCalendar();
  const recorder = useRecorder();
  const phone = usePhone();
  const [date, setDate] = useState(todayLocal);
  const day = useLive(dayPath(date));
  const [choosing, setChoosing] = useState(null); // the key of the event a candidate is being chosen for
  const { data } = day;

  // Hand today to the reminders whenever this card has it fresher, and read the day again every few minutes and
  // when a call ends (the event it was made for then shows it).
  useEffect(() => { if (data) calendar.sync(data); }, [data]);
  useEffect(() => { const timer = setInterval(() => { if (document.visibilityState === 'visible') day.reload(); }, 5 * MINUTE); return () => clearInterval(timer); }, [day.reload]);
  const first = useRef(true);
  useEffect(() => { if (first.current) first.current = false; else day.reload(); }, [recorder.live, phone.live]);

  const [refresh, refreshing] = useAction(async () => { day.set(await api.get(dayPath(date, true))); });
  const change = async (event, changes) => {
    let saved;
    try {
      saved = await api.put(`/calendar/events/${encodeURIComponent(event.key)}`, changes);
    } catch (err) {
      // The event has moved or gone since this card was drawn: show the day as it is now, then say why nothing changed.
      if (err.status === 404 || err.status === 409) day.reload();
      throw err;
    }
    day.set({ ...data, events: data.events.map((e) => (e.key === saved.key ? saved : e)) });
    if (changes.added) calendar.offerReminders();
  };
  const nav = 'flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-white text-stone-600 shadow-sm hover:bg-stone-50 max-sm:size-10';
  const chosen = choosing && data?.events.find((e) => e.key === choosing);

  return (
    <Card className={cx('flex flex-col overflow-hidden', className)}>
      <div className="space-y-3 p-4 pb-3 sm:p-5 sm:pb-3">
        <CardIntro icon={CalendarDays} title="Your calendar">Add the calls you want written up, and The Book reminds you when one is about to start.</CardIntro>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => setDate(shiftDay(date, -1))} aria-label="Previous day" className={nav}><ChevronLeft className="size-4" /></button>
          <button type="button" onClick={() => setDate(shiftDay(date, 1))} aria-label="Next day" className={nav}><ChevronRight className="size-4" /></button>
          <h3 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold text-stone-900" aria-live="polite">{dayLabel(date)}</h3>
          {date !== todayLocal() && <Button size="sm" onClick={() => setDate(todayLocal())} className="!h-9 max-sm:!h-10">Today</Button>}
          <button type="button" onClick={refresh} disabled={refreshing || !data} aria-label="Read the calendar again" title="Read the calendar again" className={cx(nav, 'disabled:opacity-50')}>
            <RefreshCw className={cx('size-4', refreshing && 'animate-spin')} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-line lg:min-h-56 lg:basis-0">
        {!data ? (day.error ? <div className="p-4 sm:p-5"><Notice tone="bad">Your day could not be loaded. {day.error} <button type="button" onClick={day.reload} className="font-medium underline underline-offset-2">Try again</button></Notice></div> : <Loading className="!py-12" />) : (
          <>
            {!data.connected && (
              <div className="space-y-3 px-4 py-4 sm:px-5">
                <p className="text-sm leading-relaxed text-stone-600">
                  <span className="font-medium text-stone-900">Your calendar is not connected yet.</span> Paste one private link from Google, Outlook or Apple Calendar and your day shows here, next to the interviews scheduled in The Book. The Book can only read the calendar, never change it.
                </p>
                <Link to="/settings?tab=account#calendar" className="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg bg-brand-700 px-4 text-[15px] font-medium text-white shadow-sm hover:bg-brand-800 max-sm:w-full"><CalendarDays className="size-4" />Connect your calendar</Link>
              </div>
            )}
            {data.warnings?.length > 0 && <div className="space-y-2 px-4 pt-3 sm:px-5">{data.warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}</div>}
            {data.events.length > 0 ? (
              <ul className={cx('divide-y divide-line', !data.connected && 'border-t border-line')}>
                {data.events.map((event) => <EventRow key={event.key} event={event} now={calendar.now || Date.now()} onChange={change} onChoose={() => setChoosing(event.key)} />)}
              </ul>
            ) : data.connected ? (
              <p className="px-4 py-10 text-center text-sm text-stone-500 sm:px-5">Nothing in your calendar {date === todayLocal() ? 'today' : 'on this day'}.</p>
            ) : null}
          </>
        )}
      </div>
      <Reminders />

      {chosen && <ChooseCandidateModal event={chosen} onClose={() => setChoosing(null)} onSave={(applicationId) => change(chosen, { application_id: applicationId })} />}
    </Card>
  );
}
