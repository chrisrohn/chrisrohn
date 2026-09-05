# Chris Rohn's New Music — setup

Everything here is free. Total setup is about 20 minutes, most of it DNS propagation.

## What you are building

```
GitHub Actions (daily 06:15 ET)                        chrisrohn.com (GitHub Pages, public)
┌──────────────────────────────────────┐               ┌───────────────────────────────────────┐
│ profile: Last.fm tt_discotheque      │               │ anyone: listen, filter by source, Picks│
│   + your public YT year playlists    │   feed.json   │                                       │
│   + Last.fm & ListenBrainz similar   │ ────────────▶ │ you (Sign in with Google):            │
│ sources: ListenBrainz fresh releases │               │   keep → "<year> | Indie Discotheque" │
│   MusicBrainz tags · Bandcamp new    │               │   skip → unlisted "Skipped" playlist  │
│   Deezer artist releases · blog RSS  │               │   (YouTube Data API, from your browser)│
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
   strongest source for original release dates of disco/electronic records.
5. **Actions → Discover → Run workflow.** Afterwards: merging a change to `site/` publishes in about a minute
   (the *Publish site* workflow); merging a change to `discovery/` runs the full data build first, 20–30 min.
   Feed data refreshes on the daily schedule or a manual Discover run.
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

Every year found is kept as evidence (hover the year badge on the site to see it). The earliest year from the most
trusted tier wins: ✓ = catalogue-verified, plain = a store/source date, ? = weak hint. If nothing anywhere says when
a song came out the card shows `year?` and Keep refuses until you pick, so a catalogue track can't slip into this
year's playlist by default. Lookups are cached and budgeted per run (`resolve.max_year_lookups_per_run`; MusicBrainz
allows 1 request/s), undated tracks first.

**Sessions:** Google access tokens last an hour; the site renews them silently on your next tap, so you stay signed in
for as long as your Google session lasts. Signing out only forgets that device. To disconnect the site from your
Google account entirely use https://myaccount.google.com/permissions.

**No duplicates:** every Keep first asks YouTube whether that video is already in the target playlist (1 quota unit)
and skips the add if so. The daily build scans all year playlists for the exact same video appearing twice in a
year or in two different years — a different upload of the same song is deliberately not counted (full report in
`site/data/duplicates.json`). The site warns you on load; ⚙ → Duplicate check
filters by kind, year and name, removes copies one tap at a time or all extra same-video copies in a year at once
(quota-aware: 50 units per removal), marks the wrong-year copy where the catalogues verified the original year, and
offers a live "scan this year now" for anything added since the last build.
If you ever need more than 200 writes a day, Google grants quota increases for personal projects through the
YouTube API quota extension form in the Cloud console (free).

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

- Open chrisrohn.com. `j`/`k` move, `space` plays, `u` thumbs up, `d` thumbs down, `o` opens in YouTube Music, `/` searches.
- Change the year dropdown on a card before thumbing up if a reissue/late release should go to another year.
- **Keep** files the track into the year playlist immediately (an **Undo** button shows for a few seconds). **Skip** hides
  it. Both disappear from the feed at once on every device: ratings are mirrored to a hidden app-data file in your
  Google Drive (free, no quota), pulled when you open the site or return to the tab and pushed after each thumb.
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
  `+N` next to the deck counter, lifts it for the visit. A search or another sort always shows everything.
- **It learns from you, without API quota.** Every keep and skip remembers the card's sources, blogs, tags and artist.
  The site works out a keep rate for each against your overall rate and nudges the scores (the number on the card
  hovers to show `build score ± learned`), so a blog you keep from floats up and one you skip through sinks; tracks
  left unrated for three days count as a weak pass. It travels with the Drive mirror, so every device agrees.
  The daily build does the same from the other side: `site/data/history/` records what each feed showed, and
  three days later anything that reached a year playlist counts as kept, the Skipped playlist as skipped (only when
  skips are filed on YouTube), the rest as a weak pass — `discovery/learn.py`, tuned under `learn:` in config.yaml
  and weighted by `ranking.weights.learned`. Cards say why: "you keep 71% from KEXP", "you rarely keep hip hop".
- **Skipped** tab: what you thumbed down from this feed, newest first, with **restore** (an Undo that no longer needs
  the toast; a skip filed on YouTube costs 50 units to take back). **Stats** (⚙ → *Stats*): keeps and skips by week,
  keep rate by source and tag, most-kept artists, and what the build has learned so far.
- A tag chip or an artist name on a card is a filter (it lands in the search box). The **link** control on a card
  copies its own address (`/?t=<id>`), which opens the site on that card; the RSS items carry the same link.
- A video YouTube refuses to embed here (removed, or the owner blocks embedding) is remembered for a month: the card
  stays, marked *no embed*, and autoplay steps over it.
- **Catalog** tab — filling the earlier years. The daily job also builds `site/data/catalog.json` from your own
  Last.fm history: the tracks you have played most and the ones you loved but never filed, then the top tracks of
  the artists you play and of their similar artists (what is adjacent). Anything a year playlist or the Skipped
  playlist already holds is hidden; the rest is resolved on YouTube Music and given a verified release year in daily
  batches on the feed's caches, so the tab fills in over a couple of weeks and then keeps pace with your listening.
  The year select shows every playlist year with how many tracks it holds and how many candidates wait, so the
  thin years are easy to work through; each Keep files into the verified year (or asks when none was found). Plays,
  loved, your keeps and skips all rank it; the shortlist, search, source chips and the phone deck work as in the
  feed. Tuning is under `catalog:` in config.yaml (candidate counts, per-run lookup budgets, its share of the job's
  time after the feed). Nothing here spends YouTube API quota; the Last.fm key is the only one it needs.
- Subscribe to `https://chrisrohn.com/feed.xml` in any RSS reader for the same list (with release dates, artwork and
  tags; the internal score stays internal).

