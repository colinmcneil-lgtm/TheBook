import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FileUp, Search, UserPlus } from 'lucide-react';
import { useApp, useApi, useOpenCandidate, Pending } from '../state.jsx';
import { url, plural, NO_JOB } from '../lib.js';
import { Button, Input, Page, Select, Tabs, useToast } from '../ui.jsx';
import ApplicationsTable from '../components/ApplicationsTable.jsx';
import { AddCandidateModal, carriesFiles, pickResume, resumeRefusal } from '../components/CandidateModals.jsx';

const NOT_ON_A_JOB = 'none'; // the Job filter's choice for people saved to The Book without a job
const BOOK = 'book';         // and the tab that shows them; the two are one choice, shown in both places
const STATUSES = ['active', BOOK, 'hired', 'rejected', 'withdrawn', 'all'];
// The tab the address asks for (?status=…), if it is one this user has: the "Not on a job yet" tab is the agency's.
const statusIn = (params, isAgency) => {
  const asked = params.get('status');
  return STATUSES.includes(asked) && (asked !== BOOK || isAgency) ? asked : 'active';
};

export default function Candidates() {
  const { scope, isAgency } = useApp();
  const openCandidate = useOpenCandidate();
  // The page can be opened already searching (?q=…, from the bar at the top) or already adding somebody (?new=1).
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState(statusIn(params, isAgency));
  const [jobId, setJobId] = useState('');
  const [owner, setOwner] = useState('');
  const [text, setText] = useState(params.get('q') || '');
  const [query, setQuery] = useState((params.get('q') || '').trim());
  const [adding, setAdding] = useState(isAgency && params.get('new') === '1');
  const [dropped, setDropped] = useState(null); // a résumé dropped on the page, which the Add candidate dialog opens with
  const over = useDroppedResume(isAgency && !adding && !params.get('c'), (file) => { setDropped(file); setAdding(true); });
  useEffect(() => { const t = setTimeout(() => setQuery(text.trim()), 250); return () => clearTimeout(t); }, [text]);
  // Changing client keeps the "Not on a job yet" tab open: those people belong to no client, so it still means the same.
  useEffect(() => setJobId(''), [scope]);
  // A search sent from the top bar replaces whatever was typed here.
  useEffect(() => { if (params.has('q')) { setText(params.get('q')); setStatus(statusIn(params, isAgency)); } }, [params, isAgency]);
  // ?new=1 opens the form, also when this page is already open (Add candidate in the bar at the top). Once it is
  // open the address no longer needs to say so: a refresh should not open it again.
  useEffect(() => {
    if (params.get('new') !== '1') return;
    if (isAgency) setAdding(true);
    const next = new URLSearchParams(params); next.delete('new'); setParams(next, { replace: true });
  }, [params, setParams, isAgency]);

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
      {query && <p className="mb-3 text-[13px] text-stone-500" role="status">Showing people matching “{query}”{status === 'all' ? ', whatever stage they reached' : ''}.</p>}
      {rows ? <ApplicationsTable rows={rows} empty={noJob && !query && !owner ? 'Nobody is in The Book without a job. Use “Add candidate” or the browser extension and choose “No job yet”. If your extension has no such choice, download it again from Settings, Browser extension.' : undefined} /> : <Pending error={error} />}
      {adding && <AddCandidateModal initialFile={dropped} onClose={() => { setAdding(false); setDropped(null); }} onAdded={openCandidate} />}
      {over && (
        <div className="pointer-events-none fixed inset-3 z-40 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-brand-500 bg-brand-50 px-6 text-center" role="status">
          <span className="flex size-12 items-center justify-center rounded-xl bg-white text-brand-700 ring-1 ring-brand-200"><FileUp className="size-6" /></span>
          <p className="text-lg font-semibold text-brand-900">Drop a résumé to add a candidate</p>
          <p className="max-w-sm text-sm text-brand-800">Add candidate opens with the details filled in from it. PDF, Word, RTF or text, up to 8 MB.</p>
        </div>
      )}
    </Page>
  );
}

/**
 * A résumé file dropped anywhere on the page while `on` (agency only, with no dialog or profile open) is handed to
 * `take`, as if it had been dropped in the Add candidate dialog. Answers whether a file is being dragged over the page.
 * A file dropped on an open profile or dialog is theirs: they take it first, and this lets it be.
 */
function useDroppedResume(on, take) {
  const toast = useToast();
  const [over, setOver] = useState(false);
  const latest = useRef({ on, take });
  latest.current = { on, take };
  useEffect(() => {
    let depth = 0; // dragenter and dragleave come in pairs for every element crossed; the page is left when they even out
    const enter = (e) => { if (latest.current.on && carriesFiles(e)) { depth += 1; setOver(true); } };
    const leave = (e) => { if (carriesFiles(e) && --depth <= 0) { depth = 0; setOver(false); } };
    const overPage = (e) => {
      if (!latest.current.on || e.defaultPrevented || !carriesFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const drop = (e) => {
      depth = 0;
      setOver(false);
      if (!latest.current.on || e.defaultPrevented || !carriesFiles(e)) return;
      e.preventDefault();
      const { file, more } = pickResume(e.dataTransfer.files);
      if (!file) return;
      const refusal = resumeRefusal(file, 'add the candidate without a résumé');
      if (refusal) return toast(refusal, 'error');
      if (more) toast(`One résumé at a time: ${file.name} was taken.`);
      latest.current.take(file);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overPage);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overPage);
      window.removeEventListener('drop', drop);
    };
  }, []);
  useEffect(() => { if (!on) setOver(false); }, [on]);
  return over && on;
}
