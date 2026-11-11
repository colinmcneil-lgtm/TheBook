import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FileUp, LoaderCircle, TriangleAlert } from 'lucide-react';
import { api, url, firstName, sameName, watchForUpdate, renderTemplate, toLocalInput, fmtDateTime, jobLine, profilePath, INTERVIEW_KINDS, JOB_STATUS, RECOMMENDATIONS, REJECT_REASONS, SOURCES , photoUrl, squarePhoto } from '../lib.js';
import { useApp, useApi, useOpenCandidate } from '../state.jsx';
import { Button, Checkbox, Field, Input, Modal, Select, Textarea, Avatar, UpdateNotice, useAction, useToast, useClearToasts, cx } from '../ui.jsx';

const useForm = (initial) => {
  const [form, setForm] = useState(initial);
  const bind = (key) => ({ value: form[key] ?? '', onChange: (e) => setForm((f) => ({ ...f, [key]: e.target.value })) });
  return [form, setForm, bind];
};

/** Somebody who applied through the agency's confidential post and has not been told who the client is. Only the agency is sent this. */
const inTheDark = (data) => Boolean(data.board && !data.board.client_known);
/**
 * A template filled in with "our client" where the company's name would be, put right where that reads badly: "The
 * our client hiring team" becomes "Our client’s hiring team", and a sentence does not start with a small letter.
 * The server does the same to the e-mails it sends by itself (ourClientWording in server/board.js).
 */
const ourClientWording = (text) => String(text)
  .replace(/\b([Tt])he our client\b/g, (m, t) => (t === 'T' ? 'Our client’s' : 'our client’s'))
  .replace(/(^|[.!?]\s+|\n\s*)our client/g, (m, lead) => `${lead}Our client`);
/** Said beside a tick that sends one of the automatic e-mails to such a candidate. */
function ConfidentialNote({ data }) {
  if (!inTheDark(data)) return null;
  return (
    <p className="rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-950">
      {firstName(data.candidate.name)} applied through your confidential post and has not been told who the client is. The e-mail uses the title they applied under (“{data.board.title}”) and says “our client” in place of {data.client.name}. If it would name {data.client.name} all the same, it is not sent.
    </p>
  );
}

function MailNote() {
  const { mailConfigured, candidateMail } = useApp();
  if (candidateMail) return null;
  return (
    <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
      {mailConfigured
        ? 'Emails to candidates are switched off, so this is saved on the candidate’s record but not sent. An admin can switch them on in Settings.'
        : 'Email delivery is not connected yet, so messages are saved on the candidate\'s record but not sent. See Settings for how to connect it.'}
    </p>
  );
}

export function RejectModal({ data, onClose }) {
  const { bump } = useApp();
  const toast = useToast();
  const [reason, setReason] = useState(REJECT_REASONS[0]);
  const [other, setOther] = useState('');
  const [sendEmail, setSendEmail] = useState(false);
  const [save, busy] = useAction(async () => {
    const answer = await api.post(`/applications/${data.application.id}/reject`, { reason: reason === 'Other' ? other || 'Other' : reason, send_email: sendEmail });
    toast(`${firstName(data.candidate.name)} was rejected`);
    if (answer.notice) toast(answer.notice, 'error'); // the e-mail was held back
    bump();
    onClose();
  });
  return (
    <Modal title={`Reject ${data.candidate.name}?`} subtitle="They leave the active pipeline. You can restore them later." size="sm" onClose={onClose} onSubmit={save}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="dangerSolid" busy={busy}>Reject candidate</Button></>}>
      <Field label="Reason">
        <Select value={reason} onChange={(e) => setReason(e.target.value)}>{REJECT_REASONS.map((r) => <option key={r}>{r}</option>)}</Select>
      </Field>
      {reason === 'Other' && <Field label="Details"><Input value={other} onChange={(e) => setOther(e.target.value)} autoFocus /></Field>}
      <Checkbox checked={sendEmail && Boolean(data.candidate.email)} disabled={!data.candidate.email} onChange={(e) => setSendEmail(e.target.checked)} label="Send the “Not moving forward” email"
        hint={data.candidate.email ? 'Uses the template in Settings. Reasons are never shared with the candidate.' : 'There is no email address on file for this candidate.'} />
      {sendEmail && <MailNote />}
      {sendEmail && <ConfidentialNote data={data} />}
    </Modal>
  );
}

