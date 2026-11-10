import React, { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Check, ChevronDown, Copy, Download, Plus, UserPlus, Trash2 } from 'lucide-react';
import { useApp, useApi, Pending } from '../state.jsx';
import { api, ago, fmtDate } from '../lib.js';
import { Checkbox, Avatar, Badge, Button, Card, CardHeader, Field, Input, Modal, Page, Tabs, Textarea, useAction, useToast } from '../ui.jsx';
import { ApproveForm, InviteForm } from '../components/Forms.jsx';
import { Notice } from '../oracle/bits.jsx';
import { PHONE_SETTINGS, settingNames, usePhone } from '../oracle/phone.jsx';
import { showNumber } from '../oracle/calls.js';

/** A link such as /settings?tab=account#phone lands on that card, not at the top of the page. */
function useScrollToHash(ready) {
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash || !ready) return;
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash, ready]);
}

function Account() {
  const { user, isAgency } = useApp();
  const toast = useToast();
  const [form, setForm] = useState({ current: '', next: '' });
  const [save, busy] = useAction(async () => { await api.post('/me/password', form); setForm({ current: '', next: '' }); toast('Password changed'); });
  return (
    <div className="max-w-lg space-y-6">
    <Card>
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
    {/* Calls and calendars belong to the agency's own people: a client's hiring team has neither. */}
    {isAgency && <MobileCard />}
    {isAgency && <CalendarLinkCard />}
    </div>
  );
}

/** The signed-in person's own mobile, and the PIN that goes with ringing The Book from it. */
function MobileCard() {
  const { status, statusError, reloadStatus } = usePhone();
  const toast = useToast();
  const [number, setNumber] = useState(null); // null until typed in: the box then shows what is saved
  const [pin, setPin] = useState('');
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  useScrollToHash(Boolean(status));
  const saved = status?.my_phone ? showNumber(status.my_phone) : '';
  const shown = number ?? saved;
  const send = async (body, done) => {
    setProblem(null);
    setBusy(true);
    try {
      await api.put('/me/phone', body);
      await reloadStatus();
      setNumber(null);
      setPin('');
      toast(done);
    } catch (err) { setProblem(err.status ? err.message : 'The Book could not be reached. Check your connection and try again.'); }
    setBusy(false);
  };
  // The PIN is only sent when one was typed, so saving a new number leaves the PIN as it is.
  const save = () => send({ phone: shown.trim(), ...(pin ? { pin } : {}) }, shown.trim() ? 'Mobile number saved' : 'Mobile number removed');
  return (
    <Card id="phone" className="scroll-mt-4">
      <CardHeader title="Your mobile number" action={status && <Badge tone={status.my_phone ? 'green' : 'amber'}>{status.my_phone ? 'Saved' : 'Not saved'}</Badge>} />
      <form className="space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {!status && statusError && <Notice tone="bad">Your phone settings could not be loaded. {statusError}</Notice>}
        {status && !status.configured && <Notice>Phone calls are not connected to this workspace yet. You can save your number now and it is used as soon as they are.</Notice>}
        <Field label="Mobile number" hint="The phone The Book rings when you press Call, before it connects you to the candidate. It is also the only phone that can place calls by ringing The Book’s number.">
          <Input type="tel" inputMode="tel" autoComplete="tel" value={shown} onChange={(e) => setNumber(e.target.value)} placeholder="(416) 555 0123" className="max-sm:!h-11 max-sm:!text-base" />
        </Field>
        <Field label={status?.my_pin_set ? 'New PIN' : 'PIN'} hint={`4 to 6 digits. You key it in when you ring The Book’s number from your mobile to place a call without the app, so nobody else can place calls with your phone.${status?.my_pin_set ? ' Leave this empty to keep the PIN you have.' : ''}`}>
          <Input type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{4,6}" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder={status?.my_pin_set ? 'A PIN is set' : 'Choose a PIN'} className="max-w-40 max-sm:!h-11 max-sm:!text-base" />
        </Field>
        {problem && <Notice tone="bad">{problem}</Notice>}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" busy={busy} disabled={!status || (shown.trim() === saved && !pin)}>Save</Button>
          {status?.my_pin_set && <Button disabled={busy} onClick={() => send({ phone: status.my_phone || '', pin: '' }, 'PIN removed')}>Remove PIN</Button>}
          {status?.my_phone && <Button variant="danger" disabled={busy} onClick={() => send({ phone: '' }, 'Mobile number removed')}>Remove number</Button>}
        </div>
        {status?.configured && status.number_display && (
          <p className="text-[13px] leading-relaxed text-stone-500">The Book’s own number is <span className="tabular font-medium text-stone-700">{status.number_display}</span>. Candidates see it when you call them, and it is the number you ring to place a call from your phone. <Link to="/oracle" className="font-medium text-brand-700 hover:underline">How that works</Link></p>
        )}
      </form>
    </Card>
  );
}

