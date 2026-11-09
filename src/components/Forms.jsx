import React, { useState } from 'react';
import { api, ENGAGEMENTS } from '../lib.js';
import { useApp } from '../state.jsx';
import { Button, Field, Input, Modal, Select, Textarea, useAction, useToast } from '../ui.jsx';

const CURRENCIES = ['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'SGD', 'AED', 'CHF'];

export function ClientForm({ client, onClose, onSaved }) {
  const { bump, reloadMe } = useApp();
  const toast = useToast();
  const [form, setForm] = useState(() => ({
    name: '', industry: '', location: '', website: '', tagline: '', about: '', brand_color: '#1f5443', status: 'active',
    engagement_model: 'retainer', monthly_retainer: '', fee_percent: '', currency: 'USD', started_at: new Date().toISOString().slice(0, 10),
    ...Object.fromEntries(Object.entries(client || {}).map(([k, v]) => [k, v ?? ''])),
  }));
  const bind = (key) => ({ value: form[key] ?? '', onChange: (e) => setForm((f) => ({ ...f, [key]: e.target.value })) });
  const [save, busy] = useAction(async () => {
    const id = client ? (await api.put(`/clients/${client.id}`, form), client.id) : (await api.post('/clients', form)).id;
    toast(client ? 'Client saved' : `${form.name} added`);
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

const randomPassword = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

/** Create a login for an agency teammate (no `client`) or someone on a client's hiring team. */
export function UserForm({ client, onClose }) {
  const { bump, isAdmin } = useApp();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', email: '', title: '', role: client ? 'client' : 'recruiter', password: randomPassword() });
  const bind = (key) => ({ value: form[key], onChange: (e) => setForm((f) => ({ ...f, [key]: e.target.value })) });
  const [save, busy] = useAction(async () => {
    await api.post('/users', { ...form, client_id: client?.id });
    try { await navigator.clipboard.writeText(`Sign in at ${window.location.origin}\nEmail: ${form.email}\nTemporary password: ${form.password}`); toast('Account created. Sign-in details copied to your clipboard.'); }
    catch { toast('Account created. Share the sign-in details with them.'); }
    bump();
    onClose();
  });
  return (
    <Modal title={client ? `Invite someone from ${client.name}` : 'Add a teammate'} subtitle={client ? 'Hiring managers and interviewers see only this company’s roles and candidates.' : undefined} onClose={onClose} onSubmit={save}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Create account</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name"><Input {...bind('name')} required autoFocus /></Field>
        <Field label="Job title"><Input {...bind('title')} /></Field>
        <Field label="Email"><Input type="email" {...bind('email')} required /></Field>
        {!client && (
          <Field label="Access">
            <Select {...bind('role')} disabled={!isAdmin}>
              <option value="recruiter">Recruiter (all clients)</option>
              <option value="admin">Admin (plus team and billing settings)</option>
            </Select>
          </Field>
        )}
        <Field label="Temporary password" hint="Send this to them yourself. They can change it in Settings after signing in." className={client ? '' : 'sm:col-span-2'}>
          <Input {...bind('password')} required minLength={8} className="font-mono" />
        </Field>
      </div>
    </Modal>
  );
}
