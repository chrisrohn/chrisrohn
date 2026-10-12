// Shared by the fitness specs: a synthetic athlete's dashboard data (the same pipeline as `python -m fitness demo`),
// the console watcher, and the axe scan.
import AxeBuilder from "@axe-core/playwright";
import { execFileSync } from "node:child_process";

export const DATA = JSON.parse(execFileSync("python3", ["-c", `
import json, sys, tempfile
from datetime import date
from pathlib import Path
from fitness import build, config, demo
from fitness.store import Store
cfg = config.load()
with tempfile.TemporaryDirectory() as tmp, Store(Path(tmp) / "d.db") as store:
    demo.populate(store, date.today(), days=200)
    data = build.assemble(cfg, store.days(), store.activities(), date.today())
sys.stdout.write(json.dumps(build.phone_data(data)))
`], { cwd: new URL("../..", import.meta.url), maxBuffer: 64 << 20 }).toString());

/** Page errors, console errors and CSP violations, collected for an `expect(...).toEqual([])` at the end. @param {import("@playwright/test").Page} page */
export function watch(page) {
  const problems = [];
  page.on("pageerror", e => problems.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error" || /Content Security Policy/i.test(m.text())) problems.push(m.text()); });
  return problems;
}

/** WCAG 2.1 AA + best-practice violations on the page as it stands. @param {import("@playwright/test").Page} page */
export async function axe(page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  return r.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(", ")}`);
}
