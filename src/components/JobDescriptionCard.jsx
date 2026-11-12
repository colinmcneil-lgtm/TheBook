import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Download, FileDown, FileText, FileUp, Trash2 } from 'lucide-react';
import { api, fmtDate } from '../lib.js';
import { useApi, useApp } from '../state.jsx';
import { Button, Card, Checkbox, Loading, Modal, cx, useAction, useToast } from '../ui.jsx';
import { carriesFiles } from './CandidateModals.jsx';

// The "Job description" card on a job's Brief: the advert saved on the job, downloaded as a PDF with or without the
// client's name, and the client's own file when one is kept with the job. Agency only, as the Brief is.

/** The types the server keeps as the client's file: the résumé's rules (PDF, Word, RTF or text, up to 8 MB). */
export const CLIENT_FILE_ACCEPT = '.pdf,.doc,.docx,.rtf,.txt';
export const MAX_CLIENT_FILE = 8 * 1024 * 1024;
/** Why this file cannot be kept as the client's file, as a sentence; nothing when it can. */
export function clientFileRefusal(file) {
  if (!/\.(pdf|docx?|rtf|txt)$/i.test(file.name)) return 'The client’s file has to be a PDF, a Word document (.doc or .docx), an RTF or a text file.';
  if (file.size > MAX_CLIENT_FILE) return 'That file is larger than 8 MB, so it cannot be kept with the job.';
  if (!file.size) return 'That file is empty.';
  return null;
}
/** Keep `file` as the job's client file. `replace` says the person agreed to put it in place of the one there. */
export function keepClientFile(jobId, file, replace = false) {
  const form = new FormData();
  if (replace) form.append('replace', '1');
  form.append('file', file);
  return api.put(`/jobs/${jobId}/job-description/file`, form);
}

const size = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** The name a download is saved under, from the answer's Content-Disposition (the full name, then the plain one). */
function savedName(header, fallback) {
  const full = /filename\*=UTF-8''([^;]+)/i.exec(header || '');
  if (full) { try { return decodeURIComponent(full[1]); } catch { /* fall through to the plain name */ } }
  return /filename="([^"]+)"/i.exec(header || '')?.[1] || fallback;
}

export default function JobDescriptionCard({ job, onEditJob }) {
  const { data, error } = useApi(`/jobs/${job.id}/job-description`);
  const [pdf, setPdf] = useState(false);
  return (
    <Card>
      <div className="p-5">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-stone-900"><FileText className="size-4 text-brand-600" />Job description</h3>
        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : !data ? <Loading className="h-24" /> : (
          <div className="mt-3 space-y-4">
            {data.with || data.without ? (
              <div>
                <p className="text-[13px] leading-relaxed text-stone-600">The advert saved on this job, as a PDF to send to candidates.</p>
                <Button className="mt-2.5 w-full" icon={FileDown} onClick={() => setPdf(true)}>Download as PDF</Button>
              </div>
            ) : (
              <p className="text-[13px] leading-relaxed text-stone-600">
                This job has no description yet, so there is nothing to make a PDF from.
                {onEditJob && <> <button type="button" className="font-medium text-brand-700 hover:underline" onClick={onEditJob}>Add the job advert</button>.</>}
              </p>
            )}
            <ClientFile job={job} info={data} />
          </div>
        )}
      </div>
      {pdf && data && <PdfDialog job={job} info={data} onClose={() => setPdf(false)} onEditJob={onEditJob} />}
    </Card>
  );
}

