// @ts-check
/* Cross-device memory: ratings (and the quota count) mirrored to a hidden per-app file in the signed-in account's
 * Google Drive (appDataFolder). Newest record per track wins; "undone" tombstones travel too. */
import { state, persist, reconcileRated, ptDay, DRIVE, DRIVE_UPLOAD, SYNC_FILE } from "./state.js";
import { toast } from "./dom.js";
import { withAuth, isCurator, tokenValid } from "./auth.js";
import { render } from "./render.js";

/** @typedef {import("./types").Rated} Rated */

/** @param {string} method @param {string} url @param {{params?: Record<string, any>, body?: any, raw?: boolean}} [opts] */
export async function drive(method, url, { params = {}, body, raw } = {}) {
  return withAuth(async token => {
    const u = new URL(url); for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
    /** @type {Record<string, string>} */
    const headers = { Authorization: "Bearer " + token }; if (body && !raw) headers["Content-Type"] = "application/json";
    const r = await fetch(u, { method, headers, body: raw ? body : (body ? JSON.stringify(body) : undefined) });
    if (!r.ok) {
      const j = await r.json().catch(() => ({})); const msg = (j.error && j.error.message) || r.statusText;
      if (r.status === 401) { if (state.auth) state.auth.expires_at = 0; persist(); throw new Error("Google session expired — it will refresh on your next tap"); }
      if (r.status === 403 && /Drive API has not been used|not enabled|accessNotConfigured/i.test(msg)) throw new Error("Google Drive API is not enabled for this project — enable it once in the Google Cloud console (see SETUP.md) so ratings can sync across devices");
      if (r.status === 403 && /insufficient/i.test(msg)) throw new Error("Sign out and sign in again to grant the new 'app data' permission that syncs ratings across devices");
      throw new Error(msg);
    }
    return r;
  });
}
// Two devices syncing for the first time at once can each create a file: the newest is the one we keep, the others
// are folded in and deleted so every device ends up on the same file.
async function syncFiles() {
  const r = await drive("GET", `${DRIVE}/files`, { params: { spaces: "appDataFolder", q: `name='${SYNC_FILE}'`, fields: "files(id,modifiedTime)", orderBy: "modifiedTime desc", pageSize: 10 } });
  return /** @type {{id: string}[]} */ ((await r.json()).files || []);
}
async function syncFileId() {
  if (state.sync.fileId) return state.sync.fileId;
  const f = (await syncFiles())[0];
  if (f) { state.sync.fileId = f.id; persist(); return f.id; }
  return null;
}
/** @param {string} id @returns {Promise<{rated: Record<string, Rated>, quota?: {day: string, units: number}} | null>} */
async function readSyncFile(id) {
  const r = await drive("GET", `${DRIVE}/files/${id}`, { params: { alt: "media" } });
  const data = await r.json().catch(() => null);
  return data && data.rated ? data : null;
}
// Newest record per track wins. "seen" (spotted in a playlist, no playlistItemId to undo with) never beats a real
// decision; "undone" is a tombstone so an Undo on one device also un-hides the track on the others.
/** @param {Rated | undefined} r */
const weak = r => !r || r.decision === "seen";
/** @param {{rated?: Record<string, Rated>, quota?: {day: string, units: number}} | null} remote */
export function mergeRemote(remote) {
  let changed = false;
  for (const [id, r] of Object.entries((remote && remote.rated) || {})) {
    if (!r || r.pending) continue;
    const l = state.rated[id];
    const newer = !l || (r.at || 0) > (l.at || 0);
    if ((newer && !(weak(r) && !weak(l))) || (weak(l) && !weak(r))) { state.rated[id] = { ...r, pending: false }; changed = true; }
  }
  // the quota is per account, not per device: the highest count any device saw today is the truth
  const q = remote && remote.quota;
  if (q && q.day === ptDay() && (state.quota.day !== q.day || q.units > state.quota.units)) { state.quota = { day: q.day, units: q.units }; changed = true; }
  return changed;
}
export async function pullRatings() {
  if (!isCurator() || !tokenValid()) return;
  try {
    const files = state.sync.fileId ? [{ id: state.sync.fileId }] : await syncFiles();
    if (!files.length) return;
    let changed = false;
    for (const f of files) { const remote = await readSyncFile(f.id).catch(() => null); if (remote && mergeRemote(remote)) changed = true; }
    state.sync.fileId = files[0].id;
    for (const f of files.slice(1)) drive("DELETE", `${DRIVE}/files/${f.id}`).catch(() => {});
    if (changed) { persist(); render(); schedulePush(); }
    state.sync.at = Date.now(); persist();
  } catch (e) { toast("Rating sync (pull) failed: " + /** @type {Error} */ (e).message, true); }
}
export function schedulePush() { clearTimeout(state.syncTimer); state.syncTimer = setTimeout(() => pushRatings().catch(() => {}), 1500); }
export async function pushRatings() {
  if (!isCurator()) return;
  reconcileRated();
  try {
    let id = await syncFileId();
    // never overwrite what another device wrote since we last looked: fold the file in first, then write the union
    if (id) { const remote = await readSyncFile(id).catch(() => null); if (remote && mergeRemote(remote)) render(); }
    const shared = Object.fromEntries(Object.entries(state.rated).filter(([, r]) => !r.pending));
    const payload = JSON.stringify({ version: 3, account: state.auth?.email, updatedAt: new Date().toISOString(), rated: shared, quota: state.quota });
    if (id) {
      await drive("PATCH", `${DRIVE_UPLOAD}/files/${id}`, { params: { uploadType: "media" }, body: payload, raw: true });
    } else {
      const boundary = "nm" + Date.now();
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: SYNC_FILE, parents: ["appDataFolder"] })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`;
      const r = await withAuth(token => fetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": `multipart/related; boundary=${boundary}` }, body }));
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || r.statusText);
      id = (await r.json()).id; state.sync.fileId = id;
    }
    state.sync.at = Date.now(); persist();
  } catch (e) { toast("Rating sync (push) failed: " + /** @type {Error} */ (e).message, true); }
}