/** Schedule an interview, or change one that is already booked when `interview` is passed (its time, length, format, place, notes and interviewers). */
export function ScheduleModal({ data, interview, onClose }) {
  const { bump, user } = useApp();
  const toast = useToast();
  const stage = data.stages.find((s) => s.id === data.application.stage_id);
  const tomorrow = new Date(Date.now() + 86400000);
  tomorrow.setHours(10, 0, 0, 0);
  const [form, setForm, bind] = useForm(interview
    ? { title: interview.title, kind: interview.kind, starts_at: toLocalInput(new Date(interview.starts_at)), duration_min: interview.duration_min, location: interview.location || '', notes: interview.notes || '' }
    : { title: stage?.kind === 'interview' ? stage.name : 'Interview', kind: 'video', starts_at: toLocalInput(tomorrow), duration_min: 45, location: '', notes: '' });
  const [panel, setPanel] = useState(interview ? (interview.panel || []).map((p) => p.id) : [user.id]);
  const [notify, setNotify] = useState(false);
  const { data: people } = useApi(url('/users', { client_id: data.client.id }));
  const toggle = (id) => setPanel((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const [save, busy] = useAction(async () => {
    const starts = new Date(form.starts_at);
    const details = { ...form, starts_at: starts.toISOString(), panel, notify, time_label: `${fmtDateTime(starts)} (${Intl.DateTimeFormat().resolvedOptions().timeZone})` };
    const answer = interview ? await api.patch(`/interviews/${interview.id}`, details) : await api.post('/interviews', { ...details, application_id: data.application.id });
    toast(interview ? 'Interview updated' : 'Interview scheduled');
    if (answer.notice) toast(answer.notice, 'error'); // the invitation was held back
    bump();
    onClose();
  });
  return (
    <Modal title={interview ? 'Edit interview' : 'Schedule interview'} subtitle={`${data.candidate.name} · ${data.job.title}`} onClose={onClose} onSubmit={save}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>{interview ? 'Save changes' : 'Schedule'}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Interview" className="sm:col-span-2"><Input {...bind('title')} required /></Field>
        <Field label="Date and time" hint={`Your time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`}><Input type="datetime-local" {...bind('starts_at')} required /></Field>
        <Field label="Length">
          {/* An interview booked with a length that is not on the list keeps it. */}
          <Select {...bind('duration_min')}>{[...new Set([15, 30, 45, 60, 90, 120, Number(form.duration_min)])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{m} minutes</option>)}</Select>
        </Field>
        <Field label="Format">
          <Select {...bind('kind')}>{Object.entries(INTERVIEW_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        </Field>
        <Field label="Location or link"><Input {...bind('location')} placeholder="Meeting link, address or phone number" /></Field>
      </div>
      <div>
        <div className="mb-1.5 text-[13px] font-medium text-stone-700">Interviewers</div>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {(people || []).map((p) => (
            <label key={p.id} className={cx('flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-sm', panel.includes(p.id) ? 'border-brand-400 bg-brand-50' : 'border-line bg-white')}>
              <input type="checkbox" checked={panel.includes(p.id)} onChange={() => toggle(p.id)} className="size-4 accent-brand-700" />
              <Avatar name={p.name} size={24} />
              <span className="min-w-0">
                <span className="block truncate font-medium text-stone-800">{p.name}</span>
                <span className="block truncate text-xs text-stone-500">{p.role === 'client' ? p.title || p.client_name : 'Agency'}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-stone-500">Each interviewer is asked for a scorecard once the interview has taken place.</p>
      </div>
      <Field label="Notes for the panel"><Textarea rows={2} {...bind('notes')} placeholder="What to focus on, what has already been covered" /></Field>
      <Checkbox checked={notify && Boolean(data.candidate.email)} disabled={!data.candidate.email} onChange={(e) => setNotify(e.target.checked)} label={interview ? 'Email the updated invitation to the candidate' : 'Email the invitation to the candidate'}
        hint={data.candidate.email ? 'Uses the “Interview invitation” template with this time, format and location.' : 'There is no email address on file for this candidate.'} />
      {notify && <MailNote />}
      {notify && <ConfidentialNote data={data} />}
    </Modal>
  );
}

export function ScorecardModal({ interview, criteria, candidateName, onClose }) {
  const { bump, user } = useApp();
  const toast = useToast();
  const mine = interview.scorecards?.find((s) => s.user_id === user.id);
  const [rec, setRec] = useState(mine?.recommendation || '');
  const [ratings, setRatings] = useState(mine?.ratings || {});
  const [notes, setNotes] = useState(mine?.notes || '');
  const [save, busy] = useAction(async () => {
    await api.post(`/interviews/${interview.id}/scorecard`, { recommendation: rec, ratings, notes });
    toast('Scorecard submitted');
    bump();
    onClose();
  });
  const SCALE = ['Weak', 'Mixed', 'Good', 'Excellent'];
  return (
    <Modal title="Interview scorecard" subtitle={`${candidateName} · ${interview.title}`} onClose={onClose} onSubmit={save}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy} disabled={!rec}>Submit scorecard</Button></>}>
      <div className="space-y-3">
        {criteria.map((c) => (
          <div key={c} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-stone-800">{c}</span>
            <div className="flex gap-1" role="radiogroup" aria-label={c}>
              {SCALE.map((label, i) => (
                <button key={label} type="button" role="radio" aria-checked={ratings[c] === i + 1} onClick={() => setRatings((r) => ({ ...r, [c]: r[c] === i + 1 ? undefined : i + 1 }))}
                  className={cx('h-8 rounded-md border px-2.5 text-xs font-medium', ratings[c] === i + 1 ? 'border-brand-700 bg-brand-700 text-white' : 'border-line bg-white text-stone-600 hover:bg-stone-50')}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <Field label="Evidence and notes" hint="What did you see or hear that supports your view?"><Textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <div>
        <div className="mb-1.5 text-[13px] font-medium text-stone-700">Overall recommendation</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Overall recommendation">
          {Object.entries(RECOMMENDATIONS).map(([key, r]) => (
            <button key={key} type="button" role="radio" aria-checked={rec === key} onClick={() => setRec(key)}
              className={cx('h-10 rounded-lg border text-sm font-medium', rec === key ? (r.tone === 'green' ? 'border-brand-700 bg-brand-700 text-white' : 'border-red-700 bg-red-700 text-white') : 'border-line bg-white text-stone-700 hover:bg-stone-50')}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export function EmailModal({ data, onClose }) {
  const { bump, user } = useApp();
  const toast = useToast();
  const { data: templates } = useApi('/templates');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  // Somebody who applied through the confidential post and has not been told who the client is: templates are
  // filled in with the title they applied under and "our client", the way the automatic e-mails are.
  const dark = inTheDark(data);
  // Someone who is not on a job has no job title or company to fill in: those merge fields are left as they are in a
  // template, and the message cannot be sent until the recruiter has replaced them (see `unfilled`).
  const vars = { candidate_first_name: firstName(data.candidate.name), candidate_name: data.candidate.name, job_title: dark ? data.board.title : data.job?.title,
    company: dark ? 'our client' : data.client?.name, sender_name: user.name };
  const [applied, setApplied] = useState(null); // the text a template put in, to tell "this template" from "this message"
  const fill = (text) => (dark ? ourClientWording(renderTemplate(text, vars)) : renderTemplate(text, vars));
  const apply = (id) => {
    const t = templates?.find((x) => String(x.id) === id);
    if (!t) return;
    setSubject(fill(t.subject));
    setBody(fill(t.body));
    setApplied(`${fill(t.subject)}\n${fill(t.body)}`);
  };
  // Asked a moment after the recruiter stops typing: does this message name the client? The server asks itself again when it is sent.
  const [names, setNames] = useState(false);
  const message = `${subject}\n${body}`;
  useEffect(() => {
    if (!dark) return undefined;
    let live = true;
    const timer = setTimeout(async () => {
      try { const answer = await api.post(`/applications/${data.application.id}/emails/check`, { subject, body }); if (live) setNames(answer.names_client); } catch { /* the server checks again on sending */ }
    }, 350);
    return () => { live = false; clearTimeout(timer); };
  }, [message, dark]);
  const unfilled = message.match(/\{\{\s*\w+\s*\}\}/g);
  const [send, busy] = useAction(async () => {
    let result;
    try {
      result = await api.post(`/applications/${data.application.id}/emails`, { subject, body, names_client_ok: names });
    } catch (err) {
      if (err.data?.code === 'names_client') setNames(true); // typed and sent before the warning could show: it shows now, and nothing was sent
      throw err;
    }
    toast(result.delivery === 'sent' ? 'Email sent' : result.delivery === 'failed' ? 'Saved, but delivery failed' : 'Saved to the record (delivery not connected)', result.delivery === 'failed' ? 'error' : 'ok');
    bump();
    onClose();
  });
  return (
    <Modal title={`Email ${data.candidate.name}`} subtitle={data.candidate.email || 'No email address on file'} onClose={onClose} onSubmit={send}
      footer={<>
        {dark && names && (
          <p role="alert" className="flex basis-full items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] text-amber-950">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>This candidate applied through your confidential post. This {applied === message ? 'template' : 'message'} names {data.client.name}. Send it only if you mean to tell them who the client is.</span>
          </p>
        )}
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" busy={busy} disabled={Boolean(unfilled) || !data.candidate.email}>{dark && names ? 'Send anyway' : 'Send email'}</Button>
      </>}>
      {!data.candidate.email && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">Add an email address for this candidate first (More actions, Edit details).</p>}
      <MailNote />
      {dark && (
        <p className="rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-950">
          {firstName(data.candidate.name)} applied through your confidential post (“{data.board.title}”) and has not been told who the client is. Templates say “our client” in place of {data.client.name}. Once they know, tick “Knows who the client is” on their profile.
        </p>
      )}
      <Field label="Start from a template">
        <Select defaultValue="" onChange={(e) => apply(e.target.value)}>
          <option value="">Blank message</option>
          {/* The interview invitation is sent from the Schedule dialog, where the time and place are known. The
              confirmation for the agency's own job board goes out by itself when somebody applies there. */}
          {(templates || []).filter((t) => t.key !== 'interview_invite' && t.key !== 'board_application_received').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      </Field>
      <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} required /></Field>
      <Field label="Message"><Textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} required /></Field>
      {unfilled && <p className="text-xs text-red-700">Replace {[...new Set(unfilled)].join(', ')} before sending.</p>}
    </Modal>
  );
}

/** `initialNote` starts the write-up from a draft (Otterview's, written from a call) instead of the last one sent. */
export function SubmitModal({ data, onClose, initialNote, onSubmitted }) {
  const { bump } = useApp();
  const toast = useToast();
  const [note, setNote] = useState(initialNote ?? data.application.submission_note ?? '');
  const [save, busy] = useAction(async () => {
    await api.post(`/applications/${data.application.id}/submit`, { note });
    onSubmitted?.(note.trim()); // whoever opened this with a draft learns what was actually sent
    toast(`Submitted to the ${data.client.name} hiring team`);
    bump();
    onClose();
  });
  return (
    <Modal title="Submit to the hiring team" subtitle={`${data.candidate.name} · ${data.job.title} at ${data.client.name}`} onClose={onClose} onSubmit={save}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Submit for review</Button></>}>
      <Field label="Your write-up" hint="The hiring team sees this alongside the profile and résumé, then approves or declines. Approval moves the candidate to the next interview stage.">
        <Textarea rows={8} value={note} onChange={(e) => setNote(e.target.value)} required autoFocus
          placeholder={'Why this person, in a few lines:\n• Relevant experience and standout achievements\n• Motivation for the move\n• Salary expectations and notice period\n• Anything to probe at interview'} />
      </Field>
    </Modal>
  );
}

export function ReviewModal({ data, decision, onClose }) {
  const { bump } = useApp();
  const toast = useToast();
  const approve = decision === 'approved';
  const [note, setNote] = useState('');
  const [save, busy] = useAction(async () => {
    await api.post(`/applications/${data.application.id}/review`, { decision, note });
    toast(approve ? 'Approved for interview' : 'Declined');
    bump();
    onClose();
  });
  return (
    <Modal title={approve ? `Approve ${data.candidate.name} for interview` : `Decline ${data.candidate.name}`} size="sm" onClose={onClose} onSubmit={save}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant={approve ? 'primary' : 'dangerSolid'} busy={busy}>{approve ? 'Approve' : 'Decline'}</Button></>}>
      <Field label={approve ? 'Comment (optional)' : 'What is missing?'} hint={approve ? 'They move to the next interview stage.' : 'This helps the recruiter calibrate who to put forward next.'}>
        <Textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} required={!approve} autoFocus />
      </Field>
    </Modal>
  );
}

export function OfferModal({ data, onClose }) {
  const { bump } = useApp();
  const toast = useToast();
  const [form, , bind] = useForm({ salary: data.offer?.salary ?? '', start_date: data.offer?.start_date ?? '', status: data.offer?.status ?? 'draft', notes: data.offer?.notes ?? '' });
  const [save, busy] = useAction(async () => {
    await api.put(`/applications/${data.application.id}/offer`, form);
    toast('Offer saved');
    bump();
    onClose();
  });
  return (
    <Modal title="Offer" subtitle={`${data.candidate.name} · ${data.job.title}`} size="sm" onClose={onClose} onSubmit={save}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Save offer</Button></>}>
      <div className="grid grid-cols-2 gap-4">
        <Field label={`Base salary (${data.client.currency})`}><Input type="number" min="0" step="500" {...bind('salary')} /></Field>
        <Field label="Start date"><Input type="date" {...bind('start_date')} /></Field>
      </div>
      <Field label="Status">
        <Select {...bind('status')}>
          <option value="draft">Draft, not yet sent</option>
          <option value="sent">Sent to candidate</option>
          <option value="accepted">Accepted</option>
          <option value="declined">Declined</option>
        </Select>
      </Field>
      <Field label="Notes"><Textarea rows={3} {...bind('notes')} placeholder="Bonus, equity, conditions, negotiation history" /></Field>
      {form.status === 'accepted' && <p className="text-xs text-stone-500">Once the paperwork is signed, move the candidate to Hired to close the loop.</p>}
    </Modal>
  );
}

/** Correct the fee recorded for a placement: the figure Reports counts. It starts from what is recorded, or from what the offer works out to at the fee percentage recorded when they were hired. */
export function PlacementFeeModal({ data, onClose }) {
  const { bump } = useApp();
  const toast = useToast();
  const { placement, offer, client } = data;
  const percent = placement.fee_percent ?? client.fee_percent;
  const workedOut = offer?.salary != null && percent > 0 ? Math.round((offer.salary * percent) / 100) : '';
  const [fee, setFee] = useState(placement.fee ?? workedOut);
  const [save, busy] = useAction(async () => {
    await api.put(`/applications/${data.application.id}/placement-fee`, { fee });
    toast('Placement fee saved');
    bump();
    onClose();
  });
  return (
    <Modal title="Placement fee" subtitle={`${data.candidate.name} · ${data.job.title}`} size="sm" onClose={onClose} onSubmit={save}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Save fee</Button></>}>
      <Field label={`Placement fee (${placement.currency})`} hint="What you billed for this placement. Reports counts this figure, whatever the offer or the client’s terms say later. Leave it empty if there is no fee for this placement.">
        <Input type="number" min="0" step="1" value={fee} onChange={(e) => setFee(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

const CANDIDATE_FIELDS = [['name', 'Full name', 'text', true], ['email', 'Email', 'email'], ['phone', 'Phone'], ['linkedin', 'LinkedIn URL'], ['current_title', 'Current title'], ['current_company', 'Current company'], ['location', 'Location']];

export function EditCandidateModal({ data, onClose }) {
  const { bump } = useApp();
  const toast = useToast();
  const [form, , bind] = useForm({ ...data.candidate });
  const [save, busy] = useAction(async () => {
    await api.patch(`/applications/${data.application.id}`, { candidate: form });
    bump();
    onClose();
  });
  // The photo saves as soon as it is chosen or removed; it is separate from the fields below.
  const [setPhoto, working] = useAction(async (file) => {
    if (file) {
      const fd = new FormData();
      fd.append('photo', await squarePhoto(file), 'photo.jpg');
      await api.put(`/candidates/${data.candidate.id}/photo`, fd);
      toast('Photo saved');
    } else {
      await api.del(`/candidates/${data.candidate.id}/photo`);
      toast('Photo removed');
    }
    bump();
  });
  return (
    <Modal title="Edit candidate details" onClose={onClose} onSubmit={save}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Save</Button></>}>
      <div className="flex items-center gap-4">
        <Avatar name={data.candidate.name} size={64} src={photoUrl(data.candidate.id, data.candidate.photo)} />
        <div className="flex flex-wrap items-center gap-2">
          <label className={cx('inline-flex h-8 cursor-pointer items-center rounded-lg border border-line bg-white px-2.5 text-[13px] font-medium text-stone-800 shadow-sm hover:bg-stone-50', working && 'pointer-events-none opacity-50')}>
            {data.candidate.photo ? 'Change photo' : 'Add a photo'}
            <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Photo" onChange={(e) => { setPhoto(e.target.files[0]); e.target.value = ''; }} />
          </label>
          {data.candidate.photo && <Button size="sm" variant="ghost" busy={working} onClick={() => setPhoto(null)}>Remove</Button>}
          <span className="basis-full text-xs text-stone-500">JPEG, PNG or WebP. Photos added with the browser extension appear here too.</span>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {CANDIDATE_FIELDS.map(([key, label, type = 'text', required]) => <Field key={key} label={label}><Input type={type} required={required} {...bind(key)} /></Field>)}
      </div>
    </Modal>
  );
}

/** The details a résumé dropped on a profile can fill in, in the order the dialog lists them. The name is never one. */
const RESUME_DETAILS = [['email', 'Email'], ['phone', 'Phone'], ['location', 'Location'], ['current_title', 'Current title'], ['current_company', 'Company'], ['linkedin', 'LinkedIn link']];
/** A detail reduced to what makes it that detail, so "(416) 555-0188" and "416 555 0188" count as the same number. */
function sameDetail(key, a, b) {
  const plain = (v) => String(v || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  if (key === 'phone') {
    const digits = (v) => String(v || '').replace(/\D+/g, '');
    const [x, y] = [digits(a), digits(b)];
    // The same number with or without the country code in front ("+1 416 555 0188" and "416 555 0188"). A number
    // with its area code is not the same as one without: that is a fuller number, worth offering.
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    return Boolean(x) && (x === y || (short.length >= 10 && long.length - short.length <= 3 && long.endsWith(short)));
  }
  if (key === 'linkedin') {
    const link = (v) => plain(v).replace(/^https?:\/\//, '').replace(/^([a-z]{2,3}\.)?(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    return link(a) === link(b);
  }
  return plain(a) === plain(b);
}

/**
 * A résumé dropped on a candidate's profile, or chosen there. It is read in the browser, and what it says is set
 * beside what the profile has: a detail the profile has no value for is ticked to be filled in, one it has a different
 * value for is only changed if ticked, and one that is the same is not mentioned. The name is never changed; a
 * résumé with somebody else's name on it says so before anything is attached, with nothing ticked. One click attaches
 * the file and saves the ticked details together (PUT /applications/:id/resume). Agency only. `more` says that other
 * files were dropped with this one and left out.
 */
export function AttachResumeModal({ data, file, more = false, again = false, onClose, onAttached }) {
  const { bump } = useApp();
  const toast = useToast();
  // A toast left from the résumé attached a moment ago would sit over this dialog's buttons on a phone.
  const clearToasts = useClearToasts();
  useEffect(() => { clearToasts(); }, []);
  const { application: app, candidate, client } = data;
  const first = firstName(candidate.name);
  const [read, setRead] = useState(null); // what readResume found: { fields, status, nameFromFile, roleCurrent, companyCurrent }
  const [rows, setRows] = useState([]);   // [{ key, label, current, value, ticked }], one for each detail worth asking about
  const [problem, setProblem] = useState(null); // why the workspace would not save it
  const problemBox = useRef(null);
  useEffect(() => { problemBox.current?.scrollIntoView({ block: 'nearest' }); }, [problem]);
  const [sameFile, setSameFile] = useState(false); // the file is the résumé already on file, which is then kept once
  // Whether the file has been compared with the résumé on file (or the comparison failed). Until then the dialog does
  // not say what happens to the one on file, and nothing can be attached.
  const [compared, setCompared] = useState(!app.resume_file);
  useEffect(() => {
    let live = true;
    readResumeFile(file).then((result) => {
      if (!live) return;
      const found = result.fields || {};
      // Somebody else's résumé: nothing from it is ticked until the recruiter has looked.
      const theirs = !found.name || sameName(found.name, candidate.name);
      // A title is only ticked when the résumé shows that job running to the present ("2021 – Present"), and a company
      // only when it also stands with that title where it plainly belongs to it. Otherwise they may not be the job
      // they have now: offered, not ticked.
      const unsure = (key) => (key === 'current_title' ? !result.roleCurrent : key === 'current_company' ? !result.companyCurrent : false);
      setRead(result);
      setRows(RESUME_DETAILS.map(([key, label]) => ({ key, label, current: String(candidate[key] || '').trim(), value: String(found[key] || '').trim() }))
        .filter((r) => r.value && !sameDetail(r.key, r.current, r.value))
        .map((r) => ({ ...r, unsure: unsure(r.key), ticked: theirs && !r.current && !unsure(r.key) })));
    });
    if (app.resume_file) {
      setCompared(false);
      Promise.all([fetch(`/api/applications/${app.id}/resume`).then((r) => (r.ok ? r.arrayBuffer() : null)), file.arrayBuffer()])
        .then(([onFile, chosen]) => {
          if (!live || !onFile || onFile.byteLength !== chosen.byteLength) return;
          const [x, y] = [new Uint8Array(onFile), new Uint8Array(chosen)];
          setSameFile(x.every((byte, i) => byte === y[i]));
        })
        .catch(() => {}) // not known: the dialog says what happens to a different file
        .finally(() => { if (live) setCompared(true); });
    }
    return () => { live = false; };
  }, [file]);
  const change = (key, values) => { setProblem(null); setRows((all) => all.map((r) => (r.key === key ? { ...r, ...values } : r))); };
  const chosen = rows.filter((r) => r.ticked && r.value.trim() && !sameDetail(r.key, r.current, r.value));
  const otherName = read?.fields?.name && !sameName(read.fields.name, candidate.name) ? read.fields.name : null;
  const unread = read && RESUME_UNREAD[read.status];
  const replacing = Boolean(app.resume_file);

  const [save, busy] = useAction(async () => {
    setProblem(null);
    // While it is being sent the dialog stays open (Cancel, Escape and the cross wait), so what happens is always said.
    const fd = new FormData();
    fd.append('resume', file);
    for (const r of chosen) fd.append(r.key, r.value.trim());
    let answer;
    try {
      answer = await api.put(`/applications/${app.id}/resume`, fd);
    } catch (err) {
      // Said in the dialog, which stays open: nothing was saved. No answer at all means the server was not reached.
      setProblem(err.status ? `${err.message}${/[.!?]$/.test(err.message) ? '' : '.'}` : 'The Book could not be reached.');
      return;
    }
    const n = answer.filled.length;
    const details = n ? `${n === 1 ? 'one detail' : `${n} details`} filled in` : '';
    toast(answer.resume === 'unchanged' ? `That résumé was already on file${n ? `; ${details}` : ''}`
      : answer.resume === 'replaced' ? `Résumé replaced${n ? ` and ${details}` : ''}. The earlier one is kept under Earlier résumés`
      : `Résumé attached${n ? ` and ${details}` : ''}`);
    bump();
    onClose();
    onAttached?.(answer);
  });
  const label = `${otherName ? 'Attach anyway' : 'Attach'}${chosen.length ? ` and fill in ${chosen.length === 1 ? '1 detail' : `${chosen.length} details`}` : otherName ? '' : ' résumé'}`;
  const close = busy ? () => {} : onClose;
  return (
    <Modal title={replacing && compared && !sameFile ? 'Replace the résumé' : 'Attach a résumé'} onClose={close} onSubmit={save}
      subtitle={<>{candidate.name} · {file.name}{more && <span className="mt-1 block text-[13px] text-stone-600" role="status">One résumé at a time: {file.name} was taken.</span>}
        {again && <span className="mt-1 block text-[13px] text-stone-600" role="status">One résumé at a time. Cancel this one first to attach another.</span>}</>}
      footer={<><Button onClick={close} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" busy={busy} disabled={!read || !compared}>{busy ? 'Attaching…' : label}</Button></>}>
      {!read ? (
        <p className="flex items-center gap-2 text-sm text-stone-600" role="status"><LoaderCircle className="size-4 animate-spin" />Reading the résumé…</p>
      ) : (
        <>
          {otherName && (
            <p role="alert" className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] text-amber-950">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="font-medium">This résumé looks like it belongs to {otherName}.</span>
                {read.nameFromFile ? ' (That is the name in its file name.)' : ''} Check that it is {first}’s before attaching it. Nothing from it is ticked, and the name on the profile stays as it is.
              </span>
            </p>
          )}
          {read.status === 'updated' && <UpdateNotice>The résumé can still be attached as it is, with nothing filled in.</UpdateNotice>}
          {unread && read.status !== 'updated' && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-950">{unread} It can still be attached, with nothing filled in from it.</p>
          )}
          {rows.length > 0 ? (
            <div>
              <p className="text-[13px] font-medium text-stone-700">Found in the résumé</p>
              <p className="text-xs text-stone-500">Ticked details are saved on {first}’s profile. Correct any of them here first.</p>
              <ul className="mt-2 space-y-2">
                {rows.map((r) => (
                  <li key={r.key} className={cx('rounded-lg border px-3 py-2.5', r.ticked ? 'border-brand-300 bg-brand-50/40' : 'border-line bg-white')}>
                    <label className="flex items-start gap-2.5 text-sm text-stone-800">
                      <input type="checkbox" checked={r.ticked} onChange={(e) => change(r.key, { ticked: e.target.checked })} className="mt-0.5 size-4 shrink-0 accent-brand-700" />
                      <span className="min-w-0">
                        <span className="font-medium">{r.label}</span>
                        <span className="block text-[13px] break-words text-stone-600">
                          {r.current ? <>{r.current} on the profile, {r.value} in the résumé</> : 'Not on the profile yet'}
                        </span>
                        {r.unsure && <span className="block text-xs text-amber-800">Check this is their current job.</span>}
                      </span>
                    </label>
                    <Input className="mt-2" value={r.value} aria-label={`${r.label} from the résumé`} onChange={(e) => change(r.key, { value: e.target.value, ticked: true })} />
                  </li>
                ))}
              </ul>
            </div>
          ) : !unread && (
            <p className="rounded-lg border border-line bg-stone-50 px-3 py-2 text-[13px] text-stone-600">
              {RESUME_DETAILS.some(([key]) => read.fields?.[key]) ? `Everything it has is on ${first}’s profile already.` : 'No contact details were recognised in it, so nothing will be filled in.'}
            </p>
          )}
          <p className="text-xs text-stone-500">
            {!compared ? 'Checking this against the résumé on file… '
              : sameFile ? 'This is the résumé already on file, so it is kept once. '
              : replacing ? `The résumé on file now (${app.resume_name || 'résumé'}) is kept under Earlier résumés, which only your agency sees. ` : ''}
            {client ? `The ${client.name} hiring team sees the résumé on the profile, as they would one added with the candidate.` : 'Only your agency sees people who are not on a job.'}
          </p>
          {problem && <p role="alert" ref={problemBox} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{problem} Nothing was saved.</p>}
        </>
      )}
    </Modal>
  );
}

// ---------- résumé files: what the Add candidate dialog and a candidate's profile share ----------

/** The kinds of file a résumé can be (the server accepts the same, see ALLOWED_RESUME in server/api.js). */
export const RESUME_ACCEPT = '.pdf,.doc,.docx,.rtf,.txt';
const MAX_RESUME = 8 * 1024 * 1024;
/**
 * Why this file cannot be taken as a résumé, said before it is sent and refused; nothing when it can. `instead` ends
 * the sentence about a file that is too large ("add the candidate without a résumé").
 */
export function resumeRefusal(file, instead) {
  if (!/\.(pdf|docx?|rtf|txt)$/i.test(file.name)) return 'Résumés need to be PDF, Word, RTF or text files.';
  if (file.size > MAX_RESUME) return `That file is larger than 8 MB, so it was not attached. Choose a smaller copy${instead ? `, or ${instead}` : ''}.`;
  return null;
}
/**
 * The résumé among the files dropped at once: the first one of a kind a résumé can be, else the first file (which
 * is then refused with the usual sentence). `more` says that other files were left out.
 */
export function pickResume(files) {
  const all = Array.from(files || []);
  const file = all.find((f) => !resumeRefusal(f)) || all.find((f) => /\.(pdf|docx?|rtf|txt)$/i.test(f.name)) || all[0] || null;
  return { file, more: all.length > 1 };
}
/** Whether something being dragged over the page is a file (and not text or a card being moved). */
export const carriesFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
/**
 * Read a résumé in the browser (see readResume in src/resume.js): { fields, status, nameFromFile }. Never throws.
 * The status is 'updated' when the reader could not be loaded because the app was updated since the page was opened.
 */
export async function readResumeFile(file) {
  const updated = watchForUpdate();
  let result = { fields: {}, status: 'error' };
  try {
    const { readResume } = await import('../resume.js');
    result = await readResume(file);
    if (result.status === 'error' && updated()) result = { ...result, status: 'updated' };
  } catch (err) {
    console.warn('The résumé could not be read automatically:', err);
    if (updated(err)) result.status = 'updated';
  }
  return result;
}
/** Why nothing could be taken from a résumé, for each reading that means so. */
export const RESUME_UNREAD = {
  no_text: 'This file has no selectable text (it is a scan or an image saved as a PDF), so it could not be read.',
  blank: 'No text was found in this file.',
  empty: 'This file is empty.',
  binary: 'This file is not text (it may be another kind of file saved under this name), so it could not be read.',
  unreadable: 'This type of file cannot be read automatically. PDF and .docx files can.',
  protected: 'This PDF is password-protected, so it could not be read.',
  error: 'This file could not be opened for reading.',
  updated: 'It could not be read this time.',
};
/** While mounted, a file dropped beside a drop zone is not opened by the browser, in place of or next to the app. */
export function useNoStrayDrops() {
  useEffect(() => {
    const ignore = (e) => {
      if (e.defaultPrevented || !carriesFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', ignore);
    window.addEventListener('drop', ignore);
    return () => {
      window.removeEventListener('dragover', ignore);
      window.removeEventListener('drop', ignore);
    };
  }, []);
}

/** What to tell the recruiter after a résumé was dropped in: what was filled, or exactly why it could not be. */
function resumeNote({ labels, status, nameFromFile }) {
  const fromName = nameFromFile ? ' The name was taken from the file name.' : '';
  const why = RESUME_UNREAD[status];
  if (why) return `Attached. ${why}${fromName} Fill in the ${nameFromFile ? 'rest' : 'details'} below.`;
  if (!labels.length) return 'Attached. No contact details were recognised in it, so fill in the details below.';
  return `Filled in ${labels.join(', ')} from the résumé.${fromName} Please check them.`;
}

/**
 * Put someone on a job from their profile. For a person saved to The Book without a job, their entry becomes that
 * job's application, so their notes, résumé, calls and history stay in one place; any open job of any client can be
 * chosen. For a person who is already on a job, this adds them to another job of the same client.
 */
export function AddToJobModal({ data, onClose }) {
  const { bump } = useApp();
  const toast = useToast();
  const open = useOpenCandidate();
  const navigate = useNavigate();
  const { application: app, candidate, job: current, client } = data;
  const another = Boolean(current);
  const { data: jobs, error } = useApi(url('/jobs', { client_id: client?.id }));
  // Jobs they are already in are not offered: this one, and any other they are being considered for.
  const inAlready = new Set([current?.id, ...data.others.map((o) => o.job_id)]);
  const choices = (jobs || []).filter((j) => j.status !== 'closed' && !inAlready.has(j.id));
  const byClient = [];
  for (const j of choices) {
    let group = byClient.find((g) => g.client === j.client_name);
    if (!group) byClient.push(group = { client: j.client_name, jobs: [] });
    group.jobs.push(j);
  }
  const [jobId, setJobId] = useState('');
  const [stageId, setStageId] = useState(''); // empty means the job's first stage, which is the one the list opens on
  const { data: jobData } = useApi(jobId ? `/jobs/${jobId}` : null);
  // Why the workspace would not do it, when that is something the recruiter can act on here:
  // { code: 'already_in_job', message, id, join } or { code: 'duplicate_in_client', message, people }.
  const [refusal, setRefusal] = useState(null);
  const refusalBox = useRef(null);
  useEffect(() => { refusalBox.current?.scrollIntoView({ block: 'nearest' }); }, [refusal]);
  const chooseJob = (value) => { setJobId(value); setStageId(''); setRefusal(null); };
  const chosen = choices.find((j) => j.id === Number(jobId));
  const first = firstName(candidate.name);

  // `into` is the record to add them to, once the recruiter has been shown that this client already has one for them.
  const [save, busy] = useAction(async (into) => {
    // Joining an entry to the record that is already in this job, as opposed to adding anyone to the job.
    const joining = Boolean(into) && refusal?.code === 'already_in_job';
    setRefusal(null);
    let result;
    try {
      result = await api.post(`/applications/${app.id}/add-to-job`, { job_id: Number(jobId), stage_id: stageId ? Number(stageId) : undefined, into });
    } catch (err) {
      const code = err.status === 409 ? err.data?.code : null;
      // `join` names the client's record that is in the job, when this is an entry in The Book that can be joined to it.
      if (code === 'already_in_job') return setRefusal({ code, message: err.message, id: err.data.id, join: another ? null : err.data.join });
      if (code === 'duplicate_in_client') {
        // One line for each person, however many of that client's jobs they are in.
        const people = (err.data.matches || []).filter((m, i, all) => all.findIndex((x) => x.candidate_id === m.candidate_id) === i);
        return setRefusal({ code, message: err.message, people });
      }
      throw err;
    }
    toast(joining ? `Joined to ${first}’s application for ${chosen?.title || 'that job'}`
      : result.merged ? `Added to ${chosen?.title || 'the job'} on their existing record` : `${first} added to ${chosen?.title || 'the job'}`);
    bump();
    onClose();
    // Someone who had no job keeps the same profile, wherever it was opened from. A new application in another job
    // is opened in that job, not over the page of the job they were being looked at in.
    if (another) navigate(profilePath(Number(jobId), result.id));
    else open(result.id);
  });

  const option = (j) => <option key={j.id} value={j.id}>{j.title}{j.status === 'open' ? '' : ` (${JOB_STATUS[j.status]?.label.toLowerCase() || j.status})`}</option>;
  return (
    <Modal title={another ? 'Add to another job' : 'Add to a job'} subtitle={another ? `${candidate.name} · ${client.name}` : candidate.name} size="sm" onClose={onClose} onSubmit={() => save()}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy} disabled={!jobId || Boolean(refusal)}>Add to job</Button></>}>
      {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">The jobs could not be loaded. {error}</p>
        : jobs && !choices.length ? (
          <p className="rounded-lg border border-line bg-stone-50 px-3 py-2.5 text-sm text-stone-600">
            {another ? `${client.name} has no other open job to add ${first} to.` : <>There are no open jobs yet. <Link to="/jobs" onClick={onClose} className="font-medium text-brand-700 hover:underline">Add a job</Link> first, then come back to add {first} to it.</>}
          </p>
        ) : (
          <>
            {/* Once a job is chosen the list no longer shows which client it is under, so the hint does. */}
            <Field label="Job" hint={chosen && !another ? `At ${chosen.client_name}.` : undefined}>
              <Select value={jobId} onChange={(e) => chooseJob(e.target.value)} required autoFocus disabled={!jobs}>
                <option value="">Choose a job…</option>
                {another ? choices.map(option) : byClient.map((g) => <optgroup key={g.client} label={g.client}>{g.jobs.map(option)}</optgroup>)}
              </Select>
            </Field>
            <Field label="Stage">
              <Select value={stageId} onChange={(e) => { setStageId(e.target.value); setRefusal(null); }} disabled={!jobData}>
                {(jobData?.stages || []).filter((s) => s.kind !== 'hired').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            {!another && !refusal && (
              <p className="text-xs text-stone-500">Everything on {first}’s profile comes with them: notes, résumé, calls and history. The client’s hiring team sees their details, photo and résumé, and none of the notes, emails or history from before now.</p>
            )}
          </>
        )}
      {refusal?.code === 'already_in_job' && (
        <div role="alert" ref={refusalBox} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="min-w-0 flex-1 basis-48 font-medium">{refusal.message}</span>
            <span className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => { onClose(); open(refusal.id); }}>Open them in that job</Button>
              {refusal.join && <Button size="sm" variant="primary" busy={busy} onClick={() => save(refusal.join.candidate_id)}>Join this entry to that record</Button>}
            </span>
          </div>
          {refusal.join && (
            <p className="mt-2 text-xs text-amber-900">That is {chosen ? `${chosen.client_name}’s` : 'the client’s'} own record of them. Joining moves everything saved here (notes, résumé, calls and history) onto their application for that job, so there is one record of this person. The hiring team will see what their record was missing and this entry has: contact details, a photo, and the résumé if they had sent none. They do not see the notes, emails, calls or history from The Book.</p>
          )}
        </div>
      )}
      {refusal?.code === 'duplicate_in_client' && (
        <div role="alert" ref={refusalBox} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">
          <p className="font-medium">{refusal.message}</p>
          <ul className="mt-2 space-y-2">
            {refusal.people.map((m) => (
              <li key={m.candidate_id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                <span className="min-w-0 flex-1 basis-40 text-[13px]">
                  {/* In a new tab, so the two records can be compared before anything is joined. A record that is in no job has nothing to open. */}
                  {m.application_id
                    ? <a href={`/candidates?c=${m.application_id}`} target="_blank" rel="noopener noreferrer" className="font-medium underline">{m.name}</a>
                    : <span className="font-medium">{m.name}</span>}
                  {m.job_title ? `, in ${m.job_title}${m.stage_name ? ` (${m.stage_name})` : ''}` : m.application_id ? '' : ', not in any job at the moment'}
                </span>
                <Button size="sm" variant="primary" busy={busy} onClick={() => save(m.candidate_id)}>Add to their existing record</Button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-amber-900">Adding to the existing record moves everything saved here onto it (notes, résumé, photo, calls and history), so there is one record for this person at that client. The hiring team sees their details and résumé, including contact details and a photo that record was missing, and none of the notes, emails or history from before now.</p>
        </div>
      )}
    </Modal>
  );
}

const NO_JOB_YET = 'none'; // the Job choice that saves someone to The Book without a job

/**
 * Add a sourced or referred candidate: straight into a job's pipeline, or to The Book with no job yet when the
 * dialog is not opened from a job. Dropping a résumé in fills the form from it. `initialFile` is a résumé dropped on
 * the page before the dialog was open, taken as if it had been dropped in here.
 */
export function AddCandidateModal({ jobId, onClose, onAdded, initialFile, initialMore = false }) {
  const { bump, scope } = useApp();
  const toast = useToast();
  const { data: jobs } = useApi(jobId ? null : url('/jobs', { client_id: scope }));
  const [form, setForm, bind] = useForm({ job_id: jobId || '', source: 'agency_sourced', stage_id: '' });
  const toBook = form.job_id === NO_JOB_YET;
  const openJobs = (jobs || []).filter((j) => j.status !== 'closed');
  // With no job to choose, The Book is the only place to put someone, so it is chosen for them.
  useEffect(() => { if (jobs && !openJobs.length) setForm((f) => (f.job_id ? f : { ...f, job_id: NO_JOB_YET })); }, [jobs]);
  const [file, setFile] = useState(null);
  const [reading, setReading] = useState(false);
  const [filled, setFilled] = useState(null); // what was taken from the résumé: { labels, status, nameFromFile }
  const [over, setOver] = useState(false);
  const [conflict, setConflict] = useState(null); // the LinkedIn link or email belongs to someone else's record: { message, matches }
  const [onJob, setOnJob] = useState(null);       // "No job yet" was chosen for someone who is already on a client's job: the places they are in
  const { data: jobData } = useApi(form.job_id && !toBook ? `/jobs/${form.job_id}` : null);
  useEffect(() => setForm((f) => ({ ...f, stage_id: '' })), [form.job_id]);
  useEffect(() => setConflict(null), [form.linkedin, form.email]);
  useEffect(() => setOnJob(null), [form.linkedin, form.email, form.name, form.job_id]);
  const conflictBox = useRef(null);
  useEffect(() => { conflictBox.current?.scrollIntoView({ block: 'nearest' }); }, [conflict, onJob]);

  const latest = useRef(form);
  latest.current = form;
  const fromResume = useRef({}); // what the last résumé put into each field, to tell it apart from what was typed
  const reads = useRef(0);

  // A file dropped just beside the dashed box would otherwise be opened by the browser, in place of or next to the app.
  useNoStrayDrops();

  const takeFile = async (picked) => {
    if (!picked) return;
    // Said now, not when the whole form is sent and refused.
    const refusal = resumeRefusal(picked, 'add the candidate without a résumé');
    if (refusal) return toast(refusal, 'error');
    const turn = ++reads.current;
    setFile(picked);
    setFilled(null);
    setReading(true);
    const result = await readResumeFile(picked);
    if (turn !== reads.current) return; // another file was chosen while this one was being read

    // The new file replaces whatever the previous one filled in (and empties what it has no value for),
    // but anything typed or corrected by hand stays as it is.
    const found = result.fields || {};
    const changes = {}, kept = {}, labels = [];
    for (const [key, label] of CANDIDATE_FIELDS) {
      const current = String(latest.current[key] || '').trim();
      if (current && current !== fromResume.current[key]) continue;
      const value = String(found[key] || '').trim();
      if (value) {
        changes[key] = kept[key] = value;
        labels.push(key === 'linkedin' ? 'LinkedIn link' : label.toLowerCase());
      } else if (current) changes[key] = '';
    }
    fromResume.current = kept;
    setForm((f) => ({ ...f, ...changes }));
    setFilled({ labels, status: result.status, nameFromFile: result.nameFromFile && 'name' in kept });
    setReading(false);
  };

  // A résumé dropped on the page that opened this dialog is taken as if it had been dropped in here. Toasts left on
  // that page would sit over this dialog's buttons on a phone, as for the attach dialog.
  const clearToasts = useClearToasts();
  useEffect(() => { if (initialFile) { clearToasts(); takeFile(initialFile); } }, []);

  // Takes the file off the form. What it filled in stays, as typed details would.
  const removeFile = () => {
    reads.current++; // a read still in progress is for a file that is no longer attached
    setFile(null);
    setFilled(null);
    setReading(false);
  };

  const [save, busy] = useAction(async () => {
    setConflict(null);
    setOnJob(null);
    if (toBook) {
      // "Just add to The Book" has nothing to add for somebody who is already on a client's job: a second record of
      // them would only have to be joined up later. The recruiter is shown where they are instead, as the extension does.
      const found = await api.get(url('/candidates/lookup', { linkedin: form.linkedin, email: form.email })).catch(() => []);
      const places = found.filter((r) => r.job_id && sameName(r.name, form.name));
      if (places.length && !found.some((r) => r.general)) return setOnJob(places);
    }
    const fd = new FormData();
    // With no job sent, the person is saved to The Book without one (and so without a stage).
    for (const [k, v] of Object.entries(form)) if (v && !(toBook && (k === 'job_id' || k === 'stage_id'))) fd.append(k, v);
    if (file) fd.append('resume', file);
    let added;
    try {
      added = await api.post('/applications', fd);
    } catch (err) {
      if (err.status !== 409 || err.data?.code !== 'link_conflict') throw err;
      return setConflict({ message: err.message, matches: err.data.matches || [] });
    }
    const who = added.name || form.name;
    // Someone already in The Book without a job is not saved twice. A résumé sent goes onto the entry they have, and
    // one they already had is kept as an earlier résumé. Added to a job, their entry is what goes on the job.
    const resumeNews = { added: ', so the résumé was added to their entry', replaced: '. This résumé is now on their profile, and the one they had is kept under Earlier résumés', unchanged: ', with this same résumé' }[added.resume] ?? '';
    toast(toBook
      ? added.known ? `${who} was already in The Book${resumeNews}` : `${firstName(form.name)} added to The Book`
      : added.moved ? (added.joined ? `Added to ${who}'s existing record, with everything saved on them in The Book` : `${who} was already in The Book, so their entry went on the job with its notes, résumé and calls`)
      : added.known ? `Added to ${who}'s existing record` : `${firstName(form.name)} added to the pipeline`);
    bump();
    onClose();
    onAdded?.(added.id);
  });
  return (
    <Modal title="Add candidate" onClose={onClose} onSubmit={save}
      subtitle={<>For people you have sourced, referrals, or applicants who came in another way.{initialMore && file === initialFile && (
        // Several files were dropped on the page that opened this dialog: said here, where a toast would cover the buttons.
        <span className="mt-1 block text-[13px] text-stone-600" role="status">One résumé at a time: {file.name} was taken.</span>)}</>}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>{toBook ? 'Add to The Book' : 'Add candidate'}</Button></>}>
      <label
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); takeFile(e.dataTransfer.files[0]); }}
        className={cx('flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed px-4 py-3.5 transition-colors', over ? 'border-brand-500 bg-brand-50' : 'border-stone-300 bg-stone-50 hover:border-stone-400')}
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white text-brand-700 ring-1 ring-line">{reading ? <LoaderCircle className="size-5 animate-spin" /> : <FileUp className="size-5" />}</span>
        <span className="min-w-0 flex-1 text-sm">
          <span className="block font-medium text-stone-900">{file ? file.name : 'Drop a résumé here, or click to choose one'}</span>
          <span className="block text-[13px] text-stone-500">
            {reading ? 'Reading the résumé…' : filled ? resumeNote(filled) : 'The details below are filled in from it. PDF, Word, RTF or text, up to 8 MB.'}
          </span>
        </span>
        {file && <button type="button" onClick={(e) => { e.preventDefault(); removeFile(); }} className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-stone-600 hover:bg-stone-200 hover:text-stone-900">Remove</button>}
        <input type="file" accept={RESUME_ACCEPT} className="sr-only" aria-label="Résumé" onChange={(e) => { takeFile(e.target.files[0]); e.target.value = ''; }} />
      </label>
      {filled?.status === 'updated' && <UpdateNotice>Refreshing clears this form. To carry on without refreshing, fill in the details by hand; the file stays attached.</UpdateNotice>}
      <div className="grid gap-4 sm:grid-cols-2">
        {!jobId && (
          <Field label="Job" className="sm:col-span-2" hint={toBook ? 'They are saved without a job or a stage, and only your agency sees them. You can add them to a job from their profile.' : undefined}>
            <Select {...bind('job_id')} required>
              <option value="">Choose a job…</option>
              <option value={NO_JOB_YET}>No job yet: just add to The Book</option>
              {openJobs.map((j) => <option key={j.id} value={j.id}>{j.title} · {j.client_name}</option>)}
            </Select>
          </Field>
        )}
        {CANDIDATE_FIELDS.map(([key, label, type = 'text', required]) => <Field key={key} label={label}><Input type={type} required={required} {...bind(key)} /></Field>)}
        <Field label="Source">
          <Select {...bind('source')}>{Object.entries(SOURCES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        </Field>
        {!toBook && (
          <Field label="Starting stage">
            <Select {...bind('stage_id')} disabled={!jobData}>
              {(jobData?.stages || []).filter((s) => s.kind !== 'hired').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        )}
      </div>
      {onJob ? (
        <div role="alert" ref={conflictBox} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">
          <p className="font-medium">{onJob[0].name} is already in your workspace, so they were not added to The Book as well.</p>
          <ul className="mt-1.5 space-y-1 text-[13px]">
            {onJob.map((m) => (
              <li key={m.application_id}>
                {/* In a new tab, so what has been typed here is not lost. */}
                <a href={profilePath(m.job_id, m.application_id)} target="_blank" rel="noopener noreferrer" className="font-medium underline">Open {m.name}</a>
                <span className="text-amber-900"> · {jobLine(m)}{m.status && m.status !== 'active' ? ` (${m.status})` : m.stage_name ? ` (${m.stage_name})` : ''}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-amber-900">To put them forward for another job, choose that job above.</p>
        </div>
      ) : conflict ? (
        <div role="alert" ref={conflictBox} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900">
          <p className="font-medium">{conflict.message}</p>
          <ul className="mt-1.5 space-y-1 text-[13px]">
            {conflict.matches.map((m) => (
              <li key={m.application_id}>
                {/* In a new tab, so what has been typed here is not lost. */}
                <a href={profilePath(m.job_id, m.application_id)} target="_blank" rel="noopener noreferrer" className="font-medium underline">Open {m.name}</a>
                <span className="text-red-800"> · {jobLine(m)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : <p className="text-xs text-stone-500">An email address or a LinkedIn link is needed, so the same person is recognised if they are added again.</p>}
    </Modal>
  );
}

/**
 * "Delete all data on this person" for somebody who is on file in more than one place. Each client keeps its own
 * record of a person and The Book keeps its own, so erasing one record leaves the others. Every record is named
 * here with a tick box: the ones under the same email address are ticked to begin with, since they are certainly
 * the same person; one that only shares a LinkedIn link is left for the recruiter to tick.
 */
export function EraseModal({ data, elsewhere, metaviewToo, onClose, onDone }) {
  const { bump } = useApp();
  const toast = useToast();
  const { candidate, client } = data;
  const [chosen, setChosen] = useState(() => new Set(elsewhere.filter((r) => r.same_email).map((r) => r.candidate_id)));
  const toggle = (id) => setChosen((was) => { const next = new Set(was); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const left = elsewhere.filter((r) => !chosen.has(r.candidate_id));
  const [erase, busy] = useAction(async () => {
    const also = elsewhere.filter((r) => chosen.has(r.candidate_id)).map((r) => r.candidate_id);
    const result = await api.del(url(`/candidates/${candidate.id}`, { also: also.length ? also.join(',') : undefined }));
    toast(left.length ? `${result.erased === 1 ? 'One record' : `${result.erased} records`} of ${candidate.name} deleted; ${left.length === 1 ? 'one is' : `${left.length} are`} still on file`
      : `All data on ${candidate.name} deleted`);
    onClose();
    onDone();
    bump();
  });
  const place = (r) => (r.client_id ? `${r.client_name}’s record${r.job_title ? `, in ${r.job_title}` : ''}` : 'The Book, without a job');
  const others = data.others.length ? `, with their ${data.others.length === 1 ? 'application' : 'applications'} for ${data.others.map((o) => o.job_title).join(', ')}` : '';
  return (
    <Modal title="Delete all data on this person" subtitle={candidate.name} size="sm" onClose={onClose} onSubmit={erase}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="danger" busy={busy}>{chosen.size ? `Delete ${chosen.size + 1} records` : 'Delete this record only'}</Button></>}>
      <p className="text-sm text-stone-700">{candidate.name} is on file in more than one place. Each client keeps its own record of a person and The Book keeps its own, so deleting one leaves the others. Tick every record that should go.</p>
      <div className="space-y-3 rounded-lg border border-line px-3 py-3">
        <Checkbox checked disabled readOnly label={`This record: ${client ? `${client.name}’s${others}` : 'The Book, without a job'}`} />
        {elsewhere.map((r) => (
          <Checkbox key={r.candidate_id} checked={chosen.has(r.candidate_id)} onChange={() => toggle(r.candidate_id)}
            label={<>{place(r)}{r.application_id && <> · <a href={`/candidates?c=${r.application_id}`} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-700 underline">open</a></>}</>}
            hint={r.same_email ? 'Same email address.' : `Same LinkedIn link${r.name !== candidate.name ? `, under the name ${r.name}` : ''}. Check that it is the same person before ticking.`} />
        ))}
      </div>
      <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-900">
        Everything held on each record ticked is deleted for good: contact details, notes, scorecards, interviews, emails, résumés and recorded calls. This cannot be undone.
        {left.length > 0 && ` ${left.length === 1 ? 'The record' : 'The records'} left unticked will still be on file.`}
      </p>
      {metaviewToo && <p className="text-xs text-stone-500">The Book also forgets their Metaview calls. The conversations themselves stay in Metaview: delete them there too if they must go altogether.</p>}
    </Modal>
  );
}
