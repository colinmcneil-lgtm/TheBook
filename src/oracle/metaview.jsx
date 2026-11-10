// The Metaview tab of The Oracle, and the pieces about Metaview that other screens share.
//
// Metaview is where the agency's calls are recorded. The Book reads the list of those calls and shows it here. A call
// is "brought in" (its transcript and Metaview's notes are copied into The Oracle) the first time somebody opens it
// or chooses its candidate, or by itself when it clearly belongs to one candidate. Nothing here changes anything in
// Metaview: The Book only reads from it.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AudioLines, Check, LoaderCircle, Phone, RefreshCw, Search, Upload, UserPlus, Video, X } from 'lucide-react';
import { useApp, Pending } from '../state.jsx';
import { api, url, ago, fmtWhen, photoUrl } from '../lib.js';
import { Avatar, Badge, Button, Card, CardHeader, Empty, Input, Select, useAction, useToast, cx } from '../ui.jsx';
import { MicBadge } from './RecorderProvider.jsx';
import { AttachModal, Notice, WhoToggle, useLive, useQuery } from './bits.jsx';
import { MATCHED_BY, kindLine, peopleLine, readingLine, whoseCall } from './calls.js';

const UNREACHABLE = 'The Book could not be reached. Check your connection and try again.';
/** A sentence for a request that failed: the server's own words when it answered, ours when it could not be reached. */
export const problemOf = (err) => (err?.status ? err.message : UNREACHABLE);

/** The picture for how a conversation was held: a phone, a video meeting, a recording somebody uploaded, or just sound. */
const channelIcon = (channel) => (/phone/i.test(channel || '') ? Phone
  : /zoom|meet|teams|webex|whereby/i.test(channel || '') ? Video
  : /upload/i.test(channel || '') ? Upload : AudioLines);
/** The round badge that stands at the start of a Metaview call's row. */
export const ChannelBadge = ({ call, size = 36 }) => <MicBadge size={size} icon={channelIcon(call.channel)} />;

// ---- the connection ---------------------------------------------------------------------------------------------------------
/**
 * Whether Metaview is connected and how far The Book has got with it. Asked again every few seconds while the
 * history is still being read, and after "Look for new calls" until that look has been done. Once connected it is
 * also asked now and then for as long as the screen is open, so calls The Book finds or brings in by itself (it
 * looks every ten minutes) show up without the page being loaded again.
 */
export function useMetaview() {
  const [looking, setLooking] = useState(null); // { was: when The Book had last looked } from pressing the button until it has looked again
  const [reading, setReading] = useState(false); // the history is still being read
  const live = useLive('/metaview/status', (s) => Boolean(s.connected || looking), looking ? 2000 : reading ? 5000 : 20_000);
  const status = live.data;
  useEffect(() => { setReading(Boolean(status?.catching_up)); }, [status?.catching_up]);
  const checked = status?.last_checked_at ?? null;
  useEffect(() => { if (looking && checked !== looking.was) setLooking(null); }, [checked, looking]);
  // Metaview may be slow or not answering: the button does not spin for ever.
  useEffect(() => {
    if (!looking) return undefined;
    const timer = setTimeout(() => setLooking(null), 45_000);
    return () => clearTimeout(timer);
  }, [looking]);
  const [look, asking] = useAction(async () => {
    await api.post('/metaview/refresh');
    setLooking({ was: checked });
    await live.reload();
  });
  return { status, error: live.error, set: live.set, reload: live.reload, look, looking: asking || Boolean(looking) };
}

// ---- the list ---------------------------------------------------------------------------------------------------------------
const PAGE = 30;
/**
 * Metaview's calls for one search, a page at a time. `filters` is null while there is nothing to ask for. The rows
 * on screen stay while a new search loads, and are read again quietly (as many as are showing, one request at a
 * time) whenever `stamp` changes: The Book has found new calls, or brought some in.
 */
