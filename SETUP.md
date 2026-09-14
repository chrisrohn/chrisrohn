# Chris Rohn's New Music — setup

Everything here is free. Total setup is about 20 minutes, most of it DNS propagation.

## What you are building

```
GitHub Actions (nightly, by 06:47 ET)                  chrisrohn.com (GitHub Pages, public)
┌──────────────────────────────────────┐               ┌───────────────────────────────────────┐
│ profile: Last.fm tt_discotheque      │               │ anyone: listen, filter by source, Picks│
│   + your public year playlists       │   feed.json   │                                       │
│   + Last.fm & ListenBrainz similar   │ ────────────▶ │ you (Sign in with Google):            │
│   + Last.fm top acts of your genres  │               │   keep → "<year> | Indie Discotheque" │
│ sources: your artists' new releases  │               │   skip → unlisted "Skipped" playlist  │
│   (YouTube Music · Deezer · MB)      │               │   (YouTube Data API, from your browser)│
│   ListenBrainz fresh · MB tags       │               │                                       │
│   Bandcamp · radio · blog RSS        │               │                                       │
│   thin day → earlier years fill in   │               │                                       │
│ score → resolve on YouTube Music     │               └───────────────────────────────────────┘
│ hides anything already in those      │ ◀── reads your playlists (public + unlisted-by-id) ──┘
│ playlists                            │
└──────────────────────────────────────┘
```

No database, no server, no GitHub tokens: your YouTube playlists *are* the state. The daily job only builds the
feed; the only thing that ever writes to a playlist is you pressing a thumb while signed in. ("Indie Discotheque" below
always means the YouTube Music library playlists, `<year> | Indie Discotheque`, that the picks are filed into.)

## 1. GitHub (required)

1. Merge this branch to `main`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Settings → Actions → General → Workflow permissions: Read and write permissions.**
4. **Settings → Secrets and variables → Actions → New repository secret**: `LASTFM_API_KEY` from
   https://www.last.fm/api/account/create (instant, free, any app name). Optional but recommended: `DISCOGS_TOKEN`
   from a free Discogs account (Settings → Developers → Generate new token) — Discogs master years are the
   strongest source for original release dates of disco/electronic records. For the Concerts tab (all optional,
   each one another listing; all free but JamBase): `BANDSINTOWN_APP_ID`, `TICKETMASTER_API_KEY`,
   `SEATGEEK_CLIENT_ID`, `EDMTRAIN_API_KEY`, and `JAMBASE_API_KEY` on its metered free tier — see *Concerts* below.
5. **Actions → Discover → Run workflow.** Afterwards: merging a change to `site/` publishes in about a minute
   (the *Publish site* workflow); merging a change to `discovery/` runs the full data build first, 20–30 min.
   Feed data refreshes on the morning schedule (three slots, first one wins — see *How the site is built* below)
   or a manual Discover run.
6. **Actions → Discover → Run workflow** (first time only). First run takes ~10–15 min (profile build + MusicBrainz rate limit).

## 2. chrisrohn.com DNS (required for the custom domain)

At your registrar (or DreamHost, if its name servers still run the domain), add:

| Type | Name | Value |
|---|---|---|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| CNAME | `www` | `chrisrohn.github.io` |

Then **Settings → Pages → Custom domain: `chrisrohn.com`** → Save → tick **Enforce HTTPS** once the check passes.

## 3. Sign in with Google (so keeps and skips reach your playlists)

One free Google Cloud OAuth client, created in the browser with a **personal** Google account. Everything after
that is a normal "Sign in with Google" button on the site.

1. https://console.cloud.google.com/projectcreate → name it `chrisrohn-new-music` (any name works) → Create.
2. https://console.cloud.google.com/apis/library/youtube.googleapis.com → **Enable** (YouTube Data API v3), and
   https://console.cloud.google.com/apis/library/drive.googleapis.com → **Enable** (Google Drive API — used only for a
   hidden app-data file that keeps your thumbs in sync across devices; the site never sees your real Drive files).
3. https://console.cloud.google.com/auth/overview → **Get started** → App name `Chris Rohn's New Music`, your
   email, Audience **External**, contact email → Create. Then on **Branding** set Application home page
   `https://chrisrohn.com`, Privacy policy `https://chrisrohn.com/privacy.html`, Terms of service
   `https://chrisrohn.com/terms.html`, and add `chrisrohn.com` under Authorised domains. (Both pages ship with
   the site and contain the disclosures YouTube API Services require.)
