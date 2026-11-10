import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AudioLines, FileAudio, Mic, MonitorSpeaker, Pause, Phone, Play, Square, Upload, UserPlus } from 'lucide-react';
import { useApp, useApi, Pending } from '../state.jsx';
import { api, url, fmtDateTime, photoUrl } from '../lib.js';
import { Avatar, Badge, Button, Card, CardHeader, Empty, Field, Input, Modal, Page, useAction, useToast, cx } from '../ui.jsx';
import { CONSENT_WORDING, UPLOAD_CONSENT_WORDING, Elapsed, LevelMeter, MicBadge, limitWords, sessionLabel, useRecorder } from '../oracle/RecorderProvider.jsx';
import { CallRecorder } from '../oracle/recorder.js';
import { AttachModal, CallStatus, CandidatePicker, CardIntro, ConsentTick, Notice, PhoneMark, callName, fmtLength, madeBy, pickOf, useLive } from '../oracle/bits.jsx';
import { CallCard, usePhone } from '../oracle/phone.jsx';
import { CalendarCard } from '../oracle/calendar.jsx';

const code = (text) => <code className="rounded bg-stone-200/70 px-1 py-0.5 text-xs text-stone-800">{text}</code>;

/** Says what still works when transcription or AI writing is not connected, and who can connect it. */
function ConnectionNotice({ status }) {
  const { isAdmin } = useApp();
  if (!status || (status.transcription && status.ai)) return null;
  const works = !status.transcription && !status.ai
    ? 'Calls are recorded, saved and can be played back, and you can paste in a transcript. Automatic transcripts, notes summaries and submission drafts are not connected yet.'
    : !status.transcription
      ? 'Calls are recorded and saved, but automatic transcripts are not connected yet. Paste a transcript into a call and its notes summary and submission draft can still be written for you.'
      : 'Calls are recorded and transcribed. Notes summaries and submission drafts are not connected yet, so for now you write those yourself.';
  return (
    <Notice className="mt-4">
      {works}{' '}
      {isAdmin ? (
        <>
          To connect {!status.transcription && status.ai ? 'transcripts' : 'them'}, set{' '}
          {!status.transcription && code('DEEPGRAM_API_KEY')}{!status.transcription && !status.ai && ' (transcripts) and '}{!status.ai && code('ANTHROPIC_API_KEY')}{!status.transcription && !status.ai && ' (notes and drafts)'}
          {' '}where the app is hosted, then restart it. The README has the steps.
        </>
      ) : 'An admin can connect them in the app’s hosting settings.'}
    </Notice>
  );
}

