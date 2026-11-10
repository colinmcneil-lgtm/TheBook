// Builds the Google "x-ray" search for a job brief: LinkedIn profiles that match the brief's search string, in the
// place the recruiter is sourcing for. Without a place in the search, Google leans towards wherever the recruiter
// happens to be sitting, which is rarely where the job is.

// Region names that qualify the place before them ("Austin, Texas"; "Leeds, England") rather than naming another place.
const REGIONS = new Set([
  // United States
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa',
  'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
  'new hampshire', 'new jersey', 'new mexico', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina',
  'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'west virginia', 'wisconsin', 'wyoming', 'district of columbia',
  // Canada
  'alberta', 'british columbia', 'manitoba', 'new brunswick', 'newfoundland and labrador', 'nova scotia', 'ontario', 'prince edward island', 'quebec', 'québec', 'saskatchewan',
  // Countries and nations
  'united states', 'united states of america', 'usa', 'canada', 'united kingdom', 'england', 'scotland', 'wales', 'northern ireland', 'ireland', 'australia', 'new zealand',
  'germany', 'france', 'spain', 'italy', 'netherlands', 'india', 'singapore', 'mexico', 'brazil', 'united arab emirates',
]);

// What people type, and how LinkedIn writes that place on a profile. Looked up in lower case.
const ALIASES = {
  sf: ['San Francisco'], 'san fran': ['San Francisco'],
  'bay area': ['San Francisco Bay Area', 'Bay Area'], 'the bay area': ['San Francisco Bay Area', 'Bay Area'], 'sf bay area': ['San Francisco Bay Area', 'Bay Area'],
  'san francisco bay area': ['San Francisco Bay Area', 'Bay Area'], 'silicon valley': ['San Francisco Bay Area', 'Silicon Valley'],
  nyc: ['New York City', 'New York'], 'new york city': ['New York City', 'New York'], ny: ['New York'],
  la: ['Los Angeles'], dc: ['Washington DC', 'District of Columbia'], 'washington dc': ['Washington DC', 'District of Columbia'], 'washington d.c.': ['Washington DC', 'District of Columbia'],
  gta: ['Greater Toronto Area', 'Toronto'], 'greater toronto area': ['Greater Toronto Area', 'Toronto'], 'greater toronto': ['Greater Toronto Area', 'Toronto'],
  'greater vancouver': ['Greater Vancouver', 'Vancouver'], 'greater london': ['Greater London', 'London'], philly: ['Philadelphia'], vegas: ['Las Vegas'],
};
// Words that say where someone may work, not where they are.
const NOT_A_PLACE = /^(remote|remotely|anywhere|hybrid|on-?site|in office|wfh|work from home|tbc|tbd|n\/a|various|multiple)$/i;

/**
 * The places in what was typed, as the phrases to look for: "SF Bay Area or San Jose" gives
 * ["San Francisco Bay Area", "Bay Area", "San Jose"]. Several places are separated by "or", "/", ";", "|", a new
 * line or a comma. A comma followed by a state, province or country ("Austin, Texas", "Toronto, ON") belongs to the
 * place before it: the full name is kept as part of the phrase and an abbreviation is dropped, because profiles
 * spell regions out.
 */
export function locationTerms(typed) {
  const out = [];
  const add = (term) => { const t = term.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim(); if (t && !NOT_A_PLACE.test(t) && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t); };
  for (const chunk of String(typed || '').split(/\s+or\s+|[\n;|/]+/i)) {
    const parts = chunk.split(',').map((p) => p.trim()).filter(Boolean);
    const places = [];
    for (const part of parts) {
      const abbreviation = /^[A-Z]{2,3}\.?$/.test(part) || /^(u\.s\.a?\.?|u\.k\.)$/i.test(part);
      if (places.length && abbreviation) continue; // "Toronto, ON": the city says it
      if (places.length && REGIONS.has(part.toLowerCase())) { places[places.length - 1] += `, ${part}`; continue; }
      places.push(part);
    }
    for (const place of places) {
      const known = ALIASES[place.toLowerCase().replace(/\s+/g, ' ')];
      // "LA" and "DC" are only places when typed as capitals; "la" inside a longer name never reaches here.
      (known && (place.length > 3 || place === place.toUpperCase()) ? known : [place]).forEach(add);
    }
  }
  return out.slice(0, 8);
}

/** The location part of the search: `"Leeds"`, or `("San Francisco Bay Area" OR "Bay Area")`; '' when no place was given. */
export function locationClause(typed) {
  const terms = locationTerms(typed).map((t) => `"${t}"`);
  return terms.length > 1 ? `(${terms.join(' OR ')})` : terms[0] || '';
}

/** A LinkedIn-style boolean string as Google reads one: AND is implied, and NOT is written as a minus sign. Quoted phrases are left alone. */
function forGoogle(search) {
  return String(search || '').split(/("[^"]*")/).map((piece, i, all) => (piece.startsWith('"') ? piece
    // A NOT in front of a word or a bracket, or (at the end of this piece) in front of the quoted phrase that follows.
    : piece.replace(/\s+AND\s+/g, ' ').replace(/\bNOT\s+(?=[(\w])/g, '-').replace(/\bNOT\s+$/, all[i + 1] ? '-' : 'NOT '))).join('').replace(/\s+/g, ' ').trim();
}

/**
 * The whole x-ray search. The place goes first, straight after the site: Google only reads about the first 32 words
 * of a search, and a long list of job titles would otherwise push the place off the end.
 */
export function xraySearch(search, location) {
  return ['site:linkedin.com/in', locationClause(location), forGoogle(search)].filter(Boolean).join(' ');
}

/** The address that runs it. */
export const xrayUrl = (search, location) => `https://www.google.com/search?q=${encodeURIComponent(xraySearch(search, location))}`;
