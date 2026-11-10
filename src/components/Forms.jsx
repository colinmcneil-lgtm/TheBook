import React, { useState } from 'react';
import { Copy } from 'lucide-react';
import { api, firstName, fmtDate, ENGAGEMENTS, todayLocal } from '../lib.js';
import { useApp } from '../state.jsx';
import { Button, Field, Input, Modal, Select, Textarea, useAction, useToast } from '../ui.jsx';

const CURRENCIES = ['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'SGD', 'AED', 'CHF'];

export function ClientForm({ client, onClose, onSaved }) {
  const { bump, reloadMe } = useApp();
  const toast = useToast();
  const [form, setForm] = useState(() => ({
    name: '', industry: '', location: '', website: '', privacy_url: '', tagline: '', about: '', brand_color: '#1f5443', status: 'active',
    engagement_model: 'retainer', monthly_retainer: '', fee_percent: '', currency: 'USD', started_at: todayLocal(),
    ...Object.fromEntries(Object.entries(client || {}).map(([k, v]) => [k, v ?? ''])),
  }));
  const bind = (key) => ({ value: form[key] ?? '', onChange: (e) => setForm((f) => ({ ...f, [key]: e.target.value })) });
  const [save, busy] = useAction(async () => {
    const saved = client ? await api.put(`/clients/${client.id}`, form) : await api.post('/clients', form);
    const id = client ? client.id : saved.id;
    toast(client ? 'Client saved' : `${form.name} added`);
    if (saved.board_notice) toast(saved.board_notice, 'error'); // a new name or address is now in one of this client's confidential posts
    await reloadMe();
    bump();
    onClose();
    onSaved?.(id);
  });
  const model = form.engagement_model;
  return (
    <Modal title={client ? `Edit ${client.name}` : 'New client'} subtitle={client ? undefined : 'Each client gets its own careers page, jobs, pipeline and hiring-team logins.'} size="lg" onClose={onClose} onSubmit={save}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>{client ? 'Save changes' : 'Add client'}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-6">
        <Field label="Company name" className="sm:col-span-4"><Input {...bind('name')} required autoFocus={!client} /></Field>
        <Field label="Brand colour" className="sm:col-span-2">
          <span className="flex items-center gap-2">
            <input type="color" {...bind('brand_color')} aria-label="Brand colour" className="h-9 w-12 cursor-pointer rounded-lg border border-line bg-white p-1" />
            <Input {...bind('brand_color')} pattern="#[0-9a-fA-F]{6}" />
          </span>
        </Field>
        <Field label="Industry" className="sm:col-span-2"><Input {...bind('industry')} /></Field>
        <Field label="Head office" className="sm:col-span-2"><Input {...bind('location')} /></Field>
        <Field label="Website" className="sm:col-span-2"><Input {...bind('website')} placeholder="https://" /></Field>
      </div>

      <h3 className="border-t border-line pt-4 text-sm font-semibold text-stone-900">Careers page</h3>
      {client && (
        <Field label="Page address" hint="Changing this breaks links you have already shared.">
          <span className="flex items-center gap-1 text-sm text-stone-500">{window.location.origin}/careers/<Input {...bind('slug')} className="max-w-56" /></span>
        </Field>
      )}
      <Field label="Headline"><Input {...bind('tagline')} placeholder="One line on what the company does and why it matters" /></Field>
      <Field label="About the company"><Textarea rows={4} {...bind('about')} placeholder="A few short paragraphs candidates will read before applying." /></Field>
      <Field label="Privacy notice link" hint="Linked next to the consent box on every application form. Use the client's own candidate privacy notice.">
        <Input {...bind('privacy_url')} placeholder="https://" />
      </Field>

      <h3 className="border-t border-line pt-4 text-sm font-semibold text-stone-900">Your engagement <span className="font-normal text-stone-500">· never shown to the client</span></h3>
      <div className="grid gap-4 sm:grid-cols-6">
        <Field label="Model" className="sm:col-span-3">
          <Select {...bind('engagement_model')}>{Object.entries(ENGAGEMENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        </Field>
        <Field label="Currency" className="sm:col-span-1">
          <Select {...bind('currency')}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
        </Field>
        <Field label="Status" className="sm:col-span-2">
          <Select {...bind('status')}><option value="active">Active</option><option value="paused">Paused</option><option value="ended">Ended</option></Select>
        </Field>
        {model !== 'per_hire' && <Field label="Monthly retainer" className="sm:col-span-2"><Input type="number" min="0" step="100" {...bind('monthly_retainer')} /></Field>}
        {model !== 'retainer' && <Field label="Fee per hire (% of base salary)" className="sm:col-span-2"><Input type="number" min="0" max="100" step="0.5" {...bind('fee_percent')} /></Field>}
        <Field label="Start date" className="sm:col-span-2"><Input type="date" {...bind('started_at')} /></Field>
      </div>
    </Modal>
  );
}

const copyText = async (text) => { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } };
const joinLink = (token) => `${window.location.origin}/join/${token}`;

/** A one-time link to pass on, with a button to copy it. */
function LinkToSend({ link }) {
  const toast = useToast();
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-lg bg-stone-100 px-3 py-2.5 text-xs text-stone-800">{link}</code>
      <Button icon={Copy} onClick={async () => toast((await copyText(link)) ? 'Copied' : 'Select the link and copy it', 'ok')}>Copy</Button>
    </div>
  );
}

/**
 * Create a one-time invitation link. With `client`, the person joins that company's hiring team;
 * without it, they join your agency team (admins only).
 */
export function InviteForm({ client, onClose }) {
  const { bump, isAdmin, agencyName } = useApp();
  const toast = useToast();
  const [form, setForm] = useState({ email: '', role: client ? 'client' : 'recruiter' });
  const [link, setLink] = useState(null);
  const [create, busy] = useAction(async () => {
    const { token } = await api.post('/invites', { ...form, client_id: client?.id });
    const url = joinLink(token);
    setLink(url);
    bump();
    if (await copyText(url)) toast('Invitation link copied');
  });
  const audience = client ? `${client.name}'s hiring team` : `the ${agencyName} team`;

  if (link) {
    return (
      <Modal title="Invitation link ready" subtitle={`Send this to the person joining ${audience}.`} onClose={onClose}
        footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <LinkToSend link={link} />
        <ul className="list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-stone-600">
          <li>They open it, choose their own password, and are signed in straight away.</li>
          <li>It works once and expires in 7 days. You can revoke it under Settings, Team.</li>
          <li>This is the only time the link is shown, so copy it now.</li>
        </ul>
      </Modal>
    );
  }
  return (
    <Modal title={client ? `Invite someone from ${client.name}` : 'Invite a teammate'}
      subtitle={client ? 'Hiring managers and interviewers see only this company’s roles and candidates.' : 'Teammates see every client.'} onClose={onClose} onSubmit={create}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Create invitation link</Button></>}>
      <Field label="Their email (optional)" hint="If you add it, the link only works for an account with this address.">
        <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoFocus />
      </Field>
      {!client && (
        <Field label="Access">
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} disabled={!isAdmin}>
            <option value="recruiter">Recruiter (all clients)</option>
            <option value="admin">Admin (plus team and agency settings)</option>
          </Select>
        </Field>
      )}
    </Modal>
  );
}

