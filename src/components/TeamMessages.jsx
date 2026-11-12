import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Briefcase, Check, Lock, MessagesSquare, Search, Send, UserRound, X } from 'lucide-react';
import { api, url, ago, jobLine } from '../lib.js';
import { useApp, useApi } from '../state.jsx';
import { Avatar, Button, Card, Field, Input, Loading, Modal, Select, Tabs, Textarea, useAction, useToast, cx } from '../ui.jsx';

// What Messages shares with the rest of the app: a message's words with their links, the chip for the candidate or
// job a message carries, the dialog that finds one to attach, the picker of people, the composer opened from a
// profile or a job ("Message the team"), and the short list of the team's messages shown there. The agency's alone:
// none of it is asked for, or drawn, for a client's user.

export const BODY_MAX = 4000;
/** Tell the menu's count and the list of conversations to look again now (after a send, a read, a rename...). */
export const messagesChanged = () => window.dispatchEvent(new Event('messages:changed'));

// http and https links only; a link ends at a space, and punctuation that ends a sentence is not part of it.
const LINK = /\bhttps?:\/\/[^\s<>"']+/gi;
/**
 * A message's words as React elements: line breaks kept (by the caller's whitespace-pre-wrap), and http(s) links made
 * clickable. Built from text pieces and <a> elements, never from HTML, so nothing anybody writes can become markup.
 */
export function MessageText({ text, className }) {
  const parts = [];
  let last = 0;
  for (const match of String(text || '').matchAll(LINK)) {
    let href = match[0];
    const trail = /[.,;:!?)\]}]+$/.exec(href);
    if (trail) href = href.slice(0, -trail[0].length);
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(<a key={match.index} href={href} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2 [overflow-wrap:anywhere]">{href}</a>);
    last = match.index + href.length;
  }
  if (last < String(text || '').length) parts.push(text.slice(last));
  return <span className={cx('whitespace-pre-wrap [overflow-wrap:anywhere]', className)}>{parts}</span>;
}

/**
 * The candidate or job a message carries. A candidate opens their profile over the page you are on; a job opens the
 * job. With `onRemove` (in the composer, before sending) it has a button to take it off instead.
 */
export function AttachmentChip({ attachment: a, onRemove, className }) {
  if (!a) return null;
  const Icon = a.type === 'job' ? Briefcase : UserRound;
  const label = a.type === 'job' ? a.title : a.name;
  const inner = (
    <>
      <Icon className="size-3.5 shrink-0 opacity-70" />
      <span className="min-w-0 truncate"><span className="font-medium">{label}</span>{a.detail && <span className="opacity-70"> · {a.detail}</span>}</span>
    </>
  );
  const cls = 'inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-2.5 text-[12.5px] text-brand-900';
  if (onRemove) {
    return (
      <span className={cx(cls, 'pr-1', className)}>
        {inner}
        <button type="button" onClick={onRemove} aria-label={`Remove ${label}`} className="ml-0.5 rounded-full p-0.5 text-brand-700 hover:bg-brand-100"><X className="size-3.5" /></button>
      </span>
    );
  }
  const to = a.type === 'job' ? `/jobs/${a.job_id}` : `?c=${a.application_id}`;
  return <Link to={to} className={cx(cls, 'hover:border-brand-300 hover:bg-brand-100', className)} title={a.type === 'job' ? 'Open the job' : 'Open their profile'}>{inner}</Link>;
}

/** What a chip needs, from a row of the candidates list or the jobs list. */
export const candidateAttachment = (row) => ({ type: 'candidate', application_id: row.id, name: row.name, detail: row.job_id ? `${row.job_title} at ${row.client_name}` : 'In The Book, not on a job' });
export const jobAttachment = (job) => ({ type: 'job', job_id: job.id, title: job.title, detail: job.client_name });

