import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Briefcase, Plus, MapPin } from 'lucide-react';
import { useApp, useApi, Pending } from '../state.jsx';
import { url, daysSince, WORK_MODES } from '../lib.js';
import { Avatar, Button, Card, Empty, Page, Select, Tabs } from '../ui.jsx';
import { ClientName, JobStatusBadge } from '../components/bits.jsx';
import JobForm from '../components/JobForm.jsx';

export function JobList({ jobs }) {
  const { isAgency } = useApp();
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
          {/* Whose job it is. The agency's own column: a client's user is never sent it. */}
          {isAgency && (
            <div className="flex w-44 items-center gap-2">
              {j.account_executive_name && <Avatar name={j.account_executive_name} size={24} />}
              <span className="min-w-0">
                <span className={`block truncate text-[13px] font-medium ${j.account_executive_name ? 'text-stone-800' : 'text-stone-400'}`}>{j.account_executive_name || 'Nobody yet'}</span>
                <span className="block text-xs text-stone-500">Account executive</span>
              </span>
            </div>
          )}
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

export default function Jobs() {
  const { scope, isAgency, clients, user } = useApp();
  const navigate = useNavigate();
  const [status, setStatus] = useState('open');
  const [creating, setCreating] = useState(false);
  // The agency can narrow the list to one account executive's jobs: '' is everybody's, 'me' their own, 'none' the jobs with nobody.
  const [executive, setExecutive] = useState('');
  useEffect(() => setExecutive(''), [scope]); // somebody chosen for one client may have no jobs at the next
  const { data: all, error } = useApi(url('/jobs', { client_id: scope, account_executive: executive === 'me' ? user.id : executive }));
  // Everyone who can be an account executive, plus anyone who has left but still has jobs here.
  const { data: executives } = useApi(isAgency ? url('/account-executives', { client_id: scope }) : null);
  const count = (s) => all?.filter((j) => j.status === s).length;
  const jobs = all?.filter((j) => status === 'all' || j.status === status);

  return (
    <Page title="Jobs" subtitle="Every role you are hiring for, and where each pipeline stands."
      actions={isAgency && <Button variant="primary" icon={Plus} onClick={() => setCreating(true)} disabled={!clients.length}>New job</Button>}>
      {isAgency && (
        <div className="mb-3 flex justify-end">
          <Select value={executive} onChange={(e) => setExecutive(e.target.value)} aria-label="Filter by account executive" className="!w-auto max-w-64">
            <option value="">Any account executive</option>
            <option value="me">Mine</option>
            {(executives?.people || []).map((p) => <option key={p.id} value={p.id}>{p.name}{p.active ? '' : ' (deactivated)'}</option>)}
            {(executives?.none > 0 || executive === 'none') && <option value="none">No account executive</option>}
          </Select>
        </div>
      )}
      <Tabs className="mb-4" value={status} onChange={setStatus}
        tabs={[{ id: 'open', label: 'Open', count: count('open') }, { id: 'draft', label: 'Drafts', count: count('draft') }, { id: 'paused', label: 'Paused', count: count('paused') }, { id: 'closed', label: 'Closed', count: count('closed') }, { id: 'all', label: 'All' }]} />
      {!jobs ? <Pending error={error} /> : jobs.length ? <JobList jobs={jobs} /> : (
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
