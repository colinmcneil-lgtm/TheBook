import React, { useEffect, useRef, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { watchForUpdate } from '../lib.js';
import { Button, Card, Loading, UpdateNotice } from '../ui.jsx';

// Shows a candidate's résumé inside the profile. The file itself is never opened as a document on this site
// (it was uploaded by someone anonymous): PDF pages are drawn onto canvases, other formats are shown as plain text.

const MAX_PAGES = 15;

export default function ResumeViewer({ app }) {
  const holder = useRef(null);
  const [state, setState] = useState({ status: 'loading' }); // loading | pdf | text | none | error | updated
  const url = `/api/applications/${app.id}/resume`;
  const name = app.resume_name || 'resume';
  const isPdf = /\.pdf$/i.test(name);

  useEffect(() => {
    let cancelled = false;
    let task = null;
    const updated = watchForUpdate();
    (async () => {
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('The file could not be loaded.');
        const buffer = await res.arrayBuffer();
        if (cancelled) return;

        if (!isPdf) {
          const { extractResumeText } = await import('../resume.js');
          const text = (await extractResumeText(new File([buffer], name))).trim();
          if (!cancelled) setState(text ? { status: 'text', text } : { status: 'none' });
          return;
        }

        const [pdfjs, { default: workerUrl }] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')]);
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        // Glyphs are drawn as shapes (no fonts are installed into the page), and nothing in the file is allowed to run.
        task = pdfjs.getDocument({
          data: buffer, isEvalSupported: false, disableFontFace: true, enableXfa: false,
          standardFontDataUrl: '/pdfjs/standard_fonts/', cMapUrl: '/pdfjs/cmaps/', cMapPacked: true,
        });
        const doc = await task.promise;
        if (cancelled) return;
        const box = holder.current;
        box.replaceChildren();
        const width = Math.max(320, box.clientWidth);
        const ratio = Math.min(2, window.devicePixelRatio || 1);
        const pages = Math.min(doc.numPages, MAX_PAGES);
        setState({ status: 'pdf', pages: doc.numPages });
        for (let n = 1; n <= pages && !cancelled; n++) {
          const page = await doc.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / base.width) * ratio });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = '100%';
          canvas.className = 'block rounded-lg bg-white shadow-sm ring-1 ring-line';
          canvas.setAttribute('role', 'img');
          canvas.setAttribute('aria-label', `Résumé page ${n} of ${doc.numPages}`);
          box.append(canvas);
          await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
        }
      } catch (err) {
        console.warn('The résumé could not be displayed:', err);
        holder.current?.replaceChildren();
        if (cancelled) return;
        if (updated(err)) setState({ status: 'updated' });
        else setState({ status: 'error', message: /password/i.test(`${err?.name} ${err?.message}`) ? 'This PDF is password-protected, so it cannot be shown here.' : 'This file could not be shown here.' });
      }
    })();
    return () => { cancelled = true; task?.destroy?.(); };
  }, [url, name, isPdf]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-sm text-stone-600"><FileText className="size-4 shrink-0" /><span className="truncate">{name}</span></span>
        <a href={url} download><Button size="sm" icon={Download}>Download</Button></a>
      </div>
      {state.status === 'loading' && <Loading />}
      {state.status === 'updated' && <UpdateNotice />}
      {state.status === 'text' && <Card className="p-5"><p className="text-sm leading-relaxed whitespace-pre-wrap text-stone-800">{state.text}</p></Card>}
      {(state.status === 'none' || state.status === 'error') && (
        <Card className="p-5 text-sm text-stone-600">
          {state.status === 'error' ? state.message : 'This type of file cannot be shown here.'} Use Download to open it on your computer.
        </Card>
      )}
      {/* Always in the page (never display:none), so its width can be measured before the first page is drawn. */}
      {isPdf && <div ref={holder} className="space-y-3" />}
      {state.status === 'pdf' && state.pages > MAX_PAGES && <p className="text-center text-[13px] text-stone-500">Showing the first {MAX_PAGES} of {state.pages} pages. Download the file to see the rest.</p>}
    </div>
  );
}
