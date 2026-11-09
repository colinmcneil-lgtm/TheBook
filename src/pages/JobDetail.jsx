import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarDays, ChevronDown, Copy, ExternalLink, Pencil, Trash2, UserPlus } from 'lucide-react';
import { useApp, useApi, useOpenCandidate, Pending } from '../state.jsx';
import { api, url, daysSince, fmtDate, salaryRange, WORK_MODES, EMPLOYMENT, JOB_STATUS } from '../lib.js';
import { Avatar, Badge, Button, Card, Empty, Menu, Page, Stars, Tabs, useAction, useToast, cx } from '../ui.jsx';
import { JobStatusBadge, ReviewBadge } from '../components/bits.jsx';
import ApplicationsTable from '../components/ApplicationsTable.jsx';
import JobForm from '../components/JobForm.jsx';
import { AddCandidateModal } from '../components/CandidateModals.jsx';

function Board({ stages, apps }) {
  const { bump } = useApp();
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
    <div className="-mx-4 overflow-x-auto px-4 pb-4 sm:-mx-8 sm:px-8">
      <div className="flex min-w-max gap-3">
        {stages.map((stage) => {
          const cards = apps.filter((a) => (moved[a.id] ?? a.stage_id) === stage.id);
          return (
            <section
              key={stage.id}
              aria-label={stage.name}
              onDragOver={(e) => { e.preventDefault(); setOver(stage.id); }}
              onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget) && setOver(null)}
              onDrop={(e) => drop(e, stage)}
              className={cx('flex w-64 shrink-0 flex-col rounded-xl border p-2 transition-colors', over === stage.id ? 'border-brand-400 bg-brand-50' : 'border-transparent bg-stone-200/50')}
            >
              <h3 className="flex items-center justify-between px-1.5 pt-1 pb-2 text-[13px] font-semibold text-stone-700">
                {stage.name}
                <span className="tabular rounded-full bg-white px-1.5 text-xs font-medium text-stone-500">{cards.length}</span>
              </h3>
              <div className="flex min-h-24 flex-col gap-2">
                {cards.map((a) => (
                  <div
                    key={a.id}
                    role="button"
                    tabIndex={0}
                    draggable
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open(a.id))}
                    onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(a.id)); e.dataTransfer.effectAllowed = 'move'; }}
                    onClick={() => open(a.id)}
                    className="block rounded-lg border border-line bg-white p-3 text-left shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing"
                  >
                    <span className="flex items-center gap-2">
                      <Avatar name={a.name} size={24} />
                      <span className="truncate text-sm font-medium text-stone-900">{a.name}</span>
                    </span>
                    {(a.current_title || a.current_company) && <span className="mt-1 block truncate text-xs text-stone-500">{[a.current_title, a.current_company].filter(Boolean).join(' at ')}</span>}
                    <span className="mt-2 flex flex-wrap items-center gap-1.5">
                      {a.rating ? <Stars value={a.rating} size={11} /> : null}
                      <ReviewBadge status={a.review_status} />
                      {a.next_interview && <Badge tone="blue" icon={CalendarDays}>{fmtDate(a.next_interview)}</Badge>}
                      <span className="tabular ml-auto text-xs text-stone-400" title="Days in this stage">{daysSince(a.stage_entered_at)}d</span>
                    </span>
                  </div>
                ))}
                {!cards.length && <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-stone-300 text-xs text-stone-400">Drop here</div>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
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
        {isAgency && job.ideal_profile && (
          <Card className="border-violet-200 bg-violet-50/50 p-5">
            <h3 className="text-sm font-semibold text-stone-900">Internal brief <span className="font-normal text-stone-500">· agency only</span></h3>
            <p className="mt-2 max-w-prose text-sm leading-relaxed whitespace-pre-wrap text-stone-700">{job.ideal_profile}</p>
          </Card>
        )}
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

export default function JobDetail() {
  const { id } = useParams();
  const { isAgency, isAdmin, bump } = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const openCandidate = useOpenCandidate();
  const [tab, setTab] = useState('pipeline');
  const [modal, setModal] = useState(null);
  const { data, error } = useApi(`/jobs/${id}`);
  const { data: apps, error: appsError } = useApi(url('/applications', { job_id: id, status: 'all' }));
  const inPlay = useMemo(() => (apps || []).filter((a) => a.status === 'active' || a.status === 'hired'), [apps]);

  const [setStatus] = useAction(async (status) => { await api.patch(`/jobs/${id}/status`, { status }); toast(`Job is now ${JOB_STATUS[status].label.toLowerCase()}`); bump(); });
  const [remove] = useAction(async () => {
    if (!window.confirm('Delete this job and every candidate in it? This cannot be undone.')) return;
    await api.del(`/jobs/${id}`);
    toast('Job deleted');
    navigate('/jobs');
    bump();
  });

  if (error) return <Page title="Job not found"><Card><Empty title="This job does not exist or you do not have access to it." action={<Link to="/jobs"><Button>Back to jobs</Button></Link>} /></Card></Page>;
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
      subtitle={[job.client_name, job.location, WORK_MODES[job.work_mode], salaryRange(job.salary_min, job.salary_max, job.currency)].filter(Boolean).join(' · ')}
      actions={
        <>
          {job.status === 'open' && (
            <>
              <Button icon={Copy} onClick={copyLink}>Copy apply link</Button>
              <a href={careersUrl} target="_blank" rel="noreferrer"><Button icon={ExternalLink}>View advert</Button></a>
            </>
          )}
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
              <Button icon={Pencil} onClick={() => setModal('edit')}>Edit</Button>
              <Button variant="primary" icon={UserPlus} onClick={() => setModal('add')}>Add candidate</Button>
            </>
          )}
        </>
      }
    >
      <Link to="/jobs" className="no-print -mt-3 mb-3 inline-flex items-center gap-1 text-[13px] text-stone-500 hover:text-stone-800"><ArrowLeft className="size-3.5" />All jobs</Link>
      <Tabs className="mb-4" value={tab} onChange={setTab}
        tabs={[{ id: 'pipeline', label: 'Pipeline', count: inPlay.length }, { id: 'all', label: 'All candidates', count: apps.length }, { id: 'details', label: 'Job details' }]} />
      {tab === 'pipeline' && <Board stages={stages} apps={inPlay} />}
      {tab === 'all' && <ApplicationsTable rows={apps} showJob={false} empty="Nobody has applied yet. Share the apply link or add candidates you have sourced." />}
      {tab === 'details' && <Details job={job} stages={stages} />}
      {modal === 'edit' && <JobForm job={job} stages={stages} onClose={() => setModal(null)} />}
      {modal === 'add' && <AddCandidateModal jobId={job.id} onClose={() => setModal(null)} onAdded={openCandidate} />}
    </Page>
  );
}
