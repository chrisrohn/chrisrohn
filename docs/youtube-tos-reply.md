# YouTube API Services — ToS Violations Report V.1 (10 Sep 2026): what changed, and the reply

Google's compliance team sent *ToS Violations Report V.1* for API client **Christopher Rohn**, project
**903191577478**. Three items: two *[Confirm]* questions and one branding violation. This page records what the site
does about each and the reply to send. The facts below are the code's; the compliance overview (every request the
client makes, and why) is in [youtube-api-compliance.md](youtube-api-compliance.md).

## The violation (III.F.2a, branding) and the fix

The report's screenshot shows the source chip on each card reading **YTMUSIC**: the card printed the source's
internal key (`ytmusic`) and the stylesheet uppercases chips. "YT" is an abbreviation of the YouTube name, which the
[branding guidelines](https://developers.google.com/youtube/terms/branding-guidelines) forbid. Several links and
notices also said "YT Music".

Fixed in the site, everywhere a source is named:

| Where | Was | Now |
|---|---|---|
| Source chip on every card, deck card and the now-playing panel | `YTMUSIC` (the raw key) | **YouTube Music**, via one `sourceLabel()` in `site/src/feed.js` that every view uses |
| Source filter chip and the Stats sheet | `Artist watch` / raw key | **YouTube Music** |
| Card link, artist sheet button, Cleanup search link | `YT Music`, `search YT Music` | **YouTube Music**, **search YouTube Music** |
| Player notice, release-year notice | `Open in YT Music`, `the YT Music link` | `Open in YouTube Music`, `the YouTube Music link` |
| SETUP.md architecture diagram | `YT year playlists`, `YT Music` | spelled out |

What the site does not do, and never did: it does not use a YouTube logo, icon, play button or wordmark anywhere. The
only icons are its own (`site/icons`, a monochrome record) and plain line glyphs for play/pause/skip. The chip's red
edge is a plain colour accent on a text label, not a YouTube brand asset. The app's name ("Chris Rohn's New Music")
contains no YouTube reference; the pages say the feed is *for the Indie Discotheque playlists on YouTube Music*,
which the guidelines allow ("works with YouTube"-style references). The embedded player is YouTube's own iframe,
unmodified.

## The two *[Confirm]* items, answered from the code

**III.D.1c — project numbers.** The client uses exactly one Google Cloud project, **903191577478**, for the OAuth
client (Sign in with Google) and the YouTube Data API v3. There is no second project, no server-side key and no other
API client under this name. *(Confirm in the Cloud console before sending: if any other project holds an OAuth client
or an enabled YouTube Data API for this site, list it in the reply.)*

**III.E.4a-g — refresh, update and deletion of API data.** The client is a static page; the only place YouTube API
data ever lives is the signed-in user's own browser (local storage) and, for ratings only, a hidden app-data file in
that user's own Google Drive. Nothing is sent to any server the developer controls, because there is none.

| API data | Fetched | Refreshed | Deleted |
|---|---|---|---|
| Contents of the current year's playlist and the Skipped playlist (video ids only, `playlistItems.list`) | on sign-in | re-read at most every **30 minutes** while the page is open, and again on every sign-in | kept in memory only; gone when the tab closes |
| The exact playlist items holding one video (`playlistItems.list` with `videoId`) | right before an add or removal | never cached: fetched fresh for every action | discarded after the action |
| Video details for the Cleanup tab (`videos.list`: title, channel, duration, views, region restriction) | on a tap, for the copies shown | fetched again on the next tap; not stored | never persisted |
| Playability audit findings (which of the user's own playlist items are deleted, private or region-blocked) | on a tap, per year playlist | a year is not re-audited within **24 hours**; the next audit replaces the year's findings | a finding is removed the moment the track is removed or swapped; the whole set clears with the browser's site data |
| Videos that refused to embed (video id + timestamp) | when the player reports it | retried after **30 days** | pruned after 30 days |
| The user's own keep/skip decisions (video id, artist, title, year) | when the user taps | mirrored to that user's Drive app-data file on change | undone decisions after 30 days, decisions the feed no longer shows after 45 days, device-local ones after a year; the Drive file is deletable by the user (Drive → Settings → Manage apps) |
| OAuth access token | at sign-in | silently re-issued when it is about to lapse | expires after about one hour; removed on sign-out |

Every request is bound to a user action (sign-in, Keep, Undo, a Cleanup tap) or to the 30-minute re-read of the
user's own playlist; there is no background job, crawler or bulk export. The ⚙ → API activity sheet on the site lists
every request as it is made, with its purpose, result and quota cost.

## The reply

Send from the API contact address, quoting the report's subject line.

> Hello,
>
> Thank you for the report (ToS Violations Report V.1, project 903191577478, API client "Christopher Rohn"). Each
> item, in the report's order:
>
> **III.D.1c — project numbers.** The API client uses one Google Cloud project only: **903191577478**. It holds the
> OAuth client for Sign in with Google and the YouTube Data API v3 enablement. There is no other project, key or
> client for this application.
>
> **III.E.4a-g — refreshing, updating and deleting API data.** The client is a static web page
> (https://chrisrohn.com) with no server; every YouTube Data API request goes from the signed-in user's browser to
> Google with that user's own OAuth token, and the only API data it holds is in that user's browser:
>
> - The list of video ids in the user's current year playlist (and their "Skipped" playlist) is read on sign-in and
>   re-read at most every 30 minutes while the page is open, so tracks already saved are hidden and never added
>   twice. It is held in memory only and is gone when the tab closes.
> - Before any add or removal the client re-reads, with `playlistItems.list` and a `videoId`, exactly which items
>   hold that video. This is never cached.
> - Video details (`videos.list`) for the Cleanup tab are fetched on a tap and are not stored.
> - Playability audit findings for the user's own playlists are kept on that device for the user to act on; a year
>   is not re-audited within 24 hours, the next audit replaces the findings, a finding is removed the moment the
>   track is removed or swapped, and the set clears with the browser's site data.
> - The user's own keep/skip decisions are pruned automatically (undone decisions after 30 days, decisions for
>   tracks no longer shown after 45 days, device-local decisions after a year) and mirrored only to a hidden
>   app-data file in the user's own Google Drive, which the user can delete at any time.
> - OAuth tokens expire after about an hour and are removed on sign-out.
>
> Every request is tied to a user action or to that 30-minute re-read; there is no background collection, no bulk
> download and nothing is transmitted to any server of ours. The site's own "API activity" view (⚙ → API activity)
> shows each request as it happens with its purpose, result and quota cost.
>
> **III.F.2a — branding.** The label in your screenshot ("YTMUSIC") was the source's internal identifier printed on
> the card and uppercased by the stylesheet. That was wrong and is fixed: every place the site names the source now
> reads "YouTube Music" in full (the card chips, the filter chips, the statistics view, links, buttons and notices),
> and "YT" no longer appears anywhere in the user interface or documentation. The application does not use a YouTube
> logo, icon, play button or other brand asset anywhere; its icons are its own, the embedded player is YouTube's
> unmodified iframe, and the application's name contains no YouTube reference. The change is live at
> https://chrisrohn.com and public in the source repository (https://github.com/chrisrohn/chrisrohn).
>
> Please let me know if anything further is needed.
>
> Christopher Rohn
