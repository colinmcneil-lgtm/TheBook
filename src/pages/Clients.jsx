import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Building2, Plus } from 'lucide-react';
import { useApi, Pending } from '../state.jsx';
import { ENGAGEMENTS, money } from '../lib.js';
import { Badge, Button, Card, Empty, Page } from '../ui.jsx';
import { ClientForm } from '../components/Forms.jsx';

export function engagementSummary(c) {
  const parts = [];
  if (c.engagement_model !== 'per_hire' && c.monthly_retainer) parts.push(`${money(c.monthly_retainer, c.currency)} / month`);
  if (c.engagement_model !== 'retainer' && c.fee_percent) parts.push(`${c.fee_percent}% per hire`);
  return parts.join(' + ') || ENGAGEMENTS[c.engagement_model];
}

export default function Clients() {
  const navigate = useNavigate();
  const { data: clients, error } = useApi('/clients');
  const [creating, setCreating] = useState(false);
  return (
    <Page title="Clients" subtitle="The companies you run hiring for." actions={<Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New client</Button>}>
      {!clients ? <Pending error={error} /> : !clients.length ? (
        <Card><Empty icon={Building2} title="Add your first client" action={<Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New client</Button>}>
          You will get a branded careers page for them straight away, and can invite their hiring managers once the first role is live.
        </Empty></Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {clients.map((c) => (
            <Link key={c.id} to={`/clients/${c.id}`} className="group overflow-hidden rounded-xl border border-line bg-white transition-shadow hover:shadow-md">
              <div className="h-1.5" style={{ background: c.brand_color }} />
              <div className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold text-stone-900 group-hover:underline">{c.name}</h2>
                    <p className="truncate text-[13px] text-stone-500">{[c.industry, c.location].filter(Boolean).join(' · ') || 'No details yet'}</p>
                  </div>
                  {c.status !== 'active' && <Badge tone={c.status === 'paused' ? 'amber' : 'gray'}>{c.status === 'paused' ? 'Paused' : 'Ended'}</Badge>}
                </div>
                <dl className="tabular mt-4 grid grid-cols-4 gap-2 text-center">
                  {[['Open roles', c.open_jobs], ['New', c.new_applicants], ['In process', c.active_candidates], ['Hires', c.hires]].map(([label, value]) => (
                    <div key={label} className="rounded-lg bg-stone-50 py-2">
                      <dd className="text-lg font-semibold text-stone-900">{value}</dd>
                      <dt className="text-[11px] text-stone-500">{label}</dt>
                    </div>
                  ))}
                </dl>
                <p className="mt-3 text-[13px] text-stone-600">{engagementSummary(c)}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
      {creating && <ClientForm onClose={() => setCreating(false)} onSaved={(id) => navigate(`/clients/${id}`)} />}
    </Page>
  );
}
