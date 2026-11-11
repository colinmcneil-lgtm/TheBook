import React, { useState } from 'react';
import { Check, CircleAlert, Hourglass, Lock, MessageSquareText, UserCheck, X } from 'lucide-react';
import { api, agoInWords, fmtDate, firstName, NO_JOB } from '../lib.js';
import { useApp, useApi } from '../state.jsx';
import { Badge, Button, Card, Field, Loading, Modal, Select, Textarea, useAction, useToast, cx } from '../ui.jsx';

// Asking somebody on the team to review a candidate: the dialog that asks, what the profile shows about requests
// (a banner for whoever is asked, a quieter line for everybody else), and the profile's short history of them.
// The agency's alone: none of this is asked for, or drawn, for a client's user.

export const ANSWER_LABELS = { good_to_go: 'Good to go', not_a_fit: 'Not a fit' };
export const AnswerBadge = ({ answer }) => <Badge tone={answer === 'good_to_go' ? 'green' : 'red'} icon={answer === 'good_to_go' ? Check : X}>{ANSWER_LABELS[answer]}</Badge>;
const possessive = (name) => `${name}’s`;

/**
 * "Ask for AE review": who (the job's account executive to begin with, when there is one and it is not you), and what
 * they should look at. `about` is the candidate's name and the job line, for the dialog's heading.
 */
