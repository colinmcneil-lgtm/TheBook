import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, ArrowUpToLine, Briefcase, CalendarDays, Check, Ellipsis, FileText, GraduationCap, MessagesSquare, Plus, Search, StickyNote, X } from 'lucide-react';
import { useApp, useApi, useOpenCandidate, Pending } from '../state.jsx';
import { api, url, ago, daysSince, fmtDateTime, fmtDay, fmtTime, photoUrl, plural } from '../lib.js';
import { Avatar, Button, Card, CardHeader, Empty, Field, Input, Menu, Modal, Page, Select, Textarea, useToast, cx } from '../ui.jsx';
import { ClientName, JobStatusBadge, StageBadge } from '../components/bits.jsx';
import { DragGhost, DropSlot, Grip, useDragDrop } from '../components/DragDrop.jsx';

// The three lists, by the name the server gives each kind of item.
const LISTS = {
  job: { title: 'Jobs to work on', picker: 'pick-jobs', add: 'Add jobs', icon: Briefcase, ticked: 'done',
    hint: 'Each job you tick counts as one cycle on it. The whole team sees it on Cycles: who ticked it and when, never your note.' },
  prep: { title: 'People to prep', picker: 'pick-people', add: 'Add people', icon: GraduationCap, ticked: 'prepped',
    hint: 'The Book adds people here by itself, seven days before an interview on a job you are the account executive of, or for your own candidates on a job with none.' },
  debrief: { title: 'People to debrief', picker: 'pick-people', add: 'Add people', icon: MessagesSquare, ticked: 'debriefed',
    hint: 'The Book adds people here by itself, when an interview has ended on a job you are the account executive of, or for your own candidates on a job with none.' },
};
/** What an item is called: the job's title or the person's name. */
const nameOf = (item) => item.title ?? item.name;
/** The line under it: which client the job is for, or which job the person is in. */
const aboutOf = (item) => (item.title ? item.client_name : `${item.job_title} · ${item.client_name}`);

// A picker sits beside its list when the window is at least this wide. Narrower than that (a phone, a tablet on its
// side, a small laptop window with the menu down its left) the lists get the whole width, so their rows are never
// squeezed, and each picker is behind an "Add" button. BESIDE is the same width, written out for the stylesheet.
const WIDE = '(min-width: 1100px)';
const BESIDE = 'grid grid-cols-1 items-start gap-6 min-[1100px]:grid-cols-[minmax(0,1fr)_min(420px,42%)]';

/** Is the window wide enough for a picker to sit beside its list? */
function useWide() {
  const query = WIDE;
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const changed = () => setWide(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  return wide;
}

/** "Today, 10:30", "Tomorrow, 14:00", or the day and time in full. */
function when(date) {
  const day = fmtDay(date);
  return ['Today', 'Tomorrow', 'Yesterday'].includes(day) ? `${day}, ${fmtTime(date)}` : fmtDateTime(date);
}

/**
 * The last line of a row, and the short note under it ("find 5 more by Friday"). With no note yet, "Add a note" sits
 * at the end of that line, so the row is no taller for it. Click the note to change it; Enter saves, Escape leaves
 * it as it was.
 */
function NoteLine({ value, about, onSave, children }) {
  const [draft, setDraft] = useState(null); // null while it is only being read
  const left = useRef(false);
  const edit = () => { left.current = false; setDraft(value || ''); };
  // Closed with Enter or Escape, the keyboard's focus goes back to the note it was opened from, not to the top of the page.
  const opener = useRef(null);
  const byKey = useRef(false);
  useLayoutEffect(() => {
    if (draft !== null || !byKey.current) return;
    byKey.current = false;
    opener.current?.focus();
  });
  const save = () => {
    if (left.current) return;
    left.current = true;
    const next = draft.trim();
    setDraft(null);
    if (next !== (value || '')) onSave(next);
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 text-[13px] text-stone-500">
        {children}
        {!value && draft === null && (
          <button ref={opener} type="button" onClick={edit} aria-label={`Add a note to ${about}`} className="inline-flex items-center gap-0.5 rounded text-xs text-stone-400 hover:text-brand-700">
            <Plus className="size-3" aria-hidden="true" />Add a note
          </button>
        )}
      </div>
      {value && draft === null && (
        <button ref={opener} type="button" onClick={edit} aria-label={`Change the note on ${about}: ${value}`} className="mt-1 flex items-start gap-1.5 rounded text-left text-[13px] text-stone-700 hover:text-brand-700">
          <StickyNote className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden="true" /><span className="[overflow-wrap:anywhere]">{value}</span>
        </button>
      )}
      {draft !== null && (
        <Input autoFocus value={draft} maxLength={300} aria-label={`Note on ${about}`} placeholder="e.g. find 5 more by Friday" className="mt-1 !h-8"
          onChange={(e) => setDraft(e.target.value)} onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); byKey.current = true; save(); }
            if (e.key === 'Escape') { e.stopPropagation(); byKey.current = true; left.current = true; setDraft(null); }
          }} />
      )}
    </>
  );
}

