// Phone numbers: turning what people type into one stored form, and deciding which numbers The Book will ring.
//
// The stored form is E.164: "+", the country code, then the number, digits only ("+16475550199"). It is what the
// phone service wants, and what a caller's number arrives as, so two numbers are the same person's exactly when
// their stored forms are equal.
//
// The second half matters for money. "+1" is not only Canada and the United States: it is also premium-rate lines
// (1-900), a block of Caribbean countries that cost many times more to ring, and special numbers that are nobody's
// phone. A number is only called when it is plainly an ordinary number in a country the workspace allows.

// Canadian area codes. Anything else under +1 that is not on one of the lists below is taken to be the United States.
const CANADA = new Set(('204 226 236 249 250 257 263 289 306 343 354 365 367 368 382 403 416 418 428 431 437 438 450 468 474 506 514 519 ' +
  '548 579 581 584 587 604 613 639 647 672 683 705 709 742 753 778 780 782 807 819 825 867 873 879 902 905 942').split(' '));
// Area codes under +1 that belong to other countries and territories, each priced on its own by the phone service.
const OTHER_PLUS_ONE = {
  242: 'BS', 246: 'BB', 264: 'AI', 268: 'AG', 284: 'VG', 340: 'VI', 345: 'KY', 441: 'BM', 473: 'GD', 649: 'TC', 658: 'JM', 876: 'JM',
  664: 'MS', 670: 'MP', 671: 'GU', 684: 'AS', 721: 'SX', 758: 'LC', 767: 'DM', 784: 'VC', 787: 'PR', 939: 'PR', 809: 'DO', 829: 'DO',
  849: 'DO', 868: 'TT', 869: 'KN',
};
// Area codes that are not a place at all: numbers that follow a person or a machine around (the 5XX block), inbound
// international (456) and the US government's own (710). Nobody's mobile or desk phone is on these.
const NOT_A_PLACE = new Set(('456 710 500 521 522 523 524 525 526 527 528 529 532 533 535 538 542 543 544 545 546 547 549 550 552 553 554 556 ' +
  '558 566 569 577 578 588 589').split(' '));

// Country codes outside +1 that a workspace can allow with PHONE_COUNTRIES. The Book cannot tell an ordinary number
// from a premium-rate one in these countries, so for them it leans on the phone service's own permissions.
const CALLING_CODES = {
  44: 'GB', 353: 'IE', 33: 'FR', 49: 'DE', 31: 'NL', 34: 'ES', 39: 'IT', 351: 'PT', 32: 'BE', 41: 'CH', 43: 'AT', 46: 'SE', 47: 'NO',
  45: 'DK', 358: 'FI', 48: 'PL', 61: 'AU', 64: 'NZ', 91: 'IN', 65: 'SG', 852: 'HK', 81: 'JP', 52: 'MX', 55: 'BR', 27: 'ZA', 971: 'AE',
  972: 'IL', 63: 'PH',
};
export const KNOWN_COUNTRIES = new Set(['CA', 'US', ...Object.values(OTHER_PLUS_ONE), ...Object.values(CALLING_CODES)]);

const NANP = /^[2-9]\d{2}[2-9]\d{6}$/; // ten digits; the area code and the exchange each start 2 to 9

/**
 * A phone number as somebody typed it, in the stored form, or null when it cannot be understood. A number with no
 * country code is read as a Canadian or US one (they are written the same way): ten digits, or eleven starting
 * with 1. Other countries need the country code, as "+44 ..." or "011 44 ...". Nothing is guessed: a number that
 * could be read two ways comes back as null, and the person is asked to type it again.
 */
export function toE164(input) {
  if (typeof input !== 'string' || input.length > 40) return null;
  let s = input.trim().replace(/[\s,;]*(?:ext\.?|x|#)\s*\d+\s*$/i, ''); // an extension cannot be dialled as part of the number
  if (/[a-z]/i.test(s)) return null;                                     // "1-800-FLOWERS", or an "x" with nothing after it
  const plus = s.startsWith('+');
  if ((s.match(/\+/g) || []).length > (plus ? 1 : 0)) return null;      // a plus sign anywhere but the front
  s = s.replace(/\(0\)/g, '').replace(/\D/g, '');                        // "+44 (0)7700 ...": the (0) is not dialled
  if (!s) return null;
  let digits;
  if (plus) digits = s;
  else if (s.startsWith('011')) digits = s.slice(3);                     // how an international number is dialled from Canada and the US
  else if (s.length === 10) digits = `1${s}`;
  else if (s.length === 11 && s.startsWith('1')) digits = s;
  else return null;
  if (!/^[1-9]\d{6,14}$/.test(digits)) return null;
  if (digits.startsWith('1') && !(digits.length === 11 && NANP.test(digits.slice(1)))) return null;
  return `+${digits}`;
}

/**
 * Where a stored number is, as a two-letter country code, or why it cannot be said:
 *   { country: 'CA' }    an ordinary number in that country
 *   { special: true }    a premium-rate, toll-free or other special number: never called
 *   { country: null }    a country The Book does not know
 */
export function placeOf(e164) {
  const digits = String(e164 || '').replace(/^\+/, '');
  if (digits.startsWith('1')) {
    const area = digits.slice(1, 4), exchange = digits.slice(4, 7);
    // 800, 888, 900 and the like: an area code whose last two digits match is never a place. Nor is the 976 exchange.
    if (area[1] === area[2] || NOT_A_PLACE.has(area) || exchange === '976') return { special: true };
    return { country: OTHER_PLUS_ONE[area] ?? (CANADA.has(area) ? 'CA' : 'US') };
  }
  for (const length of [3, 2]) {
    const country = CALLING_CODES[digits.slice(0, length)];
    if (country) return { country };
  }
  return { country: null };
}

/** The countries this workspace may ring, as two-letter codes: Canada and the United States unless PHONE_COUNTRIES says otherwise. */
export const allowedCountries = () => [...new Set((process.env.PHONE_COUNTRIES || '').trim().split(',').map((code) => code.trim().toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code)))]
  .concat((process.env.PHONE_COUNTRIES || '').trim() ? [] : ['CA', 'US']);
/** Is this stored number one The Book would ring: an ordinary number (not premium-rate or special) in an allowed country? */
export function mayRing(e164, countries = allowedCountries()) {
  if (!e164) return false;
  const place = placeOf(e164);
  return !place.special && Boolean(place.country) && countries.includes(place.country);
}

/** For people to read: "+16475550199" becomes "(647) 555-0199". Numbers elsewhere are shown as stored. */
export function displayNumber(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164 || null;
}

/** For a voice to read out one digit at a time: "4 1 6, 5 5 5, 0 1 2 3". */
export function spokenNumber(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  const spaced = (digits) => digits.split('').join(' ');
  return m ? `${spaced(m[1])}, ${spaced(m[2])}, ${spaced(m[3])}` : spaced(String(e164 || '').replace(/\D/g, ''));
}

/** The digits of a number with a +1 number's leading 1 taken off, for finding it among numbers stored as typed. */
export const searchDigits = (e164) => String(e164 || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