export function AskReviewModal({ applicationId, candidateName, jobLine, onClose }) {
  const { bump } = useApp();
  const toast = useToast();
  const { data, error } = useApi(`/applications/${applicationId}/reviews`);
  const [chosen, setChosen] = useState(null); // null until somebody is picked: the suggestion stands until then
  const [note, setNote] = useState('');
  // Whoever has a request about this candidate that they have not answered yet cannot be asked again until they do.
  const waitingOn = new Set((data?.reviews || []).filter((r) => r.open).map((r) => r.reviewer_id));
  const who = chosen ?? (data?.suggested && !waitingOn.has(data.suggested) ? String(data.suggested) : '');
  const [ask, busy] = useAction(async () => {
    await api.post(`/applications/${applicationId}/reviews`, { reviewer_id: Number(who), note });
    const person = data.people.find((p) => p.id === Number(who));
    toast(`Asked ${firstName(person?.name)} to review ${firstName(candidateName)}`);
    bump();
    onClose();
  });
  return (
    <Modal title="Ask for AE review" subtitle={`${candidateName} · ${jobLine || NO_JOB}`} size="sm" onClose={onClose} onSubmit={ask}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" icon={UserCheck} busy={busy} disabled={!who}>Ask for review</Button></>}>
      {error ? <p className="text-sm text-red-700">{error}</p> : !data ? <Loading /> : (
        <>
          <Field label="Who should review them?"
            hint={data.suggested && Number(who) === data.suggested ? 'The account executive for this job.' : 'Anybody active on your team. They are told in their Inbox, and by e-mail when e-mail is connected.'}>
            <Select value={who} onChange={(e) => setChosen(e.target.value)} required autoFocus>
              <option value="">Choose somebody…</option>
              {data.people.map((p) => (
                <option key={p.id} value={p.id} disabled={waitingOn.has(p.id)}>
                  {p.name}{p.id === data.suggested ? ' (account executive)' : ''}{waitingOn.has(p.id) ? ' (already asked)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="What should they look at?" hint="Optional.">
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </Field>
          <p className="flex items-center gap-1.5 text-xs text-stone-500"><Lock className="size-3.5 shrink-0" />Only your agency sees review requests. The candidate and the client are never told.</p>
        </>
      )}
    </Modal>
  );
}

/** The banner for whoever was asked: who asked, when, their note, and the two answers, each with a comment if they like. */
function AnswerBanner({ review: r, candidateName }) {
  const { bump } = useApp();
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [answer, busy] = useAction(async (choice) => {
    await api.post(`/reviews/${r.id}/answer`, { answer: choice, comment });
    toast(`${ANSWER_LABELS[choice]}: ${firstName(r.asked_by_name) || 'they'} will see your answer`);
    bump();
  });
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-violet-50 px-4 py-3 text-sm text-violet-950">
        <span className="flex min-w-0 flex-1 basis-56 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-800"><UserCheck className="size-4" /></span>
          <span className="min-w-0">
            <span className="block font-semibold">{r.asked_by_name || 'Somebody on your team'} asked for your review of {firstName(candidateName)}</span>
            <span className="block text-xs opacity-80">Asked {agoInWords(r.created_at)}. Only your agency sees this.</span>
          </span>
        </span>
      </div>
      <form className="space-y-3 px-4 py-3" onSubmit={(e) => e.preventDefault()}>
        {r.note && (
          <div>
            <div className="text-[11px] font-semibold tracking-wider text-stone-500 uppercase">What to look at</div>
            <p className="serif mt-1.5 text-[17px] leading-relaxed whitespace-pre-wrap text-stone-900">{r.note}</p>
          </div>
        )}
        <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} placeholder="Add a comment (optional)" aria-label="Comment with your answer" />
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="danger" icon={X} busy={busy} onClick={() => answer('not_a_fit')}>Not a fit</Button>
          <Button size="sm" variant="primary" icon={Check} busy={busy} onClick={() => answer('good_to_go')}>Good to go</Button>
        </div>
      </form>
    </Card>
  );
}

/** A quieter line for everybody else in the agency: who is being waited on, or the answer that came back to you. */
function ReviewLine({ review: r }) {
  const { bump, user } = useApp();
  const [cancel, cancelling] = useAction(async () => { await api.post(`/reviews/${r.id}/cancel`); bump(); });
  const [done, finishing] = useAction(async () => { await api.post(`/reviews/${r.id}/done`); bump(); });
  const asker = r.asked_by === user.id ? 'you' : r.asked_by_name || 'somebody no longer on your team';
  const reviewer = r.reviewer_name || 'The person asked';
  const stuck = r.open && !r.reviewer_can_answer;
  return (
    <div className={cx('flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm',
      stuck ? 'border-gold-200 bg-gold-50 text-gold-900' : 'border-line bg-stone-50 text-stone-700')}>
      <span className="flex min-w-0 flex-1 basis-56 items-start gap-2">
        {stuck ? <CircleAlert className="mt-0.5 size-4 shrink-0" /> : r.open ? <Hourglass className="mt-0.5 size-4 shrink-0 text-stone-500" /> : <MessageSquareText className="mt-0.5 size-4 shrink-0 text-stone-500" />}
        <span className="min-w-0">
          {r.open ? (
            stuck
              ? <><span className="font-medium">{r.reviewer_name ? `${r.reviewer_name} can no longer answer` : 'The person asked is no longer on your team and cannot answer'}; ask somebody else.</span> Asked by {asker} {agoInWords(r.created_at)}.</>
              : <>Waiting on {r.reviewer_name ? possessive(r.reviewer_name) : 'their'} review, asked by {asker} {agoInWords(r.created_at)}.</>
          ) : (
            <><span className="font-medium text-stone-900">{reviewer}:</span> {ANSWER_LABELS[r.answer]}{r.comment ? <>. <span className="text-stone-600">“{r.comment}”</span></> : '.'}</>
          )}
          {r.open && r.note && <span className="mt-0.5 block text-[13px] text-stone-500 [overflow-wrap:anywhere]">“{r.note}”</span>}
        </span>
      </span>
      {r.can_cancel && <Button size="sm" busy={cancelling} onClick={cancel}>Cancel request</Button>}
      {r.can_mark_done && <Button size="sm" icon={Check} busy={finishing} onClick={done}>Done</Button>}
    </div>
  );
}

/** At the top of the profile: the requests still open, and answers that have come back to you and are still in your Inbox. */
export function ReviewRequests({ reviews, candidateName }) {
  if (!reviews) return null;
  const mine = reviews.filter((r) => r.yours_to_answer);
  const others = reviews.filter((r) => (r.open && !r.yours_to_answer) || r.can_mark_done);
  return (
    <>
      {mine.map((r) => <AnswerBanner key={r.id} review={r} candidateName={candidateName} />)}
      {others.map((r) => <ReviewLine key={r.id} review={r} />)}
    </>
  );
}

/** The profile's short history of review requests: who asked whom, when, the note, the answer and the comment. */
export function ReviewHistory({ reviews }) {
  if (!reviews?.length) return null;
  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold text-stone-900">Reviews from your team</h3>
      <p className="mt-0.5 text-xs text-stone-500">Only your agency sees these.</p>
      <ul className="mt-3 space-y-3 text-[13px]">
        {reviews.map((r) => (
          <li key={r.id} className="space-y-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium text-stone-900">{r.asked_by_name || 'Somebody'} asked {r.reviewer_name || 'somebody no longer on the team'}</span>
              {r.answer ? <AnswerBadge answer={r.answer} /> : r.cancelled_at ? <Badge tone="gray">Cancelled</Badge> : <Badge tone="amber" icon={Hourglass}>Waiting</Badge>}
            </div>
            <div className="text-xs text-stone-500">
              {fmtDate(r.created_at)}
              {r.answered_at && ` · answered ${fmtDate(r.answered_at)}`}
              {r.cancelled_at && ` · cancelled${r.cancelled_by_name ? ` by ${r.cancelled_by_name}` : ''} ${fmtDate(r.cancelled_at)}`}
            </div>
            {r.note && <p className="text-stone-600 [overflow-wrap:anywhere]">“{r.note}”</p>}
            {r.comment && <p className="text-stone-800 [overflow-wrap:anywhere]"><span className="text-stone-500">{firstName(r.reviewer_name) || 'Answer'}:</span> {r.comment}</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
