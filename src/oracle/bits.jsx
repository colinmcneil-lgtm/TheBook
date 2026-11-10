// Pieces shared by The Oracle's pages and the Calls tab on a candidate's profile.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Check, Copy, Info, LoaderCircle, Search, UserPlus, X } from 'lucide-react';
import { api, url, fmtDate, jobLine, photoUrl } from '../lib.js';
import { useApp, useApi } from '../state.jsx';
import { Avatar, Badge, Button, Checkbox, Input, Modal, useAction, useToast, cx } from '../ui.jsx';
import { AddCandidateModal } from '../components/CandidateModals.jsx';
import { OFFERED_BY } from './calls.js';

export { callWhen, fmtLength, madeBy } from './calls.js';

// ---- words for a call ---------------------------------------------------------------------------------------------------
const STATUS = {
  recording: { label: 'Recording', tone: 'red' },
  uploaded: { label: 'Saved', tone: 'gray' },
  transcribing: { label: 'Transcribing', tone: 'amber' },
  ready: { label: 'Ready', tone: 'green' },
  failed: { label: 'Could not be transcribed', tone: 'red' },
};
/** Where a call has got to. */
export function CallStatus({ status }) {
  const s = STATUS[status] || STATUS.uploaded;
  return <Badge tone={s.tone} icon={status === 'transcribing' ? Spinner : undefined}>{s.label}</Badge>;
}
const Spinner = ({ className }) => <LoaderCircle className={cx(className, 'animate-spin')} />;

/** What to call a call: its own title, else who it was with, else the day it was recorded. */
export const callName = (call) => call.title || (call.candidate_name ? `Call with ${call.candidate_name}` : `Call on ${fmtDate(call.created_at)}`);

/** Marks a call that was recorded in Metaview and brought in from there. Nothing for calls recorded or uploaded in The Book. */
export function MetaviewMark({ call }) {
  return call.source === 'metaview' ? <Badge tone="violet">Metaview</Badge> : null;
}

/** A position in the recording, "2:07" or "1:02:07". */
export function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const pad = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

// ---- loading that can repeat ----------------------------------------------------------------------------------------------
/**
 * Like useApi, with two additions these screens need: `reload()` after a change, and checking again every few seconds
 * while `poll(data)` says something is still in progress (a call being transcribed).
 */
export function useLive(path, poll, everyMs = 4000) {
  const { version } = useApp();
  const [state, setState] = useState({ path: null, data: null, error: null });
  const latest = useRef(path);
  latest.current = path;
  const load = useCallback(() => {
    if (!path) return Promise.resolve();
    return api.get(path)
      .then((data) => { if (latest.current === path) setState({ path, data, error: null }); })
      .catch((err) => {
        // A failed re-check keeps what is on screen; a failed first load says why in plain words.
        const message = err.status ? err.message : 'The Book could not be reached. Check your connection and try again.';
        if (latest.current === path) setState((s) => (s.path === path && s.data ? s : { path, data: null, error: message }));
      });
  }, [path]);
  useEffect(() => { load(); }, [load, version]);
  const fresh = state.path === path;
  const again = Boolean(fresh && state.data && poll?.(state.data));
  useEffect(() => {
    if (!again) return undefined;
    const timer = setInterval(load, everyMs);
    return () => clearInterval(timer);
  }, [again, load, everyMs]);
  const set = useCallback((data) => setState({ path, data, error: null }), [path]);
  return { data: fresh ? state.data : null, error: fresh ? state.error : null, reload: load, set };
}

// ---- what the address says ------------------------------------------------------------------------------------------------
/**
 * The address's query (?tab=…&q=…) and a way to change parts of it: `change({ q: 'dana', show: '' })` sets one and
 * removes the other. It works from the address as it is at that moment, not as it was when the screen was last
 * drawn, so a change made a little later (after a pause in typing, or when an answer arrives) never undoes one
 * made in between. Changes replace the current entry in the browser's history unless `replace` is false.
 */
export function useQuery() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const go = useRef(navigate);
  go.current = navigate;
  const change = useCallback((changes, { replace = true } = {}) => {
    const next = new URLSearchParams(window.location.search);
    for (const [name, value] of Object.entries(changes)) (value === null || value === undefined || value === '' ? next.delete(name) : next.set(name, value));
    const query = next.toString();
    if (query !== window.location.search.replace(/^\?/, '')) go.current({ search: query ? `?${query}` : '' }, { replace });
  }, []);
  return [params, change];
}

