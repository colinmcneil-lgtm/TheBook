import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Copy, ExternalLink, ImageUp, Trash2 } from 'lucide-react';
import { api, copyText, plural } from '../lib.js';
import { useApp, useApi, Pending } from '../state.jsx';
import { Badge, Button, Card, CardHeader, Checkbox, Field, Input, Textarea, useAction, useToast } from '../ui.jsx';

// Settings, Agency, "Our job board": how the agency's public job board looks, and the three ways to get it onto the
// agency's own website. Admins change it; the rest of the team reads it and can copy the link, the snippet and the feed.

const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * What the agency pastes into a page of its own website. The frame shows the board; the script after it does four
 * small things, and listens to nothing but that frame:
 *   - sizes the frame to the board, so the page scrolls as one;
 *   - gives each role an address on the website itself: the page's own address with "?role=" and the post's token
 *     on the end opens that role, and the address in the browser follows the visitor from the list to a role and back;
 *   - brings the board, or its application form, into view when the board asks, clear of a menu fixed to the top;
 *   - if the board has said nothing after eight seconds (the website is not on the list of those that may show it),
 *     puts a plain link to the board in its place, so visitors are never left looking at a blank space.
 */
export const snippetFor = (origin, name) => `<iframe id="job-board-frame" title="Jobs at ${escAttr(name)}" src="${origin}/board?embed=1" style="width:100%;height:700px;border:0"></iframe>
<script>
(function () {
  var frame = document.getElementById('job-board-frame');
  var board = '${origin}/board';
  var link = null, heard = false;
  var role = (/[?&]role=([a-f0-9]{18})(?![a-f0-9])/.exec(location.search) || [])[1];
  if (role) frame.src = board + '/' + role + '?embed=1';
  function bringIntoView(down) {
    var top = frame.getBoundingClientRect().top + window.pageYOffset + down - 100;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
  window.addEventListener('message', function (event) {
    var said = event.data;
    if (event.source !== frame.contentWindow || !said || said.board !== 'the-book') return;
    heard = true;
    if (link) { link.parentNode.removeChild(link); link = null; }
    if (typeof said.height === 'number') frame.style.height = said.height + 'px';
    if (said.top && frame.getBoundingClientRect().top < 100) bringIntoView(0);
    if (typeof said.scrollTo === 'number') bringIntoView(said.scrollTo);
    if ('role' in said && window.URL && history.replaceState) {
      var here = new URL(location.href);
      if (/^[a-f0-9]{18}$/.test(said.role || '')) here.searchParams.set('role', said.role); else here.searchParams.delete('role');
      history.replaceState(history.state, '', here.href);
    }
  });
  setTimeout(function () {
    if (heard) return;
    frame.style.height = '0';
    link = document.createElement('a');
    link.href = role ? board + '/' + role : board;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'See our open roles';
    frame.parentNode.insertBefore(link, frame);
  }, 8000);
})();
</script>`;

function Way({ title, children, value, copied, multiline }) {
  const toast = useToast();
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-stone-900">{title}</h3>
      <p>{children}</p>
      <div className="flex items-start gap-2">
        {multiline
          ? <pre className="max-h-56 min-w-0 flex-1 overflow-auto rounded-lg bg-stone-100 px-3 py-2.5 text-xs leading-relaxed text-stone-800">{value}</pre>
          : <code className="min-w-0 flex-1 truncate rounded-lg bg-stone-100 px-3 py-2.5 text-xs text-stone-800">{value}</code>}
        <Button icon={Copy} onClick={() => copyText(value, toast, copied)}>Copy</Button>
      </div>
    </div>
  );
}

