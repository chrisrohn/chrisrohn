# Training & Recovery — a personal fitness insights site

Your Garmin Venu Sq wellness data and your full Strava history, turned into one private page: a daily
**train / easy / rest call**, your own **sleep score**, a **readiness** score against your own normal, the
**fitness / fatigue / form** model, a phone **ride mode** that works like a cycling computer (GPX routes, turn by turn,
maps, climbs ahead, recorded rides, workouts you can reshape mid-ride), and a day-by-day **season plan** that re-optimizes every time it's built.
The plan runs through the Iceman Cometh (Nov 7, 2026 · wave 14, 9:24 AM) and a Zwift / MyWoosh trainer winter (Dec 1 – Feb 28) to
Barry-Roubaix (Apr 17, 2027), with the 100k and 50k compared side by side.

```bash
python -m fitness demo --open        # see it with a synthetic athlete first; no accounts needed
```

It installs as an app on your phone from **<https://chris.bike/>**, with your data kept only on the phone
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

## Your morning

1. **Wake up.** The watch hands last night's sleep, HRV-proxy stress, resting HR and Body Battery to Garmin Connect
   when the phone app syncs it (opening Garmin Connect makes sure).
2. **Open the app.** If the last sync is more than 45 minutes old it starts one by itself and reloads about a minute
   later with this morning's numbers. If last night still isn't in Garmin, the Today card says so, with a *Sync now*.
3. **Or don't open anything.** With the morning notification on (Settings → *Morning notification*), the call
   arrives on its own once last night's sleep is in.
