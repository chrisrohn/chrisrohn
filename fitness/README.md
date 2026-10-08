# Training & Recovery — a personal fitness insights site

Your Garmin Venu Sq wellness data and your full Strava history, turned into one private page: a daily
**train / easy / rest call**, your own **sleep score**, a **readiness** score against your own normal, the
**fitness / fatigue / form** model, a phone **ride mode** with live HR and interval cues, and a day-by-day **season plan** that re-optimizes every time it's built.
The plan runs through the Iceman Cometh (Nov 7, 2026) and a Zwift / MyWoosh trainer winter (Dec 1 – Feb 28) to
Barry-Roubaix (Apr 17, 2027), with the 100k and 50k compared side by side.

```bash
python -m fitness demo --open        # see it with a synthetic athlete first; no accounts needed
```

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

**It must load over HTTPS** (browsers only allow Bluetooth and GPS on secure pages). Two ways:

1. **Host the data-free page.** Run `python -m fitness ride-page` to get `dist/public/ride.html`, which contains
   none of your data. Put it on any HTTPS host: Cloudflare Pages (`npx wrangler pages deploy fitness/dist/public`),
   GitHub Pages or Netlify. Set `[ride] url` to its address and rebuild. The dashboard's Ride mode button then
   opens it with your zones and the week's sessions packed into the link's `#fragment`. The fragment is never
   sent to the server, and the page keeps a copy, so it still works with no signal at the trailhead.
2. **Serve it from home.** Use `tailscale serve --bg 8765` alongside `python -m fitness serve` and open
   `https://<your-computer>.<tailnet>.ts.net/ride.html` on the phone. Load it before you roll out.

A big GPS screen for hours drains the battery: for Barry-Roubaix, dim the screen or bring a small battery pack.

## Setup (once, about 10 minutes)

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
   *Authorization Callback Domain* `localhost`, then
   `STRAVA_CLIENT_ID=… STRAVA_CLIENT_SECRET=… python -m fitness login strava`.
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
15 7 * * * cd ~/chrisrohn && .venv/bin/python -m fitness run >> fitness/data/cron.log 2>&1
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
| `garmin.py`, `strava.py` | sync, sign-in and parsers (raw responses are kept in SQLite, so fixing a parser never needs a re-download) |
| `activities.py` | sport mapping and the Garmin↔Strava duplicate merge |
| `metrics.py` | load, PMC, sleep score, readiness, recommendation, insights (pure functions) |
| `plan.py` | season planner (phases, trainer season, taper optimizer) and session libraries |
| `build.py` | assembles the numbers and inlines them into `dist/index.html` |
| `workouts.py` | structured steps (HR targets from threshold HR) for ride mode |
| `site/` | the dashboard and ride-mode pages, styles and SVG charts (no dependencies, works offline) |
| `demo.py` | the synthetic athlete |

Tests: `python -m pytest tests/test_fitness.py`. This is a personal analysis tool, not medical advice.