function useCalls(filters, stamp) {
  const { version } = useApp();
  const key = filters ? JSON.stringify(filters) : null;
  const [state, setState] = useState({ key: null, calls: [], total: 0, error: null });
  const [more, setMore] = useState(false);
  const [again, setAgain] = useState(0);
  const showing = useRef(0);
  showing.current = state.key === key ? state.calls.length : 0;
  const latest = useRef(key);
  latest.current = key;

  const read = useCallback(async (offset) => api.get(url('/metaview/calls', { ...filters, offset, limit: PAGE })), [key]);
  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    (async () => {
      const calls = [];
      let total = 0;
      const wanted = Math.max(PAGE, showing.current);
      do {
        const page = await read(calls.length);
        total = page.total;
        if (!page.calls.length) break;
        calls.push(...page.calls);
      } while (live && calls.length < Math.min(wanted, total));
      if (live) setState({ key, calls: unique(calls), total, error: null });
    })().catch((err) => {
      // A failed re-read keeps what is on screen; a failed first read says why.
      if (live) setState((was) => (was.key === key && was.calls.length ? was : { key, calls: [], total: 0, error: problemOf(err) }));
    });
    return () => { live = false; };
  }, [key, stamp, version, again]);

  const [showMore] = useAction(async () => {
    setMore(true);
    try {
      const page = await read(state.calls.length);
      if (latest.current === key) setState((was) => (was.key === key ? { ...was, calls: unique([...was.calls, ...page.calls]), total: page.total } : was));
    } finally { setMore(false); }
  });

  return {
    calls: state.key ? state.calls : null, total: state.total, error: state.error,
    stale: state.key !== key, // the rows are from the search before this one, which is still loading
    showMore, loadingMore: more, reload: () => setAgain((n) => n + 1),
  };
}
/** A call that moved between two pages while they were being read is listed once. */
const unique = (calls) => calls.filter((c, i) => calls.findIndex((x) => x.id === c.id) === i);