4. **Read the call.** The app opens on **Today**, one of five tabs along the bottom of the phone (along the top on a
   wide screen), so nothing needs scrolling to find:

   | Tab | What's on it |
   | --- | --- |
   | **Today** | The call and why, Plan B, the weather, tonight's bedtime, tomorrow in a line, and readiness, sleep, form and fitness at a glance |
   | **Plan** | The next 7 days, what the plan changed, race day, the season to the start line |
   | **Fuel** | Today's and tomorrow's meals, bottles for the weather, the week's shopping and Sunday prep, weight |
   | **Body** | All the numbers: readiness and its parts, load, sleep, recovery markers, what your data says, the device |
   | **Ride** | Ride mode, the inside of your rides, and the bike: chain, tires, pressures |

   A small red dot on a tab means news there (the plan changed, a bike job is due, an illness watch). Old section
   links still work: `#bike` opens the Ride tab at the bike, `#season` the Plan tab at the season.

   The Today tab has:
   - **The call:** the plan's session (or the commute), eased by readiness when the morning says so, never made harder.
   - **How do you feel?** Four taps and a neck check (see [The morning check-in](#the-morning-check-in)).
   - **Plus strength:** on the days the plan books it, the session to do after the ride (see
     [Strength all season](#strength-all-season)).
   - **Plan B:** what to do instead if it rains or the day runs short, so there's always a sensible option.
   - **Tomorrow** in a line; **The week →** opens the next 7 days on Plan: tap any day for its session and its
     Plan B. Every sync rebuilds them from what you rode, slept and recovered: a missed day moves, a good week grows.
   - **Weather:** on a commute day, each leg's weather, what to wear, lights, and the wind home. On other days, the
     best window to ride today.
   - **Fuel:** today's carbs and protein in a line; **Meals →** opens the Fuel tab.

Work days are Monday to Friday except US federal holidays (`commute.holidays = "us-federal"`, `""` for none): no
commute is ever booked or suggested on a weekend or a holiday.

### Weather

The sync fetches [Open-Meteo](https://open-meteo.com)'s forecast (free, no key) for where your commute starts, learned
from your Garmin rides' start points. Only a point rounded to about 1 km leaves the sync, and coordinates never reach
the phone. The forecast is cached for 50 minutes. `[weather] enabled = false` turns it off.

- **The commute call** checks both legs at your usual departure times:
  - thunderstorms, gusts of 60 km/h or more, or ice: leave the bike, and the session moves to the evening;
  - rain: *your call*, with the Plan B;
  - otherwise, what to wear for how it feels, lights when a leg is near dark, and the headwind home.
- **Other days** get the best window to ride: in daylight, after work on weekdays, the driest, then the warmest.
- **The planner** keeps the next 16 days' commutes off wet days. A long ride forecast into the rain swaps with a free,
  dry neighboring day (Saturday's to Sunday).
- **The 7-day list** shows each day's sky, high and low, and the chance of rain.

### The morning notification

Settings → *Morning notification* → **Turn on**, in the installed app (or in Chrome without installing it).

- **What arrives:** the day's call, between 5 and 11 am, once last night's sleep is in (or from 9 am regardless).
  One update follows if the call changes before 5 pm, for example when the forecast turns or the afternoon check
  eases the ride home.
- **Sunday evening:** the week's recap. It covers hours ridden against plan, commute days, the fitness change, and
  next week's hours and key sessions.
- **Privacy:** the sync encrypts each message to your browser's key (RFC 8291, signed with VAPID, RFC 8292), so the
  push service in between only ever carries ciphertext.
- **Sending a test:** *Send a test* in the same place.

### The afternoon check

On a commute day, once you've ridden in, every sync after noon takes a second look at the ride home. It reads
today's Body Battery and stress (as of the watch's last sync to your phone) and the latest forecast for the ride
home.
- **Workout home, drained day:** Body Battery 25 or below, today's stress averaging 50 or more, or 2+ hours of high
  stress turns it into **Ride home easy**: Z1–Z2, no intervals.
- **Endurance ride home:** the same check, with a lower bar (Body Battery 15, stress 60).
- **Storms on the way home** say to wait it out or get a ride and leave the bike at work.
- **Otherwise** the call says the ride home stands.

### Tonight's bedtime

The Today card says when to turn the lights out tonight. It starts from your usual wake time on mornings like
tomorrow (work day or not, from the last six weeks). If you're commuting tomorrow, it uses an hour before the ride
in when that's earlier. Then it takes off your sleep need and 15 minutes to fall asleep. Lights out comes 30 minutes
earlier with more than 3 hours of sleep debt this week, and 15 earlier before a hard day.

### The morning check-in

The watch can't tell you how your legs feel. A morning check-in asks, under the call: **legs**, **energy**, **life
stress** and **mood** on a 1–5 scale, and **feeling sick?** It takes four seconds and is the most sensitive early
read there is: subjective wellness tracks training load, fatigue and coming illness better than resting HR or heart
rate measures do (Saw, Main & Gastin 2016, a systematic review of 56 studies).

- **Readiness** becomes 70% the watch, 30% you (3 is your normal = 75, each step 15 points); the tile shows both.
- **The call** can only get easier: the blended score's band (the same 75 / 60 / 45 as readiness), any answer at
  its worst (legs very sore, energy drained, life stress very high, mood low) caps the day at easy, and the **neck
  check** decides sickness: a head cold rides easy at most, anything below the neck (chest, fever, aches) rests.
- **Strength** is skipped on a day the call came down from the plan: heavy sets want fresh legs.
- **Body → Recovery markers** draws *How you felt* over the readiness chart, so you can see the two agree or not.
- **Synced:** with GitHub sync set up, a few seconds after your last tap the app starts a quiet `service` run with
  the check-in (and any ride ratings) as its code, so no change to your private repository's workflow is needed.
  The sync keeps them in its encrypted store (`feel.py`), blends them into the morning call the same way, and the
  notification's afternoon-update rule sends the eased call if it changed. Every device sees them; this phone's own
  answers win. A save that can't go (offline) goes the next time the app opens.
- **Without the sync** it stays on the phone (`fitness-checkin`, the last 90 mornings). *Remove from this device*
  clears it, and the ride ratings, with the rest.

### Ride ratings

Under the check-in, the app asks how hard your latest ride was (from the last three days, not commutes), on the
CR-10 scale: 1 very easy, 3 moderate, 5 hard, 7 very hard, 10 maximal, for the whole ride, about 30 minutes after.
That's Foster's **session RPE** (Foster et al. 2001), and it's what heart rate can't say: how the ride *felt*.

- **Ride → Training → How rides felt** lists the rated rides: RPE, session RPE (RPE × minutes) and the heart-rate
  load (TSS). Each ride's session RPE per TSS is set against your own usual ratio: *harder than usual*, *as usual*
  or *easier than usual*.
- **After 8 ratings**, when your last three rides felt 20% or more harder than their load usually does, the Today card
  says so: fatigue that shows up in how rides feel before it shows overnight (Saw et al. 2016). It's a reason
  beside the call, not a change to it. Recent activities show each ride's RPE.

### The week so far

If you've already ridden a lot since Monday, the rest of the week shrinks (down to half) so the week lands on its
target. A light start isn't crammed into the weekend. *Plan adjusted* says when this happens.

## Races and the trainer season

Races live in [`config.toml`](config.toml) as `[[races]]` blocks. Each one has a date, a kind (`mtb` or `gravel`,
which picks the session library), the race-morning form band, and words that find past editions in your history.
`every = "3rd Sat Apr"` rolls a race to next year's date once it's past. Each race has one or more distance
`options`, each with its own expected race time, target fitness (CTL), longest training ride and taper range.

**The course.** When the organizer publishes the route, drop its GPX in [`courses/`](courses/) and name it in the
race's block (`course = "courses/iceman-2026.gpx"`). Like `start` and `wave`, it belongs to that `date`'s edition.
[`course.py`](course.py) reads it once per build: its length and climbing, the hills, where along it the climbing
sits, the wind along its own line, and the start and finish for the venue forecast (unless `start_ll` / `finish_ll`
say otherwise). Two counts of climbing, because they answer different questions: what a GPS or barometric recorder
reports (every rise of a metre or more, so it compares with your past editions), and ride mode's smoothed count with
its ClimbPro climbs. The race card and the phone use the same smoothed count, and a test runs `ride-core.js` on the
file to keep them in step. The 2026 Iceman (Ride with GPS 57666523) is **27.4 mi / 44.1 km with ~1,610 ft**. That's
shorter than the editions before it. The climbing comes as 29 short rises and only 3 real climbs, 43% of it is in
the last third, and the line finishes on a ~200 yd wall at ~10% with pitches to 16%.

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
- **Strength all season.** See [Strength all season](#strength-all-season): the transition teaches the lifts, the
  trainer base lifts heavy, the build keeps it.
- **The history.** Rides recorded as Strava *Virtual Ride*, flagged *trainer*, or with Zwift / MyWoosh in the
  name count as indoor. They get their own color in the weekly-hours chart, and the Training section shows the
  season's rides, hours, average power and how your best-effort FTP moved.
- **Weekend skills.** In base and build, a weekend endurance ride outdoors is a **Skills ride**: Z2 riding with the
  handling and racecraft the next race asks for. Before Iceman that's singletrack flow, sand and two-track, wave
  starts, punchy climbs with remounts, and eating on rough ground. Before Barry-Roubaix it's paceline work, loose
  corners and descents, rolling hills at tempo, eating at speed in the drops, and sand and washboard.
- **Workout files.** Each planned trainer session downloads as a Zwift `.zwo` file from its day in the 7-day list,
  with power as a fraction of FTP for each zone. Put it in Zwift's custom workouts folder; check MyWoosh can import
  it before relying on it there.
- **FTP.** Zwift and MyWoosh send trainer power, so with an FTP set, those rides are scored from power. Leave
  `ftp = 0` and the site estimates FTP from your best 20–90 minute power ride of the last year. After each ramp
  test, put the real number in `config.toml`.

## Strength all season

Heavy, low-rep leg work makes a cyclist more economical and more powerful late in a race without adding bulk
(Rønnestad & Mujika 2014 review; Vikmoen et al. 2016), and one session a week keeps the gains through a race season
(Rønnestad et al. 2010). Riding doesn't load bone, and masters cyclists lose it, so each session carries a few jumps
(Nichols & Rauh 2011). The plan books it like this:

| Phase | Strength | What |
|---|---|---|
| Transition (after Iceman) | The day's session, twice a week | Learn the lifts: 3 × 8–10 with 2 reps in reserve, a little heavier each week |
| Trainer base (Dec–Feb) | **2 a week**, after the ride | **Strength A / B · heavy:** squat or leg press / trap-bar deadlift 4 × 4–6, single-leg work, calf raises, rows, box jumps, core (35 min) |
| Build (Mar–) | **1 a week**, after the ride | **Strength · keep it:** 3 × 4 at the winter weight, step-ups, box jumps, core (25 min) |
| A recovery week | 1 | **Strength · light:** bodyweight, glute bridges, core and mobility (20 min) |
| Taper, race week, the week after a race | None | The last heavy session is 10+ days before the start |

- **Where it goes:** on the hard days, after the ride, so the easy days stay easy (key sessions first, then
  endurance, easy and commute days). Never the day before a long ride, a key session or a race, and never two days
  running.
- **What's logged counts:** a Garmin or Strava strength workout since Monday comes off the week's quota, and the
  Training section shows your strength sessions a week over the last 8 weeks.
- **On the phone:** the Today card says what to lift and how many of the week's are done; the week list marks the
  days with **+ strength**; the morning notification adds it to the body. When readiness or the check-in brings the
  day down from the plan, the card says to skip the lifting.

## Bike commuting

Your 30 km each-way commute is weekday training, so the plan builds it in instead of stacking it on top. Set it up
under `[commute]` in `config.toml`: distance, climbing, the days you can ride (most preferred first), and how many
commute days a week you want at least and at most (default 1–3).

**How the plan uses it.** A round trip costs about 110–130 TSS and 2¼ hours, learned from your past commutes. That's
two or three times a typical session, so commutes are booked against the **whole week's** load, never one day's.
Commutes are the cheapest training you have, since it's riding you'd otherwise spend driving, so the planner books
them like this:

1. **Key days first.** The workout rides home on the commute (*Commute + workout*), so a hard session needs no extra
   time before or after work. When the week can't afford that, the key day can still be an easy commute.
2. **Then your other commute days**, most preferred first, up to `per_week`'s most.
3. **Something gives to make room.** What a commute costs beyond the session it replaces comes out of the endurance
   and recovery days first (down to half), then the long ride (down to two thirds). The long ride is never cut
   shorter than the race itself.
4. **Not in a taper.** There a commute has to fit the day it replaces, since a taper sheds volume.

A missed *Commute + workout* still owes its workout: the plan moves it to a free day, like any missed key session.
The commute replaces that day's session, so it never comes on top of it:

| The day's job in the plan | How the commute is ridden |
|---|---|
| Key session | **Commute + workout:** in easy (Z1–Z2); home with a flat-road workout (2 × 15 sweet spot, 30 min tempo, 3 × 8 threshold, or race-pace blocks for gravel), the rest Z2 |
| Endurance | **Endurance commute:** Z2 both ways, steady, no surges at the lights |
| Easy, taper, recovery week | **Easy commute:** Z1 both ways, soft-pedal, arrive fresh |
| Rest | Leave the bike, unless the week needs one more commute to reach its minimum: then an easy commute, and the rest moves to the week's lightest day |
| Openers, race, last 2 days before a race | Leave the bike |
| Trainer season (Dec–Feb) | Leave the bike, unless `winter = true` |

**The morning call.** On a commute day the dashboard's call *is* the commute, and readiness can only make it
easier:
- ≥ 75: as planned.
- 60–74: as planned, but on a workout day you decide on the ride home (see the check below).
- 45–59: easy both ways, no intervals.
- Below 45, or an illness flag: leave the bike.

On a non-commute weekday it says whether an optional easy commute makes sense. On a rest day that's a work day, a
green morning (readiness 70+) in base or build, with the week under its commute maximum, offers an **optional easy
commute** in place of "not a bike day". Rest is still the default. Each call gives the heart-rate
ranges for each leg in bpm, the expected time, and a fueling plan for the day: breakfast, food at work, and an
afternoon snack before the ride home.

**Your commute as a fitness test.** A ride is counted as a commute if Strava's commute box is ticked, or if it's a
weekday ride of about the commute's length starting at 5–10 am or 2–8 pm. Same route and terrain every time makes
it a free, repeated test. The Training section charts speed per 100 bpm for each direction and tells you when it
moves: rising means aerobic fitness, and a drop that lasts a week means fatigue.

**The in-ride check.** Ride mode has *Commute in* and *Commute home* sessions. It compares your heart rate with what
you usually need for that speed on that leg (a line fitted to your past commutes), **on steady riding only**: rolling
15 km/h+ at an even speed, a minute or more after a stop. City riding (lights, traffic, the sprint away from each stop)
puts heart rate out of step with speed, so it needs 4 steady minutes in the last 8, and 4+ stops in 10 minutes means
stop-and-go: no verdict at all. 8+ bpm high, held for 2 minutes, means fatigue, illness or heat: the app takes the
intervals off and says so (Undo is there for 30 s). 5+ bpm low tells you it's a good day for the work. After every
stop, 45 s of *Rolling again* lets heart rate catch up before any ▲ Push / ▼ Ease off.

## Ride mode: a cycling computer on the phone on your bars

Set like the rest of the app, a 1970s transit sign (Helvetica, heavy rules, square everything, red only where it
matters), **dark by default** (true black on the phone's OLED; light or auto, following the phone, in Settings, shared
with the dashboard), with the five heart-rate zones as flat signal colors, like a subway map's lines, and stops and
places as sign pictograms in the 1974 AIGA/DOT manner (water, food, bike shop, restroom, aid, summit…). Every Workout
field fits a Pixel 7 without scrolling, turn banner and all.

The type is Helvetica on every phone: iPhones use their own Helvetica Neue, and Android (where "Helvetica" is only a
name for Roboto) and Windows get URW's Nimbus Sans L, the Helvetica clone, served with the app (19 KB a weight; GPL,
source and license in [`fonts/`](fonts)).

- **On the bars: hold, don't tap.** Tap **End** and it asks first; hold it for a second and the ride ends without
  asking. The **lock** beside End (or *Lock the screen at Start* in Settings) makes the screen ignore rain and bumps:
  the readings stay in view, and only a one-second hold on the bar along the bottom unlocks it.

Five screens, swiped or tapped along the top: **Workout · Map · Ahead · Data · Laps**.

- **Routes.** Load a **GPX or TCX** (Ride with GPS, Komoot, Strava, Garmin Connect, a race site) under **Map → Routes**,
  or on Android **share** the file to Training from any app (Files, Gmail, Komoot…); desktop Chrome opens .gpx files
  with it. Routes stay on the phone, with **Reverse**, **GPX** out and **Delete**. A file with no heights gets them
  from Open-Meteo's elevation API. **The next race's course arrives by itself**: within six weeks of a race with a
  `course`, the sync sends ride mode the line (thinned to within 1.5 m across and 0.5 m in height, so it keeps its length
  within 0.3% and its climbs), and ride mode keeps it as a route under its own id, saves its map for offline and
  picks it on race morning (once: choose another route and it stays chosen). It comes with the dashboard's data, not
  in the QR code, and every point is checked before it's kept.
- **Turn by turn.** The file's own cues when it has them (Ride with GPS cue sheets, Garmin and TCX course points),
  otherwise turns read off the line itself. A banner and voice: *"In 500 feet, turn left onto Fox Rd"*, then *"Turn
  left now"* with a beep and a buzz, timed to your speed. Street names come from the map's own data.
- **Off course and wrong way.** 40 m+ off the line for 6 s says *Off course*, with an arrow and the distance back.
  With signal it asks **BRouter** (free, no key) for a way back and guides you turn by turn until you're on the route
  (automatic, or the **Reroute** button; Settings picks mixed / gravel, road, quiet roads, MTB or shortest). The way
  back **looks forward**: it knows your direction of travel and where the route goes, so it rejoins ahead of both
  where you left it and where you are now (a parallel road leads you on, not back). Up to three places ahead are
  routed at once, the spot where you left the route is a no-go (a locked gate stays locked), and the shortest way
  that doesn't start with a U-turn wins. Far from the start? **Directions** to it.
  **No signal, still a way back:** when BRouter can't be reached, ride mode routes on the phone from the map tiles
  it already holds (the corridor saved with the route, and every tile the map has shown): it reads their roads and
  paths (one-ways kept, motorways left out, cycleways preferred, steps avoided), joins them across tile edges, and
  finds the same forward rejoin, no-go and all, with turns named from the tiles' street names.
- **The map.** OpenFreeMap's vector map (MapLibre), heading-up or north-up, zooming with your speed and in for a
  turn: the route ahead in red, done in grey, climbs by steepness, your track in blue. **It saves itself for
  offline**: loading a route online stores every map tile along it (±800 m, zoom 8–14) in the phone's cache. No
  WebGL or no tiles: a drawn breadcrumb of the route and your track stands in.
- **What's ahead.** Done / to go / still to climb, arrival time (and *after sunset: lights* when it is), the elevation
  profile of the whole route and the next 5 miles colored by grade, **ClimbPro-style** climbs (*next climb in 1.2 mi:
  0.9 mi at 5.1%, 240 ft up*, then on it: distance and height to the top, grade now), the next turns, water / food /
  aid stops from the file's waypoints, and the **wind on the next 10 miles** (headwind / tailwind / cross shares).
  Within 2 km of a climb, and all the way up it, a **climb strip** on the Workout screen says how far, how long and
  how steep, then the distance and height to the top (the weather steps aside for it).
- **Climbs ahead with no route** (like Wahoo's Summit Freeride). Just ride: the app follows the road you're on through
  the map tiles (the same ones the offline rerouting reads), straight on at each junction and staying with the road's
  name, looks up its heights every 100 m (Open-Meteo, so this part needs signal), and finds the climbs on the next
  6 km. They're on Ahead (the profile, the climb, the climbs further on), on the map in their grade colors, in the
  Workout strip, and said 300 m before the foot. It looks again every few kilometres, or as soon as you turn off the
  road. Settings: every climb, Cat 4 and up, Cat 3 and up, or off.
- **The wind's cost** (like Wahoo's AirDrag / AirBoost, estimated). The ACE measures the air with a sensor; the phone
  takes the forecast wind at rider height, turns it onto your direction of travel, and gives the extra (or missing)
  drag and the watts it costs at your speed, under *On your line* and as a **Wind** field. Over the ride it adds up
  what the wind did to the clock (your speed against the still-air speed for the same effort), and the summary says
  it: *the wind cost you about 6 min; headwind 55% of the time*.
- **Data.** Ride and moving time, distance, speed, average and max, climbed, grade, HR and max, power (10 s) and
  cadence, time of day, sunset, elevation, the climb, the wind, lap time, the fuel tank, W′, and the phone's battery
  with **how long it lasts** at this ride's drain (and whether that's enough for the ride left). **Your fields:**
  **Fields** picks the Workout screen's six and the Data screen's list and order; **2 · 3 · 4 a row** on the Data
  screen is the zoom (fewer, bigger numbers on rough ground). Kept on the phone.
- **Back to the start**, under **Go**: **Retrace my track** turns your own track around and guides you back the way
  you came, turn by turn, climbs and all (no signal needed); **Quickest way back** routes to where you started.
- **Battery saver.** When the forecast says the phone won't last the ride left (route at your average speed, or the
  session's steps), saver turns on by itself, says so, and offers **Undo**: true black, the map moved every 5 s
  without animation, the screens redrawn every 3 s. The timer, recording, cues and trainer keep their pace.
  Settings: on by itself / always / off. A spoken warning at 15% either way.
- **Smart trainer (Tacx Flow Smart, and any FTMS trainer).** **Trainer** in the top bar pairs it (a Flow Smart, T2240,
  shows as *Tacx Flow 12345*; it speaks Tacx's FE-C over Bluetooth, which ride mode drives directly):
  - **ERG on the workout:** each step's watts from your FTP, set the moment the step starts, and moved when the app
    eases the session. **No FTP? Heart-rate ERG:** the watts are nudged every 20 s to hold the step's heart-rate
    band (in small steps, because HR lags), and what held each band is remembered, so the next ride starts there.
  - **A route on the trainer:** a free ride with a route loaded sets the route's grade under you, moves your place
    along it with the trainer's wheel speed (turns, climbs and *Ahead* all follow), and records the climbing.
  - Speed, power and cadence come from the trainer and are recorded (an indoor ride: no GPS track). A wheel-on trainer
    can't brake hard at a low wheel speed, so when the Flow flags it the screen and voice say **shift to a harder
    gear** (or easier, at the other end). At End it goes back to a flat road.
  - **The Flow, wheel-on:** pump the tyre to the same pressure every time, press the roller with the same number of
    turns, and run the spin-down calibration in Tacx's app now and then (ride mode says when the trainer asks for
    one); that's what keeps its power honest. The older, non-smart Flow (T2200) has no Bluetooth and only works with
    Tacx's own head unit. Settings: auto (ERG on a workout, else the route's grade) / ERG only / grade only / read only;
    your weight sets how climbs feel.
- **To the training sync, by itself.** With the sync connected (the dashboard's Cloud sync), **End** sends the ride to
  it: the summary and heart rate, power, cadence and speed every 5 s, deflated, as one run of the sync. It counts in
  the plan from that run; when the watch recorded the same ride the two become one (the watch's record wins and
  takes the phone's power: a trainer ride with the watch on gets its watts); and a ride only the phone recorded goes up
  to **Garmin Connect** (and from there Strava) 6 hours after it ends, if no other copy has turned up by then. No
  signal at End: it goes when there is. The sync lists the rides it has, so one lost in GitHub's queue is sent again.
- **What this ride did.** At End, before the numbers: the work on target (minutes and %, and what that says), the zone
  split, the load against plan and what it does to fitness and tomorrow's form, the next event's fitness target and
  how far there is to go, and the commute check. Kept with the ride under Saved rides.
- **Race plan (like Garmin's Power Guide).** On *Ahead*, **Race plan** takes a finish time (or **Fastest I can hold**:
  the time where the plan's intensity meets what you can hold that long, about 90% of FTP for two hours and 79% for
  four) and the surface (road, gravel, mountain bike). The route splits into climbs, flats and descents, and each gets
  watts, the heart-rate band they mean for you, and a speed: harder up the climbs, easier down, so the effort evens out.
  It warns when a time asks more than you can hold. On the ride the Workout screen becomes the plan (on a free ride, or
  once the session's steps are done): this section's targets, **how far ahead or behind the plan** you are (the big
  number), what's next, a word at each new section, and a warning when the first half is ridden over the plan. FTP is
  yours, else the sync's eFTP, else an estimate from your weight; your weight plus 10 kg of bike and kit is the mass.
- **Fuel tank and W′ (real-time stamina).** From the first pedal stroke: the carbohydrate you're burning (from power,
  or heart rate, at the share of carbs that intensity burns: about a third easy, nearly all at threshold) against a
  fed rider's ~6.5 g/kg, filled by every **Done** on the eat-and-drink prompt. *Data* shows the tank's %, grams used and
  eaten, and when it runs low at this pace; it says *eat something* at 40% and *eat now* at 25%, and the after-ride note
  says how the fueling went. With power and the critical power and W′ the sync learned from your power curve, **W′
  left** tracks the reserve above CP (Skiba's model) and says when it's nearly gone.
- **Race your past self.** Load a route you've ridden with ride mode and *Ahead* shows **your best** (or last) ride
  there; on the ride, how far ahead or behind it you are, said every quarter of the route. Each climb's time is said at
  the top against your best on it (*a new record*, with a fanfare). **Save as route** in a ride's summary turns any ride,
  like the commute, into a route to ride again against itself.
- **Go somewhere.** *Map → Go*: **Home** (set once with *Set home here*), **a loop of N mi** from where you are, into the
  wind first so it brings you home (*Another way round* for a different one), and **Nearby** water, food and coffee,
  bike shops and restrooms from OpenStreetMap, with **Go** on each. **Long-press the map** to ride to that point. Each
  becomes a route with turn by turn (BRouter, or the saved map with no signal). A route loaded online also gets the
  water, food, restrooms and bike shops within 150 m of it from OpenStreetMap, saved with it for gravel with no signal
  and listed with its own stops on *Ahead* and the map.
- **Weather on the ride.** Every 15 minutes, Open-Meteo's 15-minute forecast where you are: *Rain in about 35
  minutes* (and whether it's heavy), *rain easing*, the wind picking up or turning (*from the northwest at 28 km/h*),
  and thunderstorms in the next three hours, each said once and shown on the weather bar.
- **Laps and recording.** **Lap** button, a lap per workout step and auto laps every N mi / km (Settings), with
  **auto-pause** at stops. Every second is recorded on the phone (it survives a reload), and **End** keeps the ride
  under **Laps → Saved rides**, exporting **FIT** (Garmin Connect *Import data*, Strava *Upload*, TrainingPeaks),
  **GPX** or **TCX**, or **Share…** straight to another app. The watch's file stays the official record.
- **The app does the thinking.** Before the ride, **Today** says why this ride: the day's call, readiness and the
  overnight markers that moved it, fitness and form against the next event's fitness target, the commute's speed per
  heartbeat against your earlier commutes, where your zones came from, and the days to the event. The session itself is already the one the
  morning allows (see [When the plan doesn't happen](#when-the-plan-doesnt-happen)). On the bike it adjusts itself,
  says what it changed, and offers **Undo** for 30 s:
  - two reps in a row where HR never reaches the target: fatigue, so the rest of the set is cut;
  - two reps well over it: the rest of the set is 5% easier;
  - the commute check running hot on steady riding: the intervals are off, the rest is easy;
  - the session done short of its planned load: easy endurance added to finish the day's work.
- **Change** (beside the step) is for when life changes the ride: ±1 / +5 min, previous step, one more rep, cut the
  set, **fit the rest into the minutes you have** (long easy riding and the cool-down shrink first, then reps come off
  the end), or a **quick workout** (endurance, tempo, sweet spot, threshold, VO2, 30/30s, hill repeats, sprints,
  recovery) fitted to your minutes.
  - **Efforts on the climbs.** On a route, the easy step before an interval waits (up to 10 min) for the foot of the
    next climb, and says so.
  - **Power.** With an FTP (Settings, or the dashboard's), each step gets a watt range beside the HR one, and with a
    power meter the status follows 10-second power, so even short efforts get a number.

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
The Workout screen shows:

- **Live readings:** heart rate, with your zone and a marker on the zone bar; time, distance, speed (from the
  wheel sensor, else GPS), cadence or power, average HR, and live load against the planned TSS.
- **Weather where you are:** temperature and how it feels, the rain chance, and wind speed and direction (with gusts).
  - **When it updates:** fetched from Open-Meteo each time you tap **Start** or **Resume**, and every 30 minutes on
    the ride. Only a position rounded to about 1 km leaves the phone.
  - **The wind arrow** points where the wind is blowing: north-up while you're stopped, turned to your direction of
    travel once you're moving. *On your line* then reads it live: headwind, tailwind, or crosswind from the left or
    right.
  - **No signal:** it falls back to the hourly forecast from the last sync, which is also what it shows before
    you start.
- **The day's session as timed steps.** For example: warm-up → VO2 1/5 at **166–176 bpm** → easy 3 min → …
  - Each step shows a countdown, its target range from your threshold HR, and a status (▲ Push / On target /
    ▼ Ease off). Efforts of 2 minutes or less say *by feel*, because HR lags them.
  - Each step change gets beeps, a vibration (Android) and a spoken cue, with a 3-2-1 countdown before it.
- **Practical touches:**
  - **Fueling prompts** every 20 minutes after the first 20, with more carbs suggested on long days.
  - **Screen kept awake.** Ride mode asks the phone to keep the screen on.
  - **Survives a reload.** A reload or tab switch mid-ride restores the ride, paused.
  - **Summary:** a ride summary with time in zones at the end.

The watch keeps recording the official file; ride mode's own copy goes only to your training sync (above), and to
Garmin Connect only for a ride the watch didn't record (`[sync] upload_phone_rides = false` to never).

**Browser.** Android: Chrome. iPhone: Safari and iOS Chrome can't use Bluetooth sensors, so install the free
**Bluefy** browser and open ride mode in it. GPS, steps and cues work in any browser. On iPhone, also set Auto-Lock
to *Never* for rides, in case the browser ignores the keep-awake request.

**Sensor not in the picker?** (e.g. a Garmin HRM-Pro Plus that shows in the phone's Bluetooth list)
- **Forget it in the phone's Bluetooth settings.** A strap the phone itself is connected to stops advertising, so the
  browser can't find it. Sensors pair inside ride mode, never in the phone's settings.
- **Free a Bluetooth slot.** Close Garmin Connect, Zwift or other apps using it; the watch can stay on it over ANT+.
- **Wake it.** Wear the strap with the pads wet (it sleeps until it feels a heartbeat); spin a cadence or speed sensor.
- **Android:** allow Chrome *Nearby devices* and keep Location on.
- Still missing? Tap **Show all nearby devices** under the hint, which lists everything in range.

Once connected, a sensor is remembered and reconnects by itself when it's back in range (Chrome).

**Where it lives: <https://chris.bike/ride.html>**, inside the installed app (see
[The app on your phone](#the-app-on-your-phone)). It's a data-free page: no zones, plan or history are in it, and it's
`noindex`. Its Content-Security-Policy ([`site/csp.txt`](site/csp.txt)) lets only its own scripts and files run, and
lets it talk only to GitHub's API, Open-Meteo, OpenFreeMap's tiles, BRouter and OpenStreetMap's Overpass API. HTTPS is what phones require for
Bluetooth and GPS.

**Getting the week onto the phone:** open the dashboard, then **Body → Phone app**, and scan the QR
code. You can also tap **copy the link** and send it to yourself. The link carries your HR anchors and the next 7
days of sessions, compressed into its `#fragment`, which browsers never send to a server. The phone keeps that
plan, so the page works with no signal at the trailhead. Rescan when the plan changes. A link that won't decode
is ignored, and the plan already on the phone stays.

You can also host it elsewhere: `python -m fitness ride-page` writes a data-free copy to `dist/public/ride.html`.
Put the folder's address in `[app] url`. To use the local copy with no hosting, set `url = ""` and serve it over
Tailscale (`tailscale serve --bg 8765` alongside `python -m fitness serve`).

A big GPS screen for hours drains the battery: the Data screen says how long it lasts and battery saver steps in, but
for Barry-Roubaix dim the screen or bring a small battery pack.

## Cloud sync (no computer)

Everything runs on GitHub and your phone. A **private** repository of yours syncs Garmin (and Strava, if you use it) every hour
while you're up (5:17 to 22:17 Michigan time; a run takes about 30 seconds) and whenever you open the app with data more than
45 minutes old, with [`fitness-sync.yml`](../.github/workflows/fitness-sync.yml), and the app
at <https://chris.bike/> reads the result with a token that can only see that repository. Garmin's
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
<https://www.strava.com/settings/api> (*Authorization Callback Domain* `chris.bike`), add `STRAVA_CLIENT_ID` and
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

## Inside the rides

The sync fetches each ride's minute-by-minute heart rate, speed and power from Garmin. It goes back 120 days, at
most 30 rides per sync to stay under Garmin's limits.
- **Aerobic decoupling:** on long steady rides (an hour or more, not commutes), how much more heart rate the second
  half cost for the same output. Under 5% over a ride as long as the race means the aerobic engine holds; more means
  more long Z2 riding. Trainer rides with power read cleanest. Outdoors, wind and hills blur any single ride, so
  watch the trend.
- **This week's hard sessions:** each session's planned minutes at target against the minutes your heart rate
  actually spent there. A rep under 4 minutes is expected to show half its length, because heart rate lags. If two
  sessions in a week fall well short, the page suggests your threshold heart rate is set too high, and how to retest
  it.

### The power-duration curve

From the same traces (and the average power of trainer rides from Strava that have no trace), **Ride → Training →
Power-duration curve** draws your best average power for 1 minute to 2 hours: the last 6 weeks against the year's
best, with the day each best was set (`power.py`).

- **Critical power and W′** (Monod & Scherrer 1965; Jones et al. 2010), fitted to the best 3–20 minute efforts of the
  last 90 days: CP is the most you can hold on your aerobic engine (close to, a little above, FTP); W′ is the fixed
  reserve above it that every surge and wave start spends. The page says how long an effort at 120% of CP empties it.
- **eFTP**, 95% of the best 20 minutes, beside the FTP the load math uses, with W/kg from your weight. When they're
  more than 5% apart the page says which way to move `athlete.ftp`, and with no FTP set it gives the number to use.
- **The last 6 weeks more than 8% under the year** at 5 or 20 minutes: the page says so, and that a rested hard
  session at that duration will tell fitness from simply no recent all-out effort.
- Minute resolution makes the 1–2 minute bests a little conservative; from 3 minutes on they're exact enough.
  Outdoors that needs a power meter; the trainer season fills the curve on its own.

## When the plan doesn't happen

Every sync rebuilds the plan from what you actually did ([`plan.py`](plan.py) `adapt`), and the Today card says
what changed under **Plan adjusted**:

- **A missed long ride** moves to the next free day that week: Saturday's to Sunday.
- **A missed key session** moves to a free day with no hard day on either side. If there isn't one, it's dropped
  rather than crammed in.
- **A missed commute** (weather, a meeting) is rebooked later in the week. Commutes you've already ridden count
  toward the week's 1–3, so a skipped one is made up and none is doubled.
- **The body decides today's intensity.** When this morning's readiness (or your check-in) says easy or rest on a key
  session or long ride, today becomes easy riding (or rest), and the session moves like a missed one: to a free day
  this week with no hard day beside it, or it's dropped rather than crammed in. Ride mode gets the eased session, and
  any day the call is easier than the plan (a commute call, a late check-in) has its ride held to it: intervals out,
  steady Z2 (or a recovery spin) in, with the reason shown and said at Start.
- **Today, as it happens.** If no ride in is logged by 10:00 on a commute day, today stops being a commute. The
  session it replaced comes back for the evening, on the trainer or outside, and the food plan follows. If nothing is
  logged by 19:00 on a long-ride day, the long ride moves to tomorrow when tomorrow is free.
- **Rest is earned.** A planned rest day after three days with next to nothing ridden (under 30 TSS, form above −15)
  has nothing to recover from. On a day off work (a weekend or a federal holiday), it becomes the long ride those days
  owed, even if that was last Saturday's. On a workday, it becomes steady endurance. Readiness still eases it if the
  morning says so. The holiday Monday after a weekend off the bike is the case it was built for.
- **Fitness lost to a missed day** isn't made up in one go. The coming weeks' load targets are recomputed from the
  fitness you actually have, still capped at `max_ramp`, so the race-day target stays honest without a cram week.

Recovery weeks, tapers and race weeks aren't rearranged: there, a missed session simply stays missed.

## Race day

The **Race** section covers each race in the next six weeks (the next one always):
- the race-morning timeline, counted back from your wave's start (`start = "HH:MM"` and `wave = N` in the race's
  config block; 10:00 until set, and set aside once the race rolls to next year's date), including a low-fiber carb breakfast (not the Nutty Pudding that day);
- how to ride the start and the heart rate to settle at;
- the bottles and gels for your expected time;
- the race's length from your own past editions (the median of the last three, by elapsed time; one edition per
  day, so a ride to or from the venue that shares the name doesn't count), else the option's `hours`. When this
  year's course is more than 3% longer or shorter than an edition, that edition counts at its own pace over this
  year's distance, so the bottles, gels, finish forecast and timeline fit the race you'll actually ride;
- with a `course`: its profile with the hills shaded; what it asks of you (rolling or climbing, front- or back-loaded,
  the finale and its last hill); the clock at each third (distance plus 1 km for every 100 m up, scaled to your
  expected time); and every hill with its length, height, grade, steepest pitch, time at race speed and how to ride
  it (a drag, a surge or a threshold effort);
- from 16 days out, the forecast **at the course** (`start_ll` / `finish_ll` in the race's block; the home forecast
  until then) for the warm-up, the race from your gun to your expected finish, and the finish, plus the trail the
  48 hours before leave behind (dry and loose, damp and packed, soaked, snow, frozen) and the head- or tailwind along
  the course itself (each stretch weighted by its length, and the share of it ridden into the wind), or along the
  start→finish line when there's no course;
- what that forecast asks of you, the bike and the bottles (`fitness/racewx.py`): kit for racing effort (about 10 °F
  warmer than the feels-like), the corral and the finish; the race's Silca pressures moved for the case, with the
  cold correction for pumping indoors (Gay-Lussac); and the bike, riding and fueling lines for the Cube's tubeless
  Riddler 45s, AXS, hydraulic Rivals and Super Secret drip;
- every case written out on the page, the forecast's picks first: dry sand, damp and packed, rain, mud, cold and
  wet, snow, frozen ground, freezing rain, bitter cold, warm, windy, thunderstorms;
- race notices to your phone: when the course forecast first arrives, when it changes what to do (once a day at
  most), the evening before (wake time, kit, pressures) and race morning;
- the bike checklist for the week before;
- a pack list;
- the key sessions still to come.

## The bike

The **Bike** section tracks the 2022 Cube Nuroad C:62 SL from the riding itself (`[bike]` in config.toml):

| Job | When |
|---|---|
| Re-drip the chain (Silca Super Secret) | every 200 mi, and **right after any wet ride** (from the weather history) |
| Clean the chain | every 800 mi |
| Check chain wear | every 1,000 mi |
| Charge the AXS battery | every 15 h of riding |
| Top up tubeless sealant | every 90 days |
| Check brake pads | every 1,000 mi; wet miles count double |
| Inspect the tires | every 750 mi |
| Bleed the brakes (DOT 5.1) | yearly |
| Shifter batteries (CR2032) | every 2 years |
| Full service | 3,000 mi or yearly |

- **Trainer rides** count toward the chain and the AXS battery, not the tires or brakes (`trainer = true`).
- **Done** logs a job (a `service` run). Until the first one, each job counts from the day it first appeared.
- **Intervals** can be changed under `[bike.every]`.
- **Tire pressure:** enter Silca's numbers per surface and per race. The app gives the total system weight to type
  into Silca's calculator: you, plus the bike's 18.5 lb, plus 2.5 kg of bottles and tools. It tells you to run the
  calculator again when your weight has moved 2 kg since you set them, or when a race is three weeks out with no
  pressures.

## Fitted to your riding

The plan fits itself to how you actually ride ([`plan.py`](plan.py) `fit`, from the last 12 weeks, once there are
6 weeks of riding; `[plan] fit = false` turns it off). The Season section shows it under *Fitted to your riding*,
next to each weekday's riding.

- **The week's shape** blends `weekly_pattern` half-and-half with your own riding: how often you ride each weekday,
  times how long. Commutes are booked separately. One full rest day stays (the configured one). A day you rarely
  ride isn't forced to rest: it stays a light option the planner can use as your fitness grows.
- **Volume** is capped at your usual busy week + 15%, so the plan stretches you without asking for a life you don't
  have. The cap never sits below what your current fitness can safely grow into (`base_ramp`, +3 CTL a week), so a
  quiet summer doesn't hold back an autumn build. The cap rises as you ride more.
- **Long rides** are capped at your usual long ride + 25% (at least 1½ h).
- **Commutes** use your own commuting days, most-used first, and your real 25th–75th percentile count per week.

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

### Beyond carbs and protein: the nutrients

The **Fuel** tab's *Nutrients* table checks the day against the Dietary Reference Intakes for your age and sex
([`nutrients.py`](nutrients.py)). Iron (× 1.8) and zinc (× 1.5) are raised for a vegetarian diet, as the DRIs do,
because plant iron and zinc absorb less. The Pudding and the Super Veggie are worked out ingredient by ingredient
(USDA FoodData Central; the whey and the lentils from their labels).

| What the two Blueprint meals bring | |
|---|---|
| Plenty | Fiber (~47 g), folate, vitamins C and K, magnesium, iron (~17 mg, mostly plant iron), plant omega-3 (ALA, ~7 g) |
| Part | Calcium ~60%, zinc and potassium ~65%, choline ~50%, selenium ~70% |
| None | Vitamin B12, vitamin D, iodine, EPA and DHA |

The plan closes the gaps every day:
- **A cup of plain Greek yogurt with the Super Veggie** (as a lime-cumin dressing or on the side). It adds B12,
  calcium and iodine. It also takes lunch past the ~2.5 g of leucine a meal needs to switch muscle repair fully on
  (the bowl alone has ~1.8 g, from plant protein).
- **Gap fillers**: 2 eggs (choline, B12, iodine, selenium), ¼ cup pumpkin seeds (zinc), and iodized salt in the
  cooking (sea and pink salt aren't iodized).
- **Iron**: the Super Veggie's lime and broccoli supply the vitamin C that helps its iron absorb. Keep coffee or tea
  an hour away from it.

What food can't cover is listed with a dose and the reason:
- **Vitamin D3**: 600–1,000 IU. At 42° N the skin makes next to none from November to February, and these foods
  have almost none.
- **Algae oil**: 250–500 mg EPA + DHA. The body turns only a few percent of ALA into EPA, and under 1% into DHA.
- **Creatine** (optional): 3–5 g. It helps the hard surges of a mass start or a punchy climb, and vegetarians
  respond more. It costs about 1 kg of water weight.

List what you already take under `[nutrition.supplements]` (`vitamin_d_iu`, `epa_dha_mg`, `b12_ug`…) and the table
counts it instead of suggesting it. Set `creatine = true` once you take it.

Training days add three things:
- **A beet-juice shot** (≈ 400 mg nitrate) 2–3 hours before key sessions and races, and daily for the 3–5 days
  before a race. Nitrate is one of the few supplements the IOC consensus rates as well supported (Maughan et al.
  2018). Skip antibacterial mouthwash on those days: mouth bacteria do the conversion.
- **25–30 g of slow protein before bed** after hard, long and race days: cottage cheese or Greek yogurt (Snijders
  et al. 2015).
- **Caffeine on race morning**, if you use it: 3 mg per kg, 60 minutes before the start (ISSN, Guest et al. 2021).

The weekly shopping list includes all of it: yogurt, eggs, pumpkin seeds, cottage cheese, beet shots, and a check
for the iodized salt and the supplements. These are planning numbers, not a food log. Dinner (beans, tofu,
potatoes) adds zinc, potassium, magnesium and iron on top.

### Shopping and prep

Under the fuel plan, *Shopping & prep* covers the next seven days:
- **How many** Nutty Puddings and Super Veggies the plan calls for, and on which days.
- **Your recipes scaled to that:** what to buy, with bag counts (for example frozen broccoli in 12 oz bags,
  lentil cans, limes), and what to check you still have (nuts, seeds, spices, supplements, in spoons or grams).
- **The prep:** pudding jars with the dry ingredients pre-portioned, one jar of dressing for the week, and lunches
  cooked up to four days at a time. With `lunch = "veggie_chicken"` the list swaps the lentils for chicken.

### Bottles for the weather

The bottle plan follows the forecast for the ride.
- **24°C / 75°F and up:** it adds water and sodium the mix doesn't cover: about 0.8 L and 600 mg an hour, rising to
  1 L and 800 mg from 29°C / 84°F. The extra comes from the bladder or a refill.
- **5°C / 41°F and below:** warm water in an insulated bottle, and drink on schedule even when you're not thirsty.
- **Race day** uses the race-morning forecast.

### Weight

Log a weigh-in now and then: Garmin Connect → Health Stats → Weight, or a Garmin Index scale. The fuel targets then
follow a 10-day smoothed trend instead of the profile's single number, and the page shows the 4-week change. The
Silca weight comes from the same figure.

## The app on your phone

**<https://chris.bike/>** is an installable app (a PWA): home-screen icon, full screen, no browser bars,
and it opens offline. The hosted copy holds no one's data; yours arrives from the [cloud sync](#cloud-sync-no-computer)
(or by hand from a computer, below) and stays on the phone.

**Why its own address.** Android installs one app per *scope*, and the music app's scope is all of chrisrohn.com, so
an app under chrisrohn.com/fitness/ could only ever offer *Open in New Music*. On its own origin it installs as its own
app, with its own icon, storage and notifications.

- **The site** is the GitHub Pages site of the public `chrisrohn/chris.bike` repository, at the custom domain
  `chris.bike` ([`config.toml`](config.toml) `[app] url`). Its `deploy.yml` workflow (source:
  [`cloud/app-site.yml`](cloud/app-site.yml)) builds the app from this repository's `main`
  (`node fitness/build-app.mjs --as app <dir>`, which also writes the Pages `CNAME`) every hour when `fitness/` has
  changed, and on demand (*Actions → Deploy the Training app → Run workflow*, any branch).
- **The old addresses** — <https://chrisrohn.github.io/> (the `chrisrohn/chrisrohn.github.io` repository, same
  workflow) and chrisrohn.com/fitness/ — forward there, and every QR link and home-screen shortcut from before still
  works. Browser storage belongs to an address, so on the way each phone's data comes along: the GitHub connection,
  settings and saved plan (localStorage) and ride mode's routes, rides and any ride still being recorded (IndexedDB),
  in the link's `#fragment`, which never reaches a server, in parts of up to 900 KB, one hop each
  ([`site/move-out.js`](site/move-out.js) → `chris.bike/move.html`, [`site/move-in.js`](site/move-in.js)). Nothing
  already at the new address is overwritten, the old copy is kept until the move has landed, and the new address only
  takes a move from the addresses in `[app] moved_from`. The old offline copy is retired. The app then says it moved
  once, and offers to turn the morning notification back on (a subscription belongs to the address it was made at);
  install it from chris.bike and remove the old icon.
- **The old github.io site only forwards once chris.bike is live.** Its deploy asks
  `node fitness/build-app.mjs --role chrisrohn/chrisrohn.github.io`: *forward* once `https://chris.bike/move.html`
  answers with the app, *standby* (the app itself, served there as before) until then. So the switch happens by
  itself on the first hourly run after the domain works, and nobody is sent to an address that isn't there yet.

**Setting up chris.bike** (once):

1. **GitHub:** create the public repository **`chrisrohn/chris.bike`** (with a README) and add
   [`cloud/app-site.yml`](cloud/app-site.yml) to it as `.github/workflows/deploy.yml`. *Actions → Deploy the
   Training app → Run workflow*: it commits the app and its `CNAME`. Then *Settings → Pages*: *Deploy from a
   branch*, `main`, `/ (root)`; the custom domain reads `chris.bike`.
2. **Verify the domain** (stops anyone else's Pages site claiming it): *github.com → Settings (your profile) → Pages →
   Add a domain* → `chris.bike`; it shows a TXT record to add.
3. **Namecheap → Domain List → chris.bike → Manage → Advanced DNS**: delete the parking records (the *CNAME* `www` →
   `parkingpage.namecheap.com` and the *URL Redirect* `@`), then add:

   | Type | Host | Value |
   |---|---|---|
   | A | `@` | `185.199.108.153` |
   | A | `@` | `185.199.109.153` |
   | A | `@` | `185.199.110.153` |
   | A | `@` | `185.199.111.153` |
   | AAAA | `@` | `2606:50c0:8000::153` |
   | AAAA | `@` | `2606:50c0:8001::153` |
   | AAAA | `@` | `2606:50c0:8002::153` |
   | AAAA | `@` | `2606:50c0:8003::153` |
   | CNAME | `www` | `chrisrohn.github.io.` |
   | TXT | `_github-pages-challenge-chrisrohn` | the code from step 2 |

   `www.chris.bike` then redirects to `chris.bike`.
4. Once the DNS check in *Settings → Pages* is green and the certificate is issued (minutes to an hour), tick
   **Enforce HTTPS**.
5. **Strava** (if you use it): set the app's *Authorization Callback Domain* to `chris.bike` at
   <https://www.strava.com/settings/api>.
6. Within the hour `chrisrohn.github.io` switches to forwarding (or run its *Deploy the Training app* workflow).
   Open the old app on the phone once: it carries everything over and opens Training at chris.bike. Install it from
   there, turn the morning notification back on, and remove the old icon.

1. **Install.** iPhone: open it in Safari → **Share** → **Add to Home Screen**. Android: Chrome → **Install**
   (the button in the top bar, or the ⋮ menu). Desktop Chrome / Edge: the install icon in the address bar.
2. **Get your data in** with the [cloud sync](#cloud-sync-no-computer), or by hand: on a computer,
   `python -m fitness run`, then **Body → Phone app**:
   - **Copy phone link** and send it to yourself (AirDrop, Messages, email). On the phone, open the app → **Import
     data** → paste it. The data rides after the `#` in the link, which browsers never send to a server.
   - Or **Save data file**, put it in iCloud Drive / Google Drive, and pick it under **Import data**. Set
     `[app] export_dir` (e.g. `"~/Library/Mobile Documents/com~apple~CloudDocs/Training"`) and every build drops a
     fresh `fitness-data.json` there for you.
3. **Refresh** with **Sync now** (or **Update data** without the cloud sync) in the bar under the masthead; it turns
   red after 36 hours. **Settings → Remove from this device** wipes it from the phone.

On iPhone an installed app keeps its own storage, separate from Safari, so import *inside* the app after installing.
Ride mode (also a long-press shortcut on the icon on Android) reads the same copy, so its zones and the week's sessions are
already there. Theme (light, auto or dark) and units follow you between the two. A new build of the site replaces the cached app the
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
   *Authorization Callback Domain* `chris.bike` (Strava always allows `localhost` too), then
   `STRAVA_CLIENT_ID=… STRAVA_CLIENT_SECRET=… python -m fitness login strava`. Keep `STRAVA_CLIENT_SECRET` in the
   environment for later syncs too (e.g. `export` it in your shell profile): it's never written to disk.
   This is how your Zwift and MyWoosh rides arrive, with their power. If you also record a trainer ride on the
   watch, the two copies are merged into one: the watch's heart rate plus the trainer's power.
4. `python -m fitness sync` (the first run backfills `sync.history_days` of Garmin data, about 2 requests a day),
   then `python -m fitness build --open`.
5. Set `max_hr`, `lthr` and, if you have a power meter, `ftp` in [`config.toml`](config.toml). Any value you leave
   at 0 is estimated from your data, and the page lists which ones were estimated. **LTHR is learned from your
   rides** (`streams.lthr_from`): the best gap-free 20 minutes × 0.95 or the best hour (Friel's field markers) across
   the last year's heart-rate traces, the second-best once five rides were hard (a strap glitch can't set your zones),
   80–95% of max HR; it waits for three genuinely hard rides, and 89% of max HR stands in until then. Every zone,
   target and load follows it.

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
- **Readiness, weighted for you.** Once there are 20 mornings with a commute, each marker's weight grows with how
  well it has predicted your good days. A good day is measured, not felt: speed per heartbeat on the commute against
  that leg's usual. The weights are shrunk toward the defaults until there are plenty of days (n / (n + 30)). The
  readiness panel names the marker that predicts best for you.
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
| `feel.py` | the app's morning check-in and ride ratings: parsing what the phone sends, storing it, blending it into the call |
| `rides.py` | rides ride mode sends to the sync: decoded into an activity and a trace, merged with the watch's copy (its power added), uploaded to Garmin Connect when nothing else recorded them |
| `power.py` | the power-duration curve, critical power and eFTP |
| `plan.py` | season planner (phases, trainer season, taper optimizer) and session libraries |
| `build.py` | assembles the numbers and inlines them into `dist/index.html` and `dist/ride.html` |
| `build-app.mjs` | writes the public, data-free app for its own site (`node fitness/build-app.mjs <dir>`: the dashboard shell, ride mode, MapLibre, manifest, icons, the offline service worker) and, during the chrisrohn.com build, the forwarding page at `/fitness/` |
| `render-icons.mjs` | renders the PNG icons from `site/icons/*.svg` (the heartbeat as the bike's top tube) |
| `raceday.py`, `racewx.py` | race day: the morning timeline from your wave's gun, pacing, bottles, the course's hills and clock, and the course forecast turned into kit, tire pressures, bike prep and riding for every weather case |
| `course.py`, `courses/` | a race's course from the organizer's GPX: length, climbing (recorder-style and ride mode's), hills, thirds and finale, the profile, the wind along it, and the thinned line for ride mode |
| `workouts.py` | structured steps (HR targets from threshold HR) for ride mode |
| `site/` | the dashboard (`shell.js`: data, install, offline; `app.js`: the page), ride mode (`ride-core.js`: routes, navigation, climbs, the sun, workout tailoring, FIT / GPX / TCX, smart-trainer protocols, offline routing from vector tiles, the battery forecast, the ride packed for the sync; `ride.js`: the screens, sensors and trainer, map, recording and sending), styles, SVG charts, `csp.txt`, `manifest.webmanifest`, `sw.js` (offline, map tiles, the share target) and `icons/` |
| `demo.py` | the synthetic athlete |
| `fonts/` | Nimbus Sans L (URW, GPL v2): the source OTFs, the license, and `subset.sh`, which writes the app's `site/fonts/*.woff2` |

Tests: `python -m pytest fitness/tests` (models, planner, parsers, build, race courses checked against ride mode's own analysis) and `npx playwright test fitness/tests` (the hosted app and ride page: manifest, offline, data import, the GitHub sync against a stand-in API, CSP, accessibility, link hand-off, the move from chrisrohn.com; and the cycling computer: route parsing, climbs, turn by turn, off course and detours against a stand-in BRouter, the map under its CSP, recording and FIT / GPX / TCX, tailoring, the share target, the race course on the card and kept as a route). CI runs both. This is a personal analysis tool, not medical advice.
