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
| **Phone calls** | Call a candidate from The Book: your own phone rings, you press 1, and the candidate is rung from the agency's number. Or ring that number from your mobile while you are out, key in a PIN and the number, and talk as you walk. Either way the call is recorded with each of you on your own channel, written out, summarised, put on the candidate, and you are e-mailed when the notes are ready. Candidates who ring the number are put through to their recruiter. Agency only. See [Phone calls](#phone-calls). |
| **Inbox** | Every new application across all clients lands in one review queue, oldest first. |
| **Pipeline** | A drag-and-drop board per job with stages you define. Ratings, notes (optionally agency-only), rejection reasons, withdrawals, offers. |
| **Shortlist hand-off** | Submit a candidate to the hiring team with your write-up. They approve (the candidate moves to the next interview stage) or decline with a reason, so you can calibrate. |
| **Interviews** | Schedule with a panel, download a calendar file, and collect a structured scorecard from each interviewer against the criteria set on the job. Outstanding scorecards are chased in the sidebar and dashboard. |
| **Your calendar** | Each recruiter can connect their own calendar to The Oracle with a private link. Their day is shown with The Book's interviews in it, each event says which candidate it is probably with, and "+ Add" marks the ones to record. Agency only. See [Your calendar in The Oracle](#your-calendar-in-the-oracle). |
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

### One tab, three ways to start a call

The Oracle's page opens on three cards, with the list of calls underneath. On a computer, calling and recording sit
on the left and the day on the right; on a phone they stack in that order.

