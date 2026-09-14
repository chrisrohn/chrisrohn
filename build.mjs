// Builds the static site into dist/: bundles site/src/main.js (esbuild, minified, with a source map) into a
// content-hashed app.<hash>.js, minifies style.css and theme.js into style.<hash>.css and theme.<hash>.js, rewrites
// every page and sw.js to those names, writes sitemap.xml, and copies everything else in site/ as is (data/, icons,
// feed.xml, robots.txt). A hashed filename is what lets GitHub Pages cache app code, styles and the pre-paint theme
// script for ten minutes without ever serving a stale copy against a new index.html; the unhashed style.css and
// theme.js are kept too, so an index.html a browser cached a minute before a deploy still finds its files.
import { build, transform } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = "site", OUT = process.env.OUT_DIR || "dist";
const ORIGIN = "https://chrisrohn.com";
const PAGES = ["index.html", "privacy.html", "terms.html", "404.html"];
const hashOf = (/** @type {string | Uint8Array} */ s) => createHash("sha256").update(s).digest("hex").slice(0, 10);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(SRC, OUT, { recursive: true, filter: p => !/(^|\/)site\/src(\/|$)/.test(p.replace(/\\/g, "/")) });   // the sources are bundled, never deployed

// the app bundle
const result = await build({
  entryPoints: [join(SRC, "src", "main.js")], outfile: join(OUT, "app.js"),
  bundle: true, format: "iife", target: ["es2022"], platform: "browser",
  minify: true, sourcemap: true, write: false, legalComments: "none", charset: "utf8",
  banner: { js: "/* Chris Rohn's New Music — built from site/src by build.mjs; edit the sources, not this file. */" },
});
const js = result.outputFiles.find(f => f.path.endsWith(".js"));
const map = result.outputFiles.find(f => f.path.endsWith(".map"));
const hash = hashOf(js.contents);
const appName = `app.${hash}.js`;
writeFileSync(join(OUT, appName), js.text.replace(/\/\/# sourceMappingURL=.*$/m, `//# sourceMappingURL=${appName}.map`));
if (map) writeFileSync(join(OUT, appName + ".map"), map.text);
if (existsSync(join(OUT, "app.js"))) rmSync(join(OUT, "app.js"));

// the stylesheet and the pre-paint theme script: minified and hashed the same way
/** @param {string} file @param {"css" | "js"} loader */
async function asset(file, loader) {
  const source = readFileSync(join(SRC, file), "utf8");
  const out = await transform(source, { loader, minify: true, target: ["es2022"], charset: "utf8", legalComments: "none", sourcemap: loader === "js" ? "external" : false, sourcefile: file });
  const h = hashOf(out.code);
  const name = file.replace(/\.(css|js)$/, `.${h}.$1`);
  writeFileSync(join(OUT, name), loader === "js" ? `${out.code}\n//# sourceMappingURL=${name}.map\n` : out.code);
  if (out.map) writeFileSync(join(OUT, name + ".map"), out.map);
  writeFileSync(join(OUT, file), out.code);   // the unhashed copy, for the ten-minute window
  return name;
}
const styleName = await asset("style.css", "css");
const themeName = await asset("theme.js", "js");

// every page points at the hashed files
for (const page of PAGES) {
  const path = join(SRC, page);
  if (!existsSync(path)) throw new Error(`site/${page} is missing`);
  let html = readFileSync(path, "utf8");
  if (page === "index.html") {
    if (!html.includes('src="app.js"')) throw new Error("site/index.html must reference app.js");
    html = html.replace('src="app.js"', `src="${appName}"`);
  }
  if (!html.includes('href="style.css"') && !html.includes('href="/style.css"')) throw new Error(`site/${page} must reference style.css`);
  if (!html.includes('src="/theme.js"')) throw new Error(`site/${page} must reference /theme.js`);
  html = html.replace(/href="\/?style\.css"/, `href="/${styleName}"`).replace('src="/theme.js"', `src="/${themeName}"`);
  writeFileSync(join(OUT, page), html);
}

// the service worker precaches exactly these names
const sw = readFileSync(join(SRC, "sw.js"), "utf8");
for (const tag of ["__APP_JS__", "__STYLE_CSS__", "__THEME_JS__", "__BUILD__"]) if (!sw.includes(tag)) throw new Error(`site/sw.js must contain ${tag}`);
writeFileSync(join(OUT, "sw.js"), sw.replaceAll("__APP_JS__", "/" + appName).replaceAll("__STYLE_CSS__", "/" + styleName).replaceAll("__THEME_JS__", "/" + themeName).replaceAll("__BUILD__", hash));

// the sitemap: the pages a search engine should index, dated by this build (the feed changes daily)
const today = new Date().toISOString().slice(0, 10);
const urls = [["/", "daily", "1.0"], ["/privacy.html", "monthly", "0.3"], ["/terms.html", "monthly", "0.3"]];
writeFileSync(join(OUT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([p, f, pr]) => `  <url><loc>${ORIGIN}${p}</loc><lastmod>${today}</lastmod><changefreq>${f}</changefreq><priority>${pr}</priority></url>`).join("\n")}\n</urlset>\n`);

const size = (/** @type {string} */ f) => (readFileSync(join(OUT, f)).length / 1024).toFixed(0) + " KB";
console.log(`built ${OUT}/ · ${appName} (${size(appName)}) · ${styleName} (${size(styleName)}) · ${themeName} (${size(themeName)}) · ${readdirSync(OUT).length} entries`);
