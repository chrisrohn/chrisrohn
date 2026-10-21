// The installable Training app. It lives on an origin of its own ([app] url in fitness/config.toml, by default
// https://chrisrohn.github.io/), apart from the music app: Android installs one app per scope, and the music app's
// scope is all of chrisrohn.com, so a training app under chrisrohn.com/fitness/ could only ever "open in New Music".
//
//   buildStandalone(out)  the whole app at <out>/ — what the app's own site serves:
//     index.html          the dashboard shell — holds no one's data; a phone link or a data file brings it, kept on the device
//     ride.html           ride mode, the cycling computer (ride-core.js + ride.js inlined)
//     vendor/             MapLibre GL, for the map (loaded only on the Map screen)
//     manifest.webmanifest, sw.js, icons/, .nojekyll, robots.txt   installable, offline, not indexed
//   buildApp(out)         <out>/fitness/ on chrisrohn.com — the move: carries anything this phone kept there to the new
//                         address, retires the old service worker, and forwards (QR links from before still work)
//
// Every page carries a Content-Security-Policy (fitness/site/csp.txt): only its own inline scripts (by hash) and its
// own files run, and it talks only to GitHub's API, Open-Meteo, OpenFreeMap's tiles and the BRouter router.
//
//   node fitness/build-app.mjs <dir>     writes the standalone app (what the app site's deploy workflow runs)
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "site");
const part = (/** @type {string} */ f) => readFileSync(join(SITE, f), "utf8");
export const POLICY = part("csp.txt").trim();
/** Where the app lives: [app] url in fitness/config.toml (FITNESS_APP_URL overrides it). */
export const APP_URL = (() => {
  const env = process.env.FITNESS_APP_URL;
  if (env) return env.endsWith("/") ? env : env + "/";
  const m = readFileSync(join(HERE, "config.toml"), "utf8").match(/^\[app\][\s\S]*?^url\s*=\s*"([^"]*)"/m);
  const url = (m && m[1]) || "https://chrisrohn.github.io/";
  return url.endsWith("/") ? url : url + "/";
})();
const sha = (/** @type {string} */ s) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

/** @param {string} page @param {string} [policy] */
function lockDown(page, policy = POLICY) {
  const hashes = [...page.matchAll(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)].map(m => sha(m[1]));
  if (hashes.length < 2 || !page.includes("__CSP__")) throw new Error("fitness/site pages must carry a __CSP__ meta and their inline scripts");
  return page.replace("__CSP__", policy.replace("%SCRIPTS%", hashes.join(" ")));
}

/** The two pages, filled in and locked down. */
export function pages() {
  // function replacements: the sources contain `$` sequences String.replace would expand
  const ride = lockDown(part("ride.html").replace("/*__STYLE__*/", () => part("style.css")).replace("/*__RIDE_STYLE__*/", () => part("ride.css"))
    .replace("/*__RIDE_CORE__*/", () => part("ride-core.js")).replace("/*__RIDE_APP__*/", () => part("ride.js")).replace("__RIDE_DATA__", ""));
  const index = lockDown(part("index.html").replace("/*__STYLE__*/", () => part("style.css")).replace("/*__SHELL__*/", () => part("shell.js"))
    .replace("/*__APP__*/", () => part("app.js")).replace("__DATA__", ""));
  return { ride, index };
}

/** MapLibre's ES module, its worker and stylesheet, from node_modules (npm ci); without them the map falls back to the
 *  drawn breadcrumb. @param {string} dir */
export function vendor(dir) {
  const src = join(HERE, "..", "node_modules", "maplibre-gl");
  if (!existsSync(join(src, "dist", "maplibre-gl.mjs"))) return false;
  mkdirSync(join(dir, "vendor"), { recursive: true });
  for (const f of ["maplibre-gl.mjs", "maplibre-gl-worker.mjs", "maplibre-gl.css"]) cpSync(join(src, "dist", f), join(dir, "vendor", f));
  cpSync(join(src, "LICENSE.txt"), join(dir, "vendor", "MAPLIBRE-LICENSE.txt"));
  return true;
}

