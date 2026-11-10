// How résumé text is turned into the Add candidate form: run with `node --test "test/**/*.test.mjs"`.
// Every case states all seven fields. A field left out of `expect` must come back empty: the reader is allowed to
// find nothing, but never to fill in something that is not the candidate's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResume, nameFromFilename, extractResumeText, readResume } from '../src/resume.js';
import { docx, rtfFile, textFile } from './fixtures.mjs';

const FIELDS = ['name', 'email', 'phone', 'linkedin', 'location', 'current_title', 'current_company'];
const all = (fields) => Object.fromEntries(FIELDS.map((k) => [k, fields[k] || '']));
const reads = (title, text, expect, hints) => test(title, () => assert.deepEqual(all(parseResume(text, hints)), all(expect)));
/** Text with the font size of each line, as the PDF reader reports it: rows of [text, size] on page 1. */
const sized = (rows) => ({ text: rows.map(([t]) => t).join('\n'), hints: { lines: rows.map(([, size]) => ({ size, page: 1 })) } });

// ---------- whole résumés ----------

reads('US: company and city, then title and dates', `JOHN A. SMITH
123 Main Street, Springfield, IL 62704 | (217) 555-0142 | john.smith@gmail.com

PROFESSIONAL SUMMARY
Software engineer with 10 years of experience building payment systems.

PROFESSIONAL EXPERIENCE
Acme Corporation, Chicago, IL
Senior Software Engineer, June 2019 – Present
• Led a team of 6 engineers delivering the billing platform
• Cut cloud spend by 30%

Initech, Austin, TX
Software Engineer, 2014 – 2019

EDUCATION
B.S. Computer Science, University of Illinois, 2014`,
{ name: 'John A. Smith', email: 'john.smith@gmail.com', phone: '(217) 555-0142', location: 'Springfield, IL', current_title: 'Senior Software Engineer', current_company: 'Acme Corporation' });

reads('US: new graduate, education first, bullets and a GPA', `Emily Chen
emily.chen@university.edu • (415) 555-0198 • San Francisco, CA • github.com/emilychen

EDUCATION
University of California, Berkeley — B.S. Computer Science, May 2024
GPA: 3.8/4.0

EXPERIENCE
Software Engineering Intern, Stripe — San Francisco, CA
June 2023 – August 2023
• Built an internal dashboard used by 40 engineers
• Reduced build times from 12 minutes to 5

PROJECTS
Course Planner (React, Node) 2022 - 2023`,
{ name: 'Emily Chen', email: 'emily.chen@university.edu', phone: '(415) 555-0198', location: 'San Francisco, CA', current_title: 'Software Engineering Intern', current_company: 'Stripe' });

reads('US: sales résumé full of figures, title above company', `Marcus Johnson
Atlanta, GA 30301 · 404-555-0173 · marcus.johnson@mail.example

Summary
Top-performing sales leader: $4.2M revenue in 2023, 135% of quota for 3 years running.

Experience
Regional Sales Manager
Salesforce, Atlanta, GA
01/2019 – Present
• Closed $12,500,000 in new business across 25 enterprise accounts
• Grew the team from 4 to 11 between 2019 - 2022

Account Executive
Oracle, Atlanta, GA
2014 – 2018`,
{ name: 'Marcus Johnson', email: 'marcus.johnson@mail.example', phone: '404-555-0173', location: 'Atlanta, GA', current_title: 'Regional Sales Manager', current_company: 'Salesforce' });

reads('US: LaTeX template with diamonds between the contact details', `Jane Q. Public
Software Engineer
(+1) 555-123-4567 ⋄ jane@public.example ⋄ github.com/janeqp ⋄ linkedin.com/in/jane-q-public

Experience
Senior Software Engineer @ Datadog
Mar 2021 – Present
Designed the ingestion pipeline for log data`,
{ name: 'Jane Q. Public', email: 'jane@public.example', phone: '(+1) 555-123-4567', linkedin: 'https://www.linkedin.com/in/jane-q-public', current_title: 'Senior Software Engineer', current_company: 'Datadog' });

reads('UK: title and company joined by a hyphen, dates below', `Jane Doe
jane.doe@gmail.com | 07700 900111 | London

Experience
Senior Software Engineer - Acme Corp
Jan 2020 - Present
Led a team of five building the checkout service
Reduced page load time by 40%`,
{ name: 'Jane Doe', email: 'jane.doe@gmail.com', phone: '07700 900111', location: 'London', current_title: 'Senior Software Engineer', current_company: 'Acme Corp' });

reads('UK: nurse whose surname is a job word, postcode in the address', `Patricia Head, RN
Registered Nurse
Leeds LS6 2QT | 07700 900321 | pat.head@nhs.example

Employment
Staff Nurse – Leeds Teaching Hospitals NHS Trust
Aug 2015 – Present
Charge nurse cover on a 28-bed surgical ward`,
{ name: 'Patricia Head', email: 'pat.head@nhs.example', phone: '07700 900321', location: 'Leeds', current_title: 'Staff Nurse', current_company: 'Leeds Teaching Hospitals NHS Trust' });

reads('UK: teacher, full postal address, "to present" dates', `Mr James O'Neill
14 Park Road, Reading, RG1 5AB
Tel: 0118 496 0456 · Email: j.oneill@mail.example

PERSONAL STATEMENT
A mathematics teacher with twelve years in selective and comprehensive schools.

TEACHING EXPERIENCE
Head of Mathematics, Kendrick School, Reading — September 2018 to present
Teacher of Mathematics, The Abbey School — 2012 to 2018

REFERENCES
Ms Christine Kattirtzi, Headteacher, Kendrick School
c.kattirtzi@kendrick.example · 0118 901 5859`,
{ name: "Mr James O'Neill", email: 'j.oneill@mail.example', phone: '0118 496 0456', location: 'Reading', current_title: 'Head of Mathematics', current_company: 'Kendrick School' });

reads('UK: referee comes before the work history and is the only email in the file', `Tom Baker
Nottingham, UK
Phone: 0115 496 0123

References
Dr Helen Wright, helen.wright@uni.example
07700 900999

Experience
Lab Technician, Boots
2019 – Present`,
{ name: 'Tom Baker', phone: '0115 496 0123', location: 'Nottingham, UK', current_title: 'Lab Technician', current_company: 'Boots' });

reads('UK: plain text, capitals, title then company on separate lines', `PRIYA RAMANATHAN
Recruitment Consultant
priya.r@mail.example
+44 7700 900789
Bristol, England

EXPERIENCE
Senior Recruitment Consultant
Marlowe Group
2021 - Present`,
{ name: 'Priya Ramanathan', email: 'priya.r@mail.example', phone: '+44 7700 900789', location: 'Bristol, England', current_title: 'Senior Recruitment Consultant', current_company: 'Marlowe Group' });

reads('Ireland: "Curriculum Vitae" above the name, labels in the contact line', `Curriculum Vitae
Dr. Siobhán O'Connor-Lee
Email: siobhan.oconnor@mail.example • Phone: (020) 7946 0991 • Address: Dublin, Ireland
Professional Experience
Head of Clinical Operations at Lumen Health (2020 – Present)
Ran operations for 40 clinics.
Operations Manager at Tidewell (2015 – 2020)`,
{ name: "Dr. Siobhán O'Connor-Lee", email: 'siobhan.oconnor@mail.example', phone: '(020) 7946 0991', location: 'Dublin, Ireland', current_title: 'Head of Clinical Operations', current_company: 'Lumen Health' });

reads('Germany: dates first, numeric date ranges, no phone', `Lukas Müller
Berlin | lukas.mueller@mail.example

Berufserfahrung / Experience
10.2019 - 03.2023 Senior Engineer, Acme GmbH
Designed the billing system used by 2M customers
Mentored four junior engineers
01.2015 - 09.2019 Engineer, Beispiel AG`,
{ name: 'Lukas Müller', email: 'lukas.mueller@mail.example', location: 'Berlin', current_title: 'Senior Engineer', current_company: 'Acme GmbH' });

reads('Germany: title, particles, slash in the phone number, "seit"', `Dr. Hans-Peter von der Heide
Musterstraße 12 · 80331 München
Tel.: 089/1234567 · Mobil: 0171/2345678
hp.vonderheide@beispiel.example

Berufserfahrung
seit 03/2018 · Leiter Controlling, Siemens AG, München
2012 – 2018 · Controller, BMW Group

Ausbildung
Diplom-Kaufmann, LMU München, 2006`,
{ name: 'Dr. Hans-Peter von der Heide', email: 'hp.vonderheide@beispiel.example', phone: '089/1234567', location: 'München', current_title: 'Leiter Controlling', current_company: 'Siemens AG' });

reads('France: street address, national phone format, French dates', `Camille Dubois
Chef de projet marketing
12 rue de la Paix, 75002 Paris
06 12 34 56 78
camille.dubois@exemple.example

Expérience professionnelle
Chef de projet marketing – L'Oréal, Paris
Septembre 2019 – Aujourd'hui
Pilotage du lancement de trois gammes en Europe

Formation
Master Marketing, ESSEC, 2016`,
{ name: 'Camille Dubois', email: 'camille.dubois@exemple.example', phone: '06 12 34 56 78', location: 'Paris', current_title: 'Chef de projet marketing', current_company: "L'Oréal" });

reads('Spain: four-part name in capitals, company then title', `MARÍA JOSÉ GARCÍA LÓPEZ
Madrid, España · +34 612 345 678 · mjgarcia@correo.example

Experiencia profesional
Banco Santander — Analista de riesgos
Enero 2020 – Actualidad
Modelos de riesgo de crédito para pymes

Formación
Grado en Economía, Universidad Complutense de Madrid`,
{ name: 'María José García López', email: 'mjgarcia@correo.example', phone: '+34 612 345 678', location: 'Madrid, España', current_title: 'Analista de riesgos', current_company: 'Banco Santander' });

reads('Italy: name and headline on one line, "@" between title and company', `SOFIA ROSSI | UX DESIGNER
Milan, Italy | sofia@sofiarossi.example | +39 345 678 9012 | sofiarossi.example

ABOUT
I design calm interfaces for busy people.

EXPERIENCE
UX Designer @ Bending Spoons
2021 – Present
Redesigned onboarding for an app with 10 million users`,
{ name: 'Sofia Rossi', email: 'sofia@sofiarossi.example', phone: '+39 345 678 9012', location: 'Milan, Italy', current_title: 'UX Designer', current_company: 'Bending Spoons' });

reads('Sweden: link on its own line, title and company split by a comma', `Jonas Bergström
Finance Manager
Stockholm, Sweden
jonas.bergstrom@mail.example | +46 70 123 45 67
https://www.linkedin.com/in/jonas-bergstrom
Employment History
Finance Manager, Varsity Freight
2019 – Present
Owned month-end close.`,
{ name: 'Jonas Bergström', email: 'jonas.bergstrom@mail.example', phone: '+46 70 123 45 67', linkedin: 'https://www.linkedin.com/in/jonas-bergstrom', location: 'Stockholm, Sweden', current_title: 'Finance Manager', current_company: 'Varsity Freight' });

reads('India: "Personal Details" with a Name label, date of birth and passport number', `Curriculum Vitae
Personal Details
Name: Rohan Mehta
Email: rohan@mail.example
Mobile: 07700 900123
Date of Birth: 12/03/1990
Passport No: Z1234567
Employment History
Brightwater Analytics
Senior Data Engineer
Jan 2021 – Present`,
{ name: 'Rohan Mehta', email: 'rohan@mail.example', phone: '07700 900123', current_title: 'Senior Data Engineer', current_company: 'Brightwater Analytics' });

