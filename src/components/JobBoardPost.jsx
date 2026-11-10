import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleAlert, CircleCheck, Copy, ExternalLink, EyeOff, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import { api, ago, copyText, fmtDate, plural, salaryRange, WORK_MODES, EMPLOYMENT } from '../lib.js';
import { useApp, useApi, Pending } from '../state.jsx';
import { Badge, Button, Card, CardHeader, Checkbox, Field, Input, Textarea, useAction, useToast } from '../ui.jsx';
import { PostView } from '../pages/Board.jsx';

// The job's Confidential post tab: the agency's own advert for this job, for its public job board. What is typed
// here is all the public is ever shown; nothing is taken from the client. The check below the form is what keeps
// the client's name out, and the post cannot be public while it finds anything.

const LOG = { published: 'Went public', taken_down: 'Came down', overruled: 'A word was overruled', overrule_withdrawn: 'An overrule was withdrawn' };

export default function JobBoardPost({ job }) {
  const { isAdmin, bump } = useApp();
  const toast = useToast();
  const { data: loaded, error } = useApi(`/jobs/${job.id}/board`);
  const [view, setView] = useState(null);       // what the server last said, after a save or an overrule
  const [form, setForm] = useState(null);
  const [checked, setChecked] = useState(null); // the check, run on what is in the form now
  const [drafted, setDrafted] = useState(null); // what the last draft took out, for the recruiter to read
  const current = view ?? loaded;
  useEffect(() => { setView(null); }, [loaded]);
  // The form starts from the saved post, and starts again only when the saved post is different: the workspace
  // re-reads its data whenever anything is saved anywhere, and that must not wipe what is being typed here.
  const savedPost = current && JSON.stringify(current.post), savedCheck = current && JSON.stringify(current.check);
  useEffect(() => {
    if (!current) return;
    const p = current.post;
    setForm({ enabled: p.enabled, title: p.title, location: p.location, description: p.description, show_salary: p.show_salary });
  }, [savedPost]);

  // The check is run again a moment after the recruiter stops typing, so they see what it finds before they save.
  const typed = form && JSON.stringify([form.title, form.location, form.description, form.show_salary]);
  const latest = useRef(typed);
  useEffect(() => {
    latest.current = typed;
    if (!form || !current) return undefined;
    const saved = JSON.stringify([current.post.title, current.post.location, current.post.description, current.post.show_salary]);
    if (typed === saved) { setChecked(current.check); return undefined; }
    const timer = setTimeout(async () => {
      try {
        const result = await api.post(`/jobs/${job.id}/board/check`, form);
        if (latest.current === typed) setChecked(result);
      } catch { /* the next keystroke, or the save, checks again */ }
    }, 400);
    return () => clearTimeout(timer);
  }, [typed, savedCheck]);

  const [save, saving] = useAction(async () => {
    const next = await api.put(`/jobs/${job.id}/board`, form);
    setView(next);
    setDrafted(null);
    toast(next.state.live ? 'Saved. The post is public.' : form.enabled ? 'Saved, but the post is not public yet.' : 'Saved', next.state.live || !form.enabled ? 'ok' : 'error');
    bump();
  });
  const [draft, drafting] = useAction(async () => {
    if (form.description.trim() && !window.confirm('Replace the advert text with a new draft?')) return;
    const result = await api.post(`/jobs/${job.id}/board/draft`);
    setForm((f) => ({ ...f, title: result.title, description: result.description }));
    setDrafted(result.removed);
    toast('Drafted. Read it through before you save.');
  });
  const [overrule, overruling] = useAction(async (problem) => {
    if (!window.confirm(`Overrule “${problem.found}” in “${problem.phrase}”?\n\nOnly do this when it is plainly not the client: a common word that happens to be in their name. It is recorded with your name. The same word anywhere else in the post is still found.`)) return;
    setView(await api.post(`/jobs/${job.id}/board/overrules`, { word: problem.word, key: problem.key }));
    toast('Overruled, and recorded');
    bump();
  });
  const [withdraw] = useAction(async (item) => {
    setView(await api.del(`/jobs/${job.id}/board/overrules/${item.id}`));
    toast('Overrule withdrawn');
    bump();
  });

  if (!current || !form || !checked) return <Card><Pending error={error} /></Card>;
  const { post, state, board } = current;
  const dirty = JSON.stringify(form) !== JSON.stringify({ enabled: post.enabled, title: post.title, location: post.location, description: post.description, show_salary: post.show_salary });
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const salary = salaryRange(job.salary_min, job.salary_max, job.currency);
  const address = post.token ? `${window.location.origin}/board/${post.token}` : null;
  const preview = {
    title: form.title, location: form.location, description: form.description, work_mode: job.work_mode, employment_type: job.employment_type,
    salary: form.show_salary && salary ? { min: job.salary_min, max: job.salary_max, currency: job.currency } : null,
  };

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-6">
        <Card>
          <CardHeader title="Confidential post" action={state.live ? <Badge tone="green" icon={CircleCheck}>Public</Badge> : <Badge tone={post.enabled ? 'amber' : 'gray'}>Not public</Badge>} />
          <div className="space-y-4 p-4">
            <p className="text-sm leading-relaxed text-stone-600">
              Your own advert for this job, on your job board, in your agency’s name. The public sees only what is on this page: nothing is taken from {job.client_name}, and applicants are not told who the employer is.
            </p>
            {state.live ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2.5 text-sm text-brand-900">
                <span className="min-w-0 flex-1 basis-56">Public on your job board{post.posted_at ? ` since ${fmtDate(post.posted_at)}` : ''}.</span>
                <Button size="sm" icon={Copy} onClick={() => copyText(address, toast, 'Link copied')}>Copy link</Button>
                <a href={address} target="_blank" rel="noreferrer"><Button size="sm" icon={ExternalLink}>Open</Button></a>
              </div>
            ) : post.enabled && state.says ? (
              <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950"><TriangleAlert className="mt-0.5 size-4 shrink-0" />{state.says}</p>
            ) : null}
            <Checkbox checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} label="Post on our website (confidential)"
              hint="Goes public when you save, as long as the job is open and the check below finds nothing." />
            <Field label="Title" hint="As the public should see it."><Input value={form.title} onChange={(e) => set('title', e.target.value)} /></Field>
            <Field label="Location" hint="As it should be shown: an area, not an address."><Input value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="e.g. Greater Toronto Area" /></Field>
            <div className="space-y-2 rounded-lg bg-stone-50 px-3 py-2.5 text-sm text-stone-600">
              <p><span className="font-medium text-stone-800">{[WORK_MODES[job.work_mode], EMPLOYMENT[job.employment_type]].join(' · ')}</span> are shown as they are on the job. Change them with Edit, above.</p>
              <Checkbox checked={form.show_salary && Boolean(salary)} disabled={!salary} onChange={(e) => set('show_salary', e.target.checked)}
                label={salary ? `Show the salary range (${salary})` : 'Show the salary range'} hint={salary ? undefined : 'This job has no salary range.'} />
            </div>
            <Field label="Advert text" hint="Plain text; line breaks are kept. Describe the employer in general terms only (“a Series B health-tech company”).">
              <Textarea rows={16} value={form.description} onChange={(e) => set('description', e.target.value)}
                placeholder={'Our client is a …\n\nWhat you will do\n• …\n\nWhat we are looking for\n• …'} />
            </Field>
            {current.ai ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button icon={Sparkles} busy={drafting} onClick={draft}>{drafting ? 'Drafting…' : 'Draft it for me'}</Button>
                <span className="min-w-0 flex-1 basis-56 text-[13px] text-stone-500">Rewrites the job’s own advert with everything that points to the employer taken out. The job’s advert and the client’s name are sent to the AI service to do it.</span>
              </div>
            ) : (
              <p className="text-[13px] text-stone-500">AI drafting is not connected, so write the advert yourself. Leave out the client’s name and anything made from it, products and brand names, founders and other named people, addresses and neighbourhoods, exact headcount or funding figures, awards, slogans and links.</p>
            )}
            {drafted && (
              <div className="rounded-lg bg-violet-50 px-3 py-2.5 text-[13px] leading-relaxed text-violet-950">
                <p className="font-medium">This is a draft. Read it through: the check below is what counts, and it has been run on it.</p>
                {drafted.length > 0 && <ul className="mt-1.5 list-disc space-y-0.5 pl-5">{drafted.map((r, i) => <li key={i}>{r}</li>)}</ul>}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
              <Button variant="primary" busy={saving} disabled={!dirty} onClick={save}>{form.enabled && !state.live ? 'Save and post' : 'Save'}</Button>
              {dirty && <span className="text-[13px] text-stone-500">You have changes that are not saved.</span>}
              {!dirty && post.updated_at && <span className="text-[13px] text-stone-500">Saved {ago(post.updated_at)}{post.updated_by_name ? ` by ${post.updated_by_name}` : ''}.</span>}
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Confidentiality check" action={checked.ok ? <Badge tone="green" icon={ShieldCheck}>Nothing found</Badge> : <Badge tone="red" icon={CircleAlert}>{plural(checked.problems.length, 'thing')} to fix</Badge>} />
          <div className="space-y-4 p-4 text-sm leading-relaxed">
            {checked.problems.length > 0 && (
              <ul className="space-y-2">
                {checked.problems.map((p, i) => (
                  <li key={i} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-red-950">
                    <span className="min-w-0 flex-1 basis-64">{p.message}</span>
                    {p.can_overrule && isAdmin && <Button size="sm" busy={overruling} disabled={dirty} title={dirty ? 'Save the post first' : undefined} onClick={() => overrule(p)}>Overrule</Button>}
                  </li>
                ))}
              </ul>
            )}
            {checked.problems.length > 0 && (
              <p className="text-[13px] text-stone-500">
                The post cannot be public until these are gone.
                {checked.problems.some((p) => p.can_overrule) && (isAdmin
                  ? ` A single word that is plainly a false alarm (a client called North, in “North America”) can be overruled${dirty ? ' once the post is saved' : ''}.`
                  : ' An admin can overrule a single word that is plainly a false alarm (a client called North, in “North America”).')}
              </p>
            )}
            {checked.ok && <p className="text-stone-600">Nothing in the title, location or text gives {job.client_name} away, as far as the check can tell. It cannot know everything: read the advert as a stranger would before you post it.</p>}
            {checked.overruled.length > 0 && (
              <div>
                <h3 className="text-[13px] font-semibold text-stone-900">Overruled</h3>
                <ul className="mt-1.5 space-y-1.5">
                  {checked.overruled.map((o) => (
                    <li key={o.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg bg-stone-50 px-3 py-2 text-[13px] text-stone-700">
                      <span className="min-w-0 flex-1 basis-64">“{o.found}” in “{o.phrase}”: said not to be the client by {o.by || 'somebody who has left'}, {fmtDate(o.at, true)}.</span>
                      {isAdmin && <button type="button" onClick={() => withdraw(o)} className="text-xs font-medium text-stone-500 hover:text-red-700">Withdraw</button>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {checked.warnings.map((w, i) => (
              <p key={i} className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-950"><TriangleAlert className="mt-0.5 size-4 shrink-0" /><span>{w.message}</span></p>
            ))}
            {checked.client_advert_public && (
              <p className="text-[13px] text-stone-500">
                This job is also advertised in {job.client_name}’s name on <a href={`/careers/${job.client_slug}/${job.id}`} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">their careers page</a>, which anybody can read.
                Compare the two: a title, salary or sentence they share could be used to match them.
              </p>
            )}
            <details className="text-[13px] text-stone-500">
              <summary className="font-medium text-stone-700">What the check looks for</summary>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5">{checked.looked_for.map((x, i) => <li key={i}>{x}</li>)}</ul>
              <p className="mt-1.5">Capitals and accents make no difference, and a name broken up with dots, dashes or spaces is still found. It is run before the post goes public and again whenever the post, the job or the client is changed; a post that fails comes down until it is fixed.</p>
            </details>
          </div>
        </Card>
      </div>

      <div className="space-y-6">
        <Card className="overflow-hidden">
          <CardHeader title="Preview" action={<span className="text-xs text-stone-500">Exactly what the public sees</span>} />
          <div className="bg-white">
            <div className="flex items-center gap-2 px-5 py-3 text-sm font-semibold" style={{ background: board.color, color: '#fff' }}><EyeOff className="size-4 opacity-80" />{board.name}</div>
            <div className="px-5 py-6"><PostView board={board} post={preview} /></div>
          </div>
        </Card>
        <Card className="p-4 text-sm text-stone-600">
          <h3 className="text-sm font-semibold text-stone-900">Applications</h3>
          <p className="mt-1">
            {current.applied ? `${plural(current.applied, 'person has', 'people have')} applied through this post.` : 'Nobody has applied through this post yet.'}
            {' '}They land in this job like any other applicant, with the source “Our website” and no owner until a recruiter takes them, and they are sent your own confirmation e-mail, which does not name {job.client_name}.
          </p>
          <p className="mt-2 text-[13px] text-stone-500">The board’s name, colour and the websites it can be shown on are under <Link to="/settings?tab=agency#board" className="font-medium text-brand-700 hover:underline">Settings, Agency, Our job board</Link>.</p>
        </Card>
        {current.log.length > 0 && (
          <Card className="p-4">
            <h3 className="text-sm font-semibold text-stone-900">History</h3>
            <ul className="mt-2 space-y-1.5 text-[13px] text-stone-600">
              {current.log.map((l, i) => (
                <li key={i}><span className="font-medium text-stone-800">{LOG[l.kind] || l.kind}</span>{l.detail ? `: ${l.detail}` : ''} <span className="text-stone-400">· {l.user_name || 'The Book'}, {ago(l.created_at)}</span></li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
