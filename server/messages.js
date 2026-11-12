// Messages: chat between people on the agency team, one to one or in a named group, in the manner of Teams. A
// message can carry one candidate or one job, and then it is listed on that profile too, for the people who can read
// the conversation it is in.
//
// Four rules shape everything here.
//  1. It is the agency's business alone. Every route refuses a client's user, a client's user is never offered as
//     somebody to write to, and nothing about a message is written anywhere a client's user is shown from: not a
//     candidate's history, notes or e-mails, and no column on applications, candidates or jobs. It all lives in three
//     tables (conversations, conversation_members, messages; see db.js) that only this file reads.
//  2. Only the people in a conversation know it is there. Every route about one conversation answers "not found",
//     exactly as for one that never existed, to anybody who is not in it now: never been in it, or left it. The same
//     goes for the list of messages on a candidate's profile or a job: it holds only messages from conversations the
//     person looking is in, so a one-to-one chat stays between its two people.
//  3. One one-to-one conversation for each pair of people. Starting one with somebody you already have one with opens
//     that one; the database refuses a second (conversations.pair_key), so two clicks at once cannot make two.
//  4. People come and go. Somebody added to a group reads its whole history, as in Teams. Somebody who leaves it no
//     longer sees it, cannot read or write in it, and is not counted or e-mailed about it. Somebody deactivated, or
//     since made a client's user, keeps their place in the conversations they were in, so their messages stay with
//     their name, but nobody can start a conversation with them, add them, or write to them one to one, and they are
//     never e-mailed. Somebody removed from the database outright is in no conversation; what they wrote stays,
//     shown as from somebody no longer on the team (the same as reviews.js does for people removed).
//
// Unread is counted for each person: messages by anybody else after the last one they have read (last_read_id, a
// message id, so that two messages in the same millisecond are never read or unread together). The thread marks the
// conversation read as far as the messages it has shown. The app's own lines (a group made, renamed, joined or
// left) are not counted and are never e-mailed about.
//
// The e-mail heads-up goes through notify() in mail.js, which is the team's e-mail and does not wait for the switch
// for e-mails to candidates. Each person gets at most one e-mail about a conversation until they have read it: the
// e-mail remembers the message it was about (mailed_id, with mailed_at saying when), and the next one can go once they
// have read as far as that message (last_read_id). None at all if they have switched "Email me about new messages" off.
import { q, tx, now, scrub, getSetting } from './db.js';
import { notify, appUrl, mailConfigured } from './mail.js';

const BODY_MAX = 4000;
const NAME_MAX = 80;
/** How many messages a thread is opened with, and how many more each "Show earlier messages" brings. */
const PAGE = 100;
/** Somebody who can be written to, added to a group or e-mailed: active on the agency team. */
const ON_TEAM = `u.role != 'client' AND u.active = 1 AND u.pending = 0`;
const onTeam = (userId) => Boolean(userId && q.get(`SELECT 1 AS x FROM users u WHERE u.id = ? AND ${ON_TEAM}`, userId));
const firstName = (name) => String(name || '').split(/\s+/)[0];

// Control characters have no place in what people write to each other, and a NUL would even cut the text short where
// SQLite stores it. A message keeps its line breaks and tabs; a group's name is one line, and also loses the marks that
// turn text right to left or isolate it, which could make a name read differently in the list or an e-mail's subject.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;
const NAME_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g;
/** The words of a message as they are kept: line breaks made plain, control characters taken out, spaces at either end trimmed. */
const cleanBody = (value) => (typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim() : '');
/** A user id from a request, or null: a whole number, written as one or as digits. */
const idOf = (value) => (typeof value === 'number' && Number.isInteger(value) && value > 0) || (typeof value === 'string' && /^\d+$/.test(value)) ? Number(value) : null;

/**
 * Unread messages for one person in every conversation they are in now, for the count beside Messages in the menu.
 * Deleted messages and the app's own lines are not counted.
 */
