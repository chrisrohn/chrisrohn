// Shapes shared by the modules. feed.json is written by discovery/build.py (Item.to_dict + _public_item).
export interface YouTubeMatch { videoId: string | null; thumbnail?: string | null; year?: string | number | null; playlistId?: string | null; album?: string | null }
export interface FeedItem {
  id: string; artist: string; title: string; display?: string; display_title?: string; kind?: string;
  release?: string | null; release_type?: string | null; release_date?: string | null; date_kind?: string;
  tags?: string[]; sources?: string[]; links?: Record<string, string | string[]>; artwork?: string | null; editorial?: boolean;
  year?: number | null; year_source?: string | null; year_confidence?: string | null; year_evidence?: string[]; original_year?: number | null;
  youtube?: YouTubeMatch | null; score: number; reasons?: string[]; matched_artist?: string | null; match_kind?: string | null; first_seen?: string | null;
  _pick?: boolean; _year?: string | number | null; _skipped?: boolean;
}
export interface LearnedRow { n: number; k: number; rate: number; adj: number }
export interface LearnedSummary { outcomes: number; kept: number; skipped: number; keep_rate: number; since?: string | null; sources: Record<string, LearnedRow>; tags: Record<string, LearnedRow> }
export interface Feed {
  generated_at: string; station: string; site_name?: string; count: number; new_today: number; years?: number[];
  google?: { client_id?: string; curator_hashes?: string[]; curators?: string[]; guests?: boolean; guest_playlist_title_pattern?: string };
  youtube?: { playlist_title_pattern?: string; skipped_playlist_title?: string; playlists?: Record<string, string>; skipped_playlist_id?: string; skips_in_youtube?: boolean;
    duplicates_count?: number; duplicates_kinds?: Record<string, number>; duplicates_checked_at?: string | null };
  picks?: Array<{ artist: string; title: string; videoId?: string | null; year?: string; thumbnail?: string | null; album?: string | null }>;
  learned?: LearnedSummary;
  feed_health?: Record<string, { ok: boolean; entries: number; kept: number; error?: string | null }>;
  lastfm_user?: string; profile?: { built_at?: string; counts?: Record<string, number> }; sources?: string[]; blogs?: string[]; items: FeedItem[];
}
export interface Rated {
  decision: "up" | "down" | "seen" | "undone"; at: number; year?: number | string; videoId?: string; artist?: string; title?: string;
  playlistItemId?: string; playlistId?: string; pending?: boolean; local?: boolean; duplicate?: boolean;
  sources?: string[]; tags?: string[];   // what the card carried when it was rated: the personal ranking and the stats learn from these
}
export interface Auth { email?: string; name?: string; picture?: string; hash?: string; access_token?: string; expires_at: number }
export interface DupeEntry { year: string; playlistId: string; videoId: string; position: number }
export interface Dupe { key: string; videoId: string; artist: string; title: string; kind: string; years: string[]; count: number; entries: DupeEntry[]; verified_year?: number; verified_source?: string }

export interface Settings { audition: boolean; auditionSeconds: number; auditionStart: number; deck: boolean | null; skipsInYouTube: boolean | null; dupesNoticed?: string; dupesDone: string[]; installDismissedAt?: number; shortlistSize: number }
export interface Filters { q: string; sourcesOff: string[]; blogsOff: string[]; sort: string; onlyNew: boolean; onlyPlayable: boolean; onlyKnown: boolean; onlyRecent: boolean; shortlist: boolean }
export interface State {
  feed: Feed | null; rated: Record<string, Rated>; auth: Auth | null; playlists: Record<string, any>; settings: Settings;
  deckIndex: number; auditionTimer: any; auditionTick: any; auditionArmed: string | null;
  quota: { day: string; units: number }; filters: Filters; view: string; order: string[]; currentId: string | null; rendered: number;
  badVideos: Record<string, number>; ratedVersion: number; shortlistHidden: number; focusId: string | null;
  player: any; playerReady: boolean; pendingVideo: string | null; tokenClient: any; busy: Set<string>;
  sync: { fileId: string | null; at: number }; syncTimer: any; _years: number[]; dupes: Dupe[] | null; dupePage: number; dupeQT: any;
  library: any[] | null; notOwner: boolean; signingIn: Promise<boolean> | null; authCb: any; authErrCb: any; keepAliveAt: number;
  lastAuthError: { why: string; at: number } | null; ready: boolean;
}