/**
 * Approve a self-registered account: decide which client's hiring team (or, for admins, which agency role) it gets.
 * Approving turns the request into a one-time link for that email address, where the person sets their password.
 */
export function ApproveForm({ person, onClose }) {
  const { bump, isAdmin, clients } = useApp();
  const toast = useToast();
  const guess = clients.find((c) => person.requested_company && c.name.toLowerCase() === person.requested_company.toLowerCase());
  const [form, setForm] = useState({ role: 'client', client_id: guess?.id ?? '' });
  const [approved, setApproved] = useState(null); // { link, notified, expires_at }
  const [approve, busy] = useAction(async () => {
    const { notified, token, expires_at } = await api.post(`/users/${person.id}/approve`, form);
    const link = joinLink(token);
    setApproved({ link, notified, expires_at });
    bump();
    if (!notified && (await copyText(link))) toast('Link copied');
  });

  if (approved) {
    return (
      <Modal title={`${person.name} is approved`} subtitle={approved.notified ? `This link has been emailed to ${person.email}.` : `No email was sent, so send ${firstName(person.name)} this link yourself.`} onClose={onClose}
        footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <LinkToSend link={approved.link} />
        <ul className="list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-stone-600">
          <li>They open it, choose their own password, and are signed in straight away.</li>
          <li>It only works for {person.email}, works once, and expires {approved.expires_at ? `on ${fmtDate(approved.expires_at)}` : 'in 7 days'}. You can revoke it under Open invitations on this page.</li>
          <li>This is the only time the link is shown, so copy it now{approved.notified ? ' if you want to send it yourself as well' : ''}.</li>
        </ul>
      </Modal>
    );
  }
  return (
    <Modal title={`Approve ${person.name}`} subtitle={[person.email, person.requested_company && `says they are from ${person.requested_company}`].filter(Boolean).join(' · ')} size="sm" onClose={onClose} onSubmit={approve}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Approve account</Button></>}>
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
        Anyone can request an account, and the email address has not been verified. Only approve people you recognise.
        They set their password through a one-time link that works for this address only.
      </p>
      <Field label="Give access as">
        <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="client">Client hiring team (one company only)</option>
          {isAdmin && <option value="recruiter">Recruiter on my team (all clients)</option>}
          {isAdmin && <option value="admin">Admin on my team</option>}
        </Select>
      </Field>
      {form.role === 'client' && (
        <Field label="Company" hint="They will see this client's roles and candidates, and nothing else.">
          <Select value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })} required>
            <option value="">Choose a client…</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
      )}
    </Modal>
  );
}
