import React, { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CalendarDays, ChevronDown, Copy, ExternalLink, MessagesSquare, Pencil, Trash2, UserPlus } from 'lucide-react';
import { useApp, useApi, useOpenCandidate, Pending } from '../state.jsx';
import { api, url, ago, daysSince, firstName, fmtDate, photoUrl, salaryRange, sourceName, plural, WORK_MODES, EMPLOYMENT, JOB_STATUS } from '../lib.js';
import { Avatar, Badge, Button, Card, Empty, Menu, Page, Stars, Tabs, useAction, useToast, cx } from '../ui.jsx';
import { JobStatusBadge, ReviewBadge } from '../components/bits.jsx';
import ApplicationsTable from '../components/ApplicationsTable.jsx';
import JobForm from '../components/JobForm.jsx';
import JobBrief from '../components/JobBrief.jsx';
import JobBoardPost from '../components/JobBoardPost.jsx';
import { MessageTeamModal, TeamMessagesCard, jobAttachment } from '../components/TeamMessages.jsx';

// The tab each person used last, remembered per person: on a shared computer the next one starts on their own.
const tabKey = (user) => `thebook.jobtab.${user.id}`;
const lastTab = (user) => { try { return localStorage.getItem(tabKey(user)); } catch { return null; } };
import { AddCandidateModal } from '../components/CandidateModals.jsx';

// A card goes quiet after this many days in one stage with nothing booked.
const QUIET_DAYS = 7;
const isQuiet = (a) => !a.next_interview && daysSince(a.stage_entered_at) >= QUIET_DAYS;

