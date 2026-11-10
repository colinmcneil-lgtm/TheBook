import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Briefcase, ChevronDown, UserRoundX } from 'lucide-react';
import { daysSince, plural } from '../lib.js';
import { useApp } from '../state.jsx';
import { Avatar, Badge, Card, CardHeader, ClientDot, Empty, Switch, cx } from '../ui.jsx';
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

/** One person's jobs. On a phone the heading is a button that folds the jobs away. */
function Column({ column: c, wide, open, onToggle }) {
  const name = c.id == null ? 'No account executive' : c.name;
  const heading = (
    <>
      {c.id == null
        ? <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-stone-300 text-stone-600"><UserRoundX className="size-4" /></span>
        : <Avatar name={c.name} size={32} />}
      <span className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-stone-900" title={name}>{name}</span>
          {c.you && <Badge tone="green">You</Badge>}
          {c.id != null && !c.active && <Badge>Deactivated</Badge>}
        </span>
        <span className="block text-xs text-stone-500">{plural(c.jobs.length, 'job')}</span>
      </span>
    </>
  );
  return (
    <section aria-label={`${name}: ${plural(c.jobs.length, 'job')}`} data-board-column={c.id ?? 'none'}
      className={cx('rounded-xl bg-stone-100 p-2', wide && 'max-w-[22rem] min-w-60 flex-1 basis-0')}>
      {wide ? <h3 className="flex items-center gap-2.5 px-1.5 pt-1 pb-2.5">{heading}</h3> : (
        <h3>
          <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1">
            {heading}
            <ChevronDown className={cx('size-4 shrink-0 text-stone-500 transition-transform', open && 'rotate-180')} />
          </button>
        </h3>
      )}
      {(wide || open) && <div className={cx('flex flex-col gap-2', !wide && 'mt-2')}>{c.jobs.map((j) => <JobCard key={j.id} job={j} />)}</div>}
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
  return (
    <Card>
      <CardHeader title="Job board" action={<Switch checked={all} onChange={onAll} label="Include paused and draft" />} />
      {columns.length ? (
        <div className={cx('p-3', wide ? 'flex items-start gap-3 overflow-x-auto' : 'space-y-2')}>
          {columns.map((c, i) => (
            <Column key={key(c)} column={c} wide={wide} open={isOpen(c, i)} onToggle={() => setFolded((f) => ({ ...f, [key(c)]: !isOpen(c, i) }))} />
          ))}
        </div>
      ) : (
        <Empty icon={Briefcase} title={all ? 'No open, paused or draft jobs' : 'No open jobs'}>
          Each job appears here under its account executive: the person on your team who created it.
        </Empty>
      )}
    </Card>
  );
}
