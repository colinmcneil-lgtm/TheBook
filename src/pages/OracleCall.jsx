import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, ArrowLeftRight, AudioLines, Check, ClipboardPaste, Copy, Ellipsis, LoaderCircle, NotebookPen, Pencil, RefreshCw, Send, Sparkles, StickyNote, Trash2, UserPlus, UserRound, X,
} from 'lucide-react';
import { useApp, useApi, Pending } from '../state.jsx';
import { api, ago, firstName, fmtDateTime, photoUrl } from '../lib.js';
import { Avatar, Badge, Button, Card, CardHeader, Input, Menu, Select, Tabs, Textarea, useAction, useToast, cx } from '../ui.jsx';
import { ReviewBadge } from '../components/bits.jsx';
import { SubmitModal } from '../components/CandidateModals.jsx';
import { useRecorder } from '../oracle/RecorderProvider.jsx';
import { AttachModal, CallStatus, CopyButton, NotesText, Notice, callName, fmtClock, fmtLength, useLive } from '../oracle/bits.jsx';

const SPEAKER_TONES = ['text-brand-700', 'text-amber-700', 'text-violet-700', 'text-sky-700', 'text-rose-700', 'text-lime-700'];
const speakerName = (call, n) => call.speakers?.[n]?.trim() || `Speaker ${Number(n) + 1}`;
const transcriptText = (call) => (call.transcript || []).map((t) => `${speakerName(call, t.speaker)}: ${t.text}`).join('\n\n');
const APP_STATUS = { hired: 'Hired', rejected: 'Rejected', withdrawn: 'Withdrawn' };

/** Text typed into a box on this page and not saved yet is saved when the recruiter leaves the page, not lost. */
function useSaveOnLeave(unsaved, save) {
  const latest = useRef(null);
  latest.current = { unsaved, save };
  useEffect(() => () => { if (latest.current.unsaved) latest.current.save(); }, []);
}

/** The title, with a pencil to rename the call. */
function Title({ call, onPatch }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [save, busy] = useAction(async () => { await onPatch({ title: text.trim() }); setEditing(false); });
  if (editing) {
    return (
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={120} autoFocus aria-label="Call title" placeholder="Give this call a title" required className="!h-10 max-w-md min-w-56 flex-1 !text-base font-medium"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); } }} />
        <Button type="submit" variant="primary" busy={busy}>Save</Button>
        <Button onClick={() => setEditing(false)}>Cancel</Button>
      </form>
    );
  }
  return (
    <h1 className="flex items-center gap-1.5 text-[22px] font-semibold tracking-tight text-stone-900">
      <span className="min-w-0 truncate">{callName(call)}</span>
      <button type="button" onClick={() => { setText(call.title || ''); setEditing(true); }} aria-label="Rename this call" title="Rename" className="rounded-md p-1.5 text-stone-400 hover:bg-stone-900/5 hover:text-stone-700"><Pencil className="size-4" /></button>
    </h1>
  );
}

