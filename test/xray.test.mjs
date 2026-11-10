// The Google x-ray search built on a job's brief: which places are looked for, and how the search is put together.
import test from 'node:test';
import assert from 'node:assert/strict';
import { locationTerms, locationClause, xraySearch, xrayUrl } from '../src/xray.js';

test('a place is looked for the way LinkedIn writes it', () => {
  const cases = {
    'San Francisco': ['San Francisco'],
    'SF Bay Area': ['San Francisco Bay Area', 'Bay Area'],
    'bay area': ['San Francisco Bay Area', 'Bay Area'],
    SF: ['San Francisco'],
    NYC: ['New York City', 'New York'],
    GTA: ['Greater Toronto Area', 'Toronto'],
    LA: ['Los Angeles'],
    'Greater Manchester': ['Greater Manchester'],
    ' Leeds ': ['Leeds'],
    '"Austin"': ['Austin'],
  };
  for (const [typed, terms] of Object.entries(cases)) assert.deepEqual(locationTerms(typed), terms, typed);
});

test('several places, however they are separated', () => {
  assert.deepEqual(locationTerms('San Francisco or San Jose'), ['San Francisco', 'San Jose']);
  assert.deepEqual(locationTerms('Toronto, Vancouver'), ['Toronto', 'Vancouver']);
  assert.deepEqual(locationTerms('Toronto / Ottawa; Montreal'), ['Toronto', 'Ottawa', 'Montreal']);
  assert.deepEqual(locationTerms('London\nManchester'), ['London', 'Manchester']);
  assert.deepEqual(locationTerms('SF Bay Area or San Francisco'), ['San Francisco Bay Area', 'Bay Area', 'San Francisco']);
  assert.deepEqual(locationTerms('Portland OR Seattle'), ['Portland', 'Seattle']); // "OR" between places is the word, not Oregon
  assert.equal(locationTerms('a, b, c, d, e, f, g, h, i, j, k').length, 8);
});

test('a state, province or country after a comma belongs to the place before it', () => {
  assert.deepEqual(locationTerms('Toronto, ON'), ['Toronto']);
  assert.deepEqual(locationTerms('San Francisco, CA'), ['San Francisco']);
  assert.deepEqual(locationTerms('Austin, Texas'), ['Austin, Texas']);
  assert.deepEqual(locationTerms('Leeds, England, UK'), ['Leeds, England']);
  assert.deepEqual(locationTerms('Toronto, Ontario, Canada or Ottawa, ON'), ['Toronto, Ontario, Canada', 'Ottawa']);
  assert.deepEqual(locationTerms('Austin, TX, Dallas, TX'), ['Austin', 'Dallas']);
  assert.deepEqual(locationTerms('Ontario'), ['Ontario']); // a region alone is a place to search
});

test('words about how people work are not places', () => {
  for (const typed of ['', '   ', 'Remote', 'remote or hybrid', 'Anywhere', 'TBC']) assert.deepEqual(locationTerms(typed), [], typed);
  assert.deepEqual(locationTerms('Remote or Toronto'), ['Toronto']);
  assert.deepEqual(locationTerms(null), []);
});

test('the place goes straight after the site, so a long list of titles cannot push it out of what Google reads', () => {
  const search = '("Head of Customer Success" OR "VP of Customer Success") AND ("net revenue retention" OR NRR) AND (enterprise OR Strategic)';
  assert.equal(xraySearch(search, 'SF Bay Area'),
    'site:linkedin.com/in ("San Francisco Bay Area" OR "Bay Area") ("Head of Customer Success" OR "VP of Customer Success") ("net revenue retention" OR NRR) (enterprise OR Strategic)');
  assert.equal(xraySearch(search, 'San Francisco'), 'site:linkedin.com/in "San Francisco" ("Head of Customer Success" OR "VP of Customer Success") ("net revenue retention" OR NRR) (enterprise OR Strategic)');
  assert.equal(locationClause('Toronto'), '"Toronto"');
  assert.equal(locationClause(''), '');
});

test('with no place the search is as it was, written the way Google reads it', () => {
  assert.equal(xraySearch('("Head of Sales" OR "Sales Director") AND (logistics OR freight) NOT recruiter', ''),
    'site:linkedin.com/in ("Head of Sales" OR "Sales Director") (logistics OR freight) -recruiter');
  assert.equal(xraySearch('"Sales AND Marketing Manager" NOT "account NOT manager"', ''), 'site:linkedin.com/in "Sales AND Marketing Manager" -"account NOT manager"');
  assert.equal(xraySearch('', 'Leeds'), 'site:linkedin.com/in "Leeds"');
  assert.equal(xraySearch('', ''), 'site:linkedin.com/in');
});

test('the address carries the whole search', () => {
  const url = new URL(xrayUrl('("Head of Sales") AND freight', 'Austin, Texas or Dallas'));
  assert.equal(url.origin + url.pathname, 'https://www.google.com/search');
  assert.equal(url.searchParams.get('q'), 'site:linkedin.com/in ("Austin, Texas" OR "Dallas") ("Head of Sales") freight');
});
