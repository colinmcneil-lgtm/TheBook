import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  X, Mail, Phone, MapPin, Link2, FileText, ArrowRight, BriefcaseBusiness, CalendarPlus, Ellipsis, Send, Lock, Undo2, Trash2, Pencil, Banknote, Check, CircleAlert, CircleCheck, Hourglass, Download, LogOut, ClipboardCheck, Merge, Mic, AudioLines, LoaderCircle, Plus, EyeOff, UserCheck, FileUp, MessagesSquare,
} from 'lucide-react';
import { api, url, ago, since, extUrl, photoUrl, telHref, fmtDate, fmtDateTime, fmtWhen, money, firstName, NO_JOB, sourceName, INTERVIEW_KINDS, RECOMMENDATIONS } from '../lib.js';
import { useApp, useApi } from '../state.jsx';
import { Avatar, Badge, Button, Card, Checkbox, Drawer, Empty, Loading, Menu, Select, Stars, Tabs, Textarea, useAction, useToast, cx } from '../ui.jsx';
import ResumeViewer from './ResumeViewer.jsx';
import { CallStatus, MetaviewMark, callName, callWhen, fmtLength, madeBy, useLive } from '../oracle/bits.jsx';
import { kindLine, oraclePath } from '../oracle/calls.js';
import { ChannelBadge, problemOf } from '../oracle/metaview.jsx';
import { RejectModal, ScheduleModal, ScorecardModal, EmailModal, SubmitModal, ReviewModal, OfferModal, PlacementFeeModal, EditCandidateModal, AddToJobModal, EraseModal,
  AttachResumeModal, RESUME_ACCEPT, carriesFiles, pickResume, resumeRefusal, useNoStrayDrops } from './CandidateModals.jsx';
