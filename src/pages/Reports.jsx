import React, { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import { useApp, useApi, useOpenCandidate } from '../state.jsx';
import { url, fmtDate, money } from '../lib.js';
import { Button, Card, CardHeader, Loading, Page, Select, Stat, cx } from '../ui.jsx';

const RANGES = [['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last 12 months'], ['', 'All time']];
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');

/** Horizontal magnitude bar: one hue, value labelled in ink beside it. */
function Bar({ value, max, className }) {
  return (
    <div className={cx('h-2.5 rounded-full bg-stone-100', className)}>
      <div className="h-full rounded-full bg-brand-600" style={{ width: `${max ? Math.max((value / max) * 100, value ? 2 : 0) : 0}%` }} />
    </div>
  );
}

function Funnel({ steps }) {
  const max = steps[0]?.count || 0;
  return (
    <div className="space-y-3 p-4">
      {steps.map((s, i) => (
        <div key={s.label} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm">
          <span className="truncate text-stone-700">{s.label}</span>
          <Bar value={s.count} max={max} />
          <span className="tabular flex w-24 items-baseline justify-end gap-2">
            <span className="font-semibold text-stone-900">{s.count}</span>
            <span className="w-11 text-right text-xs text-stone-500" title={i ? 'Of the previous step' : undefined}>{i ? pct(s.count, steps[i - 1].count) : ''}</span>
          </span>
        </div>
      ))}
      <p className="pt-1 text-xs text-stone-500">Percentages show how many moved on from the step before.</p>
    </div>
  );
}

function Weekly({ weeks }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...weeks.map((w) => w.count));
  return (
    <div className="p-4">
      <div className="flex h-36 items-end gap-[2px] border-b border-stone-300" role="img" aria-label={`Applications per week for the last 12 weeks: ${weeks.map((w) => w.count).join(', ')}`}>
        {weeks.map((w, i) => (
          <div key={w.start} className="relative flex h-full flex-1 items-end justify-center" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            {hover === i && (
              <div className="pointer-events-none absolute bottom-full z-10 mb-1 rounded-md bg-stone-900 px-2 py-1 text-xs whitespace-nowrap text-white shadow">
                <span className="font-semibold">{w.count}</span> applied · week of {fmtDate(w.start)}
              </div>
            )}
            <div className={cx('w-full max-w-7 rounded-t-[4px]', hover === i ? 'bg-brand-800' : 'bg-brand-600')} style={{ height: `${(w.count / max) * 100}%`, minHeight: w.count ? 2 : 0 }} />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-xs text-stone-500">
        <span>{fmtDate(weeks[0].start)}</span>
        <span>Peak week: {max}</span>
        <span>{fmtDate(weeks.at(-1).start)}</span>
      </div>
    </div>
  );
}

export default function Reports() {
  const { scope, scopeClient, isAgency, agencyName } = useApp();
  const openCandidate = useOpenCandidate();
  const [days, setDays] = useState('90');
  const [jobId, setJobId] = useState('');
  useEffect(() => setJobId(''), [scope]);
  const { data: jobs } = useApi(url('/jobs', { client_id: scope }));
  const { data } = useApi(url('/reports', { client_id: scope, job_id: jobId, days }));
  const rangeLabel = RANGES.find(([v]) => v === days)[1].toLowerCase();
  const job = jobs?.find((j) => String(j.id) === jobId);

  return (
    <Page
      title="Reports"
      subtitle={`${job ? job.title : scopeClient ? scopeClient.name : 'All clients'} · ${rangeLabel}${isAgency ? ` · prepared by ${agencyName}` : ''}`}
      actions={
        <>
          <Select value={jobId} onChange={(e) => setJobId(e.target.value)} aria-label="Job" className="!w-auto max-w-56">
            <option value="">All jobs</option>
            {(jobs || []).map((j) => <option key={j.id} value={j.id}>{j.title}{scope ? '' : ` · ${j.client_name}`}</option>)}
          </Select>
          <Select value={days} onChange={(e) => setDays(e.target.value)} aria-label="Period" className="!w-auto">
            {RANGES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </Select>
          <Button icon={Printer} onClick={() => window.print()}>Print or save PDF</Button>
        </>
      }
    >
      {!data ? <Loading /> : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Applicants" value={data.totals.applicants} />
            <Stat label="Reached interview" value={data.totals.interviewed} hint={`${pct(data.totals.interviewed, data.totals.applicants)} of applicants`} />
            <Stat label="Hires" value={data.totals.hires} />
            <Stat label="Average time to hire" value={data.totals.avg_days_to_hire != null ? `${data.totals.avg_days_to_hire} days` : '–'} hint="application to hired" />
            <Stat label="Offer acceptance" value={data.totals.offer_acceptance != null ? `${data.totals.offer_acceptance}%` : '–'} hint="of offers decided" />
          </div>

          {isAgency && data.revenue?.length > 0 && (
            <Card className="no-print">
              <CardHeader title="Your revenue" action={<span className="text-xs text-stone-500">Visible to your agency only</span>} />
              <div className="grid gap-x-10 gap-y-3 p-4 sm:grid-cols-2">
                {data.revenue.map((r) => (
                  <React.Fragment key={r.currency}>
                    <div><div className="text-[13px] text-stone-500">Monthly retainers ({r.currency})</div><div className="tabular text-xl font-semibold">{money(r.monthly_retainers, r.currency)}</div></div>
                    <div><div className="text-[13px] text-stone-500">Placement fees, {rangeLabel} ({r.currency})</div><div className="tabular text-xl font-semibold">{money(r.placement_fees, r.currency)}</div></div>
                  </React.Fragment>
                ))}
              </div>
            </Card>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Hiring funnel" action={<span className="text-xs text-stone-500">Candidates who applied in this period</span>} />
              <Funnel steps={data.funnel} />
            </Card>
            <Card>
              <CardHeader title="New applications per week" action={<span className="text-xs text-stone-500">Last 12 weeks</span>} />
              <Weekly weeks={data.weeks} />
            </Card>
          </div>

          <Card>
            <CardHeader title="Where candidates come from" />
            {data.sources.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="text-left text-xs text-stone-500">
                      <th className="px-4 py-2 font-medium">Source</th>
                      <th className="w-2/5 px-3 py-2 font-medium">Applicants</th>
                      <th className="px-3 py-2 text-right font-medium">Reached interview</th>
                      <th className="px-3 py-2 text-right font-medium">Interview rate</th>
                      <th className="px-4 py-2 text-right font-medium">Hired</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line border-t border-line">
                    {data.sources.map((s) => (
                      <tr key={s.source}>
                        <td className="px-4 py-2.5 font-medium text-stone-800">{s.label}</td>
                        <td className="px-3 py-2.5">
                          <span className="flex items-center gap-3"><Bar value={s.applicants} max={data.sources[0].applicants} className="flex-1" /><span className="tabular w-8 text-right font-medium">{s.applicants}</span></span>
                        </td>
                        <td className="tabular px-3 py-2.5 text-right">{s.interviewed}</td>
                        <td className="tabular px-3 py-2.5 text-right">{pct(s.interviewed, s.applicants)}</td>
                        <td className="tabular px-4 py-2.5 text-right">{s.hired}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="px-4 py-6 text-sm text-stone-500">No applications in this period.</p>}
          </Card>

          <Card>
            <CardHeader title="Open roles" count={data.openRoles.length} />
            {data.openRoles.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="text-left text-xs text-stone-500">
                      <th className="px-4 py-2 font-medium">Role</th>
                      <th className="px-3 py-2 text-right font-medium">Days open</th>
                      <th className="px-3 py-2 text-right font-medium">New</th>
                      <th className="px-3 py-2 text-right font-medium">Interviewing</th>
                      <th className="px-3 py-2 text-right font-medium">Offer</th>
                      <th className="px-4 py-2 text-right font-medium">Filled</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line border-t border-line">
                    {data.openRoles.map((r) => (
                      <tr key={r.id}>
                        <td className="px-4 py-2.5"><span className="font-medium text-stone-800">{r.title}</span>{!scope && <span className="text-stone-500"> · {r.client_name}</span>}</td>
                        <td className="tabular px-3 py-2.5 text-right">{r.days_open}</td>
                        <td className="tabular px-3 py-2.5 text-right">{r.new_applicants}</td>
                        <td className="tabular px-3 py-2.5 text-right">{r.interviewing}</td>
                        <td className="tabular px-3 py-2.5 text-right">{r.offers}</td>
                        <td className="tabular px-4 py-2.5 text-right">{r.hires}/{r.openings}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="px-4 py-6 text-sm text-stone-500">No open roles right now.</p>}
          </Card>

          <Card>
            <CardHeader title="Hires" count={data.hires.length} />
            {data.hires.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="text-left text-xs text-stone-500">
                      <th className="px-4 py-2 font-medium">Name</th>
                      <th className="px-3 py-2 font-medium">Role</th>
                      <th className="px-3 py-2 font-medium">Source</th>
                      <th className="px-3 py-2 text-right font-medium">Hired</th>
                      <th className="px-3 py-2 text-right font-medium">Days to hire</th>
                      {isAgency && <th className="no-print px-4 py-2 text-right font-medium">Your fee</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line border-t border-line">
                    {data.hires.map((h) => (
                      <tr key={h.id} onClick={() => openCandidate(h.id)} className="cursor-pointer hover:bg-stone-50">
                        <td className="px-4 py-2.5 font-medium text-stone-800">{h.name}</td>
                        <td className="px-3 py-2.5">{h.job_title}{!scope && <span className="text-stone-500"> · {h.client_name}</span>}</td>
                        <td className="px-3 py-2.5 text-stone-600">{h.source}</td>
                        <td className="tabular px-3 py-2.5 text-right">{fmtDate(h.hired_at, true)}</td>
                        <td className="tabular px-3 py-2.5 text-right">{h.days_to_hire}</td>
                        {isAgency && <td className="no-print tabular px-4 py-2.5 text-right">{h.fee ? money(h.fee, h.currency) : <span className="text-stone-400">Retainer</span>}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="px-4 py-6 text-sm text-stone-500">No hires in this period yet.</p>}
          </Card>
        </div>
      )}
    </Page>
  );
}
