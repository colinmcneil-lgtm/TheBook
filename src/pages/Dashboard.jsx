import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, Briefcase, Inbox, Hourglass, ClipboardCheck, UserPlus, CalendarCheck, ArrowUpRight, ThumbsUp, Handshake, Trophy, EyeOff } from 'lucide-react';
import { useApp, useApi, useOpenCandidate, Pending } from '../state.jsx';
import { url, ago, daysSince, firstName, fmtDay, photoUrl, plural, remember, remembered } from '../lib.js';
import { Card, CardHeader, Empty, ListRow, Page, Stat, StatStrip, Avatar, cx } from '../ui.jsx';
import { ClientName, InterviewLine, StageBadge } from '../components/bits.jsx';
import JobBoard from '../components/JobBoard.jsx';

// The moments a recruiter most wants to see in the feed. Each gets a label, an icon and a small tag so it stands out
// from notes, emails and other routine activity.
const MILESTONES = {
  interview: { label: 'Interview stage', icon: ArrowUpRight, pill: 'bg-brand-50 text-brand-800' },
  booked: { label: 'Interview booked', icon: CalendarCheck, pill: 'bg-brand-50 text-brand-800' },
  approved: { label: 'Approved for interview', icon: ThumbsUp, pill: 'bg-brand-50 text-brand-800' },
  offer: { label: 'Offer stage', icon: Handshake, pill: 'bg-gold-50 text-gold-800' },
  sent: { label: 'Offer sent', icon: Handshake, pill: 'bg-gold-50 text-gold-800' },
  accepted: { label: 'Offer accepted', icon: Handshake, pill: 'bg-gold-50 text-gold-800' },
  hired: { label: 'Hired', icon: Trophy, pill: 'bg-emerald-50 text-emerald-800' },
};

