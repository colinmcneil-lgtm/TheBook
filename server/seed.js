// Fills an empty database with a demo agency, three fictional clients and a realistic pipeline.
// Run with: npm run seed            (refuses to run if the database already has users)
//           npm run seed -- --reset (wipes everything first)
//           Both refuse to run when NODE_ENV=production unless you also pass --force.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, q, tx, setSetting, createStages, DATA_DIR, UPLOAD_DIR } from './db.js';
import { reportStart } from './reporting.js';

const reset = process.argv.includes('--reset');
if (process.env.NODE_ENV === 'production' && !process.argv.includes('--force')) {
  console.error(`Refusing to load demo data into a production database (${DATA_DIR}). Add --force if you really mean it.`);
  process.exit(1);
}
if (q.get('SELECT 1 AS x FROM users LIMIT 1')) {
  if (!reset) {
    console.log('The database already has data. Use "npm run seed -- --reset" to wipe it and load the demo.');
    process.exit(0);
  }
  console.log(`Wiping ${DATA_DIR} ...`);
  tx(() => {
    for (const t of ['report_events', 'metaview_forgotten', 'metaview_people', 'metaview_calls', 'calls', 'emails', 'offers', 'scorecards', 'interview_panel', 'interviews', 'activities', 'notes', 'stage_history', 'applications', 'candidates', 'stages', 'jobs', 'sessions', 'invites', 'users', 'clients'])
      db.exec(`DELETE FROM ${t}`);
    db.exec(`DELETE FROM settings WHERE key LIKE 'metaview_%'`); // the demo is not connected to Metaview
    db.exec('DELETE FROM sqlite_sequence'); // a wiped database starts numbering from 1 again
  });
  for (const file of fs.readdirSync(UPLOAD_DIR)) fs.rmSync(path.join(UPLOAD_DIR, file), { recursive: true, force: true }); // résumés, photos and call audio of the rows just deleted
  fs.rmSync(path.join(DATA_DIR, 'recordings'), { recursive: true, force: true }); // pieces of recordings that were never finished
}

