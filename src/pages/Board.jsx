import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Banknote, Briefcase, CircleCheck, Clock, EyeOff, MapPin, Search } from 'lucide-react';
import { api, salaryRange, WORK_MODES, EMPLOYMENT, firstName, extUrl, plural } from '../lib.js';
import { Button, Checkbox, Field, Input, Loading, Select, Textarea, useAction } from '../ui.jsx';

// The agency's own job board: public pages in the agency's name, listing its confidential posts. Nothing here knows
// which client a post is for: the pages are drawn from what the public routes send, which is the post's own title,
// location and text and a few facts about the job.
//
// The same pages are shown inside the agency's website (the snippet in Settings puts them in a frame, with ?embed=1
// in the address). Shown that way they leave out their own header and footer, since the website has its own, and
// tell the page around them how tall they are so the frame can be sized to fit.

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

/** Whether the board is being shown inside another website's page. */
const useEmbedded = () => new URLSearchParams(useLocation().search).get('embed') === '1';
/** An address on the board that stays inside the frame when the board is embedded. */
const boardPath = (token, embedded) => `/board${token ? `/${token}` : ''}${embedded ? '?embed=1' : ''}`;

/** The page's name in the tab and what a link preview says about it: the agency and the role, never anything else. */
function useHead(title, description) {
  useEffect(() => {
    if (!title) return;
    document.title = title;
    const set = (selector, value) => document.head.querySelector(selector)?.setAttribute('content', value);
    set('meta[property="og:title"]', title);
    if (description) for (const selector of ['meta[name="description"]', 'meta[property="og:description"]']) set(selector, description);
  }, [title, description]);
}

/**
 * Tell the page around the frame how tall the board is, whenever that changes, and ask it to bring the top of the
 * board into view when the visitor moves from the list to a post or back. The message says nothing but that.
 */
function useFrameSize(box, embedded, at) {
  useLayoutEffect(() => {
    if (!embedded || !box.current || window.parent === window) return undefined;
    const tell = () => window.parent.postMessage({ board: 'the-book', height: Math.ceil(box.current.getBoundingClientRect().height) }, '*');
    tell();
    const watcher = new ResizeObserver(tell);
    watcher.observe(box.current);
    return () => watcher.disconnect();
  }, [embedded, box]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (embedded && window.parent !== window) window.parent.postMessage({ board: 'the-book', top: true }, '*');
    else window.scrollTo({ top: 0 });
  }, [at, embedded]);
}

function Logo({ board, size = 36 }) {
  if (!board.logo) return null;
  return <img src={`/api/public/board/logo?v=${board.logo}`} alt="" width={size} height={size} className="shrink-0 rounded-lg bg-white object-contain" style={{ width: size, height: size }} />;
}

function Shell({ board, embedded, at, hero, children }) {
  const box = useRef(null);
  useFrameSize(box, embedded, at);
  // The workspace's page colour is not the board's: on its own the board is white, and inside another page it shows that page through.
  useEffect(() => {
    const before = document.body.style.background;
    document.body.style.background = embedded ? 'transparent' : '#ffffff';
    return () => { document.body.style.background = before; };
  }, [embedded]);
  const ink = inkOn(board.color);
  if (embedded) return <div ref={box} className="px-1 pt-1 pb-6 text-stone-900">{children}</div>;
  return (
    <div ref={box} className="flex min-h-full flex-col bg-white">
      <header style={{ background: board.color, color: ink }}>
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-5 py-4">
          <Link to="/board" className="flex min-w-0 items-center gap-3">
            <Logo board={board} />
            <span className="truncate text-[17px] font-semibold tracking-tight">{board.name}</span>
          </Link>
          <span className="ml-auto hidden text-sm opacity-80 sm:block">Careers</span>
        </div>
        {hero}
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-5 pb-14">{children}</main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-4 gap-y-1 px-5 py-5 text-xs text-stone-500">
          <span>© {new Date().getFullYear()} {board.name}</span>
          {extUrl(board.privacy_url) && <a href={extUrl(board.privacy_url)} target="_blank" rel="noopener noreferrer" className="underline hover:text-stone-800">Privacy notice</a>}
        </div>
      </footer>
    </div>
  );
}

function Missing({ message }) {
  return (
    <div className="flex min-h-64 items-center justify-center bg-white px-6 py-16 text-center">
      <div>
        <p className="text-lg font-semibold text-stone-900">{message || 'This page could not be found.'}</p>
        <p className="mt-1 text-sm text-stone-500">The link may be out of date.</p>
        <Link to={boardPath(null, new URLSearchParams(window.location.search).get('embed') === '1')} className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-stone-700 hover:underline"><ArrowLeft className="size-4" />See all open roles</Link>
      </div>
    </div>
  );
}

