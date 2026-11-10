import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { api } from './lib.js';
import { AppContext } from './state.jsx';
import { ToastProvider, Loading } from './ui.jsx';
import Layout from './components/Layout.jsx';
import Login, { Join } from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Inbox from './pages/Inbox.jsx';
import Jobs from './pages/Jobs.jsx';
import JobDetail from './pages/JobDetail.jsx';
import Candidates from './pages/Candidates.jsx';
import Interviews from './pages/Interviews.jsx';
import Reports from './pages/Reports.jsx';
import Clients from './pages/Clients.jsx';
import ClientDetail from './pages/ClientDetail.jsx';
import Settings from './pages/Settings.jsx';
import { Careers, CareersJob } from './pages/Careers.jsx';

const stored = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key, value) => { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* storage unavailable */ } };

function Workspace() {
  const [me, setMe] = useState(undefined); // undefined = loading, null = signed out
  const [version, setVersion] = useState(0);
  const [scope, setScopeState] = useState(() => Number(stored('embed.scope')) || null);
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
      setScope: (id) => { setScopeState(id); store('embed.scope', id); },
      version,
      bump: () => setVersion((v) => v + 1),
      reloadMe,
      // Back to the home address, so whoever signs in next does not land on the previous person's page.
      signOut: async () => { await api.post('/logout').catch(() => {}); navigate('/', { replace: true }); setMe(null); },
    };
  }, [me, scope, version, reloadMe, navigate]);

  if (me === undefined) return <Loading className="h-full" />;
  if (!me) return <Login onDone={reloadMe} />;

  return (
    <AppContext.Provider value={ctx}>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/jobs/:id" element={<JobDetail />} />
          <Route path="/candidates" element={<Candidates />} />
          <Route path="/interviews" element={<Interviews />} />
          <Route path="/reports" element={<Reports />} />
          {ctx.isAgency && <Route path="/clients" element={<Clients />} />}
          {ctx.isAgency && <Route path="/clients/:id" element={<ClientDetail />} />}
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
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