// Deterministic pseudo-random numbers so the demo looks the same on every run.
let seed = 20261109;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const DAY = 86400000;
const ago = (days, hour = between(8, 18)) => { const d = new Date(Date.now() - days * DAY); d.setHours(hour, between(0, 59), 0, 0); return d.toISOString(); };
const ahead = (days, hour, minute = 0) => { const d = new Date(Date.now() + days * DAY); d.setHours(hour, minute, 0, 0); return d.toISOString(); };
const hash = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`; };

const PASSWORD = 'demo1234';
const user = (email, name, role, clientId, title) =>
  q.insert('INSERT INTO users (email, password_hash, name, role, client_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', email, hash(PASSWORD), name, role, clientId, title, ago(120));

const FIRST = ['Amara', 'Ben', 'Chloe', 'Daniel', 'Elena', 'Farid', 'Grace', 'Hugo', 'Imani', 'Jonas', 'Keiko', 'Liam', 'Mina', 'Noah', 'Olivia', 'Pedro', 'Quinn', 'Rosa', 'Samir', 'Tara', 'Uma', 'Victor', 'Wren', 'Yusuf', 'Zoe', 'Anders', 'Bianca', 'Callum', 'Dara', 'Esme', 'Felix', 'Gia', 'Hana', 'Idris', 'Jude', 'Kira', 'Leo', 'Maya', 'Nico', 'Orla'];
const LAST = ['Adeyemi', 'Bergström', 'Castillo', 'Dunne', 'Eriksen', 'Fontaine', 'Greene', 'Haddad', 'Ivanova', 'Jensen', 'Kaur', 'Lindqvist', 'Moreau', 'Nakamura', 'Okafor', 'Petrov', 'Quigley', 'Rahman', 'Silva', 'Thackeray', 'Ueda', 'Vasquez', 'Whitlock', 'Yilmaz', 'Zamora', 'Ashby', 'Brandt', 'Chowdhury', 'Delacroix', 'Ekwueme'];
const COMPANIES = ['Brightwater', 'Coppermill', 'Ostrava Labs', 'Finchley & Co', 'Halden Systems', 'Juniper Row', 'Marlowe Group', 'Northgate Digital', 'Pellham', 'Quillon', 'Redfern Works', 'Sable Analytics', 'Tidewell', 'Varsity Freight', 'Wexcombe'];
const CITIES = ['London', 'Manchester', 'Bristol', 'Leeds', 'Edinburgh', 'Dublin', 'Birmingham', 'Remote, UK'];
const SOURCES = ['careers_page', 'careers_page', 'careers_page', 'careers_page', 'agency_sourced', 'agency_sourced', 'linkedin', 'linkedin', 'referral', 'job_board'];
// Phone numbers from the range kept for fiction (555-0100 to 555-0199), so nothing in the demo is a real person's
// number. No two candidates share one.
const AREA_CODES = ['416', '647', '437', '905', '289', '613'];
const takenPhones = new Set();
const demoPhone = () => {
  let area = between(100, 999) % AREA_CODES.length, last = between(100000, 999999) % 100;
  while (takenPhones.has(`${AREA_CODES[area]}-${last}`)) { last = (last + 1) % 100; if (!last) area = (area + 1) % AREA_CODES.length; }
  takenPhones.add(`${AREA_CODES[area]}-${last}`);
  return `(${AREA_CODES[area]}) 555-01${String(last).padStart(2, '0')}`;
};
const REJECT_REASONS = ['Not enough relevant experience', 'Salary expectations too far apart', 'Stronger candidates in process', 'Location or right-to-work mismatch', 'Skills not a match for this role'];

tx(() => {
  setSetting('agency_name', 'Harbour Talent Partners');
  const alex = user('alex@harbourtalent.example', 'Alex Morgan', 'admin', null, 'Founder & Talent Partner');
  const priya = user('priya@harbourtalent.example', 'Priya Nair', 'recruiter', null, 'Senior Recruiter');

  const client = (name, slug, color, industry, location, tagline, about, model, retainer, fee, startedDays) =>
    q.insert(
      `INSERT INTO clients (name, slug, brand_color, website, industry, location, tagline, about, engagement_model, monthly_retainer, fee_percent, currency, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'GBP', ?, ?)`,
      name, slug, color, `https://${slug}.example`, industry, location, tagline, about, model, retainer, fee, ago(startedDays).slice(0, 10), ago(startedDays));

  const lumen = client('Lumen Health', 'lumen-health', '#0b6e99', 'Digital health', 'London',
    'Helping clinics run on time, so clinicians can focus on patients.',
    'Lumen Health builds scheduling and patient-flow software used by more than 400 clinics. We are a team of 85 across London and Manchester, backed by leading healthcare investors, and growing our engineering, product and customer teams this year.\n\nWe care about calm, focused work, clear writing and looking after each other.',
    'hybrid', 6500, 12, 160);
  const kestrel = client('Kestrel Logistics', 'kestrel-logistics', '#b45309', 'Logistics', 'Manchester',
    'Same-day freight for the businesses that keep cities moving.',
    'Kestrel runs a same-day delivery network across the North of England. Our depots, drivers and software teams move more than 20,000 parcels a day.\n\nWe hire people who like solving practical problems and take pride in getting the details right.',
    'retainer', 4800, 0, 95);
  const fable = client('Fable & Finch', 'fable-and-finch', '#7c3aed', 'Consumer goods', 'Bristol',
    'Thoughtfully made homeware, delivered to your door.',
    'Fable & Finch designs and sells homeware direct to customers across Europe. We are a small, profitable team that is investing in brand, e-commerce and operations.',
    'per_hire', 0, 18, 40);

  const maya = user('maya@lumenhealth.example', 'Maya Okonkwo', 'client', lumen, 'VP Engineering');
  const tom = user('tom@lumenhealth.example', 'Tom Reilly', 'client', lumen, 'Head of Product');
  const sara = user('sara@lumenhealth.example', 'Sara Lindholm', 'client', lumen, 'Chief Operating Officer');
  const dev = user('dev@kestrel.example', 'Dev Patel', 'client', kestrel, 'Operations Director');
  const ruth = user('ruth@kestrel.example', 'Ruth Calloway', 'client', kestrel, 'Head of Sales');
  const ines = user('ines@fableandfinch.example', 'Inès Garnier', 'client', fable, 'Founder');

  const job = (clientId, title, dept, location, mode, min, max, manager, status, openedDays, stages, criteria, description, profile, questions = []) => {
    const id = q.insert(
      `INSERT INTO jobs (client_id, title, department, location, work_mode, employment_type, salary_min, salary_max, description, ideal_profile, status,
         hiring_manager_id, openings, questions, criteria, created_by, created_at, opened_at)
       VALUES (?, ?, ?, ?, ?, 'full_time', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      clientId, title, dept, location, mode, min, max, description, profile, status, manager,
      JSON.stringify(questions.map((label, i) => ({ id: `q${i + 1}`, label, type: i === 0 ? 'yesno' : 'long', required: i === 0 }))),
      JSON.stringify(criteria), alex, ago(openedDays + 2), status === 'draft' ? null : ago(openedDays));
    createStages(id, stages);
    return id;
  };
  const describe = (intro, doing, need) =>
    `${intro}\n\nWhat you will do\n${doing.map((x) => `• ${x}`).join('\n')}\n\nWhat we are looking for\n${need.map((x) => `• ${x}`).join('\n')}\n\nWhat we offer\n• Competitive salary and equity or bonus\n• 28 days holiday plus bank holidays\n• Flexible working and a generous learning budget`;

  const jobs = [
    { id: job(lumen, 'Senior Backend Engineer', 'Engineering', 'London', 'hybrid', 85000, 105000, maya, 'open', 38,
        ['Recruiter screen', 'Technical interview', 'System design', 'Final interview'], ['Technical depth', 'System design', 'Collaboration', 'Ownership'],
        describe('We are looking for a senior engineer to own the services behind our scheduling engine, which handles millions of appointments a month.',
          ['Design and ship backend services in TypeScript and Postgres', 'Improve reliability and performance of our booking APIs', 'Mentor engineers and raise the bar on code review'],
          ['5+ years building production backend systems', 'Strong SQL and data-modelling skills', 'Experience working closely with product and design']),
        'Someone who has scaled a multi-tenant SaaS backend. Healthcare experience is a plus, not a must. Maya values clear written communication above pedigree.',
        ['Do you have the right to work in the UK?', 'Tell us about a system you designed that you are proud of.']), size: 21, hires: 2, panel: [maya, priya] },
    { id: job(lumen, 'Product Designer', 'Product', 'London', 'hybrid', 60000, 75000, tom, 'open', 24,
        ['Recruiter screen', 'Portfolio review', 'Final interview'], ['Craft', 'Product thinking', 'Communication', 'Research'],
        describe('Join our product team to design the tools that receptionists and clinicians use all day, every day.',
          ['Own design for the clinic calendar from discovery to delivery', 'Run research with clinic staff', 'Contribute to our design system'],
          ['A portfolio showing shipped B2B or workflow-heavy products', 'Comfortable with ambiguity and close collaboration with engineers']),
        'Mid-to-senior designer with real research chops. Tom wants to see process, not only polished screens.',
        ['Do you have the right to work in the UK?', 'Share a link to your portfolio and tell us which project best represents you.']), size: 14, panel: [tom, alex] },
    { id: job(lumen, 'Customer Success Manager', 'Customer', 'Manchester', 'hybrid', 42000, 52000, sara, 'open', 12,
        ['Recruiter screen', 'Hiring manager interview', 'Final interview'], ['Customer empathy', 'Commercial sense', 'Communication', 'Organisation'],
        describe('Look after a portfolio of clinic groups and make sure they get lasting value from Lumen.',
          ['Run onboarding and quarterly reviews', 'Spot expansion opportunities', 'Be the voice of the customer internally'],
          ['3+ years in customer success or account management in SaaS', 'Confident presenting to senior stakeholders']),
        'Healthcare or public-sector accounts experience would stand out.'), size: 9, panel: [sara, priya] },
    { id: job(kestrel, 'Head of Sales', 'Commercial', 'Manchester', 'onsite', 80000, 95000, ruth, 'open', 45,
        ['Recruiter screen', 'Hiring manager interview', 'Case presentation', 'Final interview'], ['Leadership', 'Commercial strategy', 'Deal execution', 'Culture add'],
        describe('Lead and grow our eight-person sales team as we expand into the Midlands.',
          ['Own new-business revenue and forecasting', 'Coach account executives', 'Build partnerships with regional retailers'],
          ['Experience leading a B2B sales team', 'A track record in logistics, freight or a related sector']),
        'Needs logistics credibility. Dev wants a builder who still enjoys closing deals.',
        ['Do you have the right to work in the UK?']), size: 12, panel: [ruth, dev, alex] },
    { id: job(kestrel, 'Depot Operations Lead', 'Operations', 'Leeds', 'onsite', 38000, 45000, dev, 'open', 20,
        ['Recruiter screen', 'Site visit', 'Final interview'], ['People leadership', 'Process discipline', 'Safety', 'Problem solving'],
        describe('Run day-to-day operations at our Leeds depot, leading a team of 25 across two shifts.',
          ['Plan shifts and routes', 'Own safety and service KPIs', 'Coach team leaders'],
          ['Experience managing a warehouse or depot team', 'Comfortable with early starts and a hands-on role']),
        'Internal step-up candidates welcome.'), size: 10, panel: [dev, priya] },
    { id: job(kestrel, 'Data Analyst', 'Technology', 'Manchester', 'hybrid', 40000, 50000, dev, 'paused', 60,
        ['Recruiter screen', 'Technical interview', 'Final interview'], ['SQL and analysis', 'Storytelling with data', 'Stakeholder management'],
        describe('Help us understand route efficiency and customer demand.', ['Build dashboards', 'Answer commercial and operational questions with data'], ['Strong SQL', 'Clear communication']),
        'Paused until the Q1 budget is confirmed.'), size: 5, panel: [dev] },
    { id: job(fable, 'E-commerce Manager', 'Growth', 'Bristol', 'hybrid', 48000, 58000, ines, 'open', 15,
        ['Recruiter screen', 'Founder interview', 'Final interview'], ['Commercial sense', 'Analytical skill', 'Brand feel', 'Ownership'],
        describe('Own our online store end to end, from merchandising to conversion.',
          ['Plan the trading calendar', 'Run site experiments', 'Work with brand and operations on launches'],
          ['Experience running a Shopify store at scale', 'Comfortable with numbers and with creative work']),
        'First e-commerce hire. Inès wants a doer with taste.'), size: 11, panel: [ines, alex] },
    { id: job(fable, 'Operations Coordinator', 'Operations', 'Bristol', 'onsite', 28000, 32000, ines, 'draft', 0,
        ['Recruiter screen', 'Founder interview'], ['Organisation', 'Communication', 'Initiative'],
        describe('Keep orders, suppliers and customer queries running smoothly.', ['Coordinate suppliers', 'Manage stock records'], ['Highly organised', 'Great written English']),
        'Draft: waiting for Inès to confirm the salary band.'), size: 0, panel: [ines] },
    { id: job(kestrel, 'Finance Manager', 'Finance', 'Manchester', 'hybrid', 55000, 65000, dev, 'closed', 88,
        ['Recruiter screen', 'Hiring manager interview', 'Final interview'], ['Technical accounting', 'Commercial partnering', 'Communication'],
        describe('Own month-end, forecasting and commercial finance for a fast-growing logistics business.', ['Run month-end close', 'Partner with depot managers on budgets'], ['Qualified accountant (ACA, ACCA or CIMA)', 'Experience in a multi-site business']),
        'Filled. Closed after the hire started.'), size: 8, hires: 1, closedSpan: 50, panel: [dev, alex] },
  ];
  q.run('UPDATE jobs SET openings = 3 WHERE id = ?', jobs[0].id);

  // Recruiter briefs: what the team sourcing each role needs to know.
  const brief = (jobId, data) => q.run('UPDATE jobs SET brief = ? WHERE id = ?', JSON.stringify(data), jobId);
  brief(jobs[0].id, {
    about: 'Lumen is splitting its scheduling engine out of the monolith and needs a senior engineer to own the booking services end to end. The team is six engineers plus a product manager, reporting to Maya (VP Engineering). Two of the three openings are growth hires; one replaces a leaver.',
    must_haves: ['5+ years building and running production backend services', 'Strong Postgres: has designed schemas and fixed slow queries under load', 'TypeScript or another typed backend language (Go, Kotlin, C#) with willingness to work in TypeScript', 'Has owned a service through an on-call rotation', 'Right to work in the UK without sponsorship'],
    nice_to_haves: ['Multi-tenant SaaS at scale', 'Healthcare, booking or scheduling domain', 'Has mentored mid-level engineers'],
    not_a_fit: ['Pure front-end or mobile backgrounds', 'Contractors looking for day rates', 'Fully remote outside the UK'],
    target_companies: ['Brightwater', 'Northgate Digital', 'Halden Systems', 'Sable Analytics', 'Tidewell', 'Quillon'],
    where_to_look: ['LinkedIn: backend engineers at the target companies with 4 to 8 years in post', 'GitHub: contributors to Postgres tooling and TypeScript server frameworks', 'Speakers and attendees from London backend and Postgres meetups', 'Maya’s former colleagues at Northgate Digital (ask her for introductions)'],
    locations: 'London office two days a week (Tuesday and Thursday). Commutable from most of the South East. Manchester office is an option for the right person.',
    search_titles: ['Senior Backend Engineer', 'Senior Software Engineer', 'Staff Engineer', 'Lead Backend Developer'],
    search_keywords: ['TypeScript', 'Node.js', 'PostgreSQL', 'distributed systems', 'SaaS'],
    pay_notes: 'Share options (0.05% to 0.1%), 10% pension match, private health, £1,500 learning budget.',
    pay_flex: 'Maya will go to £110k for someone who can lead the scheduling rewrite. No sign-on bonus.',
    selling_points: ['Own a system handling millions of appointments a month', 'Series B closed in the spring: three years of runway', 'Small team, no agile theatre, real say in architecture', 'Maya is a strong, hands-on engineering leader with low attrition'],
    screening_questions: ['Tell me about the last production incident you led the response to.', 'What is the largest table you have worked with, and what did you do when queries slowed down?', 'What are you earning now, and what would make you move?', 'What is your notice period?'],
    process_notes: 'Send profiles in batches of three with a short write-up. Maya replies within 48 hours. Technical interview is a paired exercise, not a take-home.',
  });
  brief(jobs[3].id, {
    about: 'Kestrel is expanding into the Midlands and needs a sales leader who can keep closing while building the team from eight to fifteen. Reports to Ruth; works closely with Dev on depot capacity.',
    must_haves: ['Has led a B2B sales team of five or more', 'Track record in logistics, freight or parcel delivery', 'Still carries a personal number and enjoys it', 'Based within an hour of Manchester'],
    nice_to_haves: ['Has opened a new region from scratch', 'Experience selling to regional retailers'],
    not_a_fit: ['Enterprise software sellers with no operational background', 'Account managers who have not won new business recently'],
    target_companies: ['Varsity Freight', 'Redfern Works', 'Coppermill', 'Pellham'],
    where_to_look: ['LinkedIn: regional sales managers ready to step up', 'Trade press “movers” columns', 'Referrals from Kestrel’s account executives'],
    search_titles: ['Head of Sales', 'Sales Director', 'Regional Sales Manager', 'Commercial Director'],
    search_keywords: ['logistics', 'freight', 'same-day', 'B2B', 'new business'],
    search_string: '("Head of Sales" OR "Sales Director" OR "Regional Sales Manager") AND (logistics OR freight OR courier) AND (Manchester OR "North West")',
    pay_notes: '30% bonus on target, car allowance £6k, private health.',
    pay_flex: 'Base could reach £100k with a lower bonus. Guaranteed first-quarter bonus is possible.',
    selling_points: ['Profitable, family-owned, growing 30% a year', 'A new region to build with a real budget', 'Direct line to the owners'],
    screening_questions: ['What was your team’s number last year and what did you personally close?', 'How would you approach your first 90 days in the Midlands?'],
    process_notes: 'Case presentation is to Ruth and Dev together. They want to see a 90-day plan.',
  });
  for (const j of jobs.filter((x, i) => ![0, 3].includes(i) && x.size > 0)) {
    const meta = q.get('SELECT title, department, location FROM jobs WHERE id = ?', j.id);
    brief(j.id, {
      must_haves: [`3+ years in a comparable ${meta.department.toLowerCase()} role`, 'Clear, structured communicator', `Able to be in ${meta.location} as the role requires`],
      nice_to_haves: ['Experience in a company of a similar size and stage'],
      search_titles: [meta.title, meta.title.replace(/^(Senior|Lead|Head of) /, '')].filter((t, i, a) => a.indexOf(t) === i),
      search_keywords: [meta.department, meta.location],
      selling_points: ['Growing team with a hiring manager who moves quickly'],
    });
  }

  const usedNames = new Set();
  const person = () => {
    let name;
    do name = `${pick(FIRST)} ${pick(LAST)}`; while (usedNames.has(name));
    usedNames.add(name);
    return name;
  };
  const act = (appId, userId, type, detail, at) => q.run('INSERT INTO activities (application_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)', appId, userId, type, detail, at);
  const RECS = ['strong_yes', 'yes', 'yes', 'yes', 'no', 'no', 'strong_no'];
  const REC_LABEL = { strong_yes: 'Strong yes', yes: 'Yes', no: 'No', strong_no: 'Strong no' };
  const SCORE_NOTES = {
    strong_yes: 'Excellent conversation. Clear thinker, specific examples and real depth. I would hire.',
    yes: 'Solid across the board with good examples. A couple of areas to probe at the next stage.',
    no: 'Likeable, but answers stayed high level and I did not see enough evidence for this level.',
    strong_no: 'Not a match for this role. Significant gaps against what we need.',
  };
  let upcomingSlot = 0;

  for (const j of jobs) {
    if (j.closedSpan) q.run('UPDATE jobs SET closed_at = ? WHERE id = ?', ago(88 - j.closedSpan), j.id);
    const stages = q.all('SELECT * FROM stages WHERE job_id = ? ORDER BY position', j.id);
    const meta = q.get('SELECT * FROM jobs WHERE id = ?', j.id);
    const criteria = JSON.parse(meta.criteria);
    const openedDays = Math.max(1, Math.round((Date.now() - new Date(meta.opened_at || Date.now()).getTime()) / DAY));
    const hiredStage = stages.length - 1;

    for (let n = 0; n < j.size; n++) {
      const name = person();
      const email = `${name.toLowerCase().normalize('NFKD').replace(/[^a-z ]/g, '').replace(/ /g, '.')}@mail.example`;
      const source = pick(SOURCES);
      const span = j.closedSpan || openedDays;
      const appliedDays = Math.max(0.2, openedDays - rnd() * span * (j.closedSpan ? 0.4 : 0.95));
      const title = `${pick(['Senior ', '', '', 'Lead ', ''])}${meta.title.replace(/^(Senior|Head of|Lead) /, '')}`.replace(/^Sales$/, 'Sales Manager');
      const candId = q.insert(
        'INSERT INTO candidates (client_id, name, email, phone, linkedin, location, current_title, current_company, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        meta.client_id, name, email, demoPhone(), `https://www.linkedin.com/in/${email.split('@')[0].replace(/\./g, '-')}`,
        pick(CITIES), title, pick(COMPANIES), ago(appliedDays));

      // How far this candidate got. The first few per job go deep so every stage has someone in it.
      let depth;
      if (n < (j.hires || 0)) depth = hiredStage;                               // completed hires
      else if (n === (j.hires || 0) && meta.status === 'open') depth = hiredStage - 1; // one live offer
      else if (n <= hiredStage - 2) depth = n;
      else depth = rnd() < 0.5 ? 0 : between(1, hiredStage - 2);
      if (appliedDays < 3) depth = Math.min(depth, 1);
      const rejected = depth < hiredStage && (j.closedSpan ? true : depth < hiredStage - 1 && rnd() < (depth === 0 ? 0.3 : 0.35) && appliedDays > 4);
      const status = depth === hiredStage ? 'hired' : rejected ? 'rejected' : 'active';

      const stepDays = (j.closedSpan ? appliedDays - (openedDays - j.closedSpan) : appliedDays) / (depth + 1.3);
      const enteredAt = (i) => ago(appliedDays - stepDays * i);
      const appliedAt = enteredAt(0);
      const answers = JSON.parse(meta.questions).map((qn, i) => ({ question: qn.label, answer: i === 0 ? 'Yes' : 'Happy to walk through this in detail. In short: I led the work end to end, from the first proposal through to rollout, and it is still in production today.' }));
      const appId = q.insert(
        `INSERT INTO applications (candidate_id, job_id, stage_id, status, source, rating, answers, cover_note, reject_reason, applied_at, stage_entered_at, updated_at, hired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        candId, j.id, stages[depth].id, status, source, depth > 0 ? between(3, 5) : null, JSON.stringify(answers),
        source === 'careers_page' ? `I have followed ${meta.title.includes('Sales') ? 'the company' : 'your product'} for a while and this role is a close match for what I have been doing at ${pick(COMPANIES)}. I would love to talk.` : null,
        rejected ? pick(REJECT_REASONS) : null, appliedAt, enteredAt(depth), enteredAt(depth), status === 'hired' ? enteredAt(depth) : null);

      // Sourced candidates belong to whoever added them; applicants are picked up by a recruiter once they move forward.
      const owner = source !== 'careers_page' ? priya : depth > 0 ? (n % 3 === 0 ? alex : priya) : null;
      if (owner) q.run('UPDATE applications SET owner_id = ? WHERE id = ?', owner, appId);
      act(appId, source === 'careers_page' ? null : priya, source === 'careers_page' ? 'applied' : 'added',
        source === 'careers_page' ? 'Applied via careers page' : 'Added to the pipeline', appliedAt);
      for (let i = 0; i <= depth; i++) {
        q.run('INSERT INTO stage_history (application_id, stage_id, entered_at) VALUES (?, ?, ?)', appId, stages[i].id, enteredAt(i));
        if (i > 0) act(appId, pick([alex, priya]), i === hiredStage ? 'hired' : stages[i].kind === 'offer' ? 'stage_offer' : 'stage_interview', i === hiredStage ? 'Marked as hired' : `Moved to ${stages[i].name}`, enteredAt(i));
      }
      if (rejected) act(appId, priya, 'rejected', `Rejected: ${q.get('SELECT reject_reason r FROM applications WHERE id = ?', appId).r}`, enteredAt(depth + 0.5));

      // Interviews: one completed interview per interview stage already passed, plus upcoming ones for some active candidates.
      for (let i = 1; i <= Math.min(depth, hiredStage - 2); i++) {
        const passed = i < depth || rejected || status === 'hired' || Boolean(j.closedSpan);
        const isCurrent = i === depth && !passed;
        if (isCurrent && rnd() < 0.3) continue; // nothing booked yet
        const upcoming = isCurrent && rnd() < 0.75;
        const startsAt = upcoming ? ahead(1 + (upcomingSlot % 9), 9 + (upcomingSlot++ % 4) * 2, pick([0, 30])) : ago(Math.max(0.3, appliedDays - stepDays * (i + 0.6)), between(9, 16));
        const kind = /technical|design|portfolio|case/i.test(stages[i].name) ? 'technical' : /screen/i.test(stages[i].name) ? 'phone' : /site|final/i.test(stages[i].name) ? 'onsite' : 'video';
        const panel = /screen/i.test(stages[i].name) ? [priya] : j.panel.slice(0, 2);
        const iid = q.insert(
          `INSERT INTO interviews (application_id, title, kind, starts_at, duration_min, location, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          appId, stages[i].name, kind, startsAt, kind === 'phone' ? 30 : 60,
          kind === 'onsite' ? 'Client office, reception on arrival' : kind === 'phone' ? 'Recruiter will call the candidate' : 'https://meet.example/embed-room',
          upcoming ? 'scheduled' : 'completed', priya, enteredAt(i));
        act(appId, priya, 'interview_booked', `Scheduled ${stages[i].name}`, enteredAt(i));
        for (const uid of panel) {
          q.run('INSERT INTO interview_panel (interview_id, user_id) VALUES (?, ?)', iid, uid);
          if (upcoming) continue;
          if (isCurrent && uid !== priya && rnd() < 0.6) continue; // feedback still owed by the hiring team
          const rec = passed && !(rejected && i === depth) ? pick(['strong_yes', 'yes', 'yes']) : rejected ? pick(['no', 'no', 'strong_no']) : pick(RECS);
          const ratings = Object.fromEntries(criteria.map((c) => [c, rec === 'strong_yes' ? between(3, 4) : rec === 'yes' ? between(2, 4) : between(1, 3)]));
          q.run('INSERT INTO scorecards (interview_id, user_id, recommendation, ratings, notes, submitted_at) VALUES (?, ?, ?, ?, ?, ?)',
            iid, uid, rec, JSON.stringify(ratings), SCORE_NOTES[rec], startsAt);
          act(appId, uid, 'scorecard', `Submitted a scorecard for ${stages[i].name}: ${REC_LABEL[rec]}`, startsAt);
        }
      }

      // Recruiter hand-off to the hiring team.
      if (depth >= 1 && source !== 'careers_page' || depth >= 2) {
        const pending = depth === 1 && status === 'active' && rnd() < 0.6;
        if (status === 'rejected' && depth === 1 && rnd() < 0.5) continue;
        q.run(`UPDATE applications SET review_status = ?, submission_note = ?, submitted_by = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?`,
          pending ? 'pending' : 'approved',
          `${name.split(' ')[0]} is currently ${title} at ${pick(COMPANIES)}. Strong on the core of this brief, well regarded by former colleagues, and realistic on salary. Notice period is one month. Worth meeting.`,
          owner ?? priya, pending ? null : 'Agreed, keen to meet.', pending ? null : j.panel[0], pending ? null : enteredAt(1.5), appId);
        act(appId, owner ?? priya, 'submitted', 'Submitted to the hiring team for review', enteredAt(1.2));
        if (!pending) act(appId, j.panel[0], 'review', 'Approved for interview', enteredAt(1.5));
      }

      if (depth >= 2 && rnd() < 0.7) {
        q.run('INSERT INTO notes (application_id, user_id, body, private, created_at) VALUES (?, ?, ?, ?, ?)', appId, priya,
          pick(['Spoke this morning. Engaged, well prepared and asked sharp questions about the team. Salary expectations are within band.',
            'Has another process at second stage elsewhere, so we should keep momentum this week.',
            'Reference from a former manager was glowing. Described as the person the team goes to when things get hard.']), rnd() < 0.4 ? 1 : 0, enteredAt(depth - 0.4));
      }
      if (depth >= hiredStage - 1) {
        const salary = Math.round((meta.salary_min + (meta.salary_max - meta.salary_min) * (0.4 + rnd() * 0.5)) / 500) * 500;
        const st = status === 'hired' ? 'accepted' : 'sent';
        q.run('INSERT INTO offers (application_id, salary, start_date, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          appId, salary, ahead(status === 'hired' ? 12 : 30, 9).slice(0, 10), st, 'Includes standard benefits package.', enteredAt(hiredStage - 1), enteredAt(hiredStage - 1));
        act(appId, alex, 'offer', `Offer ${st}`, enteredAt(hiredStage - 1));
      }
    }
  }

  // Reporting. A real workspace counts from 16 November 2026 and records nothing earlier. So that the demo's
  // Individual and Clients reports have something in them, the demo alone counts from a Monday about five months
  // back, and the moments those reports count are written down here for the history made above, as the server
  // would have recorded them had it been running then: each search's kickoff, each first submission, the first
  // interview with the client that followed it, and each hire with its fee.
  const monday = new Date(Date.now() - 150 * DAY);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  setSetting('reports_start', monday.toISOString().slice(0, 10));
  const counted = reportStart();
  // The demo behaves as if The Book had been installed, and counting had begun, on that Monday. Without these two
  // the page would say, truthfully for a real workspace, that nothing was written down before today.
  setSetting('reports_first_run', counted.at);
  setSetting('reports_began', counted.at);
  q.run(`UPDATE offers SET accepted_at = created_at WHERE status = 'accepted'`);
  for (const j of q.all('SELECT id, client_id, opened_at FROM jobs WHERE opened_at >= ?', counted.at)) {
    q.run(`INSERT INTO report_events (kind, job_id, client_id, at) VALUES ('search_opened', ?, ?, ?)`, j.id, j.client_id, j.opened_at);
  }
  const moment = (kind, a, userId, at) => q.run(
    'INSERT INTO report_events (kind, application_id, candidate_name, job_id, client_id, user_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)', kind, a.id, a.name, a.job_id, a.client_id, userId, at);
  const history = q.all(
    `SELECT a.id, a.job_id, a.status, a.review_status, a.submitted_by, a.owner_id, a.hired_at, c.name, j.client_id, cl.fee_percent, cl.currency
     FROM applications a JOIN candidates c ON c.id = a.candidate_id JOIN jobs j ON j.id = a.job_id JOIN clients cl ON cl.id = j.client_id ORDER BY a.id`);
  for (const a of history) {
    const sent = a.review_status ? q.get(`SELECT created_at AS at FROM activities WHERE application_id = ? AND type = 'submitted' ORDER BY id LIMIT 1`, a.id)?.at : null;
    if (sent && sent >= counted.at) {
      moment('submission', a, a.submitted_by, sent);
      // Their first interview with the client: already in such a stage when they were submitted, or else whichever
      // came first afterwards, a move into one or an interview booked for them.
      const withClient = (when, after) => q.get(
        `SELECT h.entered_at AS at FROM stage_history h JOIN stages s ON s.id = h.stage_id
         WHERE h.application_id = ? AND s.kind = 'interview' AND s.with_client = 1 AND h.entered_at ${after ? '>' : '<='} ? ORDER BY h.entered_at LIMIT 1`, a.id, when)?.at;
      const booked = q.get('SELECT MIN(created_at) AS at FROM interviews WHERE application_id = ? AND created_at > ?', a.id, sent).at;
      const met = withClient(sent, false) ? sent : [withClient(sent, true), booked].filter(Boolean).sort()[0];
      if (met) moment('first_interview', a, a.submitted_by, met);
    }
    if (a.status === 'hired' && a.hired_at >= counted.at) {
      const offer = q.get('SELECT salary, accepted_at FROM offers WHERE application_id = ?', a.id);
      const fee = offer?.salary != null && a.fee_percent > 0 ? Math.round((offer.salary * a.fee_percent) / 100) : null;
      q.run(
        `INSERT INTO report_events (kind, application_id, candidate_name, job_id, client_id, user_id, at, filled_at, salary, fee_percent, fee, currency)
         VALUES ('placement', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id, a.name, a.job_id, a.client_id, a.owner_id ?? a.submitted_by, a.hired_at, offer?.accepted_at && offer.accepted_at <= a.hired_at ? offer.accepted_at : a.hired_at,
        offer?.salary ?? null, a.fee_percent, fee, a.currency);
    }
  }

  // Otterview: three calls Priya recorded, so the page has something on it. The demo holds their transcripts and
  // notes but no audio. Two are on a candidate; the third has not been added to anyone yet.
  const CONSENT = 'I have told everyone on this call that it is being recorded and transcribed, and they have agreed.';
  /** Give each turn a start and end, at an ordinary speaking pace with a short pause between speakers. */
  const timed = (lines) => {
    let at = 1.2;
    return lines.map(([speaker, text]) => {
      const start = Math.round(at * 10) / 10;
      at += text.split(' ').length / 2.6;
      const end = Math.round(at * 10) / 10;
      at += 0.9;
      return { speaker, start, end, text };
    });
  };
  const demoCall = ({ title, days, app, turns, source = 'deepgram', speakers, notes, submission = null }) => {
    const at = ago(days, 11);
    const length = Math.round((turns.at(-1).end + 2) * 1000);
    q.run(
      `INSERT INTO calls (recording_id, title, status, source, duration_ms, transcript, transcript_source, speakers, notes, notes_at, submission, submission_at,
         application_id, candidate_id, consent_by, consent_at, consent_wording, created_by, created_at, updated_at)
       VALUES (?, ?, 'ready', 'recorded', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomBytes(16).toString('hex'), title, length, JSON.stringify(turns), source, JSON.stringify(speakers), notes, at, submission, submission ? at : null,
      app?.id ?? null, app?.candidate_id ?? null, priya, at, CONSENT, priya, at, at);
    if (app) act(app.id, priya, 'call', `Call recorded, ${Math.max(1, Math.round(length / 60000))} min`, at);
  };
  /** Someone at interview stage in a job who has not been put to the hiring team yet, to hang a call on. */
  const interviewing = (jobId) => q.get(
    `SELECT a.id, a.candidate_id, c.name, c.current_company FROM applications a JOIN candidates c ON c.id = a.candidate_id JOIN stages s ON s.id = a.stage_id
     WHERE a.job_id = ? ORDER BY a.status = 'active' DESC, s.kind = 'interview' DESC, a.review_status IS NULL DESC, a.id LIMIT 1`, jobId);

  const seller = interviewing(jobs[3].id);
  if (seller) {
    const first = seller.name.split(' ')[0];
    demoCall({
      title: `Call with ${seller.name}`, days: 2, app: seller, speakers: { 0: 'Priya Nair', 1: seller.name },
      turns: timed([
        [0, `Thanks for making the time, ${first}. Before I tell you more about Kestrel, could you walk me through what you are doing at ${seller.current_company} at the moment?`],
        [1, 'Of course. I run the regional sales team here, eight account executives across the North West. We sell same-day and next-day freight to retailers and manufacturers. Last year the team closed 3.1 million in new business against a target of 2.8, and I personally brought in about 600,000 of that.'],
        [0, 'So you still carry a number yourself?'],
        [1, 'I do, and I would not want to give that up. I like being in front of customers.'],
        [0, 'What is making you open to a move?'],
        [1, 'Honestly, there is no bigger job for me here. The sales director is not going anywhere, and the company is not opening new regions. I want to build something.'],
        [0, 'That fits. Kestrel is expanding into the Midlands and wants someone to grow the team from eight to fifteen. Have you opened a region before?'],
        [1, 'Not from nothing. I took over Leeds when it was two people and grew it to five, so I have hired and trained, but I have not started with a blank map.'],
        [0, 'Understood. What are you on now, and what would you need to move?'],
        [1, 'I am on 78,000 base with a 20 percent bonus. I would be looking for around 90,000 base, and I care more about the bonus being realistic than about the headline.'],
        [0, 'And notice?'],
        [1, 'Three months, although I think they would let me go after two.'],
        [0, 'Are you talking to anyone else?'],
        [1, 'I have had a first conversation with one other logistics firm, nothing further yet.'],
        [0, 'Good to know. I will send you the job description today and put you forward to Ruth at Kestrel this week. If she wants to meet, the next step is a video call with her.'],
        [1, 'That sounds good. Thank you.'],
      ]),
      notes: [
        `${first} runs an eight-person regional sales team at ${seller.current_company} and still carries a personal number. They are open to a move because there is no bigger role where they are. To be put forward to Ruth this week.`,
        `Background and current role\n- Runs the regional sales team at ${seller.current_company}: eight account executives across the North West.\n- Sells same-day and next-day freight to retailers and manufacturers.`,
        'Why they are looking\n- No bigger job where they are: the sales director is staying and the company is not opening new regions.\n- Wants to build something.',
        'Relevant experience for this role\n- The team closed 3.1 million in new business last year against a target of 2.8.\n- Personally brought in about 600,000 of that, and wants to keep carrying a number.\n- Took over Leeds when it was two people and grew it to five; has hired and trained.',
        'Pay (current and expected)\n- On 78,000 base with a 20 percent bonus.\n- Looking for around 90,000 base; cares more about a realistic bonus than the headline.',
        'Notice period and availability\n- Three months, but thinks they would be let go after two.',
        'Other processes and offers\n- A first conversation with one other logistics firm; nothing further yet.',
        'Concerns to probe\n- Has not opened a region from nothing: Leeds already had two people.',
        'Next steps\n- Send the job description today.\n- Put forward to Ruth this week; the next step would be a video call with her.',
      ].join('\n\n'),
      submission: [
        `I spoke to ${seller.name} this week and would recommend meeting them for the Head of Sales role.`,
        `${first} runs the regional sales team at ${seller.current_company}: eight account executives selling same-day and next-day freight to retailers and manufacturers across the North West. Last year the team closed 3.1 million in new business against a target of 2.8, and ${first} personally brought in about 600,000 of it. They still carry their own number and told me they would not want to give that up.`,
        'They are open to a move because they want to build something bigger than their current role allows, which is what the Midlands expansion offers. They have grown a team before, taking Leeds from two people to five, and have hired and trained account executives.',
        'The honest gap: they have not opened a region from a standing start.',
        'They are looking for around 90,000 base and care most about the bonus being realistic. Notice is three months, though they expect to be released after two.',
      ].join('\n\n'),
    });
  }

  const engineer = interviewing(jobs[0].id);
  if (engineer) {
    const first = engineer.name.split(' ')[0];
    demoCall({
      title: `Call with ${engineer.name}`, days: 5, app: engineer, speakers: { 0: 'Priya Nair', 1: engineer.name },
      turns: timed([
        [0, `Hi ${first}, thanks for calling back. I wanted to hear a bit more about the systems you look after at ${engineer.current_company}.`],
        [1, 'Sure. I am on the platform team. We run the booking and payments services, mostly TypeScript on Node with Postgres underneath. I have been there four years and I lead the on-call rota for our services.'],
        [0, 'What is the biggest table you have had to deal with?'],
        [1, 'Our events table is a little over two billion rows. Queries got slow about a year ago, so I led the work to partition it by month and move the old data out. Median query time went from about 900 milliseconds to under 100.'],
        [0, 'That is exactly the kind of thing Lumen needs. They are pulling their scheduling engine out of a monolith. How do you feel about two days a week in the London office?'],
        [1, 'That is fine. I am in Croydon, so it is about forty minutes.'],
        [0, 'And on salary?'],
        [1, 'I am on 88,000. I would want at least 95,000 to move, and I would like to understand the share options.'],
        [0, 'Notice period?'],
        [1, 'One month.'],
        [0, 'Great. The next stage is a paired technical exercise with Maya\'s team, not a take-home. I will send over some times.'],
        [1, 'Perfect, thanks.'],
      ]),
      notes: [
        `${first} is a platform engineer at ${engineer.current_company} with four years on booking and payments services. Comfortable with two days a week in London and on one month's notice. Next is the paired technical exercise.`,
        `Background and current role\n- On the platform team at ${engineer.current_company} for four years.\n- Runs the booking and payments services: mostly TypeScript on Node, with Postgres underneath.\n- Leads the on-call rota for those services.`,
        'Relevant experience for this role\n- Events table of a little over two billion rows.\n- Led the work to partition it by month and move old data out; median query time went from about 900 milliseconds to under 100.',
        'Pay (current and expected)\n- On 88,000.\n- Would want at least 95,000 to move, and wants to understand the share options.',
        'Notice period and availability\n- One month.',
        'Location and working pattern\n- Lives in Croydon, about forty minutes from the office.\n- Fine with two days a week in London.',
        'Next steps\n- Paired technical exercise with Maya\'s team (not a take-home).\n- Send over some times.',
      ].join('\n\n'),
    });
  }

  demoCall({
    title: 'Intro call: product designer referred by Tom', days: 1, app: null, source: 'pasted', speakers: { 0: 'Priya Nair', 1: 'Rowan' },
    turns: timed([
      [0, 'Thanks for getting in touch, Rowan. Tom at Lumen mentioned you might be open to hearing about a design role.'],
      [1, 'Yes. I have been at the same agency for five years, mostly on booking and workflow tools for healthcare clients, and I would like to work on one product properly.'],
      [0, 'What does your research experience look like?'],
      [1, 'I run my own interviews and usability sessions. On the last project I spent two weeks shadowing receptionists before drawing anything.'],
      [0, 'That is what Tom wants to see. What would you need on pay and notice?'],
      [1, 'I am looking for something between 65,000 and 70,000. My notice is six weeks.'],
      [0, 'Good. Send me your portfolio and I will add you to the role properly.'],
      [1, 'Will do, thank you.'],
    ]),
    notes: [
      'Rowan is a designer with five years at an agency, mostly on booking and workflow tools for healthcare clients, and wants to work on a single product. Referred by Tom. Portfolio to follow.',
      'Background and current role\n- Five years at the same agency.\n- Mostly booking and workflow tools for healthcare clients.',
      'Why they are looking\n- Wants to work on one product properly.',
      'Relevant experience for this role\n- Runs their own interviews and usability sessions.\n- Spent two weeks shadowing receptionists on the last project before drawing anything.',
      'Pay (current and expected)\n- Looking for between 65,000 and 70,000.',
      'Notice period and availability\n- Six weeks.',
      'Next steps\n- Rowan to send a portfolio.\n- Add them to the Product Designer role.',
    ].join('\n\n'),
  });
});

console.log(`Demo data loaded.
  Agency owner:  alex@harbourtalent.example / ${PASSWORD}
  Recruiter:     priya@harbourtalent.example / ${PASSWORD}
  Client user:   maya@lumenhealth.example / ${PASSWORD}  (sees Lumen Health only)`);
