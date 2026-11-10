import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { CircleCheck, LoaderCircle, Mic, Pause, Play, Square, TriangleAlert, WifiOff, X } from 'lucide-react';
import { useApp } from '../state.jsx';
import { api } from '../lib.js';
import { useToast, cx } from '../ui.jsx';
import { CallRecorder, ChunkUploader, formatElapsed } from './recorder.js';

/** The sentence the recruiter ticks before a call is recorded or uploaded. It is stored with the call. */
export const CONSENT_WORDING = 'Everyone on this call knows it is being recorded and has agreed.';

const IDLE = {
  state: 'idle', live: false, session: null, waiting: 0, callAudio: null, note: null, limitMinutes: null, minutesLeft: null,
  start: async () => { throw new Error('Recording is not available here.'); },
  pause: () => {}, resume: () => {}, stop: async () => {}, addCallAudio: async () => ({ ok: false, reason: 'unsupported' }),
  level: () => 0, elapsed: () => 0, clearNote: () => {},
};
const RecorderContext = createContext(IDLE);
/** The one recorder for the whole app. It lives above the pages, so a call keeps recording while the recruiter moves around. */
export const useRecorder = () => useContext(RecorderContext);

/** "3 hours" or "45 minutes": the longest a call can be recorded, as the server gives it in minutes. */
export const limitWords = (minutes) => {
  const whole = Math.round(minutes);
  const n = whole % 60 === 0 ? whole / 60 : whole;
  return `${n} ${whole % 60 === 0 ? 'hour' : 'minute'}${n === 1 ? '' : 's'}`;
};

/** Why recording could not start, in words the recruiter can act on. */
function startProblem(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'The Book is not allowed to use the microphone. Click the icon at the left end of the address bar, switch Microphone to Allow, then press Record now again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Plug one in, or check your headset is connected, then press Record now again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone could not be opened. Another app may be using it: close that app, or choose a different microphone in your browser settings, and try again.';
    case 'NotSupportedError':
      return 'This browser cannot record calls. Use a recent version of Chrome, Edge, Firefox or Safari.';
    case 'InsecureError':
      return 'Recording only works when The Book is opened at a secure address (one that starts with https).';
    case 'BusyError':
      return 'A call is already being recorded in another tab of this browser. Stop that recording first.';
    default:
      return err?.status ? err.message : 'The recording could not be started. Check your connection and try again.';
  }
}