/** The client's own file: download it, or (for the job's account executive or an admin) add, replace or remove it. */
function ClientFile({ job, info }) {
  const { bump } = useApp();
  const toast = useToast();
  const [over, setOver] = useState(false);
  const input = useRef(null);
  const file = info.file;
  const [take, busy] = useAction(async (chosen) => {
    if (!chosen) return;
    const refusal = clientFileRefusal(chosen);
    if (refusal) return toast(refusal, 'error');
    // A file already kept is never replaced without asking.
    if (file && !window.confirm(`Replace the client’s file “${file.name}” with “${chosen.name}”? The one there now is deleted.`)) return;
    await keepClientFile(job.id, chosen, Boolean(file));
    toast(file ? 'The client’s file was replaced' : 'The client’s file is kept with the job');
    bump();
  });
  const [remove, removing] = useAction(async () => {
    if (!window.confirm(`Remove the client’s file “${file.name}” from this job? It is deleted for good.`)) return;
    await api.del(`/jobs/${job.id}/job-description/file`);
    toast('The client’s file was removed');
    bump();
  });
  const choose = () => input.current?.click();
  const picker = <input ref={input} type="file" accept={CLIENT_FILE_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => { take(e.target.files[0]); e.target.value = ''; }} />;
  const drop = info.can_change ? {
    onDragOver: (e) => { if (carriesFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true); } },
    onDragLeave: () => setOver(false),
    onDrop: (e) => { if (!carriesFiles(e)) return; e.preventDefault(); setOver(false); take(e.dataTransfer.files[0]); },
  } : {};
  const who = info.account_executive ? `${info.account_executive} (the account executive) or an admin` : 'an admin';

  return (
    <div className="border-t border-line pt-4" {...drop}>
      <div className="mb-2 text-xs font-medium tracking-wide text-stone-500 uppercase">The client’s own file</div>
      {file ? (
        <>
          <div className={cx('flex items-center gap-3 rounded-xl border border-line px-3 py-2.5', over && 'border-brand-500 bg-brand-50')}>
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700"><FileText className="size-4" /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-stone-900" title={file.name}>{file.name}</span>
              <span className="block text-xs text-stone-500">{size(file.size)} · added on {fmtDate(file.added_at, true)}{file.added_by ? ` by ${file.added_by}` : ''}</span>
            </span>
            <a href={`/api/jobs/${job.id}/job-description/file`} download aria-label={`Download ${file.name}`} title="Download"
              className="rounded-md p-2 text-stone-500 hover:bg-stone-100 hover:text-stone-800"><Download className="size-4" /></a>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-stone-500">It is the client’s own document and names them, so it is not for candidates on a confidential role.</p>
          {info.can_change ? (
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button size="sm" icon={FileUp} busy={busy} onClick={choose}>Replace</Button>
              <Button size="sm" variant="ghost" icon={Trash2} busy={removing} onClick={remove}>Remove</Button>
              {picker}
            </div>
          ) : <p className="mt-2 text-xs text-stone-500">Only {who} can replace or remove it.</p>}
        </>
      ) : info.can_change ? (
        <div className={cx('rounded-xl border border-dashed px-4 py-3 text-sm', over ? 'border-brand-500 bg-brand-50' : 'border-stone-300')}>
          <p className="text-[13px] leading-relaxed text-stone-600">No file from the client is kept. Drop their job description here, or choose it: PDF, Word, RTF or text, up to 8 MB.</p>
          <Button size="sm" className="mt-2.5 w-full" icon={FileUp} busy={busy} onClick={choose}>Choose a file</Button>
          {picker}
        </div>
      ) : (
        <p className="text-[13px] leading-relaxed text-stone-500">No file from the client is kept. {who[0].toUpperCase() + who.slice(1)} can add one.</p>
      )}
    </div>
  );
}

/**
 * Choose what the PDF gives, and download it. Without the client's name, the check the confidential post uses is
 * run on exactly what goes in the file first; what it finds is listed, and the download waits for "Download anyway".
 */
