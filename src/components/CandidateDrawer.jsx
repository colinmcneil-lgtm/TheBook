import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  X, Mail, Phone, MapPin, Link2, FileText, ArrowRight, CalendarPlus, Ellipsis, Send, Lock, Undo2, Trash2, Pencil, Banknote, Check, CircleAlert, CircleCheck, Hourglass, Download, LogOut, ClipboardCheck, Merge, Mic, AudioLines,
} from 'lucide-react';
import { api, url, ago, since, extUrl, photoUrl, fmtDate, fmtDateTime, money, firstName, SOURCES, INTERVIEW_KINDS, RECOMMENDATIONS } from '../lib.js';
import { useApp, useApi } from '../state.jsx';
import { Avatar, Badge, Button, Card, Checkbox, Drawer, Empty, Loading, Menu, Select, Stars, Tabs, Textarea, useAction, useToast, cx } from '../ui.jsx';
import ResumeViewer from './ResumeViewer.jsx';
import { CallStatus, PhoneMark, callName, fmtLength, madeBy, useLive } from '../oracle/bits.jsx';
import { personOf, usePhone } from '../oracle/phone.jsx';
import { telHref } from '../oracle/calls.js';
import { RejectModal, ScheduleModal, ScorecardModal, EmailModal, SubmitModal, ReviewModal, OfferModal, PlacementFeeModal, EditCandidateModal } from './CandidateModals.jsx';

const OFFER_STATUS = { draft: { label: 'Draft', tone: 'gray' }, sent: { label: 'Sent', tone: 'amber' }, accepted: { label: 'Accepted', tone: 'green' }, declined: { label: 'Declined', tone: 'red' } };
const DELIVERY = { sent: { label: 'Sent', tone: 'green' }, failed: { label: 'Delivery failed', tone: 'red' }, not_configured: { label: 'Saved, not sent', tone: 'amber' } };

export default function CandidateDrawer({ id, onClose }) {
  const { data, error } = useApi(`/applications/${id}`);
  return (
    <Drawer onClose={onClose} label="Candidate">
      {error ? (
        <div className="p-6"><Empty icon={CircleAlert} title="This candidate could not be opened" action={<Button onClick={onClose}>Close</Button>}>{error}</Empty></div>
      ) : !data ? <Loading className="h-full" /> : <CandidateView data={data} onClose={onClose} />}
    </Drawer>
  );
}

