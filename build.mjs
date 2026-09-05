// Builds the static site into dist/: bundles site/src/main.js (esbuild) into a content-hashed app.<hash>.js,
// rewrites index.html and sw.js to that name, and copies everything else in site/ as is (data/, icons, CSS, feed.xml).
// A hashed filename is what lets GitHub Pages cache app code for ten minutes without ever serving a stale bundle
// against a new index.html.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = "site", OUT = process.env.OUT_DIR || "dist";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(SRC, OUT, { recursive: true, filter: p => !p.replace(/\\/g, "/").includes("/site/src") });

const result = await build({
  entryPoints: [join(SRC, "src", "main.js")], outfile: join(OUT, "app.js"),
  bundle: true, format: "iife", target: ["es2022"], platform: "browser",
  minify: false, sourcemap: true, write: false, legalComments: "none", charset: "utf8",
  banner: { js: "/* Chris Rohn's New Music — built from site/src by build.mjs; edit the sources, not this file. */" },
});
const js = result.outputFiles.find(f => f.path.endsWith(".js"));
const map = result.outputFiles.find(f => f.path.endsWith(".map"));
const hash = createHash("sha256").update(js.contents).digest("hex").slice(0, 10);
const name = `app.${hash}.js`;
writeFileSync(join(OUT, name), js.text.replace(/\/\/# sourceMappingURL=.*$/m, `//# sourceMappingURL=${name}.map`));
if (map) writeFileSync(join(OUT, name + ".map"), map.text);
if (existsSync(join(OUT, "app.js"))) rmSync(join(OUT, "app.js"));

const html = readFileSync(join(SRC, "index.html"), "utf8");
if (!html.includes('src="app.js"')) throw new Error("site/index.html must reference app.js");
writeFileSync(join(OUT, "index.html"), html.replace('src="app.js"', `src="${name}"`));
const sw = readFileSync(join(SRC, "sw.js"), "utf8");
if (!sw.includes("__APP_JS__") || !sw.includes("__BUILD__")) throw new Error("site/sw.js must contain __APP_JS__ and __BUILD__");
writeFileSync(join(OUT, "sw.js"), sw.replaceAll("__APP_JS__", "/" + name).replaceAll("__BUILD__", hash));
console.log(`built ${OUT}/ · ${name} (${(js.contents.length / 1024).toFixed(0)} KB)`);