// ---- choosing the candidate -----------------------------------------------------------------------------------------------
/** The few facts about an application that the picker shows and hands back. */
export const pickOf = (row) => row && ({
  application_id: row.application_id ?? row.id, candidate_id: row.candidate_id, name: row.name ?? row.candidate_name,
  photo: row.photo ?? row.candidate_photo ?? null, job_title: row.job_title, client_name: row.client_name,
});

/**
 * "Who is this call with?" Search people by name and choose one. Someone being considered for several jobs is listed
 * once with each job underneath, because a call is added to one job's application.
 */
export function CandidatePicker({ value, onChange, label = 'Who is this call with?', hint, autoFocus }) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(text.trim()), 250); return () => clearTimeout(t); }, [text]);
  const searching = query.length >= 2;
  const { data: rows, loading, error } = useApi(searching ? url('/applications', { q: query, status: 'all' }) : null);

  if (value) {
    return (
      <div>
        <span className="mb-1 block text-[13px] font-medium text-stone-700">{label}</span>
        <div className="flex items-center gap-3 rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2">
          <Avatar name={value.name} size={32} src={photoUrl(value.candidate_id, value.photo)} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-stone-900">{value.name}</span>
            <span className="block truncate text-[13px] text-stone-600">{jobLine(value)}</span>
          </span>
          <Button size="sm" variant="ghost" icon={X} onClick={() => { onChange(null); setText(''); }}>Change</Button>
        </div>
      </div>
    );
  }

  // One entry per person, each with the jobs they are in. The search also looks at job titles, employers and email
  // addresses, so people whose name matches come first: typing "ma" for Maya must not bury her under every manager.
  const people = [];
  for (const row of (searching && rows) || []) {
    let person = people.find((p) => p.candidate_id === row.candidate_id);
    if (!person) people.push(person = { ...row, jobs: [] });
    person.jobs.push(row);
  }
  const named = (p) => (p.name || '').toLowerCase().includes(query.toLowerCase());
  people.sort((a, b) => named(b) - named(a)); // keeps the server's order within each group
  const SHOWN = 12;
  const who = (p) => [p.current_title, p.current_company].filter(Boolean).join(' at ') || p.email || '';
  // Someone saved to The Book without a job is listed too: a call can be about them before there is any job to name.
  const standing = (row) => (!row.job_title ? '' : row.status === 'active' ? row.stage_name : row.status === 'hired' ? 'Hired' : row.status === 'rejected' ? 'Rejected' : 'Withdrawn');

  return (
    <div>
      <label className="block">
        <span className="mb-1 block text-[13px] font-medium text-stone-700">{label}</span>
        <span className="relative block">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-stone-400 max-sm:top-3.5" />
          {/* Enter here must not submit the form around it: on The Oracle that form starts a recording. */}
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search candidates by name" className="pl-9 max-sm:!h-11 max-sm:!text-base" autoFocus={autoFocus} autoComplete="off"
            onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
        </span>
      </label>
      {searching ? (
        <div className="mt-1.5 max-h-64 overflow-y-auto rounded-lg border border-line bg-white" role="listbox" aria-label="Matching candidates">
          {error ? <p className="px-3 py-2.5 text-sm text-red-700">{error}</p>
            : !rows && loading ? <p className="px-3 py-2.5 text-sm text-stone-500">Searching…</p>
            : !people.length ? <p className="px-3 py-2.5 text-sm text-stone-500">Nobody in The Book matches “{query}”.</p>
            : (
              <ul className="divide-y divide-line">
                {people.slice(0, SHOWN).map((p) => (p.jobs.length === 1 ? (
                  <li key={p.candidate_id}>
                    <button type="button" role="option" aria-selected="false" onClick={() => onChange(pickOf(p))} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-stone-50">
                      <Avatar name={p.name} size={30} src={photoUrl(p.candidate_id, p.photo)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-stone-500"><span className="font-medium text-stone-900">{p.name}</span>{who(p) ? ` · ${who(p)}` : ''}</span>
                        <span className="block truncate text-[13px] text-stone-600">{p.job_title ? `For ${jobLine(p)}` : jobLine(p)}</span>
                      </span>
                    </button>
                  </li>
                ) : (
                  <li key={p.candidate_id} className="px-3 py-2">
                    <span className="flex items-center gap-3">
                      <Avatar name={p.name} size={30} src={photoUrl(p.candidate_id, p.photo)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-stone-500"><span className="font-medium text-stone-900">{p.name}</span>{who(p) ? ` · ${who(p)}` : ''}</span>
                        <span className="block truncate text-[13px] text-stone-600">Being considered for {p.jobs.length} jobs. Which one is this call about?</span>
                      </span>
                    </span>
                    <span className="mt-1.5 flex flex-col gap-1 pl-[42px]">
                      {p.jobs.map((row) => (
                        <button key={row.id} type="button" role="option" aria-selected="false" onClick={() => onChange(pickOf(row))}
                          className="flex items-center justify-between gap-3 rounded-md border border-line px-2.5 py-1.5 text-left text-[13px] hover:border-brand-300 hover:bg-brand-50/50">
                          <span className="min-w-0 truncate font-medium text-stone-800">{jobLine(row)}</span>
                          <span className="shrink-0 text-xs text-stone-500">{standing(row)}</span>
                        </button>
                      ))}
                    </span>
                  </li>
                )))}
                {people.length > SHOWN && <li className="px-3 py-2 text-[13px] text-stone-500">More people match. Type more of the name to find them.</li>}
              </ul>
            )}
        </div>
      ) : hint ? <span className="mt-1 block text-xs text-stone-500">{hint}</span> : null}
    </div>
  );
}

/**
 * Add a call to a candidate after it was recorded (or move it to someone else). When the person is not in The Book
 * yet, the usual Add candidate dialog opens and the call is added to them once they are saved.
 * A Metaview call may come with `suggestions` (the people in The Book it could belong to), which are offered first,
 * and with its own way to `save` the choice, because choosing may be what brings the call into The Book.
 */
export function AttachModal({ call, current, suggestions, save: saveChoice, saveLabel, onClose, onDone }) {
  const toast = useToast();
  const [picked, setPicked] = useState(null);
  const [adding, setAdding] = useState(false);
  const attach = async (applicationId, name) => {
    const updated = await (saveChoice ? saveChoice(applicationId) : api.patch(`/oracle/calls/${call.id}`, { application_id: applicationId }));
    toast(name ? `Call added to ${name}` : 'Call added to the candidate');
    onDone(updated);
  };
  const [save, busy] = useAction(async () => { await attach(picked.application_id, picked.name); onClose(); });
  const [afterAdding] = useAction(async (applicationId) => attach(applicationId));

  if (adding) return <AddCandidateModal onClose={onClose} onAdded={afterAdding} />;
  return (
    <Modal title={current ? 'Move this call to another candidate' : 'Add this call to a candidate'} subtitle={callName(call)} size="sm" onClose={onClose} onSubmit={save}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy} disabled={!picked}>{busy && saveLabel ? saveLabel : current ? 'Move call' : 'Add call'}</Button></>}>
      {!picked && suggestions?.length > 0 && (
        <div>
          <span className="mb-1 block text-[13px] font-medium text-stone-700">{suggestions.length === 1 ? 'This could be' : 'This could be one of these'}</span>
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line" aria-label="Possible candidates">
            {suggestions.map((s) => (
              <li key={s.application_id}>
                <button type="button" onClick={() => setPicked(pickOf(s))} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-stone-50">
                  <Avatar name={s.name} size={32} src={photoUrl(s.candidate_id, s.photo)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-stone-900">{s.name}</span>
                    <span className="block truncate text-[13px] text-stone-600">{jobLine(s)}</span>
                  </span>
                  {OFFERED_BY[s.how] && <span className="shrink-0 text-xs text-stone-500">{OFFERED_BY[s.how]}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <CandidatePicker value={picked} onChange={setPicked} autoFocus={!suggestions?.length} label={suggestions?.length && !picked ? 'Or search for someone else' : undefined} hint="Type at least two letters of their name." />
      {current && call.submission && <Notice tone="warn">The submission draft was written for the job this call is on now, so it is removed when the call moves.</Notice>}
      {current && call.note_saved && <Notice tone="warn">The notes saved to {call.candidate_name ? `${call.candidate_name}’s` : 'the current'} profile from this call are removed from it if the call moves to somebody else. You can save them to the new profile afterwards.</Notice>}
      {/* Someone new can be saved with no job yet, so this works in a workspace that has no jobs at all. */}
      <p className="text-[13px] text-stone-600">
        Not in The Book yet?{' '}
        <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline"><UserPlus className="size-3.5" />Add them as a new candidate</button>
        {' '}and the call is added to them.
      </p>
    </Modal>
  );
}

// ---- small things -----------------------------------------------------------------------------------------------------------
/** "Mine" or "Everyone": whose calls a list shows. */
export function WhoToggle({ everyone, onChange }) {
  const option = (label, on, value) => (
    <button type="button" aria-pressed={on} onClick={() => onChange(value)}
      className={cx('rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors', on ? 'bg-white text-stone-900 shadow-sm ring-1 ring-line' : 'text-stone-500 hover:text-stone-800')}>{label}</button>
  );
  return <div className="flex shrink-0 gap-0.5 rounded-lg bg-stone-100 p-0.5" role="group" aria-label="Whose calls to show">{option('Mine', !everyone, 'mine')}{option('Everyone', everyone, 'everyone')}</div>;
}

/** The top of a card in The Oracle: a round badge, what the card is called, and what it is for in a line or two. */
export function CardIntro({ icon: Icon, title, action, children }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-950 text-gold ring-1 ring-gold/50"><Icon className="size-5" /></span>
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-semibold tracking-tight text-stone-900">{title}</h2>
        {children && <p className="mt-0.5 text-[13px] leading-snug text-stone-500">{children}</p>}
      </div>
      {action}
    </div>
  );
}

/** The consent tick box, shared by recording and uploading. It turns red when someone tries to go on without it. */
export function ConsentTick({ checked, onChange, missing, wording }) {
  return (
    <div className={cx('rounded-lg border px-3 py-2.5', missing ? 'border-red-300 bg-red-50' : 'border-line bg-stone-50')}>
      <Checkbox checked={checked} onChange={(e) => onChange(e.target.checked)} label={wording}
        hint={missing ? 'Tick this box first. Calls may only be recorded when everyone on them has agreed.' : 'Your confirmation is kept with the call.'} />
    </div>
  );
}

/** A quiet explanation box. */
export function Notice({ tone = 'info', className, children }) {
  const tones = { info: 'border-line bg-stone-50 text-stone-600', warn: 'border-amber-200 bg-amber-50 text-amber-950', bad: 'border-red-200 bg-red-50 text-red-900' };
  return (
    <div className={cx('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[13px] leading-relaxed', tones[tone], className)}>
      <Info className="mt-0.5 size-4 shrink-0 opacity-70" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Copy text to the clipboard and say so on the button for a moment. */
export function CopyButton({ text, label = 'Copy', ...props }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1800);
    } catch { toast('Copying is blocked in this browser. Select the text and copy it yourself.', 'error'); }
  };
  return <Button size="sm" icon={done ? Check : Copy} onClick={copy} {...props}>{done ? 'Copied' : label}</Button>;
}

/**
 * Notes as the server writes them: plain text where a short line followed by "- " lines is a heading and "- " lines
 * are bullets. Anything else is an ordinary paragraph.
 */
export function NotesText({ text }) {
  const lines = String(text || '').split('\n').map((l) => l.trimEnd());
  const isBullet = (l) => /^\s*[-•]\s+/.test(l || '');
  const blocks = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    if (isBullet(line)) {
      if (blocks.at(-1)?.type !== 'list') blocks.push({ type: 'list', items: [] });
      blocks.at(-1).items.push(line.replace(/^\s*[-•]\s+/, ''));
    } else {
      const next = lines.slice(i + 1).find((l) => l.trim());
      blocks.push({ type: isBullet(next) && line.length <= 80 ? 'heading' : 'text', text: line.trim() });
    }
  });
  return (
    <div className="space-y-1.5 text-sm leading-relaxed text-stone-800">
      {blocks.map((b, i) => (b.type === 'heading' ? <h4 key={i} className="pt-2 font-semibold text-stone-900 first:pt-0">{b.text}</h4>
        : b.type === 'list' ? <ul key={i} className="list-disc space-y-1 pl-5 marker:text-stone-400">{b.items.map((item, j) => <li key={j}>{item}</li>)}</ul>
        : <p key={i}>{b.text}</p>))}
    </div>
  );
}
