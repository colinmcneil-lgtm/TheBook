import React, { useEffect, useState } from 'react';
import { api, url, firstName, renderTemplate, toLocalInput, fmtDateTime, INTERVIEW_KINDS, RECOMMENDATIONS, REJECT_REASONS, SOURCES } from '../lib.js';
import { useApp, useApi } from '../state.jsx';
import { Button, Checkbox, Field, Input, Modal, Select, Textarea, Avatar, useAction, useToast, cx } from '../ui.jsx';

const useForm = (initial) => {
  const [form, setForm] = useState(initial);
  const bind = (key) => ({ value: form[key] ?? '', onChange: (e) => setForm((f) => ({ ...f, [key]: e.target.value })) });
  return [form, setForm, bind];
};

function MailNote() {
  const { mailConfigured } = useApp();
  if (mailConfigured) return null;
  return (
    <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
      Email delivery is not connected yet, so messages are saved on the candidate's record but not sent. See Settings for how to connect it.
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
    await api.post(`/applications/${data.application.id}/reject`, { reason: reason === 'Other' ? other || 'Other' : reason, send_email: sendEmail });
    toast(`${firstName(data.candidate.name)} was rejected`);
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
      <Checkbox checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} label="Send the “Not moving forward” email" hint="Uses the template in Settings. Reasons are never shared with the candidate." />
      {sendEmail && <MailNote />}
    </Modal>
  );
}