- **Call a candidate.** "Find & call candidate" searches by name or by the digits of a number, or takes a number
  typed in full. It shows who will be rung and from which of your phones, with "Record this call" ticked, and then
  follows the call. Closing the dialog or going to another page does not end the call: it stays on the card, and
  is a strip across the top everywhere else, with Hang up. "Or call from your own phone" shows The Book's number
  and the three steps for calling with no screen at all. See [Phone calls](#phone-calls).
- **Record a live conversation.** For a call on Meet, Zoom or Teams, on speaker, or in person. See
  [Recording a call](#recording-a-call).
- **Your calendar.** The day's events with "+ Add" on each. Two minutes before an added event starts, a prompt
  appears across the top of whatever page you are on, with Record, Call and Join; with your permission the browser
  also shows a desktop notification. The Book has to be open in a tab for either, and a phone's browser shows only
  the prompt. A call recorded or placed from an event is shown on the event afterwards. See
  [Your calendar in The Oracle](#your-calendar-in-the-oracle).

One call at a time: while a phone call is under way Record now is held back, and while a browser recording is
running Call is, each saying why. A call that comes in during a recording cannot be held back, so the card says
both are running. A candidate's profile has a Call button beside their number (an ordinary dial link when phone
calls are not connected), and its Calls tab lists phone calls with their direction.

Each person sets up their own side under **Settings, Your account**: "Your mobile number" (the phone The Book rings,
and the PIN for ringing in) and "Your calendar" (the private link). Whether phone calls are connected, and what is
needed to connect them, is under **Settings, Agency**.

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
on it has agreed. For a call recorded in the browser or uploaded, The Book does not announce the recording to the
candidate: the recruiter has to tell them and get their agreement. (A call placed through The Book's phone number is
different: the other person hears a notice first. See [Phone calls](#phone-calls).) Before every recording and every upload the recruiter must confirm that everyone on the call has
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

## Phone calls

With a Twilio account connected, The Book has a phone number of its own, and calls made through it land in the
Oracle without anyone pressing Record.

1. **Call from the app.** Find a candidate (or type a number) and press Call. Your own mobile rings. A voice says who
   you are about to call and asks you to press 1; only then is the candidate rung, and they see The Book's number,
   not yours. The key press is there so that if your voicemail answers your phone, it is never connected to a
   candidate. The screen follows the call: ringing you, waiting for you to press 1, calling them, in the call, and
   one plain sentence for how it ended ("Kevin's phone was busy", "You did not pick up"). You can hang up from the
   screen. If the call does not connect, the voice tells you why before it hangs up.
2. **Call from your phone (the switchboard).** Save The Book's number in your contacts. Ring it from the mobile you
   saved in The Book, key in your PIN and #, then the number you want and #. The call is placed and recorded the
   same way, with no screen needed. If the number is exactly one candidate's, the call goes on that candidate. Three
   wrong PINs end the call and lock that mobile out of the switchboard (you are e-mailed when it happens): for a
   quarter of an hour the first time, an hour the next, then a day. Wrong PINs add up across calls, so hanging up
   and trying again does not help a guesser, and ten of them inside a day switch the PIN off until its owner
   chooses a new one in the app. A caller's number can be faked, so the PIN is the only real lock, and it must not
   be something that can be guessed a few tries at a time for ever. One call at a time: while a call you placed is
   under way, a second one from the switchboard is refused.
3. **Somebody rings the number.** The caller is found by their number and put through to the recruiter who last
   called them, or else the owner of their most recent application, or else the first admin who has a mobile saved.
   Your phone shows The Book's number, and before you are joined a voice says "Call from Dana Whitlock, a candidate"
   (or that the number is not known). If you do not answer within twenty seconds the caller is asked to leave a
   message, and the message becomes a call in the Oracle too, titled "Voicemail from ...". A number nobody knows is
   put through the same way and waits in the Oracle to be added to a candidate. Ringing back from your call log
   reaches the switchboard, so the call back is recorded as well. (Set `PHONE_FORWARD_SHOWS=caller` if you would
   rather see the caller's own number; calls passed on that way are more likely to be labelled as spam by your carrier.)

### After the call

When Twilio says the recording is ready, The Book fetches it with both channels, checks that it really has two,
stores it next to the other call audio, and only then deletes Twilio's copy. The call appears in the Oracle with
"phone" as its source, which way it went and the other person's number. It is put on the candidate automatically
when it was placed on a candidate or when the number is exactly one candidate's (on their most recent active
application), and their history says "Phone call, 12 min". Otherwise it is left for the recruiter to add to someone.

The transcript does not guess who is speaking: Twilio puts the person it rang first on the first channel, so on a
call you placed the first channel is you, and on a call that came in it is the caller. Each channel is written out
on its own and the two are woven together by time, with the names filled in. Notes are then written as for any
Oracle call, and the recruiter is e-mailed "Your call notes for Dana Whitlock are ready" with a link. Without e-mail
connected, no e-mail is sent and nothing else changes.

Nobody is at a screen for a phone call, so what would be a button for a browser recording happens by itself. If the
transcription service is busy, failing or not answering, the call goes back in line (after a minute, then five,
fifteen, an hour, and so on for about two days); if it cannot be written out at all, the recruiter is e-mailed
"Your call with Dana Whitlock could not be written out" with the reason and a link. If the e-mail itself cannot be
sent, it is tried again for three days and only marked as sent once the mail provider has taken it. A restart
between the transcript and the notes loses neither: the notes are written and the e-mail sent once the server is
back.

Twilio's messages to The Book (webhooks) are not guaranteed to arrive, or to arrive once. Every one can be
repeated without harm, and once a minute The Book asks Twilio about calls it has heard nothing about and about
recordings that never turned up. A recording that cannot be fetched is tried again for up to thirty days (one day,
if Twilio keeps answering that it has no such recording) and stays at Twilio meanwhile; it is never deleted there
until it is safely here. A restart in the middle loses nothing.

### Telling people the call is recorded

Before a recorded call is connected, the person who did not place it hears, alone:

> "This call from Harbour Talent is recorded and transcribed for recruitment notes. Tell your recruiter if you'd
> prefer it wasn't."

(with your agency's name). A caller hears it when they ring in, after "Thanks for calling". It takes under ten
seconds. It is played before recording starts, which is when it has to be; for the same reason it is **not in the
audio**. What proves it was played is the call's own record: the Oracle shows the words, to whom and when. The
recruiter can also say it once connected, which puts it in the recording.

- `PHONE_NOTICE=off` plays no notice. The call's record then says so, and telling the other person is up to the
  recruiter. Any other text replaces the wording, for example a version your lawyer has approved. Keep it short.
- **Call without recording** places the call with no recording and no notice, and nothing goes to the Oracle. Use
  it when a candidate asks not to be recorded.
- The recruiter hears on their own phone, before pressing 1, whether the call will be recorded.

Canada's privacy law expects people to be told that a call is recorded and why, whoever placed it, and about a dozen
US states require everyone on a call to agree. You cannot tell where somebody is from their number. Telling everyone
on every call covers all of them, which is why it is the default. This is a careful reading of second-hand sources,
not legal advice: have a privacy lawyer confirm the wording once, and add a line about call recording to your
privacy notice. Twilio, Deepgram and Anthropic all process calls in the United States.

### Settings

| Setting | What it is |
| --- | --- |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | From the front page of the Twilio Console. The token signs in to Twilio and is what proves a webhook came from Twilio. |
| `TWILIO_NUMBER` | The number you bought, for example `+16475550100`. |
| `APP_URL` | **The exact public https address of the workspace**, for example `https://hiring.youragency.com`. Twilio signs every webhook with the address it was sent to, and The Book checks that signature against this setting, so it must be the address you gave Twilio, letter for letter: `https`, the same domain (your own domain if you use one, not the Railway one), no path. If it is wrong, every call fails with "an application error has occurred". |
| `PHONE_COUNTRIES` | Countries that may be called, as two-letter codes. Default `CA,US`. |
| `PHONE_NOTICE` | See above. Default on. |
| `PHONE_FORWARD_SHOWS` | `caller` to show a caller's own number when they are put through. Default: The Book's number. |
| `PHONE_CALLS_PER_HOUR` | The most calls one person can place in an hour. Default 30. |
| `PHONE_STRANGERS_PER_HOUR`, `PHONE_STRANGERS_PER_DAY` | The most calls put through from numbers that are not a candidate's. Default 10 an hour and 40 a day. |
| `PHONE_MIN_FREE_MB` | With less free disk space than this, callers are not asked to leave a message. Default 500. |
| `PHONE_VOICE` | Optional: which of Twilio's voices reads the prompts (for example `alice`). |

Without the three Twilio settings (or without an address in `APP_URL`), the app says phone calls are not connected,
and everything else works as before. People can still save their mobile and PIN ahead of time. Settings, Agency
says which of the four is still missing, and shows the two addresses for step 5 below, filled in, ready to copy.

### Setting it up

1. Open a Twilio account and upgrade it from the trial. A trial account can only ring numbers you have verified,
   plays its own message, cuts calls at ten minutes and, if opened in Canada, cannot ring US numbers at all.
2. Buy a local number with Voice. An Ontario number (416, 647, 437, 905, 289, 365) suits an Ontario agency.
3. In Voice, Settings, Geo permissions, allow United States and Canada only, and leave every high-risk box off.
   Check that "Enforce HTTP Auth on Media URLs" (Voice, Settings, General) is on, so recordings cannot be fetched
   without your credentials.
4. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_NUMBER` and `APP_URL` on the server and restart it. Set
   `DEEPGRAM_API_KEY` and `ANTHROPIC_API_KEY` too if they are not already (see [The Oracle](#the-oracle)), and
   connect e-mail if you want the "notes are ready" message.
5. In Twilio, open Phone Numbers, Active numbers, your number, Voice configuration. For **A call comes in** choose
   Webhook, `https://<your address>/api/phone/twilio/inbound`, HTTP POST. For **Call status changes** enter
   `https://<your address>/api/phone/twilio/status`, HTTP POST. Save. Until this is done, calls placed from the app
   work but ringing The Book's number reaches nothing, and The Book cannot know: it shows "Connected" either way.
   Settings, Agency shows the two addresses in full. To check, ring the number from a saved mobile: a voice should
   say "This is The Book".
6. In The Book, each person on the agency team saves their own mobile number under Settings, Your account, and a
   PIN of 4 to 6 digits if they want to ring in (six is better; a PIN needs at least three different digits, and
   runs, years and 2580 are refused). Save The Book's number in your phone as "The Book".

### What stops it running up a bill

- A call can only be placed by a signed-in agency user, or from that user's own saved mobile with their PIN. Caller
  ID can be faked, which is why the PIN exists.
- Numbers are checked before Twilio is asked for anything. Only ordinary numbers in the allowed countries are
  rung. `+1` is not only Canada and the United States: 1-900 and other premium lines, toll-free numbers, and the
  Caribbean countries and US territories that share `+1` (Jamaica, the Dominican Republic, Puerto Rico and the
  rest, each priced on its own) are refused. The same check applies to the mobile a person saves, since The Book
  rings that too. For countries other than Canada and the US, The Book cannot tell a premium-rate number from an
  ordinary one, so if you add any, rely on Twilio's geographic permissions as well.
- Each person can place 30 calls an hour and one at a time, whether from the app or from the switchboard. The
  count is kept in the database, so a restart does not reset it. A call is cut off at three hours. One saved mobile
  can ring the switchboard 20 times an hour, and the PIN prompt ends the call after three asks.
- Calls coming in are put through at most 10 an hour from one number, 60 an hour and 300 a day in all; beyond that
  the call is turned away with a busy tone, without being answered. Calls from numbers that are not a candidate's
  get a much smaller share (10 an hour and 40 a day), because anyone can make them, and each one rings a
  recruiter's phone and may leave a message to store and write out.
- A message left by a number that is nobody's is written out, but no notes are drafted for it until somebody asks
  on its page, at most five e-mails a day are sent about such messages, and one that nobody has put on a candidate
  after 30 days is deleted with its audio. When the disk has less than 500 MB free, callers are not asked to leave
  a message at all, so the room that is left stays for calls being recorded.
- Webhooks are accepted only with Twilio's signature. Anything else is answered 403 and changes nothing.

### Privacy

Phone calls follow the Oracle's rules: agency only; client users are refused on every route and see nothing of a
call, not even the line on a candidate's history. Deleting a candidate deletes their phone calls with the audio,
transcripts and notes, and the entries in each recruiter's list of calls; if a call with them is still going, its
recording is deleted from Twilio when it arrives. A recording that was still at Twilio when the person was deleted
(not fetched yet, or fetched but Twilio's copy not yet deleted) is remembered by its Twilio name alone and deleted
there, tried again until Twilio says it is gone. Deleting a call in the Oracle while it is still going does the
same. Phone numbers and PINs are never written to the server log. PINs are stored as salted hashes. What Twilio
told The Book about each call is kept for two weeks to help with fault-finding, with numbers and keys masked.

A phone recording is a WAV file, about 2 MB a minute (115 MB an hour), much larger than a browser recording, so
watch the disk. Until The Book has fetched and deleted it, a recording sits on Twilio's servers in the United
States; that is normally under a minute.

### What it costs

Estimates gathered in November 2026 from Twilio's published prices, in US dollars; check your own account.

- The number: about $1.15 a month.
- A call you place is two calls to Twilio (to you, then to the candidate) at about $0.014 a minute each, plus
  recording at $0.0025 a minute: **about 90 cents for half an hour**. A call that comes in and is put through is
  about 75 cents for half an hour.
- Some places cost far more per minute: Yukon, the Northwest Territories and Nunavut (area code 867) about $0.15,
  Alaska about $0.09.
- Transcription is billed for both channels, so a half-hour phone call counts as an hour of audio at Deepgram.

### Before you rely on it

**None of this has been run against Twilio.** Twilio could not be reached from where it was built. The requests
follow Twilio's published API description and the code of its own library, and the signature check passes that
library's own test cases; but what Twilio sends in each webhook, and in what order, comes partly from second-hand
summaries of its documentation. Everything was tested against a stand-in written from those sources
(`test/twilio-standin/`), which shows that The Book and the stand-in agree, not that Twilio behaves this way. The
same goes for Deepgram's handling of a two-channel file. Before recruiters use it with candidates, make these
checks on real calls between the team's own phones, in this order:

1. With the account upgraded and the number bought, confirm the two Console settings in step 3 above.
2. Place one call from the app between two of your phones. If a voice says "an application error has occurred",
   `APP_URL` does not match the address Twilio was given (the server log shows requests answered 403).
3. Press 1, talk for a minute with each person saying who they are, and hang up. The call should show as ended
   with its length, and appear in the Oracle within a minute or two.
4. Open the call in the Oracle. The audio should have both voices, and **the names on the transcript should be the
   right way round**. If they are swapped, the channel order is not what Twilio's documentation says; tell whoever
   maintains The Book, because it is one line to change.
5. Listen to the start of the recording: the notice should not be in it. Ask the person called what they heard, and
   note what the caller hears while the notice plays.
6. In the Twilio Console, under Monitor, Logs, Call recordings, the recording should be gone.
7. Place a call and let your own phone go to voicemail. The other phone must not ring, and the call should end as
   "You did not press 1".
8. Ring The Book's number from a phone that is not saved in it: check what the recruiter's phone shows and hears,
   then try again without answering and leave a message. The message should appear in the Oracle.
9. Ring in from a saved mobile and place a call with the PIN. Then call a US mobile on each big carrier you can and
   see how The Book's number is labelled; if it shows as spam, register for caller-ID attestation in Twilio's
   Trust Hub.
10. Look at the first calls in Twilio's usage page and compare the prices with the figures above.

### Not built for phone calls yet

- Stopping a recording part-way through a call. Until then: hang up and call back without recording, and delete the
  call in the Oracle.
- A French notice, or transcription of calls held in French (`DEEPGRAM_LANGUAGE` sets one language for all calls).
- Deleting call audio automatically after a set time.
- Talking through the browser with a headset instead of your own phone.
- Ringing several recruiters at once for a call that comes in, and text messages.

## Your calendar in The Oracle

A recruiter's day, in the same place they record their calls: the events from their own calendar and The Book's
interviews in one list, each with the candidate it is probably with, a button to join or call, and "+ Add" to mark
the ones to record. Nothing has to be set up on the server, and nobody registers an app with Google or Microsoft:
each recruiter pastes one private link from their calendar.

### Getting your link

The link is pasted in under Settings, Your account, "Your calendar", which also has these steps. They are as
Google, Microsoft and Apple describe them, and were not tried while this was built (see
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

Paste the link under Settings, Your account, "Your calendar". The Book reads the calendar once before accepting the link, and says plainly what
is wrong if it cannot. One calendar per person; to use another, paste its link in place of the first.

**Treat the link like a password.** Anyone who has it can read that calendar. The Book stores it sealed, never
shows it again (not to you, not to an admin) and never writes it to a log. To take access away, remove the link
under Settings, Your account, "Your calendar", and to be sure, also reset it where it came from: **Reset** beside the secret address in Google,
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
  recorded from an event, or a phone call placed from it, is shown on it afterwards. An added event is prompted two
  minutes before it starts, while The Book is open in a tab. The Book's own interviews are in the day like any
  other event and are added the same way.

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
own so that reading one never holds up anybody else. A phone number written in an event only becomes a Call button
when it is a number The Book would ring itself (an ordinary number in an allowed country), so an invitation cannot
put a premium-rate or overseas number one tap away. An event set to repeat many times an hour is left out, with a
sentence saying so, before any time is spent working out its dates.

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

1. Create an event with a guest and a Meet or Teams link, paste the calendar's link under Settings, Your account,
   "Your calendar", and check
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
  A draft that has not come back after two and a half minutes is given up on and the basics are filled in instead
  (`AUTOFILL_AI_TIMEOUT_MS` changes how long). Without a key, autofill still works in its basic form and nothing is
  sent anywhere. The same key lets the Oracle
  write call notes and submission drafts.
- **Connect call transcription (optional)** by setting `DEEPGRAM_API_KEY`. See [The Oracle](#the-oracle) for what is
  sent, what it costs and what happens without it.
- **Connect phone calls (optional)** by setting `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_NUMBER` and
  `APP_URL`, and pointing the number's voice webhook at the workspace. See [Phone calls](#phone-calls) for the steps;
  `APP_URL` must be the exact public https address.
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
  reporting.js  The Individual and Clients reports: the record of submissions, first interviews, placements and searches, and the day counting starts
  autofill.js  Drafting a job and its brief from a job description and intake notes
  oracle.js  The Oracle: recording and uploading calls, transcription, notes and submission drafts
  phone.js   Phone calls through Twilio: click to call, the switchboard, calls coming in, fetching the recording
  phone-numbers.js     Reading a phone number as typed, and which numbers may be rung
  twilio-signature.js  Checking that a webhook really came from Twilio
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
  oracle/                               The recorder, the phone line and the day: what The Oracle's cards share with the rest of the app
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
- A reminder for an added event that reaches you when The Book is not open in a tab (the prompt and the desktop
  notification are made by the open page), and a sign-in to Google or Microsoft in place of the pasted link (which
  would also bring guest lists for Outlook).
- Self-service password reset by email. Until then, an agency user deactivates the account and invites the person
  again at the same address (see "Accounts and getting back in").
- Declining many account requests at once; each is declined on its own, and unanswered ones expire after 14 days.
- AI-assisted screening of applications. (Calls are summarised by the Oracle; applications and résumés are not.)
- Joining a video call to record it. The Oracle records in the recruiter's browser, or takes an uploaded recording.
- Multi-posting to job boards, e-signature for offers, and headcount planning or onboarding checklists.
- Automated tests that drive the screens in a browser as part of `npm test`. `npm test` covers the résumé reader,
  job autofill (the plain reader, and the route against a stand-in for the AI service), the recruiter brief, the activity
  feed's milestones, résumé and photo files, the Oracle's server side, the Oracle's uploader, phone calls against a stand-in for Twilio, the
  calendar against calendar files, and reporting (every number on the Individual and Clients reports, through a
  story acted out either side of the start date and over more than a year, with the reports' clock set by the test). The Oracle's screens were driven end to end in Chrome with a simulated microphone
  while it was built (record, reload and server restart mid-call, a lost connection, two people on one computer,
  transcript, notes, add to a candidate, draft, submit, delete), against stand-ins for Deepgram and Claude. The
  phone and calendar screens were driven the same way at 1280 and 390 wide (save a mobile and PIN, call and watch
  each state, calls that do not connect, an unrecorded call, the switchboard, a call coming in, connect a calendar,
  add an event, the prompt, record and call from an event, a client user seeing none of it), against the same
  stand-ins, the stand-in for Twilio and a calendar file: no real phone rang and no real calendar link was read.
  The Individual and Clients reports, the start date, the placement fee on a hired candidate and the tick on the
  job form were driven in Chrome at 1280 and 390 wide on the demo data, and printed to PDF.
  The other screens were verified by hand.
