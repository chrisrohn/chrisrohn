// The installable Training app. It lives on an origin of its own ([app] url in fitness/config.toml, https://chris.bike/),
// apart from the music app: Android installs one app per scope, and the music app's scope is all of chrisrohn.com, so a
// training app under chrisrohn.com/fitness/ could only ever "open in New Music".
//
//   buildStandalone(out)  the whole app at <out>/ — what the app's own site serves:
//     index.html          the dashboard shell — holds no one's data; a phone link or a data file brings it, kept on the device
//     ride.html           ride mode, the cycling computer (ride-core.js + ride.js inlined)
//     move.html           the other end of a move from an old address (move-in.js)
//     vendor/             MapLibre GL, for the map (loaded only on the Map screen)
//     manifest.webmanifest, sw.js, icons/, fonts/, .nojekyll, robots.txt   installable, offline, not indexed
//     CNAME               the custom domain, when the site is the app's own ({ cname: true })
//   buildForward(out)     an old address's whole site (chrisrohn.github.io): every page carries what this phone kept
//                         there to the app (move-out.js), retires the old service worker, and forwards
//   buildApp(out)         <out>/fitness/ on chrisrohn.com: the same, for the address before that
//
// Every page carries a Content-Security-Policy (fitness/site/csp.txt): only its own inline scripts (by hash) and its
// own files run, and it talks only to GitHub's API, Open-Meteo, OpenFreeMap's tiles and the BRouter router.
//
//   node fitness/build-app.mjs <dir>                  the app, without a CNAME (tests, a local copy)
//   node fitness/build-app.mjs --role <owner/repo>    what that repository's Pages site serves: app | standby | forward
//   node fitness/build-app.mjs --as <role> <dir>      builds it (what the sites' deploy workflow runs, fitness/cloud/app-site.yml)
//
// The roles: a repository named after the app's host (chrisrohn/chris.bike) is the app, with its CNAME. The owner's
// github.io repository forwards to it, but only once the app answers at its address with a move.html: until then it
// stays "standby", the app itself without a CNAME, so a phone never forwards to an address that isn't there yet.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "site");
const part = (/** @type {string} */ f) => readFileSync(join(SITE, f), "utf8");
export const POLICY = part("csp.txt").trim();
const slash = (/** @type {string} */ u) => (u.endsWith("/") ? u : u + "/");
const APP_SECTION = (readFileSync(join(HERE, "config.toml"), "utf8").match(/^\[app\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m) || ["", ""])[1];
/** Where the app lives: [app] url in fitness/config.toml (FITNESS_APP_URL overrides it). */
export const APP_URL = slash(process.env.FITNESS_APP_URL || (APP_SECTION.match(/^url\s*=\s*"([^"]*)"/m) || [])[1] || "https://chris.bike/");
/** The app's earlier addresses, whose pages may hand a move to this one: [app] moved_from (FITNESS_MOVED_FROM, comma-separated, overrides it). */
export const MOVED_FROM = (process.env.FITNESS_MOVED_FROM
  ? process.env.FITNESS_MOVED_FROM.split(",")
  : [...((APP_SECTION.match(/^moved_from\s*=\s*\[([^\]]*)\]/m) || [])[1] || "").matchAll(/"([^"]+)"/g)].map(m => m[1])).map(u => slash(u.trim())).filter(Boolean);
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
  const ride = lockDown(part("ride.html").replace("/*__COMMON__*/", () => part("common.js")).replace("/*__STYLE__*/", () => part("style.css")).replace("/*__RIDE_STYLE__*/", () => part("ride.css"))
    .replace("/*__RIDE_CORE__*/", () => part("ride-core.js")).replace("/*__RIDE_APP__*/", () => part("ride.js")).replace("__RIDE_DATA__", ""));
  const index = lockDown(part("index.html").replace("/*__COMMON__*/", () => part("common.js")).replace("/*__STYLE__*/", () => part("style.css")).replace("/*__SHELL__*/", () => part("shell.js"))
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

/** A small page of the app's own look that runs one inline script under a policy allowing only it. */
function shell(/** @type {string} */ title, /** @type {string} */ body, /** @type {string} */ script, /** @type {string} */ head = "") {
  const policy = `default-src 'none'; script-src ${sha(script)}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${policy}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#000000">${head}
  <title>${title}</title>
  <style>body{font:16px/1.5 "Helvetica Neue",Helvetica,Arial,sans-serif;margin:0;padding:32px 20px;background:#000;color:#f2efe8}a{color:#ff5a3c;font-weight:700}main{max-width:36rem;border-top:6px solid #f2efe8;padding-top:12px}#note{color:#bdb8ad}</style>
</head>
<body>
  <main>
${body}
  </main>
  <script>${script}</script>
</body>
</html>
`;
}

/** move.html on the app's address: takes a move from an old one (move-in.js). The meta marks it, so an old address
 *  only starts forwarding once this answers (role()). */
export function movePage() {
  const script = part("move-in.js").replace('["__FROM__"]', () => JSON.stringify(MOVED_FROM));
  return shell("Training · moving in", `    <h1>Moving in</h1>
    <p id="note" role="status">Bringing this phone's rides, routes and settings along…</p>
    <p><a href="./">Open Training</a></p>`, script, `\n  <meta name="fitness-move" content="1">`);
}

/** The whole app at <out>/. `cname`: write the Pages CNAME for a custom domain (only the app's own site does).
 *  @param {string} out @param {{ cname?: boolean }} [opt] */
export function buildStandalone(out, { cname = false } = {}) {
  mkdirSync(out, { recursive: true });
  const { ride, index } = pages();
  const manifest = part("manifest.webmanifest");
  JSON.parse(manifest);   // fail the build, not the install, on a broken manifest
  const hasMap = vendor(out);
  const move = movePage();
  const version = createHash("sha256").update(index).update(ride).update(move).update(manifest).update(String(hasMap)).digest("hex").slice(0, 10);
  writeFileSync(join(out, "index.html"), index);
  writeFileSync(join(out, "ride.html"), ride);
  writeFileSync(join(out, "move.html"), move);
  writeFileSync(join(out, "manifest.webmanifest"), manifest);
  writeFileSync(join(out, "sw.js"), part("sw.js").replaceAll("__VERSION__", version));
  writeFileSync(join(out, ".nojekyll"), "");
  writeFileSync(join(out, "robots.txt"), "User-agent: *\nDisallow: /\n");
  writeFileSync(join(out, "404.html"), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Training</title><p style="font:16px/1.5 system-ui,sans-serif;padding:24px">Nothing here. <a href="./">Open Training</a>.</p>\n`);
  const host = new URL(APP_URL).hostname;
  if (cname && !host.endsWith(".github.io")) writeFileSync(join(out, "CNAME"), host + "\n");   // the custom domain for the app's Pages site
  cpSync(join(SITE, "icons"), join(out, "icons"), { recursive: true });
  cpSync(join(SITE, "fonts"), join(out, "fonts"), { recursive: true });   // Nimbus Sans L, the Helvetica on Android and Windows
  return { version, hasMap };
}

/** An old address's page (index.html, ride.html, move.html and 404.html are all this): it carries what this phone kept
 *  at `base` to the app and forwards (move-out.js). @param {string} base this copy's path, e.g. "/" or "/fitness/" */
export function forwardPage(base) {
  const script = part("move-out.js").replace('"__APP_URL__"', () => JSON.stringify(APP_URL)).replace('"__BASE__"', () => JSON.stringify(base));
  const host = new URL(APP_URL).host;
  return shell("Training has moved", `    <h1>Training lives at ${host} now</h1>
    <p>Same app, new address. Everything this phone kept here comes along: the GitHub connection, settings, routes and rides.</p>
    <p id="note" role="status"></p>
    <p><a id="go" href="${APP_URL}">Open Training at ${host}</a></p>
    <p>Then install it from there (Chrome → Install) and remove the old icon.</p>`, script);
}
/** The old service worker, replaced by one that steps aside: it unregisters itself and reloads its pages, which forward. */
const STEP_ASIDE = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith("fitness-")) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url).catch(() => {});
})()));
`;
/** @param {string} dir @param {string} base */
function writeForward(dir, base) {
  mkdirSync(dir, { recursive: true });
  const html = forwardPage(base);
  for (const f of ["index.html", "ride.html", "move.html"]) writeFileSync(join(dir, f), html);
  writeFileSync(join(dir, "sw.js"), STEP_ASIDE);
  return html;
}

/** An old address's whole Pages site (the owner's github.io): every path forwards, carrying the phone's data. @param {string} out */
export function buildForward(out) {
  const html = writeForward(out, "/");
  writeFileSync(join(out, "404.html"), html);   // an old bookmark or shortcut anywhere on the site
  writeFileSync(join(out, ".nojekyll"), "");
  writeFileSync(join(out, "robots.txt"), "User-agent: *\nDisallow: /\n");
}

/** chrisrohn.com/fitness/, the address before that: same pages, same job. @param {string} out */
export function buildApp(out) {
  writeForward(join(out, "fitness"), "/fitness/");
}

/** What a repository's Pages site serves (see the top of this file). @param {string} repo owner/name */
export async function role(repo) {
  const [owner, name] = repo.toLowerCase().split("/");
  const host = new URL(APP_URL).hostname.toLowerCase();
  if (name === host) return "app";
  if (name !== `${owner}.github.io`) throw new Error(`${repo} is neither the app's site (a repository named ${host}) nor ${owner}.github.io`);
  try {
    const res = await fetch(APP_URL + "move.html", { signal: AbortSignal.timeout(20_000) });
    if (res.ok && (await res.text()).includes('name="fitness-move"')) return "forward";
  } catch { /* not there yet */ }
  return "standby";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (/** @type {string} */ f) => { const i = args.indexOf(f); return i < 0 ? null : args.splice(i, 2)[1] || ""; };
  const repo = flag("--role"), as = flag("--as") || "standby", out = args[0];
  if (repo != null) {
    console.log(await role(repo));
  } else if (!out || !["app", "standby", "forward"].includes(as)) {
    console.error("usage: node fitness/build-app.mjs [--as app|standby|forward] <dir>  ·  node fitness/build-app.mjs --role <owner/repo>");
    process.exit(2);
  } else if (as === "forward") {
    buildForward(out);
    console.log(`built the forwarder into ${out}/ · every page carries this phone's data to ${APP_URL}`);
  } else {
    const { version, hasMap } = buildStandalone(out, { cname: as === "app" });
    console.log(`built the Training app into ${out}/ for ${APP_URL} (${as}) · ${version}${hasMap ? "" : " · no map library (run npm ci)"}`);
  }
}
