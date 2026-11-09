import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, url, WORK_MODES, EMPLOYMENT } from '../lib.js';
import { useApp, useApi } from '../state.jsx';
import { Button, Checkbox, Field, Input, Modal, Select, Textarea, useAction, useToast } from '../ui.jsx';

const DEFAULT_STAGES = ['Recruiter screen', 'Hiring manager interview', 'Final interview'];
const DEFAULT_CRITERIA = ['Role-specific skills', 'Problem solving', 'Communication', 'Values and motivation'];

function Section({ title, hint, children }) {
  return (
    <section className="border-t border-line pt-4 first:border-0 first:pt-0">
      <h3 className="text-sm font-semibold text-stone-900">{title}</h3>
      {hint && <p className="mt-0.5 mb-3 text-[13px] text-stone-500">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}

/** Create a job, or edit one when `job` (and its `stages`) are passed. */
export default function JobForm({ job, stages, clientId, onClose, onSaved }) {
  const { clients, scope, bump } = useApp();
  const toast = useToast();
  const [form, setForm] = useState(() => ({
    client_id: job?.client_id ?? clientId ?? scope ?? (clients.length === 1 ? clients[0].id : ''),
    title: job?.title ?? '', department: job?.department ?? '', location: job?.location ?? '',
    work_mode: job?.work_mode ?? 'hybrid', employment_type: job?.employment_type ?? 'full_time',
    salary_min: job?.salary_min ?? '', salary_max: job?.salary_max ?? '', salary_public: job ? job.salary_public === 1 : true,
    openings: job?.openings ?? 1, hiring_manager_id: job?.hiring_manager_id ?? '', status: job?.status ?? 'draft',
    description: job?.description ?? '', ideal_profile: job?.ideal_profile ?? '',
    interview_stages: stages ? stages.filter((s) => s.kind === 'interview').map((s) => ({ id: s.id, name: s.name })) : DEFAULT_STAGES.map((name) => ({ name })),
    questions: job?.questions ?? [],
    criteria: job?.criteria ?? DEFAULT_CRITERIA,
  }));
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const bind = (key) => ({ value: form[key] ?? '', onChange: (e) => set(key, e.target.value) });
  const editList = (key, index, patch) => set(key, form[key].map((item, i) => (i === index ? (typeof item === 'string' ? patch : { ...item, ...patch }) : item)));
  const dropFrom = (key, index) => set(key, form[key].filter((_, i) => i !== index));
  const { data: people } = useApi(form.client_id ? url('/users', { client_id: form.client_id }) : null);
  const client = clients.find((c) => c.id === Number(form.client_id));

  const [save, busy] = useAction(async () => {
    const id = job ? (await api.put(`/jobs/${job.id}`, form), job.id) : (await api.post('/jobs', form)).id;
    toast(job ? 'Job saved' : form.status === 'open' ? 'Job created and published' : 'Job saved as a draft');
    bump();
    onClose();
    onSaved?.(id);
  });

  return (
    <Modal title={job ? 'Edit job' : 'New job'} size="lg" onClose={onClose} onSubmit={save}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>{job ? 'Save changes' : 'Create job'}</Button></>}>
      <Section title="The role">
        <div className="grid gap-4 sm:grid-cols-6">
          <Field label="Client" className="sm:col-span-3">
            <Select value={form.client_id} required disabled={Boolean(job)}
              onChange={(e) => setForm((f) => ({ ...f, client_id: e.target.value, hiring_manager_id: '' }))}>
              <option value="">Choose a client…</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Status" className="sm:col-span-3">
            <Select {...bind('status')}>
              <option value="draft">Draft (not visible)</option>
              <option value="open">Open (live on the careers page)</option>
              <option value="paused">Paused</option>
              <option value="closed">Closed</option>
            </Select>
          </Field>
          <Field label="Job title" className="sm:col-span-4"><Input {...bind('title')} required placeholder="e.g. Senior Backend Engineer" /></Field>
          <Field label="Department" className="sm:col-span-2"><Input {...bind('department')} placeholder="e.g. Engineering" /></Field>
          <Field label="Location" className="sm:col-span-2"><Input {...bind('location')} placeholder="e.g. London" /></Field>
          <Field label="Working pattern" className="sm:col-span-2">
            <Select {...bind('work_mode')}>{Object.entries(WORK_MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          </Field>
          <Field label="Contract" className="sm:col-span-2">
            <Select {...bind('employment_type')}>{Object.entries(EMPLOYMENT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          </Field>
          <Field label={`Salary from${client ? ` (${client.currency})` : ''}`} className="sm:col-span-2"><Input type="number" min="0" step="500" {...bind('salary_min')} /></Field>
          <Field label="Salary to" className="sm:col-span-2"><Input type="number" min="0" step="500" {...bind('salary_max')} /></Field>
          <Field label="Openings" className="sm:col-span-2"><Input type="number" min="1" {...bind('openings')} /></Field>
          <Field label="Hiring manager" className="sm:col-span-3">
            <Select {...bind('hiring_manager_id')} disabled={!form.client_id}>
              <option value="">Not set</option>
              {(people || []).map((p) => <option key={p.id} value={p.id}>{p.name}{p.role === 'client' ? '' : ' (agency)'}</option>)}
            </Select>
          </Field>
          <div className="flex items-end pb-2 sm:col-span-3">
            <Checkbox checked={form.salary_public} onChange={(e) => set('salary_public', e.target.checked)} label="Show the salary range on the careers page" />
          </div>
        </div>
      </Section>

      <Section title="Job advert" hint="Shown on the client's careers page. Plain text; line breaks are kept.">
        <Textarea rows={9} {...bind('description')} placeholder={'A short introduction to the role and team.\n\nWhat you will do\n• …\n\nWhat we are looking for\n• …'} />
      </Section>

      <Section title="Internal brief" hint="Your notes on the ideal profile, must-haves and the hiring manager's preferences. Only your agency sees this.">
        <Textarea rows={3} {...bind('ideal_profile')} />
      </Section>

      <Section title="Interview stages" hint="Every pipeline starts with Applied and ends with Offer and Hired. These are the steps in between, in order.">
        <div className="space-y-2">
          {form.interview_stages.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="tabular w-5 text-center text-xs text-stone-400">{i + 1}</span>
              <Input value={s.name} onChange={(e) => editList('interview_stages', i, { name: e.target.value })} aria-label={`Stage ${i + 1}`} />
              <Button variant="ghost" icon={Trash2} aria-label="Remove stage" className="!px-2" onClick={() => dropFrom('interview_stages', i)} disabled={form.interview_stages.length === 1} />
            </div>
          ))}
          <Button size="sm" icon={Plus} onClick={() => set('interview_stages', [...form.interview_stages, { name: '' }])}>Add stage</Button>
        </div>
      </Section>

      <Section title="Application questions" hint="Asked on the application form, after contact details and résumé.">
        <div className="space-y-2">
          {form.questions.map((q, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2">
              <Input value={q.label} onChange={(e) => editList('questions', i, { label: e.target.value })} placeholder="Question" aria-label={`Question ${i + 1}`} className="min-w-52 flex-1" />
              <Select value={q.type} onChange={(e) => editList('questions', i, { type: e.target.value })} aria-label="Answer type" className="!w-auto">
                <option value="short">Short answer</option>
                <option value="long">Long answer</option>
                <option value="yesno">Yes / No</option>
              </Select>
              <Checkbox checked={q.required} onChange={(e) => editList('questions', i, { required: e.target.checked })} label="Required" />
              <Button variant="ghost" icon={Trash2} aria-label="Remove question" className="!px-2" onClick={() => dropFrom('questions', i)} />
            </div>
          ))}
          <Button size="sm" icon={Plus} onClick={() => set('questions', [...form.questions, { label: '', type: 'short', required: false }])}>Add question</Button>
        </div>
      </Section>

      <Section title="Scorecard criteria" hint="What every interviewer rates, so feedback is comparable across candidates.">
        <div className="space-y-2">
          {form.criteria.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input value={c} onChange={(e) => editList('criteria', i, e.target.value)} aria-label={`Criterion ${i + 1}`} />
              <Button variant="ghost" icon={Trash2} aria-label="Remove criterion" className="!px-2" onClick={() => dropFrom('criteria', i)} />
            </div>
          ))}
          <Button size="sm" icon={Plus} onClick={() => set('criteria', [...form.criteria, ''])}>Add criterion</Button>
        </div>
      </Section>
    </Modal>
  );
}