export function ScheduleModal({ data, onClose }) {
  const { bump, user } = useApp();
  const toast = useToast();
  const stage = data.stages.find((s) => s.id === data.application.stage_id);
  const tomorrow = new Date(Date.now() + 86400000);
  tomorrow.setHours(10, 0, 0, 0);
  const [form, setForm, bind] = useForm({
    title: stage?.kind === 'interview' ? stage.name : 'Interview', kind: 'video', starts_at: toLocalInput(tomorrow), duration_min: 45, location: '', notes: '',
  });
  const [panel, setPanel] = useState([user.id]);
  const [notify, setNotify] = useState(false);
  const { data: people } = useApi(url('/users', { client_id: data.client.id }));
  const toggle = (id) => setPanel((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const [save, busy] = useAction(async () => {
    const starts = new Date(form.starts_at);
    await api.post('/interviews', { ...form, application_id: data.application.id, starts_at: starts.toISOString(), panel, notify, time_label: `${fmtDateTime(starts)} (${Intl.DateTimeFormat().resolvedOptions().timeZone})` });
    toast('Interview scheduled');
    bump();
    onClose();
  });
  return (
    <Modal title="Schedule interview" subtitle={`${data.candidate.name} · ${data.job.title}`} onClose={onClose} onSubmit={save}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Schedule</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Interview" className="sm:col-span-2"><Input {...bind('title')} required /></Field>
        <Field label="Date and time" hint={`Your time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`}><Input type="datetime-local" {...bind('starts_at')} required /></Field>
        <Field label="Length">
          <Select {...bind('duration_min')}>{[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}</Select>
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
      <Checkbox checked={notify} onChange={(e) => setNotify(e.target.checked)} label="Email the invitation to the candidate" hint="Uses the “Interview invitation” template with this time, format and location." />
      {notify && <MailNote />}
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
  const vars = { candidate_first_name: firstName(data.candidate.name), candidate_name: data.candidate.name, job_title: data.job.title, company: data.client.name, sender_name: user.name };
  const apply = (id) => {
    const t = templates?.find((x) => String(x.id) === id);
    if (!t) return;
    setSubject(renderTemplate(t.subject, vars));
    setBody(renderTemplate(t.body, vars));
  };
  const unfilled = `${subject}\n${body}`.match(/\{\{\s*\w+\s*\}\}/g);
  const [send, busy] = useAction(async () => {
    const result = await api.post(`/applications/${data.application.id}/emails`, { subject, body });
    toast(result.delivery === 'sent' ? 'Email sent' : result.delivery === 'failed' ? 'Saved, but delivery failed' : 'Saved to the record (delivery not connected)', result.delivery === 'failed' ? 'error' : 'ok');
    bump();
    onClose();
  });
  return (
    <Modal title={`Email ${data.candidate.name}`} subtitle={data.candidate.email} onClose={onClose} onSubmit={send}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy} disabled={Boolean(unfilled)}>Send email</Button></>}>
      <MailNote />
      <Field label="Start from a template">
        <Select defaultValue="" onChange={(e) => apply(e.target.value)}>
          <option value="">Blank message</option>
          {/* The interview invitation is sent from the Schedule dialog, where the time and place are known. */}
          {(templates || []).filter((t) => t.key !== 'interview_invite').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      </Field>
      <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} required /></Field>
      <Field label="Message"><Textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} required /></Field>
      {unfilled && <p className="text-xs text-red-700">Replace {[...new Set(unfilled)].join(', ')} before sending.</p>}
    </Modal>
  );
}

export function SubmitModal({ data, onClose }) {
  const { bump } = useApp();
  const toast = useToast();
  const [note, setNote] = useState(data.application.submission_note || '');
  const [save, busy] = useAction(async () => {
    await api.post(`/applications/${data.application.id}/submit`, { note });
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

const CANDIDATE_FIELDS = [['name', 'Full name', 'text', true], ['email', 'Email', 'email', true], ['phone', 'Phone'], ['linkedin', 'LinkedIn URL'], ['current_title', 'Current title'], ['current_company', 'Current company'], ['location', 'Location']];

export function EditCandidateModal({ data, onClose }) {
  const { bump } = useApp();
  const [form, , bind] = useForm({ ...data.candidate });
  const [save, busy] = useAction(async () => {
    await api.patch(`/applications/${data.application.id}`, { candidate: form });
    bump();
    onClose();
  });
  return (
    <Modal title="Edit candidate details" onClose={onClose} onSubmit={save}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {CANDIDATE_FIELDS.map(([key, label, type = 'text', required]) => <Field key={key} label={label}><Input type={type} required={required} {...bind(key)} /></Field>)}
      </div>
    </Modal>
  );
}

/** Add a sourced or referred candidate straight into a job's pipeline. */
export function AddCandidateModal({ jobId, onClose, onAdded }) {
  const { bump, scope } = useApp();
  const toast = useToast();
  const { data: jobs } = useApi(jobId ? null : url('/jobs', { client_id: scope }));
  const [form, setForm, bind] = useForm({ job_id: jobId || '', source: 'agency_sourced', stage_id: '' });
  const [file, setFile] = useState(null);
  const { data: jobData } = useApi(form.job_id ? `/jobs/${form.job_id}` : null);
  useEffect(() => setForm((f) => ({ ...f, stage_id: '' })), [form.job_id]);

  const [save, busy] = useAction(async () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) if (v) fd.append(k, v);
    if (file) fd.append('resume', file);
    const { id } = await api.post('/applications', fd);
    toast(`${firstName(form.name)} added to the pipeline`);
    bump();
    onClose();
    onAdded?.(id);
  });
  return (
    <Modal title="Add candidate" subtitle="For people you have sourced, referrals, or applicants who came in another way." onClose={onClose} onSubmit={save}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Add candidate</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {!jobId && (
          <Field label="Job" className="sm:col-span-2">
            <Select {...bind('job_id')} required>
              <option value="">Choose a job…</option>
              {(jobs || []).filter((j) => j.status !== 'closed').map((j) => <option key={j.id} value={j.id}>{j.title} · {j.client_name}</option>)}
            </Select>
          </Field>
        )}
        {CANDIDATE_FIELDS.map(([key, label, type = 'text', required]) => <Field key={key} label={label}><Input type={type} required={required} {...bind(key)} /></Field>)}
        <Field label="Source">
          <Select {...bind('source')}>{Object.entries(SOURCES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        </Field>
        <Field label="Starting stage">
          <Select {...bind('stage_id')} disabled={!jobData}>
            {(jobData?.stages || []).filter((s) => s.kind !== 'hired').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Résumé" hint="PDF, Word, RTF or text, up to 8 MB.">
          <input type="file" accept=".pdf,.doc,.docx,.rtf,.txt" onChange={(e) => setFile(e.target.files[0] || null)}
            className="block w-full text-sm text-stone-600 file:mr-3 file:h-9 file:rounded-lg file:border file:border-line file:bg-white file:px-3 file:text-sm file:font-medium file:text-stone-800" />
        </Field>
      </div>
    </Modal>
  );
}