reads('India: "RESUME" heading, ten-digit mobile, designation label, declaration at the end', `RESUME
RAHUL KUMAR SHARMA
E-mail: rahul.sharma92@gmail.example
Mobile No: 9876543210

Career Objective
To work in a challenging environment where I can apply my skills.

Educational Qualification
B.Tech (Computer Science), Pune University, 2014, 72.5%

Work Experience
Infosys Limited, Pune (June 2019 – Till Date)
Designation: Systems Engineer
Worked on a banking client's payments platform

Personal Details
Father's Name: Suresh Sharma
Date of Birth: 14-08-1992
Languages Known: English, Hindi

Declaration
I hereby declare that the above information is true to the best of my knowledge.
Place: Pune
(Rahul Kumar Sharma)`,
{ name: 'Rahul Kumar Sharma', email: 'rahul.sharma92@gmail.example', phone: '9876543210', current_title: 'Systems Engineer', current_company: 'Infosys Limited' });

reads('Australia: state and postcode after the city, pipes in the job line', `Liam O'Brien
Sydney NSW 2000 | 0412 345 678 | liam.obrien@email.example | linkedin.com/in/liamobrien

PROFESSIONAL SUMMARY
Chartered accountant with eight years in audit and advisory.

EMPLOYMENT HISTORY
Senior Accountant | KPMG Australia | Sydney
Feb 2020 – Present
• Lead audits for ASX-listed clients`,
{ name: "Liam O'Brien", email: 'liam.obrien@email.example', phone: '0412 345 678', linkedin: 'https://www.linkedin.com/in/liamobrien', location: 'Sydney NSW', current_title: 'Senior Accountant', current_company: 'KPMG Australia' });

reads('Singapore: family name first, title in brackets, unit number and "HP"', `TAN WEI LING (Ms)
Blk 123 Ang Mo Kio Ave 3 #05-67 Singapore 560123
HP: 9123 4567
Email: weiling.tan@mail.example

WORKING EXPERIENCE
DBS Bank Ltd
Assistant Vice President, Operations
Mar 2018 to Present
Run a team of 14 handling trade settlements`,
{ name: 'Tan Wei Ling', email: 'weiling.tan@mail.example', phone: '9123 4567', current_title: 'Assistant Vice President, Operations', current_company: 'DBS Bank Ltd' });

reads('China: family name in capitals, name in characters, mobile with country code', `LI Wei (李伟)
Shanghai, China
Mobile: +86 138 0013 8000
Email: liwei1990@mail.example

Work Experience
2019.07 – Present    Product Manager, Meituan
2016.07 – 2019.06    Associate Product Manager, Ctrip`,
{ name: 'LI Wei', email: 'liwei1990@mail.example', phone: '+86 138 0013 8000', location: 'Shanghai, China', current_title: 'Product Manager', current_company: 'Meituan' });

reads('Nigeria: personal data block, two phone numbers, referees at the end', `CURRICULUM VITAE
PERSONAL DATA
Name: OLUWASEUN ADEBAYO
Address: 14 Admiralty Way, Lekki Phase 1, Lagos
Phone: 0803 123 4567, 0705 987 6543
Email: seun.adebayo@mail.example
State of Origin: Ogun State

WORK EXPERIENCE
2019 – Date: Guaranty Trust Bank Plc, Lagos
Position: Relationship Manager

REFEREES
Mr. Tunde Bakare
Managing Director, Bakare & Co.
0802 222 3333, tunde@bakare.example`,
{ name: 'Oluwaseun Adebayo', email: 'seun.adebayo@mail.example', phone: '0803 123 4567', location: '14 Admiralty Way, Lekki Phase 1, Lagos', current_title: 'Relationship Manager', current_company: 'Guaranty Trust Bank Plc' });

reads('UAE: nationality and visa lines under the contact details', `Mohammed Al-Farsi
Dubai, UAE | +971 50 123 4567 | m.alfarsi@mail.example
Nationality: Omani | Visa Status: Employment Visa | Driving Licence: UAE

Profile
Branch operations manager with 12 years in retail banking.

Work Experience
Emirates NBD – Dubai, UAE
Branch Operations Manager (Jan 2017 – Present)
Managed a branch of 35 staff`,
{ name: 'Mohammed Al-Farsi', email: 'm.alfarsi@mail.example', phone: '+971 50 123 4567', location: 'Dubai, UAE', current_title: 'Branch Operations Manager', current_company: 'Emirates NBD' });

reads('South Africa: 13-digit ID number above the phone, company then title', `Thandiwe Nkosi
ID Number: 9001015800085
Cell: 082 555 0123
thandi.nkosi@webmail.example
Johannesburg, Gauteng

Career History
Standard Bank Group – Payroll Administrator
March 2016 – current
Processed monthly payroll for 4 200 employees`,
{ name: 'Thandiwe Nkosi', email: 'thandi.nkosi@webmail.example', phone: '082 555 0123', location: 'Johannesburg, Gauteng', current_title: 'Payroll Administrator', current_company: 'Standard Bank Group' });

reads('Academic CV: department line, ORCID, appointments, publications and referees', `CURRICULUM VITAE
Dr Amara Nwosu
Department of Physics, University of Leeds
a.nwosu@leeds.example
ORCID 0000-0002-1825-0097

Education
PhD Condensed Matter Physics, University of Cambridge, 2015
MSci Physics, Imperial College London, 2011

Academic Appointments
Lecturer in Physics, University of Leeds, 2019–present
Postdoctoral Research Associate, ETH Zürich, 2015–2019

Publications
Nwosu A., Keller T. (2021) Spin transport in layered magnets. Phys. Rev. B 103, 144417.
Nwosu A. (2018) Magnon drag. Nature Physics 14, 1026-1031.

Grants
EPSRC New Investigator Award EP/T012345/1, £412,000, 2020-2023

References
Prof. Thomas Keller, ETH Zürich, keller@ethz.example, +41 44 632 11 11`,
{ name: 'Dr Amara Nwosu', email: 'a.nwosu@leeds.example', current_title: 'Lecturer in Physics', current_company: 'University of Leeds' });

reads('Skills-first layout: no work history heading the reader knows, title from the headline', `NAOMI ADEYEMI
Customer Success Manager
naomi.adeyemi@mail.example | 07700 900654

KEY SKILLS
Account management · Onboarding · Renewals · Salesforce
Python, SQL, Tableau

CAREER SNAPSHOT
Seven years growing SaaS accounts in fintech and logistics.`,
{ name: 'Naomi Adeyemi', email: 'naomi.adeyemi@mail.example', phone: '07700 900654', current_title: 'Customer Success Manager' });

reads('Skills and languages under the header are not a location', `Aisha Khan
Data Analyst
aisha.khan@mail.example
Python, SQL, Tableau
English, Urdu
Experience
Data Analyst at Monzo
2021 – Present`,
{ name: 'Aisha Khan', email: 'aisha.khan@mail.example', current_title: 'Data Analyst', current_company: 'Monzo' });

reads('Credential after the name, a region under the title', `John Smith, PMP
Project Manager
San Francisco Bay Area
john@smith.example

Experience
Project Manager, Initech
2018 – Present`,
{ name: 'John Smith', email: 'john@smith.example', location: 'San Francisco Bay Area', current_title: 'Project Manager', current_company: 'Initech' });

reads('Surname is a job word and the city has no comma', `Adam Driver
Senior Backend Engineer
New York
adam@mail.example
Experience
Senior Backend Engineer, Stripe
2020 – Present`,
{ name: 'Adam Driver', email: 'adam@mail.example', location: 'New York', current_title: 'Senior Backend Engineer', current_company: 'Stripe' });

reads('Company name that starts like a month, dates on the same line', `Chris Evans
chris@mail.example
Experience
Senior Engineer, Novartis 2018 – Present
Built data pipelines for clinical trials`,
{ name: 'Chris Evans', email: 'chris@mail.example', current_title: 'Senior Engineer', current_company: 'Novartis' });

reads('No phone: numeric date ranges are not one', `Maria Garcia
maria.garcia@mail.example
linkedin.com/in/mariagarcia

Experience
Product Manager, Shopline
06/2019 - 08/2022
Launched the merchant onboarding flow`,
{ name: 'Maria Garcia', email: 'maria.garcia@mail.example', linkedin: 'https://www.linkedin.com/in/mariagarcia', current_title: 'Product Manager', current_company: 'Shopline' });

reads('Hospitality: job words the reader does not know, company marked by "Ltd"', `Ffion Pritchard
ffion.pritchard@mail.example · 07700 900432 · Cardiff, Wales

Work History
Sommelier
Thomas Restaurants Ltd
2022 – Present`,
{ name: 'Ffion Pritchard', email: 'ffion.pritchard@mail.example', phone: '07700 900432', location: 'Cardiff, Wales', current_title: 'Sommelier', current_company: 'Thomas Restaurants Ltd' });

reads('Job words the reader does not know and nothing to tell title from company: both left empty', `Ffion Pritchard
ffion.pritchard@mail.example

Work History
Sommelier
Hawksmoor
2022 – Present`,
{ name: 'Ffion Pritchard', email: 'ffion.pritchard@mail.example' });

reads('Agency profile with the name removed', `CANDIDATE PROFILE
Senior Project Manager
Location: Manchester
Availability: Immediate
Ref: HT-2039100417

Career History
Balfour Beatty
Senior Project Manager
2018 – Present
Delivered a £40m hospital extension`,
{ location: 'Manchester', current_title: 'Senior Project Manager', current_company: 'Balfour Beatty' });

reads('Name with letter spacing in a text file', `J A N E   D O E
P R O D U C T   D E S I G N E R
jane.doe@mail.example

E X P E R I E N C E
Product Designer | Halden Systems
2019 - Present`,
{ name: 'Jane Doe', email: 'jane.doe@mail.example', current_title: 'Product Designer', current_company: 'Halden Systems' });

reads('Address first, name second: the email address settles which line is the name', `Flat 3, 22 Canal Street
Hannah Whitfield
Leeds, UK
hannah.whitfield@mail.example

Experience
Finance Director, Varsity Freight
March 2020 – Present`,
{ name: 'Hannah Whitfield', email: 'hannah.whitfield@mail.example', location: 'Leeds, UK', current_title: 'Finance Director', current_company: 'Varsity Freight' });

reads('Surname first with a comma', `WHITFIELD, Hannah
hannah.whitfield@mail.example
Experience
Finance Director at Varsity Freight`,
{ name: 'Hannah Whitfield', email: 'hannah.whitfield@mail.example', current_title: 'Finance Director', current_company: 'Varsity Freight' });

reads('Surname that is also a language', `Dawn French
dawn.french@mail.example
Experience
Writer, Saunders and French Productions
1987 – Present`,
{ name: 'Dawn French', email: 'dawn.french@mail.example', current_title: 'Writer', current_company: 'Saunders and French Productions' });

reads('US: one-line header with hyphens, "Inc." after a comma, department after the title', `MICHAEL O'DONNELL
Boston, MA 02110 - (617) 555-0188 - modonnell@mail.example - linkedin.com/in/michael-odonnell

SUMMARY OF QUALIFICATIONS
15 years in commercial real estate.

PROFESSIONAL EXPERIENCE

CBRE GROUP, INC., Boston, MA                                                  2015 – Present
Senior Vice President, Capital Markets
- Closed $2.1B in transactions

JLL, Boston, MA   2008 – 2015
Vice President`,
{ name: "Michael O'Donnell", email: 'modonnell@mail.example', phone: '(617) 555-0188', linkedin: 'https://www.linkedin.com/in/michael-odonnell', location: 'Boston, MA', current_title: 'Senior Vice President', current_company: 'CBRE GROUP, INC.' });