/** What a job on the list says about itself. */
function JobLines({ item, onNote }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Link to={`/jobs/${item.job_id}`} className="min-w-0 truncate text-sm font-medium text-stone-900 hover:text-brand-700 hover:underline">{item.title}</Link>
        {item.status !== 'open' && <JobStatusBadge status={item.status} />}
      </div>
      <NoteLine value={item.note} about={item.title} onSave={onNote}>
        <ClientName always name={item.client_name} color={item.brand_color} />
        {item.opened_at && item.status === 'open' && <span>Open {daysSince(item.opened_at)}d</span>}
        <span>{item.in_pipeline} in the pipeline</span>
      </NoteLine>
    </>
  );
}

/**
 * What a person to prep or debrief says about themselves: who, for which job, where they stand, and when the
 * interview it is about is (or was). The interview's name is left out when it is only the name of their stage.
 */
function PersonLines({ item, onNote }) {
  const openCandidate = useOpenCandidate();
  const i = item.interview;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {/* On a phone the photo is small and sits with the name, where it costs the lines below no width. */}
        <Avatar name={item.name} size={22} src={photoUrl(item.candidate_id, item.photo)} className="sm:hidden" />
        <button type="button" onClick={() => openCandidate(item.application_id)} title="Open their profile" className="min-w-0 truncate rounded text-left text-sm font-medium text-stone-900 hover:text-brand-700 hover:underline">{item.name}</button>
        <StageBadge app={item} />
      </div>
      {/* The job, then the client: the client goes on a line of its own sooner than be cut off. */}
      <div className="flex flex-wrap items-center gap-x-2 text-[13px] text-stone-500">
        <span className="min-w-0 truncate">{item.job_title}</span>
        <ClientName always name={item.client_name} color={item.brand_color} className="min-w-0 [overflow-wrap:anywhere]" />
        <Link to={`/jobs/${item.job_id}?tab=brief`} className="inline-flex shrink-0 items-center gap-1 font-medium text-brand-700 hover:underline"><FileText className="size-3" aria-hidden="true" />Brief</Link>
      </div>
      <NoteLine value={item.note} about={item.name} onSave={onNote}>
        {i ? (
          <>
            <span className="inline-flex items-center gap-1 font-medium text-stone-800">
              <CalendarDays className="size-3.5 shrink-0 text-sky-700" aria-hidden="true" />{item.kind === 'debrief' ? `Interviewed ${when(i.starts_at)}` : when(i.starts_at)}
            </span>
            {i.title !== item.stage_name && <span className="min-w-0 truncate">{i.title}</span>}
            {item.auto && <span className="text-stone-400">Added by The Book</span>}
          </>
        ) : <span className="text-stone-400">{item.kind === 'prep' ? 'No interview booked in The Book yet' : 'No interview recorded in The Book'}</span>}
      </NoteLine>
    </>
  );
}

/**
 * One list: what is still to do, in the person's own order, then what was ticked in the last seven days. Rows are
 * dragged by their grip; the gap shows where a dragged row would land. On a phone the picker opens inside the card,
 * behind its "Add" button, so the list itself comes first.
 */
