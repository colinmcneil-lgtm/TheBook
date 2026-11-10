import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Briefcase, ExternalLink, EyeOff, Plus, MapPin } from 'lucide-react';
import { useApp, useApi, Pending } from '../state.jsx';
import { url, ago, daysSince, fmtDate, plural, WORK_MODES } from '../lib.js';
import { Badge, Button, Card, Empty, Page, Tabs } from '../ui.jsx';
import { ClientName, JobStatusBadge } from '../components/bits.jsx';
import JobForm from '../components/JobForm.jsx';

export function JobList({ jobs }) {
  return (
    <Card className="divide-y divide-line">
      {jobs.map((j) => (
        <Link key={j.id} to={`/jobs/${j.id}`} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3.5 hover:bg-stone-50">
          <div className="min-w-0 flex-1 basis-64">
            <div className="flex items-center gap-2">
              <span className="truncate text-[15px] font-medium text-stone-900">{j.title}</span>
              <JobStatusBadge status={j.status} />
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[13px] text-stone-500">
              <ClientName name={j.client_name} color={j.brand_color} />
              {j.location && <span className="inline-flex items-center gap-1"><MapPin className="size-3" />{j.location} · {WORK_MODES[j.work_mode]}</span>}
              {j.hiring_manager_name && <span>Hiring manager: {j.hiring_manager_name}</span>}
            </div>
          </div>
          <dl className="tabular grid grid-cols-4 gap-5 text-center">
            {[['New', j.new_applicants], ['Interview', j.interviewing], ['Offer', j.offers], ['Hired', `${j.hires}/${j.openings}`]].map(([label, value]) => (
              <div key={label}>
                <dd className="text-[15px] font-semibold text-stone-900">{value}</dd>
                <dt className="text-xs text-stone-500">{label}</dt>
              </div>
            ))}
          </dl>
          <div className="w-20 text-right text-[13px] text-stone-500">
            {j.status === 'open' && j.opened_at ? `Open ${daysSince(j.opened_at)}d` : `${j.total_applicants} total`}
          </div>
        </Link>
      ))}
    </Card>
  );
}

/** Every confidential post the agency has written, whichever job it is on: what the public sees it as, and whether it is public. Agency only. */
function BoardPosts() {
  const { scope } = useApp();
  const { data, error } = useApi('/board/posts');
  if (!data) return <Pending error={error} />;
  const posts = data.filter((p) => !scope || p.client_id === scope);
  if (!posts.length) {
    return (
      <Card>
        <Empty icon={EyeOff} title="No confidential posts yet">
          To advertise a job on your own website without naming the client, open the job and go to its Confidential post tab.
        </Empty>
      </Card>
    );
  }
  return (
    <Card className="divide-y divide-line">
      {posts.map((p) => (
        <div key={p.job_id} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3.5 hover:bg-stone-50">
          <Link to={`/jobs/${p.job_id}?tab=post`} className="min-w-0 flex-1 basis-64">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-[15px] font-medium text-stone-900">{p.title || 'Untitled post'}</span>
              {p.live ? <Badge tone="green">Public</Badge> : p.enabled ? <Badge tone="amber">{p.problems ? `Not public: ${plural(p.problems, 'thing')} to fix` : 'Not public: the job is not open'}</Badge> : <Badge>Switched off</Badge>}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[13px] text-stone-500">
              {p.location && <span className="inline-flex items-center gap-1"><MapPin className="size-3" />{p.location}</span>}
              <span>For <ClientName always name={p.client_name} color={p.brand_color} className="font-medium text-stone-700" />: {p.job_title}</span>
            </div>
          </Link>
          <div className="tabular w-24 text-center">
            <div className="text-[15px] font-semibold text-stone-900">{p.applied}</div>
            <div className="text-xs text-stone-500">Applied</div>
          </div>
          <div className="w-32 text-right text-[13px] text-stone-500">{p.live ? `Posted ${fmtDate(p.posted_at)}` : `Edited ${ago(p.updated_at)}`}</div>
          {p.live ? <a href={`/board/${p.token}`} target="_blank" rel="noreferrer" aria-label="Open the public post"><Button size="sm" icon={ExternalLink}>View</Button></a> : <span className="w-[68px]" />}
        </div>
      ))}
    </Card>
  );
}

export default function Jobs() {
  const { scope, isAgency, clients } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // The list of confidential posts has an address of its own (/jobs?view=board), so Settings can link to it.
  const [status, setStatusState] = useState(isAgency && params.get('view') === 'board' ? 'board' : 'open');
  const setStatus = (s) => { setStatusState(s); setParams(s === 'board' ? { view: 'board' } : {}, { replace: true }); };
  const [creating, setCreating] = useState(false);
  const { data: all, error } = useApi(url('/jobs', { client_id: scope }));
  const count = (s) => all?.filter((j) => j.status === s).length;
  const jobs = all?.filter((j) => status === 'all' || j.status === status);

  return (
    <Page title="Jobs" subtitle="Every role you are hiring for, and where each pipeline stands."
      actions={isAgency && <Button variant="primary" icon={Plus} onClick={() => setCreating(true)} disabled={!clients.length}>New job</Button>}>
      <Tabs className="mb-4" value={status} onChange={setStatus}
        tabs={[{ id: 'open', label: 'Open', count: count('open') }, { id: 'draft', label: 'Drafts', count: count('draft') }, { id: 'paused', label: 'Paused', count: count('paused') }, { id: 'closed', label: 'Closed', count: count('closed') }, { id: 'all', label: 'All' },
          isAgency && { id: 'board', label: 'On our website' }].filter(Boolean)} />
      {status === 'board' ? <BoardPosts /> : !jobs ? <Pending error={error} /> : jobs.length ? <JobList jobs={jobs} /> : (
        <Card>
          <Empty icon={Briefcase} title={status === 'open' ? 'No open jobs' : 'Nothing here'}
            action={isAgency && clients.length > 0 && <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New job</Button>}>
            {isAgency ? (clients.length ? 'Create a job to publish it on the client’s careers page and start a pipeline.' : 'Add your first client, then create a job for them.') : 'Your recruiter will set up roles here.'}
          </Empty>
        </Card>
      )}
      {creating && <JobForm onClose={() => setCreating(false)} onSaved={(id) => navigate(`/jobs/${id}`)} />}
    </Page>
  );
}