reads('US: street address on two lines, extension after the phone, company then title with its team', `David Kim
1200 Market St Apt 4B
San Francisco, CA 94102
Phone: 415.555.0199 ext. 12
david.kim@mail.example

WORK EXPERIENCE
Google LLC — Mountain View, CA
Staff Software Engineer, Search Infrastructure — Aug 2018 - Present
Software Engineer — 2013 - 2018`,
{ name: 'David Kim', email: 'david.kim@mail.example', phone: '415.555.0199', location: 'San Francisco, CA', current_title: 'Staff Software Engineer', current_company: 'Google LLC' });

reads('US: summary with no heading and large figures under the contact line', `Rebecca Stone
Leeds, West Yorkshire · rebecca.stone@mail.example · 07700 900455

Commercial finance leader with 15 years of experience. Managed budgets of 120 000 000 across 14 sites and
delivered 3 200 000 in annual savings between 2019 and 2023. Grew EBITDA from 8.2 to 11.5 percent.

Experience

Finance Director                                                  Jan 2020 – Present
Northern Rail Catering Ltd, Leeds
• Lead a team of 22`,
{ name: 'Rebecca Stone', email: 'rebecca.stone@mail.example', phone: '07700 900455', location: 'Leeds, West Yorkshire', current_title: 'Finance Director', current_company: 'Northern Rail Catering Ltd' });

reads('US: veteran, headline and keywords between the header and the work history', `JAMES T. WALKER
(910) 555-0163 • james.walker@mail.example • Fayetteville, NC • Secret Clearance

OPERATIONS MANAGER
Logistics | Team Leadership | Process Improvement

PROFESSIONAL EXPERIENCE
UNITED STATES ARMY, Fort Bragg, NC
Operations Sergeant, 2015 – 2023
Supervised 45 personnel and $12M in equipment.`,
{ name: 'James T. Walker', email: 'james.walker@mail.example', phone: '(910) 555-0163', location: 'Fayetteville, NC', current_title: 'Operations Sergeant', current_company: 'UNITED STATES ARMY' });

reads('UK: pronouns and a postal address under the name, dates before each job', `Olivia Bennett
she/her
Flat 2, 18 Rose Lane
Norwich NR1 1PL
olivia.bennett@mail.example
07700 900812

Profile
Management accountant, CIMA qualified.

Career History
Jan 2021 – Present: Management Accountant, Aviva plc, Norwich
2016 – 2020: Assistant Accountant, Norfolk County Council`,
{ name: 'Olivia Bennett', email: 'olivia.bennett@mail.example', phone: '07700 900812', location: 'Norwich', current_title: 'Management Accountant', current_company: 'Aviva plc' });

reads('UK: two phone numbers, a job word the reader does not know in the first job and one it knows in the second', `Margaret Okafor
23 Elm Grove
Croydon
CR0 2AB
Tel 020 8496 0142
Mob 07700 900387
maggieokafor@mail.example

Personal Profile
A caring and reliable person.

Employment
Night Sitter        Mar 2018 - present
Sunrise Senior Living, Purley

Care Assistant        2012 - 2018
Bupa Care Homes`,
{ name: 'Margaret Okafor', email: 'maggieokafor@mail.example', phone: '020 8496 0142' });

reads('UK: one employer with two roles under it, each with its own dates', `Nina Patel
nina.patel@mail.example | 07700 900222 | London

Work Experience

Barclays, London
2019 – Present
Vice President, Risk Analytics (2021 – Present)
Assistant Vice President (2019 – 2021)

HSBC, London
Analyst, 2015 – 2019`,
{ name: 'Nina Patel', email: 'nina.patel@mail.example', phone: '07700 900222', location: 'London', current_title: 'Vice President', current_company: 'Barclays' });

reads('Canada: "References available upon request" above the contact line hides nothing', `Wei Zhang
Software Developer

References available upon request

zhang.wei@mail.example | +1 604 555 0177 | Vancouver, BC

Experience
Software Developer, Hootsuite (2020-present)`,
{ name: 'Wei Zhang', email: 'zhang.wei@mail.example', phone: '+1 604 555 0177', location: 'Vancouver, BC', current_title: 'Software Developer', current_company: 'Hootsuite' });

reads('Canada (Québec): credential after the name, French job words, "à aujourd\'hui"', `ÉTIENNE TREMBLAY, CPA
1250 boul. René-Lévesque Ouest, Montréal (Québec) H3B 4W8
514 555-0147 | etienne.tremblay@mail.example

PROFIL
Comptable professionnel agréé, 8 ans d'expérience.

EXPÉRIENCE PROFESSIONNELLE
Contrôleur financier, Bombardier Inc., Montréal — 2019 à aujourd'hui
Analyste financier, Desjardins — 2015 à 2019`,
{ name: 'Étienne Tremblay', email: 'etienne.tremblay@mail.example', phone: '514 555-0147', current_title: 'Contrôleur financier', current_company: 'Bombardier Inc.' });

reads('Morocco: dates in a right-hand column with French month abbreviations, employer on the next line', `Fatima Zahra El Amrani
Casablanca, Maroc | +212 6 12 34 56 78 | f.elamrani@mail.example

EXPÉRIENCE PROFESSIONNELLE
Responsable Ressources Humaines\tjanv. 2020 – présent
Groupe OCP, Casablanca
Gestion de 300 collaborateurs

FORMATION
Master RH, ISCAE`,
{ name: 'Fatima Zahra El Amrani', email: 'f.elamrani@mail.example', phone: '+212 6 12 34 56 78', location: 'Casablanca, Maroc', current_title: 'Responsable Ressources Humaines', current_company: 'Groupe OCP' });

reads('France: surname in capitals, date of birth, "Depuis", colon after the dates', `Jean-Baptiste MARTIN
Né le 12/05/1988
Tél : 06.12.34.56.78
Courriel : jb.martin@mail.example
Permis B

Expériences professionnelles
Depuis 2019 : Ingénieur d'études - Capgemini, Toulouse
2015-2019 : Développeur Java - Sopra Steria`,
{ name: 'Jean-Baptiste Martin', email: 'jb.martin@mail.example', phone: '06.12.34.56.78', current_title: "Ingénieur d'études", current_company: 'Capgemini' });

reads('Germany: Lebenslauf as a table, labels in the first column, description without a bullet', `Lebenslauf

Persönliche Daten
Name\tKatharina Schäfer
Anschrift\tHauptstraße 5, 50667 Köln
Telefon\t0221 1234567
E-Mail\tk.schaefer@beispiel.example
Geburtsdatum\t14.03.1988
Geburtsort\tBonn

Berufserfahrung
04/2019 – heute\tProjektleiterin, Deutsche Telekom AG, Bonn
\tLeitung eines Teams von 8 Mitarbeitern
10/2014 – 03/2019\tBeraterin, Accenture GmbH, Düsseldorf

Ausbildung
2008 – 2014\tUniversität zu Köln, BWL`,
{ name: 'Katharina Schäfer', email: 'k.schaefer@beispiel.example', phone: '0221 1234567', location: 'Köln', current_title: 'Projektleiterin', current_company: 'Deutsche Telekom AG' });

reads('Netherlands: postcode between the street and the town, job words the reader does not know', `Sanne de Vries
Keizersgracht 123, 1015 CJ Amsterdam
06-12345678
sanne.devries@mail.example

Werkervaring
2019 - heden   Projectleider, Gemeente Amsterdam
2015 - 2019   Beleidsmedewerker, Provincie Utrecht

Opleiding
2011 - 2015   Bestuurskunde, Universiteit Utrecht`,
{ name: 'Sanne de Vries', email: 'sanne.devries@mail.example', phone: '06-12345678', location: 'Amsterdam' });

reads('Brazil: company then title, Portuguese headings, "Atual"', `João Pedro da Silva
Rua das Flores, 100 - São Paulo, SP
(11) 91234-5678 | joao.silva@mail.example

Experiência Profissional
Itaú Unibanco - Analista Financeiro Sênior
03/2019 - Atual

Formação Acadêmica
USP - Administração`,
{ name: 'João Pedro da Silva', email: 'joao.silva@mail.example', phone: '(11) 91234-5678', location: 'São Paulo, SP', current_title: 'Analista Financeiro Sênior', current_company: 'Itaú Unibanco' });

reads('Italy: Europass form, labels in the left column', `Curriculum Vitae
Europass
Personal information
First name(s) / Surname(s)\tGiulia Bianchi
Address\tVia Roma 1, 00100 Roma, Italy
Telephone\t+39 06 1234567
E-mail\tgiulia.bianchi@mail.example
Work experience
Dates\t2019 – present
Occupation or position held\tProject Manager
Name and address of employer\tEnel SpA, Viale Regina Margherita 137, Roma`,
{ name: 'Giulia Bianchi', email: 'giulia.bianchi@mail.example', phone: '+39 06 1234567', location: 'Via Roma 1, 00100 Roma, Italy', current_title: 'Project Manager', current_company: 'Enel SpA' });

reads('Poland: surname first in capitals, headings the reader half knows', `KOWALSKI Anna
anna.kowalski@mail.example
+48 601 234 567
Warszawa

Doświadczenie zawodowe
2018 – obecnie Kierownik projektu, Allegro`,
{ name: 'Kowalski Anna', email: 'anna.kowalski@mail.example', phone: '+48 601 234 567' });

reads('India: initials, state after the city, company then title in brackets with dates', `R. K. Narayan
Chennai, Tamil Nadu
Mob: +91-98765-43210

PROFESSIONAL EXPERIENCE
Tata Consultancy Services, Chennai
Technical Lead (Apr 2016 – Present)`,
{ name: 'R. K. Narayan', phone: '+91-98765-43210', location: 'Chennai, Tamil Nadu', current_title: 'Technical Lead', current_company: 'Tata Consultancy Services' });

reads('India: fresher, percentages and a CGPA, father\'s name in the personal profile', `ANJALI VERMA
H.No. 45, Sector 12, Gurgaon, Haryana - 122001
Mobile: +91 98765 12345 | Email: anjali.verma95@mail.example

CAREER OBJECTIVE
Seeking a challenging position in a reputed organization.

ACADEMIC QUALIFICATIONS
B.Tech (ECE), DTU Delhi, 2017, 8.2 CGPA
XII, CBSE, 2013, 92.4%

PROFESSIONAL EXPERIENCE
Wipro Technologies, Gurgaon                                    July 2017 – Present
Project Engineer
- Working on network automation for a telecom client

PERSONAL PROFILE
Father's Name : Mr. Rakesh Verma
Date of Birth : 12th May 1995
Marital Status : Single
Languages Known : English, Hindi`,
{ name: 'Anjali Verma', email: 'anjali.verma95@mail.example', phone: '+91 98765 12345', current_title: 'Project Engineer', current_company: 'Wipro Technologies' });