function CandidateView({ data, onClose }) {
  const { isAgency, bump, user } = useApp();
  const toast = useToast();
  const phone = usePhone();
  // With the phone line connected, an agency user calls through The Book (their mobile is rung, then the candidate's,
  // and the call is written up). Otherwise the number is an ordinary link that dials from their own device.
  const callThroughTheBook = isAgency && phone.status?.configured ? () => phone.openDialer({ person: personOf(data), application_id: data.application.id }) : null;
  const [tab, setTab] = useState('overview');
  const [modal, setModal] = useState(null); // 'reject' | 'schedule' | 'email' | 'submit' | 'offer' | 'fee' | 'edit' | { review } | { scorecard }
  const { application: app, candidate, job, client, stages } = data;
  const stage = stages.find((s) => s.id === app.stage_id);
  const next = stages.find((s) => s.position === stage.position + 1);
  const active = app.status === 'active';

  const [move, moving] = useAction(async (stageId) => {
    const { stage: to } = await api.post(`/applications/${app.id}/move`, { stage_id: stageId });
    toast(to.kind === 'hired' ? `${firstName(candidate.name)} marked as hired` : `Moved to ${to.name}`);
    bump();
  });
  // Recorded calls (The Oracle) belong to the agency: the hiring team never sees that they exist.
  // The list is looked at again while a call is being written up or its recording is on its way, and as soon as a
  // phone call placed from here changes, so a call made from this profile shows up on it without reopening it.
  const { data: calls, error: callsError, reload: reloadCalls } = useLive(isAgency ? url('/oracle/calls', { candidate_id: candidate.id }) : null,
    (rows) => rows.some((c) => c.status === 'transcribing' || (c.status === 'recording' && c.source === 'phone')));
  useEffect(() => { reloadCalls(); }, [phone.call?.status, phone.call?.call_id, phone.call?.message]);

  const [restore] = useAction(async () => { await api.post(`/applications/${app.id}/restore`); bump(); });
  const [withdraw] = useAction(async () => { await api.post(`/applications/${app.id}/withdraw`); toast('Marked as withdrawn'); bump(); });
  const [erase] = useAction(async () => {
    const others = data.others.length ? ` This also removes their ${data.others.length === 1 ? 'application' : 'applications'} for ${data.others.map((o) => o.job_title).join(', ')}.` : '';
    if (!window.confirm(`Permanently delete everything held on ${candidate.name} at ${client.name}: contact details, notes, scorecards, interviews, emails, résumé and recorded calls?${others} This cannot be undone.`)) return;
    await api.del(`/candidates/${candidate.id}`);
    toast(`All data on ${candidate.name} deleted`);
    onClose();
    bump();
  });

  const [removeFromJob] = useAction(async () => {
    if (!window.confirm(`Remove ${candidate.name} from ${job.title}? Their notes, scorecards and interviews for this job are deleted.${data.others.length ? ' Their other applications are kept.' : ` This is their only application, so their record is removed too${calls?.length ? ', along with the calls recorded with them' : ''}.`}`)) return;
    await api.del(`/applications/${app.id}`);
    toast(`Removed from ${job.title}`);
    onClose();
    bump();
  });

  // Other people at this client with the same LinkedIn link, one entry each however many jobs they are in.
  const duplicates = (data.duplicates || []).filter((d, i, all) => all.findIndex((x) => x.candidate_id === d.candidate_id) === i);
  const [merge, merging] = useAction(async (other) => {
    if (!window.confirm(`Merge the other record for ${other.name} into this one? Its applications, with their notes and interviews, move to ${candidate.name}; contact details missing here are filled in from it; and the other record is then removed. This cannot be undone.`)) return;
    await api.post(`/candidates/${other.candidate_id}/merge`, { into: candidate.id });
    toast('Records merged');
    bump();
  });

  const scorecardsDue = data.interviews.filter((i) => i.status !== 'cancelled' && new Date(i.starts_at) < new Date() && i.panel.some((p) => p.id === user.id) && !i.scorecards.some((s) => s.user_id === user.id));

  return (
    <>
      <div className="border-b border-line bg-white px-5 pt-4 sm:px-6">
        <div className="flex items-start gap-4">
          <Avatar name={candidate.name} size={candidate.photo ? 64 : 48} src={photoUrl(candidate.id, candidate.photo)} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold tracking-tight text-stone-900">{candidate.name}</h2>
              {app.status === 'rejected' && <Badge tone="red">Rejected</Badge>}
              {app.status === 'withdrawn' && <Badge tone="gray">Withdrawn</Badge>}
              {app.status === 'hired' && <Badge tone="green" icon={Check}>Hired</Badge>}
            </div>
            {(candidate.current_title || candidate.current_company) && (
              <p className="text-sm text-stone-600">{[candidate.current_title, candidate.current_company].filter(Boolean).join(' at ')}</p>
            )}
            <p className="mt-0.5 text-sm text-stone-500">
              For <Link to={`/jobs/${job.id}`} className="font-medium text-brand-700 hover:underline">{job.title}</Link> · {client.name}
            </p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-stone-600">
              {candidate.email
                ? <a href={`mailto:${candidate.email}`} className="inline-flex items-center gap-1.5 hover:text-brand-700"><Mail className="size-3.5" />{candidate.email}</a>
                : <span className="inline-flex items-center gap-1.5 text-stone-400"><Mail className="size-3.5" />No email yet</span>}
              {candidate.phone && (
                <span className="inline-flex items-center gap-2">
                  <a href={telHref(candidate.phone)} className="inline-flex items-center gap-1.5 hover:text-brand-700"><Phone className="size-3.5" />{candidate.phone}</a>
                  {isAgency && (callThroughTheBook
                    ? <button type="button" onClick={callThroughTheBook} className="inline-flex h-6 items-center rounded-md bg-brand-700 px-2 text-xs font-medium text-white hover:bg-brand-800 max-sm:h-8 max-sm:px-3">Call</button>
                    : <a href={telHref(candidate.phone)} className="inline-flex h-6 items-center rounded-md border border-line bg-white px-2 text-xs font-medium text-stone-700 hover:bg-stone-50 max-sm:h-8 max-sm:px-3">Call</a>)}
                </span>
              )}
              {extUrl(candidate.linkedin) && <a href={extUrl(candidate.linkedin)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 hover:text-brand-700"><Link2 className="size-3.5" />Profile link</a>}
              {candidate.location && <span className="inline-flex items-center gap-1.5"><MapPin className="size-3.5" />{candidate.location}</span>}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700"><X className="size-5" /></button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {active || app.status === 'hired' ? (
            <>
              <Select aria-label="Stage" value={app.stage_id} onChange={(e) => move(Number(e.target.value))} disabled={moving} className="!w-auto max-w-52 font-medium">
                {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
              {active && next && (
                <Button variant="primary" icon={ArrowRight} busy={moving} onClick={() => move(next.id)}>
                  {next.kind === 'hired' ? 'Mark as hired' : `Move to ${next.name}`}
                </Button>
              )}
              {active && <Button variant="danger" onClick={() => setModal('reject')}>Reject</Button>}
            </>
          ) : (
            <Button icon={Undo2} onClick={restore}>Return to pipeline</Button>
          )}
          <div className="flex-1" />
          {active && <Button icon={CalendarPlus} onClick={() => setModal('schedule')} className="max-sm:hidden">Schedule</Button>}
          <Button icon={Mail} onClick={() => setModal('email')} className="max-sm:hidden">Email</Button>
          <Menu
            trigger={<Button aria-label="More actions" icon={Ellipsis} className="!px-2.5" />}
            items={[
              active && { label: 'Schedule interview', icon: CalendarPlus, onClick: () => setModal('schedule') },
              { label: 'Email candidate', icon: Mail, onClick: () => setModal('email') },
              isAgency && active && { label: app.review_status ? 'Resubmit to hiring team' : 'Submit to hiring team', icon: Send, onClick: () => setModal('submit') },
              isAgency && { label: data.offer ? 'Update offer' : 'Record an offer', icon: Banknote, onClick: () => setModal('offer') },
              isAgency && { label: 'Edit details', icon: Pencil, onClick: () => setModal('edit') },
              active && null,
              active && { label: 'Candidate withdrew', icon: LogOut, onClick: withdraw },
              isAgency && null,
              isAgency && { label: 'Remove from this job', icon: X, danger: true, onClick: removeFromJob },
              isAgency && { label: 'Delete all data on this person', icon: Trash2, danger: true, onClick: erase },
            ]}
          />
        </div>

        <Tabs
          className="mt-3 -mb-px border-b-0"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'overview', label: 'Overview' },
            app.resume_file && { id: 'resume', label: 'Résumé' },
            { id: 'interviews', label: 'Interviews', count: data.interviews.length || undefined },
            isAgency && { id: 'calls', label: 'Calls', count: calls?.length || undefined },
            { id: 'activity', label: 'Activity' },
            { id: 'emails', label: 'Emails', count: data.emails.length || undefined },
          ].filter(Boolean)}
        />
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5 sm:px-6">
        {app.status === 'rejected' && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
            <span className="font-medium">Rejected.</span> {app.reject_reason}
          </div>
        )}
        {scorecardsDue.map((i) => (
          <div key={i.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            <span><span className="font-medium">Your scorecard is due</span> for {i.title} on {fmtDate(i.starts_at)}.</span>
            <Button size="sm" variant="primary" icon={ClipboardCheck} onClick={() => setModal({ scorecard: i })}>Add scorecard</Button>
          </div>
        ))}
        {duplicates.map((d) => (
          <div key={d.candidate_id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            <span className="min-w-0 flex-1 basis-56">
              <span className="font-medium">Possible duplicate of {d.name}</span>
              {d.job_title ? `, who is in ${d.job_title}${d.status === 'active' && d.stage_name ? ` (${d.stage_name})` : ''}` : ''}. Both records have the same LinkedIn link.
            </span>
            <span className="flex gap-2">
              <Link to={`?c=${d.application_id}`} className="inline-flex h-8 items-center rounded-lg border border-line bg-white px-2.5 text-[13px] font-medium text-stone-800 shadow-sm hover:bg-stone-50">Open</Link>
              {isAgency && <Button size="sm" icon={Merge} busy={merging} onClick={() => merge(d)}>Merge into this record</Button>}
            </span>
          </div>
        ))}
        <ReviewBanner data={data} onDecide={(decision) => setModal({ review: decision })} />

        {tab === 'overview' && <Overview data={data} onOffer={() => setModal('offer')} onFee={() => setModal('fee')} onResume={() => setTab('resume')} />}
        {tab === 'resume' && app.resume_file && <ResumeViewer app={app} />}
        {tab === 'interviews' && <InterviewsTab data={data} onSchedule={() => setModal('schedule')} onScorecard={(i) => setModal({ scorecard: i })} />}
        {tab === 'calls' && isAgency && <CallsTab data={data} calls={calls} error={callsError} onCall={candidate.phone ? callThroughTheBook : null} />}
        {tab === 'activity' && <ActivityTab data={data} />}
        {tab === 'emails' && <EmailsTab data={data} onCompose={() => setModal('email')} />}
      </div>

      {modal === 'reject' && <RejectModal data={data} onClose={() => setModal(null)} />}
      {modal === 'schedule' && <ScheduleModal data={data} onClose={() => setModal(null)} />}
      {modal === 'email' && <EmailModal data={data} onClose={() => setModal(null)} />}
      {modal === 'submit' && <SubmitModal data={data} onClose={() => setModal(null)} />}
      {modal === 'offer' && <OfferModal data={data} onClose={() => setModal(null)} />}
      {modal === 'fee' && <PlacementFeeModal data={data} onClose={() => setModal(null)} />}
      {modal === 'edit' && <EditCandidateModal data={data} onClose={() => setModal(null)} />}
      {modal?.review && <ReviewModal data={data} decision={modal.review} onClose={() => setModal(null)} />}
      {modal?.scorecard && <ScorecardModal interview={modal.scorecard} criteria={job.criteria} candidateName={candidate.name} onClose={() => setModal(null)} />}
    </>
  );
}

