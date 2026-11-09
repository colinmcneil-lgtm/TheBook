import React, { useState } from 'react';
import { Plus, UserPlus, Trash2 } from 'lucide-react';
import { useApp, useApi } from '../state.jsx';
import { api } from '../lib.js';
import { Avatar, Badge, Button, Card, CardHeader, Field, Input, Loading, Modal, Page, Tabs, Textarea, useAction, useToast } from '../ui.jsx';
import { UserForm } from '../components/Forms.jsx';

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
  const { data: people } = useApi('/users');
  const [adding, setAdding] = useState(false);
  const [setActive] = useAction(async (u, active) => { await api.patch(`/users/${u.id}`, { active }); toast(active ? 'Reactivated' : 'Deactivated'); bump(); });
  if (!people) return <Loading />;
  const groups = [['Agency team', people.filter((p) => p.role !== 'client')], ['Client hiring teams', people.filter((p) => p.role === 'client')]];
  return (
    <div className="max-w-3xl space-y-6">
      {groups.map(([title, list], gi) => (
        <Card key={title}>
          <CardHeader title={title} count={list.length} action={gi === 0 && isAdmin ? <Button size="sm" icon={UserPlus} onClick={() => setAdding(true)}>Add teammate</Button> : gi === 1 ? <span className="text-xs text-stone-500">Invite from each client’s page</span> : null} />
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
      {adding && <UserForm onClose={() => setAdding(false)} />}
    </div>
  );
}

const MERGE_FIELDS = ['candidate_first_name', 'candidate_name', 'job_title', 'company', 'sender_name'];

function Templates() {
  const { bump } = useApp();
  const toast = useToast();
  const { data: templates } = useApi('/templates');
  const [editing, setEditing] = useState(null);
  const [save, busy] = useAction(async () => {
    if (editing.id) await api.put(`/templates/${editing.id}`, editing);
    else await api.post('/templates', editing);
    toast('Template saved');
    setEditing(null);
    bump();
  });
  const [remove] = useAction(async () => { await api.del(`/templates/${editing.id}`); setEditing(null); bump(); });
  if (!templates) return <Loading />;
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
  const [tab, setTab] = useState('account');
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
