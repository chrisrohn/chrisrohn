## Hi there

**[Chris Rohn's New Music](https://chrisrohn.com)** — a daily new-music discovery feed where I find tracks to add to
the Indie Discotheque library playlists on YouTube Music. It follows what my Last.fm
([tt_discotheque](https://www.last.fm/user/tt_discotheque)) history says I listen to: those artists, the artists
next to them, and the acts that define the genres they sit in — watched for new releases on YouTube Music, Deezer
and MusicBrainz, and rounded out by ListenBrainz, Bandcamp, radio and music blogs. Sign in with Google, keep or skip
tracks, and approvals land in the matching `<year> | Indie Discotheque` playlist.

- Site: [chrisrohn.com](https://chrisrohn.com) · RSS: [chrisrohn.com/feed.xml](https://chrisrohn.com/feed.xml)
- How it works and how to set it up: [SETUP.md](SETUP.md)
- Pipeline: [`discovery/`](discovery) · Site: [`site/`](site) · Workflows: [`.github/workflows/`](.github/workflows)
- A quiet day is not a short day: when the current timeframe has too little to show, the feed reaches back through
  the last few years of those same artists' catalogues, marks each card *filling in from &lt;year&gt;* and files it
  into its own year
- A feed by breakfast: the build is scheduled three times a morning (02:07, 04:29 and 06:47 ET) because GitHub's
  cron queue can hold a job back for hours, and every slot after the one that publishes the day stops without
  working. Until it lands the site says so rather than showing an empty list, checks for it every few minutes and
  swaps it in by itself
- **⚙ → API activity**: every YouTube Data API request the browser makes, as it happens, with what it was for (verify a playlist's contents, add the approved track, remove one taken back), its result and quota cost, exportable as text or JSON; [docs/youtube-api-compliance.md](docs/youtube-api-compliance.md) turns it into the screencast Google's quota reviewers ask for
- A **Cleanup** tab for the year playlists: every song held more than once — the same video twice, the same song in two years, two uploads of it (audio track and video), two editions of it (original and remix, radio edit and extended mix) — with every copy laid out to compare (edition, length, album, plays, whether it plays here), played in place, kept, removed or moved to another year (the catalogue-verified year marked); a **playability audit** that asks YouTube which tracks cannot play in the US at all (deleted, private, region-blocked) and finds playable replacements, overnight for free or on the spot; paced by the API quota and remembered across devices
- Audio-only where YouTube Music has it: the resolver prefers the audio track over the video and the original issue over a deluxe edition
- Earlier years too: the **Catalog** tab draws on the Last.fm history (most played, loved, your artists' and their neighbours' best-known tracks), hides what the playlists already hold, verifies each track's release year, and lets you fill the thin years one Keep at a time
- It learns: every keep and skip teaches the site (and, via the playlists, the daily build) which sources, blogs, tags and artists you actually keep, without spending YouTube API quota; the Feed opens on a shortlist of the top 60, ⚙ → *Stats* shows the keep rates, and the *Skipped* tab restores anything thumbed down
- A third verdict, **≠ wrong video** (`x`), for a card whose YouTube match plays something other than the title it shows: it hides the card without judging the song and sends the daily build back to find another upload — the card returns as soon as one is paired
- Light or dark: the ☀/☾ button in the header (or ⚙ → *Theme*, or the `t` key) pins either set or follows the device; the choice is remembered on that device and applies to the Privacy and Terms pages too
- Installable: on a phone tap **Install** (or ⚙ → *Install as an app*) for a full-screen app that works offline, with lock-screen controls and home-screen shortcuts; desktop Chrome, Edge and Safari install it from the header button
- Keeps playing with the screen off or another app in front: phones pause the embed the moment the page is out of sight, and the player asks for the track back (⚙ → *Keep playing in the background*); the lock screen's play button and coming back to the app bring it back too, and a pause you press yourself stays a pause
- Checks: `ruff check discovery tests`, `python -m pytest tests`, `npm run check` (eslint, tsc, build) and `npm test` (Playwright smoke test of the built site, including the installable-app checks) — all run in CI on every pull request