/** The pipeline's shape in one line: who is where, and what is in danger of stalling. */
function Funnel({ stages, apps }) {
  const at = (kind) => apps.filter((a) => a.status === 'active' && stages.find((s) => s.id === a.stage_id)?.kind === kind).length;
  const quiet = apps.filter((a) => a.status === 'active' && isQuiet(a)).length;
  const withTeam = apps.filter((a) => a.review_status === 'pending').length;
  const steps = [[at('applied'), 'applied'], [at('interview'), 'interviewing'], [at('offer'), 'at offer'], [apps.filter((a) => a.status === 'hired').length, 'hired']];
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-stone-600">
      {steps.map(([n, label], i) => (
        <React.Fragment key={label}>
          {i > 0 && <span className="text-stone-400" aria-hidden="true">→</span>}
          <span><b className="tabular font-semibold text-stone-900">{n}</b> {label}</span>
        </React.Fragment>
      ))}
      <span className="flex-1" />
      {quiet > 0 && <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-gold" aria-hidden="true" />{quiet} going quiet ({QUIET_DAYS}+ days in a stage, nothing booked)</span>}
      {withTeam > 0 && <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-brand-400" aria-hidden="true" />{withTeam} with the hiring team</span>}
    </div>
  );
}

function Board({ stages, apps }) {
  const { bump, isAgency } = useApp();
  const toast = useToast();
  const open = useOpenCandidate();
  const [moved, setMoved] = useState({}); // optimistic stage for cards that were just dropped
  const [over, setOver] = useState(null);
  // When fresh data arrives, forget only the moves it already reflects; a card dropped while that request was in flight stays put.
  useEffect(() => setMoved((m) => Object.fromEntries(Object.entries(m).filter(([id, stageId]) => apps.find((a) => a.id === Number(id))?.stage_id !== stageId))), [apps]);

  const drop = async (e, stage) => {
    e.preventDefault();
    setOver(null);
    const id = Number(e.dataTransfer.getData('text/plain'));
    const app = apps.find((a) => a.id === id);
    if (!app || (moved[id] ?? app.stage_id) === stage.id) return;
    setMoved((m) => ({ ...m, [id]: stage.id }));
    try {
      await api.post(`/applications/${id}/move`, { stage_id: stage.id });
      bump();
      // Safety net: if the data never shows this move (someone else moved the card again), stop overriding it.
      setTimeout(() => setMoved((m) => (m[id] === stage.id ? Object.fromEntries(Object.entries(m).filter(([k]) => Number(k) !== id)) : m)), 10000);
    } catch (err) {
      toast(err.message, 'error');
      setMoved((m) => { const { [id]: _, ...rest } = m; return rest; });
    }
  };

  return (
    <>
      <Funnel stages={stages} apps={apps} />
      <div className="-mx-4 overflow-x-auto px-4 pb-4 sm:-mx-8 sm:px-8">
        <div className="flex min-w-max items-start gap-4">
          {stages.map((stage) => {
            const cards = apps.filter((a) => (moved[a.id] ?? a.stage_id) === stage.id);
            return (
              <section
                key={stage.id}
                aria-label={stage.name}
                onDragOver={(e) => { e.preventDefault(); setOver(stage.id); }}
                onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget) && setOver(null)}
                onDrop={(e) => drop(e, stage)}
                className={cx('flex w-[272px] shrink-0 flex-col rounded-xl border p-1.5 transition-colors', over === stage.id ? 'border-brand-300 bg-brand-50' : 'border-transparent')}
              >
                <h3 className="flex items-center gap-2 px-1.5 pt-1 pb-2.5 text-[13px] font-semibold text-stone-900">
                  {stage.name}
                  <span className="tabular text-xs font-medium text-stone-500">{cards.length}</span>
                </h3>
                <div className="flex min-h-24 flex-col gap-2.5">
                  {cards.map((a) => {
                    const quiet = a.status === 'active' && isQuiet(a);
                    const company = [a.current_title, a.current_company].filter(Boolean).join(' at ');
                    return (
                      <div
                        key={a.id}
                        role="button"
                        tabIndex={0}
                        draggable
                        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open(a.id))}
                        onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(a.id)); e.dataTransfer.effectAllowed = 'move'; }}
                        onClick={() => open(a.id)}
                        className={cx('block rounded-[10px] border bg-white px-3.5 py-3 text-left shadow-[0_1px_1px_rgba(27,31,30,0.03)] transition-[border-color,box-shadow] hover:border-brand-200 hover:shadow-[0_2px_8px_rgba(3,58,68,0.08)] active:cursor-grabbing', quiet ? 'border-gold-200' : 'border-line')}
                      >
                        <span className="flex items-center gap-2.5">
                          <Avatar name={a.name} size={28} src={photoUrl(a.candidate_id, a.photo)} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-stone-900">{a.name}</span>
                            {company && <span className="block truncate text-xs text-stone-500">{company}</span>}
                          </span>
                        </span>
                        {(a.rating || a.review_status === 'pending') && (
                          <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
                            {a.rating ? <Stars value={a.rating} size={12} /> : null}
                            <ReviewBadge status={a.review_status} />
                          </span>
                        )}
                        <span className="mt-2 flex items-center justify-between gap-2 text-xs text-stone-500">
                          {a.next_interview ? <Badge tone="green" icon={CalendarDays}>{fmtDate(a.next_interview)}</Badge>
                            : stage.kind === 'interview' && a.status === 'active' ? <span className="font-medium text-gold-800">Nothing booked</span>
                            : <Badge>{sourceName(a.source, isAgency)}</Badge>}
                          <span className={cx('tabular', quiet && 'font-medium text-gold-800')} title="Days in this stage">{daysSince(a.stage_entered_at)}d{quiet ? ' · quiet' : ''}</span>
                        </span>
                      </div>
                    );
                  })}
                  {!cards.length && <div className="flex flex-1 items-center justify-center rounded-[10px] border border-dashed border-stone-300 px-4 py-7 text-[13px] text-stone-500">Drop a candidate here</div>}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}

function Details({ job, stages }) {
  const { isAgency } = useApp();
  const fact = (label, value) => value ? (
    <div className="flex justify-between gap-4 py-1.5 text-sm"><dt className="text-stone-500">{label}</dt><dd className="text-right font-medium text-stone-800">{value}</dd></div>
  ) : null;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-6">
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-stone-900">Job advert</h3>
          {job.description ? <p className="mt-3 max-w-prose text-sm leading-relaxed whitespace-pre-wrap text-stone-700">{job.description}</p> : <p className="mt-2 text-sm text-stone-500">No description yet.</p>}
        </Card>
      </div>
      <div className="space-y-6">
        <Card className="px-4 py-2.5">
          <dl className="divide-y divide-line">
            {fact('Client', job.client_name)}
            {fact('Department', job.department)}
            {fact('Location', [job.location, WORK_MODES[job.work_mode]].filter(Boolean).join(' · '))}
            {fact('Contract', EMPLOYMENT[job.employment_type])}
            {fact('Salary', salaryRange(job.salary_min, job.salary_max, job.currency) && `${salaryRange(job.salary_min, job.salary_max, job.currency)}${job.salary_public ? '' : ' (hidden)'}`)}
            {fact('Openings', `${job.hires} of ${job.openings} filled`)}
            {fact('Hiring manager', job.hiring_manager_name)}
            {isAgency && fact('Account executive', job.account_executive_name || 'Not set')}
            {fact('Opened', job.opened_at && fmtDate(job.opened_at, true))}
          </dl>
        </Card>
        <Card className="p-4">
          <h3 className="text-sm font-semibold text-stone-900">Pipeline</h3>
          <ol className="mt-2 space-y-1 text-sm text-stone-700">{stages.map((s, i) => <li key={s.id}><span className="tabular mr-2 text-stone-400">{i + 1}</span>{s.name}</li>)}</ol>
        </Card>
        <Card className="p-4">
          <h3 className="text-sm font-semibold text-stone-900">Application questions</h3>
          {job.questions.length ? (
            <ul className="mt-2 space-y-1.5 text-sm text-stone-700">{job.questions.map((q) => <li key={q.id}>{q.label}{q.required && <span className="text-stone-400"> · required</span>}</li>)}</ul>
          ) : <p className="mt-1 text-sm text-stone-500">Contact details and résumé only.</p>}
        </Card>
        <Card className="p-4">
          <h3 className="text-sm font-semibold text-stone-900">Scorecard criteria</h3>
          <div className="mt-2 flex flex-wrap gap-1.5">{job.criteria.map((c) => <Badge key={c}>{c}</Badge>)}</div>
        </Card>
      </div>
    </div>
  );
}

