// Shapes shared by the modules. feed.json is written by discovery/build.py (Item.to_dict + _public_item).
export interface YouTubeMatch { videoId: string | null; thumbnail?: string | null; year?: string | number | null; playlistId?: string | null; album?: string | null }
export interface FeedItem {
  id: string; artist: string; title: string; display?: string; display_title?: string; kind?: string;
  release?: string | null; release_type?: string | null; release_date?: string | null; date_kind?: string;
  tags?: string[]; sources?: string[]; links?: Record<string, string | string[]>; artwork?: string | null; editorial?: boolean;
  year?: number | null; year_source?: string | null; year_confidence?: string | null; year_evidence?: string[]; original_year?: number | null;
  youtube?: YouTubeMatch | null; score: number; reasons?: string[]; matched_artist?: string | null; match_kind?: string | null; first_seen?: string | null;
  backfill?: boolean;   // an older release the build pulled in because the current timeframe was thin
  _pick?: boolean; _year?: string | number | null; _skipped?: boolean;
  plays?: number; loved?: boolean;   // catalog items: Last.fm play count, loved track
}
export interface Catalog { generated_at: string; candidates: number; count: number; undated: number; pending?: number; sources: string[]; years: Record<string, { playlist: number; candidates: number }>; items: FeedItem[] }
export interface LearnedRow { n: number; k: number; rate: number; adj: number }
export interface LearnedSummary { outcomes: number; kept: number; skipped: number; keep_rate: number; since?: string | null; sources: Record<string, LearnedRow>; tags: Record<string, LearnedRow> }
export interface Feed {
  generated_at: string; station: string; site_name?: string; count: number; new_today: number; years?: number[];
  google?: { client_id?: string; curator_hashes?: string[]; curators?: string[]; guests?: boolean; guest_playlist_title_pattern?: string };
  youtube?: { playlist_title_pattern?: string; skipped_playlist_title?: string; playlists?: Record<string, string>; skipped_playlist_id?: string; skips_in_youtube?: boolean;
    duplicates_count?: number; duplicates_kinds?: Record<string, number>; duplicates_checked_at?: string | null;
    unavailable_count?: number; unavailable_with_alt?: number; unavailable_pending?: number; region?: string };
  picks?: Array<{ artist: string; title: string; videoId?: string | null; year?: string; thumbnail?: string | null; album?: string | null }>;
  learned?: LearnedSummary;
  feed_health?: Record<string, { ok: boolean; entries: number; kept: number; error?: string | null }>;
  recent_since?: number;        // the earliest year "new releases only" still counts as recent (the backfill window)
  fresh_playable?: number; backfill?: number; backfill_candidates?: number;   // how much of the day came from the current timeframe, and what filled it
  lastfm_user?: string; repo?: string; profile?: { built_at?: string; counts?: Record<string, number> }; sources?: string[]; blogs?: string[]; items: FeedItem[];
}
export interface Rated {
  // "wrong": the card's YouTube match plays something else — the song itself was not judged; hidden while the build
  // still pairs it with that video, back as soon as the resolver finds another upload
  decision: "up" | "down" | "wrong" | "seen" | "undone"; at: number; year?: number | string; videoId?: string; artist?: string; title?: string;
  playlistItemId?: string; playlistId?: string; pending?: boolean; local?: boolean; duplicate?: boolean;
  queued?: boolean;   // made offline: filed on YouTube the next time the browser is online
  sources?: string[]; tags?: string[];   // what the card carried when it was rated: the personal ranking and the stats learn from these
}
export interface Auth { email?: string; name?: string; picture?: string; hash?: string; access_token?: string; expires_at: number }
/** A playlist row that will not play here: found greyed out by the build's scan (data/unavailable.json) or dead by the tab's audit. */
export interface Unavailable {
  year: string; playlistId: string; videoId: string; position?: number; artist: string; title: string; pending?: boolean;
  alt: { videoId: string; title?: string; album?: string | null; thumbnail?: string | null; videoType?: string } | null;
  why?: string;            // deleted | private | blocked | rejected | greyed (the build's scan)
  found?: "build" | "audit"; at?: number; itemId?: string;   // audit rows: when, and the playlist item to remove without a lookup
}
/** One finding of the playability audit (audit.js), kept on this device. */
export interface AuditRow { year: string; playlistId: string; videoId: string; itemId: string; position: number; artist: string; title: string; why: string; at: number }
export interface Audit { years: Record<string, { at: number; tracks: number; dead: AuditRow[]; units: number }> }
/** A search result that can play here, offered as a replacement for a dead track. */
export interface Replacement extends VideoInfo { videoId: string }
/** One playlist row of a duplicated song, as the build's playlist scan saw it (title, edition, album, length, audio or video). */
export interface DupeEntry {
  year: string; playlistId: string; videoId: string; position: number;
  title?: string; edition?: string; label?: string; album?: string | null; duration?: number | null; videoType?: string | null; avail?: boolean;
  itemIds?: string[];   // live scan only: the playlistItem ids, so a removal needs no lookup
}
/** One song the year playlists hold more than once (data/duplicates.json, version 2), with every copy listed. */
export interface Dupe {
  key: string; artist: string; title: string; kind: string; kinds?: string[]; years: string[]; count: number; uploads?: number; editions?: string[];
  entries: DupeEntry[]; verified_year?: number; verified_source?: string;
  videoId?: string;   // version 1 reports: one item per video
  live?: boolean;     // built by the tab's own scan of a playlist, not by the daily build
}
/** What the tab knows about a video from a videos.list lookup (1 unit for up to 50 ids). */
export interface VideoInfo { title: string; channel: string; topic: boolean; seconds: number | null; views: number | null; published: string | null; blocked: boolean; embeddable: boolean; rejected?: boolean; missing?: boolean }