reads('South Africa: name only in the title line, surname and first names labelled apart', `CURRICULUM VITAE OF SIPHO DLAMINI

PERSONAL DETAILS
Surname: Dlamini
First Names: Sipho Bongani
Identity Number: 8805125800083
Contact Number: 073 555 0198
E-mail Address: sipho.dlamini@mail.example
Residential Address: 12 Jacaranda Street, Pretoria, 0002
Driver's Licence: Code 10

EMPLOYMENT HISTORY
Company: Transnet Freight Rail
Position: Train Driver
Period: 2014 to date`,
{ name: 'Sipho Dlamini', email: 'sipho.dlamini@mail.example', phone: '073 555 0198', location: '12 Jacaranda Street, Pretoria, 0002', current_title: 'Train Driver', current_company: 'Transnet Freight Rail' });

reads('Japan: academic with no contact details, the headline under the name makes it one', `Hiroshi Tanaka
Associate Professor
Department of Economics, Kyoto University

Research Interests
Labour economics

Academic Positions
2018–present  Associate Professor, Kyoto University
2012–2018  Assistant Professor, Osaka University`,
{ name: 'Hiroshi Tanaka', current_title: 'Associate Professor', current_company: 'Kyoto University' });

reads('Page footer in the text: "Page 1 of 2" is not an employer, the footer still gives the contact details', `Hannah Lee
Marketing Executive

Experience
Marketing Executive, Monzo
2020 – Present

Page 1 of 2
Hannah Lee | hannah.lee@mail.example | 07700 900010`,
{ name: 'Hannah Lee', email: 'hannah.lee@mail.example', phone: '07700 900010', current_title: 'Marketing Executive', current_company: 'Monzo' });

// ---------- things that are not résumés ----------

reads('Invoice: no name, and the invoice number is not a phone', `INVOICE
Harbour Talent Ltd
Invoice Number 2026-00417
Bill To
Lumen Health
accounts@lumenhealth.example
Amount due 12,500.00`,
{ email: 'accounts@lumenhealth.example' });

reads('Cover letter: the sign-off is not the name, the signature is', `Dear Hiring Manager,
Priya Sharma suggested I contact you about the Finance Manager role.
You can reach me at sam.lee@mail.example or 07700 900222.
Kind regards
Sam Lee`,
{ name: 'Sam Lee', email: 'sam.lee@mail.example', phone: '07700 900222' });

reads('Reference letter about someone else: nothing is taken from the referee block', `References
Graham Pellow, CFO, Varsity Freight
graham.pellow@varsityfreight.example, 0113 496 0200
www.linkedin.com/in/graham-pellow`,
{});

reads('Agency cover sheet: the letterhead is not the candidate, the labelled name is', `Harbour Talent
Candidate Summary
Candidate: Olivia Bennett
Current role: Finance Manager at Lumen Health
Salary expectation: £65,000
Notice period: 1 month
Contact: 020 7946 0123`,
{ name: 'Olivia Bennett', phone: '020 7946 0123' });

reads('Job description: an employer and a job, nobody to add', `Lumen Health
Job Description
Finance Manager
Reports to: Finance Director
Location: Leeds
Salary: £60,000 – £70,000`,
{ location: 'Leeds' });

// ---------- layouts read out of column order ----------

const LINKEDIN_EXPORT = [
  ['Contact', 13], ['www.linkedin.com/in/rohan-', 11], ['mehta-data-engineer-', 11], ['4a81b22b (LinkedIn)', 11],
  ['Top Skills', 13], ['Data Engineering', 11], ['Apache Spark', 11], ['Python', 11],
  ['Languages', 13], ['English (Native or Bilingual)', 11], ['Hindi', 11],
  ['Rohan Mehta', 22], ['Senior Data Engineer at Brightwater Analytics', 11], ['London, England, United Kingdom', 11],
  ['Summary', 16.5], ['Data engineer with nine years building pipelines.', 11],
  ['Experience', 16.5], ['Brightwater Analytics', 13], ['Senior Data Engineer', 11], ['January 2021 - Present (5 years 11 months)', 11], ['London, England, United Kingdom', 11],
  ['Coppermill Ltd', 13], ['Data Engineer', 11], ['2017 - 2020 (3 years)', 11],
  ['Education', 16.5], ['University of Leeds', 13], ['BSc, Computer Science · (2010 - 2013)', 11],
];
const exported = sized(LINKEDIN_EXPORT);
reads('LinkedIn "Save to PDF": sidebar read first, link wrapped over three lines, no email', exported.text,
  { name: 'Rohan Mehta', linkedin: 'https://www.linkedin.com/in/rohan-mehta-data-engineer-4a81b22b', location: 'London, England, United Kingdom', current_title: 'Senior Data Engineer', current_company: 'Brightwater Analytics' }, exported.hints);
reads('LinkedIn export as bare text: with no email and no sizes the name is left empty, never a skill', exported.text,
  { linkedin: 'https://www.linkedin.com/in/rohan-mehta-data-engineer-4a81b22b', current_title: 'Senior Data Engineer', current_company: 'Brightwater Analytics' });
reads('LinkedIn export as bare text with an email: the address picks the name out', exported.text.replace('Contact\n', 'Contact\nrohan.mehta@mail.example\n'),
  { name: 'Rohan Mehta', email: 'rohan.mehta@mail.example', linkedin: 'https://www.linkedin.com/in/rohan-mehta-data-engineer-4a81b22b', location: 'London, England, United Kingdom', current_title: 'Senior Data Engineer', current_company: 'Brightwater Analytics' });
reads('LinkedIn export saved as "Profile.pdf": the file name adds nothing, the largest line is still the name', exported.text,
  { name: 'Rohan Mehta', linkedin: 'https://www.linkedin.com/in/rohan-mehta-data-engineer-4a81b22b', location: 'London, England, United Kingdom', current_title: 'Senior Data Engineer', current_company: 'Brightwater Analytics' }, { ...exported.hints, filename: 'Profile.pdf' });

const twoColumn = sized([
  ['CONTACT', 14], ['amelia.okoro@mail.example', 10], ['07700 900456', 10], ['Manchester, UK', 10], ['www.linkedin.com/in/ameliaokoro', 10],
  ['SKILLS', 14], ['Figma, Research, Prototyping', 10],
  ['AMELIA OKORO', 28], ['PRODUCT DESIGNER', 12],
  ['PROFILE', 14], ['Designer focused on complex workflow tools.', 10],
  ['WORK EXPERIENCE', 14], ['Lead Product Designer | Juniper Row', 10], ['March 2022 - Present', 10], ['Led design for scheduling.', 10],
  ['Product Designer | Halden Systems', 10], ['2018 - 2022', 10],
]);
reads('Two columns, sidebar first, name in capitals', twoColumn.text,
  { name: 'Amelia Okoro', email: 'amelia.okoro@mail.example', phone: '07700 900456', linkedin: 'https://www.linkedin.com/in/ameliaokoro', location: 'Manchester, UK', current_title: 'Lead Product Designer', current_company: 'Juniper Row' }, twoColumn.hints);

const sidebarLast = sized([
  ['KWAME', 32], ['MENSAH', 32], ['Operations Director', 12],
  ['Experience', 14], ['Operations Director', 11], ['Zipline Ghana', 10], ['2020 – Present', 10], ['Scaled drone delivery to 2 000 clinics.', 10],
  ['Plant Manager', 11], ['Unilever', 10], ['2012 – 2020', 10],
  ['Education', 14], ['MSc Supply Chain, KNUST', 10],
  ['Details', 14], ['Accra, Ghana', 10], ['kwame@mensah.example', 10], ['024 412 3456', 10],
  ['Skills', 14], ['Lean, Six Sigma', 10],
]);
reads('Two columns, sidebar last: name stacked on two large lines, contact details at the very end', sidebarLast.text,
  { name: 'Kwame Mensah', email: 'kwame@mensah.example', phone: '024 412 3456', location: 'Accra, Ghana', current_title: 'Operations Director', current_company: 'Zipline Ghana' }, sidebarLast.hints);

const bigHeading = sized([
  ['Technical Skills', 20], ['TypeScript, Go, Postgres', 10],
  ['Work Experience', 20], ['Staff Engineer, Monzo', 10], ['2019 – Present', 10],
]);
reads('PDF with no name on it: a large heading is not taken instead', bigHeading.text, { current_title: 'Staff Engineer', current_company: 'Monzo' }, bigHeading.hints);

const sameSize = sized([
  ['Board Roles', 14], ['Trustee, Shelter', 10], ['Selected Engagements', 14], ['Keynote, Money20/20', 10],
  ['Ingrid Solberg', 14], ['hello@studio.example', 10], ['Experience', 14], ['Chief Financial Officer, Kahoot', 10], ['2020 – Present', 10],
]);
reads('PDF where the name is no larger than the headings: an unknown heading is not taken for it', sameSize.text,
  { email: 'hello@studio.example', current_title: 'Chief Financial Officer', current_company: 'Kahoot' }, sameSize.hints);

const tagline = sized([
  ['Building calm software', 30], ['Nadia Rahman', 16], ['hello@studio.example', 10],
  ['Experience', 14], ['Design Lead, Loom', 10], ['2021 – Present', 10],
]);
reads('PDF whose largest line is a slogan: size says nothing, and a smaller line is not trusted on its own', tagline.text,
  { email: 'hello@studio.example', current_title: 'Design Lead', current_company: 'Loom' }, tagline.hints);
reads('PDF whose largest line is a slogan, but the email address agrees with the smaller line', tagline.text.replace('hello@', 'nadia@'),
  { name: 'Nadia Rahman', email: 'nadia@studio.example', current_title: 'Design Lead', current_company: 'Loom' }, tagline.hints);

// ---------- name ----------

