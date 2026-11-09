import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, Plus, UserPlus, Trash2 } from 'lucide-react';
import { useApp, useApi, Pending } from '../state.jsx';
import { api, ago, fmtDate } from '../lib.js';
import { Avatar, Badge, Button, Card, CardHeader, Field, Input, Modal, Page, Tabs, Textarea, useAction, useToast } from '../ui.jsx';
import { ApproveForm, InviteForm } from '../components/Forms.jsx';

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

function Agency() {
  const { agencyName, isAdmin, reloadMe, mailConfigured } = useApp();
  const toast = useToast();
  const [name, setName] = useState(agencyName);
  const [save, busy] = useAction(async () => { await api.put('/settings', { agencyName: name }); await reloadMe(); toast('Saved'); });
  return (
    <div className="max-w-lg space-y-6">
      <Card>
        <CardHeader title="Agency" />
        <form className="space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <Field label="Agency name" hint="Shown in the workspace and on reports you prepare for clients."><Input value={name} onChange={(e) => setName(e.target.value)} required disabled={!isAdmin} /></Field>
          {isAdmin && <Button type="submit" variant="primary" busy={busy}>Save</Button>}
        </form>
      </Card>
      <Card>
        <CardHeader title="Email delivery" action={<Badge tone={mailConfigured ? 'green' : 'amber'}>{mailConfigured ? 'Connected' : 'Not connected'}</Badge>} />
        <div className="space-y-2 p-4 text-sm leading-relaxed text-stone-600">
          {mailConfigured ? <p>Emails to candidates are sent through your mail server and recorded on each candidate.</p> : (
            <>
              <p>Emails to candidates (application confirmations, interview invitations, rejections) are being saved on each candidate’s record but <b className="font-medium text-stone-900">not sent</b>.</p>
              <p>To send them, set <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">SMTP_URL</code> and <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">MAIL_FROM</code> where the app is hosted, using the details from your email provider, then restart it.</p>
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
  const tab = isAgency && ['agency', 'team', 'templates'].includes(params.get('tab')) ? params.get('tab') : 'account';
  const setTab = (t) => setParams({ tab: t }, { replace: true });
  return (
    <Page title="Settings">
      {isAgency && (
        <Tabs className="mb-6" value={tab} onChange={setTab}
          tabs={[{ id: 'account', label: 'Your account' }, { id: 'agency', label: 'Agency' }, { id: 'team', label: 'Team' }, { id: 'templates', label: 'Email templates' }]} />
      )}
      {tab === 'account' && <Account />}
      {tab === 'agency' && isAgency && <Agency />}
      {tab === 'team' && isAgency && <Team />}
      {tab === 'templates' && isAgency && <Templates />}
    </Page>
  );
}