/** The whole app at <out>/. @param {string} out */
export function buildStandalone(out) {
  mkdirSync(out, { recursive: true });
  const { ride, index } = pages();
  const manifest = part("manifest.webmanifest");
  JSON.parse(manifest);   // fail the build, not the install, on a broken manifest
  const hasMap = vendor(out);
  const version = createHash("sha256").update(index).update(ride).update(manifest).update(String(hasMap)).digest("hex").slice(0, 10);
  writeFileSync(join(out, "index.html"), index);
  writeFileSync(join(out, "ride.html"), ride);
  writeFileSync(join(out, "manifest.webmanifest"), manifest);
  writeFileSync(join(out, "sw.js"), part("sw.js").replaceAll("__VERSION__", version));
  writeFileSync(join(out, ".nojekyll"), "");
  writeFileSync(join(out, "robots.txt"), "User-agent: *\nDisallow: /\n");
  writeFileSync(join(out, "404.html"), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Training</title><p style="font:16px/1.5 system-ui,sans-serif;padding:24px">Nothing here. <a href="./">Open Training</a>.</p>\n`);
  const host = new URL(APP_URL).hostname;
  if (!host.endsWith(".github.io")) writeFileSync(join(out, "CNAME"), host + "\n");   // a custom domain for the app's Pages site
  cpSync(join(SITE, "icons"), join(out, "icons"), { recursive: true });
  return { version, hasMap };
}

/** chrisrohn.com/fitness/: the move to the app's own address. Same pages, same paths, one job each. @param {string} out */
export function buildApp(out) {
  const dir = join(out, "fitness");
  mkdirSync(dir, { recursive: true });
  const script = `(async () => {
  const to = ${JSON.stringify(APP_URL)};
  const keep = {};
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith("fitness-")) keep[k] = localStorage.getItem(k); } } catch (e) { /* private mode */ }
  try { for (const r of await navigator.serviceWorker.getRegistrations()) if (new URL(r.scope).pathname.startsWith("/fitness/")) await r.unregister(); } catch (e) { /* none */ }
  try { for (const k of await caches.keys()) if (k.startsWith("fitness-")) await caches.delete(k); } catch (e) { /* none */ }
  const hash = new URLSearchParams(location.hash.slice(1));
  if (Object.keys(keep).length) {
    const packed = await new Response(new Blob([JSON.stringify(keep)]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer();
    let bin = ""; for (const b of new Uint8Array(packed)) bin += String.fromCharCode(b);
    hash.set("move", btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""));
  }
  const page = location.pathname.endsWith("/ride.html") ? "ride.html" : "";
  const target = to + page + location.search + (hash.toString() ? "#" + hash.toString() : "");
  document.getElementById("go").href = target;
  location.replace(target);
})();`;
  const policy = "default-src 'none'; script-src %SCRIPTS%; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${policy.replace("%SCRIPTS%", sha(script))}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Training has moved</title>
  <style>body{font:16px/1.5 "Helvetica Neue",Helvetica,Arial,sans-serif;margin:0;padding:32px 20px;background:#000;color:#f2efe8}a{color:#ff5a3c;font-weight:700}main{max-width:36rem;border-top:6px solid #f2efe8;padding-top:12px}</style>
</head>
<body>
  <main>
    <h1>Training has its own address now</h1>
    <p>So Android can install it as its own app, apart from the music app. Your settings on this phone come along.</p>
    <p><a id="go" href="${APP_URL}">Open Training at ${new URL(APP_URL).host}</a></p>
  </main>
  <script>${script}</script>
</body>
</html>
`;
  writeFileSync(join(dir, "index.html"), html);
  writeFileSync(join(dir, "ride.html"), html);
  // the old service worker, replaced by one that steps aside: it unregisters itself and reloads its pages, which forward
  writeFileSync(join(dir, "sw.js"), `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith("fitness-")) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url).catch(() => {});
})()));
`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) { console.error("usage: node fitness/build-app.mjs <dir>"); process.exit(2); }
  const { version, hasMap } = buildStandalone(out);
  console.log(`built the Training app into ${out}/ for ${APP_URL} · ${version}${hasMap ? "" : " · no map library (run npm ci)"}`);
}
