// @ts-check
/* The Concerts tab: every upcoming show within 150 miles of Detroit by an artist played on Indie Discotheque in the
 * last year — the Songkick page, drawn from Bandsintown and Ticketmaster by the Concerts workflow
 * (discovery/concerts.py → data/concerts.json). One row per show: the date, who, the venue and city, how far, the
 * ticket link, and the act's most popular song, playable in place through the site's own player. Loaded the first
 * time the tab opens; the rows' top songs join the id index so j/k, space and autoplay walk the list like any other. */
import { state, persist, reindex } from "./state.js";
import { $, $$, esc, safeUrl, norm, relTime, toast } from "./dom.js";
import { play, toggle } from "./player.js";
import { openArtist } from "./artist.js";
import { parseQuery, searchFor } from "./feed.js";

/** @typedef {import("./types").ConcertEvent} ConcertEvent */
/** @typedef {import("./types").Concerts} Concerts */
/** @typedef {import("./types").FeedItem} FeedItem */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** @type {Record<string, string>} */
const STATUS = { available: "", onsale: "", offsale: "off sale", cancelled: "cancelled", canceled: "cancelled", postponed: "postponed", rescheduled: "rescheduled", soldout: "sold out", "sold out": "sold out" };

/** A "YYYY-MM-DD" as a local date (never UTC: a show on the 3rd must not become the 2nd in Detroit). @param {string} s */
export const localDate = s => { const [y, m, d] = String(s || "").split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
/** The local "YYYY-MM-DD" of the day `plus` days from now. @param {number | string} plus */
const dayKey = plus => { const d = new Date(); d.setDate(d.getDate() + Number(plus)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/* ---- loading ---- */
export async function loadConcerts(force = false) {
  if (state.concertsState === "loading" || (state.concertsState === "ready" && !force)) return;
  state.concertsState = "loading"; renderConcerts();
  try {
    const r = await fetch("data/concerts.json", { cache: "no-cache" });
    if (r.status === 404) { state.concertsState = "missing"; renderConcerts(); return; }
    if (!r.ok) throw new Error("concerts.json " + r.status);
    const c = /** @type {Concerts} */ (await r.json());
    if (c.generated_at !== state.concerts?.generated_at) { state.concerts = c; state.concertTracks = tracksOf(c); memo.clear(); reindex(); }
    state.concertsState = "ready";
  } catch (e) { state.concertsState = "failed"; toast("Could not load the concert list: " + /** @type {Error} */ (e).message, true); }
  import("./render.js").then(m => m.render()).catch(() => {});
}
/** Each act's most popular song as a playable item, keyed like the feed (the same song in the feed or the catalog
 * keeps that card: reindex lets those win). @param {Concerts} c @returns {FeedItem[]} */
function tracksOf(c) {
  const out = [];
  for (const [name, a] of Object.entries(c.artists || {})) {
    const t = a.top_track; if (!t || !t.id) continue;
    const yt = t.youtube || null;
    out.push({ id: t.id, artist: name, title: t.title, display_title: t.title, release: yt?.album || null, release_type: null, release_date: null, sources: ["concerts"], tags: [], reasons: [], score: 0,
      youtube: yt && yt.videoId ? { videoId: yt.videoId, thumbnail: yt.thumbnail || null, playlistId: yt.playlistId || null, album: yt.album || null, year: yt.year ?? null } : null,
      artwork: yt?.thumbnail || a.image || null, year: yt?.year != null && Number.isFinite(Number(yt.year)) ? Number(yt.year) : null, year_source: yt?.year != null ? "youtube" : "unknown", year_confidence: "low",
      links: t.url ? { [t.source === "deezer" ? "deezer" : "last.fm"]: t.url } : {}, _concert: true });
  }
  return out;
}

/* ---- the visible list ---- */
/** @type {Map<string, ConcertEvent[]>} */
const memo = new Map();
/** The shows the filters allow, in the chosen order. @returns {ConcertEvent[]} */
export function visibleConcerts() {
  const c = state.concerts; if (!c) return [];
  const f = state.filters;
  const key = `${c.generated_at}|${f.q}|${f.conWhen}|${f.conRadius}|${f.conSort}|${todayKey()}`;
  const hit = memo.get(key); if (hit) return hit;
  const terms = parseQuery((f.q || "").trim());
  const today = todayKey(); const until = f.conWhen ? dayKey(f.conWhen) : null; const radius = Number(f.conRadius) || 0;
  const list = (c.events || []).filter(ev => {
    if (!ev.date || ev.date < today) return false;
    if (until && ev.date > until) return false;
    if (radius && Number(ev.miles) > radius) return false;
    return !terms.length || matches(ev, terms);
  });
  const plays = (/** @type {ConcertEvent} */ ev) => Math.max(...(ev.artists || [ev.artist]).map(a => artistOf(a).plays || 0), 0);
  /** @type {Record<string, (a: ConcertEvent, b: ConcertEvent) => number>} */
  const cmp = {
    date: (a, b) => a.date.localeCompare(b.date) || (a.miles || 0) - (b.miles || 0) || a.artist.localeCompare(b.artist),
    plays: (a, b) => plays(b) - plays(a) || a.date.localeCompare(b.date),
    miles: (a, b) => (a.miles || 0) - (b.miles || 0) || a.date.localeCompare(b.date),
    artist: (a, b) => a.artist.localeCompare(b.artist) || a.date.localeCompare(b.date),
  };
  list.sort(cmp[f.conSort] || cmp.date);
  if (memo.size > 8) memo.delete(/** @type {string} */ (memo.keys().next().value));
  memo.set(key, list);
  return list;
}
/** @param {ConcertEvent} ev @param {import("./feed.js").Term[]} terms */
function matches(ev, terms) {
  const top = (ev.artists || []).map(a => artistOf(a).top_track?.title || "");
  const hay = norm([ev.artist, ...(ev.artists || []), ...(ev.lineup || []), ev.title, ev.venue, ev.city, ev.region, ...top].join(" "));
  const artists = (ev.artists || [ev.artist]).concat(ev.lineup || []).map(norm);
  for (const t of terms) {
    const v = norm(t.value); let ok;
    if (t.field === "artist") ok = artists.some(a => a === v || a.includes(v));
    else if (t.field === "year") ok = (ev.date || "").startsWith(t.value);
    else if (t.field === "source") ok = (ev.sources || []).some(s => s.includes(t.value.toLowerCase()));
    else if (t.field === "tag") ok = false;
    else ok = hay.includes(v);
    if (ok === t.not) return false;
  }
  return true;
}
/** What the list knows about an act (an empty record for a name the artists map lacks). @param {string} name @returns {import("./types").ConcertArtist} */
const artistOf = name => ((state.concerts && state.concerts.artists) || {})[name] || { plays: 0, filed: 0, via: [], top_track: null, image: null, links: {} };
/** What the tab's pill says: the shows the filters allow, or "…" while the list is not in yet. */
export const concertsCount = () => (state.concerts ? visibleConcerts().length : null);

/* ---- rendering ---- */
/** @param {number | null | undefined} n */
const fmtMiles = n => (n == null ? "" : n < 1 ? "under a mile" : `${Math.round(n)} mi`);
/** @param {string | null | undefined} t */
function fmtTime(t) { if (!t) return ""; const [h, m] = t.split(":").map(Number); if (!Number.isFinite(h)) return ""; const d = new Date(); d.setHours(h, m || 0, 0, 0); return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(" ", ""); }
/** @param {ConcertEvent["price"]} p */
function fmtPrice(p) {
  if (!p || p.min == null) return "";
  const cur = p.currency || "USD";
  const money = (/** @type {number} */ v) => { try { return new Intl.NumberFormat([], { style: "currency", currency: cur, maximumFractionDigits: Number.isInteger(v) ? 0 : 2 }).format(v); } catch { return `${v} ${cur}`; } };
  return p.max != null && p.max !== p.min ? `${money(p.min)}–${money(p.max)}` : `from ${money(p.min)}`;
}
/** @param {number} n */
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function renderConcerts() {
  const host = $("#con-list"); const sum = $("#con-summary"); const empty = $("#con-empty"); if (!host) return;
  const c = state.concerts;
  $$(".concerts-only").forEach(el => { el.disabled = !c; });
  const all0 = $("#con-radius option[value='']"); if (all0 && c) all0.textContent = `within ${c.radius_miles} miles`;
  if (!c) {
    const note = { idle: "Opening the concert list…", loading: "Loading the concert list…", missing: "No concert list yet — it appears after the first run of the Concerts workflow, then refreshes every afternoon.", failed: "Could not load the concert list." }[state.concertsState] || "";
    sum.textContent = ""; host.replaceChildren(); empty.hidden = false; empty.replaceChildren(note);
    if (state.concertsState === "failed") { const b = document.createElement("button"); b.type = "button"; b.className = "btn ghost small"; b.textContent = "Retry"; b.addEventListener("click", () => loadConcerts(true)); empty.append(" ", b); }
    state.order = [];
    return;
  }
  const vis = visibleConcerts();
  const artists = new Set(vis.flatMap(ev => ev.artists || [ev.artist]));
  const when = c.generated_at ? relTime(new Date(c.generated_at)) : "?";
  const all = (c.events || []).filter(ev => ev.date >= todayKey()).length;
  const checked = c.artists_checked != null && c.artists_total ? ` · ${c.artists_checked.toLocaleString()} of ${c.artists_total.toLocaleString()} played artists checked so far` : "";
  const tm = c.health && c.health.ticketmaster && !c.health.ticketmaster.ok ? " · Bandsintown listings only" : "";
  sum.textContent = `${plural(vis.length, "show", "shows")}${vis.length !== all ? ` of ${all}` : ""} within ${c.radius_miles} miles of ${c.center?.name || "Detroit"} by ${plural(artists.size, "artist", "artists")} you played this year · built ${when}${checked}${tm}`;
  sum.title = `Sources: ${(c.sources || []).join(", ") || "none yet"}`;
  // the rows' top songs are the queue: space plays the first, j/k and autoplay walk on down the list
  const ids = []; for (const ev of vis) { const id = trackIdFor(ev); if (id && !ids.includes(id)) ids.push(id); }
  state.order = ids;
  if (!vis.length) {
    host.replaceChildren(); empty.hidden = false;
    empty.replaceChildren(all ? `${plural(all, "show is", "shows are")} listed, none of them matching these filters.` : `Nothing nearby on the books yet for the artists you played this year${c.artists_checked != null && c.artists_checked < (c.artists_total || 0) ? " — the list fills in over the next few runs as the artists are checked" : ""}.`);
    if (all) { const b = document.createElement("button"); b.type = "button"; b.className = "btn ghost small"; b.textContent = "clear the filters"; b.addEventListener("click", clearFilters); empty.append(" ", b); }
    return;
  }
  empty.hidden = true;
  const els = []; let month = "";
  for (const ev of vis) {
    if ((state.filters.conSort || "date") === "date") {
      const d = localDate(ev.date); const m = `${d.getFullYear()}-${d.getMonth()}`;
      if (m !== month) { month = m; const h = document.createElement("h3"); h.className = "con-month"; h.textContent = d.toLocaleDateString([], { month: "long", year: "numeric" }); els.push(h); }
    }
    els.push(row(ev));
  }
  host.replaceChildren(...els);
}
/** The id of the act's most popular song on a row (the headliner's, else the first billed act with one). @param {ConcertEvent} ev */
function trackIdFor(ev) {
  const c = state.concerts; if (!c) return null;
  for (const a of ev.artists || [ev.artist]) { const t = artistOf(a).top_track; if (t && t.id && t.youtube && t.youtube.videoId) return t.id; }
  return null;
}
/** @param {ConcertEvent} ev */
function row(ev) {
  const c = /** @type {Concerts} */ (state.concerts);
  const el = document.createElement("article"); el.className = "show"; el.dataset.id = ev.id;
  const d = localDate(ev.date); const soon = ev.date <= dayKey(7);
  const lead = ev.artist; const a = artistOf(lead);
  const others = (ev.artists || []).filter(x => x !== lead);
  const bill = (ev.lineup || []).filter(x => !(ev.artists || []).includes(x));
  const status = STATUS[String(ev.status || "").toLowerCase()] ?? String(ev.status || "");
  const tickets = safeUrl(ev.tickets) || safeUrl(ev.url);
  const track = a.top_track; const tid = track && track.id; const vid = track?.youtube?.videoId;
  if (tid) el.dataset.track = tid;
  if (status === "cancelled") el.classList.add("cancelled");
  const why = [];
  if (a.plays) why.push(`you played them ${plural(a.plays, "time", "times")} this year`);
  if (a.filed) why.push(`${plural(a.filed, "track", "tracks")} filed this year`);
  if (!a.plays && !a.filed) why.push("played on Indie Discotheque this year");
  const facts = [fmtTime(ev.time), ev.festival ? "festival" : ""].filter(Boolean);
  const price = fmtPrice(ev.price);   // Ticketmaster lists face values; Bandsintown publishes none
  const pop = track ? (track.source === "lastfm" && track.listeners ? `${track.listeners.toLocaleString()} listeners on Last.fm` : track.source === "deezer" ? "Deezer's most streamed" : "most popular on Last.fm") : "";
  el.innerHTML = `
    <div class="show-date" aria-hidden="true"><span class="dow">${DAYS[d.getDay()]}</span><b class="dd">${d.getDate()}</b><span class="mm">${MONTHS[d.getMonth()]}</span></div>
    <div class="show-body">
      <div class="show-line1">
        <button type="button" class="artist" title="everything by ${esc(lead)} (the artist sheet)">${esc(lead)}</button>
        ${others.length ? `<span class="show-with">with ${others.map(n => `<button type="button" class="linkish aopen" data-artist="${esc(n)}">${esc(n)}</button>`).join(", ")}</span>` : ""}
        ${status ? `<span class="flag ${esc(status.replace(/\s/g, "-"))}">${esc(status)}</span>` : ""}
        ${soon ? `<span class="flag soon">this week</span>` : ""}
      </div>
      ${ev.title && norm(ev.title) !== norm(lead) ? `<div class="show-title">${esc(ev.title)}</div>` : ""}
      <div class="show-venue"><b>${esc(ev.venue || "venue tba")}</b> · ${esc([ev.city, ev.region].filter(Boolean).join(", ") || ev.country || "")}${ev.miles != null ? ` · <span class="miles" title="from ${esc(c.center?.name || "Detroit")}">${esc(fmtMiles(ev.miles))}</span>` : ""}${facts.length ? ` · ${esc(facts.join(" · "))}` : ""}</div>
      <div class="show-why">${esc(why.join(" · "))}${bill.length ? ` · also on the bill: ${esc(bill.slice(0, 6).join(", "))}${bill.length > 6 ? "…" : ""}` : ""}</div>
      ${track ? `<div class="show-track">
        <button type="button" class="btn small tplay" ${vid ? "" : "disabled"} title="${vid ? "play their most popular song" : "no YouTube match for this song"}" aria-label="play ${esc(lead)} - ${esc(track.title)}">▶&#xFE0E;</button>
        <span class="ttitle"><span class="muted">most popular song:</span> <b>${esc(track.title)}</b>${pop ? ` <span class="muted">· ${esc(pop)}</span>` : ""}</span>
        ${vid ? `<a href="https://music.youtube.com/watch?v=${esc(vid)}" target="_blank" rel="noopener">YouTube Music</a>` : `<a href="https://music.youtube.com/search?q=${encodeURIComponent(lead + " " + track.title)}" target="_blank" rel="noopener">search YouTube Music</a>`}
      </div>` : `<div class="show-track muted">most popular song: not looked up yet</div>`}
      <div class="links">
        ${tickets ? `<a href="${esc(tickets)}" target="_blank" rel="noopener">${ev.tickets ? `tickets${ev.ticketer ? ` · ${esc(ev.ticketer)}` : ""}` : "event page"}</a>` : ""}
        ${Object.entries(ev.links || {}).filter(([, u]) => safeUrl(u) && u !== tickets).map(([k, u]) => `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${esc(k)}</a>`).join("")}
        ${Object.entries(a.links || {}).map(([k, u]) => safeUrl(u) ? `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${esc(k)}</a>` : "").join("")}
      </div>
    </div>
    <div class="show-side">
      ${tickets ? `<a class="btn ${ev.tickets ? "primary" : "ghost"} small tickets" href="${esc(tickets)}" target="_blank" rel="noopener" title="${ev.tickets ? `tickets${ev.ticketer ? ` from ${esc(ev.ticketer)}` : ""}${price ? `, ${esc(price)}` : ""}` : "the event page"}">${ev.tickets ? `Tickets${ev.ticketer ? ` · ${esc(ev.ticketer)}` : ""}` : "Details"}</a>` : `<span class="muted tba">no link</span>`}
      ${price ? `<span class="price" title="ticket price${ev.price?.currency ? ` in ${esc(ev.price.currency)}` : ""}, as Ticketmaster lists it">${esc(price)}</span>` : ""}
      ${safeUrl(ev.image || a.image) ? `<img alt="" loading="lazy" decoding="async" width="72" height="72" src="${esc(safeUrl(ev.image || a.image))}">` : ""}
    </div>`;
  const img = $("img", el); if (img) img.addEventListener("error", () => img.remove(), { once: true });
  $(".artist", el).addEventListener("click", () => openArtist(lead));
  $$(".aopen", el).forEach(b => b.addEventListener("click", () => openArtist(b.dataset.artist || "")));
  const pb = $(".tplay", el); if (pb && tid) pb.addEventListener("click", () => { if (state.playingId === tid && state.playerReady) toggle(); else play(tid); });
  if (tid && state.playingId === tid) el.classList.add("current");
  return el;
}
function clearFilters() {
  Object.assign(state.filters, { q: "", conWhen: "", conRadius: "", conSort: "date" });
  $("#q").value = ""; $("#con-when").value = ""; $("#con-radius").value = ""; $("#con-sort").value = "date";
  persist(); import("./render.js").then(m => m.render()).catch(() => {});
}
export function wireConcerts() {
  const f = state.filters;
  $("#con-when").value = f.conWhen || ""; $("#con-radius").value = f.conRadius || ""; $("#con-sort").value = f.conSort || "date";
  const rerender = () => import("./render.js").then(m => m.render()).catch(() => {});
  $("#con-when").addEventListener("change", (/** @type {any} */ e) => { f.conWhen = e.target.value; persist(); rerender(); });
  $("#con-radius").addEventListener("change", (/** @type {any} */ e) => { f.conRadius = e.target.value; persist(); rerender(); });
  $("#con-sort").addEventListener("change", (/** @type {any} */ e) => { f.conSort = e.target.value; persist(); rerender(); });
}
/** Upcoming shows nearby by one act, for the artist sheet. @param {string} name */
export function showsFor(name) {
  const c = state.concerts; if (!c) return [];
  const n = norm(name); const today = todayKey();
  return (c.events || []).filter(ev => ev.date >= today && (ev.artists || [ev.artist]).some(a => norm(a) === n)).sort((a, b) => a.date.localeCompare(b.date));
}
/** Switch to the Concerts tab filtered to one act. @param {string} name */
export function showConcertsFor(name) { const tab = $(".tab[data-view=concerts]"); if (tab) tab.click(); searchFor(`artist:"${name}"`, { add: false }); }
