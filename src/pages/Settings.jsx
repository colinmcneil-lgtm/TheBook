import React, { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { Check, Copy, Download, LoaderCircle, Plus, RefreshCw, UserPlus, Trash2 } from 'lucide-react';
import { useApp, useApi, Pending } from '../state.jsx';
import { api, ago, fmtDate } from '../lib.js';
import { Checkbox, Avatar, Badge, Button, Card, CardHeader, Field, Input, Modal, Page, Tabs, Textarea, useAction, useToast } from '../ui.jsx';
import { ApproveForm, InviteForm } from '../components/Forms.jsx';
import { Notice } from '../oracle/bits.jsx';
import { knownLine, readingLine } from '../oracle/calls.js';
import { problemOf, useMetaview } from '../oracle/metaview.jsx';

/** A link such as /settings?tab=agency#metaview lands on that card, not at the top of the page. */
function useScrollToHash(ready) {
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash || !ready) return;
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash, ready]);
}

function Account() {
  const { user } = useApp();
  const toast = useToast();
  const [form, setForm] = useState({ current: '', next: '' });
  const [save, busy] = useAction(async () => { await api.post('/me/password', form); setForm({ current: '', next: '' }); toast('Password changed'); });
  return (
    <Card className="max-w-lg">
      <CardHeader title="Your account" />
      <div className="space-y-4 p-4">
        <div className="flex items-center gap-3">
          <Avatar name={user.name} size={40} />
          <div><div className="text-sm font-medium">{user.name}</div><div className="text-[13px] text-stone-500">{user.email}</div></div>
        </div>
        <form className="space-y-4 border-t border-line pt-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <Field label="Current password"><Input type="password" autoComplete="current-password" required value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} /></Field>
          <Field label="New password" hint="At least 8 characters."><Input type="password" autoComplete="new-password" required minLength={8} value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} /></Field>
          <Button type="submit" variant="primary" busy={busy}>Change password</Button>
        </form>
      </div>
    </Card>
  );
}