export function RecorderProvider({ children }) {
  const { user } = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const location = useLocation();
  const onOracle = useRef(false); // is the recruiter looking at The Oracle right now, or working somewhere else in The Book?
  onOracle.current = location.pathname.startsWith('/oracle');
  const rec = useRef(null);
  const recovering = useRef(null);
  const stoppedShort = useRef(false); // a call ended in this page without reaching the server (as opposed to the page closing)
  const [state, setState] = useState('idle'); // idle | starting | recording | paused | stopping
  const [session, setSession] = useState(null); // { callId, title, subject: { name, job_title } | null }
  const [waiting, setWaiting] = useState(0); // parts of the recording waiting for the connection to come back
  const [callAudio, setCallAudio] = useState(null); // { surface } while the other side of the call is being recorded
  const [note, setNote] = useState(null); // { tone: 'info' | 'warn', text } shown with the recording controls
  const [recovered, setRecovered] = useState(null); // { call_id } once an interrupted recording was saved, { failed: true } while it cannot be
  const [limitMinutes, setLimitMinutes] = useState(null); // the longest a call can be recorded, once the server has said
  const [minutesLeft, setMinutesLeft] = useState(null); // set for the last ten minutes before that limit
  const startedAt = useRef(0);

  const reset = () => { rec.current = null; setState('idle'); setSession(null); setWaiting(0); setCallAudio(null); setNote(null); setMinutesLeft(null); };

  /** Finish a recording that was cut off (a reload, a crash, a lost connection at the end of a call). */
  const recover = useCallback(() => {
    recovering.current ??= ChunkUploader.recover({ userId: user.id })
      .then((result) => {
        setRecovered(result?.call_id ? { call_id: result.call_id, late: stoppedShort.current } : null);
        if (!result?.busy) stoppedShort.current = false;
        return result;
      })
      .catch(() => { setRecovered({ failed: true }); return { failed: true }; })
      .finally(() => { recovering.current = null; });
    return recovering.current;
  }, [user.id]);

  useEffect(() => {
    recover();
    const online = () => { if (!rec.current && ChunkUploader.interrupted(user.id)) recover(); };
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('online', online);
      // Signed out (or the session ended) in the middle of a call: let go of the microphone. What was recorded stays in
      // this browser and is sent the next time this person opens The Book here.
      rec.current?.abandon();
    };
  }, [recover, user.id]);

  // Closing or reloading the tab would cut the call off, so the browser asks first.
  const live = state === 'recording' || state === 'paused';
  useEffect(() => {
    if (!live && state !== 'stopping') return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [live, state]);

  const start = useCallback(async ({ consent, title, application_id, subject }) => {
    if (rec.current) throw new Error('A call is already being recorded.');
    setState('starting');
    setNote(null);
    const r = new CallRecorder();
    rec.current = r;
    try {
      // An earlier, interrupted recording is saved first, so the two never mix.
      const earlier = await (recovering.current || (ChunkUploader.interrupted(user.id) ? recover() : null));
      if (earlier?.busy) throw Object.assign(new Error('Busy'), { name: 'BusyError' });
      if (earlier?.failed) throw Object.assign(new Error('An earlier recording has not finished saving yet. Check your connection and try again in a moment.'), { status: 409 });
      const made = await r.start({ consent, title, application_id, userId: user.id });
      setSession({ callId: made.call_id, title: title || '', subject: subject || null });
      // The server counts a call's length from the moment it started, pauses included, so this does the same.
      startedAt.current = Date.now();
      api.get('/oracle/status').then((s) => setLimitMinutes(s?.maxRecordingMinutes > 0 ? s.maxRecordingMinutes : null)).catch(() => {});
    } catch (err) {
      reset();
      throw new Error(startProblem(err));
    }
    r.addEventListener('statechange', () => { if (r.state === 'recording' || r.state === 'paused' || r.state === 'stopping') setState(r.state); });
    r.addEventListener('micended', () => setNote({ tone: 'warn', text: 'The microphone was disconnected. What was recorded up to now is safe: press Stop to save the call.' }));
    r.addEventListener('callaudioended', () => { setCallAudio(null); setNote({ tone: 'info', text: 'The call’s tab is no longer being shared. Your microphone is still recording.' }); });
    r.uploader.addEventListener('retry', (e) => setWaiting(e.detail.pending));
    r.uploader.addEventListener('progress', (e) => setWaiting((w) => (w ? e.detail.pending : 0)));
    r.uploader.addEventListener('fatal', async (e) => {
      // The server will not take any more of this call. Stop here rather than record into nowhere.
      // Signed out: show the sign-in screen, which lets go of the microphone; what this browser holds is sent after signing in.
      if (e.detail.status === 401) return window.dispatchEvent(new Event('auth:expired'));
      if (e.detail.message) toast(e.detail.message, 'error');
      if (r.state !== 'recording' && r.state !== 'paused') return; // Stop was already pressed, and deals with it below
      // The call reached its limit, or was removed: save what arrived.
      await r.abandon();
      reset();
      stoppedShort.current = true;
      recover();
    });
    setState(r.state);
  }, [recover, user.id]);

  const stop = useCallback(async (how) => {
    const r = rec.current;
    if (!r || (r.state !== 'recording' && r.state !== 'paused')) return;
    const atLimit = how?.atLimit === true; // stopped by the clock below, not by the recruiter
    try {
      const result = await r.stop();
      reset();
      // Stopped from The Oracle, the recruiter goes straight to the call. Stopped from the strip while working somewhere
      // else (a candidate's profile, with a note half typed), they stay where they are and are offered the call.
      if (onOracle.current && !atLimit) {
        toast('Call saved');
        navigate(`/oracle/${result.call_id}`);
      } else {
        setRecovered({ call_id: result.call_id, late: true, atLimit });
      }
    } catch (err) {
      // Whatever went wrong, the parts not yet sent are still in this browser. Say why if the server gave a reason,
      // then finish the call from what is held (now if possible, otherwise when the connection is back).
      reset();
      stoppedShort.current = true;
      if (err?.status && err.status !== 401) toast(err.message, 'error');
      await recovering.current;
      recover();
    }
  }, [navigate, toast, recover]);

  // A call can only be so long. The server refuses anything after that, so the recording is stopped and saved here
  // when the time comes, and the recruiter is warned for the ten minutes before.
  useEffect(() => {
    if (!live || !limitMinutes) return undefined;
    const check = () => {
      const left = limitMinutes - (Date.now() - startedAt.current) / 60000;
      setMinutesLeft(left <= 10 ? Math.max(0, left) : null);
      if (left <= 0) stop({ atLimit: true });
    };
    check();
    const timer = setInterval(check, 5_000);
    return () => clearInterval(timer);
  }, [live, limitMinutes, stop]);

  const addCallAudio = useCallback(async () => {
    const result = await rec.current?.addCallAudio() ?? { ok: false, reason: 'not-recording' };
    if (result.ok) {
      setCallAudio({ surface: result.surface });
      setNote(null);
    } else if (result.reason === 'no-audio') {
      setNote({ tone: 'warn', text: 'That was shared without its sound, so the other side of the call is still not being recorded. Try again: choose the tab the call is in and tick “Also share tab audio”.' });
    } else if (result.reason !== 'cancelled' && result.reason !== 'not-recording') {
      setNote({ tone: 'warn', text: 'This browser could not share the call’s sound. Put the call on speaker so the microphone picks up both sides.' });
    }
    return result;
  }, []);

  const value = useMemo(() => ({
    state, live, session, waiting, callAudio, note, recovered, limitMinutes, minutesLeft,
    start, stop, addCallAudio,
    pause: () => rec.current?.pause(),
    resume: () => rec.current?.resume(),
    level: (name) => rec.current?.level(name) ?? 0,
    elapsed: () => rec.current?.elapsedMs ?? 0,
    clearNote: () => setNote(null),
    retryRecovery: recover,
    dismissRecovered: () => setRecovered(null),
  }), [state, live, session, waiting, callAudio, note, recovered, limitMinutes, minutesLeft, start, stop, addCallAudio, recover]);

  return <RecorderContext.Provider value={value}>{children}</RecorderContext.Provider>;
}

