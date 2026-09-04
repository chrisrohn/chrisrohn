# Indie Discotheque discovery feed — setup

Everything here is free. Total setup is about 20 minutes, most of it DNS propagation.

## What you are building

```
GitHub Actions (daily 06:15 ET)                       chrisrohn.com (GitHub Pages)
┌──────────────────────────────────────┐              ┌──────────────────────────────┐
│ profile: Last.fm tt_discotheque      │              │ feed: listen inline, 👍 / 👎  │
│   + your YT Music year playlists     │  feed.json   │ queue: unsynced thumbs        │
│   + Last.fm & ListenBrainz similar   │ ───────────▶ │ archive: everything rated     │
│ sources: ListenBrainz fresh releases │              └──────────────┬───────────────┘
│   MusicBrainz tags · Bandcamp new    │                             │ "Sync approvals"
│   Deezer artist releases · blog RSS  │   repository_dispatch       │ (you press it)
│ score → resolve on YouTube Music     │ ◀───────────────────────────┘
└──────────────────────────────────────┘
        │  Decisions workflow: 👍 → "<year> Indie Discotheque" playlist, 👎 → archive
        ▼
   data/decisions.json (the archive)   — no database service needed; the repo is the database
```

Nothing is ever written to a playlist by the daily job. Only tracks you thumbed up **and** synced are filed,
into the year playlist you chose on the card (defaults to the release year, 1979–2026 all supported).

## 1. GitHub (required)

1. Merge this branch to `main`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Settings → Actions → General → Workflow permissions: Read and write permissions.**
4. **Settings → Secrets and variables → Actions → New repository secret**:

   | Secret | Required | Where to get it |
   |---|---|---|
   | `LASTFM_API_KEY` | yes | https://www.last.fm/api/account/create — instant, free. Any app name. |
   | `YTMUSIC_OAUTH_CLIENT_ID`, `YTMUSIC_OAUTH_CLIENT_SECRET`, `ADMIN_PAT` | for filing 👍 into playlists | step 3 below (all in the browser, no install) |
   | `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | no (source is off) | needs Premium since Feb 2026; skip |

5. **Actions → Discover → Run workflow.** First run takes ~10–15 min (profile build + MusicBrainz rate limit).
   The site is live at `https://chrisrohn.github.io/chrisrohn/` until DNS is done.

## 2. chrisrohn.com DNS (required for the custom domain)

At your registrar, add:

| Type | Name | Value |
|---|---|---|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| CNAME | `www` | `chrisrohn.github.io` |

Then **Settings → Pages → Custom domain: `chrisrohn.com`** → Save → tick **Enforce HTTPS** once the check passes
(`site/CNAME` already contains the domain, so deploys keep it). Docs: https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site

## 3. Connect YouTube Music (so 👍 lands in your year playlists)

Everything happens in a browser; nothing is installed and no developer console is needed. Use a **personal**
Google account (a work/school account may be blocked from Google Cloud).

**a. Create a free Google OAuth client (5 minutes, once)**

1. https://console.cloud.google.com/projectcreate → name it `indie-discotheque` → Create.
2. https://console.cloud.google.com/apis/library/youtube.googleapis.com → **Enable** (YouTube Data API v3).
3. https://console.cloud.google.com/apis/credentials/consent → External → fill App name + your email → Save.
   Under **Audience → Test users** add your own Google email. (Leave the app in "Testing"; that's fine for one user.)
4. https://console.cloud.google.com/apis/credentials → **Create credentials → OAuth client ID** →
   Application type **TVs and Limited Input devices** → Create. Copy the **Client ID** and **Client secret**.

**b. Store them + an admin token as repo secrets** (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `YTMUSIC_OAUTH_CLIENT_ID` | the Client ID |
| `YTMUSIC_OAUTH_CLIENT_SECRET` | the Client secret |
| `ADMIN_PAT` | a fine-grained GitHub token for this repo with **Secrets: Read and write** (https://github.com/settings/personal-access-tokens/new). Lets the workflow save the sign-in result as a secret. |

**c. Sign in**

1. **Actions → Connect YouTube Music → Run workflow.**
2. Open the running job. The **Summary** (and the log) shows: *Open google.com/device and enter code XXXX-XXXX.*
3. On your phone or any browser go to https://www.google.com/device, enter the code, pick the Google account that
   owns the playlists, click **Continue/Allow**. (Google warns the app is unverified because it's your own; continue.)
4. The job finishes with "Saved as repository secret YTMUSIC_OAUTH_JSON. You're connected."

Tokens from a "Testing" OAuth app expire after 7 days; publish the consent screen (**Audience → Publish app**, no
verification needed for this scope) and the token refreshes itself indefinitely. If approvals ever show
"pending" in the Archive, just run **Connect YouTube Music** again.

Alternative without Google Cloud: if you *can* open DevTools somewhere, paste the request headers from a
`browse?` POST on music.youtube.com into a `YTMUSIC_HEADERS_RAW` secret instead (Network tab → Request Headers).

Playlists are matched by title: `<year> Indie Discotheque` in your library. The three IDs in
`discovery/config.yaml` are only a fallback.

## 4. Site token (so the Sync button can reach GitHub)

The site runs in your browser and needs a token to trigger the Decisions workflow:

1. https://github.com/settings/personal-access-tokens/new → **Fine-grained**.
2. Repository access: **Only select repositories → chrisrohn/chrisrohn**.
3. Repository permissions: **Contents: Read and write** (that is what `repository_dispatch` needs). Nothing else.
4. On the site: ⚙ → paste the token. It is stored only in that browser's localStorage.

Without a token you can still rate everything and use **Export queue as CSV (Soundiiz)** from ⚙.

## Daily use

- Open chrisrohn.com. `j`/`k` move, `space` plays, `u` thumbs up, `d` thumbs down, `o` opens in YouTube Music, `/` searches.
- Change the year dropdown on a card before thumbing up if a reissue/late release should go to another year.
- Press **Sync approvals** whenever you like (end of a session is fine). Confirm the list. Within ~3 minutes the
  tracks are in your playlists, the feed rebuilds without them, and they appear under **Archive**.
- Subscribe to `https://chrisrohn.com/feed.xml` in any RSS reader for the same list.

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
