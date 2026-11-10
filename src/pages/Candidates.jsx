import React, { useEffect, useState } from 'react';
import { Search, UserPlus } from 'lucide-react';
import { useApp, useApi, useOpenCandidate, Pending } from '../state.jsx';
import { url, plural, NO_JOB } from '../lib.js';
import { Button, Input, Page, Select, Tabs } from '../ui.jsx';
import ApplicationsTable from '../components/ApplicationsTable.jsx';
import { AddCandidateModal } from '../components/CandidateModals.jsx';

const NOT_ON_A_JOB = 'none'; // the Job filter's choice for people saved to The Book without a job
const BOOK = 'book';         // and the tab that shows them; the two are one choice, shown in both places

export default function Candidates() {
  const { scope, isAgency } = useApp();
  const openCandidate = useOpenCandidate();
  const [status, setStatus] = useState('active');
  const [jobId, setJobId] = useState('');
  const [owner, setOwner] = useState('');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  useEffect(() => { const t = setTimeout(() => setQuery(text.trim()), 250); return () => clearTimeout(t); }, [text]);
  // Changing client keeps the "Not on a job yet" tab open: those people belong to no client, so it still means the same.
  useEffect(() => setJobId(''), [scope]);

  const { data: jobs } = useApi(url('/jobs', { client_id: scope }));
  // People saved to The Book without a job belong to no client and have no stage or outcome, so their tab asks for
  // them alone, whichever client the workspace is showing.
  const noJob = isAgency && status === BOOK;
  // In process, Hired, Rejected and Withdrawn are about a pipeline, which somebody on no job is not in, so those
  // tabs leave them out (and "In process" matches the dashboard's count). "Everyone" is everyone.
  const { data: rows, error } = useApi(noJob
    ? url('/applications', { general: 1, status: 'all', q: query, owner })
    : url('/applications', { client_id: scope, status, job_id: jobId, q: query, owner, general: isAgency && status !== 'all' ? 0 : undefined }));
  // How many people are in The Book without a job, shown on their tab so they are easy to find.
  const { data: inBook } = useApi(isAgency ? url('/applications', { general: 1, status: 'all' }) : null);
  const chooseJob = (value) => {
    if (value === NOT_ON_A_JOB) return setStatus(BOOK);
    setJobId(value);
    if (noJob) setStatus('active');
  };
  // Everyone who can own candidates, plus anyone who has left but still owns some here.
  const { data: owners } = useApi(url('/owners', { client_id: scope }));

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
        <Select value={noJob ? NOT_ON_A_JOB : jobId} onChange={(e) => chooseJob(e.target.value)} aria-label="Filter by job" className="!w-auto max-w-64">
          <option value="">All jobs</option>
          {isAgency && <option value={NOT_ON_A_JOB}>{NO_JOB}</option>}
          {(jobs || []).map((j) => <option key={j.id} value={j.id}>{j.title}{scope ? '' : ` · ${j.client_name}`}</option>)}
        </Select>
        <Select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Filter by owner" className="!w-auto max-w-56">
          <option value="">Any owner</option>
          {isAgency && <option value="me">Mine</option>}
          {(owners || []).map((p) => <option key={p.id} value={p.id}>{p.name}{p.active ? '' : ' (deactivated)'}</option>)}
          <option value="none">Unassigned</option>
        </Select>
      </div>
      <Tabs className="mb-4" value={status} onChange={setStatus}
        tabs={[
          { id: 'active', label: 'In process' },
          isAgency && { id: BOOK, label: NO_JOB, count: inBook ? (inBook.length === 500 ? '500+' : inBook.length) : undefined },
          { id: 'hired', label: 'Hired' }, { id: 'rejected', label: 'Rejected' }, { id: 'withdrawn', label: 'Withdrawn' }, { id: 'all', label: 'Everyone' },
        ].filter(Boolean)} />
      {noJob && <p className="mb-4 text-sm text-stone-500">People you have saved to The Book without a job. Open one to add them to a job. Only your agency sees them.</p>}
      {rows ? <ApplicationsTable rows={rows} empty={noJob && !query && !owner ? 'Nobody is in The Book without a job. Use “Add candidate” or the browser extension and choose “No job yet”. If your extension has no such choice, download it again from Settings, Browser extension.' : undefined} /> : <Pending error={error} />}
      {adding && <AddCandidateModal onClose={() => setAdding(false)} onAdded={openCandidate} />}
    </Page>
  );
}