/** Who the call was with: their profile and job, or the prompt to add the call to someone. */
function CandidateCard({ data, onPatch, onAttach }) {
  const { call, candidate, application, applications } = data;
  // A submission draft is written for one job's hiring team, so it does not follow the call to another job or person.
  const [setJob, moving] = useAction(async (applicationId) => {
    if (call.submission && !window.confirm('Change which job this call is about? The submission draft was written for the current job, so it is removed.')) return;
    await onPatch({ application_id: applicationId });
  });
  const [detach] = useAction(async () => {
    if (!window.confirm(`Take this call off ${candidate.name}? The call is kept, and you can add it to a candidate again later.${call.submission ? ' The submission draft is removed, because it was written for this job.' : ''}${call.note_saved ? ` The notes saved to ${firstName(candidate.name)}’s profile from this call are removed from it.` : ''}`)) return;
    await onPatch({ application_id: null });
  });
  const changeWho = (
    <Menu trigger={<Button aria-label="Change who this call is with" icon={Ellipsis} className="!px-2.5" />}
      items={[
        { label: 'Move to another candidate', icon: ArrowLeftRight, onClick: onAttach },
        candidate && { label: `Take off ${firstName(candidate.name)}’s profile`, icon: X, onClick: detach },
      ]} />
  );
  if (!candidate) {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-dashed border-amber-300 bg-amber-50/70 px-4 py-3.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white text-amber-700 ring-1 ring-amber-200"><UserRound className="size-5" /></span>
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-sm font-semibold text-amber-950">Not added to a candidate yet</p>
          <p className="text-[13px] text-amber-900">Add this call to a candidate to keep it on their profile, save its notes there and draft their submission.</p>
        </div>
        <Button variant="primary" icon={UserPlus} onClick={onAttach}>Add to a candidate</Button>
      </div>
    );
  }
  if (!application) {
    // The call is on a person but on none of their jobs: the job it was about was removed, or they were taken off
    // it. Everything that needs a job (saving notes to the profile, the submission) waits until one is chosen.
    const profile = applications[0] ? `?c=${applications[0].id}` : null;
    return (
      <Card className="flex flex-wrap items-center gap-x-4 gap-y-3 border-amber-300 px-4 py-3.5">
        <Avatar name={candidate.name} size={44} src={photoUrl(candidate.id, candidate.photo)} />
        <div className="min-w-0 flex-1 basis-64">
          {profile ? <Link to={profile} className="truncate text-[15px] font-semibold text-stone-900 hover:text-brand-700 hover:underline">{candidate.name}</Link>
            : <span className="truncate text-[15px] font-semibold text-stone-900">{candidate.name}</span>}
          {(candidate.current_title || candidate.current_company) && <p className="truncate text-[13px] text-stone-600">{[candidate.current_title, candidate.current_company].filter(Boolean).join(' at ')}</p>}
          <p className="mt-1 text-[13px] text-amber-900">The job this call was about is no longer on {firstName(candidate.name)}’s profile.{applications.length ? ' Choose which of their jobs it is about, to save its notes there and draft a submission.' : ''}</p>
          {applications.length > 0 && (
            <label className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-stone-500">
              This call is about
              <Select value="" disabled={moving} onChange={(e) => e.target.value && setJob(Number(e.target.value))} aria-label="Which job this call is about" className="!h-8 !w-auto max-w-72 !text-[13px] font-medium">
                <option value="">Choose a job…</option>
                {applications.map((a) => <option key={a.id} value={a.id}>{a.job_title} · {a.client_name}</option>)}
              </Select>
            </label>
          )}
        </div>
        <div className="flex items-center gap-2">
          {profile && <Link to={profile} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3.5 text-sm font-medium text-stone-800 shadow-sm hover:bg-stone-50"><UserRound className="size-4" />Open profile</Link>}
          {changeWho}
        </div>
      </Card>
    );
  }
  return (
    <Card className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5">
      <Avatar name={candidate.name} size={44} src={photoUrl(candidate.id, candidate.photo)} />
      <div className="min-w-0 flex-1 basis-64">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`?c=${application.id}`} className="truncate text-[15px] font-semibold text-stone-900 hover:text-brand-700 hover:underline">{candidate.name}</Link>
          {APP_STATUS[application.status] && <Badge tone={application.status === 'hired' ? 'green' : application.status === 'rejected' ? 'red' : 'gray'}>{APP_STATUS[application.status]}</Badge>}
          <ReviewBadge status={application.status === 'active' ? application.review_status : null} />
        </div>
        {(candidate.current_title || candidate.current_company) && <p className="truncate text-[13px] text-stone-600">{[candidate.current_title, candidate.current_company].filter(Boolean).join(' at ')}</p>}
        {applications.length > 1 ? (
          <label className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-stone-500">
            This call is about
            <Select value={application.id} disabled={moving} onChange={(e) => setJob(Number(e.target.value))} aria-label="Which job this call is about" className="!h-8 !w-auto max-w-72 !text-[13px] font-medium">
              {applications.map((a) => <option key={a.id} value={a.id}>{a.job_title} · {a.client_name}</option>)}
            </Select>
          </label>
        ) : (
          <p className="truncate text-[13px] text-stone-500">For <Link to={`/jobs/${application.job_id}`} className="font-medium text-brand-700 hover:underline">{application.job_title}</Link> · {application.client_name}</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Link to={`?c=${application.id}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3.5 text-sm font-medium text-stone-800 shadow-sm hover:bg-stone-50"><UserRound className="size-4" />Open profile</Link>
        {changeWho}
      </div>
    </Card>
  );
}

/** A box to paste a transcript into, for calls transcribed elsewhere or when no transcription service is connected. */
function PasteTranscript({ replacing, onSave, onCancel }) {
  const [text, setText] = useState('');
  const [save, busy] = useAction(async () => onSave(text));
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <Textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} autoFocus required aria-label="Transcript"
        placeholder={'Alex: Thanks for making the time today.\nDana: Happy to. I have been looking forward to it.'} />
      <p className="text-xs text-stone-500">Start each person’s turn on a new line with their name and a colon, as above, and they are shown as speakers. Text without names is kept as it is.</p>
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" type="submit" variant="primary" busy={busy} disabled={!text.trim()}>{replacing ? 'Replace the transcript' : 'Save transcript'}</Button>
      </div>
    </form>
  );
}

/** Name the speakers. Saved when a box is left or Enter is pressed. */
function Speakers({ call, onPatch }) {
  const ids = [...new Set(call.transcript.map((t) => t.speaker))].sort((a, b) => a - b);
  const saved = (n) => call.speakers?.[n] || '';
  const [names, setNames] = useState(() => Object.fromEntries(ids.map((n) => [n, saved(n)])));
  // When saved names come back from the server, take them, but leave alone a box the recruiter has typed in since
  // (they may already be on the second name while the first is being saved).
  const before = useRef(call.speakers);
  useEffect(() => {
    setNames((now) => Object.fromEntries(ids.map((n) => [n, (now[n] ?? '') === (before.current?.[n] || '') ? saved(n) : now[n]])));
    before.current = call.speakers;
  }, [JSON.stringify(call.speakers), ids.join()]);
  const [save] = useAction(async (next) => onPatch({ speakers: Object.fromEntries(ids.map((n) => [String(n), (next[n] || '').trim()])) }));
  const commit = () => { if (ids.some((n) => (names[n] || '').trim() !== saved(n))) save(names); };
  const swap = () => { const next = { ...names, [ids[0]]: names[ids[1]], [ids[1]]: names[ids[0]] }; setNames(next); save(next); };
  return (
    <div className={cx('flex items-center gap-2 border-b border-line bg-stone-50 px-4 py-2.5', ids.length > 2 && 'flex-wrap')} role="group" aria-label="Who is speaking">
      {ids.length <= 2 && <span className="shrink-0 text-[13px] font-medium text-stone-600 max-sm:hidden">Speakers</span>}
      {ids.map((n, i) => (
        <React.Fragment key={n}>
          {i === 1 && ids.length === 2 && (
            <button type="button" onClick={swap} disabled={!names[ids[0]] && !names[ids[1]]} aria-label="Swap the two names" title="Swap the two names"
              className="rounded-md border border-line bg-white p-1.5 text-stone-500 shadow-sm hover:bg-stone-50 hover:text-stone-800 disabled:opacity-40"><ArrowLeftRight className="size-3.5" /></button>
          )}
          <Input value={names[n] ?? ''} onChange={(e) => setNames({ ...names, [n]: e.target.value })} onBlur={commit} maxLength={60}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
            placeholder={`Speaker ${n + 1}`} aria-label={`Name of speaker ${n + 1}`} className={cx('!h-8 min-w-0 flex-1 basis-28 !text-[13px] font-medium', SPEAKER_TONES[i % SPEAKER_TONES.length])} />
        </React.Fragment>
      ))}
    </div>
  );
}

function TranscriptCard({ data, status, onPatch, reload, onSeek, activeTurn, className }) {
  const { isAdmin } = useApp();
  const toast = useToast();
  const { call } = data;
  const [pasting, setPasting] = useState(false);
  const [transcribe, starting] = useAction(async () => { await api.post(`/oracle/calls/${call.id}/transcribe`); await reload(); });
  const savePasted = async (text) => { await onPatch({ transcript_text: text }); setPasting(false); toast('Transcript saved'); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(transcriptText(call)); toast('Transcript copied'); } catch { toast('Copying is blocked in this browser.', 'error'); }
  };
  const canTranscribe = call.has_audio && status?.transcription;
  const ids = call.transcript ? [...new Set(call.transcript.map((t) => t.speaker))].sort((a, b) => a - b) : [];
  // A pasted transcript often has no times at all (every turn at zero): then there is nothing to show or jump to.
  const timed = Boolean(call.transcript?.some((t) => t.start > 0));
  const pasteButton = <Button size="sm" icon={ClipboardPaste} onClick={() => setPasting(true)}>Paste a transcript</Button>;

  let body;
  if (pasting) {
    body = <div className="p-4"><PasteTranscript replacing={Boolean(call.transcript)} onSave={savePasted} onCancel={() => setPasting(false)} /></div>;
  } else if (call.transcript?.length) {
    body = (
      <>
        <Speakers call={call} onPatch={onPatch} />
        <ol className="space-y-4 px-4 py-4">
          {call.transcript.map((t, i) => (
            <li key={i} className={cx('-mx-2 flex gap-3 rounded-lg px-2 py-1', activeTurn === i && 'bg-brand-50')}>
              {!timed ? null : call.has_audio ? (
                <button type="button" onClick={() => onSeek(t.start)} title="Play from here" aria-label={`Play from ${fmtClock(t.start)}`}
                  className="tabular mt-0.5 h-fit w-12 shrink-0 rounded text-left text-xs font-medium text-brand-700 hover:underline">{fmtClock(t.start)}</button>
              ) : <span className="tabular mt-0.5 w-12 shrink-0 text-xs text-stone-400">{fmtClock(t.start)}</span>}
              <div className="min-w-0 flex-1">
                <div className={cx('text-[13px] font-semibold', SPEAKER_TONES[ids.indexOf(t.speaker) % SPEAKER_TONES.length])}>{speakerName(call, t.speaker)}</div>
                <p className="text-sm leading-relaxed whitespace-pre-wrap text-stone-800">{t.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </>
    );
  } else if (call.status === 'transcribing') {
    body = (
      <div className="flex flex-col items-center px-6 py-10 text-center" role="status">
        <LoaderCircle className="mb-3 size-6 animate-spin text-brand-600" />
        <p className="text-sm font-medium text-stone-900">Writing the transcript</p>
        <p className="mt-1 max-w-sm text-sm text-stone-500">This usually takes a minute or two. You can leave this page; the transcript will be here when you come back.</p>
        {/* The service may be slow or not answering: the recruiter is never left with nothing to do but wait. */}
        <p className="mt-4 mb-2 text-xs text-stone-500">Already have a transcript of this call?</p>
        {pasteButton}
      </div>
    );
  } else if (call.status === 'failed') {
    body = (
      <div className="space-y-3 p-4">
        <Notice tone="bad"><span className="font-medium">This call could not be transcribed.</span> {call.error || 'The transcription service did not return a transcript.'} The recording itself is safe.</Notice>
        <div className="flex flex-wrap gap-2">
          {canTranscribe && <Button size="sm" variant="primary" icon={RefreshCw} busy={starting} onClick={transcribe}>Try again</Button>}
          {pasteButton}
        </div>
      </div>
    );
  } else if (call.status === 'recording') {
    body = <p className="px-4 py-6 text-sm text-stone-500">The transcript is written once the recording has stopped.</p>;
  } else {
    body = (
      <div className="space-y-3 p-4">
        <p className="text-sm text-stone-600">
          {!call.has_audio ? 'This call has no recording and no transcript yet. Paste a transcript to have notes and a submission drafted from it.'
            : status && !status.transcription ? `The recording is saved, but there is no transcript: the transcription service is not connected yet. ${isAdmin ? 'Set DEEPGRAM_API_KEY where the app is hosted to connect it (the README has the steps). Until then you' : 'An admin can connect it. Until then you'} can paste a transcript in.`
            : 'The recording is saved and has not been transcribed yet.'}
        </p>
        <div className="flex flex-wrap gap-2">
          {canTranscribe && <Button size="sm" variant="primary" icon={AudioLines} busy={starting} onClick={transcribe}>Transcribe this call</Button>}
          {pasteButton}
        </div>
      </div>
    );
  }

  return (
    <Card className={cx('overflow-hidden', className)}>
      <CardHeader title="Transcript" action={call.transcript?.length && !pasting ? (
        <span className="flex items-center gap-2.5">
        {call.transcript_source === 'pasted' && <span className="text-xs text-stone-500">Pasted in</span>}
        <Menu trigger={<Button size="sm" aria-label="Transcript actions" icon={Ellipsis} className="!px-2" />}
          items={[
            { label: 'Copy the transcript', icon: Copy, onClick: copy },
            { label: 'Paste a different transcript', icon: ClipboardPaste, onClick: () => setPasting(true) },
            canTranscribe && { label: 'Transcribe the recording again', icon: RefreshCw, onClick: () => { if (window.confirm('Transcribe the recording again? This replaces the transcript shown here, including any pasted one.')) transcribe(); } },
          ]} />
        </span>
      ) : null} />
      {body}
    </Card>
  );
}

function NotesCard({ data, status, onPatch, reload, awaited, className }) {
  const toast = useToast();
  const { call, candidate, application } = data;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  useSaveOnLeave(editing && text.trim() !== (call.notes || ''), () => api.patch(`/oracle/calls/${call.id}`, { notes: text }).catch(() => {}));
  const [write, writing] = useAction(async () => {
    if (call.notes && !window.confirm('Write the notes again from the transcript? This replaces the notes shown here, including any changes you made.')) return;
    await api.post(`/oracle/calls/${call.id}/notes`);
    await reload();
  });
  const [save, saving] = useAction(async () => { await onPatch({ notes: text }); setEditing(false); });
  const [toProfile, copying] = useAction(async () => {
    await api.post(`/oracle/calls/${call.id}/save-note`);
    toast(`Saved to ${firstName(candidate.name)}’s profile as an agency-only note`);
  });
  const edit = () => { setText(call.notes || ''); setEditing(true); };
  const hasTranscript = Boolean(call.transcript?.length);

  return (
    <Card className={cx('overflow-hidden', className)}>
      <CardHeader title="Notes" action={call.notes && call.notes_at ? <span className="text-xs text-stone-500">Updated {ago(call.notes_at)}</span> : null} />
      <div className="space-y-3 p-4">
        {editing ? (
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <Textarea rows={14} value={text} onChange={(e) => setText(e.target.value)} autoFocus aria-label="Notes" />
            <p className="text-xs text-stone-500">A short line followed by lines that start with “- ” is shown as a heading with bullet points.</p>
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={() => setEditing(false)}>Cancel</Button>
              <Button size="sm" type="submit" variant="primary" busy={saving}>Save notes</Button>
            </div>
          </form>
        ) : writing || (awaited && !call.notes) ? (
          <>
            <div className="flex items-center gap-3 py-4 text-sm text-stone-600" role="status"><LoaderCircle className="size-5 shrink-0 animate-spin text-brand-600" />Writing the notes summary from the transcript. This can take up to a minute.</div>
            {/* If the AI service is slow or not answering, the recruiter can get on with their own. Notes typed meanwhile are kept. */}
            {!call.notes && <Button size="sm" icon={NotebookPen} onClick={edit}>Write notes yourself</Button>}
          </>
        ) : call.notes ? (
          <>
            {call.notes_before_candidate && status?.ai && hasTranscript && (
              <Notice>These notes were written before the call was added to {firstName(candidate?.name) || 'a candidate'}, so they do not take the job into account. Press “Write again” to have them written for {application?.job_title || 'the job'}.</Notice>
            )}
            <NotesText text={call.notes} />
            <div className="flex flex-wrap gap-2 border-t border-line pt-3">
              <Button size="sm" icon={Pencil} onClick={edit}>Edit</Button>
              {status?.ai && hasTranscript && <Button size="sm" icon={RefreshCw} onClick={write}>Write again</Button>}
              <CopyButton text={call.notes} />
              {application && <Button size="sm" variant="primary" icon={StickyNote} busy={copying} onClick={toProfile} className="ml-auto">Save to their profile</Button>}
            </div>
            {!candidate ? <p className="text-xs text-stone-500">Add the call to a candidate to save these notes on their profile.</p>
              : !application ? <p className="text-xs text-stone-500">Choose which job this call is about (above) to save these notes on {firstName(candidate.name)}’s profile.</p> : null}
          </>
        ) : (
          <>
            {/* The notes are written unasked once the transcript is ready. When that failed, say why: not "no notes yet". */}
            {hasTranscript && call.notes_error ? <Notice tone="bad"><span className="font-medium">The notes could not be written.</span> {call.notes_error}</Notice> : (
              <p className="text-sm text-stone-600">
                {!hasTranscript ? 'The notes summary is written from the transcript, so there is nothing to summarise yet.'
                  : status && !status.ai ? 'Notes summaries are not connected yet, so The Oracle cannot write these for you. You can write your own.'
                  : 'There are no notes for this call yet.'}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {hasTranscript && status?.ai && <Button size="sm" variant="primary" icon={call.notes_error ? RefreshCw : Sparkles} onClick={write}>{call.notes_error ? 'Try again' : 'Write the notes'}</Button>}
              <Button size="sm" icon={NotebookPen} onClick={edit}>Write notes yourself</Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function SubmissionCard({ data, status, onPatch, reload, className }) {
  const { call, candidate, application } = data;
  const [text, setText] = useState(call.submission || '');
  const [open, setOpen] = useState(false); // writing one by hand, before any draft exists
  const [submitting, setSubmitting] = useState(null); // the application, loaded for the submit dialog
  const saved = call.submission || '';
  useEffect(() => setText(saved), [saved]);
  const dirty = text !== saved;
  // Edits are saved when the recruiter clicks away from the box or leaves the page, so a draft is never lost by going to look at something else.
  useSaveOnLeave(dirty, () => api.patch(`/oracle/calls/${call.id}`, { submission: text }).catch(() => {}));
  const card = useRef(null);
  // What the hiring team has now. When it is this very text, the card says it was sent; it does not go on calling it a draft.
  const sent = application?.sent_submission || '';
  const wasSent = Boolean(sent) && sent.trim() === text.trim();
  const [warning, setWarning] = useState(null); // something the server wants said about the draft it wrote
  const [draft, drafting] = useAction(async () => {
    if (saved && !window.confirm('Write the draft again? This replaces the text shown here, including any changes you made.')) return;
    setWarning(null);
    const written = await api.post(`/oracle/calls/${call.id}/submission`);
    setWarning(written?.warning || null);
    await reload();
  });
  const [save, saving] = useAction(async () => onPatch({ submission: text }));
  const [submit, loading] = useAction(async () => {
    if (dirty) await onPatch({ submission: text });
    setSubmitting(await api.get(`/applications/${application.id}`));
  });
  const hasMaterial = Boolean(call.transcript?.length || call.notes);
  const blocked = !candidate ? 'Add this call to a candidate first. The draft is written for the hiring team of the job they are being considered for.'
    : !application ? `Choose which of ${firstName(candidate.name)}’s jobs this call is about first (above). The draft is written for that job’s hiring team.`
    : !hasMaterial ? 'There is nothing to draft from until this call has a transcript or notes.'
    : status && !status.ai ? 'Drafting is not connected yet, so The Oracle cannot write this for you. You can write it yourself.'
    : null;

  return (
    <>
    <Card className={cx('overflow-hidden', className)}>
      <CardHeader title="Submission draft" action={call.submission && call.submission_at ? <span className="text-xs text-stone-500">Updated {ago(call.submission_at)}</span> : null} />
      <div ref={card} className="space-y-3 p-4">
        {drafting ? (
          <div className="flex items-center gap-3 py-4 text-sm text-stone-600" role="status"><LoaderCircle className="size-5 shrink-0 animate-spin text-brand-600" />Drafting the write-up for the hiring team. This can take up to a minute.</div>
        ) : saved || open ? (
          <>
            {warning && <Notice tone="warn">{warning}</Notice>}
            {/* Clicking one of this card's own buttons is not "clicking away": each of them deals with unsaved text itself. */}
            <Textarea rows={12} value={text} onChange={(e) => setText(e.target.value)} aria-label="Submission draft" placeholder="Why this person is worth meeting, in a few lines."
              onBlur={(e) => { if (dirty && !card.current?.contains(e.relatedTarget)) save(); }} />
            <div className="flex flex-wrap gap-2">
              {dirty && <Button size="sm" busy={saving} icon={Check} onClick={save}>Save changes</Button>}
              {!blocked && <Button size="sm" icon={RefreshCw} onClick={draft}>Write again</Button>}
              <CopyButton text={text} disabled={!text.trim()} />
              {application && !wasSent && <Button size="sm" variant="primary" icon={Send} busy={loading} disabled={!text.trim()} onClick={submit} className="ml-auto">Submit to the hiring team</Button>}
            </div>
            {wasSent ? (
              <p className="flex items-start gap-1.5 text-xs font-medium text-brand-800">
                <Check className="mt-px size-3.5 shrink-0" />
                <span>This write-up was sent to the {application.client_name} hiring team{application.sent_at ? ` on ${fmtDateTime(application.sent_at)}` : ''}. Change the text here if you want to send them a new one.</span>
              </p>
            ) : (
              <p className="text-xs text-stone-500">
                {application
                  ? `${sent ? 'This text has not been sent.' : 'Nothing has been sent.'} “Submit to the hiring team” opens this text for a last read, and only then is it sent to ${application.client_name}.${sent ? ' They already have an earlier write-up, which this one would replace.' : ''}`
                  : candidate ? 'Nothing is sent to anyone from here. Choose which job this call is about to submit them to its hiring team.'
                  : 'Nothing is sent to anyone from here. Add the call to a candidate to submit them to the hiring team.'}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-stone-600">{blocked || `The Oracle can draft the write-up that goes to ${application.client_name} when you submit ${firstName(candidate.name)}: why they are worth meeting, in your words, from what was said on the call.`}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" icon={Sparkles} disabled={Boolean(blocked)} title={blocked || undefined} onClick={draft}>Draft the submission</Button>
              {application && <Button size="sm" icon={NotebookPen} onClick={() => setOpen(true)}>Write it yourself</Button>}
            </div>
            {!blocked && <p className="text-xs text-stone-500">Nothing is sent until you have read it and pressed Submit yourself.</p>}
          </>
        )}
      </div>
    </Card>
    {/* What was sent may have been changed in the dialog's last read: the draft here is brought into line with it. */}
    {submitting && <SubmitModal data={submitting} initialNote={text} onClose={() => setSubmitting(null)} onSubmitted={(note) => onPatch({ submission: note }).catch(() => {})} />}
    </>
  );
}

export default function OracleCall() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const recorder = useRecorder();
  const { data: status } = useApi('/oracle/status');
  const opened = useRef(Date.now());
  // Check again while the call is being transcribed, while the server is writing the notes that follow a new
  // transcript, and for a few seconds after opening a call that was only just saved (transcribing may be about to start).
  // Also while it is being recorded somewhere other than this tab: it changes here when it is stopped, or saved after being cut off, over there.
  const live = useLive(`/oracle/calls/${id}`, (d) => d.call.status === 'transcribing' || d.call.notes_pending
    || (d.call.status === 'recording' && recorder.session?.callId !== d.call.id)
    || (d.call.status === 'uploaded' && d.call.has_audio && status?.transcription && Date.now() - opened.current < 15_000), 3000);
  const { data, error, reload, set } = live;
  const audio = useRef(null);
  const [activeTurn, setActiveTurn] = useState(-1);
  const [attaching, setAttaching] = useState(false);
  const [tab, setTab] = useState('notes');

  // This page may be showing the call that is being recorded right now, or one that was cut off and has just been
  // saved: refresh when the recording stops and when a cut-off recording has been recovered.
  useEffect(() => { reload(); }, [recorder.live, recorder.recovered]);

  const onPatch = async (changes) => set(await api.patch(`/oracle/calls/${id}`, changes));
  const [remove, removing] = useAction(async () => {
    if (!window.confirm('Delete this call? The recording, the transcript, the notes and the submission draft are removed for good. Notes already saved to a candidate’s profile stay there.')) return;
    await api.del(`/oracle/calls/${id}`);
    toast('Call deleted');
    navigate('/oracle');
  });

  // A recording that was cut off and cannot be finished from the browser that made it (another computer, cleared
  // browser data): save the call from what reached the server.
  const [saveRecording, savingRecording] = useAction(async () => {
    await api.post(`/oracle/calls/${id}/save-recording`);
    toast('Call saved');
    await reload();
  });

  if (!data) return <Pending error={error} className="p-8" />;
  const { call, candidate } = data;
  const transcript = call.transcript || [];
  const seek = (seconds) => {
    if (!audio.current) return;
    audio.current.currentTime = seconds;
    audio.current.play().catch(() => {});
  };
  const follow = () => {
    const t = audio.current?.currentTime ?? 0;
    let at = -1;
    for (let i = 0; i < transcript.length && transcript[i].start <= t; i++) at = i;
    setActiveTurn(audio.current?.paused && t === 0 ? -1 : at);
  };
  const beingRecordedHere = call.status === 'recording' && recorder.session?.callId === call.id;
  const awaitedNotes = Boolean(call.notes_pending) && !call.notes;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <Link to="/oracle" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-stone-500 hover:text-brand-700"><ArrowLeft className="size-4" />The Oracle</Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-72">
          <Title call={{ ...call, candidate_name: candidate?.name }} onPatch={onPatch} />
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-stone-500">
            <CallStatus status={call.status} />
            <span>{call.source === 'uploaded' ? 'Uploaded' : 'Recorded'} by {call.created_by_name || 'someone who has left'} · {fmtDateTime(call.created_at)}{call.duration_ms ? ` · ${fmtLength(call.duration_ms)}` : ''}</span>
          </p>
          {call.consent_at && (
            <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-stone-500">
              <Check className="size-3.5 text-brand-600" />{call.consent_by_name || call.created_by_name || 'The recruiter'} confirmed that everyone on the call agreed to be recorded.
            </p>
          )}
        </div>
        {/* A recording that was cut off and never recovered can still be deleted; the one being made right now cannot. */}
        {data.can_delete && !beingRecordedHere && <Button variant="danger" icon={Trash2} busy={removing} onClick={remove}>Delete call</Button>}
      </div>

      <div className="space-y-4">
        <CandidateCard data={data} onPatch={onPatch} onAttach={() => setAttaching(true)} />

        {call.status === 'recording' ? (
          <Notice tone={beingRecordedHere ? 'info' : 'warn'}>
            {beingRecordedHere ? 'This call is being recorded now. It can be played back here once you stop the recording.' : (
              <>
                This call is still being recorded, or its recording was cut off. If it was cut off, opening The Book in the browser it was recorded in saves everything that was recorded.
                {data.can_delete && (
                  <>
                    {' '}If that is not possible, you can save what has reached The Book so far. Nothing is lost by doing so: if the call is in fact still being recorded, the rest is added when it stops.
                    <span className="mt-2 block"><Button size="sm" variant="primary" icon={Check} busy={savingRecording} onClick={saveRecording}>Save what was recorded</Button></span>
                  </>
                )}
              </>
            )}
          </Notice>
        ) : call.has_audio ? (
          <Card className="space-y-2 px-4 py-3">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio ref={audio} controls preload="metadata" src={`/api/oracle/calls/${call.id}/audio`} onTimeUpdate={follow} onSeeked={follow} className="block h-10 w-full" aria-label="Recording of the call" />
            {call.interrupted && <p className="text-xs text-amber-800">This recording was cut off before it was stopped, so the last moments of the call may be missing.</p>}
          </Card>
        ) : null}

        <Tabs className="lg:hidden" value={tab} onChange={setTab} tabs={[{ id: 'notes', label: 'Notes' }, { id: 'submission', label: 'Submission draft' }, { id: 'transcript', label: 'Transcript' }]} />
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <TranscriptCard data={data} status={status} onPatch={onPatch} reload={reload} onSeek={seek} activeTurn={activeTurn} className={cx(tab !== 'transcript' && 'max-lg:hidden')} />
          <div className={cx('space-y-4', tab === 'transcript' && 'max-lg:hidden')}>
            <NotesCard data={data} status={status} onPatch={onPatch} reload={reload} awaited={awaitedNotes} className={cx(tab !== 'notes' && 'max-lg:hidden')} />
            <SubmissionCard data={data} status={status} onPatch={onPatch} reload={reload} className={cx(tab !== 'submission' && 'max-lg:hidden')} />
          </div>
        </div>
      </div>

      {attaching && <AttachModal call={{ ...call, candidate_name: candidate?.name }} current={Boolean(candidate)} onClose={() => setAttaching(false)} onDone={set} />}
    </div>
  );
}
