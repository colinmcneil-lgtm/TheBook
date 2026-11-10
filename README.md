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
| **Otterview** | Every call with a candidate in one place, in two tabs. **Metaview**: the conversations your agency records in Metaview, findable and on the right candidates, each opening with its transcript and Metaview's notes. **Record a live conversation**: record a call in the browser, or upload a recording, and it is written out with who said what. Either way a notes summary is there and one click drafts the write-up for the hiring team. Agency only. See [Otterview](#otterview) and [Metaview in Otterview](#metaview-in-otterview). |
| **Inbox** | Every new application across all clients lands in one review queue, oldest first. |
| **Pipeline** | A drag-and-drop board per job with stages you define. Ratings, notes (optionally agency-only), rejection reasons, withdrawals, offers. |
| **Shortlist hand-off** | Submit a candidate to the hiring team with your write-up. They approve (the candidate moves to the next interview stage) or decline with a reason, so you can calibrate. |
| **Interviews** | Schedule with a panel, download a calendar file, and collect a structured scorecard from each interviewer against the criteria set on the job. Outstanding scorecards are chased in the sidebar and dashboard. |
| **Email** | Templates with merge fields; every message is recorded on the candidate. Application confirmations, interview invitations and rejections can be sent automatically. |
| **Reports** | Funnel conversion, source effectiveness, weekly application volume, time to hire, open-role ageing and hires. Printable for client reviews. Your retainer and placement-fee revenue is shown to your agency only. Two more reports for your agency alone: each recruiter's submissions, interviews and placements, and each client's searches, fill rate, time to fill and billings. See [Reporting](#reporting). |
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

## People in The Book without a job

A person can be saved to The Book with no job chosen, from the Chrome extension on their profile or from Add
candidate in the app, and put on a job later when the right role comes up.

- **What they have.** Everything on a profile that does not need a job: an owner, a résumé, a photo, notes, e-mails
  to them, calls in Otterview (recorded, uploaded or brought in from Metaview), Edit details and Delete candidate
  data. Stages, rejecting and withdrawing, the hiring team, interviews, offers and ratings belong to a job, so each
  of those answers "Add them to a job first."
- **Metaview.** A conversation in Metaview is matched to somebody who is on no job the same way as to anyone else
  (their e-mail address, their number, their exact name), shows "Not on a job yet" where the job would be, is
  offered on their profile's Calls tab, and with "bring calls in by themselves" on arrives on their entry unasked.
  Deleting them forgets their Metaview conversations too.
- **Where they are.** On the Candidates page, under their own tab, "Not on a job yet", which shows how many there
  are; "Everyone" lists them with everybody else. The other tabs (In process, Hired, Rejected, Withdrawn) are about
  a pipeline and leave them out, so "In process" shows the same people the dashboard's "Active candidates" counts.
  They are in no job, client, pipeline board, inbox, dashboard figure or report, and a list for one client or one
  job never contains them. They belong to the agency: client users never see them, and their notes are always
  agency-only.
- **Who counts as the same person.** Among people saved without a job, the same rules as within a client: one
  record per e-mail address, or failing that per LinkedIn link. Saving somebody again adds what was sent to the
  entry they have and makes nothing new. An address or a link that is on an entry under a plainly different name
  is put to you instead, so one person's résumé, photo and note never land on another's entry.
- **Résumés are never written over.** When somebody who already has a résumé is saved again with another, the new
  one goes on their profile and the one they had is kept under "Earlier résumés" there, for the agency to download
  under the name it was uploaded with, accents and other alphabets included. The same file sent twice is kept
  once. Earlier résumés are deleted only with the person.
- **Putting them on a job.** Their entry becomes that job's application at the stage chosen (the first stage if
  none is), and keeps its notes, résumé, calls and history. The date they entered the job is the day they were put
  on it, so time to hire is not counted from the day they were first saved. The client's hiring team sees the
  application from that moment on: nothing written or sent while the person was on no job is shown to them, nor
  the date they were first saved. That is not left to a filter. At the moment they go on the job, the history and
  the e-mails from before it are moved off the application into tables only the agency is read from, their notes
  are all agency-only, and a covering note saved with their entry becomes an agency-only note ("Saved with their
  entry in The Book: ..."). Your own view of the profile is unchanged: the whole history, every e-mail and note.
  An e-mail is recorded when the mail provider has answered, which can take seconds. One sent from The Book that
  is still on its way when the person is put on a job is recorded in the agency's own table as well, with the
  moment it was sent; if their entry was folded into another application meanwhile it is recorded there, and if
  the application was deleted meanwhile nothing is recorded.
  Put straight into an interview stage, Offer or Hired, they are picked out in Recent activity on the dashboard
  as anyone added straight into that stage is. Recent activity holds the job's news only, for you as for the
  client: nothing from before the job is listed beside the job's name. If they go back to The Book and are later
  put on another job, what happened on the first job stays in their history, for the agency only, and is neither
  shown to the second job's hiring team nor listed under the second job.
- **However you add them, it is the same entry.** "Add to a job" on their profile, choosing a job in the
  extension, and Add candidate in the app with a job chosen all do this: there is no way to end up with a second
  record of somebody who was in The Book. Add candidate and the extension recognise them by e-mail address or
  LinkedIn link when the name agrees. Found by their link with a different e-mail address typed, their entry keeps
  the address it has and the history says which one was typed (for the agency only), as it does for a client's
  record. The other way round, "No job yet" for somebody who is already on a client's job shows you where they
  are instead of saving them a second time.
- **When the client already has a record of them.** From their profile you are asked whether to join the two; from
  Add candidate and the extension, which add to the client's existing record anyway, the entry is joined to it.
  The entry then moves onto the client's record. Where the two disagreed (another e-mail address, phone number,
  location), the client's record keeps its own, and the history says what the entry had, for the agency only. If
  the client's record is already in the job you chose, "Join this entry to that record" folds the entry into the
  application they have there: its notes stay agency-only and its history and e-mails go to the agency's own
  tables, so the hiring team is never shown them. What the hiring team does see from the entry is what their
  record was missing: contact details, a photo, and the résumé if the application had none (a second résumé is
  kept as an earlier one, for the agency). The dialog says so before you join.
