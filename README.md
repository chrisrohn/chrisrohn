## Hi there

**[Chris Rohn's New Music](https://chrisrohn.com)** — a daily new-music discovery feed where I find tracks to add to
the Indie Discotheque library playlists on YouTube Music. Built from Last.fm ([tt_discotheque](https://www.last.fm/user/tt_discotheque)),
ListenBrainz, MusicBrainz, Bandcamp, Deezer and music blogs. Sign in with Google, keep or skip tracks, and
approvals land in the matching `<year> | Indie Discotheque` playlist.

- Site: [chrisrohn.com](https://chrisrohn.com) · RSS: [chrisrohn.com/feed.xml](https://chrisrohn.com/feed.xml)
- How it works and how to set it up: [SETUP.md](SETUP.md)
- Pipeline: [`discovery/`](discovery) · Site: [`site/`](site) · Workflows: [`.github/workflows/`](.github/workflows)
- It learns: every keep and skip teaches the site (and, via the playlists, the daily build) which sources, blogs, tags and artists you actually keep, without spending YouTube API quota; the Feed opens on a shortlist of the top 60, ⚙ → *Stats* shows the keep rates, and the *Skipped* tab restores anything thumbed down
- Light or dark: the ☀/☾ button in the header (or ⚙ → *Theme*, or the `t` key) pins either set or follows the device; the choice is remembered on that device and applies to the Privacy and Terms pages too
- Installable: on a phone tap **Install** (or ⚙ → *Install as an app*) for a full-screen app that works offline, with lock-screen controls and home-screen shortcuts; desktop Chrome, Edge and Safari install it from the header button
- Checks: `ruff check discovery tests`, `python -m pytest tests`, `npm run check` (eslint, tsc, build) and `npm test` (Playwright smoke test of the built site, including the installable-app checks) — all run in CI on every pull request
