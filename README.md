# RosterCheck

A web app that checks a Sleeper fantasy league's rosters against custom rules
Sleeper itself doesn't enforce:

- **QB/TE limits**: max 2 QBs and 2 TEs per roster, unless a 3rd is a rookie
  or 2nd-year player drafted in the rookie draft or added before Week 1
  (including rookie waivers). The exception lasts up to 2 years and carries
  forward through trades, but not through a drop-and-re-add on waivers.
- **Taxi squad rules**: 1st/2nd-year players only, drafted or added via
  waiver/free agency at any time during the season, max 2 seasons on taxi,
  max 3 taxi moves per season, and a player promoted off taxi can't return
  to it without going through waivers.

It's a static site with no backend for the core checks - it calls Sleeper's
public API directly from your browser. Two optional background pieces run via
GitHub Actions: a **daily taxi snapshot** (auto-detects taxi moves/promotions)
and a **daily violation check that emails you a PDF report**. Both are
optional - the app works fine without them, just with more manual tracking.

This build is locked to a single league (set in `app.js` and `config.json`)
and has a **viewer/admin split**: anyone with the site's URL sees a read-only
view of rosters and violations; only whoever has the private admin link can
make manual overrides, adjust taxi moves, or change settings. See "Sharing
the app with your league" below.

## Recommended hosting: GitHub (Pages + Actions) - both free

This app is designed to be deployed straight from a GitHub repo, because that
gets you free static hosting *and* free daily background jobs from the same
place, with no external database or service to sign up for.

### 1. Create the repo
1. Create a new **public** GitHub repository (public keeps Actions minutes
   unlimited; a private repo works too but has a monthly minutes cap - the
   daily jobs here are tiny, so either works). Note: even with a private
   repo, the *deployed site* is still publicly reachable by URL once Pages
   is on - repo privacy doesn't hide the live app or its files, only the
   source browsing view on github.com. See the admin-access section below
   for what that does and doesn't protect against.
2. Push everything in this folder to that repo.

### 2. Turn on GitHub Pages
1. In the repo, go to **Settings -> Pages**.
2. Under "Build and deployment", set Source to **Deploy from a branch**,
   branch `main`, folder `/ (root)`.
3. Save. You'll get a URL like `https://yourname.github.io/reponame/`.

### 3. Turn on write access for the daily job
1. Go to **Settings -> Actions -> General**.
2. Under "Workflow permissions", select **Read and write permissions**.
3. Save.

### 4. Set your admin token
This app is already locked to your league (`1314033821036851200`) in both
`config.json` and `app.js`. The one thing you need to set is your own admin
token, which unlocks override controls for you (and only you).

Edit `config.json` in the repo and replace the placeholder:
```json
{
  "leagueId": "1314033821036851200",
  "seasonsBack": 2,
  "weeksToScan": 18,
  "notifyOn": "violation",
  "adminToken": "pick-your-own-long-random-string-here"
}
```
Pick something long and hard to guess - not a word your league would guess,
like a passphrase or a string of random characters. Commit the change.

- `seasonsBack` / `weeksToScan`: how much history the background job scans -
  match these to whatever you've set in the app's Settings panel if you've
  changed them from the defaults.
- `notifyOn`: `"violation"` (default, only emails when a real rule is broken)
  or `"violation_and_review"` (also emails when something needs a manual look).

### 5. Set up the daily email (optional)
The email step uses your Gmail account via an **App Password** - free, no
new service to sign up for.

1. Turn on 2-Step Verification on the Google account you want to send from,
   if it isn't already: https://myaccount.google.com/security
2. Create an App Password: https://myaccount.google.com/apppasswords
   (choose "Mail" as the app). Google gives you a 16-character password.
3. In your GitHub repo, go to **Settings -> Secrets and variables -> Actions**
   and add three repository secrets:
   - `EMAIL_USER` - your Gmail address
   - `EMAIL_PASS` - the 16-character App Password from step 2
   - `EMAIL_TO` - where the report should be sent (can be the same address)

If you skip this step, the daily job still runs and logs whether it found a
violation - it just won't send an email without those three secrets set.

### 6. Test it
1. Go to the **Actions** tab in your repo.
2. Click **Daily Roster Check** in the sidebar, then **Run workflow**.
3. Check the run's logs for what it found, and check your inbox if a
   violation was detected and email secrets are set.