/** How long ago a post went up, by the day: that is all the board is told. */
function postedAgo(day) {
  const days = Math.max(0, Math.round((new Date(new Date().toDateString()) - new Date(`${day}T00:00`)) / 86400000));
  if (days === 0) return 'Posted today';
  if (days === 1) return 'Posted yesterday';
  if (days < 30) return `Posted ${days} days ago`;
  return `Posted ${new Date(`${day}T00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}
const salaryOf = (post) => (post.salary ? salaryRange(post.salary.min, post.salary.max, post.salary.currency) : '');

/** The facts under a post's title: where, how, on what contract and, when the agency shows it, for how much. */
function Facts({ post, className = '' }) {
  const facts = [[MapPin, post.location], [Briefcase, [WORK_MODES[post.work_mode], EMPLOYMENT[post.employment_type]].filter(Boolean).join(' · ')], [Banknote, salaryOf(post)]].filter(([, value]) => value);
  return (
    <span className={`flex flex-wrap gap-x-4 gap-y-1 text-sm text-stone-600 ${className}`}>
      {facts.map(([Icon, value]) => <span key={value} className="inline-flex items-center gap-1.5"><Icon className="size-4 shrink-0 text-stone-400" />{value}</span>)}
    </span>
  );
}
const Confidential = () => (
  <span className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-stone-600"><EyeOff className="size-3" />Confidential employer</span>
);

const BULLET = /^\s*[•●▪◦*·\-–—]\s+/;
/**
 * The advert as it was typed (plain text, with line breaks and "• " bullets), set out for reading: a short line
 * standing over a list is a heading, bulleted lines are a list, and everything else is a paragraph. Nothing is added
 * and nothing is left out.
 */
function AdvertText({ text }) {
  const blocks = [];
  const lines = String(text || '').split('\n').map((line) => line.trim());
  lines.forEach((line, i) => {
    const last = blocks.at(-1);
    if (!line) { if (last) last.closed = true; return; }
    if (BULLET.test(line)) {
      if (last?.list && !last.closed) last.items.push(line.replace(BULLET, ''));
      else blocks.push({ list: true, items: [line.replace(BULLET, '')] });
    } else if (line.length <= 60 && !/[.!?,;]$/.test(line) && BULLET.test(lines[i + 1] || '')) {
      blocks.push({ heading: line.replace(/:$/, ''), closed: true });
    } else if (last?.lines && !last.closed) last.lines.push(line);
    else blocks.push({ lines: [line] });
  });
  return (
    <div className="max-w-prose space-y-4 text-[16px] leading-relaxed text-stone-700">
      {blocks.map((b, i) => (b.heading ? <h2 key={i} className="pt-2 text-[17px] font-semibold tracking-tight text-stone-900">{b.heading}</h2>
        : b.list ? <ul key={i} className="list-disc space-y-1.5 pl-5 marker:text-stone-400">{b.items.map((item, n) => <li key={n}>{item}</li>)}</ul>
        : <p key={i}>{b.lines.map((line, n) => <React.Fragment key={n}>{n > 0 && <br />}{line}</React.Fragment>)}</p>))}
    </div>
  );
}