function ListCard({ kind, list, dnd, wide, picker, actions }) {
  const meta = LISTS[kind];
  const [adding, setAdding] = useState(false);
  const { drag } = dnd;
  const slot = drag?.over?.zone === kind ? drag.over.index : null;
  const dragged = drag?.from === kind ? drag.item.id : null;
  const others = list.open.filter((item) => item.id !== dragged);
  const person = kind !== 'job';
  // Nothing on the list (and not just because its only row is the one being dragged).
  const empty = !others.length && !dragged;

  const row = (item) => {
    const name = nameOf(item), at = list.open.indexOf(item);
    return (
      <li key={item.id} data-drop-row=""
        className={cx('flex items-start gap-1.5 rounded-lg border border-line bg-white py-2 pr-1 pl-1 sm:gap-2', item.id === dragged && 'invisible absolute')}>
        <Grip label={`Move ${name}. Drag, or use the up and down arrow keys.`} dragging={item.id === dragged} data-grip={item.id} {...dnd.grip(item, kind)}
          onKeyDown={(e) => {
            const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
            if (!step) return;
            e.preventDefault();
            actions.step(item, step);
          }} />
        <input type="checkbox" checked={false} data-tick={item.id} onChange={() => actions.tick(item)} aria-label={`Mark ${name} as ${meta.ticked}`} className="mt-1.5 size-[18px] shrink-0 rounded border-stone-300 accent-brand-700" />
        {person && <Avatar name={item.name} size={32} src={photoUrl(item.candidate_id, item.photo)} className="max-sm:hidden" />}
        <div className="min-w-0 flex-1">
          {person ? <PersonLines item={item} onNote={(note) => actions.note(item, note)} /> : <JobLines item={item} onNote={(note) => actions.note(item, note)} />}
        </div>
        {/* On a phone the two buttons sit one above the other, which leaves the words beside them more room. */}
        <div className="flex shrink-0 items-center max-sm:flex-col">
          <Menu trigger={<Button variant="ghost" size="sm" icon={Ellipsis} data-menu={item.id} aria-label={`Move ${name} up or down`} className="!px-1.5" />}
            items={[
              at > 0 && { label: 'Move up', icon: ArrowUp, onClick: () => actions.move(item, at - 1, 'menu') },
              at < list.open.length - 1 && { label: 'Move down', icon: ArrowDown, onClick: () => actions.move(item, at + 1, 'menu') },
              at > 0 && { label: 'Move to the top', icon: ArrowUpToLine, onClick: () => actions.move(item, 0, 'menu') },
              list.open.length > 1 && null,
              { label: 'Take off the list', icon: X, danger: true, onClick: () => actions.remove(item, 'menu') },
            ]} />
          <Button variant="ghost" size="sm" icon={X} data-off={item.id} aria-label={`Take ${name} off the list`} title="Take off the list" className="!px-1.5" onClick={() => actions.remove(item, 'off')} />
        </div>
      </li>
    );
  };
  // The rows other than the one being dragged, with the gap where it would land.
  const rows = others.map(row);
  if (slot !== null && !empty) rows.splice(Math.min(slot, rows.length), 0, <DropSlot key="slot" height={drag.height}>Drop here</DropSlot>);
  // The dragged row stays in the page, out of sight, so that the finger holding its grip is not left holding nothing.
  if (dragged) rows.push(row(list.open.find((item) => item.id === dragged)));

  return (
    <Card className="min-w-0">
      <CardHeader title={meta.title} count={list.open.length}
        action={(
          <span className="flex items-center gap-3">
            {/* Ticking a job here is a cycle on it: the whole team's are on the Cycles page. */}
            {kind === 'job' && <Link to="/cycles" className="text-[13px] font-medium whitespace-nowrap text-brand-700 hover:underline">See the team’s cycles</Link>}
            {!wide && <Button size="sm" variant={adding ? 'secondary' : 'primary'} icon={adding ? X : Plus} aria-expanded={adding} onClick={() => setAdding(!adding)}>{adding ? 'Close' : meta.add}</Button>}
          </span>
        )} />
      {meta.hint && <p className="px-4 pt-2.5 text-xs text-stone-500">{meta.hint}</p>}
      {!wide && adding && <div className="mx-3 mt-3 rounded-lg border border-line bg-paper">{picker}</div>}
      {/* The list takes the focus itself (data-list) when the last row on it is ticked or taken off with the keyboard. */}
      <ul data-drop-zone={kind} data-list={kind} tabIndex={-1} aria-label={meta.title}
        className={cx('relative m-1.5 flex min-h-16 flex-col gap-2 rounded-lg p-1.5 transition-colors focus-visible:outline-2 focus-visible:outline-brand-500', slot !== null && 'bg-brand-50/60')}>
        {rows}
        {/* While a row is held over a list with nothing on it, the words stay where they are, out of sight, and the
            place to drop covers them. The list must not change height under the pointer: when it did, it shrank away
            from the row, grew back, and the drop was lost as often as not. */}
        {empty && (
          <li className={cx('list-none', slot !== null && 'invisible')}>
            <Empty icon={meta.icon} title={person ? `Nobody to ${kind} yet` : 'No jobs picked yet'}>
              {wide
                ? (person ? `Drag someone across from People at interview, or press “To ${kind}” beside them.` : 'Drag a job across from Open jobs, or press + beside it.')
                : adding
                  ? (person ? `Slide someone down from the list above, or press “To ${kind}” beside them.` : 'Slide a job down from the list above, or press + beside it.')
                  : `Press “${meta.add}” to pick ${person ? 'someone' : 'the jobs you are working on'}.`}
            </Empty>
          </li>
        )}
        {empty && slot !== null && <DropSlot fill>Drop here</DropSlot>}
      </ul>
      {list.done.length > 0 && (
        <div className="border-t border-line px-3 pt-2.5 pb-2">
          <h3 className="px-1 text-xs font-semibold tracking-wide text-stone-500 uppercase">Done <span className="font-normal normal-case">· kept here for seven days</span></h3>
          <ul className="mt-1" aria-label={`${meta.title}: done`}>
            {list.done.map((item) => (
              <li key={item.id} className="flex items-center gap-2 px-1 py-1">
                <input type="checkbox" checked data-untick={item.id} onChange={() => actions.untick(item)} aria-label={`Put ${nameOf(item)} back on the list`} className="size-[18px] shrink-0 rounded border-stone-300 accent-brand-700" />
                <span className="min-w-0 flex-1 truncate text-sm text-stone-500"><span className="line-through">{nameOf(item)}</span><span className="text-stone-400"> · {aboutOf(item)}</span></span>
                {/* A prep The Book ticked because the interview's time went by is not passed off as one the person did. */}
                {item.auto_done
                  ? <span className="shrink-0 text-xs text-stone-400" title="The Book ticked this by itself, because the interview’s time has passed. Nobody marked it as done.">Interview passed</span>
                  : <span className="shrink-0 text-xs text-stone-400">{ago(item.done_at)}</span>}
                <Button variant="ghost" size="sm" icon={X} data-off={item.id} aria-label={`Remove ${nameOf(item)} from the done list`} title="Remove" className="!px-1.5" onClick={() => actions.remove(item, 'off')} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/** Covers a picker while a row from its list is being dragged: letting go here takes the row off the list. */
function TakeOff({ dnd, zone }) {
  const { drag } = dnd;
  if (!drag || LISTS[drag.from]?.picker !== zone) return null;
  const over = drag.over?.zone === zone;
  return (
    <div className={cx('pointer-events-none absolute inset-0 z-10 flex items-start justify-center rounded-lg border-2 border-dashed px-4 pt-5 text-center text-sm font-medium',
      over ? 'border-red-400 bg-red-50/95 text-red-800' : 'border-stone-300 bg-white/85 text-stone-600')}>
      Drop here to take it off your list
    </div>
  );
}

function SearchBox({ value, onChange, label }) {
  return (
    <div className="relative min-w-44 flex-1">
      <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-stone-400" aria-hidden="true" />
      <Input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={label} aria-label={label} className="pl-8" />
    </div>
  );
}

/**
 * Every open job, to pick from: drag one across to the list, or press its +. (A picker's grips are for the mouse and
 * the finger only; with the keyboard, the buttons do the same.)
 */
function JobPicker({ dnd, onAdd, onList }) {
  const { clients, scope } = useApp();
  const [q, setQ] = useState('');
  const [client, setClient] = useState(scope ?? '');
  const { data: jobs, error } = useApi(url('/todos/jobs', { q: q.trim(), client_id: client }));
  return (
    <div data-drop-zone="pick-jobs" className="relative">
      <div className="flex flex-wrap gap-2 p-3">
        <SearchBox value={q} onChange={setQ} label="Search open jobs" />
        {clients.length > 1 && (
          <Select value={client} onChange={(e) => setClient(e.target.value)} aria-label="Client" className="!w-auto max-w-full flex-1 sm:max-w-40 sm:flex-none">
            <option value="">All clients</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        )}
      </div>
      {!jobs ? <Pending error={error} className="py-6" /> : !jobs.length ? (
        <p className="px-4 pb-5 text-center text-sm text-stone-500">{q.trim() || client ? 'No open jobs match.' : 'There are no open jobs yet.'}</p>
      ) : (
        <ul className="max-h-64 space-y-1.5 overflow-y-auto px-3 pb-3 min-[1100px]:max-h-[26rem]" aria-label="Open jobs">
          {jobs.map((job) => ({ ...job, on_list: onList('job', job) })).map((j) => (
            <li key={j.id} data-drag-row="" className={cx('flex items-center gap-1.5 rounded-lg border border-line bg-white py-1.5 pr-2 pl-1', dnd.drag?.from === 'pick-jobs' && dnd.drag.item.id === j.id && 'opacity-40')}>
              {j.on_list ? <span className="w-6 shrink-0" /> : <Grip label={`Drag ${j.title} onto your list`} tabIndex={-1} {...dnd.grip(j, 'pick-jobs')} />}
              <div className={cx('min-w-0 flex-1', j.on_list && 'opacity-60')}>
                <div className="truncate text-sm font-medium text-stone-900">{j.title}</div>
                <div className="flex flex-wrap items-center gap-x-2 text-[13px] text-stone-500 xl:flex-nowrap xl:whitespace-nowrap">
                  <ClientName always name={j.client_name} color={j.brand_color} className="shrink-0" />
                  {j.on_list
                    ? <span className="inline-flex items-center gap-1"><Check className="size-3.5" aria-hidden="true" />On your list</span>
                    : <span className="min-w-0 truncate" title={`Open for ${plural(daysSince(j.opened_at), 'day')}, ${j.in_pipeline} in the pipeline`}>Open {daysSince(j.opened_at)}d · {j.in_pipeline} in the pipeline</span>}
                </div>
              </div>
              {!j.on_list && <Button size="sm" icon={Plus} data-add="" aria-label={`Add ${j.title} to your jobs to work on`} title="Add to your list" className="!px-2" onClick={(e) => onAdd('job', j, undefined, e.currentTarget)} />}
            </li>
          ))}
        </ul>
      )}
      <TakeOff dnd={dnd} zone="pick-jobs" />
    </div>
  );
}

/**
 * Candidates at an interview stage of an open job, to pick from: the person's own, or everyone's, and the search
 * box finds anyone by name. Drag one across to a list, or press "To prep" or "To debrief". Opened from one list on
 * a phone (`only`), it offers that list alone.
 */
function PeoplePicker({ dnd, onAdd, onList, only }) {
  const [q, setQ] = useState('');
  const [whose, setWhose] = useState('mine');
  const searching = Boolean(q.trim());
  const { data: people, error } = useApi(url('/todos/people', { q: q.trim(), whose: searching ? null : whose }));
  const kinds = only ? [only] : ['prep', 'debrief'];
  return (
    <div data-drop-zone="pick-people" className="relative">
      <div className="space-y-2 p-3">
        <SearchBox value={q} onChange={setQ} label="Search anyone by name" />
        {searching ? <p className="text-xs text-stone-500">Searching every candidate, whoever they belong to and whatever stage they are at.</p> : (
          <div className="flex rounded-lg border border-line bg-white p-0.5 text-[13px] font-medium" role="group" aria-label="Whose candidates">
            {[['mine', 'Mine'], ['all', 'Everyone’s']].map(([id, label]) => (
              <button key={id} type="button" aria-pressed={whose === id} onClick={() => setWhose(id)}
                className={cx('flex-1 rounded-md px-2 py-1 transition-colors', whose === id ? 'bg-brand-700 text-white' : 'text-stone-600 hover:bg-stone-100')}>{label}</button>
            ))}
          </div>
        )}
      </div>
      {!people ? <Pending error={error} className="py-6" /> : !people.length ? (
        <p className="px-4 pb-5 text-center text-sm text-stone-500">
          {searching ? 'Nobody by that name.' : whose === 'mine' ? 'None of your candidates is at an interview stage of an open job. Look at everyone’s, or search for anyone by name.' : 'Nobody is at an interview stage of an open job yet.'}
        </p>
      ) : (
        <ul className="max-h-[60vh] space-y-1.5 overflow-y-auto px-3 pb-3 min-[1100px]:max-h-[30rem]" aria-label="People at interview">
          {people.map((person) => ({ ...person, on_prep: onList('prep', person), on_debrief: onList('debrief', person) })).map((p) => {
            const free = kinds.filter((kind) => !p[`on_${kind}`]);
            return (
              <li key={p.application_id} data-drag-row="" className={cx('flex items-start gap-1.5 rounded-lg border border-line bg-white py-1.5 pr-2 pl-1', dnd.drag?.from === 'pick-people' && dnd.drag.item.application_id === p.application_id && 'opacity-40')}>
                {free.length ? <Grip label={`Drag ${p.name} onto a list`} tabIndex={-1} {...dnd.grip(p, 'pick-people')} /> : <span className="w-6 shrink-0" />}
                <Avatar name={p.name} size={28} src={photoUrl(p.candidate_id, p.photo)} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="min-w-0 truncate text-sm font-medium text-stone-900">{p.name}</span>
                    <StageBadge app={p} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 text-[13px] text-stone-500">
                    <span className="min-w-0 truncate">{p.job_title}</span>
                    <ClientName always name={p.client_name} color={p.brand_color} className="min-w-0 [overflow-wrap:anywhere]" />
                  </div>
                  <div className="flex flex-wrap gap-x-2 text-[13px] text-stone-500">
                    {p.next_interview ? <span className="font-medium text-stone-700">Interview {when(p.next_interview)}</span> : <span>{p.last_interview ? `Interviewed ${when(p.last_interview)}` : 'No interview booked in The Book'}</span>}
                    {(whose === 'all' || searching) && <span>{p.owner_name ? `Owner: ${p.owner_name}` : 'No owner'}</span>}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {kinds.map((kind) => (p[`on_${kind}`]
                      ? <span key={kind} className="inline-flex h-8 items-center gap-1 px-1 text-xs text-stone-500"><Check className="size-3.5" aria-hidden="true" />On your {kind} list</span>
                      : <Button key={kind} size="sm" icon={Plus} data-add="" aria-label={`Add ${p.name} to people to ${kind}`} onClick={(e) => onAdd(kind, p, undefined, e.currentTarget)}>To {kind}</Button>))}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <TakeOff dnd={dnd} zone="pick-people" />
    </div>
  );
}

/**
 * Ticking a debrief offers one box for what the candidate said; what is typed is saved on their profile. The box
 * stays open, with the words in it, until The Book has answered that they are saved: `onDone` answers with why
 * they were not, or with nothing when they were (and the page has then closed the box).
 */
function DebriefModal({ item, onClose, onDone }) {
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    const why = await onDone(said.trim());
    if (why === null) return;
    setBusy(false);
    setFailed(why);
  };
  return (
    <Modal title={`Debrief with ${item.name}`} subtitle={`${item.job_title} · ${item.client_name}`} size="sm" onClose={onClose} onSubmit={submit}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" icon={Check} busy={busy}>Mark as done</Button></>}>
      <Field label="What did they say?" hint="Optional. Saved on their profile as an agency-only note, which the client’s hiring team never sees.">
        <Textarea rows={5} autoFocus value={said} onChange={(e) => setSaid(e.target.value)} placeholder="How it went, what they liked, any worries, what happens next" />
      </Field>
      {failed && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {failed}{said.trim() && ' What you typed is still here, so you can copy it before you close this box.'}
        </p>
      )}
    </Modal>
  );
}

export default function Todo() {
  const { bump, version } = useApp();
  const toast = useToast();
  const wide = useWide();
  // What is on screen is changed at once and sent to the server afterwards, one change at a time and in order, so a
  // row dragged or moved with a held-down arrow key never jumps back. When the last change has been sent, the lists
  // are read again and what the server says takes over.
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState(null);
  const [mine, setMine] = useState(null);
  // What is being added right now ("job:12"), so that its + goes at once and cannot be pressed a second time.
  const [adding, setAdding] = useState([]);
  const sync = useRef({ waiting: 0, last: Promise.resolve(), readings: 0 });
  const latest = useRef(null);
  const data = mine ?? saved;
  latest.current = data;
  // The lists are read when the page opens and whenever anything in the workspace is saved. Only the newest reading
  // counts, and only when no change is on its way: an answer from before a change would put a row back where it was,
  // and the next arrow key would then move it from the wrong place.
  useEffect(() => {
    const s = sync.current, reading = ++s.readings;
    const counts = () => reading === s.readings && !s.waiting;
    api.get('/todos')
      .then((lists) => {
        if (!counts()) return;
        setSaved(lists); setMine(null); setAdding([]); setError(null);
        // The count in the menu is read again too, so that it says what the list says: items somebody else's work
        // brought (a job handed to this person, an interview booked for their candidate) show in both at once.
        window.dispatchEvent(new Event('todos:counted'));
      })
      .catch((err) => { if (counts()) setError(err.message); });
    return () => { s.readings++; };
  }, [version]);
  /**
   * Make a change: on screen at once, then on the server. Answers whether the server took it. A change that fails
   * says why in a message at the foot of the page, unless `onFail` is given to say it somewhere better.
   */
  const change = (onScreen, send, onFail = (why) => toast(why, 'error')) => {
    const s = sync.current;
    s.readings++; // a reading already on its way was taken before this change
    if (onScreen) setMine((now) => onScreen(now ?? latest.current));
    s.waiting++;
    // A request that never reached The Book fails with the browser's own words ("Failed to fetch"): say it plainly.
    const said = (err) => (err instanceof TypeError ? 'The Book could not be reached, so that was not saved. Check your connection and try again.' : err.message);
    s.last = s.last.then(() => send()).then(() => true, (err) => { onFail(said(err)); return false; })
      .then((ok) => { if (!--s.waiting) bump(); return ok; });
    return s.last;
  };
  /** Change one list on screen. */
  const edit = (kind, fn) => (d) => ({ ...d, [kind]: fn(d[kind]) });
  const without = (rows, item) => rows.filter((x) => x.id !== item.id);

  const [debriefing, setDebriefing] = useState(null);
  // Where the keyboard's focus goes once the page has been drawn again. A control that was just used is often gone
  // by then (the row was ticked, its + has been pressed, the menu has closed) or has been moved in the page, and
  // the focus would otherwise fall back to the top of the page, a long way to Tab from for the next row.
  const refocus = useRef(null); // a control, or what to look it up by
  // Only somebody using the keyboard has the page scrolled to where the focus went: after a click or a tap the
  // focus moves just the same, but the page stays where the person is looking.
  const keyboard = useRef(false);
  useEffect(() => {
    const key = () => { keyboard.current = true; }, pointer = () => { keyboard.current = false; };
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', pointer, true);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', pointer, true); };
  }, []);
  useLayoutEffect(() => {
    if (refocus.current === null) return;
    const to = typeof refocus.current === 'string' ? document.querySelector(refocus.current) : refocus.current;
    refocus.current = null;
    if (to?.isConnected) to.focus({ preventScroll: !keyboard.current });
  });
  /** The same control on the row that takes this one's place when it leaves its list, or failing one the list itself. */
  const neighbour = (item, control) => {
    const l = latest.current[item.kind];
    const rows = l.open.some((x) => x.id === item.id) ? l.open : l.done;
    const at = rows.findIndex((x) => x.id === item.id);
    const next = rows[at + 1] ?? rows[at - 1];
    return next ? `[data-${control}="${next.id}"]` : `[data-list="${item.kind}"]`;
  };
  const keyOf = (kind, picked) => `${kind}:${kind === 'job' ? picked.id : picked.application_id}`;
  /**
   * Is this job, or this person, on that list already? Asked of the lists on screen, which are ahead of the server
   * while a change is on its way, and of what is being added right now: a picker's own reading can be a moment behind.
   */
  const onList = (kind, picked) => adding.includes(keyOf(kind, picked))
    || latest.current[kind].open.some((x) => (kind === 'job' ? x.job_id === picked.id : x.application_id === picked.application_id));

  const actions = {
    /** `control` is what on the row was used to move it with the keyboard (its grip or its menu): it keeps the focus. */
    move: (item, index, control) => {
      const open = latest.current[item.kind].open;
      const to = Math.max(0, Math.min(index, open.length - 1));
      if (open.findIndex((x) => x.id === item.id) === to) return;
      if (control) refocus.current = `[data-${control}="${item.id}"]`;
      change(edit(item.kind, (l) => { const rest = without(l.open, item); rest.splice(to, 0, item); return { ...l, open: rest }; }),
        () => api.post(`/todos/${item.id}/move`, { position: to }));
    },
    step: (item, by) => actions.move(item, latest.current[item.kind].open.findIndex((x) => x.id === item.id) + by, 'grip'),
    /**
     * Tick it. `said` is what the candidate said at a debrief, when something was typed: it goes on their profile,
     * and the page only says so when The Book answers with the note it made.
     */
    done: (item, said, onFail) => change(edit(item.kind, (l) => ({ open: without(l.open, item), done: [{ ...item, done_at: new Date().toISOString(), auto_done: false }, ...without(l.done, item)] })),
      () => api.patch(`/todos/${item.id}`, { done: true, ...(said ? { debrief: said } : {}) }).then((answer) => {
        if (!said) return;
        if (!answer?.note_id) throw new Error('What you typed could not be saved on their profile.');
        toast('Saved on their profile as an agency-only note');
      }), onFail),
    // A debrief asks first what the candidate said. Everything else is simply done.
    tick: (item) => {
      if (item.kind === 'debrief') { setDebriefing(item); return; }
      refocus.current = neighbour(item, 'tick');
      actions.done(item);
    },
    untick: (item) => {
      refocus.current = `[data-tick="${item.id}"]`; // it is back on the list, and so is the focus
      return change(edit(item.kind, (l) => ({ open: [...l.open, { ...item, done_at: null }], done: without(l.done, item) })),
        () => api.patch(`/todos/${item.id}`, { done: false }));
    },
    note: (item, note) => change(edit(item.kind, (l) => ({ ...l, open: l.open.map((x) => (x.id === item.id ? { ...x, note: note || null } : x)) })),
      () => api.patch(`/todos/${item.id}`, { note })),
    /** `control` is what on the row was pressed (its × or its menu): the focus goes to the same on the next row. */
    remove: (item, control) => {
      if (control) refocus.current = neighbour(item, control);
      return change(edit(item.kind, (l) => ({ open: without(l.open, item), done: without(l.done, item) })),
        () => api.del(`/todos/${item.id}`).then(() => toast(`${nameOf(item)} taken off your list`)));
    },
    /**
     * Put a job or a person from a picker on a list: where it was dropped, or at the end when its button was
     * pressed. The picker marks it as on the list straight away, so a second press of + cannot ask for it twice,
     * and the focus goes from the button that was pressed (it is gone) to the next one in the picker.
     */
    add: (kind, picked, position, button) => {
      const key = keyOf(kind, picked);
      if (button) {
        const picker = button.closest('[data-drop-zone]'), all = [...picker.querySelectorAll('[data-add]')], at = all.indexOf(button);
        refocus.current = all[at + 1] ?? all[at - 1] ?? picker.querySelector('input[type=search]');
      }
      setAdding((keys) => [...keys, key]);
      return change(null, () => api.post('/todos', kind === 'job' ? { kind, job_id: picked.id, position } : { kind, application_id: picked.application_id, position })
        .then(() => toast(`${nameOf(picked)} added to ${LISTS[kind].title.toLowerCase()}`),
          (err) => { setAdding((keys) => keys.filter((k) => k !== key)); throw err; }));
    },
  };

  const dnd = useDragDrop({
    accepts: (item, from, zone) => {
      if (from === 'pick-jobs') return zone === 'job' && !onList('job', item);
      if (from === 'pick-people') return (zone === 'prep' || zone === 'debrief') && !onList(zone, item);
      return zone === from || zone === LISTS[from].picker; // within its own list, or back out onto the picker
    },
    onDrop: ({ item, from, to, index }) => {
      if (from.startsWith('pick-')) actions.add(to, item, index);
      else if (to === from) actions.move(item, index);
      else actions.remove(item);
    },
  });

  if (!data) return <Pending error={error} />;
  const jobPicker = <JobPicker dnd={dnd} onAdd={actions.add} onList={onList} />;
  const list = (kind) => (
    <ListCard kind={kind} list={data[kind]} dnd={dnd} wide={wide} actions={actions}
      picker={kind === 'job' ? jobPicker : <PeoplePicker dnd={dnd} onAdd={actions.add} onList={onList} only={kind} />} />
  );
  const beside = (title, hint, picker) => wide && (
    <Card className="lg:sticky lg:top-6">
      <CardHeader title={<span className="whitespace-nowrap">{title}</span>} action={<span className="text-right text-xs text-stone-500">{hint}</span>} />
      {picker}
    </Card>
  );
  const dragged = dnd.drag?.item;

  return (
    <Page title="To do" subtitle="Your own list: the jobs you have picked to work on, and the people to prep before an interview and to debrief after one. Your notes, your order and the two people lists are yours alone. The rest of the team sees which jobs are on your list, and each job you tick: that counts as a cycle on it.">
      <div className="space-y-6">
        <div className={BESIDE}>
          {list('job')}
          {beside('Open jobs', 'Drag one across, or press +', jobPicker)}
        </div>
        <div className={BESIDE}>
          <div className="min-w-0 space-y-6">{list('prep')}{list('debrief')}</div>
          {beside('People at interview', 'Drag one across, or press a button', <PeoplePicker dnd={dnd} onAdd={actions.add} onList={onList} />)}
        </div>
      </div>
      <DragGhost dnd={dnd}>
        {dragged && (
          <>
            <div className="truncate text-sm font-medium text-stone-900">{nameOf(dragged)}</div>
            <div className="truncate text-[13px] text-stone-500">{aboutOf(dragged)}</div>
          </>
        )}
      </DragGhost>
      {debriefing && (
        <DebriefModal item={debriefing} onClose={() => { refocus.current = `[data-tick="${debriefing.id}"]`; setDebriefing(null); }}
          onDone={async (said) => {
            const next = neighbour(debriefing, 'tick');
            let why = null;
            if (!await actions.done(debriefing, said, (message) => { why = message; })) return why ?? 'That was not saved.';
            refocus.current = next;
            setDebriefing(null);
            return null;
          }} />
      )}
    </Page>
  );
}
