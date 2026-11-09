import React, { useEffect, useState } from 'react';
import { api } from '../lib.js';
import { Button, Field, Input, Loading, useAction } from '../ui.jsx';

export function Logo({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#132a22" />
      <path d="M10 9h12v3.2h-8.4v2.3H21v3h-7.4v2.3H22V23H10z" fill="#e8c468" />
    </svg>
  );
}

export default function Login({ onDone }) {
  const [boot, setBoot] = useState(null);
  const [form, setForm] = useState({ agencyName: '', name: '', email: '', password: '' });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  useEffect(() => { api.get('/bootstrap').then(setBoot).catch(() => setBoot({ needsSetup: false })); }, []);

  const [submit, busy] = useAction(async () => {
    await api.post(boot.needsSetup ? '/setup' : '/login', form);
    await onDone();
  });
  if (!boot) return <Loading className="h-full" />;
  const setup = boot.needsSetup;

  return (
    <div className="grid min-h-full lg:grid-cols-[1fr_1.1fr]">
      <div className="flex flex-col justify-center px-6 py-12 sm:px-16">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-10 flex items-center gap-2.5">
            <Logo />
            <span className="text-lg font-semibold tracking-tight">{boot.agencyName || 'Embed'}</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{setup ? 'Set up your workspace' : 'Sign in'}</h1>
          <p className="mt-1.5 text-sm text-stone-500">
            {setup ? 'Create the owner account for your agency. You can invite your team and your clients afterwards.' : 'Welcome back. Enter your details to open your hiring workspace.'}
          </p>
          <form className="mt-8 space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            {setup && (
              <>
                <Field label="Agency name"><Input value={form.agencyName} onChange={set('agencyName')} required placeholder="e.g. Harbour Talent Partners" /></Field>
                <Field label="Your name"><Input value={form.name} onChange={set('name')} required autoComplete="name" /></Field>
              </>
            )}
            <Field label="Email"><Input type="email" value={form.email} onChange={set('email')} required autoComplete="email" autoFocus={!setup} /></Field>
            <Field label="Password" hint={setup ? 'At least 8 characters.' : undefined}>
              <Input type="password" value={form.password} onChange={set('password')} required minLength={setup ? 8 : undefined} autoComplete={setup ? 'new-password' : 'current-password'} />
            </Field>
            <Button type="submit" variant="primary" busy={busy} className="w-full">{setup ? 'Create workspace' : 'Sign in'}</Button>
          </form>
        </div>
      </div>
      <div className="hidden bg-brand-950 px-16 py-12 text-brand-100 lg:flex lg:flex-col lg:justify-center">
        <p className="max-w-md text-3xl leading-snug font-semibold tracking-tight text-white">
          One hiring workspace for every company you are embedded in.
        </p>
        <ul className="mt-8 max-w-md space-y-4 text-[15px] leading-relaxed text-brand-200">
          <li><span className="font-medium text-gold">Inbound.</span> A branded careers page and application form for each client, feeding one review queue.</li>
          <li><span className="font-medium text-gold">Pipeline.</span> Every candidate, stage and decision in one place, with your shortlist write-ups going straight to the hiring team.</li>
          <li><span className="font-medium text-gold">Interviews.</span> Scheduling, panels and structured scorecards, so feedback arrives the same day.</li>
          <li><span className="font-medium text-gold">Reporting.</span> Funnel, sources and time to hire, ready to walk a leadership team through.</li>
        </ul>
      </div>
    </div>
  );
}
