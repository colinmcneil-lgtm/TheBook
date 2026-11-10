import React, { useEffect, useRef, useState } from 'react';
import { Ban, Building2, Check, Copy, ExternalLink, MapPin, NotebookPen, Pencil, Search, Sparkles } from 'lucide-react';
import { api, money, salaryRange, WORK_MODES, EMPLOYMENT } from '../lib.js';
import { useApp } from '../state.jsx';
import { Badge, Button, Card, Empty, Field, Input, Loading, Modal, Textarea, useAction, useToast } from '../ui.jsx';
import { locationClause, xraySearch, xrayUrl } from '../xray.js';
import JobAutofill from './JobAutofill.jsx';

// The recruiter brief for a job: everything someone sourcing for the role needs. Agency only.

const lines = (list) => (list || []).join('\n');
// One item per line, without the bullet, number or tick box a pasted list brings with it. A dash, star or number
// is only a marker when a space follows it, so "-5% travel" and "*nix" keep their first character; "o" (Word's
// second-level bullet) and "a." only when every line starts that way.
const SYMBOL = /^\s*(?:[•●▪■◦‣⁃∙·☐☑\uF0B7\uF0A7\uF0D8]\s*|(?:[*>–—-]|\[[ xX]?\]|\(?\d{1,2}[.)])\s+)/;
const LETTERED = /^\s*(?:o|\(?[a-zA-Z][.)])\s+(?=\S)/;
function toList(value) {
  const rows = value.split('\n').filter((l) => l.trim());
  const lettered = rows.length > 1 && rows.every((l) => LETTERED.test(l));
  return rows.map((l) => l.replace(lettered ? LETTERED : SYMBOL, '').trim()).filter(Boolean);
}
// A term of several words is searched as a phrase. Quotation marks already typed round or inside it are dropped
// first: doubled or stray ones break the whole string.
const quote = (term) => { const bare = term.replace(/["“”]/g, '').trim(); return /\s/.test(bare) ? `"${bare}"` : bare; };

/** A search string built from the titles and keywords, used when the recruiter has not written their own. */
function suggestedSearch(brief) {
  const titles = (brief.search_titles || []).map(quote);
  const keywords = (brief.search_keywords || []).map(quote);
  return [titles.length && `(${titles.join(' OR ')})`, keywords.length && `(${keywords.join(' OR ')})`].filter(Boolean).join(' AND ');
}

function Section({ title, icon: Icon, children, className }) {
  return (
    <Card className={className}>
      <div className="p-5">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-stone-900">{Icon && <Icon className="size-4 text-brand-600" />}{title}</h3>
        <div className="mt-3">{children}</div>
      </div>
    </Card>
  );
}
// Long unbroken text (a pasted link, say) wraps inside its box instead of running out of the card and the page.
const WRAP = '[overflow-wrap:anywhere]';
const Prose = ({ children }) => <p className={`max-w-prose text-sm leading-relaxed whitespace-pre-wrap text-stone-700 ${WRAP}`}>{children}</p>;
function Bullets({ items, icon: Icon = Check, tone = 'text-brand-600' }) {
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-stone-700"><Icon className={`mt-0.5 size-4 shrink-0 ${tone}`} /><span className={`min-w-0 ${WRAP}`}>{item}</span></li>
      ))}
    </ul>
  );
}
const Chips = ({ items }) => <div className="flex flex-wrap gap-1.5">{items.map((item, i) => <Badge key={i} className={`max-w-full !rounded-xl !text-[13px] !whitespace-normal ${WRAP}`}>{item}</Badge>)}</div>;
const Label = ({ children }) => <div className="mb-1.5 text-xs font-medium tracking-wide text-stone-500 uppercase">{children}</div>;

