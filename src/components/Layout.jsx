import React, { useEffect, useState } from 'react';
import { NavLink, useLocation, useSearchParams } from 'react-router-dom';
import { LayoutDashboard, Inbox, Briefcase, Users, CalendarDays, ChartColumn, Building2, Settings, ChevronsUpDown, Check, LogOut, Menu as MenuIcon, X } from 'lucide-react';
import { useApp, useApi, useOpenCandidate } from '../state.jsx';
import { url } from '../lib.js';
import { Avatar, ClientDot, Menu, cx } from '../ui.jsx';
import { Logo } from '../pages/Login.jsx';
import CandidateDrawer from './CandidateDrawer.jsx';

function ScopeSwitcher() {
  const { clients, scope, scopeClient, setScope, isAgency } = useApp();
  const trigger = (
    <button type="button" className="flex w-full items-center gap-2 rounded-lg bg-white/5 px-2.5 py-2 text-left text-sm text-white ring-1 ring-white/10 hover:bg-white/10">
      {scopeClient ? <ClientDot color={scopeClient.brand_color} className="ring-2 ring-white/20" /> : <Building2 className="size-4 text-brand-300" />}
      <span className="min-w-0 flex-1 truncate font-medium">{scopeClient ? scopeClient.name : 'All clients'}</span>
      {isAgency && <ChevronsUpDown className="size-4 text-brand-300" />}
    </button>
  );
  if (!isAgency) return trigger;
  const item = (id, label, color) => ({
    label: (
      <span className="flex w-full items-center gap-2">
        {color ? <ClientDot color={color} /> : <Building2 className="size-3.5 text-stone-400" />}
        <span className="flex-1 truncate">{label}</span>
        {scope === id && <Check className="size-4 text-brand-600" />}
      </span>
    ),
    onClick: () => setScope(id),
  });
  return <Menu align="left" className="w-full" trigger={trigger} items={[item(null, 'All clients'), null, ...clients.map((c) => item(c.id, c.name, c.brand_color))]} />;
}

export default function Layout({ children }) {
  const { user, isAgency, agencyName, scope, signOut } = useApp();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const [params] = useSearchParams();
  const openCandidate = useOpenCandidate();
  const { data: counts } = useApi(url('/nav', { client_id: scope }));
  useEffect(() => setOpen(false), [location.pathname]);

  const inboxCount = counts ? (isAgency ? counts.new_applicants : counts.pending_review) : 0;
  const nav = [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
    { to: '/inbox', label: isAgency ? 'Inbox' : 'To review', icon: Inbox, count: inboxCount },
    { to: '/jobs', label: 'Jobs', icon: Briefcase },
    { to: '/candidates', label: 'Candidates', icon: Users },
    { to: '/interviews', label: 'Interviews', icon: CalendarDays, count: counts?.scorecards_due },
    { to: '/reports', label: 'Reports', icon: ChartColumn },
    isAgency && { to: '/clients', label: 'Clients', icon: Building2 },
    { to: '/settings', label: 'Settings', icon: Settings, count: counts?.pending_accounts },
  ].filter(Boolean);

  const sidebar = (
    <div className="flex h-full flex-col bg-brand-950 text-brand-100">
      <div className="flex items-center gap-2.5 px-4 pt-5 pb-4">
        <Logo size={30} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-white">{agencyName}</div>
          <div className="text-xs text-brand-300">Hiring workspace</div>
        </div>
      </div>
      <div className="px-3 pb-3"><ScopeSwitcher /></div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-1" aria-label="Main">
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => cx(
              'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
              isActive ? 'bg-white/10 text-white' : 'text-brand-200 hover:bg-white/5 hover:text-white',
            )}
          >
            <item.icon className="size-[18px] opacity-80" />
            <span className="flex-1">{item.label}</span>
            {item.count > 0 && <span className="tabular rounded-full bg-gold px-1.5 text-xs font-semibold text-brand-950">{item.count}</span>}
          </NavLink>
        ))}
      </nav>
      <div className="flex items-center gap-2.5 border-t border-white/10 px-4 py-3">
        <Avatar name={user.name} size={30} color="#2a624b" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-white">{user.name}</div>
          <div className="truncate text-xs text-brand-300">{user.title || user.email}</div>
        </div>
        <button type="button" onClick={signOut} aria-label="Sign out" title="Sign out" className="rounded-md p-1.5 text-brand-300 hover:bg-white/10 hover:text-white">
          <LogOut className="size-4" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      <aside className="no-print hidden w-60 shrink-0 lg:block">{sidebar}</aside>
      {open && (
        <div className="no-print fixed inset-0 z-40 flex lg:hidden">
          <div className="animate-fade-in w-64">{sidebar}</div>
          <button type="button" aria-label="Close menu" className="flex-1 bg-stone-950/40" onClick={() => setOpen(false)} />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print flex items-center gap-3 border-b border-line bg-white px-4 py-2.5 lg:hidden">
          <button type="button" aria-label="Open menu" onClick={() => setOpen(true)} className="rounded-md p-1.5 text-stone-600 hover:bg-stone-100">
            {open ? <X className="size-5" /> : <MenuIcon className="size-5" />}
          </button>
          <Logo size={24} />
          <span className="truncate text-sm font-semibold">{agencyName}</span>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      {params.get('c') && <CandidateDrawer key={params.get('c')} id={params.get('c')} onClose={() => openCandidate(null)} />}
    </div>
  );
}