test('name: only strong evidence counts', () => {
  const name = (text, hints) => parseResume(text, hints).name || '';
  // The opening line of a document that gives a way to reach the person.
  const opens = (first) => name(`${first}\n07700 900111\nSomething`);
  assert.equal(opens('Jane Doe'), 'Jane Doe');
  assert.equal(opens('Curriculum Vitae of Jane Doe'), 'Jane Doe');
  assert.equal(opens('Jane Doe – Curriculum Vitae'), 'Jane Doe');
  assert.equal(opens('Résumé – Jane Doe'), 'Jane Doe');
  assert.equal(opens('Alex Morgan (they/them)'), 'Alex Morgan');
  assert.equal(opens('Jean-Luc van den Berg'), 'Jean-Luc van den Berg');
  assert.equal(opens('JOHN SMITH MBA'), 'John Smith');
  assert.equal(opens("SARAH O'CONNELL BSc (Hons) ACA"), "Sarah O'Connell");
  assert.equal(opens('William "Bill" Gates'), 'William Gates');
  assert.equal(opens('DUBOIS Camille'), 'Dubois Camille');
  assert.equal(opens('Jane Doe, Senior Software Engineer'), 'Jane Doe');
  assert.equal(opens('Curriculum Vitae (CV)\nJane Doe'), 'Jane Doe');
  // What a page header holds does not push the name off the opening line.
  assert.equal(opens('Curriculum Vitae\tPage 1\nJane Doe'), 'Jane Doe');
  assert.equal(opens('Private & Confidential\nJane Doe'), 'Jane Doe');
  assert.equal(name('Personal Information\nName\tJane Doe\nNationality\tBritish'), 'Jane Doe');
  for (const real of ['Sally Field', 'Russell Brand', 'Robert Plant', 'Art Garfunkel', 'Paris Hilton', 'Kenya Moore', 'Jordan Banks', 'Larry Page', 'Björk Guðmundsdóttir', 'Nguyễn Thị Minh Khai', 'Abdul Rahman bin Abdullah'])
    assert.equal(opens(real), real);
  // A heading, a place, a company, a skill, a job title or a phrase about oneself on the first line is not a name.
  for (const first of ['Personal Details', 'San Francisco Bay Area', 'New York', 'United Kingdom', 'North Yorkshire', 'St Albans', 'Santa Clara', 'Harbour Talent Ltd', 'Harbour Talent', 'Lumen Health', 'Data Engineering', 'Apache Spark',
    'Senior Engineer', 'Product Manager', 'Art Director', 'Delivery Driver', 'Staff Nurse', 'Kind Regards', 'References', 'Top Skills', 'Key Achievements', 'Work Experience', 'Microsoft Office', 'Project Management', 'Full Stack',
    'Team Player', 'Job Description', 'Meeting Notes', 'Driving Licence', 'Your Name'])
    assert.equal(opens(`${first}\nJane Doe`), '', first);
  // Two capitalised words open many documents. They are a name only where there is a way to reach the person, or a
  // job title straight underneath.
  assert.equal(name('Jane Doe\nSomething'), '');
  assert.equal(name('Project Phoenix\nAttendees: Jane Doe, Sam Lee'), '');
  assert.equal(name('Jane Doe\nFinance Manager\nSomething'), 'Jane Doe');
  assert.equal(name('Jane Doe\nSomething\nlinkedin.com/in/jane-doe'), 'Jane Doe');
  // An organisation's email address is named after it; a person with a domain of their own has a job title under the name.
  assert.equal(name('Acme Widgets\ninfo@acmewidgets.example\n020 7946 0000'), '');
  assert.equal(name('Sofia Rossi\nUX Designer\nhello@sofiarossi.example'), 'Sofia Rossi');
  assert.equal(name('Sofia Rossi\nsofia@sofiarossi.example'), 'Sofia Rossi');
  // Nor is a name-shaped line further down, unless the email address or the file name agrees with it.
  assert.equal(name('Contact\n07700 900111\nMaple Avenue\nJane Doe'), '');
  assert.equal(name('Contact\n07700 900111\nMaple Avenue\nJane Doe\njane.doe@mail.example'), 'Jane Doe');
  assert.equal(name('Contact\n07700 900111\nMaple Avenue\nJane Doe', { filename: 'Jane_Doe_CV_2026.pdf' }), 'Jane Doe');
  assert.equal(name('Contact\n07700 900111\nMaple Avenue\nJane Doe', { filename: 'cv-final(2).pdf' }), '');
  assert.equal(name('Contact\nj.doe@mail.example\nMaple Avenue\nJane Doe'), 'Jane Doe');
  assert.equal(name('Contact\ndare.adeyemi@mail.example\nMaple Avenue\nOluwadamilare Adeyemi-Jones'), 'Oluwadamilare Adeyemi-Jones');
  // Letters that happen to sit inside the address are not agreement: "MIT" is in jsmith.
  assert.equal(name('Contact\njsmith@mail.example\nMIT Sloan\nMaple Avenue'), '');
  assert.equal(name('Contact\njsmith@mail.example\nMIT Sloan\nJohn Smith'), 'John Smith');
  // A file called after the job or the town does not make that line the name.
  assert.equal(name('Summary\nProduct Manager\n07700 900111', { filename: 'Product Manager Resume.pdf' }), '');
  assert.equal(name('Contact\nNew York\n07700 900111', { filename: 'new york cv.pdf' }), '');
  // A surname that is a job word needs the address to agree, or a job title straight under it.
  assert.equal(opens('Adam Driver\nNew York'), '');
  assert.equal(name('Adam Driver\nSenior Backend Engineer'), 'Adam Driver');
  assert.equal(name('Something\nAdam Driver\nadam.driver@mail.example'), 'Adam Driver');
  // The referee is never the candidate, even when the only email address is theirs; nor is the emergency contact.
  assert.equal(name('References\nHelen Wright\nhelen.wright@uni.example'), '');
  assert.equal(name('Experience\nAnalyst, Monzo\nReferees\nHelen Wright\nhelen.wright@uni.example'), '');
  assert.equal(name('Emergency Contact\nSam Lee\nsam.lee@mail.example\n07700 900123'), '');
  assert.equal(name('Name: Rohan Mehta\nFather\'s Name: Suresh Mehta'), 'Rohan Mehta');
  assert.equal(name('Company Name: Acme Widgets\nSomething'), '');
});

// ---------- email ----------

test('email: the candidate\'s own, whole, or nothing', () => {
  const email = (text) => parseResume(text).email || '';
  assert.equal(email('Jane Doe\nJane.Doe@Mail.Example.'), 'jane.doe@mail.example');
  assert.equal(email('Jane Doe\nmailto:jane.doe+jobs@mail.co.uk, London'), 'jane.doe+jobs@mail.co.uk');
  // Cut in two by a narrow column: joined when the break is plain to see, otherwise left out.
  assert.equal(email('Jane Doe\njane.doe@\nmail.example\nLondon'), 'jane.doe@mail.example');
  assert.equal(email('Jane Doe\njane.doe@mail.\nexample\nLondon'), 'jane.doe@mail.example');
  assert.equal(email('Jane Doe\njane.doe@mail.example\n.co.uk'), 'jane.doe@mail.example.co.uk');
  assert.equal(email('Jane Doe\njane.doe@\nLondon, UK'), '');
  assert.equal(email('Jane Doe\njane.doe@mail.\nSenior Engineer'), '');
  assert.equal(email('Jane Doe\nReach me at jane@mail.example.\nKind regards'), 'jane@mail.example');
  assert.equal(email('Jane Doe\nTwitter: @janedoe'), '');
  assert.equal(email('Jane Doe\nReferences\nref@uni.example\nEducation\nBSc\nContact\njane@mail.example'), 'jane@mail.example');
  // An address in the work history is used only when the contact block has none.
  assert.equal(email('Jane Doe\nExperience\nAnalyst, Monzo (manager: sam@monzo.example)\nContact\njane@mail.example'), 'jane@mail.example');
  assert.equal(email('Jane Doe\nExperience\nAnalyst, Monzo\nwrite to jane@mail.example'), 'jane@mail.example');
});

// ---------- phone ----------

test('phone: found in the forms people write them', () => {
  const phone = (line) => parseResume(`Jane Doe\n${line}\njane@mail.example`).phone || '';
  for (const [line, want] of [
    ['+44 7700 900123', '+44 7700 900123'], ['+44 (0)20 7946 0991', '+44 (0)20 7946 0991'], ['(020) 7946 0991', '(020) 7946 0991'], ['07700 900123', '07700 900123'],
    ['+1 (217) 555-0142', '+1 (217) 555-0142'], ['217-555-0142', '217-555-0142'], ['217.555.0142', '217.555.0142'], ['+46 70 123 45 67', '+46 70 123 45 67'],
    ['06 12 34 56 78', '06 12 34 56 78'], ['+33 6 12 34 56 78', '+33 6 12 34 56 78'], ['0049 30 12345678', '0049 30 12345678'], ['+91 98765 43210', '+91 98765 43210'],
    ['Tel: 555 0142', '555 0142'], ['M: 07700 900123 | E: jane@mail.example', '07700 900123'], ['Phone no. 020 7946 0991', '020 7946 0991'], ['Mobile +61 412 345 678', '+61 412 345 678'],
    ['London · 07700 900123 · jane@mail.example', '07700 900123'], ['123 Main Street, Springfield, IL 62704 | (217) 555-0142', '(217) 555-0142'], ['Tel. 030/12345678', '030/12345678'],
    ['(555) 123-4567 x89', '(555) 123-4567'], ['415.555.0199 ext 12', '415.555.0199'], ['07700 900123 mobile', '07700 900123'], ['+44 7700 900123 (m), +44 20 7946 0991 (h)', '+44 7700 900123'], ['Reach me on 07700 900123 and by email', '07700 900123'],
  ]) assert.equal(phone(line), want, line);
});

test('phone: dates, postcodes and reference numbers are never taken', () => {
  const phone = (line) => parseResume(`Jane Doe\n${line}\njane@mail.example`).phone || '';
  for (const line of ['06/2019 - 08/2022', '10.2019 - 03.2023', '2019 - 2022', '2019-2022', '2015–2019', '01.03.2019 - 31.12.2022', 'Date of Birth: 12.03.1990', 'DOB 12-03-1990', '1990-03-12',
    'Invoice Number 2026-00417', 'Ref: 2026 004 170', 'Springfield, IL 62704-1234', '10115 Berlin', 'ORCID 0000-0002-1825-0097', 'ID Number: 9001015800085', 'Passport No: 123456789',
    'Fax: 020 7946 0000', 'Budget £1 200 000 000', '$12,500,000 in sales', 'Student number 201912345', 'Grew revenue 120 000 000 %', 'Managed 120 000 000 EUR', 'Aadhaar: 1234 5678 9012', 'NRIC 1234 5678 90', 'ISBN 978-3-16-148410-0', '3.8/4.0', 'Flat 12, 2019',
    'GPA 3.85 4.00 2019', '192.168.100.200', 'Shipped 100 200 300 units', '1,234,567 users', 'Sort code 20-00-00 Account 12345678', '2019-01-01 to 2020-12-31', 'GB29 NWBK 6016 1331 9268 19'])
    assert.equal(phone(line), '', line);
});

test('phone: outside the contact block only a labelled or international number counts', () => {
  const body = (line) => parseResume(`Jane Doe\njane@mail.example\nSummary\nTen years in logistics.\nExperience\nPlanner, DHL\n2019 – Present\n${line}`).phone || '';
  assert.equal(body('Handled 0800 123 4567 calls a month'), '');
  assert.equal(body('Order 4471 2290 1183'), '');
  assert.equal(body('Tel: 0161 496 0789'), '0161 496 0789');
  assert.equal(body('+44 161 496 0789'), '+44 161 496 0789');
  assert.equal(body('References\nHelen Wright\nTel: 07700 900999'), '');
});

// ---------- LinkedIn ----------

