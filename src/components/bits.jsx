import React from 'react';
import { Check, Hourglass, FileText } from 'lucide-react';
import { Avatar, Badge, ClientDot, cx } from '../ui.jsx';
import { fmtTime, INTERVIEW_KINDS, JOB_STATUS } from '../lib.js';
import { useApp, useOpenCandidate } from '../state.jsx';

const STAGE_TONES = { applied: 'gray', interview: 'blue', offer: 'amber', hired: 'green' };

/** Where an application stands: its stage while active, otherwise its outcome. */
export function StageBadge({ app }) {
  if (app.status === 'rejected') return <Badge tone="red">Rejected</Badge>;
  if (app.status === 'withdrawn') return <Badge tone="gray">Withdrawn</Badge>;
  if (app.status === 'hired') return <Badge tone="green" icon={Check}>Hired</Badge>;
  return <Badge tone={STAGE_TONES[app.stage_kind]}>{app.stage_name}</Badge>;
}
export const ReviewBadge = ({ status }) => (status === 'pending' ? <Badge tone="amber" icon={Hourglass}>With hiring team</Badge> : null);
export const JobStatusBadge = ({ status }) => <Badge tone={JOB_STATUS[status]?.tone}>{JOB_STATUS[status]?.label}</Badge>;

/** "Lumen Health" with its colour dot; hidden when the workspace is already scoped to one client. */
export function ClientName({ name, color, always, className }) {
  const { scope } = useApp();
  if (scope && !always) return null;
  return <span className={cx('inline-flex items-center gap-1.5', className)}><ClientDot color={color} />{name}</span>;
}

export function CandidateCell({ app }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <Avatar name={app.name} size={32} />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 truncate text-sm font-medium text-stone-900">
          {app.name}
          {app.has_resume === 1 && <FileText className="size-3.5 shrink-0 text-stone-400" aria-label="Résumé on file" />}
        </span>
        <span className="block truncate text-[13px] text-stone-500">{[app.current_title, app.current_company].filter(Boolean).join(' at ') || app.email}</span>
      </span>
    </span>
  );
}

export function InterviewLine({ interview: i, showDate, trailing }) {
  const open = useOpenCandidate();
  return (
    <button type="button" onClick={() => open(i.application_id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-stone-50">
      <span className="tabular w-16 shrink-0 text-[13px] font-medium text-stone-900">
        {fmtTime(i.starts_at)}
        {showDate && <span className="block text-xs font-normal text-stone-500">{new Date(i.starts_at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span>}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-stone-900">{i.candidate_name}</span>
        <span className="block truncate text-[13px] text-stone-500">{i.title} · {i.job_title} · {INTERVIEW_KINDS[i.kind]}</span>
      </span>
      {trailing}
      <span className="flex shrink-0 -space-x-1.5">
        {i.panel.slice(0, 3).map((p) => <Avatar key={p.id} name={p.name} size={24} className="ring-2 ring-white" />)}
      </span>
    </button>
  );
}
