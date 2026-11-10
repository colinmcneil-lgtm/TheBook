import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Briefcase, ChevronDown, ChevronLeft, ChevronRight, UserRoundX } from 'lucide-react';
import { daysSince, plural } from '../lib.js';
import { useApp } from '../state.jsx';
import { Avatar, Badge, Button, Card, CardHeader, ClientDot, Empty, Switch, cx } from '../ui.jsx';
import { JobStatusBadge } from './bits.jsx';

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

function JobCard({ job: j }) {
  const { scope } = useApp();
  return (
    <Link to={`/jobs/${j.id}`} className="block rounded-lg border border-line bg-white p-3 shadow-sm transition-shadow hover:shadow-md">
      <span className="flex items-start justify-between gap-2">
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
    </Link>
  );
}

/**
 * One person's jobs. Side by side, a column is never taller than most of the window: a long one scrolls inside
 * itself, under its heading, so the others, the strip's scrollbar and the rest of the dashboard stay within reach.
 * On a phone the heading is a button that folds the jobs away, and a long column shows its first few until asked.
 */
function Column({ column: c, wide, open, onToggle }) {
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
            {jobs.map((j) => <JobCard key={j.id} job={j} />)}
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
  return (
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
              <Column key={key(c)} column={c} wide={wide} open={isOpen(c, i)} onToggle={() => setFolded((f) => ({ ...f, [key(c)]: !isOpen(c, i) }))} />
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
  );
}