export function Board() {
  const embedded = useEmbedded();
  const { data, error } = usePublic('/public/board');
  const [search, setSearch] = useState('');
  const [place, setPlace] = useState('');
  const [mode, setMode] = useState('');
  useHead(data && `Jobs | ${data.board.name}`, data?.board.intro);
  const places = useMemo(() => [...new Set((data?.posts || []).map((p) => p.location).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [data]);
  const modes = useMemo(() => Object.keys(WORK_MODES).filter((m) => (data?.posts || []).some((p) => p.work_mode === m)), [data]);
  if (error) return <Missing message={error} />;
  if (!data) return <Loading className="h-full" />;
  const { board, posts } = data;
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = posts.filter((p) => (!place || p.location === place) && (!mode || p.work_mode === mode)
    && words.every((w) => `${p.title} ${p.location} ${WORK_MODES[p.work_mode]} ${EMPLOYMENT[p.employment_type]}`.toLowerCase().includes(w)));
  const filtered = Boolean(search || place || mode);

  const filters = (
    <div className={`grid gap-2 rounded-xl border border-line bg-white p-2 text-stone-900 shadow-sm sm:grid-cols-[1fr_auto_auto] ${embedded ? '' : 'shadow-lg shadow-stone-900/5'}`}>
      <label className="relative block">
        <span className="sr-only">Search roles</span>
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by job title" className="!h-11 !pl-9 !text-[15px]" />
      </label>
      <Select value={place} onChange={(e) => setPlace(e.target.value)} aria-label="Location" className="!h-11 sm:!w-48">
        <option value="">All locations</option>
        {places.map((p) => <option key={p} value={p}>{p}</option>)}
      </Select>
      <Select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Working pattern" className="!h-11 sm:!w-52">
        <option value="">Any working pattern</option>
        {modes.map((m) => <option key={m} value={m}>{WORK_MODES[m]}</option>)}
      </Select>
    </div>
  );

  return (
    <Shell board={board} embedded={embedded} at="list"
      hero={(
        <div className="mx-auto max-w-4xl px-5 pt-8 pb-16 sm:pt-12">
          <h1 className="text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">Open roles</h1>
          {board.intro && <p className="mt-3 max-w-2xl text-[15px] leading-relaxed opacity-85">{board.intro}</p>}
        </div>
      )}>
      {embedded && board.intro && <p className="mb-4 max-w-2xl text-[15px] leading-relaxed text-stone-600">{board.intro}</p>}
      <div className={embedded ? '' : '-mt-8'}>{filters}</div>
      <p className="mt-6 mb-3 text-sm font-medium text-stone-500" role="status">
        {filtered ? `${plural(shown.length, 'role')} of ${posts.length}` : plural(posts.length, 'open role')}
      </p>
      {!shown.length ? (
        <div className="rounded-xl border border-line px-5 py-12 text-center">
          <p className="font-medium text-stone-900">{filtered ? 'No roles match that search.' : 'There are no open roles right now.'}</p>
          <p className="mt-1 text-sm text-stone-500">{filtered ? 'Try a different word, or clear the filters.' : 'Please check back soon.'}</p>
          {filtered && <Button className="mt-4" onClick={() => { setSearch(''); setPlace(''); setMode(''); }}>Clear filters</Button>}
        </div>
      ) : (
        <ul className="space-y-3">
          {shown.map((p) => (
            <li key={p.token}>
              <Link to={boardPath(p.token, embedded)} className="group flex items-center gap-4 rounded-xl border border-line bg-white px-5 py-4 transition-shadow hover:border-stone-300 hover:shadow-md">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-[17px] font-semibold tracking-tight text-stone-900 group-hover:underline">{p.title}</span>
                    <Confidential />
                  </span>
                  <Facts post={p} className="mt-2" />
                  <span className="mt-2 flex items-center gap-1.5 text-xs text-stone-400"><Clock className="size-3.5" />{postedAgo(p.posted)}</span>
                </span>
                <ArrowRight className="size-5 shrink-0 text-stone-300 transition-transform group-hover:translate-x-0.5 group-hover:text-stone-500" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

/**
 * One post as the public sees it: title, facts, who is recruiting, and the advert. The agency's preview on the job
 * draws this same component from what is in the form, so what the recruiter checks is what goes out.
 */
export function PostView({ board, post, apply }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-stone-900 sm:text-3xl">{post.title || 'Untitled role'}</h1>
        <Confidential />
      </div>
      <Facts post={post} className="mt-3" />
      {apply}
      <p className="mt-6 flex items-start gap-2.5 rounded-xl bg-stone-50 px-4 py-3 text-sm leading-relaxed text-stone-600">
        <EyeOff className="mt-0.5 size-4 shrink-0 text-stone-400" />
        <span>{board.name} is recruiting for this role on behalf of a client. The employer’s name is confidential for now: we tell you who it is when we speak.</span>
      </p>
      {post.description && <div className="mt-6"><AdvertText text={post.description} /></div>}
    </>
  );
}

export function BoardPost() {
  const { token } = useParams();
  const embedded = useEmbedded();
  const { data, error } = usePublic(`/public/board/posts/${token}`);
  const [form, setForm] = useState({ name: '', email: '', phone: '', linkedin: '', cover_note: '', company_website: '' });
  const [file, setFile] = useState(null);
  const [consent, setConsent] = useState(false);
  const [done, setDone] = useState(false);
  const bind = (key) => ({ value: form[key], onChange: (e) => setForm((f) => ({ ...f, [key]: e.target.value })) });
  useHead(data && `${data.post.title} | ${data.board.name}`, data && [data.post.location, WORK_MODES[data.post.work_mode], EMPLOYMENT[data.post.employment_type]].filter(Boolean).join(' · '));
  // The job-posting data the server put in this page was for the post it was opened on: gone once the visitor is on another.
  useEffect(() => () => document.getElementById('board-job-data')?.remove(), [token]);

  const [submit, busy] = useAction(async () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) fd.append(k, v);
    fd.append('consent', consent ? 'yes' : 'no');
    if (file) fd.append('resume', file);
    await api.post(`/public/board/posts/${token}/apply`, fd);
    setDone(true);
  });

  if (error) return <Missing message={error} />;
  if (!data) return <Loading className="h-full" />;
  const { board, post } = data;
  const accent = { background: board.color, color: inkOn(board.color), borderColor: 'transparent' };
  const back = <Link to={boardPath(null, embedded)} className={`inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-800 ${embedded ? '' : 'mt-8'}`}><ArrowLeft className="size-4" />All open roles</Link>;

  if (done) {
    return (
      <Shell board={board} embedded={embedded} at={`${token}:done`}>
        <div className="py-14 text-center">
          <CircleCheck className="mx-auto size-12" style={{ color: board.color }} />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-stone-900">Thank you, {firstName(form.name)}.</h1>
          <p className="mx-auto mt-2 max-w-md text-stone-600">Your application for {post.title} is with {board.name}. One of our recruiters reads every application, and we will be in touch by email.</p>
          <Link to={boardPath(null, embedded)} className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-stone-700 hover:underline"><ArrowLeft className="size-4" />See all open roles</Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell board={board} embedded={embedded} at={token}>
      {back}
      <div className="mt-4">
        <PostView board={board} post={post}
          apply={<a href="#apply" onClick={(e) => { e.preventDefault(); document.getElementById('apply')?.scrollIntoView({ behavior: 'smooth' }); }} className="mt-5 inline-flex h-11 items-center rounded-lg px-5 text-[15px] font-semibold" style={accent}>Apply for this role</a>} />
      </div>

      <form id="apply" className="mt-12 scroll-mt-6 rounded-2xl border border-line bg-stone-50 p-5 sm:p-7" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h2 className="text-xl font-semibold tracking-tight text-stone-900">Apply for this role</h2>
        <p className="mt-1 text-sm text-stone-500">You are applying through {board.name}, which is recruiting for this role on behalf of the employer.</p>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Field label="Full name"><Input {...bind('name')} required autoComplete="name" className="!h-10" /></Field>
          <Field label="Email"><Input type="email" {...bind('email')} required autoComplete="email" className="!h-10" /></Field>
          <Field label="Phone (optional)"><Input type="tel" {...bind('phone')} autoComplete="tel" className="!h-10" /></Field>
          <Field label="LinkedIn profile (optional)"><Input {...bind('linkedin')} placeholder="https://" className="!h-10" /></Field>
          <Field label="Résumé / CV" hint="PDF, Word, RTF or text, up to 8 MB." className="sm:col-span-2">
            <input type="file" accept=".pdf,.doc,.docx,.rtf,.txt" onChange={(e) => setFile(e.target.files[0] || null)}
              className="block w-full rounded-lg border border-line bg-white text-sm text-stone-600 file:mr-3 file:h-10 file:border-0 file:border-r file:border-line file:bg-stone-100 file:px-4 file:text-sm file:font-medium file:text-stone-800" />
          </Field>
          <Field label="Anything you would like us to know? (optional)" className="sm:col-span-2"><Textarea rows={4} {...bind('cover_note')} /></Field>
          {/* Honeypot: hidden from people, tempting for bots. */}
          <input type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" {...bind('company_website')} className="absolute -left-[9999px] h-0 w-0 opacity-0" />
        </div>
        <div className="mt-5">
          <Checkbox checked={consent} onChange={(e) => setConsent(e.target.checked)} required
            label={`I agree that ${board.name} may store and process my details to consider me for this role, and may share my application with the employer it is recruiting for.`} />
          {extUrl(board.privacy_url) && (
            <p className="mt-1.5 pl-[26px] text-xs text-stone-500">
              See how your information is used in {board.name}’s <a href={extUrl(board.privacy_url)} target="_blank" rel="noopener noreferrer" className="underline hover:text-stone-800">privacy notice</a>.
            </p>
          )}
        </div>
        <Button type="submit" busy={busy} className="mt-6 !h-11 w-full !text-[15px] font-semibold sm:w-auto sm:!px-8" style={accent}>Submit application</Button>
      </form>
    </Shell>
  );
}

/** Any address under /board that is not the list or a post. */
export function BoardMissing() {
  return <Missing />;
}
