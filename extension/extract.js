// Runs inside the page the recruiter is looking at, once, when they click the extension. It only reads what is
// already on screen and returns it to the popup; it does not click, scroll, load other pages or send anything anywhere.
(() => {
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const first = (...selectors) => {
    for (const s of selectors) {
      try { const t = text(document.querySelector(s)); if (t) return t; } catch { /* selector not supported */ }
    }
    return '';
  };
  const out = { name: '', title: '', company: '', location: '', email: '', phone: '', url: location.href, site: location.hostname };
  const isLinkedIn = /(^|\.)linkedin\.com$/i.test(location.hostname);

  // 1. Structured data, when the page publishes it (LinkedIn's public profile pages and many personal sites do).
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent);
      const nodes = [].concat(data['@graph'] || data);
      const person = nodes.find((n) => n && [].concat(n['@type']).includes('Person'));
      if (!person) continue;
      out.name ||= String(person.name || '').trim();
      out.title ||= String([].concat(person.jobTitle || [])[0] || '').trim();
      const org = [].concat(person.worksFor || [])[0];
      out.company ||= String((org && (org.name || org)) || '').trim();
      const addr = person.address;
      out.location ||= String((addr && (addr.addressLocality || addr.name)) || '').trim();
      out.email ||= String(person.email || '').replace(/^mailto:/, '').trim();
    } catch { /* not valid JSON */ }
  }

  if (isLinkedIn) {
    // 2. A LinkedIn profile as seen when signed in. LinkedIn changes its markup often, so several fallbacks are tried.
    const main = document.querySelector('main') || document;
    out.name ||= text(main.querySelector('h1'));
    const headline = first('main .text-body-medium.break-words', 'main [data-generated-suggestion-target]', '.top-card-layout__headline', 'main h1 ~ div .text-body-medium');
    out.location ||= first('main .text-body-small.inline.t-black--light.break-words', '.top-card__subline-item', '.top-card-layout__first-subline > span:first-child');
    const current = first('main button[aria-label^="Current company"]', 'main a[aria-label^="Current company"]', '[data-section="currentPositionsDetails"] .top-card-link__description', 'main ul.pv-text-details__right-panel li:first-child');
    out.company ||= current.replace(/^Current company:\s*/i, '');
    if (headline) {
      // "Senior Engineer at Tidewell" or "Senior Engineer @ Tidewell | Speaker"
      const m = /^(.+?)\s+(?:at|@)\s+([^|·•]+)/i.exec(headline);
      out.title ||= (m ? m[1] : headline.split(/\s*[|·•]\s*/)[0]).trim();
      if (m) out.company ||= m[2].trim();
    }
    // The first entry of the Experience section, when it is on screen.
    const exp = document.querySelector('#experience')?.closest('section');
    const role = exp && exp.querySelector('li');
    if (role) {
      const spans = [...role.querySelectorAll('span[aria-hidden="true"]')].map(text).filter(Boolean);
      if (spans[0] && !out.title) out.title = spans[0];
      if (spans[1] && !out.company) out.company = spans[1].split(' · ')[0];
    }
    // /in/<slug> is the stable address of a profile.
    const slug = /^\/(in|pub)\/([^/?#]+)/.exec(location.pathname);
    if (slug) out.url = `https://www.linkedin.com/${slug[1]}/${slug[2]}`;
  } else {
    // 3. Anywhere else: common profile markup (GitHub, personal sites), then the page title.
    out.name ||= first('[itemprop="name"]', '.p-name', '.vcard-fullname', 'h1');
    out.title ||= first('[itemprop="jobTitle"]', '.p-job-title', '.p-note');
    out.company ||= first('[itemprop="worksFor"]', '.p-org');
    out.location ||= first('[itemprop="homeLocation"]', '[itemprop="addressLocality"]', '.p-label', '.p-locality');
    const canonical = document.querySelector('link[rel="canonical"]')?.href;
    if (canonical && /^https?:/.test(canonical)) out.url = canonical;
  }

  if (!out.name) {
    const og = document.querySelector('meta[property="og:title"]')?.content || document.title;
    out.name = og.replace(/^\(\d+\)\s*/, '').split(/\s+[|–—-]\s+/)[0].trim();
  }
  // Contact details that are visible on the page (for example LinkedIn's "Contact info" panel when it is open).
  const mail = document.querySelector('a[href^="mailto:"]');
  if (mail) out.email ||= mail.getAttribute('href').replace(/^mailto:/i, '').split('?')[0].trim();
  const tel = document.querySelector('a[href^="tel:"]');
  if (tel) out.phone ||= tel.getAttribute('href').replace(/^tel:/i, '').trim();
  // Text the recruiter has highlighted is used if it is an email address.
  const picked = String(window.getSelection() || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(picked)) out.email = picked;

  for (const k of Object.keys(out)) out[k] = String(out[k] || '').slice(0, 300);
  return out;
})();
