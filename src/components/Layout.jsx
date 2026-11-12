import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { LayoutDashboard, ListTodo, Repeat2, Inbox, MessagesSquare, Briefcase, Users, CalendarDays, AudioLines, ChartColumn, Building2, Settings, ChevronsUpDown, Check, LogOut, Menu as MenuIcon, X, Search, Plus, UserPlus } from 'lucide-react';
import { useApp, useApi, useOpenCandidate } from '../state.jsx';
import { url } from '../lib.js';
import { Avatar, Button, ClientDot, Menu, cx } from '../ui.jsx';
import { Logo } from '../pages/Login.jsx';
import CandidateDrawer from './CandidateDrawer.jsx';
import { RecorderStrip, useRecorder } from '../oracle/RecorderProvider.jsx';

/**
 * Whatever sits across the top of the workspace: the strip that follows a recording round the app. Drawers and
 * dialogs cover the whole window; they start below it, however tall it is, so it is never hidden.
 */
function TopBars({ children }) {
  const box = useRef(null);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const measure = () => {
      const height = box.current?.offsetHeight || 0;
      if (height) root.style.setProperty('--recording-bar', `${height}px`);
      else root.style.removeProperty('--recording-bar');
    };
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(box.current);
    return () => { watcher.disconnect(); root.style.removeProperty('--recording-bar'); };
  }, []);
  return <div ref={box} className="shrink-0">{children}</div>;
}

/**
 * One bar across the top. A bar that fails to draw is left out and the fault is logged: it sits above every page,
 * so without this a fault in it would empty the whole window, and a recording under way would go with it.
 * It is tried again when the recruiter moves to another page.
 */
class Bar extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error('A bar across the top could not be shown:', error); }
  componentDidUpdate(before) { if (this.state.failed && before.at !== this.props.at) this.setState({ failed: false }); }
  render() { return this.state.failed ? null : this.props.children; }
}