/** Find a candidate (by name, address, company or title, as the search at the top of the page does) or a job to attach. */
export function AttachModal({ onPick, onClose }) {
  const [kind, setKind] = useState('candidate');
  const [text, setText] = useState('');
  const [found, setFound] = useState(null);
  const box = useRef(null);
  const { data: jobs } = useApi(kind === 'job' ? '/jobs' : null);
  useEffect(() => {
    if (kind !== 'candidate') return undefined;
    let live = true;
    setFound(null);
    // A moment's pause while typing, so each letter is not a search of its own.
    const wait = setTimeout(() => {
      api.get(url('/applications', { q: text.trim() || null, status: 'all' }))
        .then((rows) => live && setFound(rows.slice(0, 8)))
        .catch(() => live && setFound([]));
    }, 200);
    return () => { live = false; clearTimeout(wait); };
  }, [kind, text]);
  useEffect(() => { box.current?.focus(); }, [kind]);
  const jobRows = useMemo(() => {
    const words = text.trim().toLowerCase();
    return (jobs || []).filter((j) => !words || `${j.title} ${j.client_name}`.toLowerCase().includes(words)).slice(0, 8);
  }, [jobs, text]);
  const rows = kind === 'candidate' ? found : jobs ? jobRows : null;
  return (
    <Modal title="Attach a candidate or a job" subtitle="It shows as a chip on the message, and the message is listed on their page for the people in this conversation." size="sm" onClose={onClose}>
      <Tabs value={kind} onChange={(k) => { setKind(k); setText(''); }} tabs={[{ id: 'candidate', label: 'Candidate' }, { id: 'job', label: 'Job' }]} />
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
        <Input ref={box} type="search" value={text} onChange={(e) => setText(e.target.value)} className="pl-9" aria-label={kind === 'candidate' ? 'Find a candidate to attach' : 'Find a job to attach'}
          placeholder={kind === 'candidate' ? 'Name, email, company or title…' : 'Job title or client…'} />
      </div>
      {!rows ? <Loading className="py-8" /> : !rows.length ? (
        <p className="py-6 text-center text-sm text-stone-500">{kind === 'candidate' ? 'No candidate matches that.' : 'No job matches that.'}</p>
      ) : (
        <ul className="-mx-2 divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => onPick(kind === 'candidate' ? candidateAttachment(r) : jobAttachment(r))}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-stone-50">
                {kind === 'candidate' ? <Avatar name={r.name} size={30} /> : <span className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700"><Briefcase className="size-4" /></span>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-stone-900">{kind === 'candidate' ? r.name : r.title}</span>
                  <span className="block truncate text-xs text-stone-500">{kind === 'candidate' ? jobLine(r) : r.client_name}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/**
 * The people on the team to choose from, with a box to narrow them when there are many. `chosen` is a list of ids;
 * with `single`, choosing somebody replaces whoever was chosen.
 */
export function PeoplePicker({ people, chosen, onChange, single, label = 'People' }) {
  const [text, setText] = useState('');
  const words = text.trim().toLowerCase();
  const shown = people.filter((p) => !words || p.name.toLowerCase().includes(words));
  const toggle = (id) => onChange(single ? [id] : chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  if (!people.length) return <p className="text-sm text-stone-500">There is nobody else active on your team to choose.</p>;
  return (
    <fieldset>
      <legend className="mb-1 block text-[13px] font-medium text-stone-700">{label}</legend>
      {people.length > 6 && <Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Find somebody…" aria-label="Find somebody" className="mb-2" />}
      <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line">
        {shown.map((p) => {
          const on = chosen.includes(p.id);
          return (
            <li key={p.id}>
              <label className={cx('flex cursor-pointer items-center gap-3 px-3 py-2', on ? 'bg-brand-50' : 'hover:bg-stone-50')}>
                <input type={single ? 'radio' : 'checkbox'} name="people" checked={on} onChange={() => toggle(p.id)} className="size-4 accent-brand-700" />
                <Avatar name={p.name} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-stone-900">{p.name}</span>
                  {p.title && <span className="block truncate text-xs text-stone-500">{p.title}</span>}
                </span>
                {on && <Check className="size-4 text-brand-700" />}
              </label>
            </li>
          );
        })}
        {!shown.length && <li className="px-3 py-3 text-sm text-stone-500">Nobody by that name.</li>}
      </ul>
    </fieldset>
  );
}

/** Start a conversation with one person, or make a group with several people and a name. Resolves to its id. */
export async function startConversation(userIds, name) {
  const answer = userIds.length === 1
    ? await api.post('/messages/conversations', { kind: 'direct', user_id: userIds[0] })
    : await api.post('/messages/conversations', { kind: 'group', name, user_ids: userIds });
  return answer.id;
}

/**
 * "Message the team" on a candidate's profile or a job: the composer with that candidate or job already attached, and
 * a choice of where it goes: one of your conversations, or somebody on the team (which opens your one-to-one with
 * them, or starts it).
 */
export function MessageTeamModal({ attachment, onClose }) {
  const toast = useToast();
  const { bump, user } = useApp();
  const { data: people } = useApi('/messages/people');
  const { data: conversations } = useApi('/messages/conversations');
  const [to, setTo] = useState('');
  const [body, setBody] = useState('');
  const [chip, setChip] = useState(attachment);
  // Somebody you already have a one-to-one with is offered once, as that conversation.
  const direct = new Set((conversations || []).filter((c) => c.kind === 'direct').flatMap((c) => c.members.map((m) => m.id)));
  // A one-to-one with somebody who has left the team is read-only, so it is not offered.
  const writable = (conversations || []).filter((c) => c.kind === 'group' || c.members.some((m) => m.id !== user.id && m.on_team));
  const others = (people || []).filter((p) => !direct.has(p.id));
  const [send, busy] = useAction(async () => {
    const [kind, id] = to.split(':');
    const conversationId = kind === 'p' ? await startConversation([Number(id)]) : Number(id);
    await api.post(`/messages/conversations/${conversationId}/messages`, {
      body,
      application_id: chip?.type === 'candidate' ? chip.application_id : null,
      job_id: chip?.type === 'job' ? chip.job_id : null,
    });
    const where = kind === 'p' ? people.find((p) => p.id === Number(id))?.name : conversations.find((c) => c.id === Number(id))?.title;
    toast(`Sent to ${where || 'your team'}`);
    messagesChanged();
    bump();
    onClose();
  });
  return (
    <Modal title="Message the team" size="sm" onClose={onClose} onSubmit={send}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" icon={Send} busy={busy} disabled={!to || !body.trim()}>Send</Button></>}>
      {!people || !conversations ? <Loading /> : (
        <>
          <Field label="Send to">
            <Select value={to} onChange={(e) => setTo(e.target.value)} required autoFocus>
              <option value="">Choose a person or a conversation…</option>
              {writable.length > 0 && (
                <optgroup label="Your conversations">
                  {writable.map((c) => <option key={c.id} value={`c:${c.id}`}>{c.title}{c.kind === 'group' ? ` (group of ${c.members.length})` : ''}</option>)}
                </optgroup>
              )}
              {others.length > 0 && (
                <optgroup label="Somebody on your team">
                  {others.map((p) => <option key={p.id} value={`p:${p.id}`}>{p.name}</option>)}
                </optgroup>
              )}
            </Select>
          </Field>
          <Field label="Message">
            <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={BODY_MAX} required />
          </Field>
          {chip && <div><AttachmentChip attachment={chip} onRemove={() => setChip(null)} /></div>}
          <p className="flex items-center gap-1.5 text-xs text-stone-500"><Lock className="size-3.5 shrink-0" />Only the people in the conversation see this message. The candidate and the client are never told.</p>
        </>
      )}
    </Modal>
  );
}

/**
 * The team's messages about this candidate (`applicationId`) or job (`jobId`), newest first: only from conversations
 * you are in. `hideEmpty` leaves the card out when there are none.
 */
export function TeamMessagesCard({ applicationId, jobId, hideEmpty, onWrite, className }) {
  const { data } = useApi(url('/messages/about', { application_id: applicationId, job_id: jobId }));
  if (!data || (hideEmpty && !data.length)) return null;
  return (
    <Card className={cx('p-4', className)}>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-stone-900"><MessagesSquare className="size-4 text-stone-500" />Team messages</h3>
      <p className="mt-0.5 text-xs text-stone-500">From your conversations only. Clients never see these.</p>
      {!data.length ? (
        <p className="mt-3 text-[13px] text-stone-500">No messages from your conversations are about {jobId ? 'this job' : 'them'} yet.</p>
      ) : (
        <ul className="mt-3 space-y-3 text-[13px]">
          {data.map((m) => (
            <li key={m.id}>
              <Link to={`/messages/${m.conversation_id}`} className="-mx-2 block rounded-lg px-2 py-1.5 hover:bg-stone-50">
                <span className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-stone-500">
                  <span className="font-medium text-stone-800">{m.user_name || 'Somebody no longer on the team'}</span>
                  {/* Where it was written: a group by its name; a one-to-one as "to Marcus Bell", or "to you". */}
                  <span>{m.conversation_kind === 'group' ? `in ${m.conversation_title}` : m.mine ? `to ${m.conversation_title}` : 'to you'}</span>
                  <span>· {ago(m.created_at)}</span>
                </span>
                <span className="mt-0.5 line-clamp-3 whitespace-pre-line text-stone-700 [overflow-wrap:anywhere]">{m.body}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {onWrite && <Button size="sm" className="mt-3 w-full" onClick={onWrite}>Message the team</Button>}
    </Card>
  );
}
