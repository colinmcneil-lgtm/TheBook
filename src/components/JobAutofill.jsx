import React, { useEffect, useState } from 'react';
import { ChevronDown, FileUp, LoaderCircle, Sparkles } from 'lucide-react';
import { api } from '../lib.js';
import { useApi } from '../state.jsx';
import { Badge, Button, Textarea, useAction, useToast, cx } from '../ui.jsx';

// Paste or drop in a job description and/or the notes from an intake call, and get the job (and its recruiter
// brief) drafted. With AI connected the documents are read by Claude; without it only what a job description
// states outright is picked up. The result is handed to the parent form, which the recruiter still reviews.

// The same limits the server applies; checked here first, because a request far over them is refused before the
// server can say why.
const MAX_DESCRIPTION = 60000;
const MAX_NOTES = 300000;
// A call transcript saved as a PDF runs to dozens of pages. Every page is read, up to this many.
const MAX_PAGES = 300;

function Source({ label, hint, placeholder, value, onChange }) {
  const toast = useToast();
  const [reading, setReading] = useState(false);
  const [over, setOver] = useState(false);
  const take = async (file) => {
    if (!file) return;
    if (!/\.(pdf|docx|rtf|txt|md|vtt|srt)$/i.test(file.name)) return toast('Use a PDF, Word (.docx), RTF or text file, or paste the text.', 'error');
    setReading(true);
    try {
      const { extractDocumentText } = await import('../resume.js');
      const named = /\.(md|vtt|srt)$/i.test(file.name) ? new File([file], `${file.name}.txt`) : file; // plain-text formats
      const { text, pages, read } = await extractDocumentText(named, MAX_PAGES);
      if (!text.trim()) toast('No text could be read from that file. If it is a scan, paste the text instead.', 'error');
      else {
        // What is already in the box stays: the file's text goes under it.
        const typed = value.trim();
        onChange(typed ? `${typed}\n\n${text.trim()}` : text.trim());
        if (pages > read) toast(`Only the first ${read} of this file's ${pages} pages were read. Paste the rest if it matters.`, 'error');
        else if (typed) toast('Added below what was already in the box.');
      }
    } catch {
      toast('That file could not be read. Paste the text instead.', 'error');
    } finally {
      setReading(false);
    }
  };
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-stone-700">{label}</span>
        <label className="inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
          {reading ? <LoaderCircle className="size-3.5 animate-spin" /> : <FileUp className="size-3.5" />}
          {reading ? 'Reading…' : 'Choose a file'}
          <input type="file" accept=".pdf,.docx,.rtf,.txt,.md,.vtt,.srt" className="sr-only" aria-label={`${label} file`} onChange={(e) => { take(e.target.files[0]); e.target.value = ''; }} />
        </label>
      </div>
      <Textarea rows={5} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files[0]); }}
        className={cx('text-[13px]', over && '!border-brand-500 !bg-brand-50')} />
      <p className="mt-1 text-xs text-stone-500">{hint}</p>
    </div>
  );
}

/**
 * `onResult(result)` hands the draft to the parent form. It may return what it did with it: `note`, a sentence
 * shown after the outcome (which fields it left alone, say), and `notesUsed: false` when the intake notes the
 * plain reader keeps "as written" did not go anywhere.
 */
export default function JobAutofill({ onResult, collapsible, what = 'the job' }) {
  const toast = useToast();
  const [open, setOpen] = useState(!collapsible);
  const [description, setDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [outcome, setOutcome] = useState(null);
  const { data: status } = useApi('/jobs/autofill/status');
  const [run, busy] = useAction(async () => {
    const k = (n) => `${Math.round(n / 1000)}k`;
    if (description.trim().length > MAX_DESCRIPTION) return toast(`That job description is too long to read in one go (${k(description.trim().length)} characters; the limit is ${k(MAX_DESCRIPTION)}). Paste just the advert.`, 'error');
    if (notes.trim().length > MAX_NOTES) return toast(`Those intake notes are too long to read in one go (${k(notes.trim().length)} characters; the limit is ${k(MAX_NOTES)}). Paste the part of the call about this role.`, 'error');
    const result = await api.post('/jobs/autofill', { job_description: description, intake_notes: notes });
    setOutcome({ ...result, ...(onResult(result) || {}) });
  });
  const ai = status?.ai;

  // A file dropped just beside a box would otherwise be opened by the browser, in place of or next to the app.
  useEffect(() => {
    if (!open) return undefined;
    const ignore = (e) => {
      if (e.defaultPrevented || !Array.from(e.dataTransfer?.types || []).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', ignore);
    window.addEventListener('drop', ignore);
    return () => {
      window.removeEventListener('dragover', ignore);
      window.removeEventListener('drop', ignore);
    };
  }, [open]);

  return (
    <section className="rounded-xl border border-brand-200 bg-brand-50/50">
      <button type="button" onClick={() => collapsible && setOpen((o) => !o)} aria-expanded={open}
        className={cx('flex w-full items-center gap-2 px-4 py-3 text-left', !collapsible && 'cursor-default')}>
        <Sparkles className="size-4 shrink-0 text-brand-600" />
        <span className="flex-1 text-sm font-semibold text-stone-900">Fill in {what} from a job description or intake call</span>
        {status && <Badge tone={ai ? 'green' : 'gray'}>{ai ? 'AI drafting on' : 'Basic reading'}</Badge>}
        {collapsible && <ChevronDown className={cx('size-4 text-stone-500 transition-transform', open && 'rotate-180')} />}
      </button>
      {open && (
        <div className="space-y-3 border-t border-brand-200 px-4 py-3">
          <div className="grid gap-4 sm:grid-cols-2">
            <Source label="Job description" value={description} onChange={setDescription}
              placeholder="Paste the client's job description or advert, or drop the file here."
              hint="PDF, Word or text." />
            <Source label="Intake call" value={notes} onChange={setNotes}
              placeholder="Paste your notes or the transcript from the call with the hiring manager, or drop the file here."
              hint="Notes or a full transcript both work." />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" icon={Sparkles} busy={busy} disabled={!description.trim() && !notes.trim()} onClick={run}>{busy ? 'Reading…' : `Fill in ${what}`}</Button>
            <p className="min-w-0 flex-1 basis-64 text-xs leading-relaxed text-stone-600">
              {busy ? (ai ? 'Reading the documents and drafting. A long transcript can take a couple of minutes.' : 'Reading the job description…')
                : outcome ? (
                  <>
                    {outcome.warning ? <span className="font-medium text-amber-800">{outcome.warning} </span> : null}
                    {outcome.source === 'ai'
                      ? 'Drafted from your documents. Check every field before saving: it can misread or leave things out.'
                      : 'Filled in what the job description states directly (title, location, salary, requirement lists).'}
                    {outcome.notes && outcome.notesUsed !== false && (outcome.notes === 'cut'
                      ? <span className="font-medium text-amber-800"> The intake notes are longer than the brief holds, so only the first part (about 6,000 characters) was kept in it. Keep the full notes somewhere else.</span>
                      : ' Intake notes were kept as written in the brief.')}
                    {outcome.note ? <span className="font-medium text-stone-800"> {outcome.note}</span> : null}
                  </>
                ) : ai ? 'The documents are sent to Claude (Anthropic) to draft the fields below and the recruiter brief. Nothing is saved until you save the job.'
                : 'AI drafting is not connected, so only details a job description states outright are picked up. An admin can connect it under Settings, Agency.'}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