function ReviewBanner({ data, onDecide }) {
  const { isAgency } = useApp();
  const app = data.application;
  if (!app.review_status) return null;
  const pending = app.review_status === 'pending';
  const approved = app.review_status === 'approved';
  return (
    <Card className={cx('overflow-hidden', pending && 'border-amber-300')}>
      <div className={cx('flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm', pending ? 'bg-amber-50 text-amber-950' : approved ? 'bg-brand-50 text-brand-900' : 'bg-red-50 text-red-900')}>
        <span className="inline-flex items-center gap-2 font-medium">
          {pending ? <Hourglass className="size-4" /> : approved ? <CircleCheck className="size-4" /> : <CircleAlert className="size-4" />}
          {pending
            ? isAgency ? `Waiting for the ${data.client.name} hiring team to review` : 'Waiting for your review'
            : `${approved ? 'Approved for interview' : 'Declined'} by ${app.reviewed_by_name || 'the hiring team'} · ${fmtDate(app.reviewed_at)}`}
        </span>
        {pending && app.status === 'active' && (
          <span className="flex gap-2">
            <Button size="sm" variant="danger" onClick={() => onDecide('declined')}>Decline</Button>
            <Button size="sm" variant="primary" icon={Check} onClick={() => onDecide('approved')}>{isAgency ? 'Record approval' : 'Approve for interview'}</Button>
          </span>
        )}
      </div>
      <div className="space-y-3 px-4 py-3">
        <div>
          <div className="text-xs font-medium tracking-wide text-stone-500 uppercase">Recruiter write-up{app.submitted_by_name ? ` · ${app.submitted_by_name}` : ''}</div>
          <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-stone-800">{app.submission_note}</p>
        </div>
        {app.review_note && (
          <div>
            <div className="text-xs font-medium tracking-wide text-stone-500 uppercase">Hiring team response</div>
            <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-stone-800">{app.review_note}</p>
          </div>
        )}
      </div>
    </Card>
  );
}