## Sources

All in `discovery/config.yaml → sources`, each with an `enabled` switch. Per-feed health shows under ⚙ on the site.

| Source | What it finds | Needs |
|---|---|---|
| `listenbrainz_fresh` | every release MusicBrainz knows from the last N days, filtered by your artists/tags | nothing |
| `musicbrainz_tags` | recent releases tagged with your genres, from artists you've never heard of | nothing |
| `musicbrainz_labels` | everything your trusted labels released this window | nothing |
| `ytmusic_artists` | new singles/albums of your top artists straight from YouTube Music (the old Release Radar) | nothing |
| `youtube_channels` | label / curator / session channels via YouTube RSS, video IDs included | channel handles |
| `bandcamp` | newest releases per Bandcamp tag | nothing |
| `deezer` | newest albums of your top artists + editorial new releases | nothing |
| `radio` | recent KEXP plays (API) and SomaFM channel logs, profile-matched | nothing |
| `listenbrainz_playlists` | ListenBrainz Weekly Exploration / Weekly Jams (collaborative filtering) | a ListenBrainz username with your Last.fm history imported |
| `rss` | 40+ blogs and radio shows; `Artist – "Song"` and `Artist shares new single "Song"` headlines become cards, news never does (`discovery/headlines.py`) | nothing |
| `spotify` | off; Spotify's API is no longer viable | Premium + dev app |

## Tuning

Everything lives in `discovery/config.yaml`:

- `profile.tag_boosts` / `tag_penalties` — push genres up or down.
- `profile.seed_artists` — hand-add artists Last.fm under-counts.
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
npm install && npm run serve     # builds dist/ from site/src and serves it at http://localhost:8000

pip install ruff pytest && ruff check discovery tests && python -m pytest tests   # lint + offline tests
npm run check && npm test        # eslint + type check (tsc --checkJs) + build, then the Playwright smoke test
```

The site's JavaScript lives in `site/src/` as ES modules (`state`, `auth`, `sync`, `youtube`, `rating`, `feed`,
`render`, `player`, `rank` (the personal ranking), `stats`, `dupes`, `settings`, `keys`, `theme`, `main`); the Python side is
`discovery/build.py` (the feed), `discovery/catalog.py` (the earlier years), `discovery/learn.py` (what the playlists teach the
ranking) and `discovery/headlines.py` (which blog posts are songs). `build.mjs` bundles them with esbuild into a content-hashed
`app.<hash>.js`, rewrites `index.html` and `sw.js` to it and copies the rest of `site/` into `dist/`, which is what
both workflows upload to GitHub Pages. Nothing generated is committed. The **CI** workflow runs every check on every
pull request; **Publish site** runs the browser test again before anything reaches GitHub Pages. To bump a Python dependency edit `discovery/requirements.txt`, then regenerate the
lockfile with `cd discovery && pip-compile --generate-hashes --strip-extras -o requirements.lock requirements.txt`
(Dependabot opens that pull request weekly). If a daily build fails, the workflow opens a **build-failure** issue and
the site shows a banner once the feed is more than 36 hours old.

The installable app is `site/manifest.webmanifest` (icons in `site/icons/`, the install-dialog pictures in
`site/screenshots/`) plus `site/sw.js` (network first with a cached fallback for the shell and the feed, a capped
cache for artwork, and a waiting worker the page promotes on *Reload*) and `site/src/pwa.js` (install button, how-to
sheet, shortcuts, foreground refresh). `npm run screenshots` rebuilds the three pictures from `dist/` after a visible
redesign. The light/dark switch is `site/theme.js`, a classic script every page loads in `<head>` before the first paint:
it keeps the choice in `localStorage` (`id:theme`), sets `<html data-theme>`, which `style.css` reads through `light-dark()`
tokens, and wires the header buttons; `site/src/theme.js` hooks ⚙ → *Theme* and the `t` key into it.

**Time budget:** YouTube resolution and year verification share `resolve.time_budget_minutes` (28 by default, against
the job's 45-minute limit) and write their caches every 25 lookups, so a slow catalogue day leaves the rest for
tomorrow instead of losing the run. Cache rows nothing has touched for `resolve.cache_keep_days` are dropped.

## Why these sources (state of the world, Sept 2026)

- Spotify removed new-releases, related-artists, recommendations, audio features and other users' playlists from
  the Web API (Nov 2024 + Feb 2026) and now requires Premium for dev mode. Not viable as a foundation.
- Everynoise stopped receiving data in Dec 2023; the Particle Detector "Edge/Pulse" playlists no longer update.
- ListenBrainz fresh releases + MusicBrainz tags are open data with no key and cover every release in MusicBrainz.
- Bandcamp Discover "new" by tag is where the indie end of your genres actually appears first.
- Deezer's public catalog endpoints (artist albums, related artists, editorial releases) need no key.
- Last.fm still serves `user.getTopArtists`, `artist.getSimilar`, `artist.getTopTags` with a free key.
- ytmusicapi searches YouTube Music with no key and adds to playlists with your own browser session.