export function unreadFor(userId) {
  return q.get(
    `SELECT COUNT(*) AS n FROM conversation_members cm JOIN messages m ON m.conversation_id = cm.conversation_id
     WHERE cm.user_id = ? AND cm.left_at IS NULL AND m.kind = 'text' AND m.deleted_at IS NULL
       AND (m.user_id IS NULL OR m.user_id != cm.user_id) AND m.id > cm.last_read_id`, userId).n;
}

/**
 * Two applications became one and `goingId` is about to be deleted (inside the caller's transaction): messages about
 * it are about the kept one from now on, so they stay on the person's profile rather than losing their chip.
 */
export function entryFolded(goingId, keptId) {
  q.run('UPDATE messages SET application_id = ? WHERE application_id = ?', keptId, goingId);
}

// ---------- reading ----------

/** The candidate or job a message carries, as the screens show it on a chip. */
function attachmentOf(m) {
  if (m.application_id) {
    return { type: 'candidate', application_id: m.application_id, name: m.att_candidate_name,
      detail: m.att_job_title ? `${m.att_job_title} at ${m.att_client_name}` : 'In The Book, not on a job' };
  }
  if (m.job_id) return { type: 'job', job_id: m.job_id, title: m.job_title_only, detail: m.job_client_name };
  return null;
}
const MESSAGE_SELECT = `
  SELECT m.*, u.name AS user_name, c.name AS att_candidate_name, aj.title AS att_job_title, acl.name AS att_client_name,
    j.title AS job_title_only, jcl.name AS job_client_name
  FROM messages m LEFT JOIN users u ON u.id = m.user_id
  LEFT JOIN applications a ON a.id = m.application_id LEFT JOIN candidates c ON c.id = a.candidate_id
  LEFT JOIN jobs aj ON aj.id = a.job_id LEFT JOIN clients acl ON acl.id = aj.client_id
  LEFT JOIN jobs j ON j.id = m.job_id LEFT JOIN clients jcl ON jcl.id = j.client_id`;
/** A message as the screens get it. A deleted one says so and carries nothing else of what it was. */
function shown(m, user) {
  const deleted = Boolean(m.deleted_at);
  return {
    id: m.id, conversation_id: m.conversation_id, kind: m.kind,
    user_id: m.user_id, user_name: m.user_name ?? null,
    body: deleted ? null : m.body,
    deleted, created_at: m.created_at,
    mine: m.user_id === user.id,
    attachment: deleted ? null : attachmentOf(m),
  };
}

const MEMBER_SELECT = `SELECT cm.conversation_id, u.id, u.name, cm.left_at, (${ON_TEAM}) AS on_team
  FROM conversation_members cm JOIN users u ON u.id = cm.user_id`;
const member = (p) => ({ id: p.id, name: p.name, left: Boolean(p.left_at), on_team: Boolean(p.on_team) });
/** The people in a conversation, with who is still in it and who can still be written to. */
const membersOf = (conversationId) => q.all(`${MEMBER_SELECT} WHERE cm.conversation_id = ? ORDER BY u.name, u.id`, conversationId).map(member);
/**
 * The people in many conversations at once, in one query, by conversation id: for the list of conversations and the
 * messages on a profile, which would otherwise ask once for every row they show.
 */
function membersOfMany(where, ...values) {
  const byConversation = new Map();
  for (const p of q.all(`${MEMBER_SELECT} WHERE cm.conversation_id IN (${where}) ORDER BY u.name, u.id`, ...values)) {
    if (!byConversation.has(p.conversation_id)) byConversation.set(p.conversation_id, []);
    byConversation.get(p.conversation_id).push(member(p));
  }
  return (conversationId) => byConversation.get(conversationId) || [];
}

/**
 * What a conversation is called for the person looking: a group's name, or the other person's name in a one-to-one
 * (or "Somebody no longer on the team" when they were removed from the database).
 */
function titleOf(conversation, members, userId) {
  if (conversation.kind === 'group') return conversation.name;
  return members.find((p) => p.id !== userId)?.name || 'Somebody no longer on the team';
}

/**
 * Whether the person can write here, and if not, why in plain words. In a one-to-one, the other person must still be
 * active on the agency team; a group can always be written to by the people in it.
 */