export default function JobBrief({ job, stages }) {
  const toast = useToast();
  const { user, isAdmin } = useApp();
  const canEdit = isAdmin || (job.account_executive_id != null && job.account_executive_id === user.id); // the brief belongs to the job's account executive
  const owner = job.account_executive_name; // nobody, for a job that has no account executive
  const [editing, setEditing] = useState(false);
  const brief = job.brief || {};
  const has = (key) => (Array.isArray(brief[key]) ? brief[key].length > 0 : Boolean(brief[key]));
  const empty = !Object.keys(brief).length && !job.ideal_profile;
  const search = brief.search_string || suggestedSearch(brief);
  // Where to look for people. It starts from the brief (or the job's own location) and anyone searching can change
  // it for themselves: what they type is remembered on their computer for this job, not saved to the brief.
  const placeKey = `thebook.searchplace.${job.id}`;
  const savedPlace = brief.search_location || job.location || '';
  const [place, setPlace] = useState(() => { try { return localStorage.getItem(placeKey) ?? savedPlace; } catch { return savedPlace; } });
  const changePlace = (value) => {
    setPlace(value);
    try { if (value === savedPlace) localStorage.removeItem(placeKey); else localStorage.setItem(placeKey, value); } catch { /* private window: it still works for this visit */ }
  };
  const placeClause = locationClause(place);
  const range = salaryRange(job.salary_min, job.salary_max, job.currency);
  const fee = job.fee_percent > 0 && (job.salary_min || job.salary_max)
    ? [job.salary_min, job.salary_max].filter(Boolean).map((s) => money((s * job.fee_percent) / 100, job.currency)).join(' – ')
    : null;
  const copy = async (value, what) => { try { await navigator.clipboard.writeText(value); toast(`${what} copied`); } catch { window.prompt('Copy this', value); } };

  if (empty) {
    return (
      <>
        <Card>
          <Empty icon={NotebookPen} title="No brief for this role yet" action={canEdit && <Button variant="primary" icon={Pencil} onClick={() => setEditing(true)}>Write the brief</Button>}>
            {canEdit
              ? 'Give your recruiters what they need to start sourcing: must-haves, where to look, what to search for, the pay and how to sell the role.'
              : owner ? `${owner} is this job’s account executive and can write its brief. An admin can too.` : 'This job has no account executive, so only an admin can write its brief.'}
          </Empty>
        </Card>
        {editing && <BriefForm job={job} onClose={() => setEditing(false)} />}
      </>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-6">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-violet-200 bg-violet-50/60 px-4 py-2.5 text-[13px] text-violet-900">
          <span>
            This brief is for your recruiters. The client’s hiring team cannot see it.
            {!canEdit && ` Only ${owner ? `${owner} (the account executive) or an admin` : 'an admin'} can change it.`}
          </span>
          {canEdit && <Button size="sm" icon={Pencil} onClick={() => setEditing(true)}>Edit brief</Button>}
        </div>

        {(has('about') || job.ideal_profile) && (
          <Section title="About the role">
            <div className="space-y-4">
              {has('about') && <Prose>{brief.about}</Prose>}
              {job.ideal_profile && <div><Label>Who we are looking for</Label><Prose>{job.ideal_profile}</Prose></div>}
            </div>
          </Section>
        )}

        {(has('must_haves') || has('nice_to_haves') || has('not_a_fit')) && (
          <Section title="Who to look for">
            <div className="grid gap-6 sm:grid-cols-2">
              {has('must_haves') && <div className="sm:col-span-2"><Label>Must-haves</Label><Bullets items={brief.must_haves} /></div>}
              {has('nice_to_haves') && <div><Label>Nice to have</Label><Bullets items={brief.nice_to_haves} icon={Sparkles} tone="text-amber-500" /></div>}
              {has('not_a_fit') && <div><Label>Not a fit</Label><Bullets items={brief.not_a_fit} icon={Ban} tone="text-red-500" /></div>}
            </div>
          </Section>
        )}

        {(has('target_companies') || has('where_to_look') || has('locations')) && (
          <Section title="Where to look" icon={Building2}>
            <div className="space-y-5">
              {has('target_companies') && <div><Label>Companies to look in</Label><Chips items={brief.target_companies} /></div>}
              {has('where_to_look') && <div><Label>Places to find them</Label><Bullets items={brief.where_to_look} icon={MapPin} /></div>}
              {has('locations') && <div><Label>Where they can be based</Label><Prose>{brief.locations}</Prose></div>}
            </div>
          </Section>
        )}

        {(has('search_titles') || has('search_keywords') || search) && (
          <Section title="What to search for" icon={Search}>
            <div className="space-y-5">
              {has('search_titles') && <div><Label>Job titles</Label><Chips items={brief.search_titles} /></div>}
              {has('search_keywords') && <div><Label>Keywords</Label><Chips items={brief.search_keywords} /></div>}
              {search && (
                <div>
                  <Label>{brief.search_string ? 'Search string' : 'Suggested search string'}</Label>
                  <code className="block rounded-lg bg-stone-900 px-3.5 py-3 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-stone-100">{search}</code>
                  <div className="mt-3 max-w-md">
                    <label htmlFor="search-place" className="mb-1.5 block text-xs font-medium tracking-wide text-stone-500 uppercase">Location</label>
                    <div className="relative">
                      <MapPin className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-stone-400" aria-hidden="true" />
                      <Input id="search-place" value={place} onChange={(e) => changePlace(e.target.value)} placeholder="San Francisco Bay Area" className="!pl-8" autoComplete="off" />
                    </div>
                    <p className={`mt-1.5 text-xs text-stone-500 ${WRAP}`}>
                      {placeClause
                        ? <>Search with Google looks for people in <span className="font-mono text-[12px] text-stone-700">{placeClause}</span>. For several places, put “or” between them.</>
                        : 'Add a place and Search with Google only brings up people there. Without one, Google leans towards wherever you are.'}
                      {place !== savedPlace && <> <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => changePlace(savedPlace)}>{savedPlace ? `Back to ${savedPlace}` : 'Clear'}</button></>}
                    </p>
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button size="sm" icon={Copy} onClick={() => copy(search, 'Search string')}>Copy</Button>
                    <a href={`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(search)}`} target="_blank" rel="noopener noreferrer"><Button size="sm" icon={ExternalLink}>Search on LinkedIn</Button></a>
                    <a href={xrayUrl(search, place)} target="_blank" rel="noopener noreferrer"><Button size="sm" icon={ExternalLink}>Search with Google</Button></a>
                    <Button size="sm" variant="ghost" icon={Copy} onClick={() => copy(xraySearch(search, place), 'Google search')}>Copy the Google search</Button>
                  </div>
                </div>
              )}
            </div>
          </Section>
        )}

        {has('screening_questions') && (
          <Section title="Questions for the first call">
            <ol className={`list-decimal space-y-2 pl-5 text-sm leading-relaxed text-stone-700 ${WRAP}`}>{brief.screening_questions.map((qn, i) => <li key={i}>{qn}</li>)}</ol>
          </Section>
        )}
      </div>

      <div className="min-w-0 space-y-6">
        <Section title="Pay">
          <dl className="space-y-3 text-sm">
            <div><dt className="text-[13px] text-stone-500">Salary</dt><dd className="text-lg font-semibold tracking-tight text-stone-900">{range || 'Not set'}</dd></div>
            {has('pay_notes') && <div><dt className="text-[13px] text-stone-500">Bonus, equity and benefits</dt><dd className={`leading-relaxed whitespace-pre-wrap text-stone-700 ${WRAP}`}>{brief.pay_notes}</dd></div>}
            {has('pay_flex') && <div><dt className="text-[13px] text-stone-500">Room to move</dt><dd className={`leading-relaxed whitespace-pre-wrap text-stone-700 ${WRAP}`}>{brief.pay_flex}</dd></div>}
            {fee && <div className="border-t border-line pt-3"><dt className="text-[13px] text-stone-500">Your fee at {job.fee_percent}%</dt><dd className="font-medium text-stone-900">{fee}</dd></div>}
          </dl>
        </Section>

        {has('selling_points') && <Section title="How to sell it" icon={Sparkles}><Bullets items={brief.selling_points} /></Section>}

        <Section title="The role at a glance">
          <dl className="divide-y divide-line text-sm">
            {[['Client', job.client_name], ['Account executive', job.account_executive_name || 'Not set'],
              // Who created the job is only worth a line once it has been handed to somebody else.
              ['Job created by', job.created_by !== job.account_executive_id && job.created_by_name], ['Location', [job.location, WORK_MODES[job.work_mode]].filter(Boolean).join(' · ')], ['Contract', EMPLOYMENT[job.employment_type]],
              ['Openings', `${job.hires} of ${job.openings} filled`], ['Hiring manager', job.hiring_manager_name]].filter(([, v]) => v).map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 py-1.5"><dt className="text-stone-500">{label}</dt><dd className="text-right font-medium text-stone-800">{value}</dd></div>
            ))}
          </dl>
        </Section>

        <Section title="Interview process">
          <ol className="space-y-1 text-sm text-stone-700">{stages.map((s, i) => <li key={s.id}><span className="tabular mr-2 text-stone-400">{i + 1}</span>{s.name}</li>)}</ol>
          {has('process_notes') && <p className={`mt-3 border-t border-line pt-3 text-sm leading-relaxed whitespace-pre-wrap text-stone-700 ${WRAP}`}>{brief.process_notes}</p>}
        </Section>
      </div>

      {editing && <BriefForm job={job} onClose={() => setEditing(false)} />}
    </div>
  );
}

