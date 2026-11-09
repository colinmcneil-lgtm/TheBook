import React from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, Briefcase, Inbox, Hourglass, ClipboardCheck, ArrowRight, UserPlus } from 'lucide-react';
import { useApp, useApi, useOpenCandidate, Pending } from '../state.jsx';
import { url, ago, daysSince, firstName, fmtDay, plural } from '../lib.js';
import { Card, CardHeader, Empty, Page, Stat, Avatar } from '../ui.jsx';
import { ClientName, InterviewLine, StageBadge } from '../components/bits.jsx';

function Nudge({ icon: Icon, to, children }) {
  return (
    <Link to={to} className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 transition-colors hover:border-amber-300">
      <Icon className="size-4 shrink-0" />
      <span className="flex-1">{children}</span>
      <ArrowRight className="size-4 shrink-0 opacity-60" />
    </Link>
  );
}

export default function Dashboard() {
  const { user, scope, scopeClient, isAgency, clients } = useApp();
  const openCandidate = useOpenCandidate();
  const { data, error } = useApi(url('/dashboard', { client_id: scope }));
  const { data: nav } = useApi(url('/nav', { client_id: scope }));
  const { data: clientRows } = useApi(isAgency && !scope ? '/clients' : null);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  if (!data) return <Pending error={error} />;
  const s = data.stats;

  // Group upcoming interviews by day.
  const days = [];
  for (const i of data.upcoming) {
    const label = fmtDay(i.starts_at);
    const group = days.at(-1)?.label === label ? days.at(-1) : (days.push({ label, items: [] }), days.at(-1));
    group.items.push(i);
  }

  return (
    <Page title={`${greeting}, ${firstName(user.name)}`} subtitle={scopeClient ? `Hiring at ${scopeClient.name}` : `Hiring across ${plural(clients.length, 'client')}`}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat Link={Link} to="/jobs" label="Open roles" value={s.open_jobs} />
        <Stat Link={Link} to="/candidates" label="Active candidates" value={s.active_candidates} />
        <Stat Link={Link} to="/inbox?tab=new" label="New applicants" value={s.new_applicants} hint="waiting for a first review" />
        <Stat Link={Link} to="/interviews" label="Interviews" value={s.interviews_week} hint="next 7 days" />
        <Stat label="Offers out" value={s.offers_out} />
        <Stat Link={Link} to="/reports" label="Hires" value={s.hires_90d} hint="last 90 days" />
      </div>

      {(nav?.scorecards_due > 0 || nav?.pending_accounts > 0 || s.pending_review > 0 || (isAgency && s.new_applicants > 0)) && (
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {nav?.pending_accounts > 0 && <Nudge icon={UserPlus} to="/settings?tab=team">{plural(nav.pending_accounts, 'person', 'people')} waiting for you to approve their account</Nudge>}
          {isAgency && s.new_applicants > 0 && <Nudge icon={Inbox} to="/inbox">{plural(s.new_applicants, 'new applicant')} to review</Nudge>}
          {s.pending_review > 0 && (
            <Nudge icon={Hourglass} to="/inbox?tab=review">
              {isAgency ? `${plural(s.pending_review, 'shortlisted candidate')} waiting on the hiring team` : `${plural(s.pending_review, 'candidate')} waiting for your review`}
            </Nudge>
          )}
          {nav?.scorecards_due > 0 && <Nudge icon={ClipboardCheck} to="/interviews?tab=feedback">{plural(nav.scorecards_due, 'scorecard')} for you to complete</Nudge>}
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <div className="min-w-0 space-y-6">
          {clientRows && (
            <Card>
              <CardHeader title="Clients" action={<Link to="/clients" className="text-[13px] font-medium text-brand-700 hover:underline">Manage</Link>} />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-stone-500">
                      <th className="px-4 py-2 font-medium">Client</th>
                      <th className="px-3 py-2 text-right font-medium">Open roles</th>
                      <th className="px-3 py-2 text-right font-medium">New</th>
                      <th className="px-3 py-2 text-right font-medium">In process</th>
                      <th className="px-3 py-2 text-right font-medium">Interviews</th>
                      <th className="px-4 py-2 text-right font-medium">Hires</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line border-t border-line">
                    {clientRows.map((c) => (
                      <tr key={c.id} className="hover:bg-stone-50">
                        <td className="px-4 py-2.5"><Link to={`/clients/${c.id}`} className="font-medium text-stone-900 hover:underline"><ClientName always name={c.name} color={c.brand_color} /></Link></td>
                        <td className="tabular px-3 py-2.5 text-right">{c.open_jobs}</td>
                        <td className="tabular px-3 py-2.5 text-right">{c.new_applicants}</td>
                        <td className="tabular px-3 py-2.5 text-right">{c.active_candidates}</td>
                        <td className="tabular px-3 py-2.5 text-right">{c.upcoming_interviews}</td>
                        <td className="tabular px-4 py-2.5 text-right">{c.hires}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <Card>
            <CardHeader title="Open roles" action={<Link to="/jobs" className="text-[13px] font-medium text-brand-700 hover:underline">All jobs</Link>} />
            {data.jobs.length ? (
              <ul className="divide-y divide-line">
                {data.jobs.map((j) => (
                  <li key={j.id}>
                    <Link to={`/jobs/${j.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-stone-50">
                      <span className="min-w-0 flex-1 basis-48">
                        <span className="block truncate text-sm font-medium text-stone-900">{j.title}</span>
                        <span className="flex items-center gap-2 text-[13px] text-stone-500">
                          <ClientName name={j.client_name} color={j.brand_color} />
                          <span>Open {daysSince(j.opened_at)}d</span>
                        </span>
                      </span>
                      <span className="tabular flex gap-4 text-[13px] text-stone-600">
                        <span><b className="font-semibold text-stone-900">{j.new_applicants}</b> new</span>
                        <span><b className="font-semibold text-stone-900">{j.interviewing}</b> interviewing</span>
                        <span><b className="font-semibold text-stone-900">{j.offers}</b> offer</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <Empty icon={Briefcase} title="No open roles">Open a job to start receiving applicants.</Empty>}
          </Card>

          {data.stale.length > 0 && (
            <Card>
              <CardHeader title="Going quiet" action={<span className="text-xs text-stone-500">In a stage for 7+ days with nothing booked</span>} />
              <ul className="divide-y divide-line">
                {data.stale.map((a) => (
                  <li key={a.id}>
                    <button type="button" onClick={() => openCandidate(a.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-stone-50">
                      <Avatar name={a.name} size={28} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-stone-900">{a.name}</span>
                        <span className="block truncate text-[13px] text-stone-500">{a.job_title}</span>
                      </span>
                      <StageBadge app={a} />
                      <span className="tabular w-10 text-right text-[13px] text-stone-500">{daysSince(a.stage_entered_at)}d</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title="Upcoming interviews" action={<Link to="/interviews" className="text-[13px] font-medium text-brand-700 hover:underline">All</Link>} />
            {days.length ? days.map((d) => (
              <div key={d.label}>
                <div className="border-b border-line bg-stone-50 px-4 py-1.5 text-xs font-medium text-stone-600">{d.label}</div>
                <div className="divide-y divide-line">{d.items.map((i) => <InterviewLine key={i.id} interview={i} />)}</div>
              </div>
            )) : <Empty icon={CalendarDays} title="Nothing booked">Interviews you schedule will show up here.</Empty>}
          </Card>

          <Card>
            <CardHeader title="Recent activity" />
            <ul className="divide-y divide-line">
              {data.recent.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => openCandidate(a.application_id)} className="block w-full px-4 py-2.5 text-left hover:bg-stone-50">
                    <span className="block text-sm text-stone-800"><span className="font-medium">{a.candidate_name}</span> · {a.detail}</span>
                    <span className="block truncate text-xs text-stone-500">{a.job_title}{a.user_name ? ` · ${a.user_name}` : ''} · {ago(a.created_at)}</span>
                  </button>
                </li>
              ))}
              {!data.recent.length && <li className="px-4 py-6 text-center text-sm text-stone-500">No activity yet.</li>}
            </ul>
          </Card>
        </div>
      </div>
    </Page>
  );
}
