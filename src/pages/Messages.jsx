import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, CircleAlert, LogOut, MessagesSquare, MoreHorizontal, Paperclip, Pencil, Plus, RotateCw, Send, Trash2, UserPlus, Users, X } from 'lucide-react';
import { api, fmtDay, fmtTime, fmtDate } from '../lib.js';
import { useApp, useApi } from '../state.jsx';
import { Avatar, Button, Empty, Field, Input, Loading, Menu, Modal, useAction, useToast, cx } from '../ui.jsx';
import { AttachModal, AttachmentChip, BODY_MAX, MessageText, PeoplePicker, messagesChanged, startConversation } from '../components/TeamMessages.jsx';

// Messages: the agency team's own chat, one to one or in a group. Two panes on a wide screen (the conversations on
// the left, the open one on the right); on a phone, the list, and then the conversation with a way back.
//
// There are no sockets: the open conversation asks the server for anything newer than the last message it was given
// every five seconds while the tab is in view, and the list (and the count in the menu) every twenty seconds. What is
// sent here shows at once and is never shown twice, and a reader who has scrolled up is not pulled down by new
// messages: a "New messages" button appears instead. A conversation is marked read only as far as the messages the
// reader has actually been shown, and only while the tab is in view.

const THREAD_EVERY = 5000;
const LIST_EVERY = 20000;

/** Run `fn` every `ms` while the tab is in view, and once as soon as it comes back into view. */
function useWhileVisible(fn, ms) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    const tick = () => document.visibilityState === 'visible' && latest.current();
    const timer = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [ms]);
}

/** "10:42" today, "Tue" this week, otherwise "3 Nov": the time beside a conversation in the list. */
function listTime(d) {
  const date = new Date(d), today = new Date();
  if (date.toDateString() === today.toDateString()) return fmtTime(d);
  const days = (new Date(today).setHours(0, 0, 0, 0) - new Date(date).setHours(0, 0, 0, 0)) / 86400000;
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return fmtDate(d, date.getFullYear() !== today.getFullYear());
}

function ConversationAvatar({ conversation: c, size = 36 }) {
  if (c.kind === 'group') {
    return <span className="flex shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-800" style={{ width: size, height: size }} aria-hidden="true"><Users className="size-[45%]" /></span>;
  }
  return <Avatar name={c.title} size={size} />;
}

/** The last line of a conversation, for the list: who wrote it and its first line. */
function lastLine(last) {
  if (!last) return 'No messages yet';
  if (last.kind === 'system') return last.text;
  const who = last.mine ? 'You: ' : '';
  return last.deleted ? `${who}This message was deleted` : `${who}${last.text}`;
}

