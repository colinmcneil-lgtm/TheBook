// How a job's facts are written for people: the working pattern, the contract and the pay range, in the words the
// careers page uses (jobMeta in src/pages/Careers.jsx, from WORK_MODES, EMPLOYMENT and salaryRange in src/lib.js).
// The server cannot import the app's files (only server/ is shipped to the host), so they are written out again here.
// test/jobdescription.test.mjs checks that the two give the same words, so a change to one shows up at once.

export const WORK_MODES = { onsite: 'On-site', hybrid: 'Hybrid', remote: 'Remote' };
export const EMPLOYMENT = { full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract' };

export const money = (amount, currency = 'USD') =>
  amount == null ? '' : new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
export const salaryRange = (min, max, currency) =>
  min && max ? `${money(min, currency)} – ${money(max, currency)}` : min ? `From ${money(min, currency)}` : max ? `Up to ${money(max, currency)}` : '';

/** The line under a job's title on the careers page: where, how, what contract and (when given) the pay. */
export const jobMeta = (job, currency) => [job.location, WORK_MODES[job.work_mode], EMPLOYMENT[job.employment_type], salaryRange(job.salary_min, job.salary_max, currency)].filter(Boolean);
