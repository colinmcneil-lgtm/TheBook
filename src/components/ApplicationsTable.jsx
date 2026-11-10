import React from 'react';
import { Users } from 'lucide-react';
import { useApp, useOpenCandidate } from '../state.jsx';
import { since, fmtDate, SOURCES } from '../lib.js';
import { Avatar, Card, Empty, Stars } from '../ui.jsx';
import { CandidateCell, ClientName, NoJobBadge, ReviewBadge, StageBadge } from './bits.jsx';

export default function ApplicationsTable({ rows, showJob = true, empty = 'No candidates match these filters.' }) {
  const open = useOpenCandidate();
  const { isAgency } = useApp();
  if (!rows.length) return <Card><Empty icon={Users} title="No candidates here">{empty}</Empty></Card>;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-stone-500">
            <th className="px-4 py-2.5 font-medium">Candidate</th>
            {showJob && <th className="px-3 py-2.5 font-medium">Job</th>}
            <th className="px-3 py-2.5 font-medium">Stage</th>
            <th className="px-3 py-2.5 font-medium">Owner</th>
            <th className="px-3 py-2.5 font-medium">Source</th>
            <th className="px-3 py-2.5 font-medium">Rating</th>
            {/* The agency's list across jobs includes people it saved to The Book itself, who never applied for anything. */}
            <th className="px-4 py-2.5 text-right font-medium">{showJob && isAgency ? 'Added' : 'Applied'}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((a) => (
            <tr key={a.id} onClick={() => open(a.id)} className="cursor-pointer hover:bg-stone-50">
              <td className="max-w-64 px-4 py-2.5">
                <button type="button" className="block w-full text-left" onClick={(e) => { e.stopPropagation(); open(a.id); }}><CandidateCell app={a} /></button>
                {/* On a phone the Job column is off to the right of the screen, so the marker sits under the name there. */}
                {a.general && <NoJobBadge className="mt-1 ml-11 sm:hidden" />}
              </td>
              {/* Someone saved to The Book without a job has no job, client or stage: one marker says so across both columns. */}
              {a.general ? (
                <td colSpan={showJob ? 2 : 1} className="px-3 py-2.5">
                  <NoJobBadge className="max-sm:hidden" />
                </td>
              ) : (
                <>
                  {showJob && (
                    <td className="max-w-52 px-3 py-2.5">
                      <span className="block truncate font-medium text-stone-800">{a.job_title}</span>
                      <span className="text-[13px] text-stone-500"><ClientName name={a.client_name} color={a.brand_color} /></span>
                    </td>
                  )}
                  <td className="px-3 py-2.5">
                    <span className="flex flex-wrap items-center gap-1.5"><StageBadge app={a} /><ReviewBadge status={a.status === 'active' ? a.review_status : null} /></span>
                    {a.status === 'active' && <span className="mt-0.5 block text-xs text-stone-500">{a.next_interview ? `Interview ${fmtDate(a.next_interview)}` : `for ${since(a.stage_entered_at)}`}</span>}
                  </td>
                </>
              )}
              <td className="px-3 py-2.5 whitespace-nowrap">
                {a.owner_name ? <span className="inline-flex items-center gap-1.5 text-stone-700"><Avatar name={a.owner_name} size={20} />{a.owner_name}</span> : <span className="text-stone-400">Unassigned</span>}
              </td>
              <td className="px-3 py-2.5 whitespace-nowrap text-stone-600">{SOURCES[a.source] || a.source}</td>
              <td className="px-3 py-2.5">{a.rating ? <Stars value={a.rating} size={13} /> : <span className="text-stone-300">–</span>}</td>
              <td className="tabular px-4 py-2.5 text-right whitespace-nowrap text-stone-600">{fmtDate(a.applied_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
