# Training & Recovery — a personal fitness insights site

Your Garmin Venu Sq wellness data and your full Strava history, turned into one private page: a daily
**train / easy / rest call**, your own **sleep score**, a **readiness** score against your own normal, the
**fitness / fatigue / form** model, a phone **ride mode** with live HR and interval cues, and a day-by-day **season plan** that re-optimizes every time it's built.
The plan runs through the Iceman Cometh (Nov 7, 2026) and a Zwift / MyWoosh trainer winter (Dec 1 – Feb 28) to
Barry-Roubaix (Apr 17, 2027), with the 100k and 50k compared side by side.

```bash
python -m fitness demo --open        # see it with a synthetic athlete first; no accounts needed
```

It installs as an app on your phone from **<https://chrisrohn.com/fitness/>**, with your data kept only on the phone
(see [The app on your phone](#the-app-on-your-phone)).

## What the Venu Sq can and can't give you

The original Venu Sq has no Sleep Score. That's mostly Garmin limiting it in firmware. The watch already records
nearly everything a sleep score is built from: sleep stages, duration, awake time, overnight stress (which Garmin
derives from HRV), respiration and resting HR. Garmin only shows a Sleep Score on newer devices (the Venu Sq 2 and
later). The one real hardware gap is overnight HRV in milliseconds. The Sq doesn't support HRV Status, so Garmin
never exposes those numbers. This site uses overnight stress in its place.

| Signal | Venu Sq | Used for |
|---|---|---|
| Sleep stages, duration, awake time | ✅ | Sleep score |
| Overnight stress (HRV-derived) | ✅ | Sleep score, readiness (stands in for HRV) |
| Resting HR, sleeping respiration | ✅ | Readiness, illness watch |
| Body Battery | ✅ | Readiness |
| Pulse Ox overnight | ✅ if turned on | Shown when present |
| Overnight HRV (ms), HRV Status, Training Readiness | ❌ hardware | Replaced by the readiness model here |
| Garmin Sleep Score | ❌ firmware | Replaced by the sleep score here |

The **Data** section of the page shows how many of the last 30 days actually came through for each signal.

## Races and the trainer season

Races live in [`config.toml`](config.toml) as `[[races]]` blocks. Each one has a date, a kind (`mtb` or `gravel`,
which picks the session library), the race-morning form band, and words that find past editions in your history.
`every = "3rd Sat Apr"` rolls a race to next year's date once it's past. Each race has one or more distance
`options`, each with its own expected race time, target fitness (CTL), longest training ride and taper range.

Barry-Roubaix is set up with two options. Its "100k" is the **Killer, 62 mi / ~4,000 ft**, and the closest thing
to a "50k" is the **Thriller, 36 mi / ~2,200 ft**. The organizer also runs the 18-mi Chiller and the 100-mi Psycho
Killer. `distance = "100k"` is the option today's call follows. The page has a button for each option and
compares them on projected race-morning fitness against target and on peak training week. It also tells you
whether the longer one is realistic, and to decide by the day the outdoor build starts (Mar 1).

The `[indoor]` window (Dec 1 – Feb 28 every year, Feb 29 included in leap years) shapes both the plan and the
history:

- **The plan.** Inside the window every session is a trainer workout written for ERG mode: sweet spot, tempo,
  threshold and over-unders, with VO2 and 30/30s added in February. Long rides are capped at
  `indoor.long_ride_h`, best done as a group ride or event. A ramp FTP test is scheduled on the first hard day of
  December and again in February. Every 4th week is an easy week. The indoor base adds at most
  `plan.base_ramp` CTL a week, then the outdoor build in March adds at most `plan.max_ramp`. Between Iceman and
  Dec 1 there's a recovery week, then transition: strength twice a week and unstructured riding.
- **The history.** Rides recorded as Strava *Virtual Ride*, flagged *trainer*, or with Zwift / MyWoosh in the
  name count as indoor. They get their own color in the weekly-hours chart, and the Training section shows the
  season's rides, hours, average power and how your best-effort FTP moved.
- **FTP.** Zwift and MyWoosh send trainer power, so with an FTP set, those rides are scored from power. Leave
  `ftp = 0` and the site estimates FTP from your best 20–90 minute power ride of the last year. After each ramp
  test, put the real number in `config.toml`.

## Bike commuting

Your 30 km each-way commute is weekday training, so the plan builds it in instead of stacking it on top. Set it up
under `[commute]` in `config.toml`: distance, climbing, the days you can ride (most preferred first), and how many
commute days a week you want at least and at most (default 1–3).

**How the plan uses it.** Each week the planner checks the load it wants on each commute-able day against what a
round trip actually costs you. The cost is learned from your past commutes: about 110–130 TSS and 2¼ hours. It books
the best-fitting days, and the commute replaces that day's session, so it never comes on top of it:

| The day's job in the plan | How the commute is ridden |
|---|---|
| Key session | **Commute + workout:** in easy (Z1–Z2); home with a flat-road workout (2 × 15 sweet spot, 30 min tempo, 3 × 8 threshold, or race-pace blocks for gravel), the rest Z2 |
| Endurance | **Endurance commute:** Z2 both ways, steady, no surges at the lights |
| Easy, taper, recovery week | **Easy commute:** Z1 both ways, soft-pedal, arrive fresh |
| Rest, openers, race, last 2 days before a race | Leave the bike |
| Trainer season (Dec–Feb) | Leave the bike, unless `winter = true` |

**The morning call.** On a commute day the dashboard's call *is* the commute, and readiness can only make it
easier:
- ≥ 75: as planned.
- 60–74: as planned, but on a workout day you decide on the ride home (see the check below).
- 45–59: easy both ways, no intervals.
- Below 45, or an illness flag: leave the bike.

On a non-commute weekday it says whether an optional easy commute makes sense. Each call gives the heart-rate
ranges for each leg in bpm, the expected time, and a fueling plan for the day: breakfast, food at work, and an
afternoon snack before the ride home.

**Your commute as a fitness test.** A ride is counted as a commute if Strava's commute box is ticked, or if it's a
weekday ride of about the commute's length starting at 5–10 am or 2–8 pm. Same route and terrain every time makes
it a free, repeated test. The Training section charts speed per 100 bpm for each direction and tells you when it
moves: rising means aerobic fitness, and a drop that lasts a week means fatigue.

**The in-ride check.** Ride mode has *Commute in* and *Commute home* sessions. After 8 minutes it compares your last
5 minutes of heart rate with what you usually need for that speed on that leg, using a line fitted to your past
commutes. At 6+ bpm high it shows (and says) *running hot: keep it easy, skip the intervals*. That's the honest
answer to "should I do the workout on the way home?". At 4+ bpm low it tells you it's a good day for the work.

## Ride mode: live data on the phone on your bars

**Your Venu Sq can't send live data to a phone.** It broadcasts heart rate over ANT+ only. iPhones have no ANT+
radio and few current Android phones do, and the Garmin Connect app doesn't show live workout data. So
the phone needs its own sensor.

- **Get a Bluetooth heart-rate sensor.** A chest strap is the most accurate: Polar H10, Garmin HRM-Dual or Wahoo
  TICKR. An optical armband is more comfortable for a 4-hour Barry-Roubaix: Scosche Rhythm+ 2.0. Pick one that
  does both Bluetooth and ANT+, so it also works with Zwift on any device. Without a power meter, HR is what your
  training load is built on, and a wrist sensor reads poorly when you're gripping the bars on rough two-track.
  A strap or armband improves every number on the dashboard, not just the live view.
- **Optional: a Bluetooth speed/cadence sensor.** Wheel speed stays accurate under tree cover, where phone GPS
  wanders (most of Iceman). Set your tire's circumference in `[ride] wheel_m`. A Bluetooth power meter works
  too, if you ever get one.

`python -m fitness build` writes **`dist/ride.html`**, and the dashboard header gets a **Ride mode** button.
On the phone it shows:

- **Live readings:** heart rate, with your zone and a marker on the zone bar; time, distance, speed (from the
  wheel sensor, else GPS), cadence or power, average HR, and live load against the planned TSS.
- **The day's session as timed steps.** For example: warm-up → VO2 1/5 at **166–176 bpm** → easy 3 min → …
  - Each step shows a countdown, its target range from your threshold HR, and a status (▲ Push / On target /
    ▼ Ease off). Efforts of 2 minutes or less say *by feel*, because HR lags them.
  - Each step change gets beeps, a vibration (Android) and a spoken cue, with a 3-2-1 countdown before it.
- **Practical touches:**
  - **Fueling prompts** every 20 minutes after the first 20, with more carbs suggested on long days.
  - **Screen kept awake.** Ride mode asks the phone to keep the screen on.
  - **Survives a reload.** A reload or tab switch mid-ride restores the ride, paused.
  - **Summary:** a ride summary with time in zones at the end.

The watch keeps recording the official file, and ride mode uploads nothing.

**Browser.** Android: Chrome. iPhone: Safari and iOS Chrome can't use Bluetooth sensors, so install the free
**Bluefy** browser and open ride mode in it. GPS, steps and cues work in any browser. On iPhone, also set Auto-Lock
to *Never* for rides, in case the browser ignores the keep-awake request.

**Where it lives: <https://chrisrohn.com/fitness/ride.html>**, inside the installed app. The site build
(`fitness/build-app.mjs`, called from `build.mjs`) publishes it with the rest of chrisrohn.com. It's a data-free page: no zones, plan or history are
in it, and it's `noindex`. A strict Content-Security-Policy lets only its own scripts run and nothing load,
because it shares an origin with the music app. HTTPS is what phones require for Bluetooth and GPS.

**Getting the week onto the phone:** open the dashboard, then **Today → Ride mode on your phone**, and scan the QR
code. You can also tap **copy the link** and send it to yourself. The link carries your HR anchors and the next 7
days of sessions, compressed into its `#fragment`, which browsers never send to a server. The phone keeps that
plan, so the page works with no signal at the trailhead. Rescan when the plan changes. A link that won't decode
is ignored, and the plan already on the phone stays.

You can also host it elsewhere: `python -m fitness ride-page` writes a data-free copy to `dist/public/ride.html`.
Put the folder's address in `[app] url`. To use the local copy with no hosting, set `url = ""` and serve it over
Tailscale (`tailscale serve --bg 8765` alongside `python -m fitness serve`).

A big GPS screen for hours drains the battery: for Barry-Roubaix, dim the screen or bring a small battery pack.

## Cloud sync (no computer)

Everything runs on GitHub and your phone. A **private** repository of yours syncs Garmin (and Strava, if you use it) four times a day
(6:17, 9:17, 13:17, 19:17 Michigan time) with [`fitness-sync.yml`](../.github/workflows/fitness-sync.yml), and the app
at <https://chrisrohn.com/fitness/> reads the result with a token that can only see that repository. Garmin's
official API is for approved companies only, so this signs in the way Garmin's own mobile app does.

**One-time setup, about 10 minutes, all from the phone's browser:**

1. **Repository.** <https://github.com/new>: name `training-data`, **Private**, tick *Add a README*. Then add
   [`cloud/training.yml`](cloud/training.yml) to it as `.github/workflows/training.yml`.
2. **Secrets.** In `training-data`: *Settings → Secrets and variables → Actions → New repository secret*:

   | Secret | Value |
   |---|---|
   | `GARMIN_EMAIL`, `GARMIN_PASSWORD` | your Garmin Connect sign-in |
   | `STATE_KEY` | any long passphrase you make up; it encrypts the stored sign-ins and history. Losing it means a fresh first sync, nothing worse |

3. **Token for the app.** <https://github.com/settings/personal-access-tokens/new>: *Repository access → Only select
   repositories → training-data*; *Permissions → Actions: Read and write, Contents: Read-only*. Choose the longest
   expiry offered.
4. **Connect.** Open the app → **Connect GitHub** → `yourname/training-data` and the token → **Save and sync**.
   Then **Connect Garmin** (if Garmin emails you a sign-in code, type it into the bar that appears).
5. **Trainer rides.** In Zwift's and MyWoosh's connection settings, link Garmin Connect. Their rides then arrive
   with power, and the sync marks them as trainer rides.

**Your Strava history (free).** Strava's account export carries every activity you've ever uploaded, and the sync
imports it once:

1. On strava.com (in the phone's browser, desktop view): *Settings → My Account → Download or Delete Your Account
   → Get Started → Request your archive*. Strava emails a link to a zip, usually within a few hours.
2. Open the zip on the phone (Files by Google: tap it → *Extract*) and find `activities.csv`.
3. In `training-data`, open the `strava` folder → *Add file → Upload files* → pick `activities.csv` → *Commit
   changes*. (No `strava` folder yet? Create `strava/README.md` with *Add file → Create new file* first.)
4. **Sync now** in the app. The setup list shows *Strava history imported · N activities*. Upload a newer export
   any time; each file is imported once, and rides the watch also recorded are merged with their Garmin copy.

**Strava (optional, live).** Strava's API needs a paid Strava subscription since June 2026. With one, create an app at
<https://www.strava.com/settings/api> (*Authorization Callback Domain* `chrisrohn.com`), add `STRAVA_CLIENT_ID` and
`STRAVA_CLIENT_SECRET` as secrets, and **Connect Strava** appears in the app. Without it, the sync and the app
simply leave Strava out.

The first sync backfills a year of Garmin days and activities (up to 15 minutes; with Strava, all of its history too). After that the
app shows the newest sync whenever you open it, and **Sync now** runs one on demand (about a minute), e.g. right after
the watch has synced last night's sleep.

**What lives where.** The private repository's `state` branch holds `fitness-data.json` and `status.json` (what the
app reads) and `state.enc` (the SQLite history and the Garmin / Strava sign-ins, encrypted with `STATE_KEY`); each
run replaces it in a single commit. Nothing personal is ever written to this public repository or its site.

**When something goes wrong** the bar under the masthead says what (from `status.json`) and GitHub emails you about
the failed run. Garmin sometimes asks for a fresh sign-in after a password change or about once a year: tap
**Connect Garmin** again. A new Garmin password goes into the `GARMIN_PASSWORD` secret first.

## When the plan doesn't happen

Every sync rebuilds the plan from what you actually did ([`plan.py`](plan.py) `adapt`), and the Today card says
what changed under **Plan adjusted**:

- **A missed long ride** moves to the next free day that week: Saturday's to Sunday.
- **A missed key session** moves to a free day with no hard day on either side. If there isn't one, it's dropped
  rather than crammed in.
- **A missed commute** (weather, a meeting) is rebooked later in the week. Commutes you've already ridden count
  toward the week's 1–3, so a skipped one is made up and none is doubled.
- **Today, as it happens.** If no ride in is logged by 10:00 on a commute day, today stops being a commute. The
  session it replaced comes back for the evening, on the trainer or outside, and the food plan follows. If nothing is
  logged by 19:00 on a long-ride day, the long ride moves to tomorrow when tomorrow is free.
- **Fitness lost to a missed day** isn't made up in one go. The coming weeks' load targets are recomputed from the
  fitness you actually have, still capped at `max_ramp`, so the race-day target stays honest without a cram week.

Recovery weeks, tapers and race weeks aren't rearranged: there, a missed session simply stays missed.

## What to eat

The **Fuel** panel under today's call plans the day's eating, with tomorrow's in a fold ([`fuel.py`](fuel.py),
`[nutrition]` in [`config.toml`](config.toml)):

- **The Nutty Pudding and the Super Veggie** (Bryan Johnson's Blueprint, the make-it-yourself versions) whenever
  they fit: the Pudding at breakfast unless a hard ride starts within a few hours (then it's the recovery meal) or
  it's race morning; the Super Veggie at lunch unless a race is today or tomorrow.
- **A vegetarian base for every other meal and snack**: how many grams of carbs and protein it should carry, sized
  to what the day still owes, and what that is on a plate as two-part combinations: "5 corn tortillas + 2½ cups
  rice / 4 cups pasta" and "175 g tofu + 1 cup black beans / 125 g tempeh + 2 oz cheese / 3 eggs + 1 cup Greek
  yogurt". Snacks and pre-ride breakfasts list their building blocks (yogurt, banana, granola, honey, dates, oats).
  Pick or write recipes to the numbers.
- **The bottles**: Infinit Go Far, one serving a bottle at normal strength (a bottle an hour, so it's also the
  water), sipped about ⅓ of a bottle every 20 minutes, which is ride mode's reminder. Above 66 g/h a gel or chews
  make up the rest (races: 80 g/h). Past two bottles, extra powder rides in a bag for a refill; with nowhere to refill,
  the two bottles go double strength and the 2 L back bladder carries water only.

| Per serving (from the ingredients) | kcal | protein | carbs | fiber | fat |
|---|---|---|---|---|---|
| Nutty Pudding | ~620 | 44 g (11 g collagen) | 41 g | 21 g | 36 g |
| Super Veggie, black lentils | ~550 | 28 g | 69 g | 25 g | 21 g |
| Super Veggie, 100 g chicken | ~520 | 45 g | 34 g | 13 g | 25 g |
| Infinit Go Far (1 packet) | 280 | 4 g | 66 g | | 379 mg sodium |

- **Targets** scale with the day's intensity and length (not the training-load number: two easy commuting hours
  score high but eat like a training day): carbohydrate 3 g/kg on rest days, 3.5 easy, 5 moderate (or an easy day
  over two hours), 6 hard, 7 long, 8 on race day and the day before (on-bike fuel included); protein 1.8 g/kg.
  Carbs are capped by what the day burns: resting burn (Mifflin-St Jeor from Garmin's weight, height and age) × 1.35
  for daily life, plus the ride (METs by its intensity), so the plan never asks you to out-eat your riding. The panel
  shows the day's total calories next to that estimate.
- **Blueprint is high-fiber and fairly low-carb** (Pudding + Super Veggie ≈ 110 g carbs, ~45 g fiber): ideal on rest
  days, short on hard ones, so hard days *add* to it (a banana with the Pudding, black rice or a sweet potato with
  the Super Veggie, a pre-ride snack, a shake after).
- **The day before a race and race morning swap it out**: ~25 g of fiber from lentils and crucifers the day before,
  or the Pudding's fat and fiber three hours before the start, is asking for GI trouble.
- **Tomorrow's ride shapes tonight's dinner**: before a long ride, pizza night is the plan, not a lapse.

`[nutrition.ride_fuel]` holds the drink mix's label numbers (change them for another product); `bottle_cages` and
`bladder_l` describe what the bike and you can carry.

## The app on your phone

**<https://chrisrohn.com/fitness/>** is an installable app (a PWA): home-screen icon, full screen, no browser bars,
and it opens offline. The hosted copy holds no one's data; yours arrives from the [cloud sync](#cloud-sync-no-computer)
(or by hand from a computer, below) and stays on the phone.

1. **Install.** iPhone: open it in Safari → **Share** → **Add to Home Screen**. Android: Chrome → **Install**
   (the button in the top bar, or the ⋮ menu). Desktop Chrome / Edge: the install icon in the address bar.
2. **Get your data in** with the [cloud sync](#cloud-sync-no-computer), or by hand: on a computer,
   `python -m fitness run`, then **Today → Phone app**:
   - **Copy phone link** and send it to yourself (AirDrop, Messages, email). On the phone, open the app → **Import
     data** → paste it. The data rides after the `#` in the link, which browsers never send to a server.
   - Or **Save data file**, put it in iCloud Drive / Google Drive, and pick it under **Import data**. Set
     `[app] export_dir` (e.g. `"~/Library/Mobile Documents/com~apple~CloudDocs/Training"`) and every build drops a
     fresh `fitness-data.json` there for you.
3. **Refresh** with **Sync now** (or **Update data** without the cloud sync) in the bar under the masthead; it turns
   red after 36 hours. **Settings → Remove from this device** wipes it from the phone.

On iPhone an installed app keeps its own storage, separate from Safari, so import *inside* the app after installing.
Ride mode (also a long-press shortcut on the icon on Android) reads the same copy, so its zones and the week's sessions are
already there. Theme and units follow you between the two. A new build of the site replaces the cached app the
next time it opens with signal.

## Setup on a computer (optional)

```bash
python3 -m venv .venv && source .venv/bin/activate      # Python 3.12+
pip install -r fitness/requirements.txt
```

1. **Garmin.** Pair the Venu Sq to *your own* Garmin Connect account. If it's still on your wife's account,
   factory-reset it first, otherwise the data lands in her account. Then:
   `python -m fitness login garmin` (email, password, MFA code if you use one). Tokens are saved in
   `~/.garminconnect` with 0600 permissions. Garmin has no public consumer API; this uses
   [python-garminconnect](https://github.com/cyberjunky/python-garminconnect), which signs in the same way the
   mobile app does.
2. **Strava history.** On strava.com go to *Settings → My Account → Download or Delete Your Account → Request your archive*.
   When the zip arrives: `python -m fitness import-strava ~/Downloads/export_12345.zip`.
3. **Strava ongoing.** Create an app at <https://www.strava.com/settings/api> with
   *Authorization Callback Domain* `chrisrohn.com` (Strava always allows `localhost` too), then
   `STRAVA_CLIENT_ID=… STRAVA_CLIENT_SECRET=… python -m fitness login strava`. Keep `STRAVA_CLIENT_SECRET` in the
   environment for later syncs too (e.g. `export` it in your shell profile): it's never written to disk.
   This is how your Zwift and MyWoosh rides arrive, with their power. If you also record a trainer ride on the
   watch, the two copies are merged into one: the watch's heart rate plus the trainer's power.
4. `python -m fitness sync` (the first run backfills `sync.history_days` of Garmin data, about 2 requests a day),
   then `python -m fitness build --open`.
5. Set `max_hr`, `lthr` and, if you have a power meter, `ftp` in [`config.toml`](config.toml). Any value you leave
   at 0 is estimated from your data, and the page lists which ones were estimated.

## Daily use

```bash
python -m fitness run          # sync + build + print today's call
python -m fitness today        # just the call, from what's already synced
```

To run it automatically, add this to `crontab -e`. It runs at 7:15 every morning, after the watch has synced
last night's sleep:

```
15 7 * * * cd ~/chrisrohn && STRAVA_CLIENT_SECRET=… .venv/bin/python -m fitness run >> fitness/data/cron.log 2>&1
```

**On your phone:** run `python -m fitness serve` and open `http://<computer-ip>:8765/` on the same Wi-Fi. Away
from home, use [Tailscale](https://tailscale.com). Or deploy `fitness/dist/` to Cloudflare Pages behind
Cloudflare Access with an email allow-list. The page is a single self-contained HTML file, so you can also
AirDrop it or email it to yourself. Health data never goes to a public URL: `fitness/data/` and `fitness/dist/`
are git-ignored.

## How the numbers work

- **Training load (TSS).** Power TSS when you set an FTP and the ride has power. Otherwise heart-rate TSS: Banister
  TRIMP, scaled so that one hour at threshold HR = 100. Rides with no HR are estimated from duration.
- **Fitness / fatigue / form.** The performance-manager model: CTL is a 42-day exponentially weighted average of
  load, ATL a 7-day one, and TSB (form) = yesterday's CTL − ATL. It also reports the acute:chronic workload
  ratio, and Foster's monotony and strain.
- **Sleep score (0–100).** Duration against `sleep_need_hours` (40%). Deep sleep share against 16–33% and REM share
  against 21–31%, which are Garmin's own target ranges (15% each). Continuity, from awake minutes and wake-ups (15%).
  Overnight calm, from average sleep stress (15%). Bands: Excellent ≥ 90, Good ≥ 80, Fair ≥ 60, Poor below that.
- **Readiness.** Last night's resting HR, overnight stress, Body Battery at wake and breathing rate, each scored as
  a z-score against *your* previous 60 days (75 = exactly normal). These are blended with the sleep score. Points
  come off when form is below −10 or the load ratio is above 1.3. When resting HR is ≥ 2 SD high together with
  elevated respiration or stress, the day becomes an **illness watch** with a rest call.
  Thresholds: ≥ 75 key session · 60–74 train as planned · 45–59 easy · < 45 rest.
- **Season plan.** Each stretch to a race goes through the phases recovery → transition → indoor base → outdoor
  build → taper, and each week's load steers toward that race option's `target_ctl`. For every race the planner
  simulates each taper length in the option's `taper_days` range, with volume cut to 35–65%. A fast-decay taper
  keeps intensity and frequency while volume drops
  ([Bosquet et al. 2007](https://pubmed.ncbi.nlm.nih.gov/17762369/);
  [Mujika & Padilla 2003](https://pubmed.ncbi.nlm.nih.gov/12840640/)). The plan kept is the one that reaches race
  morning inside the race's `target_tsb` with the most fitness. Readiness can only ever make a planned day
  *easier*. If a race card shows fitness short of target, the ramp limits won't allow more in the time left. Lower
  `target_ctl`, raise `base_ramp` / `max_ramp`, or pick the shorter option.
- **Insights.** Spearman correlations over your own history, such as training load vs. that night's sleep, late
  workouts vs. sleep, and steps or stress vs. sleep. An insight only appears with 30 or more paired days and
  |ρ| ≥ 0.2, and it's reported as the difference between the top quartile and the rest.
- **Past editions.** A ride whose name contains one of the race's `match` words, within a week of that year's race
  date, counts as an edition. Each one shows the fitness and form you had that morning, so you can compare this
  year's projection with last year's start line.

## Checking RestOrTrain against this

Run `python -m fitness today` next to RestOrTrain for two or three weeks. When they disagree, the reasons list on
the page shows which markers drove this site's call. Tell RestOrTrain to trust the one that agrees with how your
legs actually felt on the bike.

## Layout

| File | Role |
|---|---|
| `cli.py` | `python -m fitness …` commands |
| `fuel.py` | the day's eating around the Blueprint meals and the riding |
| `cloud.py`, `cloud/training.yml` | the GitHub Actions sync (`python -m fitness cloud`) and the private repository's workflow that calls it |
| `garmin.py`, `strava.py` | sync, sign-in and parsers (raw responses are kept in SQLite, so fixing a parser never needs a re-download) |
| `activities.py` | sport mapping and the Garmin↔Strava duplicate merge |
| `metrics.py` | load, PMC, sleep score, readiness, recommendation, insights (pure functions) |
| `plan.py` | season planner (phases, trainer season, taper optimizer) and session libraries |
| `build.py` | assembles the numbers and inlines them into `dist/index.html` and `dist/ride.html` |
| `build-app.mjs` | writes the public, data-free app to `chrisrohn.com/fitness/` during the site build: the dashboard shell, ride mode, manifest, icons and the offline service worker |
| `workouts.py` | structured steps (HR targets from threshold HR) for ride mode |
| `site/` | the dashboard (`shell.js`: data, install, offline; `app.js`: the page) and ride mode, styles, SVG charts, `manifest.webmanifest`, `sw.js` and `icons/` (no dependencies, works offline) |
| `demo.py` | the synthetic athlete |

Tests: `python -m pytest fitness/tests` (models, planner, parsers, build) and `npx playwright test fitness/tests` (the hosted app and ride page: manifest, offline, data import, the GitHub sync against a stand-in API, CSP, accessibility, link hand-off). CI runs both. This is a personal analysis tool, not medical advice.