function PdfDialog({ job, info, onClose, onEditJob }) {
  const toast = useToast();
  // Without the client's name is where every PDF starts: the safe choice, one click from the other.
  const [named, setNamed] = useState(info.without ? false : true);
  const payWithout = info.post ? info.post.show_salary : true;
  const [pay, setPay] = useState({ with: true, without: payWithout });
  const showsPay = named ? pay.with : pay.without;
  const [check, setCheck] = useState(null); // what the check found for the current choices
  const [anyway, setAnyway] = useState(false);
  const query = `name=${named ? 'with' : 'without'}&pay=${info.pay_range && showsPay ? 1 : 0}`;

  // Asked again whenever a choice changes. With the client's name nothing is looked for, but the answer still says
  // whether some characters cannot be printed.
  useEffect(() => {
    setAnyway(false);
    let live = true;
    setCheck(null);
    api.get(`/jobs/${job.id}/job-description/check?${query}`)
      .then((answer) => live && setCheck(answer))
      .catch((err) => live && setCheck({ error: err.message, findings: [] }));
    return () => { live = false; };
  }, [query]);

  const findings = check?.findings || [];
  const blocked = !check || Boolean(check.error) || (findings.length > 0 && !anyway);
  const [download, busy] = useAction(async () => {
    const res = await fetch(`/api/jobs/${job.id}/job-description/pdf?${query}${anyway ? '&anyway=1' : ''}`, { credentials: 'same-origin' });
    if (!res.ok) {
      const answer = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
      if (answer?.findings) { setCheck((c) => ({ ...c, findings: answer.findings })); setAnyway(false); }
      throw new Error(answer?.error || 'The PDF could not be made. Please try again.');
    }
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = savedName(res.headers.get('content-disposition'), 'Job description.pdf');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60000);
    toast('PDF downloaded');
    onClose();
  });

  const option = (value, title, detail, disabled) => (
    <label className={cx('flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3', named === value ? 'border-brand-500 bg-brand-50/60' : 'border-line hover:bg-stone-50', disabled && 'cursor-not-allowed opacity-50')}>
      <input type="radio" name="jd-name" className="mt-0.5 size-4 accent-brand-700" checked={named === value} disabled={disabled} onChange={() => setNamed(value)} />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-stone-900">{title}</span>
        <span className="block text-xs leading-relaxed text-stone-500">{detail}</span>
      </span>
    </label>
  );

  return (
    <Modal title="Download the job description" subtitle={`${job.title}, as a PDF`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={Download} busy={busy} disabled={blocked} onClick={download}>Download</Button></>}>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-[13px] font-medium text-stone-700">Does it name the client?</legend>
        {option(false, 'Without the client’s name',
          info.post?.wording ? 'Uses the wording of your confidential post: its title, location and text. The heading says the role is with our client.'
            : 'Uses this job’s own title, location and advert. The heading says the role is with our client.', !info.without)}
        {option(true, `With the client’s name (${job.client_name})`,
          info.with ? 'The job as the careers page shows it, with the client’s name in the heading and the file name.' : 'This job has no advert of its own to use.', !info.with)}
      </fieldset>
      {info.pay_range && (
        <Checkbox label={`Include the pay range (${named || !info.post?.round_salary || !info.post?.wording ? info.pay_range : 'rounded, as your confidential post shows it'})`}
          checked={showsPay} onChange={(e) => setPay((p) => ({ ...p, [named ? 'with' : 'without']: e.target.checked }))} />
      )}
      <p className="text-xs leading-relaxed text-stone-500">
        Never in either PDF: the recruiter brief, the fee, who works on the job, or anything about candidates.
      </p>
      {check?.error && named && <p className="text-[13px] text-red-700">{check.error}</p>}
      {!named && (
        !check ? <p className="text-[13px] text-stone-500">Checking that nothing in it gives the client away…</p>
          : check.error ? <p className="text-[13px] text-red-700">{check.error}</p>
          : findings.length ? (
            <div className="rounded-xl border border-gold-200 bg-gold-50 px-4 py-3 text-[13px] text-gold-900">
              <p className="flex items-start gap-2 font-medium"><AlertTriangle className="mt-0.5 size-4 shrink-0" />This PDF could give the client away.</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 leading-relaxed [overflow-wrap:anywhere]">{findings.map((f, i) => <li key={i}>{f.message}</li>)}</ul>
              <p className="mt-2 leading-relaxed">
                {check.uses_post
                  ? <>Change it in the <Link className="font-medium underline" to={`/jobs/${job.id}?tab=post`} onClick={onClose}>confidential post</Link>, or download it as it is.</>
                  : <>Change the advert {onEditJob ? <button type="button" className="font-medium underline" onClick={() => { onClose(); onEditJob(); }}>(Edit, then Job advert)</button> : '(Edit, then Job advert)'}, or download it as it is.</>}
              </p>
              <div className="mt-2.5"><Checkbox label="Download anyway: I have read what was found" checked={anyway} onChange={(e) => setAnyway(e.target.checked)} /></div>
            </div>
          ) : (
            <p className="text-[13px] text-brand-800">The check found nothing that names the client{check.overruled ? ` (${check.overruled === 1 ? 'one find an admin overruled is' : `${check.overruled} finds an admin overruled are`} left out)` : ''}.</p>
          )
      )}
      {check?.dropped && <p className="text-xs text-stone-500">A few characters (such as emoji) cannot be printed and are left out of the PDF.</p>}
    </Modal>
  );
}