/** What the AI and Otterview are connected to. `metaview` is Metaview's connection, once it is known. */
function AiCard({ metaview }) {
  const { isAdmin } = useApp();
  const { data: status } = useApi('/jobs/autofill/status');
  const { data: oracle } = useApi('/oracle/status');
  if (!status) return null;
  const code = (text) => <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">{text}</code>;
  return (
    <Card>
      <CardHeader title="AI drafting" action={<Badge tone={status.ai ? 'green' : 'amber'}>{status.ai ? 'Connected' : 'Not connected'}</Badge>} />
      <div className="space-y-2 p-4 text-sm leading-relaxed text-stone-600">
        {status.ai ? (
          <p>When a recruiter fills in a job from a job description or an intake call, those documents are sent to Claude (Anthropic) to draft the job and its recruiter brief. Each use is billed to your Anthropic account.</p>
        ) : (
          <>
            <p>New jobs can be filled in from a job description or intake call. Without AI, only details a job description states outright are picked up (title, location, salary, requirement lists).</p>
            <p>To have the whole job and recruiter brief drafted, including from a call transcript, create an API key at console.anthropic.com and set {code('ANTHROPIC_API_KEY')} where the app is hosted, then restart it. Documents are then sent to Anthropic when a recruiter uses autofill, and each use is billed to that account.</p>
          </>
        )}
        {oracle && (
          <div className="mt-3 space-y-2 border-t border-line pt-3">
            <p className="flex flex-wrap items-center gap-2 font-medium text-stone-900">
              Otterview
              {metaview && <Badge tone={metaview.connected ? 'green' : 'amber'}>{metaview.connected ? 'Metaview connected' : 'Metaview not connected'}</Badge>}
              <Badge tone={oracle.transcription ? 'green' : 'amber'}>{oracle.transcription ? 'Transcripts connected' : 'Transcripts not connected'}</Badge>
              <Badge tone={oracle.ai ? 'green' : 'amber'}>{oracle.ai ? 'Notes and drafts connected' : 'Notes and drafts not connected'}</Badge>
            </p>
            <p>
              Otterview uses three connections. Your team’s calls are read from Metaview, with their transcripts and notes{metaview && !metaview.connected ? (isAdmin ? ' (connect it in the Metaview card below)' : ' (an admin can connect it here)') : ''}.
              {' '}Calls recorded or uploaded in The Book are sent to Deepgram to be transcribed{oracle.transcription ? '' : <> (create an API key at deepgram.com and set {code('DEEPGRAM_API_KEY')})</>},
              and transcripts are sent to Claude to write notes summaries and draft submissions{oracle.ai ? '' : <> (the {code('ANTHROPIC_API_KEY')} above)</>}.
              {' '}Without Deepgram and Claude, calls are still recorded and saved, and a transcript can be pasted in. Both are billed to your own accounts per use.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

const strong = (text) => <b className="font-medium text-stone-900">{text}</b>;
// Where Metaview keeps the key. Checked in Metaview's own settings.
const METAVIEW_STEPS = [
  <>In Metaview, open {strong('Settings')}, then {strong('Integrations')}, then {strong('MCP')}.</>,
  <>Switch on {strong('Use API Key instead of OAuth?')}</>,
  <>Click {strong('Generate API Key')} and name it {strong('The Book')}.</>,
  <>Copy the key and paste it here.</>,
];

/**
 * Connecting Metaview, for admins: the key goes in once and is never shown again. Once connected, what The Book has
 * read so far, whether calls are brought in by themselves, and the way to disconnect.
 */
function MetaviewCard({ metaview }) {
  const toast = useToast();
  const { status } = metaview;
  const [key, setKey] = useState('');
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  useScrollToHash(Boolean(status));
  const connect = async () => {
    setProblem(null);
    setBusy(true);
    try {
      // The server tries the key with Metaview before it keeps it, so a wrong one is refused here and now.
      const now = await api.put('/metaview/key', { key: key.trim() });
      metaview.set(now);
      setKey('');
      setReplacing(false);
      toast(now.workspace ? `Metaview connected: ${now.workspace}` : 'Metaview connected');
    } catch (err) { setProblem(problemOf(err)); }
    setBusy(false);
  };
  const [setAuto, savingAuto] = useAction(async (auto) => metaview.set(await api.put('/metaview/settings', { auto })));
  const [disconnect, disconnecting] = useAction(async () => {
    const here = Number(status.in_the_book || 0);
    if (!window.confirm(`Disconnect Metaview?\n\nKept: ${here === 1 ? 'the 1 call' : `the ${here.toLocaleString('en-CA')} calls`} already in Otterview, with ${here === 1 ? 'its' : 'their'} transcripts, notes and submission drafts.\n\nForgotten: the key, and what The Book remembered about the Metaview calls that were never brought in.\n\nNothing in Metaview is changed. The key itself keeps working there until you delete it in Metaview (Settings, Integrations, MCP).`)) return;
    await api.del('/metaview/key');
    toast('Metaview disconnected');
    await metaview.reload();
  });
  const keyForm = (label, button) => (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); connect(); }}>
      <Field label={label} hint="It is tried with Metaview before it is kept. The Book keeps it sealed and never shows it again, to you or anyone.">
        <Input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste the key" className="max-sm:!h-11 max-sm:!text-base" />
      </Field>
      {problem && <Notice tone="bad">{problem}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" busy={busy} disabled={!key.trim()}>{busy ? 'Checking the key with Metaview…' : button}</Button>
        {replacing && <Button disabled={busy} onClick={() => { setReplacing(false); setKey(''); setProblem(null); }}>Cancel</Button>}
      </div>
    </form>
  );
  const autoBox = (hint) => (
    <Checkbox checked={Boolean(status.auto)} disabled={savingAuto} onChange={(e) => setAuto(e.target.checked)} label="Bring in calls by themselves when they clearly belong to one candidate" hint={hint} />
  );
  const reading = readingLine(status);
  return (
    <Card id="metaview" className="scroll-mt-4">
      <CardHeader title="Metaview" action={status && <Badge tone={!status.connected ? 'amber' : status.error ? 'red' : 'green'}>{!status.connected ? 'Not connected' : status.error ? 'Not being read' : 'Connected'}</Badge>} />
      <div className="space-y-4 p-4 text-sm leading-relaxed text-stone-600">
        <p>Metaview records your team’s calls with candidates. Connect it and those calls appear in Otterview with their transcripts and notes, on the right candidates. The Book only reads from Metaview: nothing there is changed.</p>
        {!status ? (
          metaview.error ? <Notice tone="bad">The Metaview connection could not be checked. {metaview.error}</Notice> : <LoaderCircle className="size-5 animate-spin text-stone-400" aria-label="Loading" />
        ) : !status.connected ? (
          <>
            {/* Not connected, with something to say: a saved key that can no longer be read, or one set on the host that cannot be a key. */}
            {status.error && <Notice tone="warn">{status.error}</Notice>}
            <ol className="list-decimal space-y-1.5 pl-5">{METAVIEW_STEPS.map((step, i) => <li key={i}>{step}</li>)}</ol>
            {keyForm('Metaview API key', 'Connect')}
            <p className="text-[13px] text-stone-500">The key belongs to the person who makes it, and The Book sees the Metaview calls that person can see. Make it from an account that sees the whole team’s calls.</p>
            {/* Decided before connecting, because bringing calls in starts as soon as the key is accepted. */}
            {autoBox('Calls from the last two weeks, and new ones, that an email address or a phone number ties to one candidate come in without anyone opening them, up to a daily limit (50, unless that was changed where the app is hosted). Untick this first if you would rather bring calls in yourself.')}
          </>
        ) : (
          <>
            <div className="rounded-lg border border-line bg-stone-50 px-3 py-2.5">
              <p className="font-medium text-stone-900">{status.workspace || 'Your Metaview workspace'}</p>
              <p className="text-[13px] text-stone-600">{knownLine(status)}</p>
              <p className="text-[13px] text-stone-500">{status.last_checked_at ? `The Book last looked for new calls ${ago(status.last_checked_at)}.` : 'The Book has not looked for calls yet.'}</p>
              {reading && <p className="mt-1 flex items-center gap-2 text-[13px] text-stone-600" role="status"><LoaderCircle className="size-3.5 shrink-0 animate-spin text-brand-600" />{reading}.</p>}
            </div>
            {status.error && <Notice tone="warn"><span className="font-medium">Metaview could not be read the last time The Book looked.</span> {status.error}</Notice>}
            {autoBox('Other calls wait on the Metaview tab of Otterview until somebody opens them or chooses their candidate.')}
            <div className="flex flex-wrap gap-2">
              <Button icon={RefreshCw} busy={metaview.looking} onClick={metaview.look}>Look for new calls now</Button>
              {status.source !== 'server' && <Button variant="danger" busy={disconnecting} onClick={disconnect}>Disconnect</Button>}
            </div>
            {status.source === 'server' ? <p className="text-[13px] text-stone-500">The key was set where the app is hosted, so it is changed or removed there, not here.</p>
              : replacing ? keyForm('New Metaview API key', 'Replace key')
              : <button type="button" onClick={() => setReplacing(true)} className="text-[13px] font-medium text-brand-700 hover:underline">Use a different key</button>}
          </>
        )}
      </div>
    </Card>
  );
}

function Agency() {
  const { agencyName, isAdmin, reloadMe, mailConfigured, clientPhotos } = useApp();
  const toast = useToast();
  const [name, setName] = useState(agencyName);
  const [photos, setPhotos] = useState(clientPhotos);
  const [save, busy] = useAction(async () => { await api.put('/settings', { agencyName: name, clientPhotos: photos }); await reloadMe(); toast('Saved'); });
  const metaview = useMetaview();
  return (
    <div className="max-w-lg space-y-6">
      <Card>
        <CardHeader title="Agency" />
        <form className="space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <Field label="Agency name" hint="Shown in the workspace and on reports you prepare for clients."><Input value={name} onChange={(e) => setName(e.target.value)} required disabled={!isAdmin} /></Field>
          <Checkbox checked={photos} disabled={!isAdmin} onChange={(e) => setPhotos(e.target.checked)} label="Show candidate photos to client hiring teams"
            hint="Your own team always sees them. Switch this off if a client prefers to review candidates without photos." />
          {isAdmin && <Button type="submit" variant="primary" busy={busy}>Save</Button>}
        </form>
      </Card>
      <AiCard metaview={metaview.status} />
      {/* Connecting Metaview takes its key, so it is for admins. Everyone else sees whether it is connected, above. */}
      {isAdmin && <MetaviewCard metaview={metaview} />}
      <Card>
        <CardHeader title="Email delivery" action={<Badge tone={mailConfigured ? 'green' : 'amber'}>{mailConfigured ? 'Connected' : 'Not connected'}</Badge>} />
        <div className="space-y-2 p-4 text-sm leading-relaxed text-stone-600">
          {mailConfigured ? (
            <>
              <p>Emails to candidates are sent through your mail server and recorded on each candidate.</p>
              <p>Admins are emailed when someone requests an account, and people are emailed a link to set their password when their request is approved.</p>
            </>
          ) : (
            <>
              <p>Emails to candidates (application confirmations, interview invitations, rejections) are being saved on each candidate’s record but <b className="font-medium text-stone-900">not sent</b>.</p>
              <p>For the same reason, nobody is emailed when someone requests an account or when you approve one. Requests still appear here in Settings and on your dashboard, and approving one gives you a link to send to the person yourself.</p>
              <p>To send them, set <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">RESEND_API_KEY</code> and <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">MAIL_FROM</code> where the app is hosted (a free Resend account works, and this is the option to use on Railway), or <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">SMTP_URL</code> and <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">MAIL_FROM</code> for any other mail server. The README has the steps.</p>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

function Team() {
  const { isAdmin, user, bump } = useApp();
  const toast = useToast();
  const { data: people, error } = useApi('/users');
  const { data: invites } = useApi('/invites');
  const [modal, setModal] = useState(null); // 'invite' | { approve: person }
  const [setActive] = useAction(async (u, active) => { await api.patch(`/users/${u.id}`, { active }); toast(active ? 'Reactivated' : 'Deactivated'); bump(); });
  const [decline] = useAction(async (u) => {
    if (!window.confirm(`Decline ${u.name}'s account request? It will be removed.`)) return;
    await api.del(`/users/${u.id}`);
    toast('Request declined');
    bump();
  });
  const [revoke] = useAction(async (inv) => { await api.del(`/invites/${inv.id}`); toast('Invitation revoked'); bump(); });
  if (!people) return <Pending error={error} />;
  const waiting = people.filter((p) => p.pending);
  const members = people.filter((p) => !p.pending);
  const groups = [['Agency team', members.filter((p) => p.role !== 'client')], ['Client hiring teams', members.filter((p) => p.role === 'client')]];
  return (
    <div className="max-w-3xl space-y-6">
      {waiting.length > 0 && (
        <Card className="border-amber-300">
          <CardHeader title="Account requests" count={waiting.length} action={<span className="text-xs text-stone-500">From “Create an account” on the sign-in page</span>} />
          <ul className="divide-y divide-line">
            {waiting.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Avatar name={u.name} size={30} />
                <div className="min-w-0 flex-1 basis-56">
                  <div className="truncate text-sm font-medium text-stone-900">{u.name}</div>
                  <div className="truncate text-[13px] text-stone-500">{[u.email, u.requested_company, u.title].filter(Boolean).join(' · ')}</div>
                  <div className="text-xs text-stone-400">Requested {ago(u.created_at)}</div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="danger" onClick={() => decline(u)}>Decline</Button>
                  <Button size="sm" variant="primary" icon={Check} onClick={() => setModal({ approve: u })}>Approve</Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {groups.map(([title, list], gi) => (
        <Card key={title}>
          <CardHeader title={title} count={list.length} action={gi === 0 && isAdmin ? <Button size="sm" icon={UserPlus} onClick={() => setModal('invite')}>Invite teammate</Button> : gi === 1 ? <span className="text-xs text-stone-500">Invite from each client’s page</span> : null} />
          <ul className="divide-y divide-line">
            {list.map((u) => (
              <li key={u.id} className="flex items-center gap-3 px-4 py-2.5">
                <Avatar name={u.name} size={30} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-stone-900">
                    {u.name}
                    {u.role === 'admin' && <Badge tone="green">Admin</Badge>}
                    {u.client_name && <Badge>{u.client_name}</Badge>}
                    {!u.active && <Badge tone="red">Deactivated</Badge>}
                  </div>
                  <div className="truncate text-[13px] text-stone-500">{[u.title, u.email].filter(Boolean).join(' · ')}</div>
                </div>
                {u.id !== user.id && (u.role === 'client' || isAdmin) && (
                  <button type="button" onClick={() => setActive(u, !u.active)} className="text-xs font-medium text-stone-500 hover:text-stone-900">{u.active ? 'Deactivate' : 'Reactivate'}</button>
                )}
              </li>
            ))}
            {!list.length && <li className="px-4 py-5 text-sm text-stone-500">Nobody yet.</li>}
          </ul>
        </Card>
      ))}
      {invites?.length > 0 && (
        <Card>
          <CardHeader title="Open invitations" count={invites.length} action={<span className="text-xs text-stone-500">Unused links that still work</span>} />
          <ul className="divide-y divide-line">
            {invites.map((inv) => (
              <li key={inv.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-stone-900">{inv.role === 'client' ? `${inv.client_name} hiring team` : inv.role === 'admin' ? 'Agency admin' : 'Agency recruiter'}</div>
                  <div className="truncate text-[13px] text-stone-500">
                    {[inv.email ? `Only for ${inv.email}` : 'Anyone with the link', inv.created_by_name && `created by ${inv.created_by_name}`, `expires ${fmtDate(inv.expires_at)}`].filter(Boolean).join(' · ')}
                  </div>
                </div>
                {(inv.role === 'client' || isAdmin) && <button type="button" onClick={() => revoke(inv)} className="text-xs font-medium text-stone-500 hover:text-red-700">Revoke</button>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {modal === 'invite' && <InviteForm onClose={() => setModal(null)} />}
      {modal?.approve && <ApproveForm person={modal.approve} onClose={() => setModal(null)} />}
    </div>
  );
}

function Extension() {
  const toast = useToast();
  const address = window.location.origin;
  const copy = async () => { try { await navigator.clipboard.writeText(address); toast('Workspace address copied'); } catch { window.prompt('Copy this address', address); } };
  const steps = [
    <>Download the extension below and unzip it. You get a folder called <b className="font-medium text-stone-900">the-book-extension</b>.</>,
    <>In Chrome, open <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">chrome://extensions</code> and switch on <b className="font-medium text-stone-900">Developer mode</b> (top right).</>,
    <>Click <b className="font-medium text-stone-900">Load unpacked</b> and choose that folder. Pin “The Book” from the puzzle-piece menu so its icon stays visible.</>,
    <>Click the icon, paste your workspace address (below) and allow access when Chrome asks. You need to be signed in to this workspace in the same browser.</>,
  ];
  return (
    <div className="max-w-2xl space-y-6">
      <Card>
        <CardHeader title="Add candidates from LinkedIn" />
        <div className="space-y-4 p-4 text-sm leading-relaxed text-stone-600">
          <p>
            With the Chrome extension, open someone’s LinkedIn profile, click the extension’s icon, and their name, title, company, location, profile link and photo are filled in for you.
            Choose the job and stage and they are in that pipeline, or choose “No job yet” to save them to The Book and decide on a job later. Either way you are their owner. It warns you if the person is already in your workspace.
          </p>
          <a href="/the-book-extension.zip" download><Button variant="primary" icon={Download}>Download the extension</Button></a>
          <ol className="list-decimal space-y-2 pl-5">{steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
          {/* Loaded from a folder, the extension never updates itself: after a change such as "No job yet" it has to be replaced by hand. */}
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-950">
            <p className="font-medium">Already installed? It does not update by itself.</p>
            <p className="mt-0.5">
              If the Job list in your extension has no “No job yet: just add to The Book” choice, you have an older copy. Download it again, unzip it over the old folder (or delete the old folder first),
              then open <code className="rounded bg-white/70 px-1 py-0.5 text-xs">chrome://extensions</code> and press the reload arrow on “The Book”. Your workspace address is kept. From now on the extension tells you itself when a newer copy is ready.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-stone-100 px-3 py-2.5 text-xs text-stone-800">{address}</code>
            <Button icon={Copy} onClick={copy}>Copy address</Button>
          </div>
          <p className="text-[13px] text-stone-500">
            The extension only reads the page you are on when you click its icon, and only talks to this workspace. It works on other pages too (GitHub profiles, company team pages), and every field can be corrected before saving.
            Each person on your team installs it in their own browser. Keyboard shortcut: Alt+Shift+A.
          </p>
        </div>
      </Card>
    </div>
  );
}

const MERGE_FIELDS = ['candidate_first_name', 'candidate_name', 'job_title', 'company', 'sender_name'];

function Templates() {
  const { bump } = useApp();
  const toast = useToast();
  const { data: templates, error } = useApi('/templates');
  const [editing, setEditing] = useState(null);
  const [save, busy] = useAction(async () => {
    if (editing.id) await api.put(`/templates/${editing.id}`, editing);
    else await api.post('/templates', editing);
    toast('Template saved');
    setEditing(null);
    bump();
  });
  const [remove] = useAction(async () => { await api.del(`/templates/${editing.id}`); setEditing(null); bump(); });
  if (!templates) return <Pending error={error} />;
  return (
    <div className="max-w-3xl">
      <Card>
        <CardHeader title="Email templates" action={<Button size="sm" icon={Plus} onClick={() => setEditing({ name: '', subject: '', body: '' })}>New template</Button>} />
        <ul className="divide-y divide-line">
          {templates.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => setEditing(t)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-stone-50">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-stone-900">{t.name}</span>
                  <span className="block truncate text-[13px] text-stone-500">{t.subject}</span>
                </span>
                {t.key && <Badge tone="blue">Sent automatically</Badge>}
              </button>
            </li>
          ))}
        </ul>
      </Card>
      {editing && (
        <Modal title={editing.id ? 'Edit template' : 'New template'} onClose={() => setEditing(null)} onSubmit={save}
          footer={<>
            {editing.id && !editing.key && <Button variant="danger" icon={Trash2} onClick={remove} className="mr-auto">Delete</Button>}
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="submit" variant="primary" busy={busy}>Save template</Button>
          </>}>
          <Field label="Name"><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required /></Field>
          <Field label="Subject"><Input value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} required /></Field>
          <Field label="Message"><Textarea rows={10} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} required /></Field>
          <p className="text-xs leading-relaxed text-stone-500">
            Filled in for you when sending: {MERGE_FIELDS.map((f) => <code key={f} className="mr-1.5 rounded bg-stone-100 px-1 py-0.5">{`{{${f}}}`}</code>)}
            {editing.key === 'interview_invite' && <>and <code className="rounded bg-stone-100 px-1 py-0.5">{'{{interview_time}}'}</code> <code className="rounded bg-stone-100 px-1 py-0.5">{'{{interview_format}}'}</code> <code className="rounded bg-stone-100 px-1 py-0.5">{'{{interview_location}}'}</code></>}
          </p>
        </Modal>
      )}
    </div>
  );
}

export default function Settings() {
  const { isAgency } = useApp();
  const [params, setParams] = useSearchParams();
  // Client users only have the account tab; an unknown or agency-only tab in the address falls back to it.
  const tab = isAgency && ['agency', 'team', 'templates', 'extension'].includes(params.get('tab')) ? params.get('tab') : 'account';
  const setTab = (t) => setParams({ tab: t }, { replace: true });
  return (
    <Page title="Settings">
      {isAgency && (
        <Tabs className="mb-6" value={tab} onChange={setTab}
          tabs={[{ id: 'account', label: 'Your account' }, { id: 'agency', label: 'Agency' }, { id: 'team', label: 'Team' }, { id: 'templates', label: 'Email templates' }, { id: 'extension', label: 'Browser extension' }]} />
      )}
      {tab === 'account' && <Account />}
      {tab === 'agency' && isAgency && <Agency />}
      {tab === 'team' && isAgency && <Team />}
      {tab === 'templates' && isAgency && <Templates />}
      {tab === 'extension' && isAgency && <Extension />}
    </Page>
  );
}
