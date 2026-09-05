## Hi there 👋

🪩 **[Chris Rohn's New Music](https://chrisrohn.com)** — a daily new-music discovery feed where I find tracks to add to
the Indie Discotheque library playlists on YouTube Music. Built from Last.fm ([tt_discotheque](https://www.last.fm/user/tt_discotheque)),
ListenBrainz, MusicBrainz, Bandcamp, Deezer and music blogs. Sign in with Google, thumb tracks up or down, and
approvals land in the matching `<year> | Indie Discotheque` playlist.

- Site: [chrisrohn.com](https://chrisrohn.com) · RSS: [chrisrohn.com/feed.xml](https://chrisrohn.com/feed.xml)
- How it works and how to set it up: [SETUP.md](SETUP.md)
- Pipeline: [`discovery/`](discovery) · Site: [`site/`](site) · Workflows: [`.github/workflows/`](.github/workflows)
- Checks: `ruff check discovery tests`, `python -m pytest tests`, `npm run check` (eslint, tsc, build) and `npm test` (Playwright smoke test of the built site) — all run in CI on every pull request