function ConversationList({ conversations, error, activeId, onNew }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h1 className="display text-[22px] leading-tight text-stone-900">Messages</h1>
        <Button size="sm" variant="primary" icon={Plus} onClick={onNew} className="max-sm:h-10">New message</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && !conversations ? (
          <Empty icon={CircleAlert} title="Your messages could not be loaded">{error}</Empty>
        ) : !conversations ? <Loading /> : !conversations.length ? (
          <Empty icon={MessagesSquare} title="No conversations yet" action={<Button icon={Plus} onClick={onNew}>New message</Button>}>
            Write to somebody on your team, or start a group. Only the people in a conversation can read it.
          </Empty>
        ) : (
          <ul aria-label="Conversations">
            {conversations.map((c) => (
              <li key={c.id}>
                <Link to={`/messages/${c.id}`} aria-current={c.id === activeId ? 'page' : undefined}
                  className={cx('flex items-center gap-3 border-b border-hairline px-4 py-3 transition-colors', c.id === activeId ? 'bg-brand-50' : 'hover:bg-stone-50')}>
                  <ConversationAvatar conversation={c} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={cx('min-w-0 flex-1 truncate text-sm text-stone-900', c.unread ? 'font-semibold' : 'font-medium')}>{c.title}</span>
                      <span className="tabular shrink-0 text-xs text-stone-500">{listTime(c.last?.created_at || c.updated_at)}</span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-2">
                      <span className={cx('min-w-0 flex-1 truncate text-[13px]', c.unread ? 'text-stone-800' : 'text-stone-500', (c.last?.deleted || c.last?.kind === 'system') && 'italic')}>{lastLine(c.last)}</span>
                      {/* The badge is for the eye; a screen reader hears the count in words, as part of the link. */}
                      {c.unread > 0 && <span className="tabular inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-gold px-1.5 text-xs font-semibold text-brand-950" aria-hidden="true">{c.unread}</span>}
                      {c.unread > 0 && <span className="sr-only">, {c.unread === 1 ? '1 unread message' : `${c.unread} unread messages`}</span>}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** "New message": one person for a one-to-one conversation, or several people and a name for a group. */
function NewConversationModal({ onClose }) {
  const navigate = useNavigate();
  const { data: people, error } = useApi('/messages/people');
  const [chosen, setChosen] = useState([]);
  const [name, setName] = useState('');
  const group = chosen.length > 1;
  const [start, busy] = useAction(async () => {
    const id = await startConversation(chosen, name);
    messagesChanged();
    onClose();
    // The conversation opens ready to write in.
    navigate(`/messages/${id}`, { state: { write: true } });
  });
  return (
    <Modal title="New message" subtitle="Choose one person to write to them, or several to start a group." size="sm" onClose={onClose} onSubmit={start}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy} disabled={!chosen.length || (group && !name.trim())}>{group ? 'Start the group' : 'Start the conversation'}</Button></>}>
      {error ? <p className="text-sm text-red-700">{error}</p> : !people ? <Loading /> : (
        <>
          <PeoplePicker people={people} chosen={chosen} onChange={setChosen} label="Who to write to" />
          {group && (
            <Field label="Name of the group" hint="Everybody in the group sees it and can change it. Up to 80 characters.">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required placeholder="For example: Kestrel sales search" />
            </Field>
          )}
        </>
      )}
    </Modal>
  );
}

function RenameModal({ conversation, onClose, onDone }) {
  const [name, setName] = useState(conversation.name || '');
  const [save, busy] = useAction(async () => { await api.patch(`/messages/conversations/${conversation.id}`, { name }); onDone(); onClose(); });
  return (
    <Modal title="Rename the group" size="sm" onClose={onClose} onSubmit={save}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>Save</Button></>}>
      <Field label="Name" hint="Everybody in the group sees the new name, and a line in the conversation says who changed it.">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoFocus />
      </Field>
    </Modal>
  );
}

function AddPeopleModal({ conversation, members, onClose, onDone }) {
  const { data: people } = useApi('/messages/people');
  const [chosen, setChosen] = useState([]);
  const inIt = new Set(members.map((m) => m.id));
  const [add, busy] = useAction(async () => { await api.post(`/messages/conversations/${conversation.id}/members`, { user_ids: chosen }); onDone(); onClose(); });
  const choices = (people || []).filter((p) => !inIt.has(p.id));
  return (
    <Modal title="Add people" subtitle="They will see the whole conversation, from the start." size="sm" onClose={onClose} onSubmit={add}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" icon={UserPlus} busy={busy} disabled={!chosen.length}>Add</Button></>}>
      {!people ? <Loading /> : !choices.length ? <p className="text-sm text-stone-500">Everybody active on your team is in this group already.</p>
        : <PeoplePicker people={choices} chosen={chosen} onChange={setChosen} label="Who to add" />}
    </Modal>
  );
}

function MembersModal({ members, onClose }) {
  const { user } = useApp();
  return (
    <Modal title="People in this group" subtitle={`${members.length} people`} size="sm" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <ul className="divide-y divide-line">
        {members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 py-2">
            <Avatar name={m.name} size={30} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-900">{m.name}{m.id === user.id && <span className="font-normal text-stone-500"> (you)</span>}</span>
            {!m.on_team && <span className="text-xs text-stone-500">No longer on the team</span>}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** Why a message did not go, in plain words: the server's own reason, or (with no answer at all) the connection. */
const notSentBecause = (err) => (err.status ? err.message : 'Check your connection and try again.');

/**
 * Write at the bottom of a conversation. Enter sends, Shift+Enter starts a new line. A candidate or a job can be
 * attached first, and taken off again before sending. `box` is the text box, for the thread to put the keyboard in.
 */
function Composer({ onSend, disabledReason, box }) {
  const [body, setBody] = useState('');
  const [chip, setChip] = useState(null);
  const [attaching, setAttaching] = useState(false);
  const [sending, setSending] = useState(0); // how many messages are on their way
  // Messages that did not go, kept here with their words and chip until they are sent again or put aside: the box may
  // hold the next message by then, and nothing that was written is ever thrown away without being asked.
  const [unsent, setUnsent] = useState([]);
  const queue = useRef(Promise.resolve());
  const keys = useRef(0);
  // The box grows with what is written, up to about six lines, then scrolls.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [body]);
  // The box is emptied at once, so the next message can be written while this one is on its way. Messages go one after
  // another, in the order they were written. One that fails is shown above the box as not sent, with its words.
  const dispatch = (text, attached) => {
    setSending((n) => n + 1);
    queue.current = queue.current.then(() => onSend(text, attached)).catch((err) => {
      keys.current += 1;
      setUnsent((list) => [...list, { key: keys.current, text, chip: attached, why: notSentBecause(err) }]);
    }).finally(() => setSending((n) => n - 1));
  };
  const send = () => {
    const text = body, attached = chip;
    if (!text.trim() || text.trim().length > BODY_MAX) return;
    setBody('');
    setChip(null);
    dispatch(text, attached);
    box.current?.focus();
  };
  const putAside = (u) => { setUnsent((list) => list.filter((x) => x !== u)); box.current?.focus(); };
  const again = (u) => { putAside(u); dispatch(u.text, u.chip); };
  // Back into the box to change it, in front of whatever is being written now.
  const edit = (u) => {
    putAside(u);
    setBody((now) => (now.trim() ? `${u.text}\n${now}` : u.text));
    setChip((now) => now || u.chip);
  };
  if (disabledReason) return <p className="border-t border-line bg-stone-50 px-4 py-3 text-sm text-stone-600">{disabledReason}</p>;
  const tooLong = body.trim().length > BODY_MAX;
  return (
    <form className="border-t border-line bg-white px-3 py-2.5 sm:px-4" onSubmit={(e) => { e.preventDefault(); send(); }}>
      {unsent.length > 0 && (
        <ul className="mb-2 space-y-2" role="alert">
          {unsent.map((u) => (
            <li key={u.key} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm">
              <p className="flex items-center gap-1.5 font-medium text-red-800"><CircleAlert className="size-4 shrink-0" />This message was not sent. {u.why}</p>
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-stone-800 [overflow-wrap:anywhere]">{u.text}</p>
              {u.chip && <div className="mt-1.5"><AttachmentChip attachment={u.chip} /></div>}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" icon={RotateCw} onClick={() => again(u)} className="max-sm:h-10">Try again</Button>
                <Button size="sm" icon={Pencil} onClick={() => edit(u)} className="max-sm:h-10">Edit</Button>
                <Button size="sm" variant="ghost" icon={X} onClick={() => putAside(u)} className="max-sm:h-10">Remove</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {chip && <div className="mb-2"><AttachmentChip attachment={chip} onRemove={() => { setChip(null); box.current?.focus(); }} /></div>}
      <div className="flex items-end gap-2">
        <Button variant="ghost" icon={Paperclip} onClick={() => setAttaching(true)} aria-label="Attach a candidate or a job" title="Attach a candidate or a job" className="!px-2.5 max-sm:h-10 max-sm:min-w-10" />
        <textarea ref={box} rows={1} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Write a message"
          placeholder="Write a message…" maxLength={BODY_MAX + 500}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a new line; Enter while an accented letter is being composed is left alone.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
          }}
          className="min-h-9 min-w-0 flex-1 resize-none max-sm:min-h-10 rounded-lg border border-line bg-white px-3 py-[7px] text-sm leading-relaxed text-stone-900 placeholder:text-stone-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20" />
        <Button type="submit" variant="primary" icon={Send} busy={sending > 0 && !body.trim()} disabled={!body.trim() || tooLong} aria-label="Send" title="Send (Enter)" className="max-sm:h-10 max-sm:min-w-11"><span className="max-sm:hidden">Send</span></Button>
      </div>
      <p className={cx('mt-1 text-[11.5px] text-stone-500 max-sm:hidden', tooLong && 'text-red-700')}>
        {tooLong ? `Too long: ${body.trim().length} of ${BODY_MAX} characters.` : 'Enter to send, Shift+Enter for a new line.'}
      </p>
      {attaching && <AttachModal onClose={() => setAttaching(false)} onPick={(a) => { setChip(a); setAttaching(false); setTimeout(() => box.current?.focus(), 0); }} />}
    </form>
  );
}

/** One message, or one of the app's own lines. `head` says whether the sender's name and avatar are shown above it. */
function MessageRow({ message: m, head, onDelete }) {
  if (m.kind === 'system') {
    return <li className="my-3 px-6 text-center text-xs text-stone-500 italic"><MessageText text={m.body} /> · {fmtTime(m.created_at)}</li>;
  }
  const name = m.user_name || 'Somebody no longer on the team';
  return (
    <li className={cx('group flex gap-2.5', m.mine ? 'flex-row-reverse' : '', head ? 'mt-3' : 'mt-1')}>
      {!m.mine && (head ? <Avatar name={name} size={30} className="mt-0.5" /> : <span className="w-[30px] shrink-0" aria-hidden="true" />)}
      <div className={cx('flex min-w-0 max-w-[85%] flex-col sm:max-w-[70%]', m.mine ? 'items-end' : 'items-start')}>
        {head && (
          <div className={cx('mb-0.5 flex items-baseline gap-2 text-xs', m.mine && 'flex-row-reverse')}>
            <span className="font-semibold text-stone-800">{m.mine ? 'You' : name}</span>
            <span className="tabular text-stone-500">{fmtTime(m.created_at)}</span>
          </div>
        )}
        <div className={cx('flex max-w-full items-center gap-1', m.mine && 'flex-row-reverse')}>
          <div className={cx('min-w-0 max-w-full rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
            m.deleted ? 'border border-dashed border-stone-300 bg-transparent text-stone-500 italic' : m.mine ? 'bg-brand-700 text-white' : 'border border-line bg-white text-stone-900')}
            title={head ? undefined : fmtTime(m.created_at)}>
            {m.deleted ? 'This message was deleted' : <MessageText text={m.body} />}
            {m.attachment && <div className="mt-1.5"><AttachmentChip attachment={m.attachment} className={m.mine ? '!border-white/30 !bg-white !text-brand-900' : ''} /></div>}
          </div>
          {m.mine && !m.deleted && (
            <button type="button" onClick={() => onDelete(m)} aria-label="Delete this message" title="Delete this message"
              className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-stone-400 hover:bg-stone-100 hover:text-red-700 max-sm:size-10 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100">
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * Messages under a heading for each day; the name and avatar again when the sender changes or after five minutes.
 * Each day is a group of its own, so its heading stays at the top only while that day's messages are in view and is
 * pushed away by the next day's, never drawn over it.
 */
function Messages({ messages, onDelete }) {
  const days = [];
  for (const m of messages) {
    const d = new Date(m.created_at).toDateString();
    if (days.at(-1)?.day !== d) days.push({ day: d, messages: [] });
    days.at(-1).messages.push(m);
  }
  return (
    <ol className="px-3 pb-3 sm:px-5" aria-label="Messages">
      {days.map(({ day, messages: those }) => (
        <li key={day}>
          <h3 className="sticky top-0 z-10 flex justify-center py-1.5"><span className="rounded-full border border-line bg-paper px-3 py-0.5 text-xs font-medium text-stone-600">{fmtDay(those[0].created_at)}</span></h3>
          <ol>
            {those.map((m, i) => {
              const prev = those[i - 1];
              const head = !prev || prev.kind === 'system' || prev.user_id !== m.user_id || new Date(m.created_at) - new Date(prev.created_at) > 5 * 60000;
              return <MessageRow key={m.id} message={m} head={head} onDelete={onDelete} />;
            })}
          </ol>
        </li>
      ))}
    </ol>
  );
}

/** Merge messages in by id: one that is already there is replaced (a deletion, say), never shown twice. Oldest first. */
const merge = (have, more) => {
  const byId = new Map(have.map((m) => [m.id, m]));
  for (const m of more) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
};

function Thread({ id }) {
  const { user } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [state, setState] = useState({ conversation: null, members: [], error: null, gone: false });
  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [unseen, setUnseen] = useState(0); // new messages that arrived while the reader was scrolled up
  const [announce, setAnnounce] = useState(''); // said by a screen reader when somebody else's message comes in
  const [modal, setModal] = useState(null);
  const since = useRef(null);
  // The newest message the server has given this thread when it was opened or asked what is new. A message sent from
  // here is not counted: somebody else's message written just before it has not been fetched yet, and asking for
  // what is after the sent one would skip it for good.
  const cursor = useRef(0);
  const marked = useRef(0); // the newest message this thread has marked read
  const polling = useRef(null); // the question to the server that is on its way, if any
  const pollAgain = useRef(false);
  const scroller = useRef(null);
  const box = useRef(null);
  const menu = useRef(null);
  const atBottom = useRef(true);
  const nextScroll = useRef('bottom'); // what to do with the scroll position once the messages are drawn

  /** Mark the conversation read as far as `upTo`, the newest message shown. Only while the reader can see it. */
  const markRead = useCallback(async (upTo) => {
    if (document.visibilityState !== 'visible' || !upTo || upTo <= marked.current) return;
    const was = marked.current;
    marked.current = upTo; // at once, so a burst of scroll events sends it once
    try { await api.post(`/messages/conversations/${id}/read`, { up_to: upTo }); messagesChanged(); } catch { marked.current = was; /* the next look will try again */ }
  }, [id]);
  const failed = (err) => {
    if (err.status === 404) setState((s) => ({ ...s, gone: true }));
    else setState((s) => ({ ...s, error: err.message }));
  };
  const loadHeader = useCallback(async () => {
    const data = await api.get(`/messages/conversations/${id}`);
    setState({ conversation: data.conversation, members: data.members, error: null, gone: false });
    return data;
  }, [id]);

  useEffect(() => {
    let live = true;
    loadHeader().then((data) => {
      if (!live) return;
      since.current = data.now;
      cursor.current = data.messages.at(-1)?.id || 0;
      marked.current = data.last_read_id || 0;
      nextScroll.current = 'bottom';
      setMessages(data.messages);
      setHasMore(data.has_more);
      markRead(cursor.current);
    }).catch((err) => live && failed(err));
    return () => { live = false; };
  }, [id, loadHeader, markRead]);

  // Opened from "New message": the keyboard goes straight to the box, to write the first message.
  const ready = Boolean(state.conversation);
  useEffect(() => {
    if (ready && location.state?.write) box.current?.focus();
  }, [ready, location.state]);

  // Anything new since the last look: newer messages by id, and messages deleted since then. One question at a time:
  // asked again while one is on its way, it is asked once more as soon as that one is answered.
  const ask = useCallback(async () => {
    const after = cursor.current;
    const data = await api.get(`/messages/conversations/${id}/messages?after=${after}${since.current ? `&since=${encodeURIComponent(since.current)}` : ''}`);
    since.current = data.now;
    if (data.deleted.length) {
      const gone = new Set(data.deleted);
      setMessages((have) => have.map((m) => (gone.has(m.id) ? { ...m, deleted: true, body: null, attachment: null } : m)));
    }
    if (data.messages.length) {
      cursor.current = Math.max(cursor.current, data.messages.at(-1).id);
      const fromOthers = data.messages.filter((m) => !m.mine);
      const said = fromOthers.filter((m) => m.kind === 'text');
      if (said.length) setAnnounce(said.length === 1 ? `New message from ${said[0].user_name || 'somebody no longer on the team'}` : `${said.length} new messages`);
      if (atBottom.current) nextScroll.current = 'bottom';
      else if (fromOthers.length) setUnseen((n) => n + fromOthers.length);
      setMessages((have) => merge(have, data.messages));
      // A group renamed or somebody added or gone: the heading and the people in it are looked at again.
      if (data.messages.some((m) => m.kind === 'system')) loadHeader().catch(failed);
    }
    // Read as far as what has been shown, when the reader is at the newest: also when the tab has just come into view
    // with messages that were drawn while it was hidden.
    if (atBottom.current) markRead(cursor.current);
  }, [id, loadHeader, markRead]);
  const poll = useCallback(() => {
    if (!state.conversation || state.gone) return Promise.resolve();
    if (polling.current) { pollAgain.current = true; return polling.current; }
    polling.current = (async () => {
      try {
        do {
          pollAgain.current = false;
          await ask();
        } while (pollAgain.current);
      } catch (err) { failed(err); } finally { polling.current = null; }
    })();
    return polling.current;
  }, [ask, state.conversation, state.gone]);
  useWhileVisible(poll, THREAD_EVERY);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const want = nextScroll.current;
    nextScroll.current = null;
    if (want === 'bottom') el.scrollTop = el.scrollHeight;
    else if (want?.keepFrom != null) el.scrollTop = el.scrollHeight - want.keepFrom; // older messages were put above: stay where you were
  }, [messages]);
  // When the window gets shorter (a phone's keyboard opening, say), a reader at the newest message stays there.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const watch = new ResizeObserver(() => { if (atBottom.current) el.scrollTop = el.scrollHeight; });
    watch.observe(el);
    return () => watch.disconnect();
  }, [ready]);
  const onScroll = () => {
    const el = scroller.current;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    atBottom.current = near;
    if (near) {
      if (unseen) setUnseen(0);
      markRead(cursor.current);
    }
  };
  const toBottom = () => {
    const el = scroller.current;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setUnseen(0);
    markRead(cursor.current);
    box.current?.focus({ preventScroll: true });
  };

  const [earlier, loadingEarlier] = useAction(async () => {
    const data = await api.get(`/messages/conversations/${id}?before=${messages[0].id}`);
    nextScroll.current = { keepFrom: scroller.current.scrollHeight - scroller.current.scrollTop };
    setMessages((have) => merge(have, data.messages));
    setHasMore(data.has_more);
  });
  const send = async (body, chip) => {
    const { message } = await api.post(`/messages/conversations/${id}/messages`, {
      body, application_id: chip?.type === 'candidate' ? chip.application_id : null, job_id: chip?.type === 'job' ? chip.job_id : null,
    });
    nextScroll.current = 'bottom';
    atBottom.current = true;
    setUnseen(0);
    setMessages((have) => merge(have, [message]));
    // Whatever others wrote just before is fetched now, from where the thread had got to; and as the writer is at the
    // newest, it is all marked read as far as what was fetched (the server does not assume so, for a message sent
    // from a profile).
    poll();
  };
  const [remove] = useAction(async (m) => {
    if (!window.confirm('Delete this message? It is removed for everybody in the conversation, and the conversation shows “This message was deleted”.')) return;
    await api.del(`/messages/conversations/${id}/messages/${m.id}`);
    setMessages((have) => have.map((x) => (x.id === m.id ? { ...x, deleted: true, body: null, attachment: null } : x)));
    // Its button is gone: the keyboard goes to the box rather than back to the top of the page.
    box.current?.focus({ preventScroll: true });
    messagesChanged();
  });
  const [leave] = useAction(async () => {
    if (!window.confirm(`Leave “${state.conversation.name}”? You will no longer see it or be told about new messages in it. Somebody in it can add you again.`)) return;
    await api.post(`/messages/conversations/${id}/leave`);
    toast(`You left ${state.conversation.name}`);
    messagesChanged();
    navigate('/messages');
  });
  const changed = () => { messagesChanged(); poll(); };
  // The group's dialogs are opened from its menu, whose items are gone by the time they close: back to the menu's button.
  const closeModal = () => {
    setModal(null);
    requestAnimationFrame(() => menu.current?.querySelector('button')?.focus());
  };

  const back = <Link to="/messages" aria-label="Back to all conversations" className="-ml-1.5 rounded-md p-2.5 text-stone-600 hover:bg-stone-100 md:hidden"><ArrowLeft className="size-5" /></Link>;
  if (state.gone) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5 md:hidden">{back}</div>
        <Empty icon={MessagesSquare} title="This conversation is not in your messages">It may have been a group you left, or the link is wrong. Choose a conversation from the list.</Empty>
      </div>
    );
  }
  if (state.error && !state.conversation) return <Empty icon={CircleAlert} title="This conversation could not be loaded">{state.error}</Empty>;
  if (!state.conversation) return <Loading className="h-full" />;
  const c = state.conversation;
  const group = c.kind === 'group';
  const others = state.members.filter((m) => m.id !== user.id);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2.5 border-b border-line bg-white px-3 py-2 sm:px-4 sm:py-2.5">
        {back}
        <ConversationAvatar conversation={c} size={34} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold text-stone-900">{c.title}</h2>
          <p className="truncate text-xs text-stone-500">
            {group ? ['You', ...others.map((m) => m.name)].join(', ') : others[0] && !others[0].on_team ? 'No longer on your team' : 'One-to-one'}
          </p>
        </div>
        {group && (
          <div ref={menu}>
            <Menu trigger={<Button variant="ghost" icon={MoreHorizontal} aria-label="Group options" className="!px-2.5 max-sm:h-10 max-sm:min-w-10" />}
              items={[
                { label: 'Rename the group', icon: Pencil, onClick: () => setModal('rename') },
                { label: 'Add people', icon: UserPlus, onClick: () => setModal('add') },
                { label: `See who is in it (${state.members.length})`, icon: Users, onClick: () => setModal('members') },
                null,
                { label: 'Leave the group', icon: LogOut, danger: true, onClick: leave },
              ]} />
          </div>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto bg-paper" tabIndex={-1}>
          {hasMore && <div className="pt-3 text-center"><Button size="sm" busy={loadingEarlier} onClick={earlier}>Show earlier messages</Button></div>}
          {!messages.some((m) => m.kind === 'text') && (
            <p className="px-6 pt-8 text-center text-sm text-stone-500">{group ? 'Nobody has written here yet. Say hello to the group.' : `This is the start of your conversation with ${c.title}. Only the two of you can read it.`}</p>
          )}
          <Messages messages={messages} onDelete={remove} />
        </div>
        <p className="sr-only" aria-live="polite">{announce}</p>
        {unseen > 0 && (
          <button type="button" onClick={toBottom} className="animate-pop-in absolute bottom-3 left-1/2 inline-flex min-h-10 -translate-x-1/2 items-center gap-1.5 rounded-full bg-brand-700 px-3.5 py-1.5 text-[13px] font-medium text-white shadow-lg hover:bg-brand-800">
            <ArrowDown className="size-4" />New messages
          </button>
        )}
      </div>
      <Composer onSend={send} box={box} disabledReason={c.can_post ? null : c.why_not} />
      {modal === 'rename' && <RenameModal conversation={c} onClose={closeModal} onDone={changed} />}
      {modal === 'add' && <AddPeopleModal conversation={c} members={state.members} onClose={closeModal} onDone={changed} />}
      {modal === 'members' && <MembersModal members={state.members} onClose={closeModal} />}
    </div>
  );
}

export default function MessagesPage() {
  const { id } = useParams();
  const activeId = Number(id) || null;
  const [list, setList] = useState({ conversations: null, error: null });
  const [starting, setStarting] = useState(false);
  const load = useCallback(() => api.get('/messages/conversations')
    .then((conversations) => setList({ conversations, error: null }))
    .catch((err) => setList((s) => ({ ...s, error: err.message }))), []);
  useEffect(() => { load(); }, [load, activeId]);
  useWhileVisible(load, LIST_EVERY);
  useEffect(() => {
    window.addEventListener('messages:changed', load);
    return () => window.removeEventListener('messages:changed', load);
  }, [load]);
  return (
    <div className="flex h-full min-h-0">
      <section aria-label="Your conversations" className={cx('min-h-0 w-full border-line bg-white md:w-80 md:shrink-0 md:border-r lg:w-[340px]', activeId && 'max-md:hidden')}>
        <ConversationList conversations={list.conversations} error={list.error} activeId={activeId} onNew={() => setStarting(true)} />
      </section>
      <section aria-label="Conversation" className={cx('min-h-0 min-w-0 flex-1', activeId ? '' : 'max-md:hidden')}>
        {activeId ? <Thread key={activeId} id={activeId} /> : (
          <div className="flex h-full items-center justify-center bg-paper">
            <Empty icon={MessagesSquare} title="Choose a conversation" action={<Button icon={Plus} onClick={() => setStarting(true)}>New message</Button>}>
              Pick one from the list, or start a new one with somebody on your team.
            </Empty>
          </div>
        )}
      </section>
      {starting && <NewConversationModal onClose={() => setStarting(false)} />}
    </div>
  );
}
