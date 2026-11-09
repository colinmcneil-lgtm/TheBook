import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CircleCheck } from 'lucide-react';
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

/** Two-column frame shared by sign-in, account creation and invitations. */
function AuthFrame({ agencyName, children }) {
  return (
    <div className="grid min-h-full lg:grid-cols-[1fr_1.1fr]">
      <div className="flex flex-col justify-center px-6 py-12 sm:px-16">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-10 flex items-center gap-2.5">
            <Logo />
            <span className="text-lg font-semibold tracking-tight">{agencyName || 'Embed'}</span>
          </div>
          {children}
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

const useFields = (initial) => {
  const [form, setForm] = useState(initial);
  return [form, (k) => ({ value: form[k], onChange: (e) => setForm((f) => ({ ...f, [k]: e.target.value })) })];
};
const switchLink = 'font-medium text-brand-700 hover:underline';

export default function Login({ onDone }) {
  const [boot, setBoot] = useState(null);
  const [mode, setMode] = useState('signin'); // signin | signup | requested
  const [form, bind] = useFields({ agencyName: '', name: '', email: '', password: '', company: '', title: '' });
  useEffect(() => { api.get('/bootstrap').then(setBoot).catch(() => setBoot({ needsSetup: false })); }, []);

  const [submit, busy] = useAction(async () => {
    if (mode === 'signup') {
      await api.post('/signup', form);
      setMode('requested');
      return;
    }
    await api.post(boot.needsSetup ? '/setup' : '/login', form);
    await onDone();
  });
  if (!boot) return <Loading className="h-full" />;
  const setup = boot.needsSetup;
  const agency = boot.agencyName || 'the agency';

  if (mode === 'requested') {
    return (
      <AuthFrame agencyName={boot.agencyName}>
        <CircleCheck className="size-10 text-brand-600" />
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">Request sent</h1>
        <p className="mt-2 text-sm leading-relaxed text-stone-600">
          Thanks, {form.name.split(' ')[0]}. If you do not already have an account, your request is now with {agency}. You will be able to sign in with
          <span className="font-medium text-stone-900"> {form.email} </span>and the password you chose as soon as it is approved.
        </p>
        <p className="mt-6 text-sm text-stone-600">Already have an account? <button type="button" className={switchLink} onClick={() => setMode('signin')}>Sign in</button></p>
      </AuthFrame>
    );
  }

  const signup = mode === 'signup';
  return (
    <AuthFrame agencyName={boot.agencyName}>
      <h1 className="text-2xl font-semibold tracking-tight">{setup ? 'Set up your workspace' : signup ? 'Create your account' : 'Sign in'}</h1>
      <p className="mt-1.5 text-sm text-stone-500">
        {setup ? 'Create the owner account for your agency. You can invite your team and your clients afterwards.'
          : signup ? `Tell us who you are. ${boot.agencyName || 'The agency'} will confirm your account and connect it to your company's hiring.`
          : 'Welcome back. Enter your details to open your hiring workspace.'}
      </p>
      <form className="mt-8 space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {setup && <Field label="Agency name"><Input {...bind('agencyName')} required placeholder="e.g. Harbour Talent Partners" /></Field>}
        {(setup || signup) && <Field label="Your name"><Input {...bind('name')} required autoComplete="name" autoFocus={signup} /></Field>}
        <Field label={signup ? 'Work email' : 'Email'}><Input type="email" {...bind('email')} required autoComplete="email" autoFocus={!setup && !signup} /></Field>
        {signup && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Company"><Input {...bind('company')} required autoComplete="organization" /></Field>
            <Field label="Job title"><Input {...bind('title')} autoComplete="organization-title" /></Field>
          </div>
        )}
        <Field label="Password" hint={setup || signup ? 'At least 8 characters.' : undefined}>
          <Input type="password" {...bind('password')} required minLength={setup || signup ? 8 : undefined} autoComplete={setup || signup ? 'new-password' : 'current-password'} />
        </Field>
        <Button type="submit" variant="primary" busy={busy} className="w-full">{setup ? 'Create workspace' : signup ? 'Request account' : 'Sign in'}</Button>
      </form>
      {!setup && (
        <p className="mt-6 text-sm text-stone-600">
          {signup ? <>Already have an account? <button type="button" className={switchLink} onClick={() => setMode('signin')}>Sign in</button></>
            : <>New here? <button type="button" className={switchLink} onClick={() => setMode('signup')}>Create an account</button></>}
        </p>
      )}
    </AuthFrame>
  );
}

/** /join/<token>: someone opening an invitation link sets their own name and password and is signed straight in. */
export function Join() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [form, bind] = useFields({ name: '', email: '', title: '', password: '' });
  useEffect(() => { api.get(`/invites/${token}`).then(setInvite).catch((err) => setError(err.message)); }, [token]);
  const [accept, busy] = useAction(async () => {
    await api.post(`/invites/${token}/accept`, form);
    navigate('/', { replace: true });
  });

  if (error) {
    return (
      <AuthFrame>
        <h1 className="text-2xl font-semibold tracking-tight">This link cannot be used</h1>
        <p className="mt-2 text-sm leading-relaxed text-stone-600">{error}</p>
        <a href="/" className={`mt-6 inline-block text-sm ${switchLink}`}>Go to sign in</a>
      </AuthFrame>
    );
  }
  if (!invite) return <Loading className="h-full" />;
  const where = invite.role === 'client' ? `${invite.clientName}'s hiring team` : `the ${invite.agencyName} team`;
  return (
    <AuthFrame agencyName={invite.agencyName}>
      <h1 className="text-2xl font-semibold tracking-tight">Join {where}</h1>
      <p className="mt-1.5 text-sm text-stone-500">
        {invite.role === 'client'
          ? `${invite.agencyName} runs hiring for ${invite.clientName} here. Create your account to review candidates, give interview feedback and follow each role.`
          : 'Create your account to start working in the hiring workspace.'}
      </p>
      <form className="mt-8 space-y-4" onSubmit={(e) => { e.preventDefault(); accept(); }}>
        <Field label="Your name"><Input {...bind('name')} required autoComplete="name" autoFocus /></Field>
        <Field label="Email">
          {invite.email ? <Input value={invite.email} disabled /> : <Input type="email" {...bind('email')} required autoComplete="email" />}
        </Field>
        <Field label="Job title"><Input {...bind('title')} autoComplete="organization-title" /></Field>
        <Field label="Password" hint="At least 8 characters."><Input type="password" {...bind('password')} required minLength={8} autoComplete="new-password" /></Field>
        <Button type="submit" variant="primary" busy={busy} className="w-full">Create account</Button>
      </form>
    </AuthFrame>
  );
}
