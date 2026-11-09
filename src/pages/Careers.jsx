import React, { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CircleCheck, MapPin } from 'lucide-react';
import { api, salaryRange, WORK_MODES, EMPLOYMENT, firstName, extUrl } from '../lib.js';
import { Button, Checkbox, Field, Input, Loading, Textarea, useAction } from '../ui.jsx';

// Public, candidate-facing pages. Each client gets /careers/<slug>, styled with their brand colour.

function usePublic(path) {
  const [state, setState] = useState({ data: null, error: null });
  useEffect(() => {
    let live = true;
    api.get(path).then((data) => live && setState({ data, error: null })).catch((err) => live && setState({ data: null, error: err.message }));
    return () => { live = false; };
  }, [path]);
  return state;
}

/** Pick white or near-black text for a given background colour. */
function inkOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#1c1917' : '#ffffff';
}

function Shell({ client, children, compact }) {
  const ink = inkOn(client.brand_color);
  return (
    <div className="min-h-full bg-white">
      <header style={{ background: client.brand_color, color: ink }}>
        <div className={`mx-auto max-w-3xl px-5 ${compact ? 'py-5' : 'py-12 sm:py-16'}`}>
          <Link to={`/careers/${client.slug}`} className="text-sm font-semibold tracking-wide uppercase opacity-90 hover:opacity-100">{client.name}</Link>
          {!compact && (
            <>
              <h1 className="mt-4 max-w-2xl text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">{client.tagline || `Careers at ${client.name}`}</h1>
              <p className="mt-3 text-sm opacity-80">{[client.industry, client.location].filter(Boolean).join(' · ')}</p>
            </>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-10">{children}</main>
      <footer className="mx-auto max-w-3xl px-5 pb-10 text-xs text-stone-400">
        © {new Date().getFullYear()} {client.name}
        {extUrl(client.website) && <> · <a href={extUrl(client.website)} rel="noopener noreferrer" className="hover:text-stone-600">{client.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a></>}
      </footer>
    </div>
  );
}

function Missing({ message }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-white px-6 text-center">
      <div>
        <p className="text-lg font-semibold text-stone-900">{message || 'This page could not be found.'}</p>
        <p className="mt-1 text-sm text-stone-500">The link may be out of date.</p>
      </div>
    </div>
  );
}

const jobMeta = (job, currency) => [job.location, WORK_MODES[job.work_mode], EMPLOYMENT[job.employment_type], salaryRange(job.salary_min, job.salary_max, currency)].filter(Boolean);

export function Careers() {
  const { slug } = useParams();
  const { data, error } = usePublic(`/public/careers/${slug}`);
  useEffect(() => { if (data) document.title = `Careers at ${data.client.name}`; }, [data]);
  if (error) return <Missing message={error} />;
  if (!data) return <Loading className="h-full" />;
  const { client, jobs } = data;
  const departments = [...new Set(jobs.map((j) => j.department || 'Open roles'))];

  return (
    <Shell client={client}>
      {client.about && (
        <section className="mb-12">
          <h2 className="text-sm font-semibold tracking-wide text-stone-500 uppercase">About us</h2>
          <p className="mt-3 text-[17px] leading-relaxed whitespace-pre-wrap text-stone-700">{client.about}</p>
        </section>
      )}
      <section>
        <h2 className="text-sm font-semibold tracking-wide text-stone-500 uppercase">Open roles{jobs.length ? ` (${jobs.length})` : ''}</h2>
        {!jobs.length && <p className="mt-4 rounded-xl border border-line px-5 py-8 text-center text-stone-600">There are no open roles right now. Please check back soon.</p>}
        {departments.map((dept) => (
          <div key={dept} className="mt-6">
            {departments.length > 1 && <h3 className="mb-2 text-base font-semibold text-stone-900">{dept}</h3>}
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
              {jobs.filter((j) => (j.department || 'Open roles') === dept).map((j) => (
                <li key={j.id}>
                  <Link to={`/careers/${client.slug}/${j.id}`} className="group flex items-center gap-4 px-5 py-4 hover:bg-stone-50">
                    <span className="min-w-0 flex-1">
                      <span className="block text-[17px] font-medium text-stone-900 group-hover:underline">{j.title}</span>
                      <span className="mt-0.5 block text-sm text-stone-500">{jobMeta(j, client.currency).join(' · ')}</span>
                    </span>
                    <ArrowRight className="size-5 shrink-0 text-stone-400 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </Shell>
  );
}

export function CareersJob() {
  const { slug, jobId } = useParams();
  const [params] = useSearchParams();
  const { data, error } = usePublic(`/public/careers/${slug}/jobs/${jobId}`);
  const [form, setForm] = useState({ name: '', email: '', phone: '', linkedin: '', location: '', cover_note: '', company_website: '' });
  const [answers, setAnswers] = useState({});
  const [file, setFile] = useState(null);
  const [consent, setConsent] = useState(false);
  const [done, setDone] = useState(false);
  const bind = (key) => ({ value: form[key], onChange: (e) => setForm((f) => ({ ...f, [key]: e.target.value })) });
  useEffect(() => { if (data) document.title = `${data.job.title} at ${data.client.name}`; }, [data]);

  const [submit, busy] = useAction(async () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) fd.append(k, v);
    fd.append('answers', JSON.stringify(answers));
    fd.append('consent', consent ? 'yes' : 'no');
    if (params.get('src')) fd.append('source', params.get('src'));
    if (file) fd.append('resume', file);
    await api.post(`/public/careers/${slug}/jobs/${jobId}/apply`, fd);
    setDone(true);
    window.scrollTo({ top: 0 });
  });

  if (error) return <Missing message={error} />;
  if (!data) return <Loading className="h-full" />;
  const { client, job } = data;
  const accent = { background: client.brand_color, color: inkOn(client.brand_color), borderColor: 'transparent' };

  if (done) {
    return (
      <Shell client={client} compact>
        <div className="py-12 text-center">
          <CircleCheck className="mx-auto size-12" style={{ color: client.brand_color }} />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-stone-900">Thank you, {firstName(form.name)}.</h1>
          <p className="mx-auto mt-2 max-w-md text-stone-600">Your application for {job.title} is with the {client.name} hiring team. We read every application and will be in touch by email.</p>
          <Link to={`/careers/${client.slug}`} className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-stone-700 hover:underline"><ArrowLeft className="size-4" />See all open roles</Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell client={client} compact>
      <Link to={`/careers/${client.slug}`} className="inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-800"><ArrowLeft className="size-4" />All open roles</Link>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight text-stone-900">{job.title}</h1>
      <p className="mt-2 flex items-start gap-2 text-stone-600"><MapPin className="mt-1 size-4 shrink-0" /><span>{jobMeta(job, client.currency).join(' · ')}</span></p>
      <a href="#apply" className="mt-5 inline-flex h-10 items-center rounded-lg px-4 text-sm font-semibold" style={accent}>Apply for this role</a>

      {job.description && <div className="mt-8 text-[16px] leading-relaxed whitespace-pre-wrap text-stone-700">{job.description}</div>}

      <form id="apply" className="mt-12 scroll-mt-6 rounded-2xl border border-line bg-stone-50 p-5 sm:p-7" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h2 className="text-xl font-semibold tracking-tight text-stone-900">Apply for this role</h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Field label="Full name"><Input {...bind('name')} required autoComplete="name" /></Field>
          <Field label="Email"><Input type="email" {...bind('email')} required autoComplete="email" /></Field>
          <Field label="Phone (optional)"><Input type="tel" {...bind('phone')} autoComplete="tel" /></Field>
          <Field label="Where are you based? (optional)"><Input {...bind('location')} /></Field>
          <Field label="LinkedIn or website (optional)" className="sm:col-span-2"><Input {...bind('linkedin')} placeholder="https://" /></Field>
          <Field label="Résumé / CV" hint="PDF, Word, RTF or text, up to 8 MB." className="sm:col-span-2">
            <input type="file" accept=".pdf,.doc,.docx,.rtf,.txt" onChange={(e) => setFile(e.target.files[0] || null)}
              className="block w-full rounded-lg border border-line bg-white text-sm text-stone-600 file:mr-3 file:h-10 file:border-0 file:border-r file:border-line file:bg-stone-100 file:px-4 file:text-sm file:font-medium file:text-stone-800" />
          </Field>
          {job.questions.map((q) => q.type === 'yesno' ? (
            // A fieldset, not a <label>: wrapping radios in one label would make a click on the question text pick "Yes".
            <fieldset key={q.id} className="sm:col-span-2">
              <legend className="mb-1 block text-[13px] font-medium text-stone-700">{`${q.label}${q.required ? '' : ' (optional)'}`}</legend>
              <span className="flex gap-5 pt-1">
                {['Yes', 'No'].map((option) => (
                  <label key={option} className="flex items-center gap-2 text-sm text-stone-800">
                    <input type="radio" name={q.id} value={option} required={q.required} checked={answers[q.id] === option} onChange={() => setAnswers((a) => ({ ...a, [q.id]: option }))} className="size-4" style={{ accentColor: client.brand_color }} />
                    {option}
                  </label>
                ))}
              </span>
            </fieldset>
          ) : (
            <Field key={q.id} label={`${q.label}${q.required ? '' : ' (optional)'}`} className="sm:col-span-2">
              {q.type === 'long' ? (
                <Textarea rows={4} required={q.required} value={answers[q.id] || ''} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} />
              ) : (
                <Input required={q.required} value={answers[q.id] || ''} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} />
              )}
            </Field>
          ))}
          <Field label="Anything else you would like us to know? (optional)" className="sm:col-span-2"><Textarea rows={4} {...bind('cover_note')} /></Field>
          {/* Honeypot: hidden from people, tempting for bots. */}
          <input type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" {...bind('company_website')} className="absolute -left-[9999px] h-0 w-0 opacity-0" />
        </div>
        <div className="mt-5">
          <Checkbox checked={consent} onChange={(e) => setConsent(e.target.checked)} required
            label={`I agree that ${client.name} and its recruitment partner${data.agencyName ? `, ${data.agencyName},` : ''} may store and process my details to consider me for this role.`} />
          {extUrl(client.privacy_url) && (
            <p className="mt-1.5 pl-[26px] text-xs text-stone-500">
              See how your information is used in the <a href={extUrl(client.privacy_url)} target="_blank" rel="noopener noreferrer" className="underline hover:text-stone-800">privacy notice</a>.
            </p>
          )}
        </div>
        <Button type="submit" busy={busy} className="mt-6 !h-11 w-full !text-[15px] font-semibold sm:w-auto sm:!px-8" style={accent}>Submit application</Button>
      </form>
    </Shell>
  );
}