import { NoJobBadge, ReviewBadge } from './bits.jsx';
import { AskReviewModal, ReviewHistory, ReviewRequests } from './TeamReviews.jsx';
import { MessageTeamModal, TeamMessagesCard, candidateAttachment } from './TeamMessages.jsx';

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
  const [tab, setTab] = useState('overview');
  const [modal, setModal] = useState(null); // 'reject' | 'schedule' | 'email' | 'submit' | 'offer' | 'fee' | 'edit' | 'addToJob' | 'erase' | 'askReview' | { review } | { scorecard } | { attach: file }
  const { application: app, candidate, job, client, stages } = data;
  // Somebody on the team asked to review this person, or asked by you: the agency's alone, so never asked for by a client's user.
  const { data: teamReviews } = useApi(isAgency ? `/applications/${app.id}/reviews` : null);
  // Someone saved to The Book without a job: there is no job, client or stage, so everything that works on one
  // (moving, rejecting, scheduling, submitting, offers) is left off their profile, and "Add to a job" leads instead.
  const general = Boolean(app.general) || !job;
  const stage = stages.find((s) => s.id === app.stage_id);
  const next = stage && stages.find((s) => s.position === stage.position + 1);
  const active = app.status === 'active' && !general;

  const [move, moving] = useAction(async (stageId) => {
    const { stage: to } = await api.post(`/applications/${app.id}/move`, { stage_id: stageId });
    toast(to.kind === 'hired' ? `${firstName(candidate.name)} marked as hired` : `Moved to ${to.name}`);
    bump();
  });
  // Calls (Otterview) belong to the agency: the hiring team never sees that they exist.
  // The list is looked at again while a call is being written up.
  const { data: calls, error: callsError, reload: reloadCalls } = useLive(isAgency ? url('/oracle/calls', { candidate_id: candidate.id }) : null,
    (rows) => rows.some((c) => c.status === 'transcribing'));

  const [restore] = useAction(async () => { await api.post(`/applications/${app.id}/restore`); bump(); });
  const [withdraw] = useAction(async () => { await api.post(`/applications/${app.id}/withdraw`); toast('Marked as withdrawn'); bump(); });
  // Only asked for the agency: erasing somebody says what happens to their Metaview calls when Metaview is connected.
  const { data: metaview } = useApi(isAgency ? '/metaview/status' : null);
  // The same person on file somewhere else (another client's record of them, or their own in The Book).
  const elsewhere = isAgency ? data.elsewhere || [] : [];
  const metaviewToo = metaview?.connected || calls?.some((c) => c.source === 'metaview');
  const [erase] = useAction(async () => {
    // Somebody who is on file in more than one place: a dialog names each record and asks which to delete, so a
    // request to be erased is not believed done while another record of them is still there.
    if (elsewhere.length) return setModal('erase');
    const others = data.others.length ? ` This also removes their ${data.others.length === 1 ? 'application' : 'applications'} for ${data.others.map((o) => o.job_title).join(', ')}.` : '';
    const inMetaview = metaviewToo
      ? `\n\nThe Book also forgets their Metaview calls. The conversations themselves stay in Metaview: delete them there too if they must go altogether.` : '';
    if (!window.confirm(`Permanently delete everything held on ${candidate.name}${client ? ` at ${client.name}` : ''}: contact details, notes, scorecards, interviews, emails, résumé and recorded calls?${others} This cannot be undone.${inMetaview}`)) return;
    await api.del(`/candidates/${candidate.id}`);
    toast(`All data on ${candidate.name} deleted`);
    onClose();
    bump();
  });

  const [removeFromJob] = useAction(async () => {
    // Someone who was in The Book before this job goes back to it, with what the agency kept on them. Anyone else
    // is removed with what was written for the job.
    // Still on another job of this client: the client's record stays for that job, and what the agency kept on this
    // entry goes back to The Book as a record of its own. The question says so, and both profiles then point at each other.
    const staysIn = data.others.map((o) => o.job_title).join(', ');
    const question = app.from_book && data.others.length
      ? `Remove ${candidate.name} from ${job.title}? They stay in ${staysIn} at ${client.name}. What was kept on this entry (its notes, résumé, calls and history) goes back to The Book without a job as a separate record, and is no longer on their ${client.name} profile, which will say where it went. Their interviews, scorecards, rating and any offer for ${job.title} are deleted, with the write-up for the hiring team and the hiring team’s review.`
      : app.from_book
      ? `Remove ${candidate.name} from ${job.title}? They go back to The Book without a job and keep their notes, résumé, calls and history. Their interviews, scorecards, rating and any offer for this job are deleted, with the write-up for the hiring team and the hiring team’s review.`
      : `Remove ${candidate.name} from ${job.title}? Their notes, scorecards and interviews for this job are deleted.${data.others.length ? ' Their other applications are kept.' : ` This is their only application, so their record is removed too${calls?.length ? ', along with the calls recorded with them' : ''}.`}`;
    if (!window.confirm(question)) return;
    const result = await api.del(`/applications/${app.id}`);
    toast(result.returned ? `${firstName(candidate.name)} is back in The Book without a job` : `Removed from ${job.title}`);
    onClose();
    bump();
  });

  // Other records with the same LinkedIn link (at this client, or in The Book without a job), one entry each however many jobs they are in.
  const duplicates = (data.duplicates || []).filter((d, i, all) => all.findIndex((x) => x.candidate_id === d.candidate_id) === i);
  const [merge, merging] = useAction(async (other) => {
    if (!window.confirm(`Merge the other record for ${other.name} into this one? Its applications, with their notes and interviews, move to ${candidate.name}; contact details missing here are filled in from it; and the other record is then removed. This cannot be undone.`)) return;
    await api.post(`/candidates/${other.candidate_id}/merge`, { into: candidate.id });
    toast('Records merged');
    bump();
  });

  // A résumé file dropped anywhere on the open profile, or chosen on it, is attached through a dialog that shows what
  // it would fill in (agency only); when several are dropped at once, the dialog says which one was taken. While another
  // dialog is open a file dropped here is not taken (and that dialog, or a toast, says so), and one dropped just outside the profile is
  // not opened by the browser either.
  useNoStrayDrops();
  const [over, setOver] = useState(false);
  const canDrop = isAgency && !modal;
  useEffect(() => { if (!canDrop) setOver(false); }, [canDrop]);
  // Once a résumé is attached the Résumé tab is opened, but only when the profile shows the new file: before that, the
  // viewer would show the new file under the old one's name.
  const [attachedOver, setAttachedOver] = useState(); // the résumé that was on file when another was attached
  const showAttached = (answer) => (answer?.resume === 'unchanged' ? setTab('resume') : setAttachedOver({ file: app.resume_file }));
  useEffect(() => { if (attachedOver && app.resume_file && app.resume_file !== attachedOver.file) { setAttachedOver(undefined); setTab('resume'); } }, [app.resume_file, attachedOver]);
  const takeResume = (file, more = false) => {
    if (!file) return;
    const refusal = resumeRefusal(file);
    if (refusal) return toast(refusal, 'error');
    setModal({ attach: file, more }); // the dialog says when other files were left out
  };
  const dropZone = canDrop ? {
    onDragEnter: (e) => { if (carriesFiles(e)) { e.preventDefault(); setOver(true); } },
    onDragOver: (e) => { if (carriesFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true); } },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); },
    onDrop: (e) => { if (!carriesFiles(e)) return; e.preventDefault(); setOver(false); const { file, more } = pickResume(e.dataTransfer.files); takeResume(file, more); },
  } : isAgency ? {
    // A dialog is open on the profile: the file is not taken, and the person is told why nothing happened.
    onDragOver: (e) => { if (!e.defaultPrevented && carriesFiles(e)) e.preventDefault(); },
    // The attach dialog says so itself, where a toast would cover its buttons on a phone.
    onDrop: (e) => {
      if (e.defaultPrevented || !carriesFiles(e)) return;
      e.preventDefault();
      if (modal?.attach) setModal((m) => (m?.attach ? { ...m, again: true } : m));
      else toast('Close this dialog first to attach a résumé.');
    },
  } : {};

  const scorecardsDue = data.interviews.filter((i) => i.status !== 'cancelled' && new Date(i.starts_at) < new Date() && i.panel.some((p) => p.id === user.id) && !i.scorecards.some((s) => s.user_id === user.id));

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...dropZone}>
      {over && (
        <div className="pointer-events-none absolute inset-2 z-40 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-brand-500 bg-brand-50 px-6 text-center" role="status">
          <span className="flex size-12 items-center justify-center rounded-xl bg-white text-brand-700 ring-1 ring-brand-200"><FileUp className="size-6" /></span>
          <p className="text-lg font-semibold text-brand-900">Drop the résumé here</p>
          <p className="max-w-sm text-sm text-brand-800">It is attached to {firstName(candidate.name)}’s profile, and you see what it would fill in before anything is saved. PDF, Word, RTF or text, up to 8 MB.</p>
        </div>
      )}
      <div className="border-b border-line bg-white px-5 pt-4 sm:px-6">
        <div className="flex items-start gap-4">
          <Avatar name={candidate.name} size={candidate.photo ? 64 : 52} src={photoUrl(candidate.id, candidate.photo)} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="display text-[26px] leading-tight text-stone-900">{candidate.name}</h2>
              {app.review_status === 'pending' && app.status === 'active' && <ReviewBadge status={app.review_status} />}
              {app.status === 'rejected' && <Badge tone="red">Rejected</Badge>}
              {app.status === 'withdrawn' && <Badge tone="gray">Withdrawn</Badge>}
              {app.status === 'hired' && <Badge tone="green" icon={Check}>Hired</Badge>}
            </div>
            {(candidate.current_title || candidate.current_company) && (
              <p className="text-sm text-stone-600">{[candidate.current_title, candidate.current_company].filter(Boolean).join(' at ')}</p>
            )}
            {general ? (
              <p className="mt-0.5 text-sm text-stone-500">In The Book, not on a job yet</p>
            ) : (
              <p className="mt-0.5 text-sm text-stone-500">
                For <Link to={`/jobs/${job.id}`} className="font-medium text-brand-700 hover:underline">{job.title}</Link> at {client.name}
                {active && stage && <> · {stage.name} · {since(app.stage_entered_at)} in stage</>}
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-stone-600">
              {candidate.email
                ? <a href={`mailto:${candidate.email}`} className="inline-flex items-center gap-1.5 hover:text-brand-700"><Mail className="size-3.5" />{candidate.email}</a>
                : <span className="inline-flex items-center gap-1.5 text-stone-400"><Mail className="size-3.5" />No email yet</span>}
              {candidate.phone && <a href={telHref(candidate.phone)} className="inline-flex items-center gap-1.5 hover:text-brand-700"><Phone className="size-3.5" />{candidate.phone}</a>}
              {extUrl(candidate.linkedin) && <a href={extUrl(candidate.linkedin)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 hover:text-brand-700"><Link2 className="size-3.5" />Profile link</a>}
              {candidate.location && <span className="inline-flex items-center gap-1.5"><MapPin className="size-3.5" />{candidate.location}</span>}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700"><X className="size-5" /></button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {general ? (
            isAgency && <Button variant="primary" icon={BriefcaseBusiness} onClick={() => setModal('addToJob')}>Add to a job</Button>
          ) : active || app.status === 'hired' ? (
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
              isAgency && !general && { label: data.offer ? 'Update offer' : 'Record an offer', icon: Banknote, onClick: () => setModal('offer') },
              isAgency && { label: 'Ask for AE review', icon: UserCheck, onClick: () => setModal('askReview') },
              isAgency && { label: 'Message the team', icon: MessagesSquare, onClick: () => setModal('message') },
              isAgency && { label: 'Edit details', icon: Pencil, onClick: () => setModal('edit') },
              isAgency && !general && { label: 'Add to another job', icon: BriefcaseBusiness, onClick: () => setModal('addToJob') },
              active && null,
              active && { label: 'Candidate withdrew', icon: LogOut, onClick: withdraw },
              isAgency && null,
              isAgency && !general && { label: 'Remove from this job', icon: X, danger: true, onClick: removeFromJob },
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
            !general && { id: 'interviews', label: 'Interviews', count: data.interviews.length || undefined },
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
        {isAgency && <ReviewRequests reviews={teamReviews?.reviews} candidateName={candidate.name} />}
        {scorecardsDue.map((i) => (
          <div key={i.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gold-200 bg-gold-50 px-4 py-3 text-sm text-gold-900">
            <span><span className="font-medium">Your scorecard is due</span> for {i.title} on {fmtDate(i.starts_at)}.</span>
            <Button size="sm" variant="primary" icon={ClipboardCheck} onClick={() => setModal({ scorecard: i })}>Add scorecard</Button>
          </div>
        ))}
        {duplicates.map((d) => (
          <div key={d.candidate_id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gold-200 bg-gold-50 px-4 py-3 text-sm text-gold-900">
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
        {elsewhere.map((r) => (
          <div key={r.candidate_id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-stone-50 px-4 py-3 text-sm text-stone-700">
            <span className="min-w-0 flex-1 basis-56">
              <span className="font-medium text-stone-900">{r.client_id ? `Also on ${r.client_name}’s record` : 'Also in The Book without a job'}</span>
              {r.client_id && r.job_title ? `, in ${r.job_title}` : ''}{r.name !== candidate.name ? `, as ${r.name}` : ''}.
              {' '}{r.same_email ? 'Same email address.' : 'Same LinkedIn link.'} It is a separate record: notes, calls and history on one are not on the other, and deleting one leaves the other.
            </span>
            {r.application_id && <Link to={`?c=${r.application_id}`} className="inline-flex h-8 items-center rounded-lg border border-line bg-white px-2.5 text-[13px] font-medium text-stone-800 shadow-sm hover:bg-stone-50">Open</Link>}
          </div>
        ))}
        <ReviewBanner data={data} onDecide={(decision) => setModal({ review: decision })} />

        {tab === 'overview' && <Overview data={data} reviews={isAgency ? teamReviews?.reviews : null} onOffer={() => setModal('offer')} onFee={() => setModal('fee')} onResume={() => setTab('resume')} onChooseResume={isAgency ? takeResume : null} onMessage={isAgency ? () => setModal('message') : null} />}
        {/* Drawn afresh when the file changes: a newer résumé can take the place of this one under the same address and name.
            Straight after an attach, until the profile shows the new file, it would be drawn under the old one's name. */}
        {tab === 'resume' && app.resume_file && (attachedOver ? <Loading /> : <ResumeViewer key={app.resume_file} app={app} />)}
        {tab === 'interviews' && !general && <InterviewsTab data={data} onSchedule={() => setModal('schedule')} onEdit={(i) => setModal({ editInterview: i })} onScorecard={(i) => setModal({ scorecard: i })} />}
        {tab === 'calls' && isAgency && <CallsTab data={data} calls={calls} error={callsError} reload={reloadCalls} />}
        {tab === 'activity' && <ActivityTab data={data} />}
        {tab === 'emails' && <EmailsTab data={data} onCompose={() => setModal('email')} />}
      </div>

      {modal === 'reject' && <RejectModal data={data} onClose={() => setModal(null)} />}
      {modal === 'schedule' && <ScheduleModal data={data} onClose={() => setModal(null)} />}
      {modal?.editInterview && <ScheduleModal data={data} interview={modal.editInterview} onClose={() => setModal(null)} />}
      {modal === 'email' && <EmailModal data={data} onClose={() => setModal(null)} />}
      {modal === 'submit' && <SubmitModal data={data} onClose={() => setModal(null)} />}
      {modal === 'offer' && <OfferModal data={data} onClose={() => setModal(null)} />}
      {modal === 'fee' && <PlacementFeeModal data={data} onClose={() => setModal(null)} />}
      {modal === 'edit' && <EditCandidateModal data={data} onClose={() => setModal(null)} />}
      {modal === 'addToJob' && <AddToJobModal data={data} onClose={() => setModal(null)} />}
      {modal === 'askReview' && <AskReviewModal applicationId={app.id} candidateName={candidate.name} jobLine={job ? `${job.title} at ${client.name}` : null} onClose={() => setModal(null)} />}
      {modal === 'message' && <MessageTeamModal attachment={candidateAttachment({ id: app.id, name: candidate.name, job_id: job?.id, job_title: job?.title, client_name: client?.name })} onClose={() => setModal(null)} />}
      {modal === 'erase' && <EraseModal data={data} elsewhere={elsewhere} metaviewToo={metaviewToo} onClose={() => setModal(null)} onDone={onClose} />}
      {modal?.review && <ReviewModal data={data} decision={modal.review} onClose={() => setModal(null)} />}
      {modal?.scorecard && job && <ScorecardModal interview={modal.scorecard} criteria={job.criteria} candidateName={candidate.name} onClose={() => setModal(null)} />}
      {modal?.attach && <AttachResumeModal data={data} file={modal.attach} more={modal.more} again={modal.again} onClose={() => setModal(null)} onAttached={showAttached} />}
    </div>
  );
}

function ReviewBanner({ data, onDecide }) {
  const { isAgency } = useApp();
  const app = data.application;
  if (!app.review_status) return null;
  const pending = app.review_status === 'pending';
  const approved = app.review_status === 'approved';
  return (
    <Card className="overflow-hidden">
      <div className={cx('flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm', pending ? 'bg-gold-50 text-gold-900' : approved ? 'bg-brand-50 text-brand-900' : 'bg-red-50 text-red-900')}>
        <span className="flex min-w-0 flex-1 basis-56 items-center gap-3">
          <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-lg', pending ? 'bg-gold-100 text-gold-800' : approved ? 'bg-brand-100 text-brand-800' : 'bg-red-100 text-red-800')}>
            {pending ? <Hourglass className="size-4" /> : approved ? <CircleCheck className="size-4" /> : <CircleAlert className="size-4" />}
          </span>
          <span className="min-w-0">
            <span className="block font-semibold">
              {pending
                ? isAgency ? `Waiting for the ${data.client.name} hiring team` : 'Waiting for your review'
                : `${approved ? 'Approved for interview' : 'Declined'} by ${app.reviewed_by_name || 'the hiring team'}`}
            </span>
            <span className="block text-xs opacity-80">
              {pending ? `Submitted${app.submitted_by_name ? ` by ${app.submitted_by_name}` : ''} with the write-up below` : fmtDate(app.reviewed_at)}
            </span>
          </span>
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
          <div className="text-[11px] font-semibold tracking-wider text-stone-500 uppercase">Recruiter write-up</div>
          <p className="serif mt-1.5 text-[17px] leading-relaxed whitespace-pre-wrap text-stone-900">{app.submission_note}</p>
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

/** `onChooseResume` takes a résumé file chosen on the profile; it is only given to the agency. */
function Overview({ data, reviews, onOffer, onFee, onResume, onChooseResume, onMessage }) {
  const { isAgency, bump, user } = useApp();
  const { application: app, client } = data;
  const general = Boolean(app.general) || !data.job;
  const [note, setNote] = useState('');
  // A note on someone who is not on a job yet is always agency only (the workspace stores it that way whatever is
  // sent), so there is nothing to tick: no client is in view, and it must not turn up in front of one later.
  const [isPrivate, setPrivate] = useState(general);
  const [addNote, saving] = useAction(async () => {
    await api.post(`/applications/${app.id}/notes`, { body: note, private: isPrivate });
    setNote('');
    bump();
  });
  const [rate] = useAction(async (rating) => { await api.patch(`/applications/${app.id}`, { rating }); bump(); });
  const [removeNote] = useAction(async (id) => { await api.del(`/notes/${id}`); bump(); });
  const { data: owners } = useApi(isAgency ? url('/owners', { client_id: client?.id }) : null);
  const [assign] = useAction(async (ownerId) => { await api.patch(`/applications/${app.id}`, { owner_id: ownerId || null }); bump(); });
  const [setKnown, savingKnown] = useAction(async (known) => { await api.put(`/applications/${app.id}/client-known`, { known }); bump(); });
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
              {!isAgency ? <span />
                : general ? <span className="inline-flex min-w-0 flex-1 basis-56 items-center gap-1.5 text-[13px] text-stone-500"><Lock className="size-3.5 shrink-0" />Only your agency sees notes on someone who is not on a job, now and after they are added to one.</span>
                : <Checkbox checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} label="Agency only (hidden from the client)" />}
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
            {/* Someone who is not on a job has no stage, and nothing to be rated against yet. */}
            {general ? row('Job', <NoJobBadge />) : row('Stage', stage?.name)}
            {!general && row('In stage', since(app.stage_entered_at))}
            {row(general ? 'Added' : 'Applied', fmtDate(app.applied_at, true))}
            {row('Source', sourceName(app.source, isAgency))}
            {!general && row('Rating', <Stars value={app.rating} onChange={rate} />)}
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
        {/* Only the agency is sent this: the candidate came through its confidential post. */}
        {data.board && (
          <Card className="space-y-2 p-4">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-stone-900"><EyeOff className="size-4 text-violet-700" />Confidential post</h3>
            <p className="text-[13px] leading-relaxed text-stone-600">Applied through your website, as “{data.board.title}”. They were not told who the employer is.</p>
            <Checkbox checked={data.board.client_known} disabled={savingKnown} onChange={(e) => setKnown(e.target.checked)} label="Knows who the client is"
              hint={data.board.client_known
                ? `Ticked${data.board.client_known_by_name ? ` by ${data.board.client_known_by_name}` : ''}, ${fmtDate(data.board.client_known_at)}. They are now written to like any other candidate.`
                : `Until this is ticked, nothing The Book sends them by itself names ${client.name}, and you are warned before sending a message that does.`} />
          </Card>
        )}
        {app.resume_file ? (
          <div className="space-y-1.5">
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
            {/* A newer résumé can be chosen here or dropped on the profile; the one on file is kept under Earlier résumés. */}
            {onChooseResume && (
              <p className="px-1 text-xs text-stone-500">
                <ChooseResume onFile={onChooseResume} className="mr-1 rounded font-medium text-stone-600 underline decoration-stone-300 underline-offset-2 hover:text-brand-700" aria-label="Replace the résumé">Replace</ChooseResume>
                {' '}it, or drop a newer one on the profile.
              </p>
            )}
          </div>
        ) : onChooseResume ? (
          <div className="rounded-xl border border-dashed border-stone-300 px-4 py-3 text-sm">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-500"><FileUp className="size-4" /></span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-stone-700">No résumé on file.</span>
                <span className="block text-xs text-stone-500">Drop one anywhere on this profile, or choose a file. The details in it are filled in where the profile has none.</span>
              </span>
            </div>
            <ChooseResume onFile={onChooseResume} className="mt-2.5 inline-flex h-8 w-full items-center justify-center rounded-lg border border-line bg-white px-2.5 text-[13px] font-medium text-stone-800 shadow-sm hover:bg-stone-50">Choose a file</ChooseResume>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-stone-300 px-4 py-3 text-sm text-stone-500">No résumé on file.</div>
        )}
        {/* Résumés a newer one took the place of. They are kept, never deleted, and are the agency's alone. */}
        {isAgency && data.earlier_resumes?.length > 0 && (
          <Card className="p-4">
            <h3 className="text-sm font-semibold text-stone-900">Earlier résumés</h3>
            <p className="mt-0.5 text-xs text-stone-500">Kept when a newer résumé was added. Only your agency sees them.</p>
            <ul className="mt-2 space-y-2 text-sm">
              {data.earlier_resumes.map((r) => (
                <li key={r.id}>
                  {/* The whole file name is shown, on as many lines as it needs: it is how one résumé is told from another. */}
                  <a href={`/api/applications/${app.id}/resumes/${r.id}`} download className="block font-medium break-words text-brand-700 hover:underline">{r.name || 'Résumé'}</a>
                  <span className="block text-xs text-stone-500">Replaced on {fmtDate(r.kept_at, true)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {!general && (data.offer || (isAgency && stage?.kind === 'offer')) && (
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
              {row('Placement fee', data.placement.fee != null ? money(data.placement.fee, data.placement.currency) : <span className="font-normal text-stone-500">{data.placement.fee_edited ? 'No fee' : 'Not set'}</span>)}
              {row('Credited to', data.placement.credited_to || 'No recruiter')}
              {row('Recorded', fmtDate(data.placement.at, true))}
            </dl>
            <p className="mt-2 text-xs leading-relaxed text-stone-500">
              {data.placement.fee_edited ? (data.placement.fee != null ? 'The fee was entered by hand.' : 'Somebody on your team said there is no fee for this placement.')
                : data.placement.fee != null ? `The fee was worked out when they were hired: ${data.placement.fee_percent}% of the ${money(data.placement.salary, data.placement.currency)} offer.`
                  : 'No fee could be worked out when they were hired: the offer had no salary, or the client has no fee per hire.'}
              {' '}This is the figure Reports counts. Your agency only.
            </p>
            <Button size="sm" className="mt-3 w-full" onClick={onFee}>{data.placement.fee != null ? 'Correct the fee' : 'Add the fee'}</Button>
          </Card>
        )}
        <ReviewHistory reviews={reviews} />
        {/* The team's messages about this candidate, from the conversations the person looking is in. The agency's alone. */}
        {isAgency && <TeamMessagesCard applicationId={data.application.id} onWrite={onMessage} />}
        {data.others.length > 0 && (
          <Card className="p-4">
            <h3 className="text-sm font-semibold text-stone-900">Also considered for</h3>
            <ul className="mt-2 space-y-1.5 text-sm">
              {data.others.map((o) => (
                <li key={o.id}><Link to={`?c=${o.id}`} className="font-medium text-brand-700 hover:underline">{o.job_title || NO_JOB}</Link>{o.job_title && <span className="text-stone-500"> · {o.status === 'active' ? o.stage_name : o.status}</span>}</li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

/** A button that opens the file picker for a résumé and hands over the file chosen. */
function ChooseResume({ onFile, className, children, ...props }) {
  const input = useRef(null);
  return (
    <>
      <button type="button" className={cx('cursor-pointer', className)} onClick={() => input.current?.click()} {...props}>{children}</button>
      <input ref={input} type="file" accept={RESUME_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => { onFile(e.target.files[0]); e.target.value = ''; }} />
    </>
  );
}

function InterviewsTab({ data, onSchedule, onEdit, onScorecard }) {
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
                    i.status !== 'cancelled' && { label: 'Edit interview', icon: Pencil, onClick: () => onEdit(i) },
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

/**
 * Calls with this person in Otterview, for any of the jobs they are being considered for: the ones recorded or
 * uploaded in The Book and the ones brought in from Metaview. Under them, when Metaview is connected, the Metaview
 * calls that belong to this person and are not in The Book yet, each of which can be added. Agency only.
 */
function CallsTab({ data, calls, error, reload }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { application: app, candidate } = data;
  // Nothing about Metaview is asked for, or shown, unless it is connected.
  const { data: metaview } = useApi('/metaview/status');
  const waiting = useLive(metaview?.connected ? url('/metaview/calls', { candidate_id: candidate.id, show: 'new' }) : null);
  const inMetaview = (waiting.data?.calls || []).filter((c) => !c.call_id);
  // Some of these are certainly this person's. Others only may be: the number on the call is also on somebody
  // else's record, or its address and its name point at two people. Those say so, and are only added one at a time.
  const certain = inMetaview.filter((c) => c.match?.candidate_id === candidate.id);
  const whoElse = (c) => {
    if (certain.includes(c)) return null;
    const others = (c.suggestions || []).filter((s) => s.candidate_id !== candidate.id).map((s) => `${s.name}’s`);
    return others.length ? `Could also be ${others.join(' or ')}` : `May not be ${firstName(candidate.name)}’s`;
  };
  const [adding, setAdding] = useState(null); // the Metaview call being brought in just now
  // One at a time, so Metaview is asked for one transcript at a time however many calls there are.
  const add = async (list) => {
    let added = 0;
    try {
      for (const c of list) {
        setAdding(c.id);
        await api.post(`/metaview/calls/${c.id}/open`, { application_id: app.id });
        added += 1;
      }
    } catch (err) { toast(problemOf(err), 'error'); }
    setAdding(null);
    if (added) toast(added === 1 ? `Call added to ${firstName(candidate.name)}’s profile` : `${added} calls added to ${firstName(candidate.name)}’s profile`);
    await Promise.all([reload(), waiting.reload()]);
  };

  const record = <Button variant="primary" icon={Mic} size="sm" onClick={() => navigate(`${oraclePath('record')}&application=${app.id}`)}>Record a call</Button>;
  if (error) return <Card><Empty icon={CircleAlert} title="The calls could not be loaded">{error}</Empty></Card>;
  if (!calls) return <Loading />;
  if (!calls.length && !inMetaview.length)
    return <Card><Empty icon={AudioLines} title="No calls yet" action={record}>Record your conversations with {firstName(candidate.name)} in Otterview, and they are kept here with their transcript and notes. Only your agency sees them.</Empty></Card>;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 text-xs text-stone-500"><Lock className="size-3.5" />Only your agency sees calls.</span>
        {record}
      </div>
      {calls.length > 0 && (
        <Card className="divide-y divide-line overflow-hidden">
          {calls.map((c) => (
            <Link key={c.id} to={`/otterview/${c.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-stone-50">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700 ring-1 ring-brand-100 ring-inset" aria-hidden="true">
                {c.source === 'metaview' ? <AudioLines className="size-4" /> : <Mic className="size-4" />}
              </span>
              <span className="min-w-0 flex-1 basis-56">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-stone-900">{callName(c)}</span>
                  <MetaviewMark call={c} />
                  <CallStatus status={c.status} />
                </span>
                <span className="block truncate text-[13px] text-stone-500">
                  {madeBy(c)}{c.application_id !== app.id && c.job_title ? ` · about ${c.job_title}` : ''}
                </span>
              </span>
              <span className="tabular text-right text-[13px] text-stone-600">{fmtWhen(callWhen(c))}{c.duration_ms ? ` · ${fmtLength(c.duration_ms)}` : ''}</span>
            </Link>
          ))}
        </Card>
      )}
      {inMetaview.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-2">
            <div className="min-w-0 flex-1 basis-56">
              <h3 className="text-sm font-semibold text-stone-900">In Metaview</h3>
              <p className="text-[13px] text-stone-500">
                {inMetaview.length === 1 ? 'A call' : 'Calls'} {certain.length === inMetaview.length
                  ? `with ${firstName(candidate.name)} in Metaview that ${inMetaview.length === 1 ? 'is' : 'are'}`
                  : `in Metaview that may be with ${firstName(candidate.name)} and ${inMetaview.length === 1 ? 'is' : 'are'}`} not in The Book yet. Adding one brings in its transcript and notes.
              </p>
            </div>
            {certain.length > 1 && <Button size="sm" busy={Boolean(adding)} onClick={() => add(certain)}>Add all {certain.length}</Button>}
          </div>
          <Card className="divide-y divide-line overflow-hidden">
            {inMetaview.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                <ChannelBadge call={c} size={32} />
                <span className="min-w-0 flex-1 basis-56">
                  <span className="block truncate text-sm font-medium text-stone-900">{c.title}</span>
                  <span className="block truncate text-[13px] text-stone-500">{[fmtWhen(c.started_at), kindLine(c)].filter(Boolean).join(' · ')}</span>
                  {whoElse(c) && <span className="block truncate text-[13px] font-medium text-amber-700">{whoElse(c)}</span>}
                </span>
                {adding === c.id
                  ? <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-brand-700" role="status"><LoaderCircle className="size-3.5 animate-spin" />Bringing it in…</span>
                  : <Button size="sm" icon={Plus} disabled={Boolean(adding)} onClick={() => add([c])} aria-label={`Add ${c.title}`}>Add</Button>}
              </div>
            ))}
          </Card>
          {waiting.data?.total > waiting.data?.calls.length && (
            <p className="text-xs text-stone-500">These are the {waiting.data.calls.length} most recent. <Link to={`${oraclePath('metaview')}&who=everyone&q=${encodeURIComponent(candidate.name)}`} className="font-medium text-brand-700 hover:underline">Find the rest in Otterview</Link></p>
          )}
        </>
      )}
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
