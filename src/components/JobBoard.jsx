import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Briefcase, ChevronDown, ChevronLeft, ChevronRight, UserRoundX } from 'lucide-react';
import { api, daysSince, photoUrl, plural } from '../lib.js';
import { useApp, useOpenCandidate } from '../state.jsx';
import { Avatar, Badge, Button, Card, CardHeader, ClientDot, Empty, Menu, Switch, useToast, cx } from '../ui.jsx';
import { JobStatusBadge } from './bits.jsx';
import { DragGhost, keepInPlace, useDragDrop } from './DragDrop.jsx';
import { dropToStage, notMovedWords, placeOf, readZone, showMoves, stageZone, stillToShow, undoOf, wordsAfter } from '../board-moves.js';

// The job board on the agency's dashboard: one column for each account executive (the person a job belongs to),
// with their jobs under their name. The server decides which jobs and in what order; this draws them.

// From this width the columns sit side by side. Narrower than that (a phone) they are stacked, and each can be folded away.
const SIDE_BY_SIDE = '(min-width: 768px)';
/** Is the window at least wide enough for the columns to sit side by side? Kept up to date as it is resized. */
function useSideBySide() {
  const [wide, setWide] = useState(() => window.matchMedia(SIDE_BY_SIDE).matches);
  useEffect(() => {
    const media = window.matchMedia(SIDE_BY_SIDE);
    const changed = () => setWide(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  return wide;
}

// Stacked on a phone, a long column shows this many jobs until "Show all" is tapped, so one busy person does not
// push everybody below them, and the rest of the dashboard, a long way down.
const FIRST_FEW = 5;

/**
 * The strip of columns when they sit side by side. It scrolls sideways when there are more people than fit; this
 * says whether there is more of it off to the left or right, and steps along it, for the arrows in the board's
 * heading: an ordinary mouse wheel only scrolls up and down, and the strip's own scrollbar is at the bottom of it.
 * `watch` is what the strip is drawn from, so it is measured again when that changes.
 */
function useSideways(watch) {
  const strip = useRef(null);
  const [more, setMore] = useState({ left: false, right: false });
  useEffect(() => {
    const el = strip.current;
    if (!el) { setMore({ left: false, right: false }); return undefined; }
    const measure = () => {
      const left = el.scrollLeft > 1, right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const resized = new ResizeObserver(measure);
    resized.observe(el);
    return () => { el.removeEventListener('scroll', measure); resized.disconnect(); };
  }, watch);
  // One step is most of what is on screen, so the last column in view is still in view afterwards.
  const step = (direction) => {
    const el = strip.current;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el?.scrollBy({ left: direction * Math.max(220, el.clientWidth - 220), behavior: calm ? 'auto' : 'smooth' });
  };
  return { strip, more, step };
}

/** How long a job has been open, or where it stands when it is not open. */
function openFor(job) {
  if (job.status === 'open') return job.opened_at ? `Open ${daysSince(job.opened_at)}d` : 'Open';
  return job.opened_at ? `Opened ${daysSince(job.opened_at)}d ago` : 'Not opened yet';
}

// Dragging people between the stages of a job's pipeline, and moving them from the keyboard (see Pipeline). The
// board holds the one drag there can be at a time; each dropped-down pipeline says what to do with a person
// dropped on one of its stages.
const BoardDrag = createContext(null);
// How long the message after a move stays up, with its Undo.
const UNDO_FOR = 7000;
// Answers from the server and saved moves are put in order by one counter, so a pipeline knows whether an answer
// was asked for before or after a move was saved (see stillToShow in board-moves.js).
let ticks = 0;

/**
 * A job's pipeline, under its card: every stage in order, how many people are in it, and who they are (the first
 * few of a long stage; the server decides how many). It is asked for when the card is opened, and again whenever
 * something is saved (somebody moved to another stage from their profile, say), so it is never behind the job's own
 * page. A name opens that person's profile over the dashboard.
 *
 * A person can be moved to another stage of the job from here, as on the job's own Pipeline tab: dragged by their
 * name onto it (a mouse once it has moved a little, a finger once it has been held still for a moment), or with
 * their Move button, which lists the other stages. They move at once; when The Book has saved it, this and the
 * whole board are asked for again, so the card's own numbers follow. A message says what happened, with Undo.
 */
function Pipeline({ job, onShown }) {
  const { bump, version } = useApp();
  const toast = useToast();
  const openCandidate = useOpenCandidate();
  const { dnd, movers } = useContext(BoardDrag);
  const [answer, setAnswer] = useState({ data: null, error: null });
  // Moves made here that the server has not yet answered with a fresh pipeline: they are laid over its last answer.
  const [moves, setMoves] = useState([]);
  // Saved moves whose message is still to be shown. It says where the person is in the server's own answer, asked
  // for once the move was saved: in a long stage they can be named, or under "and N more", and only the server knows
  // which (it lists people by when they applied, which it does not send).
  const toTell = useRef(new Map());
  const tell = (entry, stages) => {
    if (!toTell.current.delete(entry.key)) return;
    const back = undoOf(entry);
    // One message about each person: a later move of the same person takes the place of the one before, whose Undo
    // would put them somewhere else.
    toast(wordsAfter(stages, entry), 'ok', { key: `board-move-${entry.person.id}`,
      ...(entry.undo ? {} : { duration: UNDO_FOR, action: { label: 'Undo', onClick: () => latestMove.current(back.person, back.to, { undo: true }) } }) });
  };
  useEffect(() => {
    let live = true;
    const asked = ++ticks;
    api.get(`/jobs/${job.id}/pipeline`)
      .then((data) => {
        if (!live) return;
        setAnswer({ data, error: null });
        setMoves((m) => stillToShow(m, asked));
        for (const entry of toTell.current.values()) if (entry.saved < asked) tell(entry, data.stages);
      })
      .catch((err) => live && setAnswer({ data: null, error: err.message }));
    return () => { live = false; };
  }, [version]);
  const ready = Boolean(answer.data);
  useEffect(() => { if (ready) onShown(); }, [ready]);
  const stages = answer.data && showMoves(answer.data.stages, moves);
  const shownNow = useRef(stages);
  shownNow.current = stages;

  // Moves are sent one at a time and in order, so two quick moves of the same person end where the second put them.
  const queue = useRef(Promise.resolve());
  const root = useRef(null);
  const refocus = useRef(null); // after a move made with the keyboard: the person whose Move button takes the focus
  /** Move a person to the stage `toId`. `undo` is Undo's own move; `keyboard` keeps the keyboard on the person. */
  const move = (person, toId, { undo = false, keyboard = false } = {}) => {
    const now = shownNow.current;
    if (!now) return;
    const from = placeOf(now, person)?.stage ?? now.find((s) => s.id === person.stageId);
    const to = now.find((s) => s.id === toId);
    if (!from || !to || from.id === to.id) return;
    const { id, name, candidate_id, photo, current_title, current_company, status } = person;
    const entry = { key: Math.random(), person: { id, name, candidate_id, photo, current_title, current_company, status }, from: from.id, to: to.id, undo, saved: null };
    if (keyboard) refocus.current = { id, stage: to.id };
    setMoves((m) => [...m, entry]);
    queue.current = queue.current.then(() => api.post(`/applications/${id}/move`, { stage_id: to.id })).then(
      () => {
        const saved = ++ticks;
        setMoves((m) => m.map((e) => (e.key === entry.key ? { ...e, saved } : e)));
        toTell.current.set(entry.key, { ...entry, saved });
        // Should no answer come (the pipeline could not be read again, or was folded away), the message still
        // comes, saying where the person is as far as the dropdown knows.
        setTimeout(() => tell(entry, shownNow.current ?? []), 4000);
        bump();
      },
      (err) => {
        // The person goes back to where the server has them, and the board is asked for again in case that is
        // because something changed meanwhile (they were moved, or taken off the job, by somebody else).
        setMoves((m) => m.filter((e) => e.key !== entry.key));
        toast(notMovedWords(name, err), 'error', { key: `board-move-${id}` });
        bump();
      },
    );
  };
  const latestMove = useRef(move);
  latestMove.current = move;
  useEffect(() => {
    movers.current.set(job.id, (person, stageId) => latestMove.current(person, stageId));
    return () => movers.current.delete(job.id);
  }, []);
  useLayoutEffect(() => {
    const to = refocus.current;
    if (!to || !root.current) return;
    refocus.current = null;
    // Their own Move button in the stage they went to, or that stage's "and N more" when they are under it.
    (root.current.querySelector(`[data-board-move="${to.id}"]`) ?? root.current.querySelector(`[data-board-stage="${to.stage}"] [data-board-more]`))?.focus();
  });

  // While one of this job's people is being dragged, every other stage of the job is a place to drop them.
  const dragging = dnd.drag?.item.jobId === job.id ? dnd.drag : null;
  const overStage = dragging?.over ? readZone(dragging.over.zone)?.stageId : null;
  // Empty stages grow while a person is dragged, so they are easy to hit, and shrink again when the person is let
  // go. Whatever the pointer is on is kept where it is on screen across both (see keepInPlace): otherwise a stage
  // further up growing would slide another stage under a pointer that has not moved.
  const was = useRef(null);
  const anchor = useRef(null);
  if (Boolean(dragging) !== Boolean(was.current) && root.current) {
    const held = dragging ?? was.current;
    const over = !dragging && held.over ? readZone(held.over.zone)?.stageId : null;
    // Measured now, while the page is still as it was: the stage they were let go on, or else the person's own row.
    const selector = over != null ? `[data-board-stage="${over}"]` : `[data-board-person="${held.item.id}"]`;
    const el = root.current.querySelector(selector);
    anchor.current = el ? { selector, top: el.getBoundingClientRect().top } : null;
  }
  was.current = dragging;
  useLayoutEffect(() => {
    const a = anchor.current;
    anchor.current = null;
    const el = a && root.current?.querySelector(a.selector);
    if (el) keepInPlace(el, a.top);
  });

  // Trying again asks for the whole dashboard again too, so a job that has been deleted meanwhile leaves the board.
  if (answer.error) {
    return (
      <p role="alert" className="text-xs text-stone-600">
        {answer.error === 'Not found' ? 'This job is no longer there.' : `The pipeline could not be loaded: ${answer.error}`}{' '}
        <button type="button" onClick={bump} className="font-medium text-brand-700 hover:underline">{answer.error === 'Not found' ? 'Refresh the board' : 'Try again'}</button>
      </p>
    );
  }
  if (!ready) return <p className="text-xs text-stone-500">Loading the pipeline…</p>;
  // Straight to the job's Pipeline tab: the job would otherwise open on whichever tab this person used last.
  const jobPipeline = `/jobs/${job.id}?tab=pipeline`;
  const stageList = stages.map(({ id, name, kind }) => ({ id, name, kind }));
  return (
    <>
      {/* Side by side, the stages touch, so that the pointer is always over one of them while a person is dragged
          down the list; the gaps seen between them are drawn inside each. */}
      <ol ref={(el) => { root.current = el; return dnd.touchArea(el); }} className="-mx-1.5">
        {stages.map((stage) => {
          const target = dragging && stage.id !== dragging.item.stageId;
          const over = target && overStage === stage.id;
          return (
            <li key={stage.id} data-board-stage={stage.id} data-drop-zone={stageZone(job.id, stage.id)} className="relative px-1.5 py-[3px]">
              {dragging && (
                <span aria-hidden="true" className={cx('pointer-events-none absolute inset-x-0 inset-y-px rounded-md border transition-colors',
                  over ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-500/25' : target ? 'border-dashed border-stone-300 bg-white' : 'border-transparent')} />
              )}
              <span className={cx('tabular relative flex items-baseline justify-between gap-2 text-xs', stage.count ? 'font-semibold text-stone-800' : 'text-stone-400', over && 'text-brand-800')}>
                <span className="truncate" title={stage.name}>{stage.name}</span><span>{stage.count}</span>
              </span>
              {stage.count > 0 && (
                <ul className="relative mt-0.5">
                  {stage.people.map((a) => {
                    const item = { ...a, jobId: job.id, stageId: stage.id, stageName: stage.name, stages: stageList };
                    return (
                      <li key={a.id} data-drag-row="" data-board-person={a.id}
                        className={cx('group/row -mx-1 flex w-[calc(100%+0.5rem)] items-center rounded-md', !dragging && 'hover:bg-stone-100', dragging?.item.id === a.id && 'opacity-40')}>
                        {/* Dragged by the name itself. A click on it still opens the profile: the mouse has to move a
                            little first, and a finger has to be held still for a moment, so neither starts a move by accident. */}
                        <button type="button" {...dnd.press(item, stageZone(job.id, stage.id))} onClick={() => openCandidate(a.id)}
                          title={[a.name, a.current_title, a.current_company].filter(Boolean).join(' · ')}
                          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left select-none [-webkit-touch-callout:none]">
                          <Avatar name={a.name} size={20} src={photoUrl(a.candidate_id, a.photo)} />
                          <span className="truncate text-[13px] text-stone-800">{a.name}</span>
                        </button>
                        {/* For the keyboard, and for anybody who would rather not drag. Seen when the row is pointed at
                            or the button has the keyboard, and always on a touch screen, where nothing is pointed at. */}
                        <Menu reveal className={cx('shrink-0', dragging && 'invisible')} items={stageList.filter((s) => s.id !== stage.id).map((s) => ({
                          label: s.kind === 'hired' ? `${s.name} (marks them hired)` : s.name,
                          onClick: () => move(item, s.id, { keyboard: true }),
                        }))} trigger={(
                          <button type="button" data-board-move={a.id} aria-label={`Move ${a.name} to another stage`} title="Move to another stage. You can also drag the name."
                            className="mr-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium text-stone-500 opacity-0 group-hover/row:opacity-100 hover:bg-white hover:text-stone-900 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-brand-500 aria-expanded:opacity-100 [@media(hover:none)]:py-1.5 [@media(hover:none)]:opacity-100">
                            Move
                          </button>
                        )} />
                      </li>
                    );
                  })}
                  {stage.count > stage.people.length && (
                    <li><Link to={jobPipeline} data-board-more="" className="block py-1 pl-7 text-xs text-brand-700 hover:underline">and {stage.count - stage.people.length} more</Link></li>
                  )}
                </ul>
              )}
              {/* An empty stage is a thin line: while somebody is being dragged it opens up, so it is easy to drop on. */}
              {target && !stage.count && (
                <span aria-hidden="true" className={cx('relative mt-0.5 block rounded py-1.5 text-center text-xs', over ? 'font-medium text-brand-800' : 'text-stone-500')}>
                  {over && stage.kind === 'hired' ? 'Drop to mark as hired' : 'Drop here'}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <Link to={jobPipeline} className="mt-2.5 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">Open job<ArrowUpRight className="size-3.5" /></Link>
    </>
  );
}

/** What follows the pointer while a person is dragged: who, and where letting go would put them. */
function DraggedPerson({ drag }) {
  const { item, over } = drag;
  const to = over && item.stages.find((s) => s.id === readZone(over.zone)?.stageId);
  return (
    <span className="flex items-center gap-2">
      <Avatar name={item.name} size={24} src={photoUrl(item.candidate_id, item.photo)} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-stone-900">{item.name}</span>
        <span className={cx('block truncate text-xs', to ? 'font-medium text-brand-700' : 'text-stone-500')}>
          {to ? (to.kind === 'hired' ? 'Let go to mark them hired' : `Let go to move to ${to.name}`) : 'Drop on another stage'}
        </span>
      </span>
    </span>
  );
}

/**
 * One job. A click on the card drops its pipeline down under it, and another folds it away; the arrow in the
 * corner opens the job itself. Several cards can be open at once. Which are open is kept by the board, not here,
 * so a card is still open after its column has been folded away and unfolded on a phone.
 */
function JobCard({ job: j, open, onToggle }) {
  const { scope } = useApp();
  const card = useRef(null);
  const panel = `board-job-${j.id}-pipeline`;
  // The pipeline can drop down below what is on screen (the last card in a tall column): bring it into view.
  const shown = () => card.current?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  return (
    <div ref={card} data-board-job={j.id} className={cx('relative rounded-lg border border-line bg-white transition-shadow hover:shadow-md', open ? 'shadow-md' : 'shadow-sm')}>
      <button type="button" aria-expanded={open} aria-controls={panel} onClick={onToggle} className="block w-full rounded-lg p-3 text-left">
        {/* Room on the right for the arrow that opens the job. */}
        <span className="flex items-start justify-between gap-2 pr-8">
          <span className="line-clamp-2 text-sm leading-snug font-medium text-stone-900 [overflow-wrap:anywhere]" title={j.title}>{j.title}</span>
          {j.status !== 'open' && <JobStatusBadge status={j.status} />}
        </span>
        {/* As everywhere else, the client is not repeated on every card when the workspace is showing one client only. */}
        {!scope && <span className="mt-1 flex items-center gap-1.5 text-[13px] text-stone-600"><ClientDot color={j.brand_color} /><span className="truncate" title={j.client_name}>{j.client_name}</span></span>}
        <span className="mt-0.5 block text-xs text-stone-500">{openFor(j)} · {j.hires} of {j.openings} filled</span>
        <span className="tabular mt-2.5 grid grid-cols-3 gap-1 border-t border-line pt-2 text-center">
          {[['Pipeline', j.in_pipeline], ['Interview', j.interviewing], ['Offer', j.offers]].map(([label, value]) => (
            <span key={label}>
              <span className={cx('block text-sm font-semibold', value ? 'text-stone-900' : 'text-stone-400')}>{value}</span>
              <span className="block text-[11px] text-stone-500">{label}</span>
            </span>
          ))}
        </span>
        <span className="mt-2 flex items-center justify-center gap-1 text-[11px] font-medium text-stone-500">
          {open ? 'Hide pipeline' : 'Show pipeline'}<ChevronDown className={cx('size-3.5 transition-transform', open && 'rotate-180')} />
        </span>
      </button>
      {/* Big enough to tap on a phone, where the rest of the card is the button that drops the pipeline down. */}
      <Link to={`/jobs/${j.id}`} aria-label={`Open the job ${j.title}`} title="Open job" className="absolute top-0.5 right-0.5 rounded-md p-2.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700">
        <ArrowUpRight className="size-4" />
      </Link>
      {open && <div id={panel} className="border-t border-line px-3 pt-2.5 pb-3"><Pipeline job={j} onShown={shown} /></div>}
    </div>
  );
}

/**
 * One person's jobs. Side by side, a column is never taller than most of the window: a long one scrolls inside
 * itself, under its heading, so the others, the strip's scrollbar and the rest of the dashboard stay within reach.
 * On a phone the heading is a button that folds the jobs away, and a long column shows its first few until asked.
 */
function Column({ column: c, wide, open, onToggle, openJobs, onJob }) {
  const { isAdmin } = useApp();
  const [all, setAll] = useState(false);
  const name = c.id == null ? 'No account executive' : c.name;
  const jobs = wide || all ? c.jobs : c.jobs.slice(0, FIRST_FEW);
  const heading = (
    <>
      {c.id == null
        ? <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-stone-300 text-stone-600"><UserRoundX className="size-4" /></span>
        : <Avatar name={c.name} size={32} />}
      <span className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-1.5">
          {/* A person's name is cut short when it is too long for the column; "No account executive" wraps instead, so it can always be read. */}
          <span className={cx('text-sm font-semibold text-stone-900', c.id == null ? 'leading-tight' : 'truncate')} title={name}>{name}</span>
          {c.you && <Badge tone="green">You</Badge>}
        </span>
        {/* Said in the small line, in words: beside the name it would leave a long name no room in a narrow column. */}
        <span className="block truncate text-xs font-normal text-stone-500">{plural(c.jobs.length, 'job')}{c.id != null && !c.active && ' · Deactivated'}</span>
      </span>
    </>
  );
  return (
    <section aria-label={`${name}: ${plural(c.jobs.length, 'job')}`} data-board-column={c.id ?? 'none'}
      className={cx('rounded-xl bg-stone-100 p-2', wide && 'flex max-h-[clamp(20rem,70vh,36rem)] max-w-[22rem] min-w-[13.5rem] flex-1 basis-0 flex-col')}>
      {wide ? <h3 className="flex shrink-0 items-center gap-2.5 px-1.5 pt-1 pb-2.5">{heading}</h3> : (
        <h3>
          <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1">
            {heading}
            <ChevronDown className={cx('size-4 shrink-0 text-stone-500 transition-transform', open && 'rotate-180')} />
          </button>
        </h3>
      )}
      {(wide || open) && (
        <>
          {/* Where these jobs came from is not obvious, and neither is how one leaves this column. */}
          {c.id == null && (
            <p className={cx('shrink-0 px-1.5 pb-2.5 text-xs leading-snug text-stone-600', !wide && 'pt-2')}>
              {isAdmin ? 'Nobody has these yet. To give one to somebody, open it and choose Edit.' : 'Nobody has these yet. An admin can give each one to somebody.'}
            </p>
          )}
          {/* The small margin and padding leave room for the cards' shadows, which a scrolling box would otherwise cut off. */}
          <div className={cx('flex flex-col gap-2', wide ? '-mx-1 -mb-1 min-h-0 flex-1 overflow-y-auto px-1 pb-1 [scrollbar-width:thin]' : c.id != null && 'mt-2')}>
            {jobs.map((j) => <JobCard key={j.id} job={j} open={openJobs.has(j.id)} onToggle={() => onJob(j.id)} />)}
            {!wide && c.jobs.length > FIRST_FEW && (
              <Button variant="ghost" size="sm" aria-expanded={all} onClick={() => setAll(!all)}>
                {all ? `Show the first ${FIRST_FEW} only` : `Show all ${plural(c.jobs.length, 'job')}`}
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * `columns` is the board as the dashboard sends it: [{ id, name, active, you, jobs }], already in order. `all` says
 * whether paused and draft jobs are included, and `onAll` flips that.
 */
export default function JobBoard({ columns, all, onAll }) {
  const wide = useSideBySide();
  const key = (c) => c.id ?? 'none';
  // On a phone one column starts unfolded: the signed-in person's own, which comes first, or else whichever is first.
  const [folded, setFolded] = useState({}); // the columns somebody has folded or unfolded by hand
  const isOpen = (c, i) => folded[key(c)] ?? i === 0;
  const { strip, more, step } = useSideways([wide, columns]);
  // The cards whose pipeline is dropped down, by job. Kept here so that folding a column away does not close them.
  const [openJobs, setOpenJobs] = useState(() => new Set());
  const toggleJob = (id) => setOpenJobs((was) => { const next = new Set(was); if (!next.delete(id)) next.add(id); return next; });
  // A person dragged out of a job's pipeline goes to the stage of that job they are let go over; anywhere else, nothing.
  const movers = useRef(new Map()); // each dropped-down pipeline's own way of moving somebody, by job
  const dnd = useDragDrop({
    scrollInside: true,
    accepts: (item, from, zone) => dropToStage(item, zone) !== null,
    onDrop: ({ item, to }) => movers.current.get(item.jobId)?.(item, dropToStage(item, to)),
  });
  return (
    <BoardDrag.Provider value={{ dnd, movers }}>
      <Card>
        <CardHeader title="Job board" action={(
          <span className="flex items-center gap-3">
            {/* Only there when the columns do not all fit. Left of the switch, so the switch does not move when they come and go. */}
            {wide && (more.left || more.right) && (
              <span className="flex items-center">
                <Button variant="ghost" size="sm" icon={ChevronLeft} className="!px-1.5" aria-label="Scroll the board left" title="Scroll the board left" disabled={!more.left} onClick={() => step(-1)} />
                <Button variant="ghost" size="sm" icon={ChevronRight} className="!px-1.5" aria-label="Scroll the board right" title="Scroll the board right" disabled={!more.right} onClick={() => step(1)} />
              </span>
            )}
            <Switch checked={all} onChange={onAll} label="Include paused and draft" />
          </span>
        )} />
        {columns.length ? (
          <>
            <div ref={strip} className={cx('p-3', wide ? 'flex items-start gap-3 overflow-x-auto' : 'space-y-2')}>
              {columns.map((c, i) => (
                <Column key={key(c)} column={c} wide={wide} open={isOpen(c, i)} onToggle={() => setFolded((f) => ({ ...f, [key(c)]: !isOpen(c, i) }))} openJobs={openJobs} onJob={toggleJob} />
              ))}
            </div>
            <p className="border-t border-line px-4 py-2.5 text-xs text-stone-500">
              A job is under its account executive: the person who created it. They, or an admin, can hand it to somebody else: open the job and choose Edit.
            </p>
          </>
        ) : (
          <Empty icon={Briefcase} title={all ? 'No open, paused or draft jobs' : 'No open jobs'}>
            Each job appears here under its account executive: the person on your team who created it.
          </Empty>
        )}
      </Card>
      <DragGhost dnd={dnd}>{dnd.drag && <DraggedPerson drag={dnd.drag} />}</DragGhost>
    </BoardDrag.Provider>
  );
}