test('linkedin: whole link or nothing', () => {
  const link = (text, hints) => parseResume(`Jane Doe\n${text}`, hints).linkedin || '';
  assert.equal(link('linkedin.com/in/jane-doe'), 'https://www.linkedin.com/in/jane-doe');
  assert.equal(link('https://uk.linkedin.com/in/Jane-Doe-1a2b3c/?originalSubdomain=uk'), 'https://www.linkedin.com/in/jane-doe-1a2b3c');
  assert.equal(link('LinkedIn: www.linkedin.com/in/janedoe.'), 'https://www.linkedin.com/in/janedoe');
  assert.equal(link('(linkedin.com/in/janedoe) | London'), 'https://www.linkedin.com/in/janedoe');
  // Legacy links keep every part of their path: the number at the end is what identifies the member.
  assert.equal(link('http://www.linkedin.com/pub/john-smith/4/a12/b34'), 'https://www.linkedin.com/pub/john-smith/4/a12/b34');
  // Wrapped across lines.
  assert.equal(link('www.linkedin.com/in/rohan-\nmehta-data-engineer-\n4a81b22b (LinkedIn)\nTop Skills'), 'https://www.linkedin.com/in/rohan-mehta-data-engineer-4a81b22b');
  assert.equal(link('www.linkedin.com/in/janedoe1\n23456 (LinkedIn)'), 'https://www.linkedin.com/in/janedoe123456');
  assert.equal(link('linkedin.com/in/jane-\ndoe-1a2b3c\nLondon'), 'https://www.linkedin.com/in/jane-doe-1a2b3c');
  assert.equal(link('linkedin.com/in/\njane-doe-1a2b3c'), 'https://www.linkedin.com/in/jane-doe-1a2b3c');
  assert.equal(link('https://www.linkedin.com/in/jane-doe-\n1a2b3c/'), 'https://www.linkedin.com/in/jane-doe-1a2b3c');
  // Wrapped in the middle of a word: the next line is joined when it can only be the rest of the address.
  assert.equal(link('linkedin.com/in/rohan-mehta-da\nta-engineer-4a81b22b\nSkills'), 'https://www.linkedin.com/in/rohan-mehta-data-engineer-4a81b22b');
  assert.equal(link('linkedin.com/in/janedoe\nskills\npython'), 'https://www.linkedin.com/in/janedoe');
  assert.equal(link('linkedin.com/in/janedoe\n07700900123'), 'https://www.linkedin.com/in/janedoe');
  // When the next line may or may not belong to it, nothing is filled in, unless the file's own link says which.
  assert.equal(link('linkedin.com/in/janedoe1a\n2b3c'), '');
  assert.equal(link('linkedin.com/in/janedoe\nfull-stack'), '');
  assert.equal(link('linkedin.com/in/janedoe1a\n2b3c', { links: ['https://www.linkedin.com/in/janedoe1a2b3c'] }), 'https://www.linkedin.com/in/janedoe1a2b3c');
  // Cut off with nothing to finish it: better empty than a link that could be someone else's.
  assert.equal(link('linkedin.com/in/jane-\nSenior Engineer'), '');
  assert.equal(link('linkedin.com/in/john-'), '');
  assert.equal(link('linkedin.com/in/jo'), '');
  // Other LinkedIn pages are not a member profile.
  assert.equal(link('linkedin.com/company/acme'), '');
  assert.equal(link('www.linkedin.com/talent/profile/ACoAAB'), '');
  // A referee's profile is not the candidate's.
  assert.equal(link('References\nHelen Wright\nlinkedin.com/in/helen-wright'), '');
  // The file's own link target completes a link the page shows cut short, or only as the word "LinkedIn".
  assert.equal(link('linkedin.com/in/jane-doe-1a2', { links: ['https://www.linkedin.com/in/jane-doe-1a2b3c?trk=x'] }), 'https://www.linkedin.com/in/jane-doe-1a2b3c');
  assert.equal(link('LinkedIn | GitHub', { links: ['https://www.linkedin.com/in/jane-doe-1a2b3c/'] }), 'https://www.linkedin.com/in/jane-doe-1a2b3c');
  assert.equal(link('LinkedIn', { links: ['https://www.linkedin.com/in/jane-doe', 'https://www.linkedin.com/in/someone-else'] }), '');
});

// ---------- location ----------

test('location: only from the contact block', () => {
  const where = (text) => parseResume(text).location || '';
  assert.equal(where('Jane Doe\nLeeds, UK\njane@mail.example'), 'Leeds, UK');
  assert.equal(where('Jane Doe\njane@mail.example | Austin, Texas, United States'), 'Austin, Texas, United States');
  assert.equal(where('Jane Doe\nGreater Manchester\njane@mail.example'), 'Greater Manchester');
  assert.equal(where('Jane Doe\nBased in: Hebden Bridge\njane@mail.example'), 'Hebden Bridge');
  assert.equal(where('Jane Doe\njane@mail.example - Wollongong, NSW - 0412 345 678'), 'Wollongong, NSW');
  // Same shape, not a place.
  assert.equal(where('John Smith, PMP\njohn@mail.example'), '');
  assert.equal(where('Jane Doe\njane@mail.example\nPython, SQL, Tableau\nEnglish, Urdu'), '');
  assert.equal(where('Jane Doe\nProduct Manager, Growth\njane@mail.example'), '');
  assert.equal(where('Jane Doe\nMBA, CFA\njane@mail.example'), '');
  assert.equal(where('Jane Doe\nBSc, MSc\njane@mail.example'), '');
  assert.equal(where('JANE DOE\nLEEDS, UK\njane@mail.example'), 'LEEDS, UK');
  for (const list of ['Honest, Reliable', 'Smith, Jones', 'React, Node', 'Management, Leadership', 'Acme Ltd, Leeds', 'University of Leeds, UK']) assert.equal(where(`Jane Doe\n${list}\njane@mail.example`), '', list);
  // A place the reader does not know is taken when it ends the way an address does, or shares a line with the contact details.
  assert.equal(where('Jane Doe\nSalt Lake City, UT\njane@mail.example'), 'Salt Lake City, UT');
  assert.equal(where('Jane Doe\nHull, East Yorkshire\njane@mail.example'), 'Hull, East Yorkshire');
  assert.equal(where('Jane Doe\nChennai, Tamil Nadu\njane@mail.example'), 'Chennai, Tamil Nadu');
  assert.equal(where('Jane Doe\nHebden Bridge, Calderdale | jane@mail.example'), 'Hebden Bridge, Calderdale');
  assert.equal(where('Jane Doe\nHebden Bridge, Calderdale\njane@mail.example'), '');
  // The town out of a postal address.
  assert.equal(where('Jane Doe\nKeizersgracht 123, 1015 CJ Amsterdam\njane@mail.example'), 'Amsterdam');
  assert.equal(where('Jane Doe\n14 Shandon Street, Cork, T23 XY12 | jane@mail.example'), 'Cork');
  assert.equal(where('Jane Doe\nAddress: 12 High St, Leeds LS1 4AB\njane@mail.example'), 'Leeds');
  assert.equal(where('Jane Doe\nLocation: Remote (Denver, CO)\njane@mail.example'), 'Remote (Denver, CO)');
  assert.equal(where('Personal details\nName\tJane Doe\nAddress\tVia Roma 1, Trastevere'), 'Via Roma 1, Trastevere');
  // The employer's town, a referee's, or the university's is not where the candidate lives.
  assert.equal(where('Jane Doe\njane@mail.example\nExperience\nAcme Corporation, Chicago, IL\nEngineer, 2019 – Present'), '');
  assert.equal(where('Jane Doe\njane@mail.example\nExperience\nEngineer, Acme\nLeeds, UK\n2019 – Present'), '');
  assert.equal(where('Jane Doe\njane@mail.example\nEducation\nUniversity of Leeds\nLeeds, UK'), '');
  assert.equal(where('Jane Doe\njane@mail.example\nReferences\nGraham Pellow, CFO, Varsity Freight\nLeeds, UK'), '');
});

// ---------- current title and company ----------

test('title and company: the common ways a job is laid out', () => {
  const role = (entry) => { const r = parseResume(`Jane Doe\njane@mail.example\nExperience\n${entry}\nLed the finance function of 24 people.`); return [r.current_title || '', r.current_company || '']; };
  const want = ['Finance Director', 'Varsity Freight'];
  for (const entry of [
    'Finance Director\nVarsity Freight\nMarch 2020 – Present',
    'Varsity Freight\nFinance Director\nMarch 2020 – Present',
    'Finance Director at Varsity Freight\nMarch 2020 – Present',
    'Finance Director @ Varsity Freight (2020 – Present)',
    'Finance Director | Varsity Freight | March 2020 – Present',
    'Varsity Freight | Finance Director | 2020 - Present',
    'Finance Director – Varsity Freight\n03/2020 – Present',
    'Finance Director - Varsity Freight - Leeds, UK',
    'Finance Director, Varsity Freight\n2020 – Present',
    'Finance Director, Varsity Freight, Leeds, UK (March 2020 – Present)',
    'Varsity Freight, Leeds, UK\nFinance Director, March 2020 – Present',
    'Varsity Freight – Leeds, UK\nFinance Director\tMarch 2020 – Present',
    'Varsity Freight - Leeds\nFinance Director',
    'March 2020 – Present\nFinance Director\nVarsity Freight',
    '2020 – Present\nVarsity Freight, Leeds\nFinance Director',
    '03/2020 - Present Finance Director, Varsity Freight',
    '2020 - Present · Finance Director, Varsity Freight',
    'Mar 2020 - Present: Finance Director, Varsity Freight',
    'Finance Director\nVarsity Freight · Full-time\nMar 2020 - Present · 5 yrs 9 mos\nLeeds, England, United Kingdom · Hybrid',
    'Varsity Freight\n5 years 9 months\nFinance Director\nMar 2020 - Present',
    'Varsity Freight\tLeeds, UK\nFinance Director\tMarch 2020 – Present',
    'Company: Varsity Freight\nPosition: Finance Director\nPeriod: 2020 – Present',
    'Finance Director\nVarsity Freight, Leeds\nSince March 2020',
    'Finance Director\nMarch 2020 – Present\nVarsity Freight',
    'Varsity Freight\nFinance Director\nKey Responsibilities:',
    'Varsity Freight, Leeds\nFinance Director, Group Reporting\nMarch 2020 – Present',
    'Finance Director, Group Reporting\nVarsity Freight\nMarch 2020 – Present',
    'Finance Director, Group Reporting\nVarsity Freight, Skipton\nMarch 2020 – Present',
    'Varsity Freight — Finance Director, Group Reporting (2020 – Present)',
    'Position\tFinance Director\nEmployer\tVarsity Freight, 4 Canal Wharf, Leeds\nDates\t2020 – Present',
    'Finance Director, Varsity Freight\n2020 – Present\nPage 1 of 2',
  ]) assert.deepEqual(role(entry), want, entry);
  const other = (entry) => { const r = parseResume(`Jane Doe\nExperience\n${entry}`); return [r.current_title || '', r.current_company || '']; };
  assert.deepEqual(other('Vice President - Engineering - Acme Ltd\n2019 – Present'), ['Vice President, Engineering', 'Acme Ltd']);
  assert.deepEqual(other('Co-Founder & CEO – Tidewell\n2019 – Present'), ['Co-Founder & CEO', 'Tidewell']);
  assert.deepEqual(other('IBM\nArmonk, NY\nSenior Engineer\n2019 – Present'), ['Senior Engineer', 'IBM']);
  assert.deepEqual(other('Zipline Ghana\nKumasi\nOperations Director\n2019 – Present'), ['Operations Director', 'Zipline Ghana']);
  assert.deepEqual(other('Senior Engineer\n2019 – 2022\nResponsibilities:\nBuilt the billing system'), ['Senior Engineer', '']);
  assert.deepEqual(other('Uber Technologies, Inc.\nSenior Product Manager, Rider Experience\nSan Francisco, CA | 2019 – Present'), ['Senior Product Manager', 'Uber Technologies, Inc.']);
  assert.deepEqual(other('Solutions Architect\nAmazon Web Services (AWS) · Full-time\nJan 2019 - Present · 5 yrs'), ['Solutions Architect', 'Amazon Web Services (AWS)']);
  assert.deepEqual(other("Teacher of English (KS3–KS5), St Mary's Catholic High School, Leeds\nSeptember 2019 – present"), ['Teacher of English (KS3–KS5)', "St Mary's Catholic High School"]);
  assert.deepEqual(other('Senior Engineer, eBay\n2019 – Present'), ['Senior Engineer', 'eBay']);
  assert.deepEqual(other('eBay\nSenior Engineer\n2019 – Present'), ['Senior Engineer', 'eBay']);
  assert.deepEqual(other('Armonk, NY\nSenior Engineer, IBM\n2019 – Present'), ['Senior Engineer', 'IBM']);
  // After the title's comma: a department when the employer has the next line, the employer when it is marked as one.
  assert.deepEqual(other('Senior Vice President, Capital Markets\nCBRE\n2015 – Present'), ['Senior Vice President', 'CBRE']);
  assert.deepEqual(other('Finance Director, Varsity Freight Ltd\nNorthern Division\n2020 – Present'), ['Finance Director', 'Varsity Freight Ltd']);
});

