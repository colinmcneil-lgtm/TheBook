// Runs inside the page the recruiter is looking at, once, when they click the extension. It only reads what is
// already on screen and returns it to the popup; it does not click, scroll, load other pages or send anything anywhere.
//
// Name, title, company and location are a convenience: the best reading of the page is good enough, and the recruiter
// can correct them. Email, phone and the profile link decide whose record this becomes in the workspace, so they are
// only taken from the part of the page that is about this person, never from menus, footers, adverts or other
// people's cards. When in doubt they are left empty.
(() => {
  // LinkedIn sometimes draws a profile inside a frame of its own, so the popup runs this in every frame of the tab.
  // A frame only counts when it belongs to the same site as the tab, and which page this is always comes from the
  // tab's own address, not the frame's.
  let page;
  try { page = window.top.location; void page.href; } catch { return null; }
  const framed = window !== window.top;
  const isLinkedIn = /(^|\.)linkedin\.com$/i.test(page.hostname);
  // Anywhere else a frame is somebody else's content (an advert, an embedded widget), not part of the profile.
  if (framed && !isLinkedIn) return null;

  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const first = (...selectors) => {
    for (const s of selectors) {
      try { const t = text(document.querySelector(s)); if (t) return t; } catch { /* selector not supported */ }
    }
    return '';
  };
  const plain = (s) => String(s || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  const isPhone = (s) => /^\+?[\d\s().-]{7,24}$/.test(s) && s.replace(/\D/g, '').length >= 7;
  const address = (a) => decodeURIComponent(a.getAttribute('href').replace(/^(mailto|tel):/i, '').split('?')[0]).trim();
  const distinct = (list) => [...new Set(list.map((v) => v.toLowerCase()))];
  const slugOf = (url) => {
    const m = /(^|\.)linkedin\.com$/i.test(url.hostname) && /^\/in\/([^/]+)/i.exec(url.pathname);
    if (!m) return '';
    try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return m[1].toLowerCase(); }
  };

  // kind: 'profile' (one person's LinkedIn profile), 'seat' (LinkedIn Recruiter or Sales Navigator),
  // 'other' (any other LinkedIn page: the feed, a search, a company) or 'web' (everything else).
  const out = { name: '', title: '', company: '', location: '', email: '', phone: '', url: '', photo: '', site: page.hostname, kind: 'web' };
  const slug = isLinkedIn ? slugOf(page) : '';
  const legacy = isLinkedIn && /^\/pub\/[^/]+/i.test(page.pathname);
  if (isLinkedIn) out.kind = slug.length >= 3 || legacy ? 'profile' : /^\/(talent|sales)(\/|$)/i.test(page.pathname) ? 'seat' : 'other';

  // ---------- structured data ----------
  // A page can publish facts about several people (authors, colleagues, the site owner). Only the entry that is about
  // the page being viewed is used: one that gives this page as its address or, failing that, carries the name in the
  // page's main heading or title.
  const heading = () => plain(text((document.querySelector('main') || document).querySelector('h1')));
  const pointsHere = (value) => {
    let url;
    try { url = new URL(String(value), page.href); } catch { return false; }
    if (slug) return slugOf(url) === slug;
    return url.origin === page.origin && url.pathname.replace(/\/+$/, '') === page.pathname.replace(/\/+$/, '');
  };
  const aboutThisPage = (person) => {
    const links = [person.url, person['@id'], person.mainEntityOfPage, ...[].concat(person.sameAs || [])]
      .map((v) => (v && typeof v === 'object' ? v['@id'] : v)).filter((v) => typeof v === 'string' && v);
    if (links.some(pointsHere)) return true;
    // On LinkedIn an entry that names a different member's profile is about that member, whatever it is called.
    if (slug && links.some((v) => { try { return slugOf(new URL(v, page.href)); } catch { return false; } })) return false;
    const name = plain(person.name);
    return name.length >= 3 && (heading() === name || (!framed && plain(document.title).includes(name)));
  };
  const structured = () => {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent);
        const nodes = [].concat(data).flatMap((n) => [].concat((n && n['@graph']) || n)).filter((n) => n && typeof n === 'object');
        const people = nodes.flatMap((n) => [n, n.mainEntity]).filter((n) => n && [].concat(n['@type']).includes('Person'));
        const person = people.find(aboutThisPage);
        if (!person) continue;
        // LinkedIn masks some values for visitors who are not signed in ("***** at ******").
        const value = (v) => { const s = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : ''; return s.includes('***') ? '' : s; };
        const org = [].concat(person.worksFor || [])[0];
        const addr = person.address;
        return {
          name: value(person.name), title: value([].concat(person.jobTitle || [])[0]), company: value(org && typeof org === 'object' ? org.name : org),
          location: value(addr && typeof addr === 'object' ? addr.addressLocality || addr.name : addr),
          email: value(person.email).replace(/^mailto:/i, ''), phone: value(person.telephone).replace(/^tel:/i, ''),
          photo: value([].concat(person.image || []).map((i) => (i && typeof i === 'object' ? i.contentUrl || i.url : i))[0]),
        };
      } catch { /* not valid JSON */ }
    }
    return {};
  };

  // "Senior Engineer at Tidewell | Speaker" or "Head of Sales @ Varsity Freight". Only the part before the first
  // divider is read, and "at" only counts in front of a capitalised name, so "Great at building teams" stays whole.
  const fromHeadline = (headline) => {
    const lead = headline.split(/\s*[|·•]\s*/)[0].trim();
    const m = /^(.+?)\s+(?:[aA]t\s+(?=[\p{Lu}\d])|@\s*)(.+)$/u.exec(lead);
    return m ? { title: m[1].trim(), company: m[2].trim(), lead } : { lead };
  };

  if (out.kind === 'profile') {
    // A LinkedIn profile. LinkedIn changes its markup often, so several fallbacks are tried.
    out.url = slug.length >= 3 ? `https://www.linkedin.com/in/${/^\/in\/([^/]+)/i.exec(page.pathname)[1].toLowerCase()}`
      // Old /pub/ addresses only work whole, so every part of the path is kept.
      : `https://www.linkedin.com${page.pathname.replace(/\/+$/, '')}`;
    const data = structured();
    const main = document.querySelector('main') || document;
    const h1 = main.querySelector('h1');
    out.name = text(h1) || data.name || '';
    let headline = first('main .text-body-medium.break-words', 'main [data-generated-suggestion-target]', '.top-card-layout__headline', 'main h1 ~ div .text-body-medium');
    out.location = first('main .text-body-small.inline.t-black--light.break-words', '.top-card__subline-item', '.top-card-layout__first-subline > span:first-child') || data.location || '';
    // If LinkedIn's class names have changed and nothing above matched, read the top card by position instead:
    // the headline is the first sentence-like text after the name, and the location is the first "City, Region" after that.
    if (h1 && (!headline || !out.location)) {
      const card = h1.closest('section') || main;
      const noise = /^\(?(he|she|they|ze|xe)\b[^)]{0,20}\)?$|·\s*(1st|2nd|3rd)|contact info|followers|connections|^message$|^connect$|^follow$|^more$|^open to|verified|mutual/i;
      const seen = new Set();
      const texts = [...card.querySelectorAll('div, span, p, li')]
        .filter((el) => (h1.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && !h1.contains(el))
        .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
        .map(text)
        .filter((t) => t && t !== out.name && !noise.test(t) && !seen.has(t) && seen.add(t));
      headline ||= texts.find((t) => t.length >= 6 && t.length <= 220) || '';
      out.location ||= texts.find((t) => t !== headline && t.length <= 80 && /^[\p{L}][\p{L} .'’-]+(,\s*[\p{L}][\p{L} .'’-]+){1,3}$/u.test(t)) || '';
    }

    // Title and company: the current position in the Experience section says it best.
    const exp = document.querySelector('#experience')?.closest('section');
    const role = exp && exp.querySelector('li');
    if (role) {
      const spans = [...role.querySelectorAll('span[aria-hidden="true"]')].map(text).filter(Boolean);
      // "Jan 2019 - Dec 2021": the latest entry has ended, so it is not where the person works now.
      const ended = spans.slice(1, 6).some((s) => /\d{4}\s*[–-]\s*(\p{L}+\.?\s+)?\d{4}\b/u.test(s));
      // Several roles at one employer are grouped: the employer and the time there come first, then each role.
      const inner = role.querySelector('li');
      const grouped = inner && /\b\d+\s*(yrs?|mos?)\b/i.test(spans[1] || '');
      if (!ended && grouped) {
        out.company = spans[0] || '';
        out.title = text(inner.querySelector('span[aria-hidden="true"]'));
      } else if (!ended) {
        out.title = spans[0] || '';
        out.company = (spans[1] || '').split(' · ')[0].trim();
      }
    }
    // Then the "Current company" control in the top card, then what the page publishes about the person.
    const current = first('main button[aria-label^="Current company"]', 'main a[aria-label^="Current company"]', '[data-section="currentPositionsDetails"] .top-card-link__description', 'main ul.pv-text-details__right-panel li:first-child');
    out.company ||= current.replace(/^Current company:\s*/i, '') || data.company || '';
    out.title ||= data.title || '';
    // The headline is free text, so it only fills what is still missing, and its "at …" is only believed when it
    // does not contradict a company found above.
    if (headline && (!out.title || !out.company)) {
      const h = fromHeadline(headline);
      const agrees = h.company && (!out.company || plain(out.company).includes(plain(h.company)) || plain(h.company).includes(plain(out.company)));
      out.title ||= agrees ? h.title : h.lead;
      if (agrees) out.company ||= h.company;
    }

    // No name in a heading: the page's title has it.
    if (!out.name && !framed) {
      const og = document.querySelector('meta[property="og:title"]')?.content || document.title;
      out.name = og.replace(/^\(\d+\)\s*/, '').split(/\s+[|–—-]\s+/)[0].trim();
    }

    // Their photo: the picture in the top card. LinkedIn's own picture addresses say what they are, which keeps out
    // the cover image and company logos. The faces of other members (mutual connections, the recruiter's own picture
    // in the page menu) have the same kind of address, so position and label decide: the person's own picture comes
    // before their name; failing that, it is one labelled with exactly their name. A label that merely contains the
    // name is someone else ("Diana Lima" for "Ana Li"). Without a name in a heading there is nothing to place a
    // picture by, so only one labelled with the name is taken. The grey placeholder is not a photo.
    const mine = /profile-(displayphoto|framedphoto)/i;
    // A picture not yet loaded shows a placeholder and keeps its real address aside.
    const sourceOf = (img) => [img.currentSrc, img.src, img.getAttribute('data-delayed-url')].find((src) => src && mine.test(src)) || '';
    const named = (img) => { const alt = plain(img.alt), name = plain(out.name); return Boolean(name) && (alt === name || alt.startsWith(`${name},`)); };
    const pictures = [...((h1 && h1.closest('section')) || main).querySelectorAll('img')]
      .filter((img) => !img.closest('nav, header, [role="navigation"], [role="banner"]'))
      .map((img) => ({ img, src: sourceOf(img) }))
      .filter((p) => p.src);
    const before = h1 ? pictures.filter((p) => h1.compareDocumentPosition(p.img) & Node.DOCUMENT_POSITION_PRECEDING) : [];
    const picture = before.find((p) => named(p.img)) || before[0] || pictures.find((p) => named(p.img));
    out.photo = (picture && picture.src) || (mine.test(data.photo || '') ? data.photo : '');

    // Contact details only from the person's own "Contact info" panel, when the recruiter has it open.
    const onContactPage = /\/(overlay|detail)\/contact-info/i.test(page.pathname);
    const panel = [...document.querySelectorAll('.pv-contact-info, [role="dialog"], dialog[open], .artdeco-modal')].find((el) =>
      el.matches('.pv-contact-info') || el.querySelector('#pv-contact-info, .pv-contact-info, .pv-contact-info__contact-type')
      || onContactPage || [...el.querySelectorAll('h1, h2')].some((h) => /^contact info$/i.test(text(h))));
    if (panel) {
      out.email = distinct([...panel.querySelectorAll('a[href^="mailto:"]')].map(address).filter(isEmail))[0] || '';
      const tel = panel.querySelector('a[href^="tel:"]');
      const labelled = [...panel.querySelectorAll('section, li')].find((el) => /^(phone|mobile)$/i.test(text(el.querySelector('h3, h2, dt'))));
      const number = tel ? address(tel) : (/\+?\d[\d\s().-]{5,22}\d/.exec(text(labelled).replace(/^(phone|mobile)/i, '')) || [''])[0];
      if (isPhone(number)) out.phone = number;
    }
  } else if (out.kind === 'seat') {
    // Recruiter and Sales Navigator pages have no address that identifies the member, so the link is left for the
    // recruiter to paste. Sales Navigator labels the person's name; nothing else is guessed here.
    out.name = first('h1[data-anonymize="person-name"]', '[data-anonymize="person-name"]');
  } else if (out.kind === 'web') {
    // Anywhere else: what the page publishes about the person, then common profile markup (GitHub, personal sites),
    // then the page title.
    const data = structured();
    out.name = data.name || first('[itemprop="name"]', '.p-name', '.vcard-fullname', 'h1');
    out.title = data.title || first('[itemprop="jobTitle"]', '.p-job-title', '.p-note');
    out.company = data.company || first('[itemprop="worksFor"]', '.p-org');
    out.location = data.location || first('[itemprop="homeLocation"]', '[itemprop="addressLocality"]', '.p-label', '.p-locality');
    if (!out.name) {
      const og = document.querySelector('meta[property="og:title"]')?.content || document.title;
      out.name = og.split(/\s+[|–—-]\s+/)[0].trim();
    }
    // A photo only when the page marks one as the person's (GitHub and personal sites do): a marked portrait in the
    // same card as their name, or labelled with exactly their name. A colleague's card further down has neither.
    const same = (value) => Boolean(out.name) && plain(value) === plain(out.name);
    const cards = [...document.querySelectorAll('[itemprop="name"], .p-name, .vcard-fullname, .fn, h1')].filter((el) => same(text(el)))
      .map((el) => el.closest('.h-card, .vcard, [itemscope]')).filter((card) => card && card !== document.body && card !== document.documentElement);
    const portrait = [...document.querySelectorAll('img[itemprop="image"], img.u-photo, .h-card img.avatar, .vcard img.avatar')]
      .filter((img) => !img.closest('nav, header, footer, aside'))
      .find((img) => cards.some((card) => card.contains(img)) || same(img.alt));
    out.photo = data.photo || (portrait && (portrait.currentSrc || portrait.src)) || '';
    // A page may name its preferred address, but only on its own site: it cannot point at somebody else's profile.
    out.url = page.href;
    try {
      const canonical = new URL(document.querySelector('link[rel="canonical"]').href);
      if (canonical.origin === page.origin) out.url = canonical.href;
    } catch { /* no usable canonical link */ }

    // An address or number is taken when the page marks it as the person's, or when it is the only one in the body of
    // the page. Menus, page headers, footers and sidebars are skipped, and so are shared mailboxes such as info@.
    const furniture = 'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]';
    const body = (selector) => [...document.querySelectorAll(selector)].filter((el) => !el.closest(furniture));
    const shared = /^(info|contact|contactus|hello|hi|enquiries|inquiries|office|admin|support|help|sales|team|mail|jobs|careers|recruitment|hr|press|media|marketing|billing|accounts|no-?reply)@/i;
    const marked = (selector, scheme) => {
      const el = body(selector)[0];
      const link = el && (el.matches('a[href]') ? el : el.querySelector('a[href]'));
      return link && link.getAttribute('href').toLowerCase().startsWith(scheme) ? address(link) : text(el);
    };
    const mails = distinct(body('a[href^="mailto:"]').map(address).filter(isEmail));
    const email = data.email || marked('[itemprop="email"], .u-email', 'mailto:') || (mails.length === 1 ? mails[0] : '');
    if (isEmail(email) && !shared.test(email)) out.email = email;
    const numbers = distinct(body('a[href^="tel:"]').map(address).filter(isPhone));
    const phone = data.phone || marked('[itemprop="telephone"], .p-tel', 'tel:') || (numbers.length === 1 ? numbers[0] : '');
    if (isPhone(phone)) out.phone = phone;
  }

  // Text the recruiter has highlighted is used if it is an email address or a phone number.
  const picked = String(window.getSelection() || '').trim();
  if (isEmail(picked)) out.email = picked;
  else if (isPhone(picked)) out.phone = picked;

  for (const k of ['name', 'title', 'company', 'location', 'email', 'phone']) out[k] = String(out[k] || '').slice(0, 300);
  // A link is never cut short, because a cut link points nowhere and matches nobody: the tracking part goes first,
  // and a link that is still too long is left out.
  if (out.url.length > 300) out.url = out.url.replace(/[?#].*$/, '');
  if (out.url.length > 300) out.url = '';
  // The photo is only an address here; the popup fetches it. Anything that is not a plain https picture address is dropped.
  try {
    const photo = out.photo ? new URL(out.photo, page.href) : null;
    out.photo = photo && photo.protocol === 'https:' && photo.href.length <= 2000 ? photo.href : '';
  } catch { out.photo = ''; }
  return out;
})();
