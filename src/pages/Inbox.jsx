import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowRight, Check, Inbox as InboxIcon, Hourglass, UserCheck } from 'lucide-react';
import { useApp, useApi, useOpenCandidate, Pending } from '../state.jsx';
import { api, url, ago, firstName, sourceName, BOARD_SOURCE } from '../lib.js';
import { Badge, Button, Card, Empty, Page, Tabs, useAction, useToast } from '../ui.jsx';
import { CandidateCell, ClientName, NoJobBadge } from '../components/bits.jsx';
import { AnswerBadge } from '../components/TeamReviews.jsx';

export default function Inbox() {
  const { scope, isAgency, bump } = useApp();
  const toast = useToast();
  const openCandidate = useOpenCandidate();
  const [params, setParams] = useSearchParams();
  const { data: fresh, error } = useApi(url('/applications', { client_id: scope, status: 'active', stage_kind: 'applied', sort: 'oldest' }));
  const { data: review, error: reviewError } = useApi(url('/applications', { client_id: scope, status: 'active', review: 'pending', sort: 'oldest' }));
  // What people on the team asked this person to review, and the answers to what they asked. The agency's alone.
  const { data: team, error: teamError } = useApi(isAgency ? url('/reviews', { client_id: scope }) : null);
  const teamCount = team ? team.waiting.length + team.answers.length : 0;
  // "For your review" comes first when it has anything in it, and is where the Inbox opens then. Until the agency's
  // list has loaded, which tab to open on is not known, so none is shown (rather than one that is then swapped).
  const tab = params.get('tab') || (isAgency ? (!team && !teamError ? null : teamCount ? 'reviews' : 'new') : 'review');
  const setTab = (t) => { const next = new URLSearchParams(params); next.set('tab', t); setParams(next, { replace: true }); };
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
  const forYou = { id: 'reviews', label: 'For your review', count: teamCount || undefined };
  const tabs = isAgency
    ? [...(teamCount ? [forYou] : []), { id: 'new', label: 'New applicants', count: fresh?.length }, { id: 'review', label: 'With hiring team', count: review?.length }, ...(teamCount ? [] : [forYou])]
    : [{ id: 'review', label: 'Waiting for your review', count: review?.length }, { id: 'new', label: 'New applicants', count: fresh?.length }];

  return (
    <Page title={isAgency ? 'Inbox' : 'To review'} subtitle={!isAgency ? 'Candidates your recruiter has put forward, with their write-up.' : tab === 'reviews' ? 'Candidates your team asked you to review, and the answers to what you asked.' : 'Every new application across your clients, oldest first.'}>
      {tab && <Tabs tabs={tabs} value={tab} onChange={setTab} className="mb-4" />}
      {!tab ? <Pending /> : tab === 'reviews' && isAgency ? <TeamReviews team={team} error={teamError} onDone={() => !params.get('tab') && setTab('reviews')} /> : !rows ? <Pending error={tab === 'new' ? error : reviewError} /> : rows.length === 0 ? (
        <Card>
          <Empty icon={tab === 'new' ? InboxIcon : Hourglass} title={tab === 'new' ? 'You are all caught up' : 'Nothing waiting for review'}>
            {tab === 'new' ? (isAgency ? 'New applications from your clients’ careers pages and from your own website land here.' : 'New applications land here.') : isAgency ? 'Candidates you submit to a hiring team appear here until they respond.' : 'When your recruiter shortlists someone, they will appear here for your decision.'}
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
                <Badge tone={a.source === BOARD_SOURCE && isAgency ? 'violet' : 'gray'}>{sourceName(a.source, isAgency)}</Badge>
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

/** The job and client a request is about, or that the person is in The Book on no job. */
function JobCell({ r }) {
  return (
    <div className="min-w-0 basis-52 text-[13px]">
      {r.job_id ? (
        <>
          <div className="truncate font-medium text-stone-800">{r.job_title}</div>
          <div className="flex items-center gap-2 text-stone-500"><ClientName name={r.client_name} color={r.brand_color} always /></div>
        </>
      ) : <NoJobBadge />}
    </div>
  );
}

/**
 * "For your review": candidates somebody on the team asked you to look at, oldest first, and below them the answers
 * to what you asked. "Review" opens the profile, where you answer; opening an answer does not clear it, "Done" does.
 */
function TeamReviews({ team, error, onDone }) {
  const { bump } = useApp();
  const openCandidate = useOpenCandidate();
  // Opened on this tab without choosing it, the Inbox stays on it once the last answer is done.
  const [done] = useAction(async (r) => { await api.post(`/reviews/${r.id}/done`); onDone(); bump(); });
  if (!team) return <Pending error={error} />;
  if (!team.waiting.length && !team.answers.length) {
    return (
      <Card>
        <Empty icon={UserCheck} title="Nothing for you to review">When somebody on your team asks for your review of a candidate, they appear here, and so do the answers to what you ask. Only your agency sees them.</Empty>
      </Card>
    );
  }
  return (
    <div className="space-y-6">
      {team.waiting.length > 0 && (
        <Card className="divide-y divide-line">
          {team.waiting.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-stone-50">
              <button type="button" onClick={() => openCandidate(r.application_id)} className="flex min-w-0 flex-1 basis-64 items-center text-left">
                <CandidateCell app={r} />
              </button>
              <JobCell r={r} />
              <div className="min-w-0 flex-1 basis-56 text-[13px] text-stone-500">
                <div>Asked by <span className="font-medium text-stone-800">{r.asked_by_name || 'somebody no longer on your team'}</span> · {ago(r.created_at)}</div>
                {r.note && <div className="line-clamp-2 text-stone-700 [overflow-wrap:anywhere]">“{r.note}”</div>}
              </div>
              <Button size="sm" variant="primary" icon={UserCheck} onClick={() => openCandidate(r.application_id)}>Review</Button>
            </div>
          ))}
        </Card>
      )}
      {team.answers.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-stone-900">Answers to what you asked</h2>
          <Card className="divide-y divide-line">
            {team.answers.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-stone-50">
                <button type="button" onClick={() => openCandidate(r.application_id)} className="flex min-w-0 flex-1 basis-64 items-center text-left">
                  <CandidateCell app={r} />
                </button>
                <JobCell r={r} />
                <div className="min-w-0 flex-1 basis-56 text-[13px] text-stone-500">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-medium text-stone-800">{r.reviewer_name || 'Somebody'}:</span><AnswerBadge answer={r.answer} /><span>{ago(r.answered_at)}</span></div>
                  {r.comment && <div className="line-clamp-2 text-stone-700 [overflow-wrap:anywhere]">“{r.comment}”</div>}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => openCandidate(r.application_id)}>Open</Button>
                  <Button size="sm" icon={Check} onClick={() => done(r)}>Done</Button>
                </div>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}