const LISTS = ['must_haves', 'nice_to_haves', 'not_a_fit', 'target_companies', 'where_to_look', 'search_titles', 'search_keywords', 'selling_points', 'screening_questions'];
const TEXTS = ['about', 'locations', 'search_string', 'search_location', 'pay_notes', 'pay_flex', 'process_notes'];

const LABELS = { about: 'The role, the team and why it is open', ideal_profile: 'Who we are looking for', must_haves: 'Must-haves', nice_to_haves: 'Nice to have', not_a_fit: 'Not a fit',
  target_companies: 'Companies to look in', where_to_look: 'Places to find them', locations: 'Where they can be based', search_titles: 'Job titles', search_keywords: 'Keywords',
  search_string: 'Search string', search_location: 'Search location', pay_notes: 'Bonus, equity and benefits', pay_flex: 'Room to move', selling_points: 'How to sell it', screening_questions: 'Questions for the first call', process_notes: 'Process notes' };

/** The form opens on the brief as it is saved now: the page behind it may have been open since before a colleague changed it. */
function BriefForm({ job, onClose }) {
  const [current, setCurrent] = useState(null);
  useEffect(() => {
    let live = true;
    api.get(`/jobs/${job.id}`).then((data) => live && setCurrent(data.job)).catch(() => live && setCurrent(job));
    return () => { live = false; };
  }, [job.id]);
  if (!current) return <Modal title="Recruiter brief" size="lg" onClose={onClose}><Loading /></Modal>;
  return <BriefEditor job={current} onClose={onClose} />;
}

