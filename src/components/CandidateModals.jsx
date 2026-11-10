import React, { useEffect, useRef, useState } from 'react';
import { FileUp, LoaderCircle } from 'lucide-react';
import { api, url, firstName, watchForUpdate, renderTemplate, toLocalInput, fmtDateTime, INTERVIEW_KINDS, RECOMMENDATIONS, REJECT_REASONS, SOURCES , photoUrl, squarePhoto } from '../lib.js';
import { useApp, useApi } from '../state.jsx';
import { Button, Checkbox, Field, Input, Modal, Select, Textarea, Avatar, UpdateNotice, useAction, useToast, cx } from '../ui.jsx';

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
      <Checkbox checked={sendEmail && Boolean(data.candidate.email)} disabled={!data.candidate.email} onChange={(e) => setSendEmail(e.target.checked)} label="Send the “Not moving forward” email"
        hint={data.candidate.email ? 'Uses the template in Settings. Reasons are never shared with the candidate.' : 'There is no email address on file for this candidate.'} />
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
      <Checkbox checked={notify && Boolean(data.candidate.email)} disabled={!data.candidate.email} onChange={(e) => setNotify(e.target.checked)} label="Email the invitation to the candidate"
        hint={data.candidate.email ? 'Uses the “Interview invitation” template with this time, format and location.' : 'There is no email address on file for this candidate.'} />
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
    <Modal title={`Email ${data.candidate.name}`} subtitle={data.candidate.email || 'No email address on file'} onClose={onClose} onSubmit={send}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy} disabled={Boolean(unfilled) || !data.candidate.email}>Send email</Button></>}>
      {!data.candidate.email && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">Add an email address for this candidate first (More actions, Edit details).</p>}
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

/** What to tell the recruiter after a résumé was dropped in: what was filled, or exactly why it could not be. */
function resumeNote({ labels, status, nameFromFile }) {
  const fromName = nameFromFile ? ' The name was taken from the file name.' : '';
  const why = {
    no_text: 'This file has no selectable text (it is a scan or an image saved as a PDF), so it could not be read.',
    unreadable: 'This type of file cannot be read automatically. PDF and .docx files can.',
    protected: 'This PDF is password-protected, so it could not be read.',
    error: 'This file could not be opened for reading.',
    updated: 'It could not be read this time.',
  }[status];
  if (why) return `Attached. ${why}${fromName} Fill in the ${nameFromFile ? 'rest' : 'details'} below.`;
  if (!labels.length) return 'Attached. No contact details were recognised in it, so fill in the details below.';
  return `Filled in ${labels.join(', ')} from the résumé.${fromName} Please check them.`;
}

/** Add a sourced or referred candidate straight into a job's pipeline. Dropping a résumé in fills the form from it. */
export function AddCandidateModal({ jobId, onClose, onAdded }) {
  const { bump, scope } = useApp();
  const toast = useToast();
  const { data: jobs } = useApi(jobId ? null : url('/jobs', { client_id: scope }));
  const [form, setForm, bind] = useForm({ job_id: jobId || '', source: 'agency_sourced', stage_id: '' });
  const [file, setFile] = useState(null);
  const [reading, setReading] = useState(false);
  const [filled, setFilled] = useState(null); // what was taken from the résumé: { labels, status, nameFromFile }
  const [over, setOver] = useState(false);
  const [conflict, setConflict] = useState(null); // the LinkedIn link belongs to someone else's record: { message, matches }
  const { data: jobData } = useApi(form.job_id ? `/jobs/${form.job_id}` : null);
  useEffect(() => setForm((f) => ({ ...f, stage_id: '' })), [form.job_id]);
  useEffect(() => setConflict(null), [form.linkedin]);
  const conflictBox = useRef(null);
  useEffect(() => { conflictBox.current?.scrollIntoView({ block: 'nearest' }); }, [conflict]);

  const latest = useRef(form);
  latest.current = form;
  const fromResume = useRef({}); // what the last résumé put into each field, to tell it apart from what was typed
  const reads = useRef(0);

  // A file dropped just beside the dashed box would otherwise be opened by the browser, in place of or next to the app.
  useEffect(() => {
    const ignore = (e) => {
      if (e.defaultPrevented || !Array.from(e.dataTransfer?.types || []).includes('Files')) return;
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

  const takeFile = async (picked) => {
    if (!picked) return;
    if (!/\.(pdf|docx?|rtf|txt)$/i.test(picked.name)) return toast('Résumés need to be PDF, Word, RTF or text files.', 'error');
    const turn = ++reads.current;
    setFile(picked);
    setFilled(null);
    setReading(true);
    const updated = watchForUpdate();
    let result = { fields: {}, status: 'error' };
    try {
      const { readResume } = await import('../resume.js');
      result = await readResume(picked);
      if (result.status === 'error' && updated()) result = { ...result, status: 'updated' };
    } catch (err) {
      console.warn('The résumé could not be read automatically:', err);
      if (updated(err)) result.status = 'updated';
    }
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

  const [save, busy] = useAction(async () => {
    setConflict(null);
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) if (v) fd.append(k, v);
    if (file) fd.append('resume', file);
    let added;
    try {
      added = await api.post('/applications', fd);
    } catch (err) {
      if (err.status !== 409 || err.data?.code !== 'link_conflict') throw err;
      return setConflict({ message: err.message, matches: err.data.matches || [] });
    }
    toast(added.known ? `Added to ${added.name || form.name}'s existing record` : `${firstName(form.name)} added to the pipeline`);
    bump();
    onClose();
    onAdded?.(added.id);
  });
  return (
    <Modal title="Add candidate" subtitle="For people you have sourced, referrals, or applicants who came in another way." onClose={onClose} onSubmit={save}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Add candidate</Button></>}>
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
        <input type="file" accept=".pdf,.doc,.docx,.rtf,.txt" className="sr-only" aria-label="Résumé" onChange={(e) => takeFile(e.target.files[0])} />
      </label>
      {filled?.status === 'updated' && <UpdateNotice>Refreshing clears this form. To carry on without refreshing, fill in the details by hand; the file stays attached.</UpdateNotice>}
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
      </div>
      {conflict ? (
        <div role="alert" ref={conflictBox} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900">
          <p className="font-medium">{conflict.message}</p>
          <ul className="mt-1.5 space-y-1 text-[13px]">
            {conflict.matches.map((m) => (
              <li key={m.application_id}>
                {/* In a new tab, so what has been typed here is not lost. */}
                <a href={`/jobs/${m.job_id}?c=${m.application_id}`} target="_blank" rel="noopener noreferrer" className="font-medium underline">Open {m.name}</a>
                <span className="text-red-800"> · {[m.job_title, m.client_name].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : <p className="text-xs text-stone-500">An email address or a LinkedIn link is needed, so the same person is recognised if they are added again.</p>}
    </Modal>
  );
}
