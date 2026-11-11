import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, UserPlus } from 'lucide-react';
import { useApp, useApi, useOpenCandidate, Pending } from '../state.jsx';
import { url, plural } from '../lib.js';
import { Button, Input, Page, Select, Tabs } from '../ui.jsx';
import ApplicationsTable from '../components/ApplicationsTable.jsx';
import { AddCandidateModal } from '../components/CandidateModals.jsx';

const STATUSES = ['active', 'hired', 'rejected', 'withdrawn', 'all'];

export default function Candidates() {
  const { scope, isAgency } = useApp();
  const openCandidate = useOpenCandidate();
  // The page can be opened already searching (?q=…, from the bar at the top) or already adding somebody (?new=1).
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState(STATUSES.includes(params.get('status')) ? params.get('status') : 'active');
  const [jobId, setJobId] = useState('');
  const [owner, setOwner] = useState('');
  const [text, setText] = useState(params.get('q') || '');
  const [query, setQuery] = useState((params.get('q') || '').trim());
  const [adding, setAdding] = useState(isAgency && params.get('new') === '1');
  useEffect(() => { const t = setTimeout(() => setQuery(text.trim()), 250); return () => clearTimeout(t); }, [text]);
  useEffect(() => setJobId(''), [scope]);
  // A search sent from the top bar replaces whatever was typed here.
  useEffect(() => { if (params.has('q')) { setText(params.get('q')); setStatus(STATUSES.includes(params.get('status')) ? params.get('status') : 'active'); } }, [params]);
  // ?new=1 opens the form, also when this page is already open (Add candidate in the bar at the top). Once it is
  // open the address no longer needs to say so: a refresh should not open it again.
  useEffect(() => {
    if (params.get('new') !== '1') return;
    if (isAgency) setAdding(true);
    const next = new URLSearchParams(params); next.delete('new'); setParams(next, { replace: true });
  }, [params, setParams, isAgency]);

  const { data: jobs } = useApi(url('/jobs', { client_id: scope }));
  const { data: rows, error } = useApi(url('/applications', { client_id: scope, status, job_id: jobId, q: query, owner }));
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
        <Select value={jobId} onChange={(e) => setJobId(e.target.value)} aria-label="Filter by job" className="!w-auto max-w-64">
          <option value="">All jobs</option>
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
        tabs={[{ id: 'active', label: 'In process' }, { id: 'hired', label: 'Hired' }, { id: 'rejected', label: 'Rejected' }, { id: 'withdrawn', label: 'Withdrawn' }, { id: 'all', label: 'Everyone' }]} />
      {query && <p className="mb-3 text-[13px] text-stone-500" role="status">Showing people matching “{query}”{status === 'all' ? ', whatever stage they reached' : ''}.</p>}
      {rows ? <ApplicationsTable rows={rows} /> : <Pending error={error} />}
      {adding && <AddCandidateModal onClose={() => setAdding(false)} onAdded={openCandidate} />}
    </Page>
  );
}
