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
| **The Oracle** | Every call with a candidate in one place, in two tabs. **Metaview**: the conversations your agency records in Metaview, findable and on the right candidates, each opening with its transcript and Metaview's notes. **Record a live conversation**: record a call in the browser, or upload a recording, and it is written out with who said what. Either way a notes summary is there and one click drafts the write-up for the hiring team. Agency only. See [The Oracle](#the-oracle) and [Metaview in The Oracle](#metaview-in-the-oracle). |
| **Inbox** | Every new application across all clients lands in one review queue, oldest first. |
| **Pipeline** | A drag-and-drop board per job with stages you define. Ratings, notes (optionally agency-only), rejection reasons, withdrawals, offers. |
| **Shortlist hand-off** | Submit a candidate to the hiring team with your write-up. They approve (the candidate moves to the next interview stage) or decline with a reason, so you can calibrate. |
| **Interviews** | Schedule with a panel, download a calendar file, and collect a structured scorecard from each interviewer against the criteria set on the job. Outstanding scorecards are chased in the sidebar and dashboard. |
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

The Oracle is where recruiters' calls with candidates are kept: the ones recorded in Metaview (see
[Metaview in The Oracle](#metaview-in-the-oracle)) and the ones recorded or uploaded in The Book itself. This
section is about the second kind; once a call is in The Oracle, both kinds work the same way.

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
  The Oracle. See [Metaview in The Oracle](#metaview-in-the-oracle).
- **Record a live conversation.** For a call on Meet, Zoom or Teams, on speaker, or in person: record it in the
  browser, or upload a recording made elsewhere. The calls recorded or uploaded in The Book are listed underneath.
  See [Recording a call](#recording-a-call).

A candidate's profile has a Calls tab with their calls of both kinds, in the order the conversations happened.

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
- **To Metaview:** only the key and the requests themselves (which conversations to list or fetch). Nothing about the
  candidates in The Book goes there. See [Metaview in The Oracle](#metaview-in-the-oracle).

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

## Metaview in The Oracle

If your agency records its candidate calls in [Metaview](https://www.metaview.ai), The Oracle can show them. The
Metaview tab lists every conversation Metaview has for you, puts each one on the candidate it was with, and opens
any of them as a call in The Oracle: the transcript with the speakers named, Metaview's own notes as the notes
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
   (the **Connect Metaview** button on The Oracle's Metaview tab leads there). The Book tries the key against
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
  in The Oracle, on the candidate it was matched to (their most recent job in progress) or the one the recruiter
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
- **For a conversation that has been brought in:** its transcript and notes, on the call in The Oracle.
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
moment. Calls already in The Oracle stay, and still open. The same care is taken when the key is replaced by one
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
- **Connect Metaview (optional)** in the app: an admin pastes a Metaview key under Settings, Agency, Metaview. Nothing
  needs setting on the server, though `METAVIEW_API_KEY` works too. See [Metaview in The Oracle](#metaview-in-the-oracle).
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
and leaves every call in The Oracle alone, phone calls included. Anyone who had saved a calendar link can also
reset their calendar's private address with their calendar provider, which makes the old link useless everywhere.

## How it is built

```
server/
  index.js   Express server; serves the API and the built front end
  api.js     All API routes: auth, careers pages, jobs, pipeline, interviews, reports
  autofill.js  Drafting a job and its brief from a job description and intake notes
  oracle.js  The Oracle: recording and uploading calls, transcription, notes and submission drafts
  metaview.js         Metaview in The Oracle: the key, reading the list in the background, bringing calls in
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
  oracle/                               What The Oracle's screens share with the rest of the app (the recorder)
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
- AI-assisted screening of applications. (Calls are summarised by the Oracle; applications and résumés are not.)
- Joining a video call to record it. The Oracle records in the recruiter's browser, or takes an uploaded recording
  (Metaview joins meetings itself, and those conversations arrive through the Metaview tab).
- Multi-posting to job boards, e-signature for offers, and headcount planning or onboarding checklists.
- Automated tests that drive the screens in a browser as part of `npm test`. `npm test` covers the résumé reader,
  job autofill (the plain reader, and the route against a stand-in for the AI service), the recruiter brief, the activity
  feed's milestones, résumé and photo files, the Oracle's server side, the Oracle's uploader, Metaview in The Oracle
  against a stand-in for Metaview, and starting on a database from before phone calls and the calendar were taken
  out. The Oracle's recording screens were driven end to end in Chrome with a simulated microphone while they were
  built (record, reload and server restart mid-call, a lost connection, two people on one computer, transcript,
  notes, add to a candidate, draft, submit, delete), against stand-ins for Deepgram and Claude. The two tabs with
  Metaview were driven the same way at computer and phone widths against the stand-in for Metaview (connect, the
  history being read, search and filters, open, choose a candidate, draft and submit, a candidate's Calls tab,
  record, upload, a recruiter, a client user, disconnect).
  The other screens were verified by hand.