/** " · 5 cycles · last 16h ago by Priya", or " · No cycles yet", linking to the Cycles page. Nothing until it has loaded. */
function CyclesLine({ jobId }) {
  const { data } = useApi(`/cycles/jobs/${jobId}`);
  if (!data) return null;
  const last = data.cycles[0];
  const by = last && (last.name ? (last.on_team ? firstName(last.name) : `${last.name} (no longer on the team)`) : 'somebody no longer on the team');
  return (
    <>
      <span aria-hidden="true"> · </span>
      <Link to="/cycles" className="whitespace-nowrap text-brand-700 hover:underline" title="Each job ticked on somebody’s Jobs to work on list is one cycle">
        {data.total ? `${plural(data.total, 'cycle')} · last ${ago(last.at)} by ${by}` : 'No cycles yet'}
      </Link>
    </>
  );
}

export default function JobDetail() {
  const { id } = useParams();
  const { user, isAgency, isAdmin, bump } = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const openCandidate = useOpenCandidate();
  const [params, setParams] = useSearchParams();
  const [modal, setModal] = useState(null);
  // The address decides the tab, then whichever tab this person used last; recruiters start on the brief, clients on the pipeline.
  const allowed = isAgency ? ['brief', 'pipeline', 'all', 'details', 'post'] : ['pipeline', 'all', 'details'];
  const tab = [params.get('tab'), lastTab(user), allowed[0]].find((t) => allowed.includes(t));
  const setTab = (t) => {
    try { localStorage.setItem(tabKey(user), t); } catch { /* storage unavailable */ }
    const next = new URLSearchParams(params);
    next.set('tab', t);
    setParams(next, { replace: true });
  };
  const { data, error } = useApi(`/jobs/${id}`);
  const { data: apps, error: appsError } = useApi(url('/applications', { job_id: id, status: 'all' }));
  const inPlay = useMemo(() => (apps || []).filter((a) => a.status === 'active' || a.status === 'hired'), [apps]);

  const [setStatus] = useAction(async (status) => {
    const answer = await api.patch(`/jobs/${id}/status`, { status });
    toast(`Job is now ${JOB_STATUS[status].label.toLowerCase()}`);
    if (answer.board_notice) toast(answer.board_notice, 'error'); // the job's confidential post came down with it
    bump();
  });
  const [remove] = useAction(async () => {
    // People who were in The Book before they were put on this job are not deleted with it: the workspace sends them back.
    if (!window.confirm('Delete this job and every candidate in it? Anyone who was in The Book before they were added to this job goes back to The Book without a job, with their notes, résumé and calls. Everyone else in the job is deleted. This cannot be undone.')) return;
    await api.del(`/jobs/${id}`);
    toast('Job deleted');
    navigate('/jobs');
    bump();
  });

  // A link to somebody's profile inside a job that is not there (the job was deleted and they went back to The Book,
  // or an older copy of the browser extension made the link for someone who is on no job) opens the profile on the
  // Candidates page instead of over an error.
  if (error === 'Not found' && params.get('c')) return <Navigate to={`/candidates?c=${encodeURIComponent(params.get('c'))}`} replace />;
  if (error) return <Page title="This job could not be opened"><Card><Pending error={error === 'Not found' ? 'It does not exist, or you do not have access to it.' : error} /></Card><Link to="/jobs" className="mt-4 inline-block text-sm font-medium text-brand-700 hover:underline">Back to jobs</Link></Page>;
  if (!data || !apps) return <Pending error={appsError} />;
  const { job, stages } = data;
  const careersUrl = `${window.location.origin}/careers/${job.client_slug}/${job.id}`;
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(careersUrl); toast('Application link copied'); } catch { window.prompt('Copy this link', careersUrl); }
  };

  return (
    <Page
      wide
      title={<span className="flex flex-wrap items-center gap-2.5">{job.title}<JobStatusBadge status={job.status} /></span>}
      subtitle={(
        <>
          {[job.client_name, job.location, WORK_MODES[job.work_mode], salaryRange(job.salary_min, job.salary_max, job.currency),
            job.status === 'open' && job.opened_at && `Open ${plural(daysSince(job.opened_at), 'day')}`,
            // Whose job it is, for the agency. A client's user is never sent it.
            isAgency && (job.account_executive_name ? `Account executive: ${job.account_executive_name}` : 'No account executive')].filter(Boolean).join(' · ')}
          {/* How often the team has worked this job, for the agency only: read from its own route, so the job's answer carries nothing new. */}
          {isAgency && <CyclesLine jobId={job.id} />}
        </>
      )}
      actions={
        <>
          {job.status === 'open' && job.careers_page && (
            <>
              <Button icon={Copy} onClick={copyLink}>Copy apply link</Button>
              <a href={careersUrl} target="_blank" rel="noreferrer"><Button icon={ExternalLink}>View advert</Button></a>
            </>
          )}
          {/* A job the agency advertises on its own board only. Everybody is told that it is not on the careers page; only the agency has the tab that says why. */}
          {job.status === 'open' && !job.careers_page && <span className="self-center text-[13px] text-stone-500">Not listed on the careers page</span>}
          {isAgency && (
            <>
              <Menu
                trigger={<Button>Status<ChevronDown className="size-4" /></Button>}
                items={[
                  ...Object.entries(JOB_STATUS).filter(([s]) => s !== job.status).map(([s, meta]) => ({ label: `Mark as ${meta.label.toLowerCase()}`, onClick: () => setStatus(s) })),
                  isAdmin && null,
                  isAdmin && { label: 'Delete job', icon: Trash2, danger: true, onClick: remove },
                ]}
              />
              <Button icon={MessagesSquare} onClick={() => setModal('message')}>Message the team</Button>
              <Button icon={Pencil} onClick={() => setModal('edit')}>Edit</Button>
              <Button variant="primary" icon={UserPlus} onClick={() => setModal('add')}>Add candidate</Button>
            </>
          )}
        </>
      }
    >
      <Link to="/jobs" className="no-print -mt-3 mb-3 inline-flex items-center gap-1 text-[13px] text-stone-500 hover:text-stone-800"><ArrowLeft className="size-3.5" />All jobs</Link>
      {/* The team's messages about this job, from the conversations the person looking is in; nothing when there are none. The agency's alone. */}
      {isAgency && <TeamMessagesCard jobId={job.id} hideEmpty className="mb-4 max-w-3xl" />}
      <Tabs className="mb-4" value={tab} onChange={setTab}
        tabs={[isAgency && { id: 'brief', label: 'Brief' }, { id: 'pipeline', label: 'Pipeline', count: inPlay.length }, { id: 'all', label: 'All candidates', count: apps.length },
          { id: 'details', label: isAgency ? 'Advert and setup' : 'Job details' },
          // The agency's own advert for this job, on its public job board. The client's hiring team has no such tab.
          isAgency && { id: 'post', label: 'Confidential post' }].filter(Boolean)} />
      {tab === 'brief' && <JobBrief job={job} stages={stages} onEditJob={() => setModal('edit')} />}
      {tab === 'pipeline' && <Board stages={stages} apps={inPlay} />}
      {tab === 'all' && <ApplicationsTable rows={apps} showJob={false} empty="Nobody has applied yet. Share the apply link or add candidates you have sourced." />}
      {tab === 'details' && <Details job={job} stages={stages} />}
      {tab === 'post' && isAgency && <JobBoardPost job={job} />}
      {modal === 'message' && isAgency && <MessageTeamModal attachment={jobAttachment({ id: job.id, title: job.title, client_name: job.client_name })} onClose={() => setModal(null)} />}
      {modal === 'edit' && <JobForm job={job} stages={stages} onClose={() => setModal(null)} />}
      {modal === 'add' && <AddCandidateModal jobId={job.id} onClose={() => setModal(null)} onAdded={openCandidate} />}
    </Page>
  );
}
