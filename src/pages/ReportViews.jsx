// The two reports built from recorded moments: one row per recruiter ("Individual") and one row per client
// ("Clients"). Both count only what has happened since the day counting started, which is shown at the top and which
// an admin can change. Agency only. The numbers themselves, and the order of the rows, come from the server.
import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, CalendarClock, Printer } from 'lucide-react';
import { useApp, useApi, useOpenCandidate, Pending } from '../state.jsx';
import { api, url, fmtDate, money, plural } from '../lib.js';
import { Button, Card, ClientDot, Empty, Field, Input, Modal, Page, Select, Tabs, useAction, useToast, cx } from '../ui.jsx';

const VIEWS = [{ id: 'overview', label: 'Overview' }, { id: 'individual', label: 'Individual' }, { id: 'clients', label: 'Clients' }];
/** Which report the address asks for. Client users only ever get the overview. */
export function useReportView() {
  const { isAgency } = useApp();
  const [params] = useSearchParams();
  const view = params.get('view');
  return isAgency && (view === 'individual' || view === 'clients') ? view : 'overview';
}

/** The switch between the three reports. The choice lives in the address (?view=clients), so a report can be linked to. */
export function ReportTabs() {
  const view = useReportView();
  const [, setParams] = useSearchParams();
  const go = (id) => {
    // Each report has its own period and sorting, so those are dropped; an open candidate (?c=) is not ours to keep either.
    const next = new URLSearchParams();
    if (id !== 'overview') next.set('view', id);
    setParams(next, { replace: true });
  };
  return <Tabs className="no-print mb-6" tabs={VIEWS} value={view} onChange={(id) => id !== view && go(id)} />;
}

