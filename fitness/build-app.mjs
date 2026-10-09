// The installable app for the public site: build.mjs calls this to write <out>/fitness/ (chrisrohn.com/fitness/):
//   index.html  the dashboard shell — holds no one's data; a phone link or a data file brings it, kept on the device
//   ride.html   ride mode
//   manifest.webmanifest, sw.js, icons/   what makes it installable and offline
// Both pages share an origin with the music app, so each carries a Content-Security-Policy that lets only its own
// inline scripts (by hash) run and loads nothing but its own files. noindex, and not in the sitemap.
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "site");
const part = (/** @type {string} */ f) => readFileSync(join(SITE, f), "utf8");
export const POLICY = "default-src 'none'; script-src %SCRIPTS%; style-src 'unsafe-inline'; img-src 'self' data:; connect-src https://api.github.com; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'";

/** @param {string} page */
function lockDown(page) {
  const hashes = [...page.matchAll(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  if (hashes.length < 2 || !page.includes("__CSP__")) throw new Error("fitness/site pages must carry a __CSP__ meta and their inline scripts");
  return page.replace("__CSP__", POLICY.replace("%SCRIPTS%", hashes.join(" ")));
}

/** @param {string} out the site's build directory */
export function buildApp(out) {
  const dir = join(out, "fitness");
  mkdirSync(dir, { recursive: true });
  // function replacements: the sources contain `$` sequences String.replace would expand
  const ride = lockDown(part("ride.html").replace("/*__STYLE__*/", () => part("style.css")).replace("/*__RIDE_STYLE__*/", () => part("ride.css"))
    .replace("/*__RIDE_APP__*/", () => part("ride.js")).replace("__RIDE_DATA__", ""));
  const index = lockDown(part("index.html").replace("/*__STYLE__*/", () => part("style.css")).replace("/*__SHELL__*/", () => part("shell.js"))
    .replace("/*__APP__*/", () => part("app.js")).replace("__DATA__", ""));
  const manifest = part("manifest.webmanifest");
  JSON.parse(manifest);   // fail the build, not the install, on a broken manifest
  const version = createHash("sha256").update(index).update(ride).update(manifest).digest("hex").slice(0, 10);
  writeFileSync(join(dir, "index.html"), index);
  writeFileSync(join(dir, "ride.html"), ride);
  writeFileSync(join(dir, "manifest.webmanifest"), manifest);
  writeFileSync(join(dir, "sw.js"), part("sw.js").replaceAll("__VERSION__", version));
  cpSync(join(SITE, "icons"), join(dir, "icons"), { recursive: true });
}
