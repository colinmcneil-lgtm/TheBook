import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowRight, Inbox as InboxIcon, Hourglass } from 'lucide-react';
import { useApp, useApi, useOpenCandidate, Pending } from '../state.jsx';
import { api, url, ago, firstName, SOURCES } from '../lib.js';
import { Badge, Button, Card, Empty, Page, Tabs, useAction, useToast } from '../ui.jsx';
import { CandidateCell, ClientName } from '../components/bits.jsx';

export default function Inbox() {
  const { scope, isAgency, bump } = useApp();
  const toast = useToast();
  const openCandidate = useOpenCandidate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || (isAgency ? 'new' : 'review');
  const setTab = (t) => { const next = new URLSearchParams(params); next.set('tab', t); setParams(next, { replace: true }); };
  const { data: fresh, error } = useApi(url('/applications', { client_id: scope, status: 'active', stage_kind: 'applied', sort: 'oldest' }));
  const { data: review, error: reviewError } = useApi(url('/applications', { client_id: scope, status: 'active', review: 'pending', sort: 'oldest' }));
  const [busyId, setBusyId] = useState(null);

  const [advance] = useAction(async (app) => {
    setBusyId(app.id);
    try {
      const { stages } = await api.get(`/jobs/${app.job_id}`);
      const next = stages.find((s) => s.position === app.stage_position + 1);
      await api.post(`/applications/${app.id}/move`, { stage_id: next.id });
      toast(`${firstName(app.name)} moved to ${next.name}`);
      bump();
    } finally { setBusyId(null); }
  });

  const rows = tab === 'new' ? fresh : review;
  const tabs = isAgency
    ? [{ id: 'new', label: 'New applicants', count: fresh?.length }, { id: 'review', label: 'With hiring team', count: review?.length }]
    : [{ id: 'review', label: 'Waiting for your review', count: review?.length }, { id: 'new', label: 'New applicants', count: fresh?.length }];

  return (
    <Page title={isAgency ? 'Inbox' : 'To review'} subtitle={isAgency ? 'Every new application across your clients, oldest first.' : 'Candidates your recruiter has put forward, with their write-up.'}>
      <Tabs tabs={tabs} value={tab} onChange={setTab} className="mb-4" />
      {!rows ? <Pending error={tab === 'new' ? error : reviewError} /> : rows.length === 0 ? (
        <Card>
          <Empty icon={tab === 'new' ? InboxIcon : Hourglass} title={tab === 'new' ? 'You are all caught up' : 'Nothing waiting for review'}>
            {tab === 'new' ? 'New applications from your clients’ careers pages land here.' : isAgency ? 'Candidates you submit to a hiring team appear here until they respond.' : 'When your recruiter shortlists someone, they will appear here for your decision.'}
          </Empty>
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {rows.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-stone-50">
              <button type="button" onClick={() => openCandidate(a.id)} className="flex min-w-0 flex-1 basis-64 items-center text-left">
                <CandidateCell app={a} />
              </button>
              <div className="min-w-0 basis-52 text-[13px]">
                <div className="truncate font-medium text-stone-800">{a.job_title}</div>
                <div className="flex items-center gap-2 text-stone-500"><ClientName name={a.client_name} color={a.brand_color} /></div>
              </div>
              <div className="flex basis-36 flex-col items-start gap-1 text-[13px] text-stone-500">
                <Badge tone="gray">{SOURCES[a.source] || a.source}</Badge>
                <span>{tab === 'new' ? `Applied ${ago(a.applied_at)}` : a.stage_name}</span>
              </div>
              <div className="flex gap-2">
                {tab === 'new' ? (
                  <>
                    <Button size="sm" variant="primary" icon={ArrowRight} busy={busyId === a.id} onClick={() => advance(a)}>Advance</Button>
                    <Button size="sm" onClick={() => openCandidate(a.id)}>Open</Button>
                  </>
                ) : (
                  <Button size="sm" variant={isAgency ? 'secondary' : 'primary'} onClick={() => openCandidate(a.id)}>{isAgency ? 'Open' : 'Review'}</Button>
                )}
              </div>
            </div>
          ))}
          {rows.length === 500 && <p className="px-4 py-3 text-center text-[13px] text-stone-500">Showing the 500 oldest. The rest appear as you work through these.</p>}
        </Card>
      )}
    </Page>
  );
}