- **If the job is deleted, or they are removed from it,** somebody who was in The Book before goes back to The Book
  without a job, with their notes, résumé, e-mails, calls and history, including what was added while they were on
  the job. Only what belonged to the job goes: interviews and scorecards, the offer, the rating, the write-up for
  the hiring team and the hiring team's review of it. Everyone else in a deleted job is deleted with it, as before.
  A note a client user wrote stays on the entry as the agency's; that user can no longer delete it, and is told
  the same as for a note that does not exist.
- **What they wrote to one client never reaches another.** Somebody may have applied on a client's careers page
  themselves and then been joined with their entry in The Book. When that application goes back to The Book, the
  answers they gave to that client's questions, their note to that client and the consent they ticked there are
  taken off it and kept as one agency-only note ("From their own application for ... at ..."), and its source
  becomes "Agency sourced". Put on another client's job afterwards, that client's hiring team is shown none of it.
  The résumé goes the same way. When the entry was joined to an application that had a résumé of its own, the
  entry's was set aside; back in The Book the entry has the résumé it brought again, and the application's own is
  kept under "Earlier résumés", which only the agency is given. When the entry brought none, a résumé the person
  sent that client with their own application is still taken off and kept under Earlier résumés (also the copy
  of it on another of that client's jobs they were added to, for as long as the application they made themselves
  is still on the client's record), and the entry goes back without a résumé. One case leaves the agency's own
  copy under Earlier résumés instead of on the profile: an application they made themselves without a résumé,
  which had been using the entry's.
- **What a hiring team could still work out.** Nothing from before the job is shown, but two things are as they
  are because the entry is kept and not copied: its history line reads "Added to (job) at (stage)", where somebody
  added straight to a job has "Added to the pipeline (...)" (the same line as for anyone added to a second job at
  the client); and the entry keeps its number, so its profile address can be lower than that of somebody added to
  the job before it, and is the same one it had at an earlier client.
- **One person, more than one record.** Each client keeps its own record of a person and The Book keeps its own,
  so the same person can be on file in two places: in The Book and on a client's record (they applied on a careers
  page while in The Book, or were removed from one of a client's jobs while still on another, which sends what you
  kept on the entry back to The Book as a record of its own), or at two clients. Each profile says so ("Also in
  The Book without a job", "Also on Maple Freight's record, in ..."), found by e-mail address or LinkedIn link,
  with a link to the other. Only the agency is told. "Delete all data on this person" names every such record and
  asks which to delete: the ones under the same e-mail address are ticked, one that only shares a LinkedIn link is
  left for you to tick, and everything ticked is erased together. A request to be forgotten is only done when
  every record of them is gone.
- **Somebody already on a job** can be added to another job of the same client the same way, as a new application
  with a copy of their résumé. Each client keeps its own record of a person, so for a job at another client they
  are added as a new candidate.

- **The reports.** Somebody on no job is in neither report. Put on a job, they are counted like anyone in that job:
  a submission, a first interview with the client and a placement are each written down once, and put straight into
  Hired they are a placement. When they go back to The Book (removed from the job, or the job deleted), what was
  counted for them in that job goes, as it does when anyone else is removed from a job; on their next job they
  are counted afresh, for that job.

The first start after this was added changes the database in place: three columns stop being required, one empty
column is added to applications, three empty tables are added (earlier résumés, and the history lines and e-mails
only the agency reads), and nothing else about existing people or applications changes. The tables of history
lines and e-mails that are there already are not touched. The two tables that are rebuilt for this keep
every index and trigger they had, including ones an earlier version made and this one no longer makes.
`test/pool-upgrade.test.mjs` builds a database with the code from before, fills it, upgrades it and compares every
row, id, counter, index, trigger and foreign key. "Before" is three releases, each kept word for word under
`test/fixtures/`: the one this was first built on (`before-pool/`, commit 5f16829), the one after it
(`before-pool-3f7b1a4/`), and the newest one without this change (`before-pool-6f279a9/`: Metaview and the reports
in, phone calls and the calendar out), whose database is one the release before it made and that it then opened
and used, with Metaview conversations and recorded report moments hanging off the two rebuilt tables. What a
database must end up as is not written out by hand: a copy is opened by the newest release without this change,
and this change's own differences are applied to what that leaves, so a database last opened by any of the three
gets the releases it missed and this change in one start, and ends up the same whichever way it came. Every test
is also run on a database whose tables began at the first release, and a database made by the first release's own
code (`first-release/`) that nothing since has opened is upgraded too. The start is also cut off before each of
its steps in turn: every time nothing is lost or renumbered, no index or trigger is missing, and the next start
finishes the job. (That found two older steps which a cut at the wrong moment left undone for good: the one that
gives each candidate an owner, and the one that says which interview stages are the agency's own when the reports'
tick first arrives. Each is now saved in one piece. A database that has already been through a step is not put
through it again.) All of this was run on made-up databases, not on a copy of a live one, so take a back-up of
`DATA_DIR` before the first deploy.

**Before the first deploy, and if you ever go back.**

- **Room on the disk.** Rebuilding the two tables needs room for about one and a half times the size of `app.db`
  in all for the length of the first start, so free space of about half its size (a 115 MB database took 165 MB
  at the most, 50 MB more than it had). With less, the start fails and the log says that the disk is full ("The
  disk that holds ... is full, so the database could not be upgraded. No row has been changed or lost.", or
  SQLite's own "database or disk is full" when it runs out after the tables are rebuilt). No row is changed or
  lost either way (a table rebuilt before the disk ran out stays rebuilt, with the rows it had): the version
  before still starts on the database, and the next start with room finishes the job.
- **Two copies of the app on one data folder.** A host that starts the new container before the old one has
  stopped has both writing to the same database for a moment. This version waits up to five seconds for the
  other instead of failing with "database is locked", and two first starts at the same moment leave the database
  as one would have. The version being replaced by this deploy does not wait: anything saved in it during the
  moment the new one rebuilds the two tables (milliseconds on a small database, about half a second with 50,000
  candidates) can fail with "Something went wrong on our side" and should be saved again. Reading is not
  affected, and it does not happen on a host that stops the old container first, nor on any later deploy.
- **Treat this deploy as one-way once somebody from The Book has been put on a job.** The version before this one
  starts on the upgraded database and loses nothing by itself, but it does not know about people without a job:
  - They disappear from its lists, their profiles answer "Not found", looking one up finds nothing (so adding them
    again makes a second record), and new Metaview conversations with them are not matched. They are all there
    again when this version is back.
  - **Do not delete a job, or remove anybody from one, while rolled back.** The old version deletes everybody in a
    deleted job, including people who came from The Book, whom this version would have returned to The Book.
  - What the client's hiring team may not see stays unseen. Notes, history and e-mails from before the job, how
    somebody was matched, a covering note saved with an entry, and what somebody wrote to another client are not
    stored where the old version shows the hiring team from (see above), and `test/pool.test.mjs` reads the
    database with the old version's own queries to check it. Two dates are in what the old version sends a client
    user's browser about somebody who came from The Book, though neither is on its screens: the date the agency
    first saved them (as the date their record was made) and the moment they went on the job. On the old version
    the agency does not see the history and e-mails from before the job either, until this version is back;
    nothing is deleted.
  - If you must go back for longer than it takes to fix a start, the safe order is: on this version, remove the
    people who came from The Book from their jobs (they return to The Book, which the old version shows to
    nobody), then roll back.
`test/pool.test.mjs` runs the rest against the real API and a stand-in for Metaview, on four ports counted from
`POOL_TEST_PORT` (it, the next, and the fifth and sixth; the fifteenth, sixteenth, nineteenth and twentieth from
`ORACLE_TEST_PORT` unless set; `test/oracle-helpers.mjs` lists
which test file uses which port). `npm test` uses thirty ports in a row from `ORACLE_TEST_PORT` (3610 unless
set): `ORACLE_TEST_PORT=5080 npm test`. Node refuses to fetch from a few ports whatever is listening on them
(5060 and 5061 among them), so a base that puts one of the thirty on such a port, any base from 5031 to 5061 for
one, is refused before a test runs, with a sentence that says which base to choose instead.

## Reporting

The Reports page has three views for the agency: **Overview** (the funnel, sources and hires, as before),
**Individual** (one row per recruiter) and **Clients** (one row per client). The view is in the address
(`/reports?view=individual`, `/reports?view=clients`), so a report can be linked to, and each one prints. Client
users see the Overview only; the other two, and everything behind them, are refused to them.

### When counting starts

Individual and Clients count from **Monday 16 November 2026**, from the start of that day in Toronto. Nothing that
happened before that moment is counted, and "lifetime" means since then. Before that day the two views say when
counting begins and show no numbers. An admin can see and change the date at the top of either view. The numbers are
written down as things happen, so moving the date later hides what was recorded before it, and moving it earlier
cannot bring back anything from before counting first began. Once counting has begun, everything is written down
whatever the date is moved to, so moving it later and back again loses nothing. The day is read in Toronto time; set
`REPORTS_TIMEZONE` (for example `America/Vancouver`) to read it elsewhere.

Moments are only written down while this version is running. **It has to be live before the start date.** If it is
installed after that day, or the date is moved to a day already past, nothing between that day and the moment
recording really began is in the numbers, and both views say so under the date ("The Book began writing these
numbers down on ...").

Something first done before the start is not made up for by doing it again afterwards: a candidate first submitted
the week before is not counted when they are sent again, and neither is the interview that follows.

### What is recorded, and when

Each moment is recorded once for a candidate in a job, at the moment it happens, with the recruiter credited as
things stood then. Reassigning a candidate or editing a client's terms later changes nothing that was recorded.

- **Submission.** The first time a candidate is submitted to the client's hiring team, credited to the person who
  submitted them.
- **First interview.** The first interview with the client that a submitted candidate gets: whichever comes first
  after their submission, being moved into an interview stage ticked "Interview with the client" or having an
  interview scheduled in The Book. A candidate already sitting in such a stage when they are submitted counts at
  the submission. It is credited to whoever submitted them. A candidate interviewed without ever being submitted is
  not counted, and neither is a submitted candidate taken straight to Offer or Hired with no interview stage or
  scheduled interview in between.
- **Placement.** A candidate is marked hired, credited to the recruiter who owns them in that job at that moment
  (whoever submitted them, if nobody owns them). The fee recorded is the salary on their offer times the client's fee
  percentage at that moment; if the offer has no salary yet, the fee is worked out when the salary is added, still
  at the percentage recorded at the hire. An agency user can correct it on the hired candidate's profile, under
  Placement; saving it empty says there is no fee for this placement. A hired candidate who is moved out of Hired,
  rejected or withdraws stops counting. If they are put back in Hired, by any road, the same placement counts again
  exactly as it was: its date, its credit and its fee do not change, whoever moved the card and whatever has been
  edited since. The one exception is a hire undone within a day of being made (a card dropped on Hired by mistake),
  with no fee entered by hand: that is forgotten, and a later hire of the same candidate is recorded afresh. A
  candidate hired before counting started is never counted, however their card is moved afterwards.
- **Search opened.** A job becomes open for the first time (kickoff).

Deleting a candidate or a job removes what was recorded for them. Merging two records of one person keeps it.

Each interview stage on the job form has a tick, **Interview with the client**. It starts ticked, except on a stage
whose name contains "recruiter", "screen" or "agency", and the stages of jobs that already existed were given the
same starting values. Changing a tick affects candidates who reach the stage afterwards, not those already in it.

### Individual: one row per recruiter

For a period you choose: since counting started, this month, the last 30 days, the last 90 days or the last 12
months. Admins see everyone on the agency team who has anything recorded, and a totals row; a recruiter sees only
their own row. Click a column heading to sort by it.

| Number | How it is counted |
| --- | --- |
| Submissions | The recruiter's submissions recorded in the period. |
| Interviews | First interviews in the period for candidates the recruiter submitted. |
| Interview/Submission ratio | Interviews divided by submissions, both in the period, as a whole percentage (5 of 11 is 45%); a dash when there are no submissions. |
| Placements | Placements credited to the recruiter in the period. |

### Clients: one row per client

Above the table are two drop-downs: the metric to sort by, and **High to low** or **Low to high**. Clicking a column
heading does the same. Nought is a figure like any other: a client with no searches shows 0 and comes first in
"Low to high", and a client with placements and nothing billed shows 0 in its currency. A dash means there is
nothing to work the figure out from (a percentage of nothing, a time to fill with nothing filled, billings with no
placements); those clients are listed last either way.

| Number | How it is counted |
| --- | --- |
| Total reqs, lifetime | Searches opened at the client since counting started. |
| Total reqs, last 12 months | Searches opened at the client in the last 12 months (never reaching back before counting started). |
| Interview % | First interviews divided by submissions, across all of that client's searches. |
| Placement % | Searches filled divided by searches opened: the client's fill rate. A search is filled when every opening on it has been hired into. Only searches opened since counting started are included, so a placement on an older search adds to billings but not here. |
| Time to fill | The average number of days from a search opening to the day the offer was accepted (the day of the hire, when no accepted offer was on record), over the placements on searches that count. |
| Total billings, lifetime | The fees recorded for the client's placements since counting started, in the client's currency. |
| Total billings, last 12 months | The same, for placements in the last 12 months. |
| Average fee per placement | Total billings divided by the number of placements that have a fee recorded. |

Billings are placement fees only; monthly retainers are not included. When clients are billed in different
currencies, each amount is shown in the client's own currency, and sorting by billings or fees compares the figures
as written, without converting them; the page says so. A placement with no fee (the offer had no salary) is listed
under the table with a link to the candidate, until the fee is entered or saved empty to say there is none.

The Overview's "Your fee" column and "Placement fees" total use the same recorded fees, so the two views agree. A
hire from before counting started has no fee on record, and the Overview still estimates it from the client's terms
today.

The demo data (`npm run seed`) is the one exception to the start date: so that the two views have something in
them, the demo counts from a Monday about five months back and is loaded with the moments its made-up history
would have recorded.

## Otterview

Otterview is where recruiters' calls with candidates are kept: the ones recorded in Metaview (see
[Metaview in Otterview](#metaview-in-otterview)) and the ones recorded or uploaded in The Book itself. This
section is about the second kind; once a call is in Otterview, both kinds work the same way.

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

### Two tabs

- **Metaview.** The agency's conversations in Metaview, newest first, with a search box and a few filters. Each one
  says which candidate it was with, or offers the people it might have been with. Opening one makes it a call in
  Otterview. See [Metaview in Otterview](#metaview-in-otterview).
- **Record a live conversation.** For a call on Meet, Zoom or Teams, on speaker, or in person: record it in the
  browser, or upload a recording made elsewhere. The calls recorded or uploaded in The Book are listed underneath.
  See [Recording a call](#recording-a-call).

A candidate's profile has a Calls tab with their calls of both kinds, in the order the conversations happened.

### Recording a call

- Press **Record now** on Otterview, or **Record a call** on the Calls tab of a candidate's profile, which starts
  with that person and job already chosen.
- By default only the recruiter's microphone is recorded. For a call held in Google Meet, Zoom or Teams in a browser
  tab, press **Add the other side of the call**, choose that tab and tick "Also share tab audio". For a call on a
  phone or in a desktop app, put it on speaker so the microphone hears both sides.
- A red strip with the time, Pause and Stop stays at the top of every page, so the recruiter can open the
  candidate's profile or anything else in The Book while the call is recorded. Stop pressed on Otterview opens the
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
`ORACLE_MODEL` chooses a different Claude model for Otterview (it otherwise follows `AUTOFILL_MODEL`, then
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
- **To Metaview:** only the key and the requests themselves (which conversations to list or fetch). Nothing about the
  candidates in The Book goes there. See [Metaview in Otterview](#metaview-in-otterview).

### Consent to recording

A call with a candidate is personal data, and in many places it is against the law to record a call unless everyone
on it has agreed. For a call recorded in the browser or uploaded, The Book does not announce the recording to the
candidate: the recruiter has to tell them and get their agreement. (A call brought in from Metaview was recorded
by Metaview, under whatever notice your Metaview account gives; The Book records that it came from there and asks
nobody to confirm anything.) Before every recording and every upload the recruiter must confirm that everyone on the call has
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
  which Otterview always does, may put the rate up.
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

## Metaview in Otterview

If your agency records its candidate calls in [Metaview](https://www.metaview.ai), Otterview can show them. The
Metaview tab lists every conversation Metaview has for you, puts each one on the candidate it was with, and opens
any of them as a call in Otterview: the transcript with the speakers named, Metaview's own notes as the notes
summary, how long it was, when it took place, and a link back to the conversation in Metaview.

From then on it is a call like any other. Speakers can be renamed, the notes edited or written again by The Book's
own AI, the write-up for the hiring team drafted, the summary saved on the profile, the call moved to another
candidate or deleted. The one difference is that there is no audio in The Book: to listen, follow the link to
Metaview.

### Connecting it

1. **Make a key in Metaview.** Sign in to Metaview, open **Settings**, then **Integrations**, then **MCP**. Where it
   asks "Use API Key instead of OAuth?", choose that, and press **Generate API Key**. Copy the key. A key belongs to
   the person who made it and sees what that person sees in Metaview, so make it with an account that can see all
   of the agency's conversations (an admin's).
2. **Enter it in The Book.** An admin opens **Settings**, **Agency**, and pastes the key into the **Metaview** card
   (the **Connect Metaview** button on Otterview's Metaview tab leads there). The Book tries the key against
   Metaview before keeping it: a key Metaview refuses is not saved, and the card says so. Recruiters see whether
   Metaview is connected, but only an admin can connect it, change the key or disconnect it.

That is all. Nothing needs setting on the server. If you would rather keep the key with the server's other
settings, set `METAVIEW_API_KEY` where The Book is hosted (on Railway: the service's **Variables**) and restart; it
then connects by itself. A key entered in the app takes over from one set on the server, and only a key entered in
the app can be removed in the app.

### What happens once it is connected

- **The list fills in.** The Book reads Metaview's list of conversations in the background, fifty at a time with a
  few seconds between pages, newest first. A couple of thousand conversations take two or three minutes. How far
  it got is kept, so a restart carries on from there. While it is still reading, the Metaview tab and the card in
  Settings say how far it has got ("600 of about 2,100 so far"); the calls already listed can be used meanwhile.
- **New calls appear by themselves.** Every ten minutes The Book looks for new conversations; **Look for new
  calls** looks at once. A recent conversation that has changed in Metaview (a transcript that arrived later, a corrected name) is
  brought up to date at the same time, and once a week the whole list is read again, which also takes out
  conversations that have been deleted in Metaview and were never brought in.
- **Each call is matched to a candidate.** By an e-mail address of the person on the call, by their phone number,
  or by their exact full name. Capitals and accents do not count. Anything weaker (a first name on its own, part
  of a name) never chooses anybody: those people are offered, and a recruiter picks. A person chosen by hand
  always wins and is remembered. Interviewers, and anyone with a login to The Book, are never taken for the
  candidate. Metaview often knows somebody on a phone call only by a first name and their number, so in practice
  most calls are matched by the phone number on the candidate's record: a candidate with no number in The Book
  will usually have to be chosen by hand.
- **Phone numbers are compared however they were typed.** "(647) 555-0199", "647.555.0199", "647/555/0199 ext 4"
  and "+1 647 555 0199" are one number, and a box holding two numbers ("416-555-0183 / 647-555-0199") counts for
  both. The last ten digits are compared together with the country: the same ten digits in another country
  ("+44 …") are a different number. A number with nothing in front is taken to be a North American one.
- **Evidence that points two ways chooses nobody.** If the address on a call is one candidate's and its number or
  its exact name is another's, or if Metaview lists two people on the call who are two different candidates,
  nobody is chosen: they are all offered, the call is never brought in by itself, and it is listed on each of
  their profiles until a recruiter decides. Two people on file with the same number (a household) or the same
  address are told apart by the name on the call; when the name does not settle it, both are offered. The same
  person on file under two clients is matched to the record that is still in progress, if only one is.
- **A caller Metaview has no name for** goes by their phone number there, and so the call is listed as "Call with
  +1 647…" here. The number still matches them to their candidate, and once the call is on a candidate it, and
  the speaker in its transcript, carry the candidate's name.
- **Opening a call brings it in.** The Book fetches that one conversation's transcript and notes and makes the call
  in Otterview, on the candidate it was matched to (their most recent job in progress) or the one the recruiter
  chose. The candidate's history gets the line "Metaview call, 12 min", which client users never see. Opening it
  again opens the same call. The call belongs to the interviewer, if they have a login to The Book, and otherwise
  to whoever opened it.
- **Notes may follow a little later.** Metaview writes a conversation's notes the first time they are asked for,
  which takes about half a minute. The call opens at once with its transcript; the notes are asked for again by
  themselves (five times over about nine minutes) and appear on the page when they are ready. If Metaview never
  produces any, the call says so and the notes can be written in The Book.
- **A call with no transcript** in Metaview is still brought in, saying that there is none yet. If Metaview writes
  it out later, the transcript and the notes arrive by themselves.
- **Recent calls come in without anyone clicking.** With "bring calls in by themselves" on (it is on unless an
  admin turns it off), a conversation from the last 14 days, and every new one, that an e-mail address or a phone
  number ties to exactly one candidate, with nothing else about the call pointing anywhere else, is brought in and
  put on that candidate automatically. A match by name is never enough for that, nor is a number shared by two
  people on file, and older history is only listed until somebody opens it. No more than 50 calls a day
  come in this way (`METAVIEW_AUTO_PER_DAY` changes the number), so a mistake cannot fill the workspace, and a call
  somebody deleted is never brought back by itself.

The list can be searched by name, e-mail address, phone digits and title, and narrowed to the calls you took part
in (**Mine**: the ones where the e-mail address you sign in to The Book with is an interviewer's in Metaview), the
ones not yet in The Book, the ones with no candidate, or, on a candidate's Calls tab, that candidate's calls, each
with **Add** and all of them with **Add all**.

### It only reads

The Book never changes anything in Metaview. Of everything a Metaview key allows, the code can ask for exactly two
things, and refuses to send anything else: whose key this is (to check it and show the workspace's name), and the
list of conversations with chosen fields. It asks one thing at a time, pauses between pages, and tries again later
when Metaview is busy or not answering; a failure is shown as a sentence on the Metaview tab and never stops the
rest of The Book.

Asking for a conversation's notes makes Metaview write them if it has not already, as it would if you opened the
conversation there. That happens only for conversations that are brought in.

### What The Book keeps, and where

- **For every conversation Metaview lists:** Metaview's number for it and its link, when it took place, its title,
  type, channel (Phone, Zoom...) and length, whether it has a transcript, and the names of the people on it with
  their part in the call. E-mail addresses and phone numbers are kept only where they are used: the candidate's
  (or, when Metaview names no candidate, everybody's who is not an interviewer), to work out who the call was
  with, and each interviewer's e-mail address, for "Mine" and for whose call it is. An interviewer's own phone
  number is not kept, nor are the contact details of anybody else on a call that has a candidate. That is what is
  needed to list a conversation and to match it, and nothing more is kept. Addresses and numbers are used for
  matching and searching on the server and are not sent to the browser, with one exception: where the number is
  all Metaview has to call somebody by, it is shown as their name, as it is in Metaview.
- **For a conversation that has been brought in:** its transcript and notes, on the call in Otterview.
- **Never:** audio. Metaview does not give it out.
- **The key:** sealed with a secret that the server makes on first use and keeps in `DATA_DIR/server-secret`, beside
  the database. It is never shown again, never returned by the server and never written to a log. Back the data
  folder up as a whole; if the secret file is lost, the key simply has to be entered again. A key set on the
  server (`METAVIEW_API_KEY`) that cannot be a key, such as one pasted with a line break in the middle, is not
  sent anywhere: the Metaview card says that it needs setting again.
- **What is deleted is written over.** When the key is replaced or Metaview is disconnected, and when a candidate
  is erased, the old contents are overwritten in the database's files, not just marked as free space. A backup
  taken *before* that still holds them, and a key keeps working in Metaview until it is deleted there: to retire
  a key for good, delete it in Metaview too (Settings, Integrations, MCP).

Nothing about your candidates in The Book is sent to Metaview: matching happens on your server. When a recruiter
has the notes written again or a write-up drafted, the transcript goes to Anthropic like any other call's (see
[What is sent outside your server](#what-is-sent-outside-your-server)).

Everything is agency only: client users are refused on every route and see nothing of it.

**Erasing a candidate** ("Delete all data on this person", or removing somebody's only application) deletes the
calls that were brought in for them, and also what The Book remembered about their other Metaview conversations:
those leave the Metaview tab, the search and the profile lists, with the person's name, address and number. Only
Metaview's numbers for those conversations are kept, so that the next reading of Metaview's list does not put
them back; they stay off the list even if the person is added to The Book again later. The conversations
themselves are still in Metaview: delete them there too if they must go altogether. (Deleting a whole job removes
the people who were only in that job and their calls, but does not do this for each of them.)

An admin can **Disconnect** Metaview (Settings, Agency): that removes the key and everything remembered about
conversations that were never brought in, at once, even if The Book is in the middle of reading Metaview at that
moment. Calls already in Otterview stay, and still open. The same care is taken when the key is replaced by one
for another Metaview workspace: nothing of the first workspace's list is carried into the second.

### Before you rely on Metaview

The Book was built and tested against a stand-in that answers the way Metaview does (`test/metaview-standin.mjs`).
It was then run once against the real service, reading only, in November 2026: the key was accepted and the
workspace named, the newest hundred conversations were listed (a page of fifty took about a second), and one phone
call was opened: every line of its transcript was read into turns for its two named speakers, its length and date
matched, and Metaview's notes arrived by themselves about 35 seconds later. That run is also where it was seen
that most callers have only a first name and a number, and that a few go by their number alone.

What that one run could not show, so check it the first time you connect:

1. Enter the key and watch the count climb to about the number of conversations you have.
2. Open a few recent calls, among them a video meeting and a long call. Check both names are on the transcript, the
   times look right, and the notes arrive within a minute.
3. Check a few matches of each kind: a candidate matched by phone number, one by e-mail, one by name.
4. Look at the calls that came in by themselves, and at each candidate's history line.

Not known: what limits Metaview puts on how often it may be asked (The Book stays well below anything
reasonable), and whether asking for notes counts against anything in your Metaview plan. The key is tied to the
person who made it; if that person leaves Metaview, the tab will say the key was refused, and a new one is needed.

## Chrome extension

`extension/` is a Chrome extension for sourcing. On a LinkedIn profile (or a GitHub profile, or a company's team
page), click its icon: the person's name, title, company, location and profile link are filled in, you choose the
job and stage, and they are added to that pipeline with you as the owner. Or choose "No job yet: just add to The
Book" (the first choice under Job, and the one a new install starts on): the person is saved without a job, and
you add them to one later from their profile (see
[People in The Book without a job](#people-in-the-book-without-a-job)). The choice is remembered, as the last job
is, and the popup works in a workspace that has no jobs yet. It warns you when the person is already in the
workspace, and does not save someone to The Book twice. When the person is already in The Book without a job and
you choose a job, the entry they have is put on that job and what you typed is added to it, in one step: their
notes, résumé, calls and history come with them and no second record is made. If the workspace refuses (a
colleague added them a moment ago, say), nothing is saved and the popup shows how things stand now. It only reads
the page when you click it, and only talks to your workspace, using the sign-in you already have there.

Everyone on the team can download it from Settings, Browser extension, which also has the four install steps
(Chrome, Load unpacked). `npm run build` packs the folder into that download. To offer it through the Chrome Web
Store instead, zip the folder and submit it from a Chrome developer account.

**It does not update itself.** Loaded from a folder, an installed copy stays as it is until it is replaced. After
a release that changes the extension (0.4.0 added "No job yet"), each person downloads it again from Settings,
Browser extension, unzips it over the old folder, and presses the reload arrow on "The Book" at
`chrome://extensions`; the workspace address is kept. 0.5.0 also has the photo fixes that went out as 0.3.1 (the
picture is taken only from the profile that was read, and permission is asked for only when the picture could not
be read at all). From 0.5.0 the popup compares itself with the copy the
workspace has ready and says so across the top when it is behind. A copy from before that cannot say anything, so
tell the team when you deploy. An older copy keeps working in the meantime: it has no "No job yet" choice, but
choosing a job for somebody who is in The Book still moves their entry, because the workspace does that itself.

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
  A draft that has not come back after two and a half minutes is given up on and the basics are filled in instead
  (`AUTOFILL_AI_TIMEOUT_MS` changes how long). Without a key, autofill still works in its basic form and nothing is
  sent anywhere. The same key lets Otterview
  write call notes and submission drafts.
- **Connect call transcription (optional)** by setting `DEEPGRAM_API_KEY`. See [Otterview](#otterview) for what is
  sent, what it costs and what happens without it.
- **Connect Metaview (optional)** in the app: an admin pastes a Metaview key under Settings, Agency, Metaview. Nothing
  needs setting on the server, though `METAVIEW_API_KEY` works too. See [Metaview in Otterview](#metaview-in-otterview).
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

### If your workspace had the calendar or the phone line

Earlier versions of The Book could read a recruiter's calendar from a link they pasted in, and had a phone line
with a mobile number and a PIN for each recruiter. Both were taken out. Starting the new version never deletes
anything, so a database that was in use before still holds what people saved for them: each saved calendar link
(sealed, but such a link opens that person's whole calendar), what was remembered about their calendar events, and
their mobile numbers and PINs. Nothing reads any of it any more, and nobody can remove it from inside the app any
more. To clear it, run this once where The Book is hosted (on Railway: open a shell on the service, in `/app`):

```
node server/forget-removed.js          # says what is there and changes nothing
node server/forget-removed.js --yes    # clears it
```

It can be run while the app is running, clears only those four things (written over, not just marked as deleted),
and leaves every call in Otterview alone, phone calls included. Anyone who had saved a calendar link can also
reset their calendar's private address with their calendar provider, which makes the old link useless everywhere.

## How it is built

```
server/
  index.js   Express server; serves the API and the built front end
  api.js     All API routes: auth, careers pages, jobs, pipeline, interviews, reports
  reporting.js  The Individual and Clients reports: the record of submissions, first interviews, placements and searches, and the day counting starts
  autofill.js  Drafting a job and its brief from a job description and intake notes
  oracle.js  Otterview: recording and uploading calls, transcription, notes and submission drafts
  metaview.js         Metaview in Otterview: the key, reading the list in the background, bringing calls in
  metaview-client.js  The connection to Metaview: one request at a time, read-only, and the reading of its answers
  match.js   Which candidate a conversation was with: by address, by phone number, by exact name
  webm.js    Writes a browser recording's length into the file, so the player can seek
  db.js      SQLite schema and helpers (Node's built-in node:sqlite, no native modules)
  links.js   How profile links are stored, and which ones identify a person
  mail.js    Optional SMTP delivery; every email is logged either way
  secret.js  The server's own secret, kept in the data folder; seals the Metaview key
  seed.js    Demo data
  forget-removed.js  Run by hand: clears what the calendar and the phone line (both taken out) left in an older database
src/
  App.jsx, state.jsx, lib.js, ui.jsx   App shell, data hooks, helpers, shared components
  components/                           Candidate profile, modals, forms, layout
  oracle/                               What Otterview's screens share with the rest of the app (the recorder)
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
  download for each interview.
- Calling a candidate from The Book. Calls are made the way you make them now and recorded by Metaview, or recorded
  in the browser.
- Playing a Metaview call's audio inside The Book; the call links to the conversation in Metaview.
- Self-service password reset by email. Until then, an agency user deactivates the account and invites the person
  again at the same address (see "Accounts and getting back in").
- Declining many account requests at once; each is declined on its own, and unanswered ones expire after 14 days.
- AI-assisted screening of applications. (Calls are summarised by Otterview; applications and résumés are not.)
- Joining a video call to record it. Otterview records in the recruiter's browser, or takes an uploaded recording
  (Metaview joins meetings itself, and those conversations arrive through the Metaview tab).
- Multi-posting to job boards, e-signature for offers, and headcount planning or onboarding checklists.
- Automated tests that drive the screens in a browser as part of `npm test`. `npm test` covers the résumé reader,
  job autofill (the plain reader, and the route against a stand-in for the AI service), the recruiter brief, the activity
  feed's milestones, résumé and photo files, Otterview's server side, Otterview's uploader, Metaview in Otterview
  against a stand-in for Metaview, starting on a database from before phone calls and the calendar were taken
  out, people saved without a job, and the database upgrade that made room for them. Otterview's recording screens were driven end to end in Chrome with a simulated microphone while they were
  built (record, reload and server restart mid-call, a lost connection, two people on one computer, transcript,
  notes, add to a candidate, draft, submit, delete), against stand-ins for Deepgram and Claude. The two tabs with
  Metaview were driven the same way at computer and phone widths against the stand-in for Metaview (connect, the
  history being read, search and filters, open, choose a candidate, draft and submit, a candidate's Calls tab,
  record, upload, a recruiter, a client user, disconnect). Reporting (every number on the Individual and Clients
  reports) is tested through a story acted out either side of the start date and over more than a year, with the
  reports' clock set by the test; the two reports, the start date, the placement fee on a hired candidate and the tick
  on the job form were driven in Chrome at 1280 and 390 wide on the demo data, and printed to PDF.
  The other screens were verified by hand.