export default function BoardSettings() {
  const { isAdmin, bump } = useApp();
  const toast = useToast();
  const { data, error } = useApi('/board/settings');
  const [form, setForm] = useState(null);
  const picker = useRef(null);
  const saved = data && JSON.stringify([data.name, data.intro, data.color, data.privacy_url, data.sites, data.page_url, data.careers_unlisted]);
  useEffect(() => {
    if (data) setForm({ name: data.name, intro: data.intro, color: data.color, privacy_url: data.privacy_url || '', sites: data.sites.join('\n'), page_url: data.page_url || '', careers_unlisted: data.careers_unlisted });
  }, [saved]);
  // A link such as /settings?tab=agency#board lands on this card, not at the top of the page.
  const { hash } = useLocation();
  const ready = Boolean(data);
  useEffect(() => { if (ready && hash === '#board') document.getElementById('board')?.scrollIntoView({ block: 'start' }); }, [hash, ready]);
  const [save, busy] = useAction(async () => { await api.put('/board/settings', form); toast('Saved'); bump(); });
  const [upload, uploading] = useAction(async (file) => {
    if (!file) return;
    const fd = new FormData();
    fd.append('photo', file);
    await api.put('/board/logo', fd);
    toast('Logo saved');
    bump();
  });
  const [removeLogo] = useAction(async () => { await api.del('/board/logo'); toast('Logo removed'); bump(); });

  if (!data || !form) return <Card id="board"><CardHeader title="Our job board" /><Pending error={error} /></Card>;
  const origin = data.address || window.location.origin;
  const bind = (key) => ({ value: form[key], disabled: !isAdmin, onChange: (e) => setForm((f) => ({ ...f, [key]: e.target.value })) });

  return (
    <Card id="board" className="scroll-mt-4">
      <CardHeader title="Our job board" action={<Badge tone={data.live ? 'green' : 'gray'}>{data.live ? `${plural(data.live, 'post')} public` : 'No posts public'}</Badge>} />
      {data.down > 0 && (
        <p className="mx-4 mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          {plural(data.down, 'post is', 'posts are')} switched on but not public. <Link to="/jobs?view=board" className="font-medium underline">See why</Link>.
        </p>
      )}
      <div className="space-y-5 p-4 text-sm leading-relaxed text-stone-600">
        <p>
          A public page in your agency’s name that lists the jobs you have chosen to advertise yourselves, without saying who the employer is. Each post is written on its job, under <b className="font-medium text-stone-900">Confidential post</b>, and checked for anything that would give the client away before it can go public.
          {' '}<Link to="/jobs?view=board" className="font-medium text-brand-700 hover:underline">See every post</Link>.
        </p>

        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <Field label="Name on the board" hint="Shown at the top of the board, in search results and in the confirmation e-mail applicants get."><Input {...bind('name')} required /></Field>
          <Field label="Introduction" hint="One or two lines under the heading."><Textarea rows={2} maxLength={300} {...bind('intro')} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Colour">
              <span className="flex items-center gap-2">
                <input type="color" {...bind('color')} aria-label="Colour" className="h-9 w-12 cursor-pointer rounded-lg border border-line bg-white p-1" />
                <Input {...bind('color')} pattern="#[0-9a-fA-F]{6}" />
              </span>
            </Field>
            <div>
              <span className="mb-1 block text-[13px] font-medium text-stone-700">Logo</span>
              <span className="flex items-center gap-2">
                {data.logo && <img src={`/api/public/board/logo?v=${data.logo}`} alt="" className="size-9 rounded-lg border border-line bg-white object-contain" />}
                {isAdmin && <Button icon={ImageUp} busy={uploading} onClick={() => picker.current.click()}>{data.logo ? 'Change' : 'Add a logo'}</Button>}
                {isAdmin && data.logo && <Button variant="ghost" icon={Trash2} aria-label="Remove the logo" className="!px-2" onClick={removeLogo} />}
                {!isAdmin && !data.logo && <span className="text-stone-500">None</span>}
                <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { upload(e.target.files[0]); e.target.value = ''; }} />
              </span>
              <span className="mt-1 block text-xs text-stone-500">A square PNG, JPEG or WebP, up to 3 MB.</span>
            </div>
          </div>
          <Field label="Privacy notice link" hint="Your agency’s own candidate privacy notice. It is linked beside the consent box on the board’s application form; a client’s notice is never shown there.">
            <Input {...bind('privacy_url')} placeholder="https://" />
          </Field>
          {!form.privacy_url.trim() && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">There is no privacy notice link yet. Applicants are asked to agree to how you use their details, so give them somewhere to read it.</p>}
          <Field label="Websites that may show the board inside their pages" hint="One on each line, for example otterbrook.ca. The board refuses to appear inside any other website. Every other page of The Book refuses to appear inside any website at all.">
            <Textarea rows={3} {...bind('sites')} spellCheck={false} />
          </Field>
          <Field label="Address of the jobs page on your website" hint="Once the board is showing inside a page of your website (way 2 below), paste that page’s address here. Each role then has an address on your own website, and that is the address given by “Copy link” on a post, in the data feed and to search engines.">
            <Input {...bind('page_url')} placeholder="https://otterbrook.ca/jobs" />
          </Field>
          <Checkbox checked={form.careers_unlisted} disabled={!isAdmin} onChange={(e) => setForm((f) => ({ ...f, careers_unlisted: e.target.checked }))}
            label="Keep clients’ careers pages out of search engines while the board has posts"
            hint="Your board and your clients’ careers pages are at the same web address, so a search of that address would list your clients beside the board. The careers pages still work for anybody who has their link." />
          {isAdmin ? <Button type="submit" variant="primary" busy={busy}>Save</Button> : <p className="text-[13px] text-stone-500">Only an admin can change these.</p>}
        </form>

        <div className="space-y-5 border-t border-line pt-5">
          <div>
            <h3 className="text-sm font-semibold text-stone-900">Put it on your website</h3>
            <p className="mt-1">The board lives at an address of The Book, which your website can link to, show inside one of its pages, or read as data. Choose whichever suits how your website is built.</p>
          </div>
          <Way title="1. Link to it" value={`${origin}/board`} copied="Address copied">
            The board’s own address. Link a “Jobs” or “Careers” item in your website’s menu to it.
            {' '}<a href={`${origin}/board`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">Open the board<ExternalLink className="size-3.5" /></a>
          </Way>
          <Way title="2. Show it inside a page of your website" value={snippetFor(origin, data.name)} copied="Snippet copied" multiline>
            Paste this where the jobs should appear, and the board shows there, sized to fit, with applications made on the spot. In Squarespace use a Code block; in Webflow an Embed element; in WordPress a Custom HTML block. Then paste that page’s address into “Address of the jobs page on your website” above and save: each role gets an address on your own website.
          </Way>
          <div className="rounded-lg bg-stone-50 px-3 py-2.5 text-[13px] leading-relaxed">
            <p className="font-medium text-stone-900">A blank space, or only a link saying “See our open roles”, where the jobs should be?</p>
            <p className="mt-1">The page’s website is not in the list above, so the board refused to show there. Open the page, look at the address bar of your browser, and add the first part of that address (for example www.otterbrook.ca) to the list. Site builders show a page from an address of their own while you are editing it, so look at the published page, not the editor’s preview. Wix always shows pasted code from an address of its own: on Wix, use way 1 instead.</p>
          </div>
          <Way title="3. Read it as data" value={`${origin}/board/feed.json`} copied="Feed address copied">
            For a web developer who wants to draw the list themselves: every public post as plain data (JSON), with the address of each post, where people apply{data.page_url ? ' (on your website’s jobs page)' : ' (on the board)'}.
          </Way>
        </div>
      </div>
    </Card>
  );
}
