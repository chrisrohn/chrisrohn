// Ride mode for the public site: build.mjs calls this to write <out>/fitness/ride.html (chrisrohn.com/fitness/ride.html).
// One self-contained page assembled from fitness/site, holding none of anyone's data: a link from the fitness dashboard
// brings the zones and sessions in its #fragment. It shares an origin with the music app, so a Content-Security-Policy
// lets only its own inline scripts (by hash) run and nothing load. It stays out of the sitemap (noindex).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "site");

/** @param {string} out the site's build directory */
export function buildRide(out) {
  const part = (/** @type {string} */ f) => readFileSync(join(SITE, f), "utf8");
  let page = part("ride.html")   // function replacements: the sources contain `$` sequences String.replace would expand
    .replace("/*__STYLE__*/", () => part("style.css")).replace("/*__RIDE_STYLE__*/", () => part("ride.css"))
    .replace("/*__RIDE_APP__*/", () => part("ride.js")).replace("__RIDE_DATA__", "");
  const hashes = [...page.matchAll(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  if (hashes.length < 2 || !page.includes("__CSP__")) throw new Error("fitness/site/ride.html must carry a __CSP__ meta and its two inline scripts");
  page = page.replace("__CSP__", `default-src 'none'; script-src ${hashes.join(" ")}; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`);
  mkdirSync(join(out, "fitness"), { recursive: true });
  writeFileSync(join(out, "fitness", "ride.html"), page);
}