test('title and company: left empty rather than guessed', () => {
  const role = (text) => { const r = parseResume(text); return [r.current_title || '', r.current_company || '']; };
  // A job with no employer line: the description is not the company.
  assert.deepEqual(role('Jane Doe\nExperience\nFreelance Designer\n2019 – Present\nWorked with startups on branding'), ['Freelance Designer', '']);
  assert.deepEqual(role('Jane Doe\nExperience\nFreelance Designer\n2019 – Present\n• Branding for twelve startups'), ['Freelance Designer', '']);
  // Dates and places alone are never a title or a company.
  assert.deepEqual(role('Jane Doe\nExperience\n10/2019 - 03/2023\nLeeds, UK'), ['', '']);
  // A paragraph under the heading instead of a list of jobs.
  assert.deepEqual(role('Jane Doe\nExperience\nI have spent ten years leading finance teams in logistics businesses across the north of England.'), ['', '']);
  // No work history at all.
  assert.deepEqual(role('Jane Doe\njane@mail.example\nEducation\nBSc Economics, University of York'), ['', '']);
  // A sentence that mentions a job is not a headline.
  assert.deepEqual(role('Jane Doe\nSeeking a Sales Manager position in Leeds\njane@mail.example'), ['', '']);
  assert.deepEqual(role('Jane Doe\nSales Manager\njane@mail.example'), ['Sales Manager', '']);
  // The first job listed is used, not a later one.
  assert.deepEqual(role('Jane Doe\nExperience\nHead of Design, Loom\n2021 – Present\nDesigner, Figma\n2017 – 2021'), ['Head of Design', 'Loom']);
  // Nor a later job's title when the first job's is a word the reader does not know: one job has one set of dates.
  assert.deepEqual(role('Jane Doe\nExperience\nSommelier, Hawksmoor 2019 – Present\nRestaurant Manager, Dishoom 2015 – 2019'), ['', '']);
  assert.deepEqual(role('Jane Doe\nExperience\nSommelier\n2019 – Present\nHawksmoor\nRestaurant Manager\n2015 – 2019\nDishoom'), ['', '']);
  // The line under the job is its description, not the employer, with or without a bullet.
  assert.deepEqual(role('Jane Doe\nExperience\nProjektleiterin, Telekom\nLeitung eines Teams von 8 Mitarbeitern'), ['Projektleiterin', 'Telekom']);
  assert.deepEqual(role("Jane Doe\nExperience\nCheffe de projet, Decathlon\nRefonte du parcours d'achat mobile\nConsultante, Capgemini"), ['Cheffe de projet', 'Decathlon']);
  // A date written in a way the reader does not know leaves no stray word behind as the employer.
  assert.deepEqual(role('Jane Doe\nExperience\nFinance Director   sty. 2020 – obecnie'), ['Finance Director', '']);
});

// ---------- file names ----------

test('nameFromFilename', () => {
  assert.equal(nameFromFilename('Raphael Rivero - Resume__112026.pdf'), 'Raphael Rivero');
  assert.equal(nameFromFilename('Greta Lindqvist CV (scan).pdf'), 'Greta Lindqvist');
  assert.equal(nameFromFilename('jane_doe_cv_final_v2.docx'), 'Jane Doe');
  assert.equal(nameFromFilename('Rohan_2026_Resume.pdf'), '');
  assert.equal(nameFromFilename('Profile.pdf'), '');
  assert.equal(nameFromFilename('Data Engineer Resume.pdf'), '');
  assert.equal(nameFromFilename('Job Application.pdf'), '');
  assert.equal(nameFromFilename('Cover Letter.docx'), '');
});

// ---------- reading files (the formats that need no browser) ----------

test('Word: the page header is read first, text boxes once, and a referee\'s details are never used', async () => {
  const file = docx({
    header: ['Hannah Whitfield', 'hannah.whitfield@mail.example  |  +44 7700 900555  |  Leeds, UK'],
    body: ['Professional Experience', 'Finance Director at Varsity Freight', 'March 2020 – Present', 'References', 'Graham Pellow, CFO, Varsity Freight', 'graham.pellow@varsityfreight.example, 0113 496 0200'],
  });
  const text = await extractResumeText(file);
  assert.ok(text.indexOf('Hannah Whitfield') < text.indexOf('Professional Experience'), 'header text comes before the body');
  const { fields, status, nameFromFile } = await readResume(file);
  assert.equal(status, 'ok');
  assert.equal(nameFromFile, false);
  assert.deepEqual(all(fields), all({ name: 'Hannah Whitfield', email: 'hannah.whitfield@mail.example', phone: '+44 7700 900555', location: 'Leeds, UK', current_title: 'Finance Director', current_company: 'Varsity Freight' }));
});

test('Word: with no header and only a referee to go on, the contact fields stay empty', async () => {
  const file = docx({ body: ['Professional Experience', 'Finance Director at Varsity Freight', 'References', 'Graham Pellow, CFO, Varsity Freight', 'graham.pellow@varsityfreight.example, 0113 496 0200'] }, 'cv.docx');
  const { fields } = await readResume(file);
  assert.deepEqual(all(fields), all({ current_title: 'Finance Director', current_company: 'Varsity Freight' }));
});

test('Word: a link shown only as the word "LinkedIn" or "Email" is followed to its address', async () => {
  const file = docx({
    header: ['Jane Doe', { link: 'https://www.linkedin.com/in/jane-doe-1a2b3c', text: 'LinkedIn' }],
    body: [{ link: 'mailto:jane.doe@mail.example?subject=Hello', text: 'Email me' }, { link: 'https://example.test/portfolio', text: 'Portfolio' }, 'Tab\tstops', 'Tom &amp; Jerry &#233;'],
    tabStops: true,
  });
  const text = await extractResumeText(file);
  assert.match(text, /Tab\tstops/);
  assert.match(text, /Tom & Jerry é/);
  assert.doesNotMatch(text.split('\n')[0], /\t/, 'tab stop settings are not tab characters');
  assert.equal(text.split('In a text box').length, 2, 'a text box is read once');
  assert.doesNotMatch(text, /example\.test/, 'other links are left as their text');
  const { fields } = await readResume(file);
  assert.deepEqual(all(fields), all({ name: 'Jane Doe', email: 'jane.doe@mail.example', linkedin: 'https://www.linkedin.com/in/jane-doe-1a2b3c' }));
});

test('Word: contact details in the page footer are the candidate\'s, though they come after the References', async () => {
  const file = docx({
    body: ['Tomasz Wiśniewski', 'Site Manager', 'Work Experience', 'Balfour Beatty, Manchester', 'Site Manager\tApril 2019 – Present', 'References', 'Paul Hargreaves, Contracts Director, Balfour Beatty, paul.hargreaves@bb.example, 0161 496 0333'],
    footer: ['tomasz.wisniewski@mail.example  •  07700 900618  •  Salford, Greater Manchester'],
  });
  const { fields } = await readResume(file);
  assert.deepEqual(all(fields), all({ name: 'Tomasz Wiśniewski', email: 'tomasz.wisniewski@mail.example', phone: '07700 900618', location: 'Salford, Greater Manchester', current_title: 'Site Manager', current_company: 'Balfour Beatty' }));
});

test('Word: list items are read as bullets, so the line under a job is its description and not the employer', async () => {
  const file = docx({ body: ['Jane Doe', 'jane.doe@mail.example', 'Experience', 'Finance Director, Varsity Freight', { bullet: 'Northern Division' }, { bullet: 'Group Reporting' }, 'Education', 'BSc Economics'] });
  assert.match(await extractResumeText(file), /\n• Northern Division\n• Group Reporting\n/);
  const { fields } = await readResume(file);
  assert.deepEqual(all(fields), all({ name: 'Jane Doe', email: 'jane.doe@mail.example', current_title: 'Finance Director', current_company: 'Varsity Freight' }));
});

test('RTF from a word processor: font, colour and style tables are not text', async () => {
  const text = await extractResumeText(rtfFile(String.raw`{\rtf1\ansi\deff4\adeflang1025
{\fonttbl{\f0\froman\fprq2\fcharset0 Times New Roman;}{\f1\froman\fprq2\fcharset2 Symbol;}{\f3\froman\fprq2\fcharset0 Liberation Serif{\*\falt Times New Roman};}}
{\colortbl;\red0\green0\blue0;\red0\green0\blue255;}
{\stylesheet{\s0\snext0\rtlch\af10\afs22 Normal;}{\s1\sbasedon0\snext0 Heading 1;}}
{\*\generator LibreOffice/7.4}{\info{\author Someone Else}{\creatim\yr2026\mo11\dy10\hr0\min7}}
\paperw12240\paperh15840
{\pard\plain \s1\b\fs44 Hannah Whitfield\par}
{\pard\plain hannah.whitfield@mail.example  |  +44 7700 900555  |  Leeds, UK\par}
{\pard\plain \b Professional Experience\par}
{\pard\plain Varsity Freight, Leeds, UK\par}
{\pard\plain Finance Director, March 2020 \u8211\'96 Present\par}
{\pard\plain {\field{\*\fldinst{HYPERLINK "https://example.test/"}}{\fldrslt{Portfolio}}}\line second line\par}
}`));
  assert.deepEqual(text.split('\n').map((l) => l.trim()).filter(Boolean), [
    'Hannah Whitfield', 'hannah.whitfield@mail.example  |  +44 7700 900555  |  Leeds, UK', 'Professional Experience', 'Varsity Freight, Leeds, UK', 'Finance Director, March 2020 – Present', 'Portfolio', 'second line',
  ]);
  assert.deepEqual(all(parseResume(text)), all({ name: 'Hannah Whitfield', email: 'hannah.whitfield@mail.example', phone: '+44 7700 900555', location: 'Leeds, UK', current_title: 'Finance Director', current_company: 'Varsity Freight' }));
});

test('RTF from TextEdit: accented letters are kept and a bare backslash ends the line', async () => {
  const file = rtfFile('{\\rtf1\\ansi\\ansicpg1252\\cocoartf2709\n\\cocoatextscaling0\\cocoaplatform0{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;\\f1\\fswiss\\fcharset0 Helvetica-Bold;}\n{\\colortbl;\\red255\\green255\\blue255;}\n{\\*\\expandedcolortbl;;}\n\\paperw11900\\paperh16840\\margl1440\\margr1440\\vieww11520\\viewh8400\\viewkind0\n\\pard\\tx566\\tx1133\\pardirnatural\\partightenfactor0\n\n\\f1\\b\\fs36 \\cf0 Zo\\\'eb Bront\\\'eb\\\n\\f0\\b0\\fs24 zoe.bronte@mail.example\\\n+44 7700 900777\\\n\\\nExperience\\\nEditor at Caf\\\'e9 M\\\'e9dia\\\n2019 \\\'96 Present \\{now\\} \\u26085 ?\\u-10179 ?\\u-8704 ?\\\n}');
  const text = await extractResumeText(file);
  assert.deepEqual(text.split('\n').filter(Boolean), ['Zoë Brontë', 'zoe.bronte@mail.example', '+44 7700 900777', 'Experience', 'Editor at Café Média', '2019 – Present {now} 日😀']);
  const { fields } = await readResume(file);
  assert.deepEqual(all(fields), all({ name: 'Zoë Brontë', email: 'zoe.bronte@mail.example', phone: '+44 7700 900777', current_title: 'Editor', current_company: 'Café Média' }));
});

