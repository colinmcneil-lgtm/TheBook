// Fills an empty database with a demo agency, three fictional clients and a realistic pipeline.
// Run with: npm run seed            (refuses to run if the database already has users)
//           npm run seed -- --reset (wipes everything first)
//           Both refuse to run when NODE_ENV=production unless you also pass --force.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, q, tx, setSetting, createStages, DATA_DIR, UPLOAD_DIR } from './db.js';

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
    for (const t of ['emails', 'offers', 'scorecards', 'interview_panel', 'interviews', 'activities', 'notes', 'stage_history', 'applications', 'candidates', 'stages', 'jobs', 'sessions', 'invites', 'users', 'clients'])
      db.exec(`DELETE FROM ${t}`);
    db.exec('DELETE FROM sqlite_sequence'); // a wiped database starts numbering from 1 again
  });
  for (const file of fs.readdirSync(UPLOAD_DIR)) fs.rmSync(path.join(UPLOAD_DIR, file), { recursive: true, force: true }); // résumés of the rows just deleted
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
        meta.client_id, name, email, `+44 7${between(100, 999)} ${between(100000, 999999)}`, `https://www.linkedin.com/in/${email.split('@')[0].replace(/\./g, '-')}`,
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
        if (i > 0) act(appId, pick([alex, priya]), i === hiredStage ? 'hired' : 'stage', i === hiredStage ? 'Marked as hired' : `Moved to ${stages[i].name}`, enteredAt(i));
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
        act(appId, priya, 'interview', `Scheduled ${stages[i].name}`, enteredAt(i));
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
          priya, pending ? null : 'Agreed, keen to meet.', pending ? null : j.panel[0], pending ? null : enteredAt(1.5), appId);
        act(appId, priya, 'submitted', 'Submitted to the hiring team for review', enteredAt(1.2));
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
});

console.log(`Demo data loaded.
  Agency owner:  alex@harbourtalent.example / ${PASSWORD}
  Recruiter:     priya@harbourtalent.example / ${PASSWORD}
  Client user:   maya@lumenhealth.example / ${PASSWORD}  (sees Lumen Health only)`);