export interface Settings {
  audition: boolean; auditionSeconds: number; auditionStart: number; deck: boolean | null; skipsInYouTube: boolean | null; dupesNoticed?: string; dupesDone: string[]; installDismissedAt?: number; shortlistSize: number;
  autoplay: boolean; shuffle: boolean; introDismissed?: boolean;
  ghToken?: string | null;   // a fine-grained GitHub token (contents: write on the site repo) that lets the browser push data/ratings.json for the build to learn from
}
export interface Filters { q: string; sourcesOff: string[]; blogsOff: string[]; sort: string; onlyNew: boolean; onlyPlayable: boolean; onlyKnown: boolean; onlyRecent: boolean; shortlist: boolean; catYear: string; catSort: string; catSourcesOff: string[] }
export interface State {
  feed: Feed | null; rated: Record<string, Rated>; auth: Auth | null; playlists: Record<string, any>; settings: Settings;
  deckIndex: number; auditionTimer: any; auditionTick: any; auditionArmed: string | null;
  quota: { day: string; units: number }; filters: Filters; view: string; order: string[]; currentId: string | null; rendered: number;
  playingId: string | null;     // the track in the player (currentId is the card the keyboard is on: they part when you browse while listening)
  shuffleOrder: string[]; shuffleFor: string;   // a shuffled copy of `order` while shuffle is on, and the order it was made from
  lastRated: string | null;     // the last thumb, for the z key
  badVideos: Record<string, number>; badVersion: number; ratedVersion: number; shortlistHidden: number; focusId: string | null; shareIn: { url?: string; text?: string; title?: string; artist?: string } | null;
  catalog: Catalog | null; catalogState: "idle" | "loading" | "ready" | "missing" | "failed"; index: Map<string, FeedItem>;
  player: any; playerReady: boolean; pendingVideo: string | null; tokenClient: any; busy: Set<string>;
  sync: { fileId: string | null; at: number }; syncTimer: any;
  ghTimer: any; ghRetry: any; ghBusy: Promise<boolean> | null; ghAt: number; ghDirty: boolean; ghFails: number;
  ghErr: string | null; ghSaid: { msg: string; at: number } | null;
  ghSha: { sha: string; updatedAt: string; count: number } | null;   // the blob this browser last committed, so an unchanged sitting is recognised without downloading it
  _years: number[]; dupes: Dupe[] | null; dupePage: number; dupeQT: any;
  videoInfo: Record<string, VideoInfo>;   // videos.list lookups made by the Cleanup tab this session
  liveDupes: Dupe[] | null; liveYear: string | null;   // the tab's own scan of one year playlist
  audit: Audit | null;                                  // the playability audit's findings (id:audit), loaded on first use
  unavailable: Unavailable[] | null; library: any[] | null; notOwner: boolean; signingIn: Promise<boolean> | null; authCb: any; authErrCb: any; keepAliveAt: number;
  lastAuthError: { why: string; at: number } | null; ready: boolean; online: boolean; recentAt: number; recentVideos: Set<string>;
  apiLog: ApiEntry[];
}
/** One YouTube Data API request, as the API activity sheet shows it. */
export interface ApiEntry {
  at: number; method: string; path: string; params?: Record<string, any>;
  status: number; ok: boolean; units: number; ms: number;
  why: string;       // what the site was doing, in plain words ("Keep: verify … does not already hold this video")
  detail?: string;   // the track or playlist concerned
  error?: string;
}