function RecordForm({ picked, setPicked }) {
  const recorder = useRecorder();
  const { cannotRecord } = usePhone();
  const [title, setTitle] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [missing, setMissing] = useState(false);
  const [problem, setProblem] = useState(null);
  const starting = recorder.state === 'starting';

  const begin = async () => {
    if (cannotRecord) return undefined;
    if (!agreed) return setMissing(true);
    setProblem(null);
    try {
      await recorder.start({
        consent: { confirmed: true, wording: CONSENT_WORDING }, title: title.trim(), application_id: picked?.application_id,
        subject: picked ? { name: picked.name, job_title: picked.job_title } : null,
      });
    } catch (err) { setProblem(err.message); }
    return undefined;
  };

  return (
    <form className="flex-1 space-y-3 p-4 sm:p-5" onSubmit={(e) => { e.preventDefault(); begin(); }}>
      <CardIntro icon={Mic} title="Record a live conversation">For a call on Meet, Zoom or Teams, on speaker, or in person. It is written up when you stop.</CardIntro>
      {/* Both are optional and say so in their labels: a call can be added to a candidate afterwards. */}
      <CandidatePicker value={picked} onChange={setPicked} label="Who is this call with? (optional)" />
      <Field label="Title (optional)">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder={picked ? `Call with ${picked.name}` : 'For example “First call”'} className="max-sm:!h-11 max-sm:!text-base" />
      </Field>
      <ConsentTick checked={agreed} onChange={(v) => { setAgreed(v); if (v) setMissing(false); }} missing={missing} wording={CONSENT_WORDING} />
      {/* One call at a time: a phone call is recorded on the phone line, so the microphone stays off until it is over. */}
      {cannotRecord && <Notice tone="warn">{cannotRecord}</Notice>}
      {problem && <Notice tone="bad">{problem}</Notice>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="submit" variant="primary" busy={starting} disabled={Boolean(cannotRecord)} className="!h-11 !px-5 !text-[15px] max-sm:w-full">
          {!starting && <span className="size-2.5 rounded-full bg-red-500 ring-2 ring-white/30" aria-hidden="true" />}
          Record now
        </Button>
        <span className="min-w-0 flex-1 basis-48 text-xs leading-snug text-stone-500">Your browser asks to use the microphone the first time. You can keep working in The Book while the call is recorded.</span>
      </div>
    </form>
  );
}

/** Warns when a long call is close to the longest a call can be recorded. The recorder stops and saves it at that point. */
function NearLimit() {
  const { limitMinutes, minutesLeft } = useRecorder();
  if (minutesLeft === null) return null;
  const left = Math.max(1, Math.round(minutesLeft));
  return (
    <Notice tone="warn">
      A call can be recorded for up to {limitWords(limitMinutes)}, and this one has about {left} {left === 1 ? 'minute' : 'minutes'} left. It is then stopped and saved for you. To carry on, start a new recording.
    </Notice>
  );
}

function RecordingPanel() {
  const { state, session, waiting, callAudio, note, pause, resume, stop, addCallAudio } = useRecorder();
  const [share, sharing] = useAction(addCallAudio);
  const paused = state === 'paused';
  const stopping = state === 'stopping';
  const canShare = CallRecorder.canShareCallAudio();
  return (
    <div className="flex-1 space-y-4 p-4 sm:p-5">
      <div className="space-y-2.5">
        <div className="flex items-center gap-3 text-[13px] text-stone-600">
          <span className="w-28 shrink-0">Your microphone</span>
          <LevelMeter source="mic" className="flex-1 bg-stone-200" barClassName={paused ? 'bg-stone-400' : 'bg-red-600'} />
        </div>
        {callAudio && (
          <div className="flex items-center gap-3 text-[13px] text-stone-600">
            <span className="w-28 shrink-0">The other side</span>
            <LevelMeter source="call" className="flex-1 bg-stone-200" barClassName={paused ? 'bg-stone-400' : 'bg-brand-600'} />
          </div>
        )}
      </div>

      {waiting > 0 && (
        <Notice tone="warn">
          <span className="font-medium">The connection dropped.</span>{' '}
          {stopping ? 'The call is kept on this computer and is saved as soon as the connection is back. Keep The Book open in this browser until then.'
            : 'The call is still being recorded and is kept on this computer. It is sent as soon as the connection is back, so carry on.'}
        </Notice>
      )}
      {note && <Notice tone={note.tone === 'warn' ? 'warn' : 'info'}>{note.text}</Notice>}
      <NearLimit />

      <div className="rounded-lg border border-line bg-stone-50 px-3.5 py-3">
        {callAudio ? (
          <p className="text-[13px] leading-relaxed text-stone-700">
            <span className="font-medium text-stone-900">Both sides of the call are being recorded:</span> your microphone and the sound of {callAudio.surface === 'monitor' ? 'your computer' : callAudio.surface === 'window' ? 'the window you shared' : 'the tab you shared'}.
          </p>
        ) : canShare ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
            <p className="min-w-0 flex-1 basis-64 text-[13px] leading-relaxed text-stone-600">
              <span className="font-medium text-stone-900">Only your microphone is being recorded.</span> If the call is in Google Meet, Zoom or Teams in your browser, share that tab and tick “Also share tab audio”. Otherwise put the call on speaker.
            </p>
            <Button icon={MonitorSpeaker} busy={sharing} disabled={stopping} onClick={share} className="max-sm:!h-11">Add the other side of the call</Button>
          </div>
        ) : (
          <p className="text-[13px] leading-relaxed text-stone-600"><span className="font-medium text-stone-900">Only your microphone is being recorded.</span> Put the call on speaker so the other person is picked up too.</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button icon={paused ? Play : Pause} disabled={stopping} onClick={paused ? resume : pause} className="max-sm:!h-11">{paused ? 'Resume' : 'Pause'}</Button>
        <Button variant="dangerSolid" icon={Square} busy={stopping} onClick={stop} className="max-sm:!h-11">{stopping ? 'Saving the call…' : 'Stop and save'}</Button>
        <span className="min-w-0 flex-1 basis-56 text-[13px] text-stone-500">
          {stopping ? 'The recording has stopped and the call is being saved.'
            : session?.subject
              ? `Recording carries on while you look at ${session.subject.name.split(' ')[0]}’s profile or anything else in The Book.`
              : 'Recording carries on while you use the rest of The Book. You can add the call to a candidate when it is saved.'}
        </span>
      </div>
    </div>
  );
}

/** "Record now": the form with its one obvious button, and everything about the call while it is being recorded. */
function RecordCard({ picked, setPicked }) {
  const { state, live, session } = useRecorder();
  const active = live || state === 'stopping';
  const paused = state === 'paused';
  if (!active) return <Card><RecordForm picked={picked} setPicked={setPicked} /></Card>;
  return (
    <Card className={cx('overflow-hidden', paused ? 'border-stone-400 ring-2 ring-stone-200' : 'border-red-300 ring-2 ring-red-200')}>
      <div className={cx('flex items-center gap-4 px-4 py-4 text-white sm:px-5', paused ? 'bg-stone-800' : 'bg-red-700')}>
        <div className="min-w-0 flex-1">
          <span className="inline-flex items-center gap-2.5 text-[13px] font-semibold tracking-wide uppercase">
            <span className="relative flex size-3" aria-hidden="true">
              {state === 'recording' && <span className="absolute inline-flex size-full animate-ping rounded-full bg-white/70" />}
              <span className={cx('relative inline-flex size-3 rounded-full', paused ? 'bg-stone-400' : 'bg-white')} />
            </span>
            {state === 'stopping' ? 'Saving the call' : paused ? 'Paused' : 'Recording'}
          </span>
          <span className="mt-1 block truncate text-sm font-medium text-white">{sessionLabel(session)}</span>
          {session?.subject?.job_title && <span className="block truncate text-[13px] text-white/85">{session.subject.job_title}</span>}
        </div>
        <Elapsed className="text-4xl leading-none font-semibold tracking-tight sm:text-5xl" />
      </div>
      <RecordingPanel />
    </Card>
  );
}

const UPLOAD_TYPES = /\.(mp3|m4a|mp4|wav|webm|ogg)$/i;

/**
 * Send the upload form. A long recording can take many minutes on an ordinary connection, so unlike the usual
 * request helper this says how far it has got and can be cancelled. Returns { done, cancel }: `done` resolves to
 * the server's answer, and fails with a sentence for the recruiter (or with `cancelled` set when they cancelled).
 */
function sendUpload(form, onProgress) {
  const xhr = new XMLHttpRequest();
  const done = new Promise((resolve, reject) => {
    const fail = (message, extra) => reject(Object.assign(new Error(message), extra));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not an answer from The Book itself */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      if (xhr.status === 401) window.dispatchEvent(new Event('auth:expired'));
      return fail(data?.error
        || (xhr.status === 408 ? 'This upload took too long and was stopped. Try again on a faster connection, or upload a shorter recording.'
          : xhr.status === 413 ? 'This file is too large to upload here.'
          : 'The recording could not be uploaded. Please try again.'));
    };
    xhr.onerror = () => fail('The upload was cut off before it finished. Check your connection and try again. On a slow connection a long recording may take too long to send.');
    xhr.onabort = () => fail('Upload cancelled', { cancelled: true });
    xhr.open('POST', '/api/oracle/calls/upload');
    xhr.send(form);
  });
  return { done, cancel: () => xhr.abort() };
}

/** For calls recorded somewhere else (a phone app, a meeting tool's download). */
function UploadModal({ maxMb, initial, onClose }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [file, setFile] = useState(null);
  const [picked, setPicked] = useState(initial || null);
  const [title, setTitle] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [missing, setMissing] = useState(false);
  const [sent, setSent] = useState(null); // how much of the file has gone, 0 to 1, while it is uploading
  const [problem, setProblem] = useState(null);
  const upload = useRef(null);
  useEffect(() => () => upload.current?.cancel(), []); // leaving the dialog any other way stops the upload too
  const busy = sent !== null;
  const tooBig = file && maxMb && file.size > maxMb * 1024 * 1024;
  const wrongType = file && !UPLOAD_TYPES.test(file.name);
  const save = async () => {
    if (busy) return;
    if (!agreed) { setMissing(true); return; }
    const fd = new FormData();
    fd.append('consent', 'true'); // fields first, so the server has them before the file arrives
    fd.append('consent_wording', UPLOAD_CONSENT_WORDING);
    if (title.trim()) fd.append('title', title.trim());
    if (picked) fd.append('application_id', picked.application_id);
    fd.append('audio', file);
    setProblem(null);
    setSent(0);
    upload.current = sendUpload(fd, setSent);
    try {
      const { id } = await upload.current.done;
      upload.current = null;
      toast('Recording uploaded');
      onClose();
      navigate(`/oracle/${id}`);
    } catch (err) {
      upload.current = null;
      setSent(null);
      if (!err.cancelled) setProblem(err.message);
    }
  };
  // While a file is on its way, Cancel stops the upload and leaves the dialog as it was; otherwise it closes it.
  const cancel = () => (busy ? upload.current?.cancel() : onClose());
  const percent = Math.min(99, Math.floor((sent || 0) * 100));
  return (
    <Modal title="Upload a recording" subtitle="For a call you recorded somewhere else." onClose={busy ? () => {} : onClose} onSubmit={save}
      footer={<><Button onClick={cancel}>{busy ? 'Cancel upload' : 'Cancel'}</Button><Button type="submit" variant="primary" icon={Upload} busy={busy} disabled={!file || tooBig || wrongType}>{busy ? 'Uploading…' : 'Upload'}</Button></>}>
      <label className="flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed border-stone-300 bg-stone-50 px-4 py-3.5 transition-colors hover:border-stone-400">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white text-brand-700 ring-1 ring-line"><FileAudio className="size-5" /></span>
        <span className="min-w-0 flex-1 text-sm">
          <span className="block truncate font-medium text-stone-900">{file ? file.name : 'Choose the recording'}</span>
          <span className={cx('block text-[13px]', tooBig || wrongType ? 'text-red-700' : 'text-stone-500')}>
            {wrongType ? 'This kind of file cannot be used. Choose an MP3, M4A, MP4, WAV, WebM or OGG file.'
              : tooBig ? `This file is ${Math.ceil(file.size / 1048576)} MB. The largest that can be uploaded is ${maxMb} MB.`
              : file ? `${(file.size / 1048576).toFixed(1)} MB` : `MP3, M4A, MP4, WAV, WebM or OGG${maxMb ? `, up to ${maxMb} MB` : ''}.`}
          </span>
        </span>
        <input type="file" accept=".mp3,.m4a,.mp4,.wav,.webm,.ogg,audio/*" className="sr-only" aria-label="Recording" disabled={busy} onChange={(e) => { setFile(e.target.files[0] || null); setProblem(null); }} />
      </label>
      {busy && (
        <div role="status" aria-live="polite">
          <div className="mb-1 flex justify-between text-[13px] text-stone-600"><span>{sent >= 1 ? 'Uploaded. Saving the recording…' : 'Uploading. Keep this window open.'}</span><span className="tabular">{percent}%</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-stone-200" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Upload progress">
            <div className="h-full rounded-full bg-brand-600 transition-[width]" style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}
      {problem && <Notice tone="bad">{problem}</Notice>}
      <CandidatePicker value={picked} onChange={setPicked} hint="Optional. You can add the call to a candidate afterwards." />
      <Field label="Title" hint="Optional."><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder={picked ? `Call with ${picked.name}` : 'Candidate call'} /></Field>
      <ConsentTick checked={agreed} onChange={(v) => { setAgreed(v); if (v) setMissing(false); }} missing={missing} wording={UPLOAD_CONSENT_WORDING} />
    </Modal>
  );
}

function CallRow({ call, onAttach }) {
  const phone = usePhone();
  const onThePhone = phone.live && phone.call.call_id === call.id; // this is the phone call under way right now
  // A call named after the candidate does not repeat their name on the second line. A phone call adds the other number.
  const who = [!callName(call).includes(call.candidate_name) && call.candidate_name, call.job_title, call.client_name, call.phone_display].filter(Boolean).join(' · ');
  const phoned = call.source === 'phone';
  return (
    <li className="relative flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-stone-50">
      {call.candidate_id ? <Avatar name={call.candidate_name} size={36} src={photoUrl(call.candidate_id, call.candidate_photo)} /> : <MicBadge size={36} icon={phoned ? Phone : undefined} />}
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link to={`/oracle/${call.id}`} className="truncate text-sm font-medium text-stone-900 after:absolute after:inset-0">{callName(call)}</Link>
          <PhoneMark call={call} />
          {onThePhone ? <Badge tone="red">On the phone now</Badge> : <CallStatus status={call.status} source={call.source} />}
        </div>
        {call.candidate_id
          ? <p className="truncate text-[13px] text-stone-500">{who}</p>
          : <p className="text-[13px] font-medium text-amber-800">Not added to a candidate yet{call.phone_display ? <span className="tabular font-normal text-stone-500"> · {call.phone_display}</span> : null}</p>}
      </div>
      <div className="text-right text-[13px] text-stone-500 max-sm:basis-full max-sm:pl-[52px] max-sm:text-left">
        <span className="tabular block text-stone-700">{fmtDateTime(call.created_at)}{call.duration_ms ? ` · ${fmtLength(call.duration_ms)}` : ''}</span>
        <span className="block">{madeBy(call)}</span>
      </div>
      {!call.candidate_id && call.status !== 'recording' && (
        <Button size="sm" icon={UserPlus} onClick={onAttach} className="relative z-10 max-sm:ml-[52px]">Add to a candidate</Button>
      )}
    </li>
  );
}

export default function Oracle() {
  const { scope } = useApp();
  const recorder = useRecorder();
  const phone = usePhone();
  const [params, setParams] = useSearchParams();
  const { data: status } = useApi('/oracle/status');
  const everyone = params.get('show') === 'everyone';
  // Check again while anything is being transcribed, for a short while after opening the page in case a call that
  // was only just saved is about to be, and while a call is being recorded somewhere other than this tab (it loses
  // its "Recording" chip here when it is stopped, or saved after being cut off, over there).
  // The list follows the client chosen in the sidebar, like the rest of the workspace.
  const opened = useRef(Date.now());
  const recordingHere = recorder.session?.callId;
  const calls = useLive(url('/oracle/calls', { mine: everyone ? '' : 1, client_id: scope }),
    (rows) => rows.some((c) => c.status === 'transcribing' || (c.status === 'recording' && c.id !== recordingHere)
      || (c.status === 'uploaded' && status?.transcription && Date.now() - opened.current < 20_000)));
  const [picked, setPicked] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [attaching, setAttaching] = useState(null);

  // "Record a call" on a candidate's profile lands here with ?application=<id>: start with that person and job chosen.
  const preselect = params.get('application');
  const asked = useRef(null);
  useEffect(() => {
    if (!preselect || asked.current === preselect) return;
    asked.current = preselect;
    api.get(`/applications/${preselect}`)
      .then((d) => setPicked(pickOf({ application_id: d.application.id, candidate_id: d.candidate.id, name: d.candidate.name, photo: d.candidate.photo, job_title: d.job.title, client_name: d.client.name })))
      .catch(() => {})
      .finally(() => { const next = new URLSearchParams(params); next.delete('application'); setParams(next, { replace: true }); });
  }, [preselect]);

  // The list shows the call being recorded, and loses the "Recording" chip as soon as it stops, or as soon as a
  // recording that was cut off (by a reload, say) has been saved.
  useEffect(() => { calls.reload(); }, [recorder.live, recorder.recovered]);
  // A phone call that was recorded appears in the list once it is over and its recording has arrived.
  useEffect(() => { calls.reload(); }, [phone.call?.status, phone.call?.call_id, phone.call?.message]);

  const show = (who) => { const next = new URLSearchParams(params); who === 'everyone' ? next.set('show', 'everyone') : next.delete('show'); setParams(next, { replace: true }); };
  const toggle = (label, on, who) => (
    <button type="button" aria-pressed={on} onClick={() => show(who)}
      className={cx('rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors', on ? 'bg-white text-stone-900 shadow-sm ring-1 ring-line' : 'text-stone-500 hover:text-stone-800')}>{label}</button>
  );

  return (
    <Page title="The Oracle" subtitle="Call a candidate, record a conversation, or work from your calendar. Every call is written up for you."
      actions={<Button icon={Upload} onClick={() => setUploading(true)}>Upload a recording</Button>}>
      {/* Two columns on a computer: calling and recording on the left, the day on the right, as tall as the two together.
          On a phone they stack in the order they are most used on the move: call, record, calendar. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <CallCard />
          <RecordCard picked={picked} setPicked={setPicked} />
        </div>
        <CalendarCard className="min-w-0" />
      </div>
      <ConnectionNotice status={status} />

      <Card className="mt-4 overflow-hidden">
        <CardHeader title="Calls" count={calls.data?.length || undefined}
          action={<div className="flex gap-0.5 rounded-lg bg-stone-100 p-0.5" role="group" aria-label="Whose calls to show">{toggle('Mine', !everyone, 'mine')}{toggle('Everyone', everyone, 'everyone')}</div>} />
        {!calls.data ? <Pending error={calls.error} /> : !calls.data.length ? (
          <Empty icon={AudioLines} title={everyone ? 'No calls yet' : 'You have not recorded any calls yet'}>
            The Oracle writes up your calls with candidates: a transcript, a notes summary and a draft submission for the hiring team. Call a candidate, press Record now when your next conversation starts, or upload one you recorded elsewhere.
          </Empty>
        ) : (
          <ul className="divide-y divide-line">
            {calls.data.map((call) => <CallRow key={call.id} call={call} onAttach={() => setAttaching(call)} />)}
          </ul>
        )}
      </Card>
      {calls.data?.length === 300 && <p className="mt-2 text-xs text-stone-500">Showing the 300 most recent calls.</p>}

      {uploading && <UploadModal maxMb={status?.maxUploadMb} initial={picked} onClose={() => setUploading(false)} />}
      {attaching && <AttachModal call={attaching} onClose={() => setAttaching(null)} onDone={() => calls.reload()} />}
    </Page>
  );
}