function postable(conversation, members, userId) {
  if (conversation.kind === 'group') return { can_post: true, why_not: null };
  const other = members.find((p) => p.id !== userId);
  if (!other) return { can_post: false, why_not: 'The other person is no longer on your team, so this conversation is read-only.' };
  if (!other.on_team) return { can_post: false, why_not: `${other.name} is no longer active on your team, so this conversation is read-only.` };
  return { can_post: true, why_not: null };
}

// ---------- e-mail ----------

/**
 * Tell the others in the conversation by e-mail, when e-mail is connected: each person still in it, active on the team
 * and with the switch on, who has read as far as the message their last e-mail was about (or has had none). The
 * message is noted as e-mailed before the e-mail is handed over, so a second message a moment later sends nothing
 * more. Not waited for: a message is sent whether or not the e-mail goes. An e-mail that did not go (the provider
 * refused it) is not counted, so the next message tries again rather than leaving the person untold until they read.
 */
function tellOthers({ conversation, messageId, sender, body, title }) {
  // With delivery not connected nothing would go, and nobody may be noted as told.
  if (!mailConfigured()) return;
  const at = now();
  const people = tx(() => {
    const due = q.all(
      `SELECT u.id, u.name, u.email FROM conversation_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.conversation_id = ? AND cm.user_id != ? AND cm.left_at IS NULL AND ${ON_TEAM} AND u.message_mail = 1
         AND (cm.mailed_id IS NULL OR cm.mailed_id <= cm.last_read_id)`, conversation.id, sender.id);
    for (const p of due) q.run('UPDATE conversation_members SET mailed_at = ?, mailed_id = ? WHERE conversation_id = ? AND user_id = ?', at, messageId, conversation.id, p.id);
    return due;
  });
  if (!people.length) return;
  const link = appUrl() ? `${appUrl()}/messages/${conversation.id}` : null;
  const agency = getSetting('agency_name', 'The Book');
  const excerpt = body.length > 200 ? `${body.slice(0, 200)}…` : body;
  const group = conversation.kind === 'group';
  for (const person of people) {
    const sent = notify({
      to: person.email,
      subject: group ? `${sender.name} wrote in ${title}` : `${sender.name} sent you a message`,
      body: `Hi ${firstName(person.name)},\n\n${sender.name} wrote${group ? ` in ${title}` : ' to you'} in The Book:\n\n${excerpt}\n\n` +
        `${link ? `Open the conversation: ${link}` : 'You will find it under Messages.'}\n\n` +
        'You will not be e-mailed about this conversation again until you have read it. ' +
        'To stop these e-mails, switch off "Email me about new messages" in Settings, under Your account.\n\n' +
        `${agency}\n`,
    });
    sent.then((handedOver) => {
      if (!handedOver) {
        q.run('UPDATE conversation_members SET mailed_at = NULL, mailed_id = NULL WHERE conversation_id = ? AND user_id = ? AND mailed_id = ?', conversation.id, person.id, messageId);
      }
    }).catch(() => {});
  }
}