const PROVIDERS = { google: 'Google Calendar', outlook: 'Outlook', icloud: 'Apple Calendar', other: 'Calendar link' };
const strong = (text) => <b className="font-medium text-stone-900">{text}</b>;
// Where each calendar keeps its private link. Checked against each provider's help pages, not against a live account.
const HOW_TO = [
  {
    name: 'Google Calendar',
    steps: [
      <>On a computer, open Google Calendar, click the gear and choose {strong('Settings')}.</>,
      <>On the left, under {strong('Settings for my calendars')}, click your calendar’s name.</>,
      <>Scroll to {strong('Integrate calendar')} and copy the link under {strong('Secret address in iCal format')}.</>,
    ],
    note: 'On a work account, if there is no secret address, your Google Workspace admin has switched it off and is the person to ask.',
  },
  {
    name: 'Outlook',
    steps: [
      <>In Outlook on the web, click the gear, then {strong('Calendar')}, then {strong('Shared calendars')}.</>,
      <>Under {strong('Publish a calendar')}, choose your calendar and {strong('Can view all details')}, then click {strong('Publish')}.</>,
      <>Click the {strong('ICS')} link that appears and choose {strong('Copy link')}.</>,
    ],
    note: 'If “Publish a calendar” is missing, your IT admin has switched publishing off. Outlook’s link usually leaves out who was invited, so you may have to choose the candidate for an event yourself.',
  },
  {
    name: 'Apple Calendar',
    steps: [
      <>Open {strong('icloud.com/calendar')} and sign in (or on an iPhone: Calendar, then Calendars).</>,
      <>Open the sharing options beside your calendar (the {strong('i')} on an iPhone) and switch on {strong('Public Calendar')}.</>,
      <>Copy the link. It starts with webcal://, which is fine.</>,
    ],
    note: 'Anyone who has an Apple public link can read that calendar, so paste it here and nowhere else.',
  },
];

/** The signed-in person's calendar link: paste it, see whether it is being read, remove it. The link is never shown again. */
function CalendarLinkCard() {
  const { version, bump } = useApp();
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [link, setLink] = useState('');
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/calendar/status').then(setStatus).catch((err) => setProblem(err.status ? err.message : 'The Book could not be reached. Check your connection and try again.')); }, [version]);
  useScrollToHash(Boolean(status));
  const connect = async () => {
    setProblem(null);
    setBusy(true);
    try {
      const made = await api.put('/calendar/link', { url: link.trim() });
      setLink('');
      toast(`Calendar connected. ${made.events_today === 1 ? '1 event' : `${made.events_today} events`} today.`);
      bump();
    } catch (err) { setProblem(err.status ? err.message : 'The Book could not be reached. Check your connection and try again.'); }
    setBusy(false);
  };
  const [remove, removing] = useAction(async () => {
    if (!window.confirm('Remove your calendar link? Your day in The Oracle then shows only the interviews scheduled in The Book. Calls already recorded are kept.')) return;
    await api.del('/calendar/link');
    toast('Calendar link removed');
    bump();
  });
  return (
    <Card id="calendar" className="scroll-mt-4">
      <CardHeader title="Your calendar" action={status && <Badge tone={!status.connected ? 'amber' : status.error ? 'red' : 'green'}>{!status.connected ? 'Not connected' : status.error ? 'Not being read' : 'Connected'}</Badge>} />
      <div className="space-y-4 p-4">
        <p className="text-sm leading-relaxed text-stone-600">
          Paste your calendar’s private link and your day shows in The Oracle, with a reminder when a call you added is about to start. The link lets The Book read your calendar and nothing else. It is kept on the server and never shown again, to you or anyone.
        </p>
        {status?.connected && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-stone-50 px-3 py-2.5 text-sm">
            <span className="min-w-0 flex-1 basis-48">
              <span className="block font-medium text-stone-900">{PROVIDERS[status.provider] || PROVIDERS.other}</span>
              <span className="block text-[13px] text-stone-500">{status.last_read_at ? `Last read ${ago(status.last_read_at)}` : 'Not read yet'}</span>
            </span>
            <Button size="sm" variant="danger" icon={Trash2} busy={removing} onClick={remove}>Remove</Button>
          </div>
        )}
        {status?.connected && status.error && <Notice tone="warn"><span className="font-medium">The last read did not work.</span> {status.error}</Notice>}
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); connect(); }}>
          <Field label={status?.connected ? 'Replace it with another link' : 'Calendar link'} hint="It is read once before it is accepted, so you know straight away that it works.">
            <Input type="url" inputMode="url" autoComplete="off" spellCheck={false} value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" className="max-sm:!h-11 max-sm:!text-base" />
          </Field>
          {problem && <Notice tone="bad">{problem}</Notice>}
          <Button type="submit" variant="primary" busy={busy} disabled={!link.trim()}>{busy ? 'Reading the calendar…' : status?.connected ? 'Replace link' : 'Connect calendar'}</Button>
        </form>
        <div className="space-y-2 border-t border-line pt-4">
          <p className="text-[13px] font-medium text-stone-700">Where to find the link</p>
          {HOW_TO.map((how) => (
            <details key={how.name} className="group rounded-lg border border-line">
              <summary className="flex min-h-10 list-none items-center gap-2 px-3 text-sm font-medium text-stone-800 hover:bg-stone-50 [&::-webkit-details-marker]:hidden">
                {how.name}<ChevronDown className="ml-auto size-4 text-stone-400 transition-transform group-open:rotate-180" />
              </summary>
              <div className="space-y-2 border-t border-line px-3 py-3 text-[13px] leading-relaxed text-stone-600">
                <ol className="list-decimal space-y-1.5 pl-5">{how.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
                <p className="text-stone-500">{how.note}</p>
              </div>
            </details>
          ))}
        </div>
      </div>
    </Card>
  );
}

