import React, { useEffect, useState } from 'react';
import { Search, UserPlus } from 'lucide-react';
import { useApp, useApi, useOpenCandidate, Pending } from '../state.jsx';
import { url, plural } from '../lib.js';
import { Button, Input, Page, Select, Tabs } from '../ui.jsx';
import ApplicationsTable from '../components/ApplicationsTable.jsx';
import { AddCandidateModal } from '../components/CandidateModals.jsx';

export default function Candidates() {
  const { scope, isAgency } = useApp();
  const openCandidate = useOpenCandidate();
  const [status, setStatus] = useState('active');
  const [jobId, setJobId] = useState('');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  useEffect(() => { const t = setTimeout(() => setQuery(text.trim()), 250); return () => clearTimeout(t); }, [text]);
  useEffect(() => setJobId(''), [scope]);

  const { data: jobs } = useApi(url('/jobs', { client_id: scope }));
  const { data: rows, error } = useApi(url('/applications', { client_id: scope, status, job_id: jobId, q: query }));

  return (
    <Page
      title="Candidates"
      subtitle={rows ? `${plural(rows.length, 'candidate')}${rows.length === 500 ? ' (showing the first 500)' : ''}` : ' '}
      actions={isAgency && <Button variant="primary" icon={UserPlus} onClick={() => setAdding(true)}>Add candidate</Button>}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-stone-400" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search by name, email, title or company" aria-label="Search candidates" className="pl-9" />
        </div>
        <Select value={jobId} onChange={(e) => setJobId(e.target.value)} aria-label="Filter by job" className="!w-auto max-w-64">
          <option value="">All jobs</option>
          {(jobs || []).map((j) => <option key={j.id} value={j.id}>{j.title}{scope ? '' : ` · ${j.client_name}`}</option>)}
        </Select>
      </div>
      <Tabs className="mb-4" value={status} onChange={setStatus}
        tabs={[{ id: 'active', label: 'In process' }, { id: 'hired', label: 'Hired' }, { id: 'rejected', label: 'Rejected' }, { id: 'withdrawn', label: 'Withdrawn' }, { id: 'all', label: 'Everyone' }]} />
      {rows ? <ApplicationsTable rows={rows} /> : <Pending error={error} />}
      {adding && <AddCandidateModal onClose={() => setAdding(false)} onAdded={openCandidate} />}
    </Page>
  );
}