// ---------- routes ----------
export function registerMessages(api, { agencyOnly, bad }) {
  /**
   * A conversation the signed-in person is in now, or one and the same 404 whether it never existed, they were never
   * in it, or they left it: nobody learns that a conversation exists from the answer.
   */
  const load = (req) => {
    const id = idOf(req.params.id);
    const c = id && q.get(
      `SELECT c.*, cm.last_read_at, cm.last_read_id FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
       WHERE c.id = ? AND cm.user_id = ? AND cm.left_at IS NULL`, id, req.user.id);
    if (!c) bad('That conversation is not in your messages.', 404);
    return c;
  };
  /** Add one of the app's own lines to a conversation ("Priya Nair added Marcus Bell"), and bring it to the top. */
  const systemLine = (conversationId, userId, body, at = now()) => {
    q.run(`INSERT INTO messages (conversation_id, user_id, kind, body, created_at) VALUES (?, ?, 'system', ?, ?)`, conversationId, userId, body, at);
    q.run('UPDATE conversations SET updated_at = ? WHERE id = ?', at, conversationId);
  };
  /** People to add, from a request: active on the agency team, not you, each once. Refused whole if one is not. */
  const teammates = (list, userId) => {
    if (!Array.isArray(list) || !list.length) bad('Choose who to add.');
    const ids = [...new Set(list.map(idOf))];
    if (ids.some((id) => id === userId)) bad('You are in it already. Choose somebody else on your team.');
    if (ids.some((id) => !onTeam(id))) bad('Choose people who are active on your team.');
    return ids.map((id) => q.get('SELECT id, name FROM users WHERE id = ?', id));
  };
  const groupName = (value) => {
    const name = typeof value === 'string' ? value.replace(NAME_CONTROL, ' ').replace(/\s+/g, ' ').trim() : '';
    if (!name) bad('Give the group a name.');
    if (name.length > NAME_MAX) bad(`Keep the group's name to ${NAME_MAX} characters.`);
    return name;
  };

  // Who can be written to: everybody active on the agency team but you, by name.
  api.get('/messages/people', agencyOnly, (req, res) => {
    res.json(q.all(`SELECT u.id, u.name, u.title FROM users u WHERE ${ON_TEAM} AND u.id != ? ORDER BY u.name, u.id`, req.user.id));
  });

  // The signed-in person's own choice about e-mails for new messages. Kept apart from /me, which a client's user is sent too.
  api.get('/messages/settings', agencyOnly, (req, res) => res.json({ email: req.user.message_mail !== 0 }));
  api.put('/messages/settings', agencyOnly, (req, res) => {
    if (typeof req.body?.email !== 'boolean') bad('email must be true or false.');
    q.run('UPDATE users SET message_mail = ? WHERE id = ?', req.body.email ? 1 : 0, req.user.id);
    res.json({ email: req.body.email });
  });

  // The conversations the signed-in person is in, newest first: what each is called, who is in it, its last line and
  // when, and how many messages in it they have not read.
  api.get('/messages/conversations', agencyOnly, (req, res) => {
    // Two queries in all, however many conversations there are: the conversations with their last line, and everybody
    // in them. The page asks again every twenty seconds, so it must not ask once more for each row.
    const rows = q.all(
      `SELECT c.*,
         (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.id > cm.last_read_id AND m.kind = 'text' AND m.deleted_at IS NULL
            AND (m.user_id IS NULL OR m.user_id != cm.user_id)) AS unread,
         lm.id AS last_id, lm.kind AS last_kind, lm.user_id AS last_user_id, lm.body AS last_body, lm.deleted_at AS last_deleted_at,
         lm.created_at AS last_created_at, lu.name AS last_user_name
       FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
       LEFT JOIN messages lm ON lm.id = (SELECT MAX(m.id) FROM messages m WHERE m.conversation_id = c.id)
       LEFT JOIN users lu ON lu.id = lm.user_id
       WHERE cm.user_id = ? AND cm.left_at IS NULL ORDER BY c.updated_at DESC, c.id DESC LIMIT 500`, req.user.id);
    const membersIn = membersOfMany('SELECT conversation_id FROM conversation_members WHERE user_id = ? AND left_at IS NULL', req.user.id);
    res.json(rows.map((c) => {
      const members = membersIn(c.id);
      const last = c.last_id && { kind: c.last_kind, user_id: c.last_user_id, body: c.last_body, deleted_at: c.last_deleted_at, created_at: c.last_created_at, user_name: c.last_user_name };
      return {
        id: c.id, kind: c.kind, name: c.name, title: titleOf(c, members, req.user.id),
        members: members.filter((p) => !p.left).map((p) => ({ id: p.id, name: p.name, on_team: p.on_team })),
        updated_at: c.updated_at, unread: c.unread,
        last: last && {
          kind: last.kind, mine: last.user_id === req.user.id, user_name: last.user_name ?? null, created_at: last.created_at,
          deleted: Boolean(last.deleted_at),
          // The first line only, for the list; the words of a deleted message are gone.
          text: last.deleted_at ? null : String(last.body || '').split('\n').find((line) => line.trim())?.trim().slice(0, 140) ?? '',
        },
      };
    }));
  });

  // Start a conversation. One to one ({ kind: 'direct', user_id }) opens the one you already have with that person
  // when there is one. A group ({ kind: 'group', name, user_ids }) needs a name and at least two other people.
  api.post('/messages/conversations', agencyOnly, (req, res) => {
    const b = req.body || {};
    const at = now();
    if (b.kind === 'direct') {
      const otherId = idOf(b.user_id);
      if (otherId === req.user.id) bad('You cannot message yourself. Choose somebody else on your team.');
      if (!onTeam(otherId)) bad('Choose somebody who is active on your team.');
      const pair = [req.user.id, otherId].sort((x, y) => x - y).join(':');
      const result = tx(() => {
        const existing = q.get('SELECT id FROM conversations WHERE pair_key = ?', pair);
        if (existing) return { id: existing.id, existing: true };
        // The unique index on pair_key is the last word: were another request to make the same pair in between, this
        // insert does nothing and the conversation it made is the one opened.
        const made = q.run(`INSERT INTO conversations (kind, pair_key, created_by, created_at, updated_at) VALUES ('direct', ?, ?, ?, ?) ON CONFLICT DO NOTHING`, pair, req.user.id, at, at);
        if (!made.changes) return { id: q.get('SELECT id FROM conversations WHERE pair_key = ?', pair).id, existing: true };
        const id = Number(made.lastInsertRowid);
        for (const userId of [req.user.id, otherId]) q.run('INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_at, last_read_id) VALUES (?, ?, ?, ?, 0)', id, userId, at, at);
        return { id, existing: false };
      });
      // Somebody who left nothing: a one-to-one cannot be left, so both are always in it.
      return res.json(result);
    }
    if (b.kind === 'group') {
      const name = groupName(b.name);
      const people = teammates(b.user_ids, req.user.id);
      if (people.length < 2) bad('A group needs at least two other people. For one person, start a one-to-one conversation.');
      const id = tx(() => {
        const made = q.insert(`INSERT INTO conversations (kind, name, created_by, created_at, updated_at) VALUES ('group', ?, ?, ?, ?)`, name, req.user.id, at, at);
        for (const userId of [req.user.id, ...people.map((p) => p.id)]) q.run('INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_at, last_read_id) VALUES (?, ?, ?, ?, 0)', made, userId, at, at);
        systemLine(made, req.user.id, `${req.user.name} made the group “${name}” with ${people.map((p) => p.name).join(', ')}`, at);
        return made;
      });
      return res.json({ id, existing: false });
    }
    bad('Choose one person for a one-to-one conversation, or several people and a name for a group.');
  });

  // One conversation: what it is called, who is in it, whether you can write, and its newest messages (oldest of them
  // first). ?before=<message id> gives the page of messages before that one instead, for "Show earlier messages".
  // Reading does not mark anything read: the thread says when it has shown them (POST .../read).
  api.get('/messages/conversations/:id', agencyOnly, (req, res) => {
    const c = load(req);
    const before = idOf(req.query.before);
    const page = q.all(`${MESSAGE_SELECT} WHERE m.conversation_id = ? ${before ? 'AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT ${PAGE + 1}`, c.id, ...(before ? [before] : []));
    const members = membersOf(c.id);
    res.json({
      conversation: { id: c.id, kind: c.kind, name: c.name, title: titleOf(c, members, req.user.id), created_at: c.created_at, ...postable(c, members, req.user.id) },
      members: members.filter((p) => !p.left),
      messages: page.slice(0, PAGE).reverse().map((m) => shown(m, req.user)),
      has_more: page.length > PAGE,
      last_read_at: c.last_read_at,
      last_read_id: c.last_read_id,
      now: now(),
    });
  });

  // What is new in a conversation since the thread last asked: messages after the last id it has, and the ids of
  // messages deleted since `since` (the `now` of its previous answer), so a deletion shows without opening it again.
  // Cheap enough to ask every few seconds.
  api.get('/messages/conversations/:id/messages', agencyOnly, (req, res) => {
    const c = load(req);
    const after = idOf(req.query.after) ?? 0;
    const since = typeof req.query.since === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(req.query.since) ? req.query.since : null;
    const at = now();
    res.json({
      messages: q.all(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.id > ? ORDER BY m.id LIMIT 500`, c.id, after).map((m) => shown(m, req.user)),
      deleted: since ? q.all('SELECT id FROM messages WHERE conversation_id = ? AND deleted_at IS NOT NULL AND deleted_at >= ? AND id <= ?', c.id, since, after).map((m) => m.id) : [],
      now: at,
    });
  });

  // Write a message: 1 to 4000 characters, with one candidate or one job if you like.
  api.post('/messages/conversations/:id/messages', agencyOnly, (req, res) => {
    const c = load(req);
    const b = req.body || {};
    const body = cleanBody(b.body);
    if (!body) bad('Write a message first.');
    if (body.length > BODY_MAX) bad(`Keep a message to ${BODY_MAX} characters. This one has ${body.length}.`);
    const members = membersOf(c.id);
    const can = postable(c, members, req.user.id);
    if (!can.can_post) bad(can.why_not, 409);
    const applicationId = b.application_id == null ? null : idOf(b.application_id);
    const jobId = b.job_id == null ? null : idOf(b.job_id);
    if (applicationId && jobId) bad('A message can carry one candidate or one job, not both.');
    if (b.application_id != null && !(applicationId && q.get('SELECT 1 AS x FROM applications WHERE id = ?', applicationId))) bad('That candidate is no longer in The Book.');
    if (b.job_id != null && !(jobId && q.get('SELECT 1 AS x FROM jobs WHERE id = ?', jobId))) bad('That job is no longer in The Book.');
    const at = now();
    const id = tx(() => {
      const made = q.insert('INSERT INTO messages (conversation_id, user_id, kind, body, application_id, job_id, created_at) VALUES (?, ?, \'text\', ?, ?, ?, ?)',
        c.id, req.user.id, body, applicationId, jobId, at);
      // Writing is not reading: a message sent from a candidate's profile into a conversation leaves what was unread in
      // it unread. The open thread marks it read itself.
      q.run('UPDATE conversations SET updated_at = ? WHERE id = ?', at, c.id);
      return made;
    });
    tellOthers({ conversation: c, messageId: id, sender: req.user, body, title: titleOf(c, members, req.user.id) });
    res.json({ message: shown(q.get(`${MESSAGE_SELECT} WHERE m.id = ?`, id), req.user) });
  });

  // The thread has shown the conversation: everything in it up to now is read. `up_to` (a message id) marks it read
  // only as far as that message: the thread says which is the newest it has shown, so a message that arrived after it
  // stays unread. Reading never goes backwards. Having read as far as the message an e-mail was about lets the next
  // message e-mail them again (see tellOthers).
  api.post('/messages/conversations/:id/read', agencyOnly, (req, res) => {
    const c = load(req);
    const upTo = idOf(req.body?.up_to);
    const to = upTo
      ? q.get('SELECT id FROM messages WHERE id = ? AND conversation_id = ?', upTo, c.id)?.id
      : q.get('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?', c.id).id ?? 0;
    if (to != null) {
      q.run('UPDATE conversation_members SET last_read_at = ?, last_read_id = MAX(last_read_id, ?) WHERE conversation_id = ? AND user_id = ?', now(), to, c.id, req.user.id);
    }
    res.json({ ok: true, unread: unreadFor(req.user.id) });
  });

  // Delete one of your own messages. It stays in the thread as "This message was deleted"; its words, and the
  // candidate or job it carried, are cleared from the database, and written over (secure_delete, and scrub()).
  api.delete('/messages/conversations/:id/messages/:messageId', agencyOnly, (req, res) => {
    const c = load(req);
    const m = q.get('SELECT * FROM messages WHERE id = ? AND conversation_id = ?', idOf(req.params.messageId), c.id);
    if (!m) bad('That message is not in this conversation.', 404);
    if (m.kind !== 'text' || m.user_id !== req.user.id) bad('You can only delete your own messages.', 403);
    if (!m.deleted_at) {
      q.run('UPDATE messages SET body = NULL, application_id = NULL, job_id = NULL, deleted_at = ? WHERE id = ?', now(), m.id);
      scrub();
    }
    res.json({ ok: true });
  });

  // Rename a group: anybody in it.
  api.patch('/messages/conversations/:id', agencyOnly, (req, res) => {
    const c = load(req);
    if (c.kind !== 'group') bad('Only a group has a name to change.');
    const name = groupName(req.body?.name);
    if (name !== c.name) {
      tx(() => {
        q.run('UPDATE conversations SET name = ? WHERE id = ?', name, c.id);
        systemLine(c.id, req.user.id, `${req.user.name} renamed the group “${name}”`);
      });
    }
    res.json({ ok: true, name });
  });

  // Add teammates to a group: anybody in it. Each person added reads the whole history, and starts with none of it
  // unread. Somebody who left can be added again.
  api.post('/messages/conversations/:id/members', agencyOnly, (req, res) => {
    const c = load(req);
    if (c.kind !== 'group') bad('People can only be added to a group. To bring somebody else in, start a group.');
    const inIt = new Set(membersOf(c.id).filter((p) => !p.left).map((p) => p.id));
    const people = teammates(req.body?.user_ids, req.user.id).filter((p) => !inIt.has(p.id));
    if (!people.length) bad('They are in this group already.');
    const at = now();
    tx(() => {
      for (const p of people) {
        q.run(`INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_at, last_read_id)
               VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages WHERE conversation_id = ?))
               ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL, joined_at = excluded.joined_at, last_read_at = excluded.last_read_at,
                 last_read_id = excluded.last_read_id, mailed_at = NULL, mailed_id = NULL`, c.id, p.id, at, at, c.id);
      }
      systemLine(c.id, req.user.id, `${req.user.name} added ${people.map((p) => p.name).join(', ')}`, at);
    });
    res.json({ ok: true, added: people.map((p) => p.id) });
  });

  // Leave a group. The history stays for everybody else, and the line "Alex Morgan left" is added.
  api.post('/messages/conversations/:id/leave', agencyOnly, (req, res) => {
    const c = load(req);
    if (c.kind !== 'group') bad('Only a group can be left.');
    const at = now();
    tx(() => {
      q.run('UPDATE conversation_members SET left_at = ? WHERE conversation_id = ? AND user_id = ?', at, c.id, req.user.id);
      systemLine(c.id, req.user.id, `${req.user.name} left`, at);
    });
    res.json({ ok: true });
  });

  // The messages that carry this candidate (?application_id=) or job (?job_id=), newest first, for their page: only
  // from conversations the person looking is in now, and never a deleted one.
  api.get('/messages/about', agencyOnly, (req, res) => {
    const applicationId = idOf(req.query.application_id), jobId = idOf(req.query.job_id);
    if (!applicationId === !jobId) bad('Say which candidate or job.');
    const rows = q.all(
      `${MESSAGE_SELECT} JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ? AND cm.left_at IS NULL
       WHERE m.kind = 'text' AND m.deleted_at IS NULL AND ${applicationId ? 'm.application_id = ?' : 'm.job_id = ?'}
       ORDER BY m.id DESC LIMIT 20`, req.user.id, applicationId || jobId);
    // The conversations these messages are in, and the people in them, in two more queries rather than two a row.
    const ids = [...new Set(rows.map((m) => m.conversation_id))];
    const marks = ids.map(() => '?').join(', ');
    const conversations = new Map(ids.length ? q.all(`SELECT * FROM conversations WHERE id IN (${marks})`, ...ids).map((c) => [c.id, c]) : []);
    const membersIn = ids.length ? membersOfMany(marks, ...ids) : () => [];
    res.json(rows.map((m) => {
      const c = conversations.get(m.conversation_id);
      return { ...shown(m, req.user), conversation_kind: c.kind, conversation_title: titleOf(c, membersIn(c.id), req.user.id) };
    }));
  });
}
