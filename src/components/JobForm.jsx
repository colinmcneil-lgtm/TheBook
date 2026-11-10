import React, { useRef, useState } from 'react';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { api, url, agencyStageName, WORK_MODES, EMPLOYMENT } from '../lib.js';
import { useApp, useApi } from '../state.jsx';
import { Button, Checkbox, Field, Input, Modal, Select, Textarea, useAction, useToast } from '../ui.jsx';
import JobAutofill from './JobAutofill.jsx';

const BRIEF_LABELS = { must_haves: ['must-have', 'must-haves'], nice_to_haves: ['nice-to-have', 'nice-to-haves'], not_a_fit: ['not-a-fit note', 'not-a-fit notes'],
  target_companies: ['target company', 'target companies'], where_to_look: ['place to look', 'places to look'], search_titles: ['job title to search', 'job titles to search'],
  search_keywords: ['keyword', 'keywords'], selling_points: ['selling point', 'selling points'], screening_questions: ['first-call question', 'first-call questions'] };

const DEFAULT_STAGES = ['Recruiter screen', 'Hiring manager interview', 'Final interview'];
// The fields autofill can fill, with what an untouched new-job form holds in each and what to call it.
const DRAFTED = { title: ['', 'job title'], department: ['', 'department'], location: ['', 'location'], work_mode: ['hybrid', 'working pattern'], employment_type: ['full_time', 'contract'],
  salary_min: ['', 'salary from'], salary_max: ['', 'salary to'], openings: [1, 'openings'], description: ['', 'job advert'] };
const stageNames = (list) => list.map((s) => s.name.trim()).join('\n');
/** Is this stage an interview with the client? What was ticked, or, when nobody has touched the tick, what the name says. */
const withClient = (stage) => stage.with_client ?? !agencyStageName(stage.name);
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

/**
 * Lets the rows of a list be put in a new order by dragging a grip (mouse or finger) or with the arrow keys while
 * the grip has focus. The list is reordered as the row is dragged, so what is on screen is always what will be saved.
 * Rows are marked with data-reorder-row and grips with data-reorder-grip inside the element `box` is attached to.
 */