function ActivityRow({ activity: a, onOpen }) {
  const m = MILESTONES[a.milestone];
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-stone-50">
        <Avatar name={a.candidate_name} size={28} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-stone-900">{a.candidate_name}</span>
            {m && <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium', m.pill)}><m.icon className="size-3" />{m.label}</span>}
          </span>
          {/* At most two lines, and long unbroken text wraps: one long note must not push everything else off the screen. */}
          <span className="mt-0.5 line-clamp-2 text-[13px] text-stone-700 [overflow-wrap:anywhere]">{a.detail}</span>
          {/* The job title gives way first, then (only if it is very long) who did it; when it happened is always shown. */}
          <span className="mt-0.5 flex gap-1 text-xs text-stone-500">
            <span className="min-w-0 truncate">{a.job_title}</span>
            {a.user_name && <span className="max-w-[50%] shrink-0 truncate">· {a.user_name}</span>}
            <span className="shrink-0">· {ago(a.created_at)}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

/** New, interviewing and at offer, as one small bar: the pipeline's shape at a glance. */
function StageBar({ job: j }) {
  const parts = [['new', j.new_applicants, 'bg-brand-200'], ['interviewing', j.interviewing, 'bg-brand-500'], ['at offer', j.offers, 'bg-gold']];
  const total = parts.reduce((n, [, v]) => n + v, 0);
  return (
    <span className="flex items-center gap-3">
      <span className="flex h-1.5 w-24 gap-0.5 overflow-hidden rounded-full bg-stone-100" role="img" aria-label={parts.map(([label, v]) => `${v} ${label}`).join(', ')}>
        {total > 0 && parts.map(([label, v, color]) => v > 0 && <span key={label} className={color} style={{ flex: v }} />)}
      </span>
      <span className="tabular w-[72px] text-right text-[13px] text-stone-600" aria-hidden="true">
        {parts.map(([label, v], i) => <React.Fragment key={label}>{i > 0 && <span className="text-stone-400"> · </span>}<b className="font-semibold text-stone-900">{v}</b></React.Fragment>)}
      </span>
    </span>
  );
}

export default function Dashboard() {
  const { user, scope, scopeClient, isAgency, clients } = useApp();
  const openCandidate = useOpenCandidate();
  // The job board shows open jobs, and paused and draft ones too when its switch is on. The switch is remembered for
  // each person in this browser. The board is the agency's: for a client's user it is neither asked for nor sent.
  const boardKey = `thebook.jobboard.${user.id}`;
  const [boardAll, setBoardAll] = useState(() => remembered(boardKey) === 'all');
  const showAll = (on) => { setBoardAll(on); remember(boardKey, on ? 'all' : null); };
  const { data, error } = useApi(url('/dashboard', { client_id: scope, board: isAgency && boardAll ? 'all' : null }));
  const { data: nav } = useApi(url('/nav', { client_id: scope }));
  const { data: clientRows } = useApi(isAgency && !scope ? '/clients' : null);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  if (!data) return <Pending error={error} />;
  const s = data.stats;

  // Group upcoming interviews by day.
  const days = [];
  for (const i of data.upcoming) {
    const label = fmtDay(i.starts_at);
    const group = days.at(-1)?.label === label ? days.at(-1) : (days.push({ label, items: [] }), days.at(-1));
    group.items.push(i);
  }

  // What is waiting on this person, most pressing first. Each line says what and why, and opens where it is dealt with.
  const row = (p) => ({ Link, ...p });
  const needs = [
    nav?.board_down > 0 && row({ icon: EyeOff, to: '/jobs?view=board', title: `${plural(nav.board_down, 'confidential post is', 'confidential posts are')} switched on but not public`, detail: 'The check took it down, or its job is no longer open' }),
    nav?.pending_accounts > 0 && row({ icon: UserPlus, to: '/settings?tab=team', title: `${plural(nav.pending_accounts, 'person', 'people')} waiting for you to approve their account`, detail: 'Choose which client’s hiring team each one joins' }),
    isAgency && s.new_applicants > 0 && row({ icon: Inbox, to: '/inbox', title: `${plural(s.new_applicants, 'new applicant')} to review`, detail: 'Oldest first, so nobody waits long for a first reply' }),
    s.pending_review > 0 && row({
      icon: Hourglass, to: '/inbox?tab=review',
      title: isAgency ? `${plural(s.pending_review, 'shortlisted candidate')} waiting on the hiring team` : `${plural(s.pending_review, 'candidate')} waiting for your review`,
      detail: isAgency ? 'Your write-up is with them; a nudge is a message away' : 'Your recruiter has put them forward with a write-up',
    }),
    nav?.scorecards_due > 0 && row({ icon: ClipboardCheck, to: '/interviews?tab=feedback', title: `${plural(nav.scorecards_due, 'scorecard')} for you to complete`, detail: 'Feedback is most useful the same day' }),
  ].filter(Boolean);

  return (
    <Page title={`${greeting}, ${firstName(user.name)}`} subtitle={`${today} · ${scopeClient ? `Hiring at ${scopeClient.name}` : `Hiring across ${plural(clients.length, 'client')}`}`}>
      <StatStrip>
        <Stat Link={Link} to="/jobs" label="Open roles" value={s.open_jobs} hint={scopeClient ? `at ${scopeClient.name}` : `across ${plural(clients.length, 'client')}`} />
        <Stat Link={Link} to="/candidates" label="Active candidates" value={s.active_candidates} hint="in a live stage" />
        <Stat Link={Link} to="/inbox?tab=new" label="New applicants" value={s.new_applicants} hint="waiting for a first review" accent={s.new_applicants > 0} />
        <Stat Link={Link} to="/interviews" label="Interviews" value={s.interviews_week} hint="next 7 days" />
        <Stat label="Offers out" value={s.offers_out} hint="waiting on an answer" />
        <Stat Link={Link} to="/reports" label="Hires" value={s.hires_90d} hint="last 90 days" />
      </StatStrip>

      {needs.length > 0 && (
        <Card className="mt-4 divide-y divide-hairline">
          <CardHeader title="Needs you today" action={<span className="text-xs text-stone-500">{plural(needs.length, 'thing')}</span>} />
          {needs.map((n) => <ListRow key={n.to} {...n} />)}
        </Card>
      )}

      {isAgency && data.board && <div className="mt-6"><JobBoard columns={data.board} all={boardAll} onAll={showAll} /></div>}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title="Open roles" count={data.jobs.length || undefined} action={<Link to="/jobs" className="text-[13px] font-medium text-brand-700 hover:underline">All jobs</Link>} />
            {data.jobs.length ? (
              <>
                <div className="flex justify-between px-4 pt-2.5 pb-1.5 text-xs text-stone-500"><span>Role</span><span>New · Interviewing · Offer</span></div>
                <ul className="divide-y divide-hairline border-t border-hairline">
                  {data.jobs.map((j) => (
                    <li key={j.id}>
                      <Link to={`/jobs/${j.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-stone-50">
                        <span className="min-w-0 flex-1 basis-48">
                          <span className="block truncate text-sm font-medium text-stone-900">{j.title}</span>
                          <span className="flex items-center gap-2 text-xs text-stone-500">
                            <ClientName name={j.client_name} color={j.brand_color} />
                            <span>Open {plural(daysSince(j.opened_at), 'day')}</span>
                          </span>
                        </span>
                        <StageBar job={j} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            ) : <Empty icon={Briefcase} title="No open roles">Open a job to start receiving applicants.</Empty>}
          </Card>

          {clientRows && (
            <Card>
              <CardHeader title="Clients" action={<Link to="/clients" className="text-[13px] font-medium text-brand-700 hover:underline">Manage</Link>} />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-stone-500">
                      <th className="px-4 py-2 font-medium">Client</th>
                      <th className="px-3 py-2 text-right font-medium">Open</th>
                      <th className="px-3 py-2 text-right font-medium">New</th>
                      <th className="px-3 py-2 text-right font-medium">In process</th>
                      <th className="px-3 py-2 text-right font-medium">Interviews</th>
                      <th className="px-4 py-2 text-right font-medium">Hires</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline border-t border-hairline">
                    {clientRows.map((c) => (
                      <tr key={c.id} className="hover:bg-stone-50">
                        <td className="px-4 py-2.5"><Link to={`/clients/${c.id}`} className="font-medium text-stone-900 hover:underline"><ClientName always name={c.name} color={c.brand_color} /></Link></td>
                        <td className="tabular px-3 py-2.5 text-right">{c.open_jobs}</td>
                        <td className="tabular px-3 py-2.5 text-right">{c.new_applicants}</td>
                        <td className="tabular px-3 py-2.5 text-right">{c.active_candidates}</td>
                        <td className="tabular px-3 py-2.5 text-right">{c.upcoming_interviews}</td>
                        <td className={cx('tabular px-4 py-2.5 text-right', !c.hires && 'text-stone-500')}>{c.hires}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {data.stale.length > 0 && (
            <Card>
              <CardHeader title="Going quiet" action={<span className="text-xs text-stone-500">In a stage for 7+ days with nothing booked</span>} />
              <ul className="divide-y divide-hairline">
                {data.stale.map((a) => (
                  <li key={a.id}>
                    <button type="button" onClick={() => openCandidate(a.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-stone-50">
                      <Avatar name={a.name} size={28} src={photoUrl(a.candidate_id, a.photo)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-stone-900">{a.name}</span>
                        <span className="block truncate text-[13px] text-stone-500">{a.job_title}</span>
                      </span>
                      <StageBadge app={a} />
                      <span className="tabular w-10 text-right text-[13px] font-medium text-gold-800">{daysSince(a.stage_entered_at)}d</span>
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
                <div className="border-b border-hairline bg-stone-50 px-4 py-1.5 text-xs font-medium text-stone-600">{d.label}</div>
                <div className="divide-y divide-hairline">{d.items.map((i) => <InterviewLine key={i.id} interview={i} />)}</div>
              </div>
            )) : <Empty icon={CalendarDays} title="Nothing booked">Interviews you schedule will show up here.</Empty>}
          </Card>

          <Card>
            <CardHeader title="Recent activity" />
            <ul className="divide-y divide-hairline">
              {data.recent.map((a) => <ActivityRow key={a.id} activity={a} onOpen={() => openCandidate(a.application_id)} />)}
              {!data.recent.length && <li className="px-4 py-6 text-center text-sm text-stone-500">No activity yet.</li>}
            </ul>
          </Card>
        </div>
      </div>
    </Page>
  );
}