/** The running time of the call. It redraws itself, so the rest of the page does not have to. */
export function Elapsed({ className }) {
  const { elapsed } = useRecorder();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 250); return () => clearInterval(t); }, []);
  return <span className={cx('tabular', className)} role="timer" aria-label="Time recorded">{formatElapsed(elapsed())}</span>;
}

/** A bar that follows the loudness of the microphone ('mic') or of the shared call ('call'). */
export function LevelMeter({ source = 'mic', className, barClassName = 'bg-brand-600' }) {
  const { level } = useRecorder();
  const bar = useRef(null);
  const latest = useRef(level);
  latest.current = level;
  useEffect(() => {
    let frame;
    let shown = 0;
    const draw = () => {
      const now = latest.current(source);
      shown = now > shown ? now : shown * 0.9 + now * 0.1; // jump up with the voice, fall back gently
      if (bar.current) bar.current.style.width = `${Math.round(shown * 100)}%`;
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [source]);
  return (
    <span className={cx('block h-1.5 overflow-hidden rounded-full', className)} role="img" aria-label={source === 'call' ? 'Sound level of the call' : 'Sound level of your microphone'}>
      <span ref={bar} data-level={source} className={cx('block h-full rounded-full', barClassName)} style={{ width: 0 }} />
    </span>
  );
}

/** Who or what the call in progress is, for the bar and the recording card. */
export const sessionLabel = (session) => session?.title || (session?.subject?.name ? `Call with ${session.subject.name}` : 'Call in progress');

/**
 * The strip across the top of the workspace. While a call is being recorded it shows the red dot, the time, the level
 * and the controls on every page; after an interrupted recording it says what happened to it.
 */
export function RecorderStrip() {
  const { state, live, session, waiting, recovered, limitMinutes, minutesLeft, pause, resume, stop, retryRecovery, dismissRecovered } = useRecorder();
  const strip = useRef(null);
  const shown = live || state === 'stopping' || Boolean(recovered);

  // Drawers and dialogs cover the whole window; they start below the strip so it is never hidden.
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!shown || !strip.current) { root.style.removeProperty('--recording-bar'); return undefined; }
    const measure = () => root.style.setProperty('--recording-bar', `${strip.current.offsetHeight}px`);
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(strip.current);
    return () => { watcher.disconnect(); root.style.removeProperty('--recording-bar'); };
  }, [shown, live, state, recovered]);

  if (live || state === 'stopping') {
    const paused = state === 'paused';
    const button = 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors';
    return (
      <div ref={strip} role="region" aria-label="Call recording" className={cx('no-print flex h-11 shrink-0 items-center gap-3 px-3 text-sm text-white sm:px-4', paused ? 'bg-stone-800' : 'bg-red-700')}>
        {/* The dot, the word and the time are together the way back to The Oracle from any page. */}
        <Link to="/oracle" title="Open The Oracle" className="flex shrink-0 items-center gap-2.5 rounded-md hover:opacity-90">
          <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
            {state === 'recording' && <span className="absolute inline-flex size-full animate-ping rounded-full bg-white/70" />}
            <span className={cx('relative inline-flex size-2.5 rounded-full', paused ? 'bg-stone-400' : 'bg-white')} />
          </span>
          <span className="font-semibold whitespace-nowrap">{state === 'stopping' ? 'Saving the call' : paused ? 'Paused' : 'Recording'}</span>
          <Elapsed className="font-medium" />
        </Link>
        <LevelMeter className="w-12 shrink-0 bg-white/25 min-[420px]:w-20 sm:w-28" barClassName="bg-white" />
        <Link to="/oracle" className="hidden min-w-0 truncate text-white/90 underline decoration-white/40 underline-offset-2 hover:text-white md:block">{sessionLabel(session)}</Link>
        {waiting > 0 && <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] text-white/90" title="Connection lost. Still recording."><WifiOff className="size-3.5 shrink-0" /><span className="truncate max-sm:sr-only">Connection lost. Still recording.</span></span>}
        {minutesLeft !== null && state !== 'stopping' && <span className="hidden text-[13px] font-medium whitespace-nowrap text-white sm:inline">About {Math.max(1, Math.round(minutesLeft))} min left</span>}
        <span className="flex-1" />
        {state === 'stopping' ? <LoaderCircle className="size-4 animate-spin" aria-label="Saving" /> : (
          <>
            <button type="button" onClick={paused ? resume : pause} className={cx(button, 'bg-white/15 hover:bg-white/25')}>
              {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}<span className="max-[420px]:sr-only">{paused ? 'Resume' : 'Pause'}</span>
            </button>
            <button type="button" onClick={stop} className={cx(button, paused ? 'bg-white text-stone-900 hover:bg-stone-100' : 'bg-white text-red-800 hover:bg-red-50')}>
              <Square className="size-3 fill-current" />Stop
            </button>
          </>
        )}
      </div>
    );
  }

  if (recovered?.call_id) {
    return (
      <div ref={strip} role="status" className="no-print flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-brand-200 bg-brand-50 px-4 py-2.5 text-sm text-brand-950">
        <CircleCheck className="size-4 shrink-0 text-brand-700" />
        <span className="min-w-0 flex-1 basis-64">
          {recovered.atLimit ? `This call reached the longest a call can be recorded${limitMinutes ? ` (${limitWords(limitMinutes)})` : ''}, so the recording was stopped. It has been saved.`
            : recovered.late ? 'The call you recorded has been saved.'
            : 'You were recording a call when this page closed. What was recorded has been saved.'}
        </span>
        <Link to={`/oracle/${recovered.call_id}`} onClick={dismissRecovered} className="font-medium text-brand-800 underline underline-offset-2 hover:text-brand-950">Open the call</Link>
        <button type="button" onClick={dismissRecovered} aria-label="Dismiss" className="rounded-md p-1 text-brand-700 hover:bg-brand-100"><X className="size-4" /></button>
      </div>
    );
  }
  if (recovered?.failed) {
    return (
      <div ref={strip} role="alert" className="no-print flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-950">
        <TriangleAlert className="size-4 shrink-0 text-amber-700" />
        <span className="min-w-0 flex-1 basis-64">The end of a call you recorded has not reached The Book yet. It is kept safe in this browser: do not clear your browsing data until it has been saved.</span>
        <button type="button" onClick={retryRecovery} className="font-medium text-amber-900 underline underline-offset-2 hover:text-amber-950">Try again now</button>
      </div>
    );
  }
  return null;
}

/** A round microphone badge, used wherever a call stands in for a person's photo. */
export function MicBadge({ size = 32, className }) {
  return (
    <span className={cx('inline-flex shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700 ring-1 ring-brand-100 ring-inset', className)} style={{ width: size, height: size }} aria-hidden="true">
      <Mic style={{ width: size * 0.5, height: size * 0.5 }} />
    </span>
  );
}