function Overview({ data, onOffer, onFee, onResume }) {
  const { isAgency, bump, user } = useApp();
  const { application: app, client } = data;
  const [note, setNote] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [addNote, saving] = useAction(async () => {
    await api.post(`/applications/${app.id}/notes`, { body: note, private: isPrivate });
    setNote('');
    bump();
  });
  const [rate] = useAction(async (rating) => { await api.patch(`/applications/${app.id}`, { rating }); bump(); });
  const [removeNote] = useAction(async (id) => { await api.del(`/notes/${id}`); bump(); });
  const { data: owners } = useApi(isAgency ? url('/owners', { client_id: client.id }) : null);
  const [assign] = useAction(async (ownerId) => { await api.patch(`/applications/${app.id}`, { owner_id: ownerId || null }); bump(); });
  const stage = data.stages.find((s) => s.id === app.stage_id);
  const row = (label, value) => (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <dt className="shrink-0 text-stone-500">{label}</dt>
      <dd className="text-right font-medium text-stone-800">{value}</dd>
    </div>
  );

  return (
    <div className="grid gap-4 md:grid-cols-[1fr_260px]">
      <div className="min-w-0 space-y-4">
        <Card className="p-4">
          <form onSubmit={(e) => { e.preventDefault(); addNote(); }}>
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for the team…" aria-label="New note" />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              {isAgency ? <Checkbox checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} label="Agency only (hidden from the client)" /> : <span />}
              <Button type="submit" variant="primary" size="sm" busy={saving} disabled={!note.trim()}>Add note</Button>
            </div>
          </form>
          {data.notes.length > 0 && (
            <ul className="mt-4 space-y-4 border-t border-line pt-4">
              {data.notes.map((n) => (
                <li key={n.id} className="flex gap-3">
                  <Avatar name={n.user_name || '?'} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 text-[13px]">
                      <span className="font-medium text-stone-900">{n.user_name}</span>
                      <span className="text-stone-400">{ago(n.created_at)}</span>
                      {n.private === 1 && <Badge tone="violet" icon={Lock}>Agency only</Badge>}
                      {n.user_id === user.id && <button type="button" onClick={() => removeNote(n.id)} className="text-xs text-stone-400 hover:text-red-700">Delete</button>}
                    </div>
                    <p className="mt-0.5 text-sm leading-relaxed whitespace-pre-wrap text-stone-700">{n.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {app.answers.length > 0 && (
          <Card className="p-4">
            <h3 className="text-sm font-semibold text-stone-900">Screening answers</h3>
            <dl className="mt-3 space-y-3">
              {app.answers.map((a, i) => (
                <div key={i}>
                  <dt className="text-[13px] text-stone-500">{a.question}</dt>
                  <dd className="mt-0.5 text-sm leading-relaxed whitespace-pre-wrap text-stone-800">{a.answer || <span className="text-stone-400">No answer</span>}</dd>
                </div>
              ))}
            </dl>
          </Card>
        )}
        {app.cover_note && (
          <Card className="p-4">
            <h3 className="text-sm font-semibold text-stone-900">Note from the candidate</h3>
            <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-stone-700">{app.cover_note}</p>
          </Card>
        )}
      </div>

      <div className="space-y-4">
        <Card className="px-4 py-2.5">
          <dl className="divide-y divide-line">
            {row('Stage', stage.name)}
            {row('In stage', since(app.stage_entered_at))}
            {row('Applied', fmtDate(app.applied_at, true))}
            {row('Source', SOURCES[app.source] || app.source)}
            {row('Rating', <Stars value={app.rating} onChange={rate} />)}
            {row('Owner', isAgency ? (
              <select aria-label="Owner" value={app.owner_id ?? ''} onChange={(e) => assign(e.target.value)} className="max-w-36 cursor-pointer rounded-md border border-line bg-white py-0.5 pr-6 pl-1.5 text-right text-sm font-medium">
                <option value="">Unassigned</option>
                {/* Someone who has left can stay the owner, but cannot be given anyone new. */}
                {(owners || []).filter((o) => o.active || o.id === app.owner_id).map((o) => <option key={o.id} value={o.id}>{o.name}{o.active ? '' : ' (deactivated)'}</option>)}
                {app.owner_id && !(owners || []).some((o) => o.id === app.owner_id) && <option value={app.owner_id}>{app.owner_name}</option>}
              </select>
            ) : app.owner_name || 'Unassigned')}
          </dl>
        </Card>
        {app.resume_file ? (
          <div className="flex items-center gap-1 rounded-xl border border-line bg-white pr-2 text-sm hover:border-brand-300">
            <button type="button" onClick={onResume} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-4 py-3 text-left">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700"><FileText className="size-4" /></span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-stone-900">View résumé</span>
                <span className="block truncate text-xs text-stone-500">{app.resume_name}</span>
              </span>
            </button>
            <a href={`/api/applications/${app.id}/resume`} download aria-label="Download résumé" title="Download" className="rounded-md p-2 text-stone-400 hover:bg-stone-100 hover:text-stone-700"><Download className="size-4" /></a>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-stone-300 px-4 py-3 text-sm text-stone-500">No résumé on file.</div>
        )}
        {(data.offer || (isAgency && stage.kind === 'offer')) && (
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-stone-900">Offer</h3>
              {data.offer && <Badge tone={OFFER_STATUS[data.offer.status].tone}>{OFFER_STATUS[data.offer.status].label}</Badge>}
            </div>
            {data.offer ? (
              <dl className="mt-2 text-sm">
                {data.offer.salary != null && row('Base salary', money(data.offer.salary, client.currency))}
                {data.offer.start_date && row('Start date', fmtDate(data.offer.start_date, true))}
                {/* Once they are hired the fee is the one recorded under Placement below, so this estimate from today's terms steps aside. */}
                {isAgency && !data.placement && client.fee_percent > 0 && data.offer.salary != null && row(`Your fee (${client.fee_percent}%)`, money((data.offer.salary * client.fee_percent) / 100, client.currency))}
              </dl>
            ) : <p className="mt-1 text-sm text-stone-500">No offer recorded yet.</p>}
            {data.offer?.notes && <p className="mt-2 text-[13px] text-stone-600">{data.offer.notes}</p>}
            {isAgency && <Button size="sm" className="mt-3 w-full" onClick={onOffer}>{data.offer ? 'Update offer' : 'Record offer'}</Button>}
          </Card>
        )}
        {/* The placement recorded for Reports when they were marked hired. Sent to agency users only. */}
        {data.placement && (
          <Card className="p-4">
            <h3 className="text-sm font-semibold text-stone-900">Placement</h3>
            <dl className="mt-2 text-sm">
              {row('Placement fee', data.placement.fee != null ? money(data.placement.fee, data.placement.currency) : <span className="font-normal text-stone-500">Not set</span>)}
              {row('Credited to', data.placement.credited_to || 'No recruiter')}
              {row('Recorded', fmtDate(data.placement.at, true))}
            </dl>
            <p className="mt-2 text-xs leading-relaxed text-stone-500">
              {data.placement.fee_edited ? 'The fee was entered by hand.'
                : data.placement.fee != null ? `The fee was worked out when they were hired: ${data.placement.fee_percent}% of the ${money(data.placement.salary, data.placement.currency)} offer.`
                  : 'No fee could be worked out when they were hired: the offer had no salary, or the client has no fee per hire.'}
              {' '}This is the figure Reports counts. Your agency only.
            </p>
            <Button size="sm" className="mt-3 w-full" onClick={onFee}>{data.placement.fee != null ? 'Correct the fee' : 'Add the fee'}</Button>
          </Card>
        )}
        {data.others.length > 0 && (
          <Card className="p-4">
            <h3 className="text-sm font-semibold text-stone-900">Also considered for</h3>
            <ul className="mt-2 space-y-1.5 text-sm">
              {data.others.map((o) => (
                <li key={o.id}><Link to={`?c=${o.id}`} className="font-medium text-brand-700 hover:underline">{o.job_title}</Link> <span className="text-stone-500">· {o.status === 'active' ? o.stage_name : o.status}</span></li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

function InterviewsTab({ data, onSchedule, onScorecard }) {
  const { bump, user } = useApp();
  const [setStatus] = useAction(async (id, status) => { await api.patch(`/interviews/${id}`, { status }); bump(); });
  const canSchedule = data.application.status === 'active';
  if (!data.interviews.length)
    return <Card><Empty icon={CalendarPlus} title="No interviews yet" action={canSchedule && <Button variant="primary" icon={CalendarPlus} onClick={onSchedule}>Schedule interview</Button>}>{canSchedule ? 'Book the first conversation and choose who should give feedback.' : 'This candidate is no longer in the pipeline.'}</Empty></Card>;
  return (
    <div className="space-y-4">
      {canSchedule && <div className="flex justify-end"><Button icon={CalendarPlus} size="sm" onClick={onSchedule}>Schedule another</Button></div>}
      {data.interviews.map((i) => {
        const past = new Date(i.starts_at) < new Date();
        const mine = i.scorecards.find((s) => s.user_id === user.id);
        return (
          <Card key={i.id}>
            <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-stone-900">{i.title}</h3>
                  {i.status === 'cancelled' ? <Badge tone="red">Cancelled</Badge> : i.status === 'completed' ? <Badge tone="gray">Completed</Badge> : past ? <Badge tone="amber">Awaiting feedback</Badge> : <Badge tone="blue">Upcoming</Badge>}
                </div>
                <p className="mt-0.5 text-[13px] text-stone-600">{fmtDateTime(i.starts_at)} · {i.duration_min} min · {INTERVIEW_KINDS[i.kind]}</p>
                {i.location && <p className="truncate text-[13px] text-stone-500">{i.location}</p>}
                {i.notes && <p className="mt-1 text-[13px] text-stone-600">{i.notes}</p>}
              </div>
              <div className="flex items-center gap-2">
                {i.status !== 'cancelled' && <Button size="sm" variant={past && !mine ? 'primary' : 'secondary'} icon={ClipboardCheck} onClick={() => onScorecard(i)}>{mine ? 'Edit my scorecard' : 'Add scorecard'}</Button>}
                <Menu
                  trigger={<Button size="sm" aria-label="Interview actions" icon={Ellipsis} className="!px-2" />}
                  items={[
                    { label: 'Add to calendar (.ics)', icon: Download, onClick: () => { window.location.href = `/api/interviews/${i.id}/ics`; } },
                    i.status === 'scheduled' && { label: 'Mark as completed', icon: Check, onClick: () => setStatus(i.id, 'completed') },
                    i.status !== 'cancelled' && { label: 'Cancel interview', icon: X, danger: true, onClick: () => setStatus(i.id, 'cancelled') },
                    i.status === 'cancelled' && { label: 'Reinstate', icon: Undo2, onClick: () => setStatus(i.id, 'scheduled') },
                  ]}
                />
              </div>
            </div>
            <div className="divide-y divide-line border-t border-line">
              {i.panel.map((p) => {
                const sc = i.scorecards.find((s) => s.user_id === p.id);
                return (
                  <div key={p.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <Avatar name={p.name} size={26} />
                      <span className="text-sm font-medium text-stone-900">{p.name}</span>
                      <span className="text-xs text-stone-500">{p.role === 'client' ? p.title : 'Agency'}</span>
                      <span className="flex-1" />
                      {sc ? <Badge tone={RECOMMENDATIONS[sc.recommendation].tone}>{RECOMMENDATIONS[sc.recommendation].label}</Badge> : <span className="text-xs text-stone-400">{past && i.status !== 'cancelled' ? 'Feedback not in yet' : 'No scorecard yet'}</span>}
                    </div>
                    {sc && (
                      <div className="mt-2 pl-9">
                        {Object.keys(sc.ratings).length > 0 && (
                          <div className="mb-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                            {Object.entries(sc.ratings).map(([criterion, value]) => (
                              <div key={criterion} className="flex items-center justify-between gap-3 text-[13px] text-stone-600">
                                <span className="truncate">{criterion}</span>
                                <span className="flex shrink-0 gap-0.5" role="img" aria-label={`${value} out of 4`}>
                                  {[1, 2, 3, 4].map((n) => <span key={n} className={cx('h-1.5 w-4 rounded-full', n <= value ? 'bg-brand-600' : 'bg-stone-200')} />)}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        {sc.notes && <p className="text-sm leading-relaxed whitespace-pre-wrap text-stone-700">{sc.notes}</p>}
                      </div>
                    )}
                  </div>
                );
              })}
              {!i.panel.length && <div className="px-4 py-3 text-sm text-stone-500">No interviewers assigned.</div>}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/** Calls with this person in The Oracle, recorded in the browser or made on the phone line, for any of the jobs they are being considered for. Agency only. */
function CallsTab({ data, calls, error, onCall }) {
  const navigate = useNavigate();
  const { application: app, candidate } = data;
  const actions = (
    <span className="flex shrink-0 justify-end gap-2">
      {onCall && <Button icon={Phone} size="sm" onClick={onCall}>Call</Button>}
      <Button variant="primary" icon={Mic} size="sm" onClick={() => navigate(`/oracle?application=${app.id}`)}>Record a call</Button>
    </span>
  );
  if (error) return <Card><Empty icon={CircleAlert} title="The calls could not be loaded">{error}</Empty></Card>;
  if (!calls) return <Loading />;
  if (!calls.length)
    return <Card><Empty icon={AudioLines} title="No calls yet" action={actions}>{onCall ? `Call ${firstName(candidate.name)} through The Book, or record` : 'Record'} your conversations with {firstName(candidate.name)} in The Oracle, and they are kept here with their transcript and notes. Only your agency sees them.</Empty></Card>;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 text-xs text-stone-500"><Lock className="size-3.5" />Only your agency sees calls.</span>
        {actions}
      </div>
      <Card className="divide-y divide-line overflow-hidden">
        {calls.map((c) => (
          <Link key={c.id} to={`/oracle/${c.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-stone-50">
            <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-full ring-1 ring-inset', c.source === 'phone' ? 'bg-brand-950 text-gold ring-brand-900' : 'bg-brand-50 text-brand-700 ring-brand-100')} aria-hidden="true">
              {c.source === 'phone' ? <Phone className="size-4" /> : <Mic className="size-4" />}
            </span>
            <span className="min-w-0 flex-1 basis-56">
              <span className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium text-stone-900">{callName(c)}</span>
                <PhoneMark call={c} />
                <CallStatus status={c.status} source={c.source} />
              </span>
              <span className="block truncate text-[13px] text-stone-500">
                {madeBy(c)}{c.phone_display ? ` · ${c.phone_display}` : ''}{c.application_id !== app.id && c.job_title ? ` · about ${c.job_title}` : ''}
              </span>
            </span>
            <span className="tabular text-right text-[13px] text-stone-600">{fmtDateTime(c.created_at)}{c.duration_ms ? ` · ${fmtLength(c.duration_ms)}` : ''}</span>
          </Link>
        ))}
      </Card>
    </div>
  );
}

function ActivityTab({ data }) {
  return (
    <Card className="p-4">
      <ol className="relative space-y-4 before:absolute before:top-2 before:bottom-2 before:left-[5px] before:w-px before:bg-line">
        {data.activities.map((a) => (
          <li key={a.id} className="relative flex gap-3 pl-0">
            <span className="relative z-10 mt-1.5 size-[11px] shrink-0 rounded-full border-2 border-white bg-stone-300 ring-1 ring-stone-300" />
            <div className="min-w-0 text-sm">
              <p className="text-stone-800">{a.detail}</p>
              <p className="text-xs text-stone-500">{a.user_name || data.candidate.name} · {fmtDateTime(a.created_at)}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function EmailsTab({ data, onCompose }) {
  if (!data.emails.length)
    return <Card><Empty icon={Mail} title="No emails yet" action={<Button variant="primary" icon={Mail} onClick={onCompose}>Email candidate</Button>}>Messages you send from here are kept on the candidate's record.</Empty></Card>;
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><Button icon={Mail} size="sm" onClick={onCompose}>New email</Button></div>
      {data.emails.map((e) => (
        <Card key={e.id} className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-stone-900">{e.subject}</h3>
            <Badge tone={DELIVERY[e.delivery]?.tone}>{DELIVERY[e.delivery]?.label}</Badge>
          </div>
          <p className="text-xs text-stone-500">To {e.to_email} · {e.sent_by_name || 'Automatic'} · {fmtDateTime(e.created_at)}</p>
          <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-stone-700">{e.body}</p>
        </Card>
      ))}
    </div>
  );
}