const Dash = () => <span className="text-stone-400">–</span>;
const longDay = (ymd) => new Date(`${ymd}T00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const wholePercent = (n) => `${Math.round(n)}%`;
const days = (n) => `${Number.isInteger(n) ? n : n.toFixed(1)} ${n === 1 ? 'day' : 'days'}`;
/** Fees as written, one figure per currency: "£12,000", or "£12,000 + CA$8,000" when a client has been billed in two. */
const moneyList = (list, joiner = ' + ') => (list.length ? list.map((m) => money(m.amount, m.currency)).join(joiner) : null);

function StartModal({ start, onClose }) {
  const { bump } = useApp();
  const toast = useToast();
  const [date, setDate] = useState(start.date);
  const [save, busy] = useAction(async () => {
    await api.put('/reports/start', { date });
    toast('Start date saved');
    bump();
    onClose();
  });
  return (
    <Modal title="When counting starts" size="sm" onClose={onClose} onSubmit={save}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Save</Button></>}>
      <Field label="Count from" hint={`Counting starts at the beginning of this day, ${start.time_zone.split('/').pop().replace(/_/g, ' ')} time. Nothing before it is counted.`}>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required autoFocus />
      </Field>
      <p className="text-[13px] leading-relaxed text-stone-500">
        The numbers are written down as things happen, from the start date onwards. Moving the date later hides what was recorded before it. Moving it earlier cannot bring back anything from before the day counting first began, because nothing was written down then.
      </p>
    </Modal>
  );
}

/** "Counting from Monday 16 November 2026", with the way to change it for an admin. Before that day, it says so and there are no numbers. */
function Start({ start, children }) {
  const { isAdmin } = useApp();
  const [editing, setEditing] = useState(false);
  const change = isAdmin && <Button size="sm" className="no-print" onClick={() => setEditing(true)}>Change the date</Button>;
  return (
    <>
      {start.started ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-line bg-white px-4 py-3 text-sm">
          <p className="min-w-0 flex-1 basis-64 text-stone-600">
            <span className="font-medium text-stone-900">Counting from {longDay(start.date)}.</span> Nothing before that day is counted, and “lifetime” means since then.
          </p>
          {change}
        </div>
      ) : (
        <Card>
          <Empty icon={CalendarClock} title={`Counting begins on ${longDay(start.date)}`} action={change || undefined}>
            From that day, every submission, first interview, placement and new search is recorded as it happens. Nothing before it is counted, so there are no numbers to show yet.
          </Empty>
        </Card>
      )}
      {start.started && children}
      {editing && <StartModal start={start} onClose={() => setEditing(false)} />}
    </>
  );
}

/**
 * A column heading that sorts by its column: click once for the usual order, again for the reverse. The arrow sits
 * before a right-aligned heading, so the heading ends where the numbers under it end.
 */
function SortHeading({ label, sub, active, dir, onSort, left, className }) {
  const Arrow = dir === 'asc' ? ArrowUp : ArrowDown;
  const arrow = active && <Arrow className="mb-0.5 size-3.5 shrink-0" aria-hidden="true" />;
  return (
    <th scope="col" aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined} className={cx('px-3 py-2 align-bottom font-medium', left ? 'text-left' : 'text-right', className)}>
      <button type="button" onClick={onSort} title="Sort by this column" className={cx('inline-flex items-end gap-1 rounded text-inherit hover:text-stone-900', left ? 'text-left' : 'text-right', active && 'text-stone-900')}>
        {!left && arrow}
        <span className="whitespace-nowrap print:whitespace-normal">{label}{sub && <span className="block font-normal">{sub}</span>}</span>
        {left && arrow}
      </button>
    </th>
  );
}

/** "Sort by" with two drop-downs: what to sort by, and high to low or low to high. */
function SortControls({ options, sort, dir, onChange, label, className }) {
  return (
    <div className={cx('no-print mb-3 flex flex-wrap items-center gap-2', className)}>
      <span className="text-sm font-medium text-stone-700">Sort by</span>
      <Select value={sort} onChange={(e) => onChange({ sort: e.target.value, dir })} aria-label={label} className="!w-auto max-w-full">
        {options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
      </Select>
      <Select value={dir} onChange={(e) => onChange({ sort, dir: e.target.value })} aria-label="Order" className="!w-auto">
        <option value="desc">High to low</option>
        <option value="asc">Low to high</option>
      </Select>
    </div>
  );
}

/** The sorting kept in the address: the column, the direction, and how to change them. */
function useSorting(defaultDir) {
  const [params, setParams] = useSearchParams();
  const set = (changes) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) value ? next.set(key, value) : next.delete(key);
    setParams(next, { replace: true });
  };
  return {
    sort: params.get('sort') || '', dir: params.get('dir') || '', set,
    /** What a click on a column heading does, given how the rows are sorted now. */
    toggle: (key, now) => set(now.sort === key ? { sort: key, dir: now.dir === 'asc' ? 'desc' : 'asc' } : { sort: key, dir: defaultDir(key) }),
  };
}

// ---------- Individual ----------
const PERIODS = [['all', 'Since counting started'], ['month', 'This month'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['12m', 'Last 12 months']];
const INDIVIDUAL_COLUMNS = [['submissions', 'Submissions'], ['interviews', 'Interviews'], ['ratio', 'Interview/Submission ratio'], ['placements', 'Placements']];

export function IndividualReport() {
  const { scope, scopeClient, isAdmin, agencyName } = useApp();
  const [params] = useSearchParams();
  const sorting = useSorting((key) => (key === 'name' ? 'asc' : 'desc'));
  const period = PERIODS.some(([id]) => id === params.get('period')) ? params.get('period') : 'all';
  const { data, error } = useApi(url('/reports/individual', { client_id: scope, period, sort: sorting.sort, dir: sorting.dir }));
  const periodLabel = PERIODS.find(([id]) => id === period)[1];
  const heading = (key, label, extra) => <SortHeading key={key} label={label} active={data.sort === key} dir={data.dir} onSort={() => sorting.toggle(key, data)} {...extra} />;
  const values = (r) => ({ submissions: r.submissions, interviews: r.interviews, ratio: r.ratio != null ? wholePercent(r.ratio) : <Dash />, placements: r.placements });
  const cells = (r) => INDIVIDUAL_COLUMNS.map(([key], i) => <td key={key} className={cx('tabular py-2.5 text-right', i === INDIVIDUAL_COLUMNS.length - 1 ? 'pr-4 pl-3' : 'px-3')}>{values(r)[key]}</td>);
  const name = (r) => <>{r.name}{!r.active && <span className="font-normal text-stone-500"> (deactivated)</span>}</>;
  // On a phone, where five columns cannot fit: the same numbers as a block per recruiter.
  const block = (r, title, total) => (
    <div key={r.user_id ?? title} className={cx('px-4 py-3', total && 'border-t-2 border-line')}>
      <h3 className={cx('text-sm text-stone-900', total ? 'font-semibold' : 'font-medium')}>{title}</h3>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
        {INDIVIDUAL_COLUMNS.map(([key, label]) => (
          <div key={key}>
            <dt className="text-xs text-stone-500">{label}</dt>
            <dd className={cx('tabular mt-0.5 text-sm text-stone-900', total ? 'font-semibold' : 'font-medium')}>{values(r)[key]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );

  return (
    <Page
      title="Reports"
      subtitle={`Individual · ${scopeClient ? scopeClient.name : 'All clients'}${data?.start.started ? ` · ${periodLabel.toLowerCase()}` : ''} · prepared by ${agencyName}`}
      actions={
        <>
          {data?.start.started && (
            <Select value={period} onChange={(e) => sorting.set({ period: e.target.value === 'all' ? '' : e.target.value })} aria-label="Period" className="!w-auto">
              {PERIODS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </Select>
          )}
          <Button icon={Printer} onClick={() => window.print()}>Print or save PDF</Button>
        </>
      }
    >
      <ReportTabs />
      {!data ? <Pending error={error} /> : (
        <Start start={data.start}>
          {data.rows.length > 1 && (
            <SortControls className="sm:hidden" label="Sort recruiters by" options={[['name', 'Name'], ...INDIVIDUAL_COLUMNS]} sort={data.sort} dir={data.dir} onChange={sorting.set} />
          )}
          <Card>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-3">
              <h2 className="text-sm font-semibold text-stone-900">{isAdmin ? 'Recruiters' : 'Your numbers'}</h2>
              <span className="text-xs text-stone-500">{periodLabel}: {fmtDate(data.from, true)} to {fmtDate(data.to, true)}</span>
            </div>
            {data.rows.length > 0 && (
              <div className="divide-y divide-line sm:hidden print:hidden">
                {data.rows.map((r) => block(r, name(r)))}
                {data.totals && block(data.totals, 'Everyone', true)}
              </div>
            )}
            {data.rows.length ? (
              <div className="hidden overflow-x-auto sm:block print:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-stone-500">
                      {heading('name', 'Recruiter', { left: true, className: '!px-4' })}
                      {INDIVIDUAL_COLUMNS.map(([key, label], i) => heading(key, label, { className: i === INDIVIDUAL_COLUMNS.length - 1 ? '!pr-4' : '' }))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line border-t border-line">
                    {data.rows.map((r) => (
                      <tr key={r.user_id ?? 'nobody'}>
                        <td className="px-4 py-2.5 font-medium text-stone-800">{name(r)}</td>
                        {cells(r)}
                      </tr>
                    ))}
                  </tbody>
                  {data.totals && (
                    <tfoot className="border-t-2 border-line">
                      <tr className="font-semibold text-stone-900"><td className="px-4 py-2.5">Everyone</td>{cells(data.totals)}</tr>
                    </tfoot>
                  )}
                </table>
              </div>
            ) : <p className="px-4 py-6 text-sm text-stone-500">Nothing has been recorded yet. A recruiter appears here once they submit a candidate or make a placement.</p>}
          </Card>
          <dl className="mt-4 grid gap-x-8 gap-y-2 text-[13px] leading-relaxed text-stone-500 sm:grid-cols-2">
            <div><dt className="inline font-medium text-stone-700">Submissions. </dt><dd className="inline">Candidates sent to the client’s hiring team for the first time, credited to whoever sent them.</dd></div>
            <div><dt className="inline font-medium text-stone-700">Interviews. </dt><dd className="inline">Submitted candidates who got their first interview with the client, credited to whoever submitted them.</dd></div>
            <div><dt className="inline font-medium text-stone-700">Interview/Submission ratio. </dt><dd className="inline">Interviews divided by submissions, both in the period shown.</dd></div>
            <div><dt className="inline font-medium text-stone-700">Placements. </dt><dd className="inline">Candidates marked hired, credited to the recruiter who owned them at that moment.</dd></div>
          </dl>
          {!isAdmin && <p className="mt-3 text-[13px] text-stone-500">You see your own numbers here. Admins see everyone’s.</p>}
        </Start>
      )}
    </Page>
  );
}

// ---------- Clients ----------
const METRICS = [
  ['reqs', 'Total reqs, lifetime'], ['reqs_12m', 'Total reqs, last 12 months'], ['interview_pct', 'Interview %'], ['placement_pct', 'Placement %'],
  ['time_to_fill', 'Time to fill'], ['billings', 'Total billings, lifetime'], ['billings_12m', 'Total billings, last 12 months'], ['avg_fee', 'Average fee per placement'],
];
const MONEY_METRICS = ['billings', 'billings_12m', 'avg_fee'];

/** What each cell of a client's row shows, with the counts behind a percentage underneath it. */
function clientValues(r) {
  const under = (text) => <span className="block text-xs font-normal text-stone-500">{text}</span>;
  return {
    reqs: r.reqs || <Dash />,
    reqs_12m: r.reqs_12m || <Dash />,
    interview_pct: r.interview_pct != null ? <>{wholePercent(r.interview_pct)}{under(`${r.interviews} of ${r.submissions}`)}</> : <Dash />,
    placement_pct: r.placement_pct != null ? <>{wholePercent(r.placement_pct)}{under(`${r.reqs_filled} of ${r.reqs} filled`)}</> : <Dash />,
    time_to_fill: r.time_to_fill != null ? days(r.time_to_fill) : <Dash />,
    billings: moneyList(r.billings) ?? <Dash />,
    billings_12m: moneyList(r.billings_12m) ?? <Dash />,
    avg_fee: moneyList(r.avg_fee, ' · ') ?? <Dash />,
  };
}

export function ClientsReport() {
  const { scope, scopeClient, agencyName } = useApp();
  const openCandidate = useOpenCandidate();
  const sorting = useSorting(() => 'desc');
  const { data, error } = useApi(url('/reports/clients', { client_id: scope, sort: sorting.sort, dir: sorting.dir }));
  const metricLabel = data ? METRICS.find(([id]) => id === data.sort)[1] : '';
  const heading = (key, label, extra) => <SortHeading key={key} label={label} active={data.sort === key} dir={data.dir} onSort={() => sorting.toggle(key, data)} {...extra} />;

  return (
    <Page
      title="Reports"
      subtitle={`Clients · ${scopeClient ? scopeClient.name : 'All clients'}${data?.start.started ? ` · sorted by ${metricLabel.toLowerCase()}, ${data.dir === 'asc' ? 'low to high' : 'high to low'}` : ''} · prepared by ${agencyName}`}
      actions={<Button icon={Printer} onClick={() => window.print()}>Print or save PDF</Button>}
    >
      <ReportTabs />
      {!data ? <Pending error={error} /> : (
        <Start start={data.start}>
          <SortControls label="Sort clients by" options={METRICS} sort={data.sort} dir={data.dir} onChange={sorting.set} />
          {data.mixed_currencies && MONEY_METRICS.includes(data.sort) && (
            <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
              These clients are billed in different currencies. Each amount is shown in the client’s own currency, and this order compares the figures as written, without converting them.
            </p>
          )}

          {/* A table on a wide screen and on paper; a card per client where nine columns cannot fit. */}
          <Card className="hidden xl:block print:block">
            <div className="overflow-x-auto print:overflow-visible">
              <table className="w-full text-sm print:text-[11px]">
                <thead>
                  <tr className="text-xs text-stone-500">
                    <th scope="col" rowSpan={2} className="px-4 py-2 text-left align-bottom font-medium">Client</th>
                    <th scope="colgroup" colSpan={2} className="border-b border-line px-3 pt-2 pb-1 text-center font-medium">Total reqs</th>
                    <th colSpan={3} />
                    <th scope="colgroup" colSpan={2} className="border-b border-line px-3 pt-2 pb-1 text-center font-medium">Total billings</th>
                    <th />
                  </tr>
                  <tr className="text-xs text-stone-500">
                    {heading('reqs', 'Lifetime')}
                    {heading('reqs_12m', 'Last 12 months')}
                    {heading('interview_pct', 'Interview %')}
                    {heading('placement_pct', 'Placement %')}
                    {heading('time_to_fill', 'Time to fill')}
                    {heading('billings', 'Lifetime')}
                    {heading('billings_12m', 'Last 12 months')}
                    {heading('avg_fee', 'Average fee', { sub: 'per placement', className: '!pr-4' })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line border-t border-line">
                  {data.rows.map((r) => {
                    const v = clientValues(r);
                    return (
                      <tr key={r.id} className="align-top">
                        <td className="px-4 py-2.5 font-medium whitespace-nowrap text-stone-800 print:whitespace-normal"><span className="flex items-center gap-2"><ClientDot color={r.brand_color} />{r.name}</span></td>
                        {METRICS.map(([id], i) => <td key={id} className={cx('tabular py-2.5 text-right whitespace-nowrap', i === METRICS.length - 1 ? 'pr-4 pl-3' : 'px-3')}>{v[id]}</td>)}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!data.rows.length && <p className="px-4 py-6 text-sm text-stone-500">There are no clients yet.</p>}
          </Card>
          <div className="space-y-3 xl:hidden print:hidden">
            {data.rows.map((r) => {
              const v = clientValues(r);
              return (
                <Card key={r.id} className="p-4">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-900"><ClientDot color={r.brand_color} />{r.name}</h2>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                    {METRICS.map(([id, label]) => (
                      <div key={id} className={cx(data.sort === id && '-m-1.5 rounded-lg bg-brand-50 p-1.5')}>
                        <dt className="text-xs text-stone-500">{label}</dt>
                        <dd className="tabular mt-0.5 text-sm font-medium text-stone-900">{v[id]}</dd>
                      </div>
                    ))}
                  </dl>
                </Card>
              );
            })}
            {!data.rows.length && <Card className="px-4 py-6 text-sm text-stone-500">There are no clients yet.</Card>}
          </div>

          {data.missing_fees.length > 0 && (
            <div className="no-print mt-4 rounded-lg bg-amber-50 px-3 py-2 text-[13px] leading-relaxed text-amber-900">
              {plural(data.missing_fees.length, 'placement has', 'placements have')} no fee recorded, so {data.missing_fees.length === 1 ? 'it is' : 'they are'} missing from the billings. Open the candidate to add it:{' '}
              {data.missing_fees.map((m, i) => (
                <React.Fragment key={m.application_id}>
                  {i > 0 && ', '}
                  <button type="button" onClick={() => openCandidate(m.application_id)} className="font-medium underline hover:text-amber-950">{m.candidate_name}</button> ({m.client_name})
                </React.Fragment>
              ))}.
            </div>
          )}
          <p className="mt-4 text-[13px] text-stone-500">Figures as of {fmtDate(data.to, true)}. Billings are placement fees only: monthly retainers are not included. A dash means there is nothing to show yet; those clients are listed last whichever way you sort.</p>
          <dl className="mt-3 grid gap-x-8 gap-y-2 text-[13px] leading-relaxed text-stone-500 sm:grid-cols-2">
            <div><dt className="inline font-medium text-stone-700">Total reqs. </dt><dd className="inline">Searches opened: jobs that became open for the first time since counting started.</dd></div>
            <div><dt className="inline font-medium text-stone-700">Interview %. </dt><dd className="inline">First interviews with the client divided by submissions, across all of that client’s searches.</dd></div>
            <div><dt className="inline font-medium text-stone-700">Placement %. </dt><dd className="inline">Searches filled divided by searches opened: the client’s fill rate. A search is filled when every opening on it has been hired into.</dd></div>
            <div><dt className="inline font-medium text-stone-700">Time to fill. </dt><dd className="inline">The average number of days from a search opening to the accepted offer, or to the hire when no accepted offer was on record.</dd></div>
            <div><dt className="inline font-medium text-stone-700">Total billings. </dt><dd className="inline">The fees recorded for placements, in the client’s currency.</dd></div>
            <div><dt className="inline font-medium text-stone-700">Average fee per placement. </dt><dd className="inline">Total billings divided by the number of placements that have a fee.</dd></div>
          </dl>
        </Start>
      )}
    </Page>
  );
}