4. From then on, it runs automatically once a day (default 13:00 UTC - edit
   the `cron:` line in `.github/workflows/snapshot.yml` to change the time).

That's it - no server, no database, no credit card.

### Alternative: Vercel Cron + Vercel KV + a transactional email API
If you'd rather not use GitHub Actions/Gmail, Vercel's free (Hobby) plan
supports daily Cron Jobs, paired with Vercel KV (free-tier Redis) instead of
committing JSON files, and a transactional email API (e.g. Resend's free
tier) instead of Gmail SMTP. More moving parts for the same result - happy to
build that version instead if you'd prefer it.

## Sharing the app with your league

- **Give your league members the plain URL** (e.g. `https://yourname.github.io/reponame/`).
  They'll see current rosters, taxi status, and any violations - fully
  read-only. No gear icon, no override buttons, no settings.
- **Your own admin link** is the same URL with `?admin=YOUR_TOKEN` appended,
  e.g. `https://yourname.github.io/reponame/?admin=your-token-here`. Visit it
  once per device (phone, laptop) - the app remembers you're the admin on
  that device from then on (via local browser storage) and cleans the token
  out of the visible address bar immediately, so it's not left sitting there.
  You can revoke it on a device any time via Settings -> "Exit admin mode."
- **Security reality check**: this is a soft gate, not real authentication.
  The site is fully public static files - anyone who opens their browser's
  developer tools and reads the JavaScript could technically find how the
  check works and construct their own admin link. For a trusted group of
  league mates, that's a non-issue in practice; nobody's going to reverse-
  engineer your fantasy app. If you ever need protection against a genuinely
  adversarial user, that requires real backend authentication, which is a
  different (and more involved) kind of project - let me know if that
  becomes a real need.
- If you ever want to rotate the admin token (e.g. you think it leaked),
  just change `adminToken` in `config.json`, commit, and your old link stops
  working - you'll need to visit the new one to regain admin access.

## Add it to your iPhone home screen

1. Open the deployed URL in **Safari** on your iPhone.
2. Tap the Share icon (square with an arrow).
3. Tap **Add to Home Screen**.

It'll open full-screen like a native app from then on.

## Using the app

1. Visit the site - it loads your league automatically (no setup needed per
   visit; the league is locked in via `config.json`/`app.js`).
2. The app pulls current rosters, transaction history, and draft picks, then
   flags any roster that's over the QB/TE limit or breaking a taxi rule.
3. Tap a flagged player to see the reasoning trail. Admins additionally see
   buttons here to manually approve or override a call if the automation
   gets an edge case wrong.
4. Tap **Download PDF report** any time for an on-demand PDF violation report -
   a top summary of taxi moves, taxi promotions, and QB/TE moves worth
   flagging, followed by full detail only for teams currently in violation
   (compliant teams and "needs review" items aren't listed - resolve those
   in the app first if you want them reflected). Available to everyone,
   admin or not.
5. Admins: tap the gear icon for settings - adjust how many past seasons are
   scanned, set exact Week 1 dates if the estimated ones are off, adjust
   taxi move counts, or clear overrides.

## The two PDF reports aren't quite the same thing

- **On-demand ("Download PDF report" button, in your browser)**: reflects
  exactly what's on screen, including any manual overrides or "previously
  promoted" markings you've made in the app.
- **Automated daily email (if set up)**: a pure, automated read of Sleeper's
  data plus the daily taxi-snapshot log. It does **not** see your manual
  overrides, because those live in your browser's local storage, not in this
  repo. If you've manually approved something in the app, the daily email may
  still list it - that's expected, not a bug. Resolve it in the app, and use
  the on-demand PDF for the "official" version if you need a corrected copy.

## Known limitations

- Week 1 kickoff dates are estimated (Thursday after Labor Day) unless you
  set exact dates in the app's Settings. The automated email job uses the
  same estimate unless you add a `data/week1-overrides.json` file with the
  same `{ "2026": "2026-09-04" }` shape.
- Assumes your league's roster IDs stay consistent season to season, which
  is standard for continued Sleeper dynasty leagues.
- When history can't be traced far enough back, a player is marked "Needs
  review" instead of guessed at - use the manual override to resolve it.
- Taxi moves-per-season and the promotion-return rule rely on the daily
  snapshot job; without it they're manually logged in the app, and even with
  it running, a move-and-reverse within the same day won't be caught.
- GitHub Actions' schedule can run a bit late during high load - it's a
  known platform quirk, not something this app controls.
