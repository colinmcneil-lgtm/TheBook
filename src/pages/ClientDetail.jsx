import React, { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Copy, ExternalLink, Pencil, Plus, UserPlus, Briefcase } from 'lucide-react';
import { useApp, useApi, Pending } from '../state.jsx';
import { api, url, fmtDate, ENGAGEMENTS } from '../lib.js';
import { Avatar, Badge, Button, Card, CardHeader, Empty, Page, Stat, useAction, useToast } from '../ui.jsx';
import { JobList } from './Jobs.jsx';
import { engagementSummary } from './Clients.jsx';
import { ClientForm, InviteForm } from '../components/Forms.jsx';
import JobForm from '../components/JobForm.jsx';

export default function ClientDetail() {
  const { id } = useParams();
  const { bump } = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const [modal, setModal] = useState(null);
  const { data, error } = useApi(`/clients/${id}`);
  const { data: jobs, error: jobsError } = useApi(url('/jobs', { client_id: id }));
  const [setActive] = useAction(async (user, active) => { const answer = await api.patch(`/users/${user.id}`, { active }); toast(active ? `${user.name} can sign in again` : `${user.name} can no longer sign in`); if (answer.board_notice) toast(answer.board_notice, 'error'); bump(); });

  if (error) return <Page title="This client could not be opened"><Pending error={error === 'Not found' ? 'It does not exist, or you do not have access to it.' : error} /><Link to="/clients" className="mt-4 inline-block text-sm font-medium text-brand-700 hover:underline">Back to clients</Link></Page>;
  if (!data || !jobs) return <Pending error={jobsError} />;
  const { client, team } = data;
  const careersUrl = `${window.location.origin}/careers/${client.slug}`;
  const copy = async () => { try { await navigator.clipboard.writeText(careersUrl); toast('Careers page link copied'); } catch { window.prompt('Copy this link', careersUrl); } };

  return (
    <Page
      title={<span className="flex items-center gap-3"><span className="size-7 rounded-lg" style={{ background: client.brand_color }} />{client.name}</span>}
      subtitle={[client.industry, client.location, client.website?.replace(/^https?:\/\//, '').replace(/\/$/, '')].filter(Boolean).join(' · ')}
      actions={
        <>
          <Button icon={Pencil} onClick={() => setModal('edit')}>Edit</Button>
          <Button variant="primary" icon={Plus} onClick={() => setModal('job')}>New job</Button>
        </>
      }
    >
      <Link to="/clients" className="-mt-3 mb-4 inline-flex items-center gap-1 text-[13px] text-stone-500 hover:text-stone-800"><ArrowLeft className="size-3.5" />All clients</Link>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Open roles" value={client.open_jobs} />
        <Stat label="New applicants" value={client.new_applicants} />
        <Stat label="In process" value={client.active_candidates} />
        <Stat label="Interviews booked" value={client.upcoming_interviews} />
        <Stat label="Hires" value={client.hires} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <div className="min-w-0 space-y-3">
          <h2 className="text-sm font-semibold text-stone-900">Jobs</h2>
          {jobs.length ? <JobList jobs={jobs} /> : (
            <Card><Empty icon={Briefcase} title="No jobs yet" action={<Button variant="primary" icon={Plus} onClick={() => setModal('job')}>New job</Button>}>Create the first role to publish it on this client’s careers page.</Empty></Card>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title="Careers page" action={<a href={careersUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-700 hover:underline">Open<ExternalLink className="size-3.5" /></a>} />
            <div className="space-y-3 p-4">
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg bg-stone-100 px-2.5 py-2 text-xs text-stone-700">{careersUrl}</code>
                <Button size="sm" icon={Copy} onClick={copy}>Copy</Button>
              </div>
              <p className="text-[13px] text-stone-500">Link to this from the client’s website. Open jobs appear automatically and applications arrive in your inbox.</p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Hiring team" count={team.length} action={<Button size="sm" icon={UserPlus} onClick={() => setModal('user')}>Invite</Button>} />
            {team.length ? (
              <ul className="divide-y divide-line">
                {team.map((u) => (
                  <li key={u.id} className="flex items-center gap-3 px-4 py-2.5">
                    <Avatar name={u.name} size={30} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-stone-900">{u.name}{!u.active && <Badge className="ml-2">Deactivated</Badge>}</div>
                      <div className="truncate text-[13px] text-stone-500">{[u.title, u.email].filter(Boolean).join(' · ')}</div>
                    </div>
                    <button type="button" onClick={() => setActive(u, !u.active)} className="text-xs font-medium text-stone-500 hover:text-stone-900">{u.active ? 'Deactivate' : 'Reactivate'}</button>
                  </li>
                ))}
              </ul>
            ) : <p className="px-4 py-5 text-sm text-stone-500">Invite hiring managers and interviewers so they can review your shortlists and submit scorecards. You get a link to send them; they choose their own password.</p>}
          </Card>

          <Card>
            <CardHeader title="Engagement" action={<span className="text-xs text-stone-500">Agency only</span>} />
            <dl className="space-y-2 p-4 text-sm">
              <div className="flex justify-between gap-4"><dt className="text-stone-500">Model</dt><dd className="font-medium">{ENGAGEMENTS[client.engagement_model]}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-stone-500">Terms</dt><dd className="font-medium">{engagementSummary(client)}</dd></div>
              {client.started_at && <div className="flex justify-between gap-4"><dt className="text-stone-500">Since</dt><dd className="font-medium">{fmtDate(client.started_at, true)}</dd></div>}
              <div className="flex justify-between gap-4"><dt className="text-stone-500">Status</dt><dd className="font-medium capitalize">{client.status}</dd></div>
            </dl>
          </Card>
        </div>
      </div>

      {modal === 'edit' && <ClientForm client={client} onClose={() => setModal(null)} />}
      {modal === 'user' && <InviteForm client={client} onClose={() => setModal(null)} />}
      {modal === 'job' && <JobForm clientId={client.id} onClose={() => setModal(null)} onSaved={(jobId) => navigate(`/jobs/${jobId}`)} />}
    </Page>
  );
}