function useReorder(list, onChange) {
  const box = useRef(null);
  const at = useRef(null); // where the row being dragged is now
  const [dragging, setDragging] = useState(null);
  const move = (from, to) => {
    if (to < 0 || to >= list.length || to === from) return from;
    const next = [...list];
    next.splice(to, 0, next.splice(from, 1)[0]);
    onChange(next);
    return to;
  };
  const stop = () => { at.current = null; setDragging(null); };
  const grip = (index) => ({
    'data-reorder-grip': '',
    onPointerDown: (e) => {
      if (e.button) return; // left button or a finger only
      e.preventDefault(); // no text selection while dragging
      e.currentTarget.focus();
      e.currentTarget.setPointerCapture(e.pointerId);
      at.current = index;
      setDragging(index);
    },
    onPointerMove: (e) => {
      if (at.current === null) return;
      const rows = [...box.current.querySelectorAll('[data-reorder-row]')].map((row) => row.getBoundingClientRect());
      // The row the pointer is over; above the first counts as the first, below the last as the last.
      let over = rows.findIndex((r) => e.clientY < r.bottom);
      if (over === -1) over = rows.length - 1;
      if (over !== at.current) { at.current = move(at.current, over); setDragging(at.current); }
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    onLostPointerCapture: stop,
    onKeyDown: (e) => {
      const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      if (!step) return;
      e.preventDefault();
      const to = move(index, index + step);
      // The row moved, so the grip to keep focus on is the one at its new place. Done at once, not a moment later:
      // a key held down sends the next press straight away, and it must land on the row that was just moved.
      if (to !== index) box.current?.querySelectorAll('[data-reorder-grip]')[to]?.focus();
    },
  });
  return { box, grip, dragging };
}

/** Create a job, or edit one when `job` (and its `stages`) are passed. */
export default function JobForm({ job, stages, clientId, onClose, onSaved }) {
  const { clients, scope, bump, user, isAdmin } = useApp();
  const toast = useToast();
  const [form, setForm] = useState(() => ({
    client_id: job?.client_id ?? clientId ?? scope ?? (clients.length === 1 ? clients[0].id : ''),
    title: job?.title ?? '', department: job?.department ?? '', location: job?.location ?? '',
    work_mode: job?.work_mode ?? 'hybrid', employment_type: job?.employment_type ?? 'full_time',
    salary_min: job?.salary_min ?? '', salary_max: job?.salary_max ?? '', salary_public: job ? job.salary_public === 1 : true,
    openings: job?.openings ?? 1, hiring_manager_id: job?.hiring_manager_id ?? '', status: job?.status ?? 'draft',
    // The account executive: whoever creates the job, until it is handed to somebody else.
    account_executive_id: job ? job.account_executive_id ?? '' : user.id,
    description: job?.description ?? '',
    // `with_client` is the "Interview with the client" tick. A stage that has never had one set (a new stage, or one
    // autofill drafted) leaves it out, and the tick then follows what the stage is called until somebody clicks it.
    interview_stages: stages ? stages.filter((s) => s.kind === 'interview').map((s) => ({ id: s.id, name: s.name, with_client: Boolean(s.with_client) })) : DEFAULT_STAGES.map((name) => ({ name })),
    questions: job?.questions ?? [],
    criteria: job?.criteria ?? DEFAULT_CRITERIA,
  }));
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const [executiveAtOpen] = useState(form.account_executive_id); // who the form showed as account executive when it was opened
  const [draft, setDraft] = useState(null); // the last autofill result, for the notes shown about it
  const latest = useRef(form);
  latest.current = form;
  const fromDraft = useRef({}); // what the last draft put into each field, to tell it apart from what was typed
  // Autofill fills the fields that are still as the form (or an earlier draft) left them. Anything typed or changed
  // by hand stays, including while the draft was being made; and a field an earlier draft filled that this one has
  // nothing for goes back to empty, so the form is never a mix of two documents.
  const applyDraft = (result) => {
    const j = result.job, now = latest.current;
    const changes = {}, filled = {}, kept = [];
    const settle = (key, current, empty, found, label) => {
      const untouched = current === String(empty) || (key in fromDraft.current && current === String(fromDraft.current[key]));
      const has = found != null && found !== '';
      if (untouched) { changes[key] = has ? found : empty; if (has) filled[key] = found; }
      else if (has && String(found) !== current) kept.push(label);
    };
    for (const [key, [empty, label]] of Object.entries(DRAFTED)) settle(key, String(now[key] ?? '').trim(), empty, j[key], label);
    const stages = j.interview_stages.join('\n');
    const stagesNow = stageNames(now.interview_stages);
    if (stagesNow === DEFAULT_STAGES.join('\n') || stagesNow === fromDraft.current.interview_stages) {
      changes.interview_stages = (stages ? j.interview_stages : DEFAULT_STAGES).map((name) => ({ name }));
      if (stages) filled.interview_stages = stages;
    } else if (stages && stages !== stagesNow) kept.push('interview stages');
    fromDraft.current = filled;
    setForm((f) => ({ ...f, ...changes, brief: result.brief, ideal_profile: result.ideal_profile || undefined }));
    setDraft(result);
    return { note: kept.length ? `Left as you had ${kept.length === 1 ? 'it' : 'them'}: ${kept.join(', ')}.` : '' };
  };
  const briefParts = draft ? Object.entries(BRIEF_LABELS).filter(([key]) => draft.brief[key]?.length).map(([key, [one, many]]) => `${draft.brief[key].length} ${draft.brief[key].length === 1 ? one : many}`) : [];
  const bind = (key) => ({ value: form[key] ?? '', onChange: (e) => set(key, e.target.value) });
  const editList = (key, index, patch) => set(key, form[key].map((item, i) => (i === index ? (typeof item === 'string' ? patch : { ...item, ...patch }) : item)));
  const dropFrom = (key, index) => set(key, form[key].filter((_, i) => i !== index));
  const stageOrder = useReorder(form.interview_stages, (next) => set('interview_stages', next));
  const { data: people } = useApi(form.client_id ? url('/users', { client_id: form.client_id }) : null);
  const client = clients.find((c) => c.id === Number(form.client_id));
  // Whose job it is can be changed by an admin, and by the account executive handing on a job of their own. Anyone
  // else sees who it is and cannot change it; a recruiter's new job is their own.
  const canHand = isAdmin || Boolean(job && job.account_executive_id === user.id);
  const { data: executives } = useApi('/account-executives');
  const team = (executives?.people || []).filter((p) => p.active);
  const holder = job ? { id: job.account_executive_id, name: job.account_executive_name, left: job.account_executive_active === 0 } : { id: user.id, name: user.name };

  const [save, busy] = useAction(async () => {
    const body = { ...form, interview_stages: form.interview_stages.map((s) => ({ ...s, with_client: withClient(s) })) };
    // The account executive is only sent when it was changed in this form. Left as it was, it says nothing: the job
    // may have been handed to somebody else while the form was open, and saving a new title must neither be refused
    // for that nor quietly hand the job back. It is not sent either by somebody whose say it is not.
    if (!canHand || String(form.account_executive_id) === String(executiveAtOpen)) delete body.account_executive_id;
    // The plain reader's one "job title to search" is the title it read. If the title was corrected here, the brief follows it.
    const title = form.title.trim().replace(/\s*\(.*\)$/, '');
    if (draft?.source === 'basic' && form.brief?.search_titles?.length === 1 && title) body.brief = { ...form.brief, search_titles: [title] };
    const saved = job ? await api.put(`/jobs/${job.id}`, body) : await api.post('/jobs', body);
    const id = job ? job.id : saved.id;
    toast(job ? 'Job saved' : form.status === 'open' ? 'Job created and published. Add the recruiter brief next.' : 'Job saved as a draft. Add the recruiter brief next.');
    if (saved.board_notice) toast(saved.board_notice, 'error'); // the change took the job's confidential post down
    bump();
    onClose();
    onSaved?.(id);
  });

  return (
    <Modal title={job ? 'Edit job' : 'New job'} size="lg" onClose={onClose} onSubmit={save}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>{job ? 'Save changes' : 'Create job'}</Button></>}>
      {!job && <JobAutofill onResult={applyDraft} />}
      {draft && (briefParts.length > 0 || draft.brief.about) && (
        <p className="rounded-lg bg-violet-50 px-3 py-2 text-[13px] leading-relaxed text-violet-900">
          A recruiter brief was drafted too{briefParts.length ? `: ${briefParts.join(', ')}` : ''}. It is saved with the job, and you can review and edit it on the job’s Brief tab.
        </p>
      )}
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
          <Field label="Salary to" className="sm:col-span-2"
            hint={draft?.job.salary_currency && client && draft.job.salary_currency !== client.currency ? `The documents give the salary in ${draft.job.salary_currency}; this client is set to ${client.currency}.` : undefined}>
            <Input type="number" min="0" step="500" {...bind('salary_max')} />
          </Field>
          <Field label="Openings" className="sm:col-span-2"><Input type="number" min="1" {...bind('openings')} /></Field>
          <Field label="Hiring manager" className="sm:col-span-3">
            <Select {...bind('hiring_manager_id')} disabled={!form.client_id}>
              <option value="">Not set</option>
              {job?.hiring_manager_id && people && !people.some((p) => p.id === job.hiring_manager_id) && (
                <option value={job.hiring_manager_id}>{job.hiring_manager_name || 'Current manager'} (deactivated)</option>
              )}
              {(people || []).map((p) => <option key={p.id} value={p.id}>{p.name}{p.role === 'client' ? '' : ' (agency)'}</option>)}
            </Select>
          </Field>
          <Field label="Account executive" className="sm:col-span-3"
            hint={canHand ? undefined : job ? `Only ${holder.name ? `${holder.name} or an admin` : 'an admin'} can hand this job to somebody else.` : 'Whoever creates a job is its account executive, so this one is yours.'}>
            <Select {...bind('account_executive_id')} disabled={!canHand}>
              {holder.id == null && <option value="">Not set</option>}
              {holder.id != null && !team.some((p) => p.id === holder.id) && <option value={holder.id}>{holder.name}{holder.left ? ' (deactivated)' : ''}</option>}
              {team.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === user.id ? ' (you)' : ''}</option>)}
            </Select>
          </Field>
          <div className="sm:col-span-6">
            <Checkbox checked={form.salary_public} onChange={(e) => set('salary_public', e.target.checked)} label="Show the salary range on the careers page" />
          </div>
        </div>
      </Section>

      <Section title="Job advert" hint="Shown on the client's careers page. Plain text; line breaks are kept.">
        <Textarea rows={9} {...bind('description')} placeholder={'A short introduction to the role and team.\n\nWhat you will do\n• …\n\nWhat we are looking for\n• …'} />
      </Section>

      <Section title="Interview stages" hint="Every pipeline starts with Applied and ends with Offer and Hired. These are the steps in between, in order. Drag a stage by its grip to move it. Tick “Interview with the client” where the client meets the candidate, and leave it off for your own screening calls: Reports counts a submitted candidate’s first interview from the first ticked stage they reach, or from an interview scheduled for them in The Book, whichever comes first.">
        <div className="space-y-2" ref={stageOrder.box}>
          {form.interview_stages.map((s, i) => (
            <div key={i} data-reorder-row="" className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg ${stageOrder.dragging === i ? 'bg-brand-50 ring-2 ring-brand-300' : ''}`}>
              {form.interview_stages.length > 1 && (
                <button type="button" {...stageOrder.grip(i)} aria-label={`Move stage ${i + 1}${s.name ? `, ${s.name}` : ''}. Drag, or use the up and down arrow keys.`} title="Drag to move"
                  className={`flex h-9 w-6 shrink-0 touch-none select-none items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-700 focus-visible:outline-2 focus-visible:outline-brand-500 ${stageOrder.dragging === i ? 'cursor-grabbing text-stone-700' : 'cursor-grab'}`}>
                  <GripVertical size={16} aria-hidden="true" />
                </button>
              )}
              <span className="tabular w-5 text-center text-xs text-stone-400">{i + 1}</span>
              <Input value={s.name} onChange={(e) => editList('interview_stages', i, { name: e.target.value })} aria-label={`Stage ${i + 1}`} className="min-w-0 flex-1" />
              {/* On a phone the tick sits on a line of its own under the name. */}
              <div className={`order-last basis-full pb-1 whitespace-nowrap sm:order-none sm:basis-auto sm:pb-0 sm:pl-0 ${form.interview_stages.length > 1 ? 'pl-[60px]' : 'pl-7'}`}>
                <Checkbox checked={withClient(s)} onChange={(e) => editList('interview_stages', i, { with_client: e.target.checked })} label="Interview with the client" />
              </div>
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
