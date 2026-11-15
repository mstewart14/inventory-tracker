"""The privacy policy, a plain page anyone can open with no sign-in (FR-PUB-07).

Served by the server, not the client: an app store's reviewer, or anyone who never installed
the app, opens it as a link, with no script and no service worker. It is written for everyone the
society deals with: people who receive goods, people who give them, and people with accounts. A change
to what is kept about any of them is a change to this page (FR-PUB-08). The text is the same for
every group. The group's name and mail address are filled in from its settings when it is asked for.
"""

from html import escape

UPDATED = "14 November 2026"

STYLE = """
:root { color-scheme: dark; }
body { margin: 0; background: #001a70; color: #fff; font: 18px/1.5 system-ui, -apple-system, sans-serif; }
main { max-width: 40rem; margin: 0 auto; padding: 1rem 16px 3rem; }
h1 { font-size: 1.6rem; margin: 0.5rem 0 0.25rem; }
h2 { font-size: 1.2rem; margin: 1.75rem 0 0.25rem; }
p, li { margin: 0.4rem 0; }
ul { padding-left: 1.25rem; }
a { color: #fff; }
.muted { color: rgba(255, 255, 255, 0.7); }
"""


def page(group: str, mail_from: str | None) -> str:
    """The whole page. `mail_from` is the address the group's mail is sent from."""
    who = escape(group) if group else "the society"
    subject = escape(group) if group else "The society"
    if mail_from:
        ask = f'email <a href="mailto:{escape(mail_from, quote=True)}">{escape(mail_from)}</a>'
    else:
        ask = "talk to the society's staff"
    title = f"Privacy · {escape(group)}" if group else "Privacy · Inventory Tracker"
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>{STYLE}</style>
</head>
<body>
<main>
<h1>Privacy</h1>
<p class="muted">Last updated {UPDATED}</p>

<p>{subject} uses Inventory Tracker to keep track of donated goods: what was given, where it is stored, what is set
aside for someone, and what was given out. {subject} runs it, not a company.</p>

<h2>If you receive goods from us</h2>
<p>You do not need an account, and we do not ask who you are. Inventory Tracker has no place to record your name,
address, phone number, or anything about your health.</p>
<p>When goods are set aside for you, the hold carries a nickname or initials, typed by our staff or by the outreach
worker who asked for it. That is all it knows about you.</p>
<ul>
<li>The nickname is deleted when the goods are handed to you, or when the hold ends any other way.</li>
<li>It is never written to our permanent records, and never put in an email.</li>
<li>While the hold is open, our staff can see it, and so can the outreach worker who asked for the hold. No other
outreach worker can.</li>
</ul>
<p>If the goods are delivered, we record a time and a drop-off point: a place to meet, not your home or your name. The
drop-off point is deleted with the nickname, and is never put in an email. The time stays in our records, with nothing
that says who the delivery was for.</p>
<p>A backup taken while a hold is open includes its nickname and drop-off point, until that backup is deleted.</p>

<h2>If you give goods to us</h2>
<p>You do not need an account. Staff can note where a donation came from, such as an organization or a clothing drive.
That note is optional and is kept for good. If you give as a person and do not want your name recorded, tell our
staff.</p>

<h2>If you look at what is available</h2>
<p>The public list of goods needs no account. It sets no cookies and does no tracking. It takes no requests: to get
goods, you speak with our staff.</p>

<h2>If you have an account</h2>
<p>Our staff, our administrators, and outreach workers from other organizations have accounts. For them we keep:</p>
<ul>
<li>Your account: your name, email address and role. Your password is kept only as a one-way hash, so no one can read
it.</li>
<li>Each thing you record: goods taken in, moved, held, handed out, or changed, with your name and the time. An
outreach worker's requests for holds are recorded the same way.</li>
<li>Notes and photos that you add.</li>
<li>For each device you sign in on: what kind it is, such as "Safari on iPhone", which version of the app it runs, and
when it last connected. Not the full details your browser sends.</li>
</ul>
<p>We keep these records for as long as {who} uses Inventory Tracker. They are the history of what was given and
where it went.</p>
<p>Please keep details about the people we serve out of notes. A note is kept for good.</p>

<h2>Reports from the public</h2>
<p>Anyone who finds something of ours with a code on it can tell us where it is, with no account. We keep what they
type, including any contact details they give. Staff can see it, and staff who asked for these alerts get it by
email.</p>

<h2>Photos</h2>
<p>The app re-saves most photos smaller before sending them, which drops where they were taken. A photo it cannot
re-save is kept as it arrived, and may include where it was taken if the phone saved that.</p>

<h2>On a staff phone</h2>
<p>The app keeps a copy of our records on each staff phone, so it works with no signal. This includes staff names,
notes, and the nickname and drop-off point of each open hold. Those two are removed from the phone when the hold
ends.</p>
<p>An outreach worker's phone keeps no copy. It is shown the goods marked for outreach and that worker's own
requests, each time it is opened.</p>
<p>When someone scans a code, the camera only reads the code. No picture is saved or sent.</p>

<h2>Logs and backups</h2>
<p>The server keeps short-term logs of each request and of failed sign-ins, with the IP address and email address, to
keep it working and secure. They are deleted after a while.</p>
<p>The database is backed up regularly, and old backups are deleted.</p>

<h2>Who can see it</h2>
<ul>
<li>Signed-in staff and administrators see the records. Administrators also see account email addresses.</li>
<li>An outreach worker sees only the goods marked for outreach or for the public, and their own requests.</li>
<li>Anyone can see the goods marked public: a name, a description, categories and photos. Not how many there are,
where they are kept, where they came from, or who has a hold.</li>
<li>Someone who scans a code without signing in sees only our name and how to contact us.</li>
</ul>

<h2>What we do not do</h2>
<p>No ads, no tracking and no analytics. We do not sell or share your data. The only other services involved are:</p>
<ul>
<li>our email provider, which sends invites, password resets and alerts to people with accounts. An email about a
hold never says who the hold is for or where a delivery goes.</li>
<li>calendar feeds we add. The server fetches them and sends nothing about you.</li>
</ul>

<h2>AI assistants</h2>
<p>A staff member or administrator can connect an AI tool of their own to Inventory Tracker. That tool gets what it
asks for, as far as that person is allowed to see. This includes the nickname and drop-off point of an open hold. We
do not control that tool or what it does with the data. An outreach worker cannot connect one. Inventory Tracker
itself uses no AI service.</p>

<h2>Deleting your account</h2>
<p>In the app, go to Settings, then Delete my account. This signs you out, and you cannot sign in again. Your other
devices sign out the next time they connect. Your name stays on the records of what you did, because they are the
history of what was given and where it went. An administrator can restore your access.</p>

<h2>Questions</h2>
<p>To ask about your data, {ask}.</p>
</main>
</body>
</html>
"""