4. https://console.cloud.google.com/auth/audience → **Publish app** (confirm). Unverified is fine: Google shows a
   one-time "app isn't verified" screen that you click through (**Advanced → Go to …**). Publishing avoids the
   7-day sign-in expiry of Testing mode. (If you'd rather stay in Testing, add yourself under **Test users**.)
5. https://console.cloud.google.com/auth/clients → **Create client** → Application type **Web application** →
   Authorised JavaScript origins: `https://chrisrohn.com`, `https://www.chrisrohn.com`, `https://chrisrohn.github.io`
   (add `http://localhost:8000` if you run it locally) → Create. Copy the **Client ID** (ends in
   `.apps.googleusercontent.com`). No secret is needed for this flow.
6. Put it in `discovery/config.yaml` → `google.client_id`, and make sure `google.curators` lists the Google
   account that owns the playlists. Commit (GitHub's web editor is fine). The next Discover run ships it in feed.json
   (the curator addresses are published only as SHA-256 hashes; the site hashes the signed-in address to compare).

On the site, click **Sign in with Google**, pick that account, allow "manage your YouTube account". The thumbs
appear. Sessions last an hour; the button re-prompts (usually a silent popup) when needed.

**Quota:** YouTube's free API quota is 10,000 units/day (reset midnight Pacific); each write costs 50. Only Keep
spends quota, so you get ~200 *saves* a day, and ⚙ shows a running meter. Skip is free: skips are remembered in the
browser and expire with the feed. Listening, filtering and playback cost nothing.

**Optional – skips on YouTube too:** switch on **⚙ → Also file skips into the Skipped playlist** if you rate from
several devices and want skips shared. The first skip then creates an unlisted `Indie Discotheque – Skipped`
playlist and shows its ID; paste it into `config.yaml` → `youtube_music.skipped_playlist_id` so the daily build
can read it (unlisted playlists aren't discoverable by title). All 48 year playlists (1979–2026) are pinned by ID in
`youtube_music.playlists`; when you create a new year's playlist, add its ID there (the build also finds it by title).
**Release years (original, not reissue):** the build identifies each track as a *recording* before asking for dates,
so the answer is consistent instead of depending on how a blog spelled the title:

1. ListenBrainz's MusicBrainz mapper (the same fuzzy matcher that maps your scrobbles) → the recording's MusicBrainz ID.
2. MusicBrainz → the earliest release of that recording, ignoring compilations, live and DJ-mix releases. A 10th
   anniversary reissue is just another release of the same recording, so the original year wins.
3. If MusicBrainz has no mapping: a strict MusicBrainz title search; then Deezer for the track's **ISRC** (the
   recording's industry code, kept across reissues) and a MusicBrainz lookup by that ISRC; the ISRC's own
   registration year is kept as a weak hint.
4. **Discogs** master-release year (masters represent the original issue; strong for disco/electronic). Needs a
   free Discogs account: Settings → Developers → *Generate new token*, saved as the `DISCOGS_TOKEN` repo secret.
5. iTunes Search API; then a release date the source itself states (Bandcamp, ListenBrainz, KEXP's album date)
   or the year YouTube Music's artist page states for a watched release; then the YouTube album year. Blog post
   and upload dates are only sightings.
6. Still unsure (no catalogue or store has a date, at most a weak hint): the release date YouTube Music states for
   the upload itself, read from the song's own page (ytmusicapi, no API quota) — a remix that only exists as an
   official video, say. It is a weak hint (`2016 ?` on the badge, the evidence line names it), but a year to file
   under rather than `year?`. Never for a fan upload, whose date is only when it was uploaded; asked once per
   video, a bounded batch a run (`resolve.max_ytmusic_date_lookups_per_run`), and asked again when the track is
   paired with another upload.

Every year found is kept as evidence (hover the year badge on the site to see it). The earliest year from the most
trusted tier wins: ✓ = catalogue-verified, plain = a store/source date, ? = weak hint. If nothing anywhere says when
a song came out the card shows `year?` and Keep refuses until you pick, so a catalogue track can't slip into this
year's playlist by default. Lookups are cached and budgeted per run (`resolve.max_year_lookups_per_run`; MusicBrainz
allows 1 request/s), undated tracks first.

**Sessions:** Google access tokens last an hour; the site renews them silently on your next tap, so you stay signed in
for as long as your Google session lasts. Signing out only forgets that device. To disconnect the site from your
Google account entirely use https://myaccount.google.com/permissions.

**Audio, not video:** YouTube Music lists most songs twice, as the audio-only track (`MUSIC_VIDEO_TYPE_ATV`, the
one the playlists want) and as the official video. The resolver prefers the audio track in search, swaps a video hit
— from a search or from an album page alike — for its audio counterpart (the watch playlist pairs the two), and
prefers an original issue over a deluxe, remastered or live edition. A card that is still a video (YouTube Music
pairs no audio track with it yet) is asked again every `resolve.audio_recheck_days` (30), a batch a run
(`resolve.audio_heals_per_run`), because the pairing often arrives later; a hit whose kind the cache never recorded
learns it the same way. ⚙ → *Stats* says how many of the day's cards (and the catalog's) play the audio track, the
build's log line the same. The library itself is checked too: every playlist row that is a video rather than the
audio track is listed in the **Cleanup** tab under *filed as the video, not the audio track*, with the audio track
YouTube Music pairs with it (asked through the watch playlist, `resolve.counterparts_per_run` a run, no API quota)
and a **swap** (add the audio track, remove the video: 100 units), per row or *swap all in a year*; **keep the
video** stops listing a row you want as it is. The album a song names is opened once for the year YouTube Music
states and its playlist, which is what the "full release" link and the year fallback come from.

**The video side, on its own tab:** the year playlists hold audio tracks, and this stays so — the Feed, the Catalog,
Picks and Cleanup never show or file a video. YouTube Music pairs most audio tracks with an official video (the same
watch playlist that pairs a video with its audio track names the video for an audio track), and the **Video** tab
(curators only) is the one place those are reviewed. Two things put a video there: a song **kept** on the Feed or
the Catalog whose card knows its video side — the resolver asks YouTube Music for it as it resolves each card
(`videos.feed_lookups_per_run` a run, once, then again every `videos.recheck_days` while there is none; the id
travels in feed.json as `youtube.video`, and a swapped video hit already knows it), so a Keep brings the video to
the tab the same day, and the Keep toast says so — and every song in every year playlist that has a video: the
**Videos** workflow (its own job, 15:51 ET, `discovery/videos.py`) walks the profile's playlist scan, asks the
watch playlist for each audio row's video (`videos.lookups_per_run` a run, ≈0.3 s each, cached for good in
`data/cache/videos.json`, so a 26,000-row library is done in a few weeks and then only new rows are asked), counts
a row that is itself a video as it stands, reads the music-video playlist (public, no quota) to leave out what it
already holds, leaves out what the tab decided (`data/ratings.json` → `videos`), and writes one row per video
(however many years hold the song) to `site/data/videos.json`; the daily job rewrites the same report from the cache
at its end (`videos.in_daily`), so a decision made on the tab is out of the list the next morning. On the tab: ▶
plays the video in place (`j`/`k` move the player down and up the list, `space` opens it, `u` approves, `d` passes,
`Esc` closes), **▲︎ add** puts the video into the single music-video playlist — `youtube_music.videos_playlist_id`,
https://music.youtube.com/playlist?list=PLTW5JZnPjE_r0Y2WwYFLFAbEVZTlt6xuX, the only playlist the tab ever writes
to (50 units, plus 1 to verify the video is not there already unless the playlist was read in the last half hour;
**read the music-video playlist** reads it on demand, 1 unit per 50, and hides what it holds) — and **▼︎ pass** is
free. Every decision is remembered per account (`id:videos`), mirrored across devices with the ratings (the Drive
file and the ratings push both carry `videos`), undoable from the toast (an approval's Undo removes the video
again), and filtered by where it came from, year and name. `python -m discovery videos` runs the report by hand.

**Songs, not interludes or mixes:** a track shorter than `resolve.min_length` (1:55) or longer than
`resolve.max_length` (9:31) is never a card, in the feed or the Catalog tab. Between several uploads of a song the
resolver prefers one inside the range (the radio edit over the extended mix, the first real song over an album's
one-minute intro); a song whose only upload is outside it is dropped after resolution, and hits cached before the
range existed are looked up once more in case a song-length upload exists. Both ends take `m:ss` or seconds; an
empty value lifts that end.

**No duplicates:** every Keep first asks YouTube whether that video is already in the target playlist (1 quota unit)
and skips the add if so. The daily build scans all year playlists and lists every *song* they hold more than once
(full report in `site/data/duplicates.json`, one item per song with every copy): a song is an artist plus a title with
its edition suffixes peeled off (`discovery/editions.py`), so the audio track, the official video, a remaster and a
radio edit of the same song land in one item, and each item names its problems — **extra copy** (the same video twice
in one year), **two years** (the same edition filed in two years; the catalogues verify the original year, a batch a
run: `resolve.max_duplicate_year_lookups_per_run`), **several uploads** (two uploads of one edition) and **versions**
(two editions: original and remix, radio and extended — a judgement call, so remixes and live takes keep their own
year). The site warns you on load; the **Cleanup** tab (curators only; its pill counts what is left) lays every copy
out as a row — edition, length, album, position, whether it plays here, ▶ to play it in place — and **look up the
copies** asks YouTube what each upload is (channel, views, upload date, region; 1 unit per 50). Pick a copy with its
radio button and **keep the chosen copy** removes the rest; ✕ removes one; **move to…** refiles a copy into another
year (the verified year marked ✓, and a song filed entirely in the wrong year gets a one-tap **move everything**);
**looks fine · dismiss** keeps every copy and stops listing the song. Filters by problem, year, order and name; bulk
buttons trim all extra copies in a year or fix all wrong-year copies of verified songs in a year (removed when the
verified year already has that edition, moved there when not), within the day's quota (51 units a removal, 102 a
move; the tab says how many today's quota allows). What you do is remembered as marks with your ratings in the Drive
mirror, so it stays done on every device; a song stays listed while the copies left still add up to a problem, and
the next build drops what is gone. **Scan a year now** reads one playlist as it is right now (1 unit per 50 tracks),
groups it by song the same way and removes without a lookup.

**Not streamable here:** the same playlist scan sees which tracks YouTube Music greys out in the region the
playlists are listened to in (`youtube_music.region`, US) — label rights, a withdrawn upload, a region lock — but
YouTube Music's listing drops deleted and private videos altogether, so the tab's **playability audit** reads a
year playlist through the Data API and checks every video with YouTube (about 2 units per 50 tracks; a whole library
in a day's quota, and *audit every year* stops by itself when the quota runs low): a video YouTube no longer answers
for is deleted or private, one restricted away from the region is blocked. Findings are kept on that device, listed
under *not streamable here* with why (a deleted video keeps whatever name the site's own records still have for it),
and travel to the build with the ratings file (`data/ratings.json` → `unplayable`), where the build searches for
another upload of each song that streams there, the audio track first, a batch a run (`resolve.counterparts_per_run`,
cached). A **swap** adds the counterpart and removes the dead copy (100 units, 101 for the build's rows), *swap all
in a year* does it in bulk within the day's quota, **find a replacement now** does the search from the tab for 101
units (the audio track first, anything blocked here left out, each result playable in place before you use it), and
a track with no other upload can be removed or searched by hand. The report is `site/data/unavailable.json`.
If you ever need more than 200 writes a day, Google grants quota increases for personal projects through the
YouTube API quota extension form in the Cloud console (free). The reviewers ask for a screencast of the client
verifying playlist contents and adding or removing tracks: **⚙ → API activity** lists every YouTube Data API request
the browser makes as it happens (endpoint, result, quota cost, and what it was for), with Copy / Download for the
reply; [docs/youtube-api-compliance.md](docs/youtube-api-compliance.md) has the shot list and the reply to send.

## Public vs. curator

chrisrohn.com is public: anyone can browse, filter by source, play tracks and see **Picks** (the newest tracks in
your current-year playlist). Nothing on the public side can write anywhere.

**Curator mode** appears when the signed-in Google account is in `google.curators`: thumbs file into the
`<year> | Indie Discotheque` playlists. **Guests** are off by default: other Google accounts can sign in but get a listen-only site. Flip
`google.guests: true` (your ⚙ panel links straight to the line) and they can rate too, with their keeps going into
`<year> Picks from chrisrohn.com` playlists in *their own* library, never yours. Everyone who signs in
shares the project's daily YouTube API quota. Nothing about the site can touch a playlist except through a Google
session that the playlist's owner approved in that browser.

## Daily use

- Open chrisrohn.com. `j`/`k` move, `space` plays, `u` thumbs up, `d` thumbs down, `x` flags the wrong video, `o` opens in
  YouTube Music, `/` searches.
- Change the year dropdown on a card before thumbing up if a reissue/late release should go to another year.
- **Keep** files the track into the year playlist immediately (an **Undo** button shows for a few seconds). **Skip** hides
  it. Both disappear from the feed at once on every device: ratings are mirrored to a hidden app-data file in your
  Google Drive (free, no quota), pulled when you open the site or return to the tab and pushed after each thumb.
- **The ratings file for the build** (⚙ → *GitHub token*): with a fine-grained token (Contents: read and write, this
  repository only) pasted once, the site commits `data/ratings.json` after each sitting, so tomorrow's build learns
  from the free local skips and the wrong-video flags too. It is built for a phone on a patchy connection: the file's
  git blob sha is worked out in the browser and compared with the repository's, so an unchanged sitting uploads
  nothing and no copy is ever downloaded; a dropped connection is retried by itself — on the spot, then on a widening
  delay, and at once when the network or the app comes back — and what is still waiting shows in ⚙ rather than
  interrupting the rating. Nothing is lost if the tab closes mid-push: it goes up on the next visit.
- **≠ Wrong video** is the third verdict, on every card, in the player and on the phone deck (`x`): the title the card
  shows is not what the YouTube match plays (a mis-resolved upload). It hides the card without judging the song —
  free, never filed on YouTube, kept out of the keep rates — and, through the ratings file, tells the daily build to
  resolve the track again without that upload. The card is back the moment the build pairs it with another one;
  meanwhile it sits in the **Skipped** tab marked *wrong video*, with **restore**.
- **Audition mode** (`a`, or the checkbox in the player bar): each track starts partway in and the site moves on by
  itself after 30 seconds unless you press a key or click the player. Length and start point are in ⚙.
- **On a phone**, tap **Install** in the bar under the header (or ⚙ → *Install as an app*; on iPhone the sheet
  walks through Share → Add to Home Screen). The installed app runs full-screen from its own icon, opens offline with
  the last feed, shows the track on the lock screen with play/pause/next, offers **New today**, **Picks** and
  **Audition** as long-press shortcuts on the icon, and refreshes itself when a new daily build lands while it is
  open. A new site build shows a *Reload* toast rather than switching under you. Swipe a card right to keep, left to
  skip (curator or guest mode only); **share** on a card opens the system share sheet. Desktop Chrome/Edge/Safari 17
  install it too (the Install button in the header, or the icon in the address bar).
- **Shortlist:** the Feed tab opens on the top 60 by score (⚙ sets how many); *show all* at the end of the list, or the
  `+N` next to the deck counter, lifts it for the visit. A search or another sort always shows everything. The day
  itself is up to `ranking.max_items` (500) songs, ranked by score.
- **Video** tab: the official videos of the songs you keep and of everything the year playlists already hold, each
  played in place and either added to the music-video playlist (`▲︎ add`, the one playlist videos go to) or passed
  (free). Only a kept song's video comes here from the feed; the year playlists themselves stay audio. See *The
  video side* above.
- **It learns from you, without API quota.** Every keep and skip remembers the card's sources, blogs, tags and artist.
  The site works out a keep rate for each against your overall rate and nudges the scores (the number on the card
  hovers to show `build score ± learned`), so a blog you keep from floats up and one you skip through sinks; tracks
  left unrated for three days count as a weak pass. It travels with the Drive mirror, so every device agrees.
  The daily build does the same from the other side: `site/data/history/` records what each feed showed, and
  three days later anything that reached a year playlist counts as kept, the Skipped playlist as skipped (only when
  skips are filed on YouTube), the rest as a weak pass — `discovery/learn.py`, tuned under `learn:` in config.yaml
  and weighted by `ranking.weights.learned`. Cards say why: "you keep 71% from KEXP", "you rarely keep hip hop".
- **Skipped** tab: what you thumbed down or flagged as the wrong video from this feed, newest first, with **restore**
  (an Undo that no longer needs the toast; a skip filed on YouTube costs 50 units to take back). **Stats** (⚙ → *Stats*): keeps and skips by week,
  keep rate by source and tag, most-kept artists, and what the build has learned so far.
- A tag chip or an artist name on a card is a filter (it lands in the search box). The **link** control on a card
  copies its own address (`/?t=<id>`), which opens the site on that card; the RSS items carry the same link.
- A video YouTube refuses to embed here (removed, or the owner blocks embedding) is remembered for a month: the card
  stays, marked *no embed*, and autoplay steps over it.
- **Thin days fill themselves.** The day is built from the current timeframe first: this year's releases, plus
  anything dated within `ranking.fresh_days`, plus what nobody dates. When that leaves fewer than `backfill.target`
  playable cards, the best releases the artist watch found in the last `backfill.years` years fill the gap (at most
  `backfill.max` a day). They carry a *filling in from &lt;year&gt;* note, their year badge says *· filling in*, and
  each files into its own year playlist, so a quiet week works through the back catalogue of the artists and genres
  you follow instead of showing you 130 cards. Nothing older than that window is ever pulled into the feed — that is
  what the Catalog tab below is for. The target is set to a day's *rating* appetite (300), not to what the fresh
  window happens to yield: those older candidates are fetched, scored and resolved on YouTube every run whatever the
  target says, so raising it costs nothing but keeps what a lower one threw away. `ranking.max_items` has to stay
  clear of `backfill.target`, or the final cut-by-score drops the fill it just made — a test in
  `tests/test_sources.py` holds that line.
- **Every card plays.** A song becomes a card only once it has its YouTube Music audio track. One with no match, a
  video-only match or an upload whose kind is not known yet is left out of the day rather than shown as a card that
  cannot be played or filed, and is tried again on a later build: a miss is looked up again after
  `resolve.retry_misses_days` (7; a new release often gets its audio track a few days after the blogs write about
  it), a video is asked for its audio side again every `resolve.audio_recheck_days`, and unknown uploads are
  labelled a batch a run. There is no "playable" filter on the site because there is nothing for it to hide.
- **Catalog** tab — filling the earlier years. The daily job also builds `site/data/catalog.json` from your own
  Last.fm history: the tracks you have played most and the ones you loved but never filed, then the top tracks of
  the artists you play and of their similar artists (what is adjacent). Anything a year playlist or the Skipped
  playlist already holds is hidden; the rest is resolved on YouTube Music and given a verified release year by the
  **Catalog** workflow (its own daily job, five hours after Discover, with a full 45 minutes), so the tab fills in
  over a couple of weeks and then keeps pace with your listening. A track is published only once its year lookup
  has run: the year select says how many are still "being dated". The catalog's chain is the fast one (ListenBrainz,
  MusicBrainz, Deezer, then the year YouTube Music states for the album; no Discogs or iTunes), and a card that still
  has no year offers **find year** — a one-tap MusicBrainz lookup from the browser that fills the year select — and
  a Discogs search link.
  The year select shows every playlist year with how many tracks it holds and how many candidates wait, so the
  thin years are easy to work through; each Keep files into the verified year (or asks when none was found). Plays,
  loved, your keeps and skips all rank it; the shortlist, search, source chips and the phone deck work as in the
  feed. Tuning is under `catalog:` in config.yaml (candidate counts, per-run lookup budgets, its share of the job's
  time after the feed). Nothing here spends YouTube API quota; the Last.fm key is the only one it needs.
- **Concerts** tab — who is playing near Detroit. The **Concerts** workflow (its own job, 13:33 ET) takes every
  artist played on Indie Discotheque in the last year — the Last.fm 12-month chart of `station.lastfm_user`, plus
  anyone filed into this year's playlist (`concerts.playlist_years`) — and draws their shows from six listings, each
  switched on by its own key (free, except JamBase) and each reported on its own in the tab's summary line (so a dead one is never mistaken
  for a quiet one):
  - **Bandsintown** (artist by artist): asks its artist-events API where each act plays next, as many a run as
    `time_budget_minutes` allows (about six a second; `artists_per_run` caps it when set) and again after
    `refresh_days`, so the list fills in over its first run or two and then keeps pace. Bandsintown's API is free but
    refuses any `app_id` it has not approved — with a 403 on every request, or just as often with an empty list or
    *"[NotFound] The artist was not found"* for every artist, which looks exactly like nobody touring. An artist
    gets a key under Bandsintown for Artists → Settings → General → *Get API Key*; anyone else asks
    biz@bandsintown.com — and a key that still answers empty for everyone needs Bandsintown to enable it for the
    public API (the same address). Put it in the `BANDSINTOWN_APP_ID` **repository** secret (Settings → Secrets and
    variables → Actions; a secret scoped to the *github-pages* environment never reaches the build job, and a
    *variable* is not a secret): `concerts.bandsintown.app_id` is only the fallback. The build logs whether the key
    came from the secret or the fallback (never its value), the health record's `bandsintown.app_id_from` says the
    same, and `bandsintown.answers` tallies what Bandsintown said (`listed`, `empty`, `not found`, or its message).
    A run of `concerts.bandsintown.give_up_after` straight failures ends the batch for that run rather than asking
    1,500 times, and a run whose first `concerts.bandsintown.empty_probe` answers (the most played artists first)
    list no show anywhere is treated as refused: nothing is recorded as checked, the summary line says so and names
    where the key came from, and the batch is asked again once the key is right.
  - **Ticketmaster** (`TICKETMASTER_API_KEY`, free at developer.ticketmaster.com, 5,000 calls a day; the list needs
    a few dozen): every music event its Discovery API lists in the radius — matched against the same artists — with
    prices, sale status and the venue's picture. TicketWeb (Ticketmaster's club arm) rides the same API.
  - **SeatGeek** (`SEATGEEK_CLIENT_ID`, free at seatgeek.com/account/develop): every concert and music festival its
    Platform API lists in the radius, which includes the clubs that sell through DICE, Eventbrite or their own box
    office and never appear on Ticketmaster; its price is its lowest listing (resale included) and is labelled so.
  - **JamBase** (`JAMBASE_API_KEY`, data.jambase.com — the Developer tier: non-commercial, 1,000 calls a month and
    3,600 an hour, every call past that charged, future events six months out, attribution required): the widest
    venue-calendar aggregator, every show in the radius with the ticket link and its seller. The tab credits it in
    its required wording (*Concert data provided by JamBase*, linked) on the line under the summary whenever its rows
    show, and asks no further than `concerts.jambase.max_days_ahead` (180 days) — the plan lists nothing past that.
    The calls are spent for coverage, not freshness: a page of 100 events, every act on every bill, is one call, so
    one region scan covers all 9,000 played artists at once, and the six months are split into date bands
    (`concerts.jambase.bands`: 45 days refreshed every 2, to 120 every 5, to 180 every 10), each with its own
    snapshot, so the near future — where announcements, sold-outs and cancellations happen — is a few pages
    refreshed often and the far end, most of the events, is fetched rarely. A run touches only the bands that
    are due, nearest first, within `requests_per_run` (40); a band the cap interrupts keeps a date cursor and
    continues from it next run (its older rows kept meanwhile), so a small cap still walks the six months. A ledger
    in `data/concerts_state.json` (`quota.jambase.days`, one count a day, committed with the data) holds every run,
    scheduled or by hand, to `monthly_quota - quota_reserve` (900) calls in any trailing 31 days — which bounds every
    calendar month and every anniversary month — counting each request before it goes out (there are no retries)
    and stopping the paging where the ledger says. The health row in `site/data/concerts.json` lists the bands
    (from, to, fetched, complete, calls, pages), the ledger (calls this run, used in the window, remaining) and
    `planned_calls_per_month`, what the cadences add up to at the pages each band actually needs — tune the bands
    if it nears 900. Requests are spaced 1.1 s apart, under the hourly rate. `concerts.jambase.base_url` and `auth`
    point at the v3 API (bearer token); the v1 API at `https://www.jambase.com/jb-api/v1` with `auth: query` still
    answers.
  - **Edmtrain** (`EDMTRAIN_API_KEY`, free, edmtrain.com/developer-api): every electronic show in
    `concerts.edmtrain.states` (Michigan, Ohio, Ontario), the lineups the dance venues post themselves; the radius is
    applied afterwards, live streams are left out.
  - **Resident Advisor** (no key): its public GraphQL, the one ra.co's own event pages call, for every listing in
    `concerts.resident_advisor.area` (`ra.co/events/us/detroit`; the numeric area id is looked up once and
    remembered, or set `area_id`), with the venue's coordinates and RA's own ticket link.

  Every venue within `radius_miles` (80) of `center` (Detroit) makes the list, out to `months_ahead`; a show found by
  several sources is one row: the listing the promoter posted (Bandsintown, then RA, JamBase, Edmtrain) leads with
  its bill, the ticket sellers and aggregators add the link, price, status and picture it lacks, and every source's
  link is on the row. A billing qualifier ("Amtrac [Live]", "(DJ set)") never stops a match. Each act's most popular
  song comes from Last.fm `artist.getTopTracks` (Deezer's artist top without a key), is resolved on YouTube Music
  through the feed's resolver and cache, and plays in place from the row. Bandsintown's, JamBase's and Edmtrain's
  ticket links lead to whichever seller the venue uses, so the button names the seller from the link (Ticketmaster,
  TicketWeb, AXS, Etix, DICE, Eventbrite, Resident Advisor…). The report is `site/data/concerts.json`; the per-artist
  state (last asked, shows, top song) and each area source's last snapshot are `data/concerts_state.json`. On the
  tab: search matches artists, venues, cities and song titles (`source:seatgeek` narrows to one listing); selects for
  when (this week, 30, 90 days), how far (25/50 miles) and the order (soonest, most played, nearest, artist); `space`
  plays the first song, `j`/`k` walk the list; an artist's name opens the sheet, which also lists their dates.
  `python -m discovery concerts` runs it by hand; nothing here spends YouTube API quota.
- Subscribe to `https://chrisrohn.com/feed.xml` in any RSS reader for the same list (with release dates, artwork and
  tags; the internal score stays internal).

## Sources

All in `discovery/config.yaml → sources`, each with an `enabled` switch. Per-feed health shows under ⚙ on the site.

| Source | What it finds | Needs |
|---|---|---|
| `listenbrainz_fresh` | every release MusicBrainz knows from the last N days, filtered by your artists/tags | nothing |
| `musicbrainz_tags` | recent releases tagged with your genres, from artists you've never heard of | nothing |
| `ytmusic_artists` | singles/albums of your profile artists straight from YouTube Music (the old Release Radar) | nothing |
| `musicbrainz_artists` | release groups of your profile artists, by MusicBrainz artist id | nothing |
| `youtube_channels` | curator / session channels via YouTube RSS, video IDs included | channel handles |
| `bandcamp` | newest releases per Bandcamp tag | nothing |
| `deezer` | newest albums of your profile artists + editorial new releases | nothing |
| `radio` | recent KEXP plays (API) and SomaFM channel logs, profile-matched | nothing |
| `listenbrainz_playlists` | ListenBrainz Weekly Exploration / Weekly Jams (collaborative filtering) | a ListenBrainz username with your Last.fm history imported |
| `rss` | 40+ blogs and radio shows; `Artist – "Song"` and `Artist shares new single "Song"` headlines become cards, news never does (`discovery/headlines.py`) | nothing |
| `spotify` | off; Spotify's API is no longer viable | Premium + dev app |

The three artist-watch sources (`ytmusic_artists`, `deezer`, `musicbrainz_artists`) share one pool: the profile
artists of the `kinds` each lists — `direct` (you play them), `similar` (their neighbours on Last.fm and
ListenBrainz) and `genre` (the acts Last.fm ranks highest under the genres you play). That pool is what the feed is
made of; no source watches record labels.

## Tuning

Everything lives in `discovery/config.yaml`:

- `profile.tag_boosts` / `tag_penalties` — push genres up or down.
- `profile.seed_artists` — hand-add artists Last.fm under-counts.
- `profile.expand_top_n` / `similar_per_artist` — how many of your artists get expanded into neighbours, and how
  many each contributes; `genre_top_tags` / `genre_artists_per_tag` / `genre_weight` — how many genres seed artists
  from Last.fm's tag charts, how deep, and how much that counts. Together these set how big the pool the artist
  watch rotates through is (⚙ and the feed's header line both show the counts).
- `backfill` — how the thin days are filled: `years` how far back the artist watch reaches (0 turns it off),
  `target` how many playable current cards a day should hold before anything older is used, `max` the most older
  cards one day may carry, `candidates` how many are carried into YouTube resolution. Older cards say
  "filling in from &lt;year&gt;" and file into their own year.
- `resolve.audio_heals_per_run` / `audio_recheck_days` — how many cards that still play a video are asked for their
  audio track a run, and how often each is asked again.
- `videos` — the Video tab's list: `lookups_per_run` playlist rows asked for their video side in the Videos
  workflow, `feed_lookups_per_run` cards asked as the daily resolver runs, `recheck_days` before a song with no video
  is asked again, `time_budget_minutes` for the workflow, `in_daily` / `job_budget_minutes` for the rewrite at the end
  of the daily job; `youtube_music.videos_playlist_id` is the one playlist approved videos go to.
- `ranking.max_items` — how many songs a day holds (500), cut by score after the backfill (keep it clear of
  `backfill.target` + `backfill.max`).
- `resolve.min_length` / `max_length` — the song-length range (1:55–9:31): shorter is an interlude, longer a mix,
  neither is a card; `resolve.max_ytmusic_date_lookups_per_run` — how many undated tracks a run ask YouTube Music
  for the upload's own release date.
- `ranking.fresh_days` — what counts as the current timeframe (this calendar year always does);
  `max_unknown_per_source` — how many acts the profile does not know one source family may put in a day before it
  is pushed down.
- `resolve.retry_misses_days` — how long a song with no YouTube Music audio track waits before it is looked up again.
- `sources.*.tags` — the Bandcamp and MusicBrainz genre lists (this replaces the "Edge of <genre>" playlists).
- `sources.rss.feeds` — add any blog/radio RSS; headlines like `Artist – "Song"` or `Artist shares "Song"` become
  playable cards. Tour dates, interviews, listicles, obituaries and the rest are dropped by `discovery/headlines.py`
  (its `NEWS` pattern is the place to add a cue if a kind of post still slips through).
- `ranking.weights` — how much artist affinity vs. tags vs. editorial picks vs. freshness vs. what you kept matter;
  `freshness_days` is how long a release keeps its freshness bonus, `undated_freshness` what a dateless item gets.
- `learn` — the outcome learning: `grace_days` before a shown track is judged, `pass_weight` for tracks never filed,
  `prior` pseudo-observations before a source or tag moves anything, `min_exposures`, `max_adjust`.
- `profile.everynoise_genres` + `python -m discovery seed-everynoise` — harvest the frozen Everynoise genre pages
  as one-time seed artists (commit `data/seeds_everynoise.json`).

Run locally:

```bash
pip install --require-hashes -r discovery/requirements.lock   # exact versions, same as the daily job
export LASTFM_API_KEY=...
python -m discovery profile      # once, then every few days automatically
python -m discovery build        # writes site/data/feed.json + site/feed.xml
python -m discovery catalog      # writes site/data/catalog.json (the earlier years, from Last.fm history)
python -m discovery concerts     # writes site/data/concerts.json (shows near Detroit by the artists played this year)
npm install && npm run serve     # builds dist/ from site/src and serves it at http://localhost:8000

pip install ruff pytest && ruff check discovery tests && python -m pytest tests   # lint + offline tests
npm run check && npm test        # eslint + type check (tsc --checkJs) + build, then the Playwright smoke test
```

The site's JavaScript lives in `site/src/` as ES modules (`state`, `auth`, `sync`, `youtube`, `rating`, `feed`,
`render`, `player`, `rank` (the personal ranking), `stats`, `dupes` (the Cleanup tab), `concerts` (the Concerts tab), `videos` (the Video tab), `editions` (which edition of a song a title is), `audit` (the playability audit), `settings`, `keys`, `theme`, `main`); the Python side is
`discovery/build.py` (the feed), `discovery/catalog.py` (the earlier years), `discovery/concerts.py` (the concert list), `discovery/videos.py` (the Video tab's list), `discovery/learn.py` (what the playlists teach the
ranking) and `discovery/headlines.py` (which blog posts are songs). `build.mjs` bundles them with esbuild into a content-hashed
`app.<hash>.js`, rewrites `index.html` and `sw.js` to it and copies the rest of `site/` into `dist/`, which is what
both workflows upload to GitHub Pages. Nothing generated is committed. The **CI** workflow runs every check on every
pull request; **Publish site** runs the browser test again before anything reaches GitHub Pages. To bump a Python dependency edit `discovery/requirements.txt`, then regenerate the
lockfile with `cd discovery && pip-compile --generate-hashes --strip-extras -o requirements.lock requirements.txt`
(Dependabot opens that pull request weekly).

**Discover** is scheduled three times a morning — 02:07, 04:29 and 06:47 New York — because GitHub runs cron on a
best-effort queue and routinely holds a job back for hours (a single 06:15 slot started 5h34 late on 2026-09-07 and
4h16 late on 2026-09-08, so there was no feed to read at breakfast). Its `check` job asks whether
`site/data/history/<today>.json` is already on `main`; if it is, the slot stops without doing any work, so a normal
morning is still exactly one build and a slot that was delayed, dropped or killed at the 45-minute timeout is simply
retried by the next one. A push to `discovery/**` and a manual run always build.

A build that does not finish opens (or comments on) one **build-failure** issue — including one killed at the
timeout, which ends as *cancelled* rather than *failed* and used to pass in silence. Meanwhile the site says on the
page that the day's build has not landed yet, keeps checking for it every four minutes and swaps it in when it
arrives; past 36 hours that notice turns into the louder "the daily build has not run since…" banner.

The installable app is `site/manifest.webmanifest` (icons in `site/icons/`, the install-dialog pictures in
`site/screenshots/`) plus `site/sw.js` (network first with a cached fallback for the shell and the feed, a capped
cache for artwork, and a waiting worker the page promotes on *Reload*) and `site/src/pwa.js` (install button, how-to
sheet, shortcuts, foreground refresh). `npm run screenshots` rebuilds the three pictures from `dist/` after a visible
redesign. `npm test` needs a browser: `npx playwright install chromium` once (CI does the same with `--with-deps`).
An environment that preloads one Chromium under `PLAYWRIGHT_BROWSERS_PATH` at a revision Playwright does not pin
is used as it is, so the suite runs there without a download; `PW_CHROMIUM=/path/to/chrome` overrides both. The light/dark switch is `site/theme.js`, a classic script every page loads in `<head>` before the first paint:
it keeps the choice in `localStorage` (`id:theme`), sets `<html data-theme>`, which `style.css` reads through `light-dark()`
tokens, and wires the header buttons; `site/src/theme.js` hooks ⚙ → *Theme* and the `t` key into it.

**Time budget:** GitHub Actions kills the Discover job at its `timeout-minutes` (45), and a killed job commits
nothing — no feed, no caches, the whole day lost. So `daily` gives itself `job.budget_minutes` (36) and hands the
feed whatever the profile build did not use. The feed splits that: fetching the sources gets
`sources.time_budget_minutes` (14) or half of what is left, whichever is smaller, and YouTube resolution plus year
verification get the rest, capped at `resolve.time_budget_minutes` (28). Every slow loop honours its share — the
three artist watches stop mid-batch and leave their rotating cursor exactly where they stopped, the resolver and the
year lookups write their caches every 25 lookups — so a run cut short is not work lost but the next run's starting
point, and a slow catalogue day still publishes a feed. Cache rows nothing has touched for `resolve.cache_keep_days`
are dropped. Run `python -m discovery build` by hand and only the configured windows apply, with no job clock.

## Why these sources (state of the world, Sept 2026)

- Spotify removed new-releases, related-artists, recommendations, audio features and other users' playlists from
  the Web API (Nov 2024 + Feb 2026) and now requires Premium for dev mode. Not viable as a foundation.
- Everynoise stopped receiving data in Dec 2023; the Particle Detector "Edge/Pulse" playlists no longer update.
- ListenBrainz fresh releases + MusicBrainz tags are open data with no key and cover every release in MusicBrainz.
- Bandcamp Discover "new" by tag is where the indie end of your genres actually appears first.
- Deezer's public catalog endpoints (artist albums, related artists, editorial releases) need no key.
- Last.fm still serves `user.getTopArtists`, `artist.getSimilar`, `artist.getTopTags` and `tag.getTopArtists` with
  a free key — the last of these is what puts the acts that define your genres in the profile, so the feed covers
  the scene and not only the names you already play.
- Record labels are deliberately not watched: an imprint is a poor proxy for what you keep (the keep rate on the
  old label watch was well below the feed's), and the artists-and-genres pool covers the same records anyway.
- ytmusicapi searches YouTube Music with no key and adds to playlists with your own browser session.
