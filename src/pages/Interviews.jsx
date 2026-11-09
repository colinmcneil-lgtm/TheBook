import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarDays, ClipboardCheck } from 'lucide-react';
import { useApp, useApi } from '../state.jsx';
import { url, fmtDay } from '../lib.js';
import { Badge, Card, Empty, Loading, Page, Tabs } from '../ui.jsx';
import { ClientName, InterviewLine } from '../components/bits.jsx';

export default function Interviews() {
  const { scope } = useApp();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'upcoming';
  const setTab = (t) => { const next = new URLSearchParams(params); next.set('tab', t); setParams(next, { replace: true }); };
  const { data: rows } = useApi(url('/interviews', { client_id: scope, when: tab }));
  const { data: nav } = useApi(url('/nav', { client_id: scope }));

  const groups = [];
  if (rows && tab === 'upcoming') {
    for (const i of rows) {
      const label = fmtDay(i.starts_at);
      if (groups.at(-1)?.label !== label) groups.push({ label, items: [] });
      groups.at(-1).items.push(i);
    }
  }
  const feedbackBadge = (i) => {
    if (i.status === 'cancelled') return <Badge tone="red">Cancelled</Badge>;
    const done = i.panel.filter((p) => p.submitted).length;
    return <Badge tone={done === i.panel.length && done > 0 ? 'green' : 'amber'}>{done}/{i.panel.length} scorecards</Badge>;
  };

  return (
    <Page title="Interviews" subtitle="What is booked, and whose feedback is still outstanding.">
      <Tabs className="mb-4" value={tab} onChange={setTab}
        tabs={[{ id: 'upcoming', label: 'Upcoming' }, { id: 'feedback', label: 'Needs my scorecard', count: nav?.scorecards_due || undefined }, { id: 'past', label: 'Past' }]} />
      {!rows ? <Loading /> : !rows.length ? (
        <Card>
          <Empty icon={tab === 'feedback' ? ClipboardCheck : CalendarDays} title={tab === 'upcoming' ? 'No interviews booked' : tab === 'feedback' ? 'No scorecards outstanding' : 'No past interviews'}>
            {tab === 'upcoming' ? 'Schedule an interview from any candidate’s profile.' : tab === 'feedback' ? 'When you have interviewed someone, your scorecard request appears here.' : ''}
          </Empty>
        </Card>
      ) : tab === 'upcoming' ? (
        <div className="space-y-4">
          {groups.map((g) => (
            <Card key={g.label} className="overflow-hidden">
              <div className="border-b border-line bg-stone-50 px-4 py-2 text-[13px] font-semibold text-stone-700">{g.label}</div>
              <div className="divide-y divide-line">
                {g.items.map((i) => <InterviewLine key={i.id} interview={i} trailing={<span className="hidden text-[13px] text-stone-500 sm:block"><ClientName name={i.client_name} color={i.brand_color} /></span>} />)}
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="divide-y divide-line overflow-hidden">
          {rows.map((i) => <InterviewLine key={i.id} interview={i} showDate trailing={tab === 'feedback' ? <Badge tone="amber" icon={ClipboardCheck}>Scorecard due</Badge> : feedbackBadge(i)} />)}
        </Card>
      )}
    </Page>
  );
}
