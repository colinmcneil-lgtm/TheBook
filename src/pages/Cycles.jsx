// Cycles: the whole agency team's view of which open jobs have been worked on. Each time somebody ticks a job on
// their own Jobs to work on list, that is one cycle on the job. The server counts, filters and puts the rows in
// order (see server/cycles.js); this page draws them. Agency only.
import React, { Fragment, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, RefreshCw, Repeat2, Users } from 'lucide-react';
import { useApp, useApi, Pending } from '../state.jsx';
import { api, url, ago, fmtDate, fmtWhen, plural } from '../lib.js';
import { Avatar, Button, Card, CardHeader, Checkbox, ClientDot, Empty, Loading, Page, Select, cx } from '../ui.jsx';

// The periods the server knows, in the order offered. "This week" runs from Monday, on the agency's own clock.
const PERIODS = [['week', 'This week'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['all', 'All time']];
const IN_PERIOD = { week: 'this week', '7d': 'in the last 7 days', '30d': 'in the last 30 days', all: 'in all' };

/** "Monday 9 November": a day written YYYY-MM-DD, as the calendar has it wherever the reader is. */
const longDay = (ymd) => new Date(`${ymd}T00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

/** Whoever made a cycle, in words: their name, said plainly when they are no longer on the team. */
function who(p) {
  if (!p?.name) return 'somebody no longer on the team';
  return p.on_team ? p.name : `${p.name} (no longer on the team)`;
}

/**
 * The page is read again when it is opened, when anything in the workspace is saved, and when the tab comes back
 * into view: somebody may have ticked a job meanwhile. No clock of its own.
 */
function useLookAgain() {
  const [again, setAgain] = useState(0);
  useEffect(() => {
    const look = () => document.visibilityState === 'visible' && setAgain((n) => n + 1);
    document.addEventListener('visibilitychange', look);
    return () => document.removeEventListener('visibilitychange', look);
  }, []);
  return again;
}

// From this width the jobs are a table; narrower (a phone) each is a card. Only one of the two is drawn, so that a
// row opened to show its cycles asks for them once.
const TABLE_WIDTH = '(min-width: 768px)';
function useTableWidth() {
  const [wide, setWide] = useState(() => window.matchMedia(TABLE_WIDTH).matches);
  useEffect(() => {
    const media = window.matchMedia(TABLE_WIDTH);
    const changed = () => setWide(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  return wide;
}

/** The choices kept in the address, so that a link shows somebody else the same view. */
function useChoices() {
  const [params, setParams] = useSearchParams();
  const set = (changes) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) value ? next.set(key, value) : next.delete(key);
    setParams(next, { replace: true });
  };
  const period = PERIODS.some(([id]) => id === params.get('period')) ? params.get('period') : 'week';
  return { period, ae: params.get('ae') || '', untouched: params.get('untouched') === '1', sort: params.get('sort') || '', dir: params.get('dir') || '', set };
}

/** A column heading that sorts the table by its column; a second click turns the order round. */
function SortHeading({ id, label, data, onSort, left, className }) {
  const active = data.sort === id;
  const Arrow = data.dir === 'asc' ? ArrowUp : ArrowDown;
  const arrow = active && <Arrow className="mb-0.5 size-3.5 shrink-0" aria-hidden="true" />;
  return (
    <th scope="col" aria-sort={active ? (data.dir === 'asc' ? 'ascending' : 'descending') : undefined} className={cx('px-3 py-2 align-bottom font-medium', left ? 'text-left' : 'text-right', className)}>
      <button type="button" onClick={() => onSort(id)} title="Sort by this column"
        className={cx('inline-flex items-end gap-1 rounded text-inherit hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500', active && 'text-stone-900')}>
        {!left && arrow}
        <span className="whitespace-nowrap">{label}</span>
        {left && arrow}
      </button>
    </th>
  );
}

/** "16h ago, Priya Nair", or "Never" in the colour that asks for attention: this page exists to show those. */
function LastCycle({ row, compact }) {
  if (!row.last_at) return <span className="font-medium text-amber-800">Never</span>;
  return (
    <span title={fmtWhen(row.last_at)}>
      <span className="text-stone-900">{ago(row.last_at)}</span>
      <span className={cx('text-stone-500', compact ? '' : 'block text-xs')}>{compact ? ', ' : ''}{who(row.last_by)}</span>
    </span>
  );
}

/** The people who have the job on their Jobs to work on right now: initials for the eye, names for a screen reader. */
function OnList({ people }) {
  if (!people.length) return <span className="text-stone-500">Nobody</span>;
  const names = people.map((p) => p.name).join(', ');
  return (
    <span className="inline-flex items-center" title={names}>
      <span className="sr-only">{names}</span>
      <span className="flex -space-x-1.5" aria-hidden="true">
        {people.slice(0, 4).map((p) => <Avatar key={p.user_id} name={p.name} size={24} className="ring-2 ring-white" />)}
      </span>
      {people.length > 4 && <span className="ml-1 text-xs text-stone-500" aria-hidden="true">+{people.length - 4}</span>}
    </span>
  );
}

/** A job's cycles, newest first, twenty at a time. */
function History({ job }) {
  const [pages, setPages] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const { version } = useApp();
  useEffect(() => {
    let live = true;
    api.get(`/cycles/jobs/${job.id}`).then((p) => live && (setPages([p]), setError(null)), (err) => live && setError(err.message));
    return () => { live = false; };
  }, [job.id, version]);
  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!pages) return <Loading className="!py-4" />;
  const cycles = pages.flatMap((p) => p.cycles);
  const earlier = async () => {
    setBusy(true);
    try { const p = await api.get(url(`/cycles/jobs/${job.id}`, { before: cycles.at(-1).id })); setPages((now) => [...now, p]); setError(null); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  if (!cycles.length) return <p className="text-sm text-stone-500">Nobody has ticked this job on their list yet.</p>;
  return (
    <div>
      <h3 className="text-xs font-semibold tracking-wide text-stone-500 uppercase">Cycles on {job.title}, newest first</h3>
      <ol className="mt-1.5 divide-y divide-hairline">
        {cycles.map((c) => (
          <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-4 py-1.5 text-sm">
            <span className="text-stone-800">{who(c)}</span>
            <span className="tabular text-stone-500">{fmtWhen(c.at)} <span className="text-stone-400">· {ago(c.at)}</span></span>
          </li>
        ))}
      </ol>
      {pages.at(-1).more && <Button size="sm" className="mt-2" busy={busy} onClick={earlier}>Show earlier</Button>}
    </div>
  );
}

/** The button that opens a row to show its job's cycles. */
function Opener({ row, open, onToggle }) {
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the cycles on ${row.title}`}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-stone-500 hover:bg-stone-900/5 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-brand-500">
      <Icon className="size-4" />
    </button>
  );
}