function AiCard() {
  const { isAdmin } = useApp();
  const { data: status } = useApi('/jobs/autofill/status');
  const { data: oracle } = useApi('/oracle/status');
  const { status: phone } = usePhone();
  useScrollToHash(Boolean(status && phone));
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
              The Oracle
              <Badge tone={oracle.transcription ? 'green' : 'amber'}>{oracle.transcription ? 'Transcripts connected' : 'Transcripts not connected'}</Badge>
              <Badge tone={oracle.ai ? 'green' : 'amber'}>{oracle.ai ? 'Notes and drafts connected' : 'Notes and drafts not connected'}</Badge>
            </p>
            <p>
              The Oracle uses two connections. Recorded calls are sent to Deepgram to be transcribed{oracle.transcription ? '' : <> (create an API key at deepgram.com and set {code('DEEPGRAM_API_KEY')})</>},
              and each transcript is sent to Claude to write the notes summary and draft submissions{oracle.ai ? '' : <> (the {code('ANTHROPIC_API_KEY')} above)</>}.
              {' '}Without them, calls are still recorded and saved, and a transcript can be pasted in. Both are billed to your own accounts per use.
            </p>
          </div>
        )}
        {phone && (
          <div id="phone-connection" className="mt-3 scroll-mt-4 space-y-2 border-t border-line pt-3">
            <p className="flex flex-wrap items-center gap-2 font-medium text-stone-900">
              Phone calls
              <Badge tone={phone.configured ? 'green' : 'amber'}>{phone.configured ? 'Connected' : 'Not connected'}</Badge>
              {phone.configured && <span className="tabular text-[13px] font-normal text-stone-500">{phone.number_display}</span>}
            </p>
            <p>
              Recruiters call candidates through one phone number that belongs to The Book, from the app or by ringing that number from their own mobile. The calls go through Twilio, which rings both phones, records the call and passes the recording to The Oracle. Twilio bills your own account for the number and for each minute.
            </p>
            {phone.configured ? (
              <p>
                {phone.notice ? 'The other person hears a short notice that the call is recorded before a recorded call is connected.' : 'The spoken notice that a call is recorded is switched off, so recruiters have to say it themselves.'}
                {' '}Calls can be placed to: {phone.countries?.length ? phone.countries.join(', ') : 'CA, US'}.
              </p>
            ) : isAdmin ? (
              <>
                <p>To connect them, create a Twilio account, buy a number there, and set these three where the app is hosted, then restart it:</p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>{code(PHONE_SETTINGS[0])}: the account’s ID, which starts with AC.</li>
                  <li>{code(PHONE_SETTINGS[1])}: the account’s secret token, shown next to it in the Twilio console.</li>
                  <li>{code(PHONE_SETTINGS[2])}: the number you bought, written like +14165550123.</li>
                </ul>
                <p>The Book also has to know its own public address ({code('APP_URL')}), because Twilio reports on each call to that address. The README has the steps.</p>
              </>
            ) : (
              <p>An admin can connect them: it needs a Twilio account and three settings ({settingNames(PHONE_SETTINGS)}) where the app is hosted.</p>
            )}
          </div>
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
      <AiCard />
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
            Choose the job and stage, and they are in that pipeline with you as the owner. It warns you if the person is already in your workspace.
          </p>
          <a href="/the-book-extension.zip" download><Button variant="primary" icon={Download}>Download the extension</Button></a>
          <ol className="list-decimal space-y-2 pl-5">{steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
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
