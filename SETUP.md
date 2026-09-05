# Indie Discotheque discovery feed — setup

Everything here is free. Total setup is about 20 minutes, most of it DNS propagation.

## What you are building

```
GitHub Actions (daily 06:15 ET)                        chrisrohn.com (GitHub Pages, public)
┌──────────────────────────────────────┐               ┌───────────────────────────────────────┐
│ profile: Last.fm tt_discotheque      │               │ anyone: listen, filter by source, Picks│
│   + your public YT year playlists    │   feed.json   │                                       │
│   + Last.fm & ListenBrainz similar   │ ────────────▶ │ you (Sign in with Google):            │
│ sources: ListenBrainz fresh releases │               │   👍 → "<year> | Indie Discotheque"      │
│   MusicBrainz tags · Bandcamp new    │               │   👎 → unlisted "Skipped" playlist     │
│   Deezer artist releases · blog RSS  │               │   (YouTube Data API, from your browser)│
│ score → resolve on YouTube Music     │               └───────────────────────────────────────┘
│ hides anything already in those      │ ◀── reads your playlists (public + unlisted-by-id) ──┘
│ playlists                            │
└──────────────────────────────────────┘
```

No database, no server, no GitHub tokens: your YouTube playlists *are* the state. The daily job only builds the
feed; the only thing that ever writes to a playlist is you pressing a thumb while signed in.

## 1. GitHub (required)

1. Merge this branch to `main`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Settings → Actions → General → Workflow permissions: Read and write permissions.**
4. **Settings → Secrets and variables → Actions → New repository secret**: `LASTFM_API_KEY` from
   https://www.last.fm/api/account/create (instant, free, any app name). That is the only secret.
5. **Actions → Discover → Run workflow.** First run takes ~10–15 min (profile build + MusicBrainz rate limit).

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

## 3. Sign in with Google (so 👍/👎 reach your playlists)

One free Google Cloud OAuth client, created in the browser with a **personal** Google account. Everything after
that is a normal "Sign in with Google" button on the site.

1. https://console.cloud.google.com/projectcreate → name it `indie-discotheque` → Create.
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
   account that owns the playlists. Commit (GitHub's web editor is fine). The next Discover run ships it in feed.json.

On the site, click **Sign in with Google**, pick that account, allow "manage your YouTube account". The thumbs
appear. Sessions last an hour; the button re-prompts (usually a silent popup) when needed.

**Quota:** YouTube's free API quota is 10,000 units/day (reset midnight Pacific); each write costs 50. Only 👍
spends quota, so you get ~200 *saves* a day, and ⚙ shows a running meter. 👎 is free: skips are remembered in the
browser and expire with the feed. Listening, filtering and playback cost nothing.

**Optional – skips on YouTube too:** switch on **⚙ → Also file 👎 into the Skipped playlist** if you rate from
several devices and want skips shared. The first 👎 then creates an unlisted `Indie Discotheque – Skipped`
playlist and shows its ID; paste it into `config.yaml` → `youtube_music.skipped_playlist_id` so the daily build
can read it (unlisted playlists aren't discoverable by title). Year playlists are public and found automatically.
If you ever need more than 200 writes a day, Google grants quota increases for personal projects through the
YouTube API quota extension form in the Cloud console (free).

## Public vs. curator

chrisrohn.com is public: anyone can browse, filter by source, play tracks and see **Picks** (the newest tracks in
your current-year playlist). Nothing on the public side can write anywhere.

**Curator mode** appears when the signed-in Google account is in `google.curators`: thumbs file into the
`<year> | Indie Discotheque` playlists. **Guests** are off by default: other Google accounts can sign in but get a listen-only site. Flip
`google.guests: true` (your ⚙ panel links straight to the line) and they can rate too, with their 👍 going into
`<year> Picks from chrisrohn.com` playlists in *their own* library, never yours. Everyone who signs in
shares the project's daily YouTube API quota. Nothing about the site can touch a playlist except through a Google
session that the playlist's owner approved in that browser.

## Daily use

- Open chrisrohn.com. `j`/`k` move, `space` plays, `u` thumbs up, `d` thumbs down, `o` opens in YouTube Music, `/` searches.
- Change the year dropdown on a card before thumbing up if a reissue/late release should go to another year.
- 👍 files the track into the year playlist immediately (an **Undo** button shows for a few seconds). 👎 hides
  it. Both disappear from the feed at once on every device: ratings are mirrored to a hidden app-data file in your
  Google Drive (free, no quota), pulled when you open the site or return to the tab and pushed after each thumb.
- **Audition mode** (`a`, or the checkbox in the player bar): each track starts partway in and the site moves on by
  itself after 30 seconds unless you press a key or click the player. Length and start point are in ⚙.
- **On a phone**, open chrisrohn.com and choose "Add to Home Screen" / "Install app": it runs full-screen with its
  own icon. Swipe a card right for 👍, left for 👎 (curator or guest mode only).
- Subscribe to `https://chrisrohn.com/feed.xml` in any RSS reader for the same list.

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
| `rss` | 40+ blogs and radio shows; `Artist – "Song"` headlines become cards | nothing |
| `spotify` | off; Spotify's API is no longer viable | Premium + dev app |

## Tuning

Everything lives in `discovery/config.yaml`:

- `profile.tag_boosts` / `tag_penalties` — push genres up or down.
- `profile.seed_artists` — hand-add artists Last.fm under-counts.
- `sources.*.tags` — the Bandcamp and MusicBrainz genre lists (this replaces the "Edge of <genre>" playlists).
- `sources.rss.feeds` — add any blog/radio RSS; headlines like `Artist – "Song"` become playable cards.
- `ranking.weights` — how much artist affinity vs. tags vs. editorial picks vs. freshness matter.
- `profile.everynoise_genres` + `python -m discovery seed-everynoise` — harvest the frozen Everynoise genre pages
  as one-time seed artists (commit `data/seeds_everynoise.json`).

Run locally:

```bash
pip install -r discovery/requirements.txt
export LASTFM_API_KEY=...
python -m discovery profile      # once, then every few days automatically
python -m discovery build        # writes site/data/feed.json + site/feed.xml
python -m http.server -d site    # http://localhost:8000
python -m pytest tests           # offline tests
```

## Why these sources (state of the world, Sept 2026)

- Spotify removed new-releases, related-artists, recommendations, audio features and other users' playlists from
  the Web API (Nov 2024 + Feb 2026) and now requires Premium for dev mode. Not viable as a foundation.
- Everynoise stopped receiving data in Dec 2023; the Particle Detector "Edge/Pulse" playlists no longer update.
- ListenBrainz fresh releases + MusicBrainz tags are open data with no key and cover every release in MusicBrainz.
- Bandcamp Discover "new" by tag is where the indie end of your genres actually appears first.
- Deezer's public catalog endpoints (artist albums, related artists, editorial releases) need no key.
- Last.fm still serves `user.getTopArtists`, `artist.getSimilar`, `artist.getTopTags` with a free key.
- ytmusicapi searches YouTube Music with no key and adds to playlists with your own browser session.