function JobName({ row, showClient }) {
  return (
    <span className="min-w-0">
      <Link to={`/jobs/${row.id}`} className="font-medium text-stone-900 hover:text-brand-700 hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-brand-500">{row.title}</Link>
      {showClient && <span className="flex items-center gap-1.5 text-xs text-stone-500"><ClientDot color={row.brand_color} />{row.client_name}</span>}
    </span>
  );
}
const aeName = (row) => (row.account_executive_name ? `${row.account_executive_name}${row.account_executive_on_team ? '' : ' (no longer on the team)'}` : 'Nobody');

export default function Cycles() {
  const { scope, scopeClient } = useApp();
  const choices = useChoices();
  const again = useLookAgain();
  const [opened, setOpened] = useState(() => new Set());
  const { data, error } = useApi(url('/cycles', { client_id: scope, period: choices.period, account_executive: choices.ae, untouched: choices.untouched ? 1 : '', sort: choices.sort, dir: choices.dir }), again);
  const periodLabel = PERIODS.find(([id]) => id === choices.period)[1];
  const inPeriod = IN_PERIOD[choices.period];
  const toggle = (id) => setOpened((now) => { const next = new Set(now); next.has(id) ? next.delete(id) : next.add(id); return next; });
  // A column's first click sorts the way that column is most use: names A to Z, longest untouched first, most first.
  const sortBy = (id) => choices.set(data.sort === id ? { sort: id, dir: data.dir === 'asc' ? 'desc' : 'asc' } : { sort: id, dir: ['job', 'ae', 'last'].includes(id) ? 'asc' : 'desc' });
  const showClient = !scope;
  const wide = useTableWidth();
  // For All time the period's column would be the same as the all-time one, so it is left out.
  const periodColumn = choices.period !== 'all';

  const summary = data && (() => {
    const s = data.summary;
    return (
      <Card className="mb-4 px-4 py-3 text-sm text-stone-700" aria-live="polite">
        <p>
          <b className="tabular font-semibold text-stone-900">{plural(s.cycles, 'cycle')}</b> {choices.period === 'all' ? 'in all' : inPeriod}
          {s.on_other_jobs > 0 && <span className="text-stone-500"> ({s.on_open_jobs} on open jobs, {s.on_other_jobs} on jobs no longer open)</span>}
          <span className="text-stone-400 max-sm:hidden" aria-hidden="true"> · </span><span className="max-sm:block">
            <b className="tabular font-semibold text-stone-900">{s.touched}</b> of {plural(s.open_jobs, 'open job')} touched,{' '}
            <b className={cx('tabular font-semibold', s.untouched ? 'text-amber-800' : 'text-stone-900')}>{s.untouched}</b> not touched
          </span>
        </p>
        {data.from && (
          <p className="mt-0.5 text-xs text-stone-500">
            {choices.period === 'week'
              ? `This week: from ${longDay(data.from_day)}, ${data.time_zone.split('/').pop().replace(/_/g, ' ')} time`
              : `${periodLabel}: since ${fmtWhen(data.from)}`}
          </p>
        )}
      </Card>
    );
  })();

  const filters = data && (
    <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2">
      <label className="flex items-center gap-2 text-sm text-stone-700">
        <span className="font-medium">Account executive</span>
        <Select value={choices.ae} onChange={(e) => choices.set({ ae: e.target.value })} className="!w-auto max-w-56">
          <option value="">Everyone</option>
          {data.account_executives.map((p) => <option key={p.id} value={p.id}>{p.name}{p.on_team ? '' : ' (no longer on the team)'}</option>)}
          <option value="none">Nobody</option>
        </Select>
      </label>
      <Checkbox label="Only jobs not touched in this period" checked={choices.untouched} onChange={(e) => choices.set({ untouched: e.target.checked ? '1' : '' })} />
    </div>
  );

  const emptyTable = data && !data.rows.length && (
    data.summary.open_jobs === 0
      ? <Empty icon={Repeat2} title="No open jobs">{scopeClient ? `${scopeClient.name} has no open jobs right now.` : 'There are no open jobs right now.'} Jobs that are closed, on hold or still drafts are not listed here.</Empty>
      : choices.untouched && !choices.ae
        ? <Empty icon={Repeat2} title={`Every open job was touched ${inPeriod}`}>Each one was ticked on somebody’s list at least once. Untick “Only jobs not touched in this period” to see them all.</Empty>
        : <Empty icon={Repeat2} title="No open jobs match these filters" action={<Button size="sm" icon={RefreshCw} onClick={() => choices.set({ ae: '', untouched: '' })}>Show every open job</Button>} />
  );

  // On a phone, where seven columns cannot fit: a card for each job, with the same facts.
  const cards = data && data.rows.length > 0 && !wide && (
    <ul className="divide-y divide-line">
      {data.rows.map((row) => (
        <li key={row.id} className="px-4 py-3">
          <div className="flex items-start gap-2">
            <Opener row={row} open={opened.has(row.id)} onToggle={() => toggle(row.id)} />
            <div className="min-w-0 flex-1">
              <JobName row={row} showClient />
              <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
                <div className="col-span-3"><dt className="text-xs text-stone-500">Last cycle</dt><dd><LastCycle row={row} compact /></dd></div>
                {periodColumn && <div><dt className="text-xs text-stone-500">{periodLabel}</dt><dd className="tabular font-medium text-stone-900">{row.cycles_period}</dd></div>}
                <div><dt className="text-xs text-stone-500">All time</dt><dd className="tabular font-medium text-stone-900">{row.cycles_total}</dd></div>
                <div><dt className="text-xs text-stone-500">Open</dt><dd className="tabular text-stone-900">{plural(row.days_open, 'day')}</dd></div>
                <div><dt className="text-xs text-stone-500">On a list now</dt><dd><OnList people={row.on_list} /></dd></div>
                <div className="col-span-2"><dt className="text-xs text-stone-500">Account executive</dt><dd className="text-stone-900">{aeName(row)}</dd></div>
              </dl>
              {opened.has(row.id) && <div className="mt-3 rounded-lg bg-paper px-3 py-2"><History job={row} /></div>}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );

  const table = data && data.rows.length > 0 && wide && (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-stone-500">
            <th scope="col" className="w-10 py-2 pl-3"><span className="sr-only">Show cycles</span></th>
            <SortHeading id="job" label={showClient ? 'Job and client' : 'Job'} data={data} onSort={sortBy} left className="!pl-1" />
            <SortHeading id="ae" label="Account executive" data={data} onSort={sortBy} left />
            {periodColumn && <SortHeading id="period" label={periodLabel} data={data} onSort={sortBy} />}
            <SortHeading id="total" label="All time" data={data} onSort={sortBy} />
            <SortHeading id="last" label="Last cycle" data={data} onSort={sortBy} left />
            <SortHeading id="on_list" label="On a list now" data={data} onSort={sortBy} left />
            <SortHeading id="open" label="Days open" data={data} onSort={sortBy} className="!pr-4" />
          </tr>
        </thead>
        <tbody className="border-t border-line">
          {data.rows.map((row) => (
            <Fragment key={row.id}>
              <tr className={cx('border-b border-line', opened.has(row.id) && 'bg-paper')}>
                <td className="py-2 pl-3 align-top"><Opener row={row} open={opened.has(row.id)} onToggle={() => toggle(row.id)} /></td>
                <td className="py-2.5 pr-3 pl-1 align-top"><JobName row={row} showClient={showClient} /></td>
                <td className="px-3 py-2.5 align-top text-stone-700">{aeName(row)}</td>
                {periodColumn && <td className="tabular px-3 py-2.5 text-right align-top font-medium text-stone-900">{row.cycles_period}</td>}
                <td className="tabular px-3 py-2.5 text-right align-top text-stone-700">{row.cycles_total}</td>
                <td className="px-3 py-2.5 align-top"><LastCycle row={row} /></td>
                <td className="px-3 py-2.5 align-top"><OnList people={row.on_list} /></td>
                <td className="tabular py-2.5 pr-4 pl-3 text-right align-top text-stone-700">{row.days_open}</td>
              </tr>
              {opened.has(row.id) && (
                <tr className="border-b border-line bg-paper">
                  <td />
                  <td colSpan={periodColumn ? 7 : 6} className="pt-1 pr-4 pb-3 pl-1"><History job={row} /></td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <Page
      title="Cycles"
      subtitle={`${scopeClient ? scopeClient.name : 'All clients'} · Each job ticked on somebody’s Jobs to work on list is one cycle.`}
      actions={
        <Select value={choices.period} onChange={(e) => choices.set({ period: e.target.value === 'week' ? '' : e.target.value })} aria-label="Period" className="!w-auto">
          {PERIODS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </Select>
      }
    >
      {!data ? <Pending error={error} /> : (
        <>
          {summary}
          {filters}
          <Card className="min-w-0">
            <CardHeader title="Open jobs" count={data.rows.length !== data.summary.open_jobs ? `${data.rows.length} of ${data.summary.open_jobs}` : data.rows.length}
              action={<span className="text-xs text-stone-500 max-sm:hidden">Longest untouched first, unless you sort by a column</span>} />
            {emptyTable}
            {cards}
            {table}
          </Card>

          <Card className="mt-6">
            <CardHeader title="By person" action={<span className="text-xs text-stone-500">{periodLabel}</span>} />
            {data.people.length ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-stone-500">
                    <th scope="col" className="px-4 py-2 text-left font-medium">Person</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Cycles</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Different jobs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line border-t border-line">
                  {data.people.map((p) => (
                    <tr key={p.user_id ?? 'removed'}>
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-2.5">
                          <Avatar name={p.name || '?'} size={24} color={p.name ? undefined : '#a8a29e'} />
                          <span className={cx(p.on_team ? 'text-stone-900' : 'text-stone-500')}>{p.name ? who(p) : 'Somebody no longer on the team'}</span>
                        </span>
                      </td>
                      <td className={cx('tabular px-3 py-2.5 text-right font-medium', p.cycles ? 'text-stone-900' : 'text-stone-400')}>{p.cycles}</td>
                      <td className={cx('tabular px-4 py-2.5 text-right', p.jobs ? 'text-stone-700' : 'text-stone-400')}>{p.jobs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty icon={Users} title="Nobody on the team yet" />}
          </Card>

          <dl className="mt-4 grid gap-x-8 gap-y-2 text-[13px] leading-relaxed text-stone-500 sm:grid-cols-2">
            <div><dt className="inline font-medium text-stone-700">A cycle. </dt><dd className="inline">One job ticked on somebody’s own Jobs to work on list. Un-ticking it takes the cycle away; ticking it again counts once more. People to prep and to debrief do not count.</dd></div>
            <div><dt className="inline font-medium text-stone-700">What it says. </dt><dd className="inline">That somebody ticked the job, and when: not what they did. Nobody else sees the notes on their list.</dd></div>
            <div><dt className="inline font-medium text-stone-700">Which jobs. </dt><dd className="inline">Open jobs only. Cycles on jobs since closed, filled or put on hold are kept, and count in the summary and By person.</dd></div>
            {data.history_from && <div><dt className="inline font-medium text-stone-700">Since when. </dt><dd className="inline">Cycles are counted from {fmtDate(data.history_from, true)}. Jobs ticked before then count only if they were still on somebody’s list that day.</dd></div>}
          </dl>
        </>
      )}
    </Page>
  );
}
