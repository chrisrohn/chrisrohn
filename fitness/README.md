# Training & Recovery — a personal fitness insights site

Your Garmin Venu Sq wellness data and your full Strava history, turned into one private page: a daily
**train / easy / rest call**, your own **sleep score**, a **readiness** score against your own normal, the
**fitness / fatigue / form** model, and a day-by-day **Iceman Cometh taper plan** (Nov 7, 2026) that re-optimizes
every time it's built.

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
3. **Strava ongoing (optional).** Create an app at <https://www.strava.com/settings/api> with
   *Authorization Callback Domain* `localhost`, then
   `STRAVA_CLIENT_ID=… STRAVA_CLIENT_SECRET=… python -m fitness login strava`.
   You only need this for rides recorded on something other than the Garmin, such as a bike computer or phone.
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
- **Race plan.** It simulates every taper from 6 to 14 days long, with volume cut to 35–65%. The build adds CTL
  at up to `plan.max_ramp` per week. A fast-decay taper keeps intensity and frequency while volume drops
  ([Bosquet et al. 2007](https://pubmed.ncbi.nlm.nih.gov/17762369/);
  [Mujika & Padilla 2003](https://pubmed.ncbi.nlm.nih.gov/12840640/)). The plan kept is the one that reaches race
  morning inside `race.target_tsb` with the most fitness. Readiness can only ever make a planned day *easier*.
- **Insights.** Spearman correlations over your own history, such as training load vs. that night's sleep, late
  workouts vs. sleep, and steps or stress vs. sleep. An insight only appears with 30 or more paired days and
  |ρ| ≥ 0.2, and it's reported as the difference between the top quartile and the rest.
- **Past editions.** Any ride whose name contains a `race.match` word (default "iceman") shows up next to the
  fitness and form you had that morning, so you can compare this year's projection with last year's start line.

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
| `plan.py` | race taper optimizer and session library |
| `build.py` | assembles the numbers and inlines them into `dist/index.html` |
| `site/` | the page template, styles and SVG charts (no dependencies, works offline) |
| `demo.py` | the synthetic athlete |

Tests: `python -m pytest tests/test_fitness.py`. This is a personal analysis tool, not medical advice.
