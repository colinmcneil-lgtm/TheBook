# The Book

A hiring workspace for an embedded recruitment agency: one place to run inbound applicants, pipelines,
interviews and reporting for every company you work inside, with a login for each client's hiring team.

Your agency name is set at first sign-in and shown throughout the workspace.

![Dashboard](docs/screenshots/dashboard.png)

## What it does

| Area | What you get |
| --- | --- |
| **Clients** | Each company you embed in has its own jobs, candidates, hiring-team logins, brand colour and engagement terms (retainer, fee per hire, or both). A switcher scopes the whole workspace to one client or all of them. |
| **Careers pages** | Every client gets a public, branded careers page at `/careers/<client>` listing open roles, each with an application form (résumé upload, custom screening questions, consent). Link to it from the client's website. Add `?src=linkedin`, `?src=job_board` or `?src=referral` to an apply link to track where applicants came from. |
| **Recruiter brief** | Each job opens on a brief for your recruiters: about the role, must-haves, nice-to-haves, who is not a fit, companies and places to look, job titles and keywords with a ready-made search string (one click to search LinkedIn or Google), pay and room to move, your fee, selling points, first-call questions and process notes. The person who created the job (or an admin) edits it; the rest of the team reads it; clients never see it. |
| **Job autofill** | When adding a job, paste or drop in the client's job description and your intake call notes or transcript, and the job and its recruiter brief are filled in for you to review. With an Anthropic API key connected, Claude drafts everything, including the brief from the call. Without one, the details a job description states outright are picked up (title, location, salary, requirement lists). |
| **The Oracle** | Record a call with a candidate in the browser, or upload a recording. The call is written out with who said what, a notes summary is drafted, and one click drafts the write-up for the hiring team. A call can be recorded first and added to a candidate afterwards. Agency only. See [The Oracle](#the-oracle). |
| **Inbox** | Every new application across all clients lands in one review queue, oldest first. |
| **Pipeline** | A drag-and-drop board per job with stages you define. Ratings, notes (optionally agency-only), rejection reasons, withdrawals, offers. |
| **Shortlist hand-off** | Submit a candidate to the hiring team with your write-up. They approve (the candidate moves to the next interview stage) or decline with a reason, so you can calibrate. |
| **Interviews** | Schedule with a panel, download a calendar file, and collect a structured scorecard from each interviewer against the criteria set on the job. Outstanding scorecards are chased in the sidebar and dashboard. |
| **Your calendar** | Each recruiter can connect their own calendar to The Oracle with a private link. Their day is shown with The Book's interviews in it, each event says which candidate it is probably with, and "+ Add" marks the ones to record. Agency only. See [Your calendar in The Oracle](#your-calendar-in-the-oracle). |
| **Email** | Templates with merge fields; every message is recorded on the candidate. Application confirmations, interview invitations and rejections can be sent automatically. |
| **Reports** | Funnel conversion, source effectiveness, weekly application volume, time to hire, open-role ageing and hires. Printable for client reviews. Your retainer and placement-fee revenue is shown to your agency only. |
| **Access** | Agency admins and recruiters see every client. Client users see only their own company, and never see your fees, internal brief or agency-only notes. |
| **Accounts** | Send a one-time invitation link (from a client's page or Settings, Team) and the person sets their own password. Or people can use "Create an account" on the sign-in page to ask for access: nothing is granted until you approve the request and choose which client's hiring team it joins, and the person then sets their password from a one-time link sent to the address they gave. |

## Accounts and getting back in

- **Invitations.** A link works once, for 7 days, and can be tied to one email address. It stops working if the
  person who created it is deactivated (their unused links are removed), and a link that grants agency access
  also needs its creator to still be an admin.
- **Account requests.** "Create an account" on the sign-in page takes a name, email, company and job title, and no
  password. A request cannot sign in and is not an account. When you approve it, it becomes an invitation tied to
  that email address: with email connected the person is sent the link, otherwise you are shown the link to pass
  on yourself. Either way the password is chosen by whoever opens the link, not by whoever filled in the form.
  Requests nobody answers are removed after 14 days, and sign-up pauses while 200 are waiting.
- **Forgotten password.** Deactivate the account (Settings, Team), then invite the person again at the same email
  address. Accepting that invitation brings the same account back with a new password and the access chosen on
  the invitation; everything it did before stays attributed to it. Only an invitation tied to that exact address
  can do this.
- **Someone has left.** Deactivate them. They are signed out everywhere, their unused invitation links stop
  working, and candidates they own stay under their name (shown as deactivated in the owner filter) until you
  reassign them.

## Who counts as the same person

Within one client, a person is recognised by their **email address**, or failing that by their **LinkedIn profile
link** (`linkedin.com/in/<name>`, stored in one form however it was copied). No other link identifies anyone: a
GitHub page, a personal site, a company's team page, a LinkedIn Recruiter or Sales Navigator address and the old
`linkedin.com/pub/...` form are kept for reference only, because many people can share one.

- Adding someone whose email or LinkedIn link is already on a record at that client adds them to that record
  (and says so) rather than creating a second one.
- If the LinkedIn link is on a record with a plainly different name, nothing is merged: you are shown the
  existing record and asked to open it or check the link.
- The public application form never joins an applicant to an existing record by link, since anyone can type any
  link there. If the link matches someone already on file, both records are kept, each profile shows
  "Possible duplicate", and an agency user can merge them. Merging moves every application, note, interview and
  email onto the record you keep.

## The Oracle

The Oracle is where recruiters record their calls with candidates.

1. **Record or upload.** A recruiter records the call in the browser, or uploads a recording made elsewhere (MP3,
   M4A, MP4, WAV, WebM or Ogg, up to 200 MB).
   A browser recording is sent to the server in small pieces during the call and each piece is saved as it arrives,
   so a dropped connection, a reloaded page or a restart of the server does not lose what was already recorded. A
   recording can run for 3 hours, counted from when it started. The recruiter is warned ten minutes before, and at
   3 hours the recording is stopped and saved; to carry on, they start a new one. An upload shows how far it has
   got and can be cancelled; it may take up to an hour to send.
2. **Transcript.** The audio is written out as text with the speakers told apart and a time on every turn.
3. **Notes.** A summary is drafted under headings a recruiter would use: background, why they are looking, relevant
   experience, pay, notice period, location, other processes, concerns to probe, next steps. Only what was said on
   the call goes in, and figures are kept as they were said. The recruiter can edit the notes and save them onto the
   candidate's profile as an agency-only note. If the notes cannot be written, the call says why and offers to try
   again; the recruiter can always write their own.
4. **Submission draft.** For a call that is on a candidate, one click drafts the write-up that goes to the client's
   hiring team. It is written to be read by the client: no fees, nothing copied from your private brief, no other
   clients, no names of other companies the candidate is talking to, nothing they said in confidence about their
   employer, and nothing personal (health, pregnancy or family plans, caring responsibilities, disability, age,
   religion, ethnicity, sexuality, immigration status): a gap or a need for flexibility is described neutrally. The
   notes mark such points "(personal: not for the client)". The recruiter reviews the draft before anything is
   sent, and once it has been sent the call says so and when.

A call can be recorded with no candidate chosen and added to one afterwards: the call's page and the list of calls
both have "Add to a candidate", which also offers to add someone who is not in The Book yet. A call put on the wrong
person can be moved: a title the call was given automatically changes to the new person's name, and the notes saved
on the first person's profile from that call are removed from it. Client users never see calls, audio, transcripts
or notes, or the line on a candidate's history that says a call was recorded.

### Recording a call

- Press **Record now** on The Oracle, or **Record a call** on the Calls tab of a candidate's profile, which starts
  with that person and job already chosen.
- By default only the recruiter's microphone is recorded. For a call held in Google Meet, Zoom or Teams in a browser
  tab, press **Add the other side of the call**, choose that tab and tick "Also share tab audio". For a call on a
  phone or in a desktop app, put it on speaker so the microphone hears both sides.
- A red strip with the time, Pause and Stop stays at the top of every page, so the recruiter can open the
  candidate's profile or anything else in The Book while the call is recorded. Stop pressed on The Oracle opens the
  call; pressed from the strip anywhere else it saves the call and leaves the recruiter where they are.
- Closing or reloading the tab ends the recording; the browser asks first. Whatever had been recorded, up to the
  last few seconds, is saved the next time The Book is opened in that browser (or within about twenty seconds, if
  another tab of The Book is open there), and the call's page says it was cut off. If the connection drops, or the
  server restarts, recording carries on and the missing part is sent when the connection is back.
- Audio that has not reached the server yet is kept in the browser until the server has it. If that browser is
  away for more than a day, the server saves the call from what it has, and still takes the rest for a week after
  that: when the browser comes back, the call becomes the whole recording. If the browser is gone for good (another
  computer, cleared browsing data), the person who recorded the call, or an admin, can press **Save what was
  recorded** on the call's page.
- Several recruiters can use one computer: each person's unsent audio waits for them and is sent when they next sign
  in there.
- If the browser's own recorder stops working in the middle of a call, the page says so, saves the call up to that
  point and asks the recruiter to start a new recording.

### The two keys

| Setting | What it turns on | Without it |
| --- | --- | --- |
| `DEEPGRAM_API_KEY` | Transcription. The audio is sent to [Deepgram](https://deepgram.com), which returns the words with the speakers told apart. Create an account and an API key there. | Calls are still recorded, kept and played back. The recruiter can paste in a transcript (lines such as `Priya: ...` become speaker turns), and everything else works from that. |
| `ANTHROPIC_API_KEY` | The notes summary and the submission draft, written by Claude from the transcript. This is the same key job autofill uses. | Transcripts still work. The recruiter writes the notes and the write-up by hand. |

Claude cannot listen to audio, which is why transcription needs a service of its own. Optional settings:
`ORACLE_MODEL` chooses a different Claude model for the Oracle (it otherwise follows `AUTOFILL_MODEL`, then
`claude-opus-5-5`); `DEEPGRAM_LANGUAGE` sets the language of the calls (default `en`); `DEEPGRAM_API_URL` points at
another Deepgram address, for example `https://api.eu.deepgram.com/v1/listen` to have audio processed in the EU.
A request for notes or a draft that gets no answer is given up on after three minutes and one more try
(`ORACLE_AI_TIMEOUT_MS` changes the three minutes); transcription is given up on after about five minutes and one
more try. Either way the call says what happened and can be tried again.

Recording needs the workspace to be served over HTTPS: browsers only allow the microphone on secure pages.

### Where audio is kept

Finished audio is a file in `DATA_DIR/uploads`, next to résumés and photos (its name starts with `call-`). While a
call is being recorded its pieces sit in `DATA_DIR/recordings`; they are removed when the call is stopped, or a
week after the server saved a call that was cut off (see above). Both are on the same persistent disk as the
database, so the back-up that covers `DATA_DIR` covers them. An hour of recorded speech is about 15 MB; uploads are whatever
size the file is. Transcripts and notes are in the database.

### What is sent outside your server

- **To Deepgram:** the audio of a call, once, when it is transcribed. Every request asks Deepgram not to keep the
  audio or transcript and not to use them to train its models (`mip_opt_out`).
- **To Anthropic:** the transcript, the notes, the recruiter's name, and the candidate's and job's details (name,
  current job, the advert, the must-haves and ideal profile from your brief). Your fee and the rest of the brief are
  never sent.

### Consent to recording

A call with a candidate is personal data, and in many places it is against the law to record a call unless everyone
on it has agreed. The Book does not announce the recording to the candidate: the recruiter has to tell them and get
their agreement. Before every recording and every upload the recruiter must confirm that everyone on the call has
agreed, and the workspace stores who confirmed it, when, and the sentence they ticked. A recording cannot be started
without that sentence; an upload sent without one is recorded against the standard sentence ("Everyone on this call
knew it was being recorded and agreed."). Nothing is recorded or kept without that. Check what the law requires where you and your candidates are, and say in your privacy notice that
calls may be recorded and transcribed.

"Delete candidate data" on a profile also deletes that person's calls: the audio, the transcripts and the notes.
Merging two records of the same person moves their calls to the record you keep. A call can be deleted on its own
by the person who recorded it or by an admin. Nothing is deleted automatically after a set time: calls are kept
until someone deletes them, so decide how long you keep them and clear out older ones.

### What it costs

Both services bill the account whose key you set, per use. These figures are estimates gathered in November 2026,
not quotes; check the providers' pricing pages.

- **Deepgram:** its pricing page could not be read while this was built, and the published figures found elsewhere
  disagree. Plan for roughly $0.26 to $0.38 per hour of audio. Asking Deepgram not to keep or train on the audio,
  which the Oracle always does, may put the rate up.
- **Claude:** an hour-long call is about 9,000 words. At the published price of `claude-opus-5-5` ($4 per million
  tokens read, $20 per million written) the notes for such a call should cost in the region of 10 to 20 US cents,
  and each submission draft about the same. This is worked out from the prices, not measured.

Each recruiter can ask for 40 AI drafts an hour, so a mistake cannot run up a bill.

### Before you rely on it

The transcription request follows Deepgram's published description exactly, but Deepgram could not be reached from
where this was built, so it has only been run against a stand-in that answers the way the description says. Before
going live, record a one-minute call with two people in Chrome and in Safari with a real key and check that the
transcript comes back with two speakers. The notes and submission drafts were likewise only run against a stand-in
for Claude, so read the first few real ones closely.

Recording was tested in Chrome only. Edge, Safari, Firefox and phones have not been
tried, and neither has a real call of an hour or more. The cases where a day or a week passes (the server saving a
call by itself, a browser coming back later with the rest) were run by putting the clock back, not by waiting.

## Your calendar in The Oracle

A recruiter's day, in the same place they record their calls: the events from their own calendar and The Book's
interviews in one list, each with the candidate it is probably with, a button to join or call, and "+ Add" to mark
the ones to record. Nothing has to be set up on the server, and nobody registers an app with Google or Microsoft:
each recruiter pastes one private link from their calendar.

### Getting your link

The steps below are as Google, Microsoft and Apple describe them. They were not tried while this was built (see
[Before you rely on it](#before-you-rely-on-the-calendar)).

- **Google Calendar** (on a computer, not the phone app): open Google Calendar, click the gear, then **Settings**.
  In the left column, under **Settings for my calendars**, click your calendar's name, then **Integrate calendar**.
  Copy the link under **Secret address in iCal format**. If your agency uses Google Workspace and that field is not
  there, an administrator has to change one setting first: Admin console, Apps, Google Workspace, Calendar,
  **Sharing settings**, **External sharing options for primary calendars**, and choose "Share all information, but
  outsiders cannot change calendars". Google says this can take up to 24 hours to appear. Changing it publishes
  nothing by itself: a calendar can only be read by someone who has its secret link.
- **Outlook / Microsoft 365** (Outlook on the web): click the gear, then **Calendar**, then **Shared calendars**.
  Under **Publish a calendar** choose your calendar and **Can view all details**, then **Publish**. Click the **ICS**
  link that appears and choose **Copy link**. With a lower level of detail every event is just called "Busy". If
  "Publish a calendar" is missing, your Microsoft 365 administrator has switched it off (Exchange admin center,
  Organization, Individual Sharing: the sharing policy needs the domain "Anonymous"). Outlook publishes three months
  back and three months ahead, and its published link very probably leaves out the guest list, so events from
  Outlook are matched to candidates by name and phone number, not by e-mail address.
- **Apple iCloud**: at icloud.com/calendar, click the sharing control beside the calendar, turn on **Public
  Calendar** and copy the link (it starts `webcal://`, which is fine). On an iPhone: Calendar, Calendars, the (i)
  beside the calendar, Public Calendar, Share Link.

Paste the link into The Oracle. The Book reads the calendar once before accepting the link, and says plainly what
is wrong if it cannot. One calendar per person; to use another, paste its link in place of the first.

**Treat the link like a password.** Anyone who has it can read that calendar. The Book stores it sealed, never
shows it again (not to you, not to an admin) and never writes it to a log. To take access away, remove the link in
The Oracle, and to be sure, also reset it where it came from: **Reset** beside the secret address in Google,
**Unpublish** in Outlook, or turn Public Calendar off in iCloud.

### What the day shows

- The events of the chosen day on the recruiter's own clock, wherever the server runs, including the days when the
  clocks change. Cancelled events, and single dates of a repeating event that were cancelled or deleted, are left out.
- **The Book's own interviews** for that person (candidates they own, interviews they scheduled or sit on the
  panel of), with the candidate already known. When a calendar event is plainly the same meeting as one of those
  (same candidate, within ten minutes), it is shown once, as the interview, with the calendar's link to join.
- **The link to join**, when the event has one for Google Meet, Zoom, Microsoft Teams or Webex. No other kind of
  link is ever offered, so an invitation cannot put an arbitrary link behind a button.
- **A phone number**, when the event names a person's number. Numbers that belong to a meeting's dial-in
  instructions are recognised and ignored.
- **Who it is with.** In this order: a guest's e-mail address that is a candidate's; a phone number in the event
  that is a candidate's; a candidate's exact full name in the title or as a guest's name (accents and capitals do
  not matter). Anything weaker is only offered as a suggestion and never chosen: "Call Kevin" with two Kevins on
  file asks which one, and with one Kevin on file still only offers him. The same goes for two candidates among the
  guests, two people with one name, and one person on file at two clients and in progress at both. The recruiter
  can always choose the candidate themselves, and their choice wins.
- **"+ Add"** marks an event to be recorded. The mark stays with the event when it is renamed or moved, and a call
  recorded from an event is shown on it afterwards.

A recruiter only ever sees and changes their own day. Client users see none of this.

### How fresh it is

The Book reads a calendar at most once every five minutes while its owner is looking at their day, and the day can
be asked to read it again at once. If the calendar cannot be reached, the last copy is shown for up to six hours with a line
saying why and how old it is. How quickly Google, Outlook and iCloud put a new event into their links is theirs to
decide and could not be measured here.

### What is kept, and where

- The link, sealed with a key that the server makes on first use and keeps in `DATA_DIR/server-secret`. Back the
  data folder up as a whole. If that file is lost, saved links can no longer be opened and are pasted in again;
  nothing else is affected.
- For each event a person has been shown: its key (meaningless outside The Book and different for each person),
  the day it was on, and whether it was added, given a candidate or recorded. No titles, guests, descriptions or
  times from the calendar are stored. Events nobody did anything with are forgotten after 30 days.
- The calendar itself is held in memory only, and dropped when its link is removed. Descriptions and locations
  never leave the server; the day view sends titles, times, guests, the link to join and the phone number.
- Removing the link removes all of the above for that person's calendar events.

### Safety

A pasted link makes the server fetch an address somebody typed, so the reader is strict: https only, the standard
port only, no private, loopback or link-local addresses (checked for every address the name has, again on every
redirect, and the connection is made to exactly the address that was checked), at most five redirects, no cookies,
10 MB and 15 seconds at most, and what comes back has to be a calendar. Saving a link can be tried twelve times an
hour per person. Everything inside an event is text a stranger may have written (anyone can send an invitation):
it is cut to length before it is looked at, shown as text only, and large calendars are read on a thread of their
own so that reading one never holds up anybody else.

### Limits

- A day shows at most 150 events from the calendar; a calendar over 10 MB is not read.
- A repeating event changed "from this date onwards" keeps its marks when the calendar gives the later dates a new
  identity but the same title and time (as Google does). If the time changed too, the mark on a later date is lost.
  Calendars that write such a change in the standard's other form (rare) are only read for the first changed
  date, and the day says so.
- A time zone that is neither a real one nor properly defined in the calendar is shown exactly as written, with a
  line saying so.
- Dates added to a repeating event one by one (the standard's `RDATE`) are not shown.
- The reader connects directly and ignores any outbound proxy.

### Before you rely on the calendar

No real Google, Outlook or iCloud link could be fetched from where this was built: those services were not
reachable, and no account was available. The reader was tested against calendar files written to look like what
they publish, and against local servers playing every trick the reader has to refuse. So, with the first real link:

1. Create an event with a guest and a Meet or Teams link, paste the calendar's link into The Oracle, and check
   that the event appears with its guest, its link to join and the right time. Note how long a new event takes to
   show up when the day is read again.
2. If the guests are missing (expected for Outlook), matching will rest on names and phone numbers.
3. If the day shows a line about a time zone it does not know, send that event's details to whoever maintains this.
4. Whether Railway's network reaches Google and Microsoft over IPv6 as well as IPv4 does not matter to the reader
   (it tries every address a name has), but a live IPv6 connection was never exercised.

The calendar tests are part of `npm test`. They start servers on five ports from `CALENDAR_TEST_PORT` (3640 unless
set). To let the real API be tested on calendar files, the server reads links to `https://calendar.test/<name>.ics`
from the folder named in `CALENDAR_TEST_FILES`; that setting is refused when `NODE_ENV` is `production`.

## Chrome extension

`extension/` is a Chrome extension for sourcing. On a LinkedIn profile (or a GitHub profile, or a company's team
page), click its icon: the person's name, title, company, location and profile link are filled in, you choose the
job and stage, and they are added to that pipeline with you as the owner. It warns you when the person is already
in the workspace. It only reads the page when you click it, and only talks to your workspace, using the sign-in
you already have there.

Everyone on the team can download it from Settings, Browser extension, which also has the four install steps
(Chrome, Load unpacked). `npm run build` packs the folder into that download. To offer it through the Chrome Web
Store instead, zip the folder and submit it from a Chrome developer account.

It also copies the person's profile photo (untick "Save their profile photo" to leave it out). The picture is
cropped to a small square and stored in your workspace, so nothing is loaded from LinkedIn afterwards. Chrome
sometimes will not let the extension read the picture; the popup then shows an "Allow profile photos" button,
which asks Chrome once for access to LinkedIn's picture server. Photos show on pipeline cards, lists and the
candidate's profile, and can be added, changed or removed under Edit details. Client hiring teams see them too
unless you switch that off in Settings, Agency (some companies prefer to review candidates without photos, to
keep appearance out of the decision). A photo is personal data: it is deleted with the candidate.

On LinkedIn Recruiter, Sales Navigator, search and company pages there is no stable member link, so the link
field is left empty there: paste the person's public profile link. The first time it connects, the extension
confirms which workspace it is talking to.

LinkedIn changes its page markup from time to time. The reader has fallbacks (it was tested against signed-in,
public and renamed-class versions of a profile page), and every field can be corrected before saving, but if a
field stops filling in, `extension/extract.js` is the one file to adjust. LinkedIn's terms restrict tools that
extract data from its pages; this one only copies what is on the screen of the profile a recruiter has opened,
one person at a time, when they click.

## Run it

Requires Node.js 22.13 or newer.

```bash
npm install
```

```bash
npm run seed
```

```bash
npm run dev
```

Open http://localhost:3000. `npm run seed` loads a demo agency with three fictional clients; skip it to start
empty, in which case the first visit asks you to create your owner account.

Settings are read from real environment variables, or from a `.env` file in the project folder if you create one
(copy `.env.example` to `.env` and edit it).

Demo sign-ins (password `demo1234` for all):

| Who | Email | Sees |
| --- | --- | --- |
| Agency owner | `alex@harbourtalent.example` | Everything |
| Recruiter | `priya@harbourtalent.example` | All clients, no team admin |
| Client hiring manager | `maya@lumenhealth.example` | Lumen Health only |

Public careers page for the demo: http://localhost:3000/careers/lumen-health

To wipe the database and reload the demo: `npm run seed -- --reset`. This deletes every record, invitation link and uploaded résumé
in `DATA_DIR`, so it refuses to run when `NODE_ENV=production` unless you add `--force`.

## Put it online

The app is a single Node process with a SQLite database file, so it runs on any host that offers a
persistent disk (Render, Railway, Fly.io, a small VPS).

```bash
docker build -t the-book .
```

```bash
docker run -p 3000:3000 -v the-book-data:/data the-book
```

### Railway

1. Create a service from this GitHub repository. Railway builds it from the `Dockerfile`.
2. Attach a **Volume** to the service with the mount path `/data`. Without it, the database and résumés are wiped on every deploy.
3. Add a service variable `PORT` = `3000`, then generate a public domain for the service pointing at port 3000.
4. Open the domain. The first visit asks you to create your owner account.

Railway, Render and Fly.io are detected automatically, so rate limits apply to each visitor's real address.
On any other host that puts a proxy in front of the app, set `TRUST_PROXY=1` (or `2` if a CDN sits in front as well).

The `Dockerfile` deliberately has no `VOLUME` instruction, because Railway rejects builds that contain one.

### Any host

- **Persistent storage is required.** The database, résumés and recorded calls live in `DATA_DIR` (`/data` in the container).
  Without a mounted volume they are lost on every redeploy. Back this folder up.
- **Serve it over HTTPS** (every host above does this for you) and point a domain at it, for example
  `hiring.youragency.com`. Careers pages then live at `hiring.youragency.com/careers/<client>`.
- **Connect AI drafting (optional)** by setting `ANTHROPIC_API_KEY` (create one at console.anthropic.com). Job autofill
  then sends the job description and intake notes a recruiter provides to Anthropic's API to draft the job and brief,
  billed to that account per use. It uses `claude-opus-5-5`; set `AUTOFILL_MODEL` to use a different Claude model.
  Without a key, autofill still works in its basic form and nothing is sent anywhere. The same key lets the Oracle
  write call notes and submission drafts.
- **Connect call transcription (optional)** by setting `DEEPGRAM_API_KEY`. See [The Oracle](#the-oracle) for what is
  sent, what it costs and what happens without it.
- **Tell the app about proxies.** Leave `TRUST_PROXY` unset when the app is reached directly (plain `docker run`).
  Behind a reverse proxy set it to the number of proxies in front, or sign-in and application rate limits will
  either lump every visitor together or be trivially bypassed.
- **Connect email** in one of two ways (see `.env.example`). Until you do, emails are saved on the candidate's
  record and clearly marked as not sent.
  - `RESEND_API_KEY` and `MAIL_FROM`: sends through [Resend](https://resend.com)'s web API. Use this on Railway,
    whose Hobby plan blocks SMTP. Create a Resend account, verify your sending domain there, create an API key,
    and set `MAIL_FROM` to an address on that domain, for example `Your Agency <hiring@youragency.com>`.
  - `SMTP_URL` and `MAIL_FROM`: sends through any SMTP server. With email connected, admins are also emailed
  when someone requests an account, and people are emailed their link to set a password when their request is
  approved. Set `APP_URL` to the workspace's address (Railway is detected automatically): without it the app
  does not know its own address, so it emails no link and shows it to the approver instead.

## How it is built

```
server/
  index.js   Express server; serves the API and the built front end
  api.js     All API routes: auth, careers pages, jobs, pipeline, interviews, reports
  autofill.js  Drafting a job and its brief from a job description and intake notes
  oracle.js  The Oracle: recording and uploading calls, transcription, notes and submission drafts
  webm.js    Writes a browser recording's length into the file, so the player can seek
  db.js      SQLite schema and helpers (Node's built-in node:sqlite, no native modules)
  links.js   How profile links are stored, and which ones identify a person
  mail.js    Optional SMTP delivery; every email is logged either way
  calendar.js         Your calendar in The Oracle: the saved link, the day's events and who they are with
  calendar-fetch.js   Reads a pasted calendar link without being led into the server's own network
  calendar-day.js     One day's events out of a calendar file, on the recruiter's clock
  calendar-worker.js  Runs that reading on a thread of its own
  calendar-links.js, calendar-match.js, calendar-time.js   Links to join and phone numbers, names, time zones
  secret.js  The server's own secret, kept in the data folder; seals saved calendar links
  seed.js    Demo data
src/
  App.jsx, state.jsx, lib.js, ui.jsx   App shell, data hooks, helpers, shared components
  components/                           Candidate profile, modals, forms, layout
  pages/                                One file per screen, plus the public careers pages
```

Security basics in place: salted scrypt password hashing, HTTP-only same-site session cookies, every
request checked against the signed-in user's client, rate limiting per visitor on sign-in, sign-up,
invitations and public applications, a content security policy, résumé uploads restricted by type and size and only
ever served back as downloads, length limits on everything the public form accepts, and a honeypot field on
application forms. The code was reviewed by independent reviewers across authorization, web security, server
logic, front end and deployment, and the confirmed findings were fixed.

Candidate privacy: each application records when consent was given, each client can link its own privacy
notice from the form, and "Delete candidate data" on a profile erases the person's record, every application
they made at that client, their résumé files, and their recorded calls with the audio, transcripts and notes.

## Not built yet

- Calendar integration (Google or Microsoft) for live availability and automatic invites; today you get a calendar file to
  download. The Oracle reads a recruiter's own calendar from a private link, but writes nothing to it, and is not told
  the moment something changes.
- A reminder when an added event is about to start, and a sign-in to Google or Microsoft in place of the pasted link
  (which would also bring guest lists for Outlook).
- Self-service password reset by email. Until then, an agency user deactivates the account and invites the person
  again at the same address (see "Accounts and getting back in").
- Declining many account requests at once; each is declined on its own, and unanswered ones expire after 14 days.
- AI-assisted screening of applications. (Calls are summarised by the Oracle; applications and résumés are not.)
- Joining a video call to record it. The Oracle records in the recruiter's browser, or takes an uploaded recording.
- Multi-posting to job boards, e-signature for offers, and headcount planning or onboarding checklists.
- Automated tests that drive the screens in a browser as part of `npm test`. `npm test` covers the résumé reader,
  job autofill, the Oracle's server side and the Oracle's uploader. The Oracle's screens were driven end to end in
  Chrome with a simulated microphone while it was built (record, reload and server restart mid-call, a lost connection,
  two people on one computer, transcript, notes, add to a candidate, draft, submit, delete), against stand-ins for
  Deepgram and Claude; the other screens were verified by hand.