/** Who a Metaview call belongs to in The Book: the candidate, or the way to say who it is. */
function Whose({ call, onChoose }) {
  const whose = whoseCall(call);
  if (whose === 'matched') {
    const { match } = call;
    const person = (
      <>
        <Avatar name={match.name} size={30} src={photoUrl(match.candidate_id, match.photo)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-stone-900">{match.name}</span>
          <span className="block truncate text-xs text-stone-500">{[match.job_title, match.client_name].filter(Boolean).join(' · ')}</span>
        </span>
      </>
    );
    // Once the call is in The Book it is moved from its own page, which says what moving it takes with it.
    if (call.call_id) return <span className="flex items-center gap-2.5 px-2 py-1" title={MATCHED_BY[match.how]}>{person}</span>;
    return (
      <button type="button" onClick={onChoose} title={`${MATCHED_BY[match.how] || 'Matched'}. Not them? Choose someone else.`}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left hover:bg-stone-200/60">{person}</button>
    );
  }
  if (whose === 'choose') {
    return (
      <span className="flex items-center gap-2 px-2">
        <Button size="sm" icon={UserPlus} onClick={onChoose}>Choose candidate</Button>
        <span className="truncate text-xs text-stone-500">{call.suggestions.length} possible</span>
      </span>
    );
  }
  return (
    <button type="button" onClick={onChoose} title="Choose the candidate yourself, or add them to The Book"
      className="rounded-lg px-2 py-1 text-left text-[13px] text-stone-500 hover:bg-stone-200/60 hover:text-stone-800">Candidate not in The Book yet</button>
  );
}

/** One of Metaview's calls. Clicking it opens it in The Oracle, bringing it in first if it is not there yet. */
function Row({ call, back, opening, held, onOpen, onChoose }) {
  const title = 'min-w-0 truncate text-left text-sm font-medium text-stone-900 after:absolute after:inset-0';
  const about = [peopleLine(call), kindLine(call)].filter(Boolean).join(' · ');
  return (
    <li className={cx('relative flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3', held ? 'pointer-events-none opacity-50' : !opening && 'hover:bg-stone-50')}>
      <ChannelBadge call={call} />
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {call.call_id ? <Link to={`/oracle/${call.call_id}`} state={{ back }} className={title}>{call.title}</Link>
            : <button type="button" onClick={onOpen} disabled={opening} className={title}>{call.title}</button>}
          {call.call_id && <Badge tone="green" icon={Check}>In The Book</Badge>}
          {!call.has_transcript && <Badge>No transcript</Badge>}
        </div>
        {opening ? (
          <p className="flex items-center gap-1.5 text-[13px] font-medium text-brand-700" role="status"><LoaderCircle className="size-3.5 animate-spin" />Bringing it in from Metaview…</p>
        ) : (
          <p className="text-[13px] text-stone-500 max-sm:line-clamp-2 sm:truncate">
            {/* Only a wide screen has a column for the date. Anywhere else it leads this line (which on a phone may run to a second). */}
            <span className="tabular text-stone-700 xl:hidden">{fmtWhen(call.started_at)}{about ? ' · ' : ''}</span>{about}
          </p>
        )}
      </div>
      <div className="relative z-10 w-64 shrink-0 max-sm:w-full max-sm:pl-11"><Whose call={call} onChoose={onChoose} /></div>
      <div className="tabular w-40 shrink-0 text-right text-[13px] text-stone-700 max-xl:hidden">{fmtWhen(call.started_at)}</div>
    </li>
  );
}

const SHOW = { all: 'All calls', new: 'Not in The Book yet', unmatched: 'No candidate yet' };

/** What the tab says before Metaview is connected: what connecting does, and who can do it. */
function NotConnected({ status }) {
  const { isAdmin } = useApp();
  const navigate = useNavigate();
  return (
    <Card>
      <Empty icon={AudioLines} title="Metaview is not connected yet"
        action={isAdmin
          ? <Button variant="primary" onClick={() => navigate('/settings?tab=agency#metaview')}>Connect Metaview</Button>
          : <p className="text-sm font-medium text-stone-700">Ask an admin to connect Metaview.</p>}>
        Once it is connected, your Metaview calls appear here with their transcripts and notes, and on the right candidates in The Book. Nothing in Metaview is changed.
      </Empty>
      {status?.error && <div className="border-t border-line p-4"><Notice tone="warn">{status.error}</Notice></div>}
    </Card>
  );
}

/** The first tab of The Oracle: the team's Metaview calls, findable, each on its candidate in The Book. */
export function MetaviewTab() {
  const { user, isAdmin } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [params, change] = useQuery();
  const metaview = useMetaview();
  const { status } = metaview;
  const connected = Boolean(status?.connected);

  // What is searched for and filtered on is kept in the address, so the list is as it was left when coming back to it.
  const q = params.get('q') || '';
  const everyone = params.get('who') === 'everyone';
  const show = SHOW[params.get('show')] ? params.get('show') : 'all';
  // The box is searched a moment after the typing stops. A search that arrives in the address some other way
  // (cleared, or the Back button) is put in the box.
  const [text, setText] = useState(q);
  const searched = useRef(q);
  searched.current = q;
  useEffect(() => {
    const timer = setTimeout(() => { if (text.trim() !== searched.current) change({ q: text.trim() }); }, 300);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => { setText((now) => (now.trim() === q ? now : q)); }, [q]);

  const stamp = connected ? [status.known, status.in_the_book, status.last_checked_at].join() : '';
  const list = useCalls(connected ? { q, who: everyone ? 'everyone' : 'mine', show } : null, stamp);

  const [opening, setOpening] = useState(null); // the Metaview call being brought in, so it can be opened
  const [choosing, setChoosing] = useState(null); // the call whose candidate is being chosen
  const back = location.pathname + location.search;
  const open = async (call) => {
    if (opening) return;
    setOpening(call.id);
    try {
      const { call_id } = await api.post(`/metaview/calls/${call.id}/open`);
      navigate(`/oracle/${call_id}`, { state: { back } });
    } catch (err) {
      toast(problemOf(err), 'error');
      setOpening(null);
    }
  };
  const chosen = () => { list.reload(); metaview.reload(); };

  if (!status) return <Pending error={metaview.error} />;
  if (!connected) return <NotConnected status={status} />;

  const reading = readingLine(status);
  const filtered = Boolean(q) || show !== 'all';
  const clear = () => { setText(''); change({ q: '', show: '' }); };
  const calls = list.calls;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-64">
          <span className="sr-only">Search Metaview calls</span>
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-stone-400 max-sm:top-3.5" />
          <Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search by name, email, phone or title" autoComplete="off" className="pl-9 max-sm:!h-11 max-sm:!text-base" />
        </label>
        <Select value={show} onChange={(e) => change({ show: e.target.value === 'all' ? '' : e.target.value })} aria-label="Which calls to show" className="!w-auto max-sm:!h-11 max-sm:flex-1">
          {Object.entries(SHOW).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
        {/* On a phone the words would push this onto a line of its own, so there it is the arrows alone. */}
        <Button icon={RefreshCw} busy={metaview.looking} onClick={metaview.look} title="Look for new calls" className="max-sm:!h-11 max-sm:!px-3.5"><span className="max-sm:sr-only">Look for new calls</span></Button>
      </div>

      {status.error && (
        <Notice tone="warn" className="mb-3">
          <span className="font-medium">Metaview could not be read the last time The Book looked.</span> {status.error}{' '}
          {isAdmin ? <Link to="/settings?tab=agency#metaview" className="font-medium text-amber-950 underline underline-offset-2">Check the connection</Link> : 'An admin can check the connection in Settings.'}
        </Notice>
      )}

      <Card className="overflow-hidden">
        <CardHeader title="Metaview calls" count={calls && !list.stale ? list.total.toLocaleString('en-CA') : undefined}
          action={<WhoToggle everyone={everyone} onChange={(who) => change({ who: who === 'everyone' ? 'everyone' : '' })} />} />
        {reading && (
          <p className="flex items-center gap-2 border-b border-line bg-stone-50 px-4 py-2 text-[13px] text-stone-600" role="status">
            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-brand-600" />{reading}. You can use the calls that are here meanwhile.
          </p>
        )}
        {!calls ? <Pending error={list.error} /> : !calls.length ? (
          filtered ? (
            <Empty icon={Search} title="No calls match" action={<Button icon={X} onClick={clear}>Clear the search</Button>}>
              {everyone ? 'Nothing in Metaview matches what you searched for.' : 'None of your own Metaview calls match what you searched for. Choose Everyone to search the whole team’s calls.'}
              {status.catching_up ? ' The Book is still reading your history, so older calls may not be here yet.' : ''}
            </Empty>
          ) : !everyone && status.known > 0 ? (
            <Empty icon={AudioLines} title="None of the Metaview calls are yours" action={<Button onClick={() => change({ who: 'everyone' })}>Show everyone’s calls</Button>}>
              Your calls are the ones where {user.email} was an interviewer. If you use a different address in Metaview, you will find your calls under Everyone.
            </Empty>
          ) : (
            <Empty icon={AudioLines} title={status.catching_up ? 'Reading your Metaview history' : 'No calls in Metaview yet'}>
              {status.catching_up ? 'The first calls appear here in a moment.' : 'Calls your team records in Metaview appear here, each with its transcript and notes.'}
            </Empty>
          )
        ) : (
          <>
            <div className="flex items-center gap-4 border-b border-line bg-stone-50/60 px-4 py-1.5 text-xs font-medium text-stone-500 max-xl:hidden" aria-hidden="true">
              <span className="w-9 shrink-0" /><span className="min-w-0 flex-1">Call</span><span className="w-64 shrink-0 pl-2">Candidate in The Book</span><span className="w-40 shrink-0 text-right">When</span>
            </div>
            <ul className={cx('divide-y divide-line transition-opacity', list.stale && 'opacity-50')} aria-busy={list.stale}>
              {calls.map((call) => (
                <Row key={call.id} call={call} back={back} opening={opening === call.id} held={Boolean(opening) && opening !== call.id}
                  onOpen={() => open(call)} onChoose={() => setChoosing(call)} />
              ))}
            </ul>
          </>
        )}
      </Card>

      {calls?.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="text-xs text-stone-500">
            Showing {calls.length.toLocaleString('en-CA')} of {Math.max(list.total, calls.length).toLocaleString('en-CA')}.
            {status.last_checked_at ? ` The Book last looked for new calls ${ago(status.last_checked_at)}.` : ''}
          </p>
          {calls.length < list.total && <Button busy={list.loadingMore} disabled={list.stale} onClick={list.showMore}>Show more</Button>}
        </div>
      )}

      {choosing && (
        <AttachModal call={{ id: choosing.call_id, title: choosing.title }} suggestions={choosing.suggestions}
          // A call that is not in The Book yet is brought in as it is added to the candidate.
          save={choosing.call_id ? undefined : (applicationId) => api.post(`/metaview/calls/${choosing.id}/open`, { application_id: applicationId })}
          saveLabel={choosing.call_id ? undefined : 'Bringing it in from Metaview…'}
          onClose={() => setChoosing(null)} onDone={chosen} />
      )}
    </>
  );
}