function ScopeSwitcher() {
  const { clients, scope, scopeClient, setScope, isAgency } = useApp();
  const trigger = (
    <button type="button" className="flex h-9 w-full items-center gap-2.5 rounded-lg bg-white/5 px-2.5 text-left text-[13.5px] text-white ring-1 ring-white/10 hover:bg-white/10">
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

/**
 * The bar above every page: find anybody from anywhere, and for the agency the two things it does most, without
 * going to the page for them first. The search opens Candidates with the words typed; Ctrl+K (⌘K on a Mac) puts the
 * cursor in it from anywhere in the workspace.
 */
function TopBar() {
  const { isAgency, clients } = useApp();
  const navigate = useNavigate();
  const box = useRef(null);
  const [text, setText] = useState('');
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); box.current?.focus(); box.current?.select(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const go = (e) => {
    e.preventDefault();
    navigate(url('/candidates', { q: text.trim() || null, status: 'all' }));
  };
  // Mac keyboards say ⌘; everything else says Ctrl.
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  return (
    <div className="no-print flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 sm:px-8">
      <form onSubmit={go} className="relative min-w-0 flex-1 basis-64 sm:max-w-lg">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
        <input ref={box} type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search candidates…" aria-label="Search candidates"
          className="h-9 w-full rounded-lg border border-line bg-white pr-14 pl-9 text-sm text-stone-900 placeholder:text-stone-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20" />
        <kbd aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded border border-line px-1.5 py-px font-sans text-[11px] text-stone-500 max-sm:hidden">{mac ? '⌘K' : 'Ctrl K'}</kbd>
      </form>
      {isAgency && (
        <div className="ml-auto flex items-center gap-2">
          <Button icon={UserPlus} onClick={() => navigate('/candidates?new=1')} className="max-sm:hidden">Add candidate</Button>
          <Button variant="primary" icon={Plus} onClick={() => navigate('/jobs?new=1')} disabled={!clients.length}>New job</Button>
        </div>
      )}
    </div>
  );
}

export default function Layout({ children }) {
  const { user, isAgency, agencyName, scope, signOut } = useApp();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const [params] = useSearchParams();
  const openCandidate = useOpenCandidate();
  // The counts are looked at again every twenty seconds while the tab is in view, for messages from the team (and
  // straight away when a conversation is read or written in, when the To do lists are read, or when the tab comes
  // back into view).
  const [again, setAgain] = useState(0);
  useEffect(() => {
    if (!isAgency) return undefined;
    const look = () => document.visibilityState === 'visible' && setAgain((n) => n + 1);
    const timer = setInterval(look, 20000);
    window.addEventListener('messages:changed', look);
    window.addEventListener('messages:counted', look);
    window.addEventListener('todos:counted', look);
    document.addEventListener('visibilitychange', look);
    return () => {
      clearInterval(timer);
      window.removeEventListener('messages:changed', look);
      window.removeEventListener('messages:counted', look);
      window.removeEventListener('todos:counted', look);
      document.removeEventListener('visibilitychange', look);
    };
  }, [isAgency]);
  const { data: counts } = useApi(url('/nav', { client_id: scope }), again);
  const recording = useRecorder().live;
  useEffect(() => setOpen(false), [location.pathname]);

  // For the agency, new applicants and what somebody on the team is waiting for this person to review (or has answered).
  const inboxCount = counts ? (isAgency ? counts.new_applicants + (counts.reviews || 0) : counts.pending_review) : 0;
  // The pages in three groups: what is waiting today, the hiring itself, and the agency (or, for a client's user, their company) around it.
  const groups = [
    { label: 'Today', items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      isAgency && { to: '/todo', label: 'To do', icon: ListTodo, count: counts?.todo },
      // The whole team's cycles on its open jobs: which have been worked on, and which nobody has touched. Agency only.
      isAgency && { to: '/cycles', label: 'Cycles', icon: Repeat2 },
      { to: '/inbox', label: isAgency ? 'Inbox' : 'To review', icon: Inbox, count: inboxCount },
      // The agency team's own chat, with how many messages are waiting to be read. A client's user is never shown it.
      isAgency && { to: '/messages', label: 'Messages', icon: MessagesSquare, count: counts?.messages, countSays: (n) => `${n} unread` },
    ] },
    { label: 'Hiring', items: [
      { to: '/jobs', label: 'Jobs', icon: Briefcase },
      { to: '/candidates', label: 'Candidates', icon: Users },
      { to: '/interviews', label: 'Interviews', icon: CalendarDays, count: counts?.scorecards_due },
      isAgency && { to: '/otterview', label: 'Otterview', icon: AudioLines, recording },
    ] },
    { label: isAgency ? 'Agency' : 'Company', items: [
      { to: '/reports', label: 'Reports', icon: ChartColumn },
      isAgency && { to: '/clients', label: 'Clients', icon: Building2 },
      { to: '/settings', label: 'Settings', icon: Settings, count: counts?.pending_accounts },
    ] },
  ].map((g) => ({ ...g, items: g.items.filter(Boolean) }));

  const sidebar = (
    <div className="flex h-full flex-col bg-brand-950 text-brand-100">
      <div className="flex items-center gap-3 px-4 pt-5 pb-4">
        <Logo size={34} />
        <div className="min-w-0">
          <div className="display line-clamp-2 text-[19px] leading-tight text-white [overflow-wrap:anywhere]" title={agencyName}>{agencyName}</div>
          <div className="mt-0.5 text-[11px] font-medium tracking-[0.08em] text-brand-300 uppercase">Hiring workspace</div>
        </div>
      </div>
      <div className="px-3 pb-2"><ScopeSwitcher /></div>
      <nav className="flex-1 overflow-y-auto px-3 pb-3" aria-label="Main">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="px-2.5 pt-4 pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-brand-300/80 uppercase">{g.label}</div>
            <div className="space-y-0.5">
              {g.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => cx(
                    'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] font-medium transition-colors',
                    isActive ? 'bg-white/10 text-white' : 'text-brand-200 hover:bg-white/5 hover:text-white',
                  )}
                >
                  {({ isActive }) => (
                    <>
                      <item.icon className={cx('size-[17px]', isActive ? 'text-gold' : 'opacity-70')} />
                      <span className="flex-1">{item.label}</span>
                      {/* A count that needs a word to make sense to a screen reader says it ("Messages, 3 unread"); the badge is for the eye. */}
                      {item.count > 0 && <span className="tabular inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-gold px-1.5 text-xs font-semibold text-brand-950" aria-hidden={item.countSays ? 'true' : undefined}>{item.count}</span>}
                      {item.count > 0 && item.countSays && <span className="sr-only">, {item.countSays(item.count)}</span>}
                      {item.recording && <span className="size-2 rounded-full bg-red-500 ring-2 ring-red-500/30" role="img" aria-label="Recording" />}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="flex items-center gap-2.5 border-t border-white/10 px-4 py-3">
        <Avatar name={user.name} size={30} color="#156472" />
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
    <div className="flex h-full flex-col">
    {isAgency && (
      <TopBars>
        <Bar at={location.pathname}><RecorderStrip /></Bar>
      </TopBars>
    )}
    <div className="flex min-h-0 flex-1">
      <aside className="no-print hidden w-[232px] shrink-0 lg:block">{sidebar}</aside>
      {open && (
        <div className="no-print fixed inset-0 z-40 flex lg:hidden" style={{ top: 'var(--recording-bar, 0px)' }}>
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
        <TopBar />
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      {params.get('c') && <CandidateDrawer key={params.get('c')} id={params.get('c')} onClose={() => openCandidate(null)} />}
    </div>
    </div>
  );
}