function BriefEditor({ job, onClose }) {
  const { bump } = useApp();
  const toast = useToast();
  const brief = job.brief || {};
  const [form, setForm] = useState(() => ({
    ideal_profile: job.ideal_profile || '',
    ...Object.fromEntries(TEXTS.map((k) => [k, brief[k] || ''])),
    ...Object.fromEntries(LISTS.map((k) => [k, lines(brief[k])])),
  }));
  const opened = useRef(form);
  const latest = useRef(form);
  latest.current = form;
  const bind = (key) => ({ value: form[key], onChange: (e) => setForm((f) => ({ ...f, [key]: e.target.value })) });
  const [save, busy] = useAction(async () => {
    await api.put(`/jobs/${job.id}/brief`, {
      version: job.brief_version, // refused if someone else has saved the brief since this form opened
      ideal_profile: form.ideal_profile,
      brief: { ...Object.fromEntries(TEXTS.map((k) => [k, form[k]])), ...Object.fromEntries(LISTS.map((k) => [k, toList(form[k])])) },
    });
    toast('Brief saved');
    bump();
    onClose();
  });
  // Escape, a click outside and Cancel all close the form; with sixteen boxes of typing in it, they ask first.
  const close = () => {
    const changed = Object.keys(form).some((key) => form[key] !== opened.current[key]);
    if (!changed || window.confirm('Close without saving? What you have typed in the brief will be lost.')) onClose();
  };
  const list = (key, label, placeholder, rows = 4) => (
    <Field label={label} hint="One per line."><Textarea rows={rows} {...bind(key)} placeholder={placeholder} /></Field>
  );
  const heading = (title) => <h3 className="border-t border-line pt-4 text-sm font-semibold text-stone-900 first:border-0 first:pt-0">{title}</h3>;
  // A draft only fills sections that are still empty, so nothing already written is replaced. The panel is told
  // what that came to, so it does not say notes were kept when the section they would go in already had text.
  const applyDraft = (result) => {
    const now = latest.current, filled = [], skipped = [];
    const sort = (key, has) => { if (has) (now[key].trim() ? skipped : filled).push(key); };
    for (const key of TEXTS) sort(key, Boolean(result.brief[key]));
    for (const key of LISTS) sort(key, Boolean(result.brief[key]?.length));
    sort('ideal_profile', Boolean(result.ideal_profile));
    setForm((f) => {
      const next = { ...f };
      for (const key of TEXTS) if (!f[key].trim() && result.brief[key]) next[key] = result.brief[key];
      for (const key of LISTS) if (!f[key].trim() && result.brief[key]?.length) next[key] = lines(result.brief[key]);
      if (!f.ideal_profile.trim() && result.ideal_profile) next.ideal_profile = result.ideal_profile;
      return next;
    });
    const names = (keys) => keys.map((key) => `“${LABELS[key]}”`).join(', ');
    return {
      notesUsed: filled.includes('about'),
      note: [filled.length ? `Filled in ${names(filled)}.` : 'Nothing was added to the brief.',
        skipped.length ? `Left alone because ${skipped.length === 1 ? 'it already has' : 'they already have'} text: ${names(skipped)}.` : '',
        result.notes && skipped.includes('about') ? 'So the intake notes were not added: paste them into that box yourself if you want them kept.' : ''].filter(Boolean).join(' '),
    };
  };

  return (
    <Modal title="Recruiter brief" subtitle={`${job.title} · ${job.client_name}. Only your agency sees this.`} size="lg" onClose={close} onSubmit={save}
      footer={<><Button onClick={close}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Save brief</Button></>}>
      <JobAutofill collapsible what="the brief" onResult={applyDraft} />
      {heading('About the role')}
      <Field label="The role, the team and why it is open"><Textarea rows={4} {...bind('about')} placeholder="What the person will own, who they report to, how big the team is, why the role exists now." /></Field>
      <Field label="Who we are looking for"><Textarea rows={3} {...bind('ideal_profile')} placeholder="The ideal person in a few sentences, including what the hiring manager cares about most." /></Field>

      {heading('Who to look for')}
      {list('must_haves', 'Must-haves', '5+ years in B2B sales\nHas managed a team of 5 or more\nRight to work in the UK')}
      <div className="grid gap-4 sm:grid-cols-2">
        {list('nice_to_haves', 'Nice to have', 'Logistics or freight background\nExperience opening a new region')}
        {list('not_a_fit', 'Not a fit', 'Job-hoppers (under 18 months per role)\nPure account managers with no new business')}
      </div>

      {heading('Where to look')}
      <div className="grid gap-4 sm:grid-cols-2">
        {list('target_companies', 'Companies to look in', 'Brightwater\nCoppermill\nVarsity Freight')}
        {list('where_to_look', 'Places to find them', 'LinkedIn: 2nd-degree connections of the hiring manager\nIndustry Slack communities\nSpeakers at trade events')}
      </div>
      <Field label="Where they can be based"><Textarea rows={2} {...bind('locations')} placeholder="Within an hour of Manchester; in the office three days a week." /></Field>

      {heading('What to search for')}
      <div className="grid gap-4 sm:grid-cols-2">
        {list('search_titles', 'Job titles', 'Head of Sales\nSales Director\nRegional Sales Manager', 3)}
        {list('search_keywords', 'Keywords', 'logistics\nfreight\nB2B', 3)}
      </div>
      <Field label="Search string" hint="Optional. If you leave it empty, one is built from the titles and keywords above.">
        <Textarea rows={2} {...bind('search_string')} placeholder='("Head of Sales" OR "Sales Director") AND (logistics OR freight) NOT recruiter' className="font-mono text-[13px]" />
      </Field>
      <Field label="Search location" hint="Where to look for people, for example “San Francisco Bay Area” or “Toronto or Ottawa”. Search with Google adds it to the search. If you leave it empty, the job’s own location is used.">
        <Input {...bind('search_location')} placeholder="San Francisco Bay Area" />
      </Field>

      {heading('Pay')}
      <p className="text-[13px] text-stone-500">The salary range itself is set on the job (Edit, on the Advert and setup tab): {salaryRange(job.salary_min, job.salary_max, job.currency) || 'not set yet'}.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Bonus, equity and benefits"><Textarea rows={3} {...bind('pay_notes')} placeholder="20% bonus, car allowance, private health." /></Field>
        <Field label="Room to move"><Textarea rows={3} {...bind('pay_flex')} placeholder="Could stretch to 100k for someone exceptional. Sign-on possible to cover a lost bonus." /></Field>
      </div>

      {heading('Selling the role and screening')}
      <div className="grid gap-4 sm:grid-cols-2">
        {list('selling_points', 'How to sell it', 'Reports to the founder\nProfitable and growing 40% a year\nBuild the team your way')}
        {list('screening_questions', 'Questions for the first call', 'What is the largest deal you have closed personally?\nWhy are you looking now?')}
      </div>
      <Field label="Process notes"><Textarea rows={2} {...bind('process_notes')} placeholder="Hiring manager wants CVs in batches of three. Feedback within 48 hours. Final stage is in person." /></Field>
    </Modal>
  );
}