test('RTF in another Windows code page: the letters are decoded with the page the file names', async () => {
  const text = await extractResumeText(rtfFile(String.raw`{\rtf1\ansi\ansicpg1250\deff0{\fonttbl{\f0\fswiss\fcharset238 Calibri;}}\pard\f0 Tomasz Wi\'9cniewski\par \'8a\'f3d\'9f, Polska\par}`));
  assert.deepEqual(text.split('\n').map((l) => l.trim()).filter(Boolean), ['Tomasz Wiśniewski', 'Šódź, Polska']);
});

test('text files saved by Windows: UTF-16 and the Windows code page are read, not garbled', async () => {
  const utf16 = textFile('Siobhán Ní Bhriain\nsiobhan@mail.example', 'utf16le');
  assert.equal((await readResume(utf16)).fields.name, 'Siobhán Ní Bhriain');
  const latin = textFile('Zoë Brontë\nzoe@mail.example\nExperience\nEditor, Café Média\n2019 – Present', 'latin1');
  assert.deepEqual(all((await readResume(latin)).fields), all({ name: 'Zoë Brontë', email: 'zoe@mail.example', current_title: 'Editor', current_company: 'Café Média' }));
});

// ---------- somebody else's details, and numbers that are not phones ----------

reads('agency cover sheet: the consultant\'s address and number are not the candidate\'s', `Michael Page
Candidate Profile
Ref: MP-203948
Consultant: Sarah Lee, sarah.lee@michaelpage.example, 020 7946 0000

Candidate: Daniel Okafor
Current role: Finance Director

Experience
Finance Director, Varsity Freight
2020 - Present`,
{ name: 'Daniel Okafor', current_title: 'Finance Director', current_company: 'Varsity Freight' });

reads('agency cover sheet: "Prepared by" and the contact line under it', `CONFIDENTIAL CANDIDATE PROFILE
Prepared by Tom Reid, Senior Consultant
T: 020 7946 0100  E: tom.reid@harboursearch.example

Candidate: JW-1042
Current role: Operations Director

Career History
Operations Director, DHL Supply Chain
2019 - Present`,
{ current_title: 'Operations Director', current_company: 'DHL Supply Chain' });

for (const heading of ['Referee Details', 'My References', 'Work References', 'Reference Contacts', 'Referees (with permission)', 'REFEREES & CONTACTS', 'Two References']) {
  reads(`a referee's phone under "${heading}" is not the candidate's`, `Emma Stone
emma.stone@mail.example

Experience
Staff Nurse, St Mary's Hospital
2018 - Present

${heading}
Dr Alan Grant, Consultant
alan.grant@hospital.example
Tel: +44 20 7946 0999`,
  { name: 'Emma Stone', email: 'emma.stone@mail.example', current_title: 'Staff Nurse', current_company: "St Mary's Hospital" });
}

reads('a headline that is only a job word does not make the contact line somebody else\'s', `Jane Doe
Consultant | jane.doe@mail.example | 07700 900123`,
{ name: 'Jane Doe', email: 'jane.doe@mail.example', phone: '07700 900123', current_title: 'Consultant' });

reads('an apostrophe is part of the address', `Shane O'Neil
shane.o'neil@mail.example`, { name: "Shane O'Neil", email: "shane.o'neil@mail.example" });
reads('an address with accented letters is left out, not cut down to another address', `José García
josé.garcía@mail.example`, {});
reads('an address with a curly apostrophe is left out', `Shane O’Neil
shane.o’neil@mail.example`, {});

reads('the first half of a numeric email address is not the phone', `Wang Xiaoming
1234567890@qq.com | 138 0013 8000
Beijing, China`, { name: 'Wang Xiaoming', email: '1234567890@qq.com', phone: '138 0013 8000', location: 'Beijing, China' });
for (const line of ['Social Security: 123-45-6789', 'Matrikelnummer 123456789', 'UTR 12345 67890', 'GitHub stars 123 456 789', 'NI: 12 34 56 78 9']) {
  reads(`not a phone: ${line}`, `John Carter\n${line}\njohn.carter@mail.example`, { name: 'John Carter', email: 'john.carter@mail.example' });
}
for (const number of ['415-555-0142', '98765 43210', '612 345 678', '020 7946 0123', '(217) 555-0142', '4155550142']) {
  reads(`a phone without a label, in a national form: ${number}`, `John Carter\njohn.carter@mail.example\n${number}`, { name: 'John Carter', email: 'john.carter@mail.example', phone: number });
}
reads('which phone it is ("Home:") is not a label for something else', `John Carter\njohn.carter@mail.example\nHome: 020 7946 0123`, { name: 'John Carter', email: 'john.carter@mail.example', phone: '020 7946 0123' });

// ---------- title, name and place: the layouts the reader used to get wrong ----------

reads('jobs listed oldest first: the one that runs to the present', `Olivia Brown
olivia.brown@mail.example

Experience
2010 - 2014  Junior Developer, Acme Corp
2014 - 2018  Developer, Globex Ltd
2018 - Present  Lead Developer, Initech`,
{ name: 'Olivia Brown', email: 'olivia.brown@mail.example', current_title: 'Lead Developer', current_company: 'Initech' });

reads('jobs listed oldest first over several lines each: nothing rather than the oldest', `Olivia Brown
olivia.brown@mail.example

Experience
Junior Developer
Acme Corp
2010 - 2014
Lead Developer
Initech
2018 - Present`,
{ name: 'Olivia Brown', email: 'olivia.brown@mail.example' });

reads('a society is the organisation, the office held is the title', `Nina Park
nina.park@mail.example

Experience
University of Leeds Finance Society
Treasurer
2023 - 2024`,
{ name: 'Nina Park', email: 'nina.park@mail.example', current_title: 'Treasurer', current_company: 'University of Leeds Finance Society' });

reads('a headline about what the person used to be is not their current title', `Nina Park
Former Director of Marketing at Acme
nina.park@mail.example`, { name: 'Nina Park', email: 'nina.park@mail.example' });
reads('nor is what they hope to be', `Nina Park
Aspiring Product Manager | MBA Candidate
nina.park@mail.example`, { name: 'Nina Park', email: 'nina.park@mail.example' });

reads('"WORK" is a heading, and an employer with a year is not a town', `Priya Nair
priya.nair@mail.example | 07700 900111
WORK
Deloitte UK 2021
Senior Consultant
KPMG India 2018
Consultant`,
{ name: 'Priya Nair', email: 'priya.nair@mail.example', phone: '07700 900111', current_title: 'Senior Consultant', current_company: 'Deloitte UK' });

reads('a reversed name on the first line is not a place', `Smith, John · coolguy82@mail.example · 555-201-3344`, { email: 'coolguy82@mail.example', phone: '555-201-3344' });
reads('nationality and religion are not a place', `Ravi Kumar
ravi.kumar@mail.example

Personal Details
Indian, Hindu`, { name: 'Ravi Kumar', email: 'ravi.kumar@mail.example' });

reads('letters after a name are dropped', `Alex Morgan MD\nalex.morgan@mail.example`, { name: 'Alex Morgan', email: 'alex.morgan@mail.example' });
reads('a name in capitals keeps its Mc', `FIONA MCDONALD\nfiona.mcdonald@mail.example`, { name: 'Fiona McDonald', email: 'fiona.mcdonald@mail.example' });
reads('one word shared with the file name does not choose the name', `Barclays Wealth
Application for Relationship Manager

Daniel Okafor
daniel@mail.example`, { name: 'Daniel Okafor', email: 'daniel@mail.example' }, { filename: 'Barclays_CV.pdf' });

test('file names that are not names give no name', () => {
  for (const name of ['Untitled document.pdf', 'Scanned Document.pdf', 'Black White Minimalist CV Resume.pdf', 'CV English Version.pdf', 'big-8mb.txt', '履歴書_山田太郎.pdf', 'New York Office.pdf']) assert.equal(nameFromFilename(name), '', name);
  assert.equal(nameFromFilename('Lebenslauf Max Mustermann.pdf'), 'Max Mustermann');
});

test('one long unbroken run of digits or letters does not stall the reader', () => {
  const started = Date.now();
  assert.deepEqual(parseResume(`Jane Doe\n${'7'.repeat(40000)}\njane.doe@mail.example`), { name: 'Jane Doe', email: 'jane.doe@mail.example' });
  parseResume(`Jane Doe\n${'a'.repeat(200000)}`);
  parseResume(`Jane Doe\n${'QUJD'.repeat(25000)}`);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

test('a Word file made to be slow or huge is read quickly or refused', async () => {
  const started = Date.now();
  // Unclosed tags, 300,000 of them: every "find the closing tag" used to start again from each one.
  assert.match(await extractResumeText(docx({ body: ['Jane Doe', '<w:tabs>'.repeat(300000)] })), /^Jane Doe/);
  assert.match(await extractResumeText(docx({ body: ['Jane Doe', '<w:tab '.repeat(200000)] })), /^Jane Doe/);
  assert.match(await extractResumeText(docx({ body: ['Jane Doe', '<w:hyperlink r:id="rId1">'.repeat(100000)] })), /^Jane Doe/);
  // A part that unpacks to far more than any document holds is not unpacked at all.
  await assert.rejects(extractResumeText(docx({ body: ['a'.repeat(9 * 1024 * 1024)] })), /more than can be read/);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test('a file is read as what its first bytes say it is, whatever its name', async () => {
  const word = docx({ body: ['Jane Doe', 'jane.doe@mail.example'] });
  const renamed = new File([await word.arrayBuffer()], 'jane.txt');
  assert.equal((await extractResumeText(renamed)).trim(), 'Jane Doe\njane.doe@mail.example');
  assert.deepEqual((await readResume(renamed)).fields, { name: 'Jane Doe', email: 'jane.doe@mail.example' });
});

test('files that cannot be read say why, and fall back to the file name for the name only', async () => {
  const doc = await readResume(new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])], 'Greta Lindqvist CV.doc'));
  assert.deepEqual(doc, { fields: { name: 'Greta Lindqvist' }, status: 'unreadable', nameFromFile: true });
  const empty = await readResume(new File([''], 'notes.txt'));
  assert.deepEqual(empty, { fields: {}, status: 'empty', nameFromFile: false });
  // Another kind of file under a text name is not shown or parsed as text.
  const picture = await readResume(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0])], 'notes.txt'));
  assert.deepEqual(picture, { fields: {}, status: 'binary', nameFromFile: false });
  assert.equal(await extractResumeText(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])], 'cv.txt')), '');
  const blank = await readResume(new File(['  \n '], 'notes.txt'));
  assert.equal(blank.status, 'blank');
  const broken = await readResume(new File([new Uint8Array(64)], 'Jane Doe.docx'));
  assert.equal(broken.status, 'error');
  assert.deepEqual(broken.fields, { name: 'Jane Doe' });
  // What went wrong is handed back, so the caller can tell a file that will not open from a reader that did not load.
  assert.ok(broken.error instanceof Error);
  assert.equal('error' in doc, false);
  const unloaded = await readResume({ name: 'Jane Doe.pdf', arrayBuffer: async () => { throw new TypeError('Failed to fetch dynamically imported module'); } });
  assert.equal(unloaded.status, 'error');
  assert.match(unloaded.error.message, /dynamically imported module/);
  const locked = await readResume({ name: 'cv.pdf', arrayBuffer: async () => { throw Object.assign(new Error('No password given'), { name: 'PasswordException' }); } });
  assert.equal(locked.status, 'protected');
  assert.equal(locked.error.name, 'PasswordException');
});
