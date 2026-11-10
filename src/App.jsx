import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { CircleAlert } from 'lucide-react';
import { api, remember, remembered } from './lib.js';
import { AppContext } from './state.jsx';
import { ToastProvider, Loading, Empty, Button } from './ui.jsx';
import Layout from './components/Layout.jsx';
import Login, { Join } from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Todo from './pages/Todo.jsx';
import Inbox from './pages/Inbox.jsx';
import Jobs from './pages/Jobs.jsx';
import JobDetail from './pages/JobDetail.jsx';
import Candidates from './pages/Candidates.jsx';
import Interviews from './pages/Interviews.jsx';
import Reports from './pages/Reports.jsx';
import Clients from './pages/Clients.jsx';
import ClientDetail from './pages/ClientDetail.jsx';
import Settings from './pages/Settings.jsx';
import Oracle from './pages/Oracle.jsx';
import OracleCall from './pages/OracleCall.jsx';
import { RecorderProvider } from './oracle/RecorderProvider.jsx';
import { Careers, CareersJob } from './pages/Careers.jsx';

/**
 * A page that fails to draw must not take the rest of the workspace down with it. Without this, one broken page
 * empties the whole window, and with it goes the recorder: a call being recorded would stop without a word.
 * The menu, the recording strip and the recorder sit outside this, so they carry on. Going to another page clears it.
 */
class PageBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error('A page could not be shown:', error); }
  componentDidUpdate(before) { if (this.state.failed && before.at !== this.props.at) this.setState({ failed: false }); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="p-8">
        <Empty icon={CircleAlert} title="This page could not be shown" action={<Button onClick={() => this.setState({ failed: false })}>Try again</Button>}>
          Something went wrong while showing it. The rest of The Book still works: choose another page from the menu, or try this one again.
        </Empty>
      </div>
    );
  }
}
function Pages({ children }) {
  const { pathname } = useLocation();
  return <PageBoundary at={pathname}>{children}</PageBoundary>;
}

function Workspace() {
  const [me, setMe] = useState(undefined); // undefined = loading, null = signed out
  const [version, setVersion] = useState(0);
  const [scope, setScopeState] = useState(() => Number(remembered('embed.scope')) || null);
  const navigate = useNavigate();

  const reloadMe = useCallback(() => api.get('/me').then(setMe).catch(() => setMe(null)), []);
  useEffect(() => { reloadMe(); }, [reloadMe]);
  useEffect(() => {
    const expired = () => setMe(null);
    window.addEventListener('auth:expired', expired);
    return () => window.removeEventListener('auth:expired', expired);
  }, []);

  const ctx = useMemo(() => {
    if (!me) return null;
    const isAgency = me.user.role !== 'client';
    const activeScope = isAgency ? (me.clients.some((c) => c.id === scope) ? scope : null) : me.user.client_id;
    return {
      me, user: me.user, isAgency, isAdmin: me.user.role === 'admin', clients: me.clients, agencyName: me.agencyName, mailConfigured: me.mailConfigured, clientPhotos: me.clientPhotos,
      scope: activeScope,
      scopeClient: me.clients.find((c) => c.id === activeScope) || null,
      setScope: (id) => { setScopeState(id); remember('embed.scope', id); },
      version,
      bump: () => setVersion((v) => v + 1),
      reloadMe,
      // Back to the home address, so whoever signs in next does not land on the previous person's page.
      signOut: async () => { await api.post('/logout').catch(() => {}); navigate('/', { replace: true }); setMe(null); },
    };
  }, [me, scope, version, reloadMe, navigate]);

  if (me === undefined) return <Loading className="h-full" />;
  if (!me) return <Login onDone={reloadMe} />;

  // The call recorder sits above the pages, so a recording carries on while the recruiter moves around the workspace.
  // Client hiring teams have no part in The Oracle, so they get no recorder and no routes to it.
  const Providers = ctx.isAgency ? RecorderProvider : React.Fragment;
  return (
    <AppContext.Provider value={ctx}>
      <Providers>
      <Layout>
        <Pages>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          {ctx.isAgency && <Route path="/todo" element={<Todo />} />}
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/jobs/:id" element={<JobDetail />} />
          <Route path="/candidates" element={<Candidates />} />
          <Route path="/interviews" element={<Interviews />} />
          {ctx.isAgency && <Route path="/oracle" element={<Oracle />} />}
          {ctx.isAgency && <Route path="/oracle/:id" element={<OracleCall />} />}
          <Route path="/reports" element={<Reports />} />
          {ctx.isAgency && <Route path="/clients" element={<Clients />} />}
          {ctx.isAgency && <Route path="/clients/:id" element={<ClientDetail />} />}
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Pages>
      </Layout>
      </Providers>
    </AppContext.Provider>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/careers/:slug" element={<Careers />} />
        <Route path="/careers/:slug/:jobId" element={<CareersJob />} />
        <Route path="/join/:token" element={<Join />} />
        <Route path="/*" element={<Workspace />} />
      </Routes>
    </ToastProvider>
  );
}
