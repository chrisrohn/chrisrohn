// The app's GitHub sync, against a stand-in for GitHub's API: connecting with a token (and refusing a public
// repository), loading what the scheduled sync left on the private repository's `state` branch, "Sync now",
// connecting Garmin with the code Garmin emails, and connecting Strava through its authorize page and back.
import { test, expect } from "@playwright/test";
import { DATA, watch, axe } from "./fixtures.mjs";

const REPO = "me/training-data";
const SYNCED = { synced: new Date().toISOString(), ok: true, garmin: { connected: true, days: 200, error: null }, strava: { connected: true, client_id: "4242", activities: 310, error: null } };
const FRESH = { synced: null, ok: true, garmin: { connected: false, days: 0, error: null }, strava: { connected: false, client_id: "4242", activities: 0, error: null } };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST", "Content-Type": "application/json" };

/** A tiny GitHub: the repository, its state branch's two files, workflow dispatches and runs. Each dispatch becomes a
 *  completed run named after its action; `onDispatch` can change the state branch as the real sync would.
 *  @param {import("@playwright/test").Page} page */
async function github(page, { status = SYNCED, data = DATA, isPrivate = true, onDispatch = /** @type {(inputs: any, gh: any) => void} */ (() => {}) } = {}) {
  const gh = { status, data, dispatches: /** @type {any[]} */ ([]), runs: /** @type {any[]} */ ([]) };
  await page.route("https://api.github.com/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const json = (body, code = 200) => route.fulfill({ status: code, headers: CORS, body: JSON.stringify(body) });
    if (req.headers().authorization !== "Bearer github_pat_good") return json({ message: "Bad credentials" }, 401);
    if (path === `/repos/${REPO}`) return json({ private: isPrivate, default_branch: "main" });
    if (path === `/repos/${REPO}/contents/status.json`) return gh.status ? json(gh.status) : json({ message: "Not Found" }, 404);
    if (path === `/repos/${REPO}/contents/fitness-data.json`) return gh.data ? json(gh.data) : json({ message: "Not Found" }, 404);
    if (path === `/repos/${REPO}/actions/workflows/training.yml/dispatches` && req.method() === "POST") {
      const body = req.postDataJSON();
      gh.dispatches.push(body);
      const { action, code } = body.inputs;
      gh.runs.unshift({ display_title: action === "garmin-code" ? `garmin-code ${code}` : action, created_at: new Date().toISOString(),
        status: "completed", conclusion: "success", html_url: `https://github.com/${REPO}/actions/runs/${gh.runs.length + 1}` });
      onDispatch(body.inputs, gh);
      return route.fulfill({ status: 204, headers: CORS });
    }
    if (path === `/repos/${REPO}/actions/workflows/training.yml/runs`) return json({ workflow_runs: gh.runs });
    return json({ message: "Not Found" }, 404);
  });
  return gh;
}
/** @param {import("@playwright/test").Page} page */
const signIn = page => page.evaluate(repo => localStorage.setItem("fitness-cloud", JSON.stringify({ repo, token: "github_pat_good", branch: "main" })), REPO);

test.describe("GitHub sync", () => {
  test("connecting with a token loads what the sync left, and refuses a bad token", async ({ page }) => {
    const problems = watch(page);
    await github(page);
    await page.goto("/fitness/");
    await page.locator(".welcome [data-action=settings]").click();
    await page.locator("#cloud-repo").fill("https://github.com/" + REPO);
    await page.locator("#cloud-token").fill("github_pat_wrong");
    await page.locator("#cloud-save").click();
    await expect(page.locator("#cloud-error")).toContainText("didn't accept the token");
    expect(await axe(page)).toEqual([]);
    await page.locator("#cloud-token").fill("github_pat_good");
    await page.locator("#cloud-save").click();
    await expect(page.locator("#load")).toBeVisible();
    await expect(page.locator("#databar")).toContainText("Synced");
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem("fitness-cloud") || "{}"))).toMatchObject({ repo: REPO, branch: "main" });
    expect(await axe(page)).toEqual([]);
    expect(problems.filter(p => !/401/.test(p))).toEqual([]);   // the refused token's 401 is the browser's own log line
  });

  test("health data only ever goes to a private repository", async ({ page }) => {
    await github(page, { isPrivate: false });
    await page.goto("/fitness/");
    await page.locator(".welcome [data-action=settings]").click();
    await page.locator("#cloud-repo").fill(REPO);
    await page.locator("#cloud-token").fill("github_pat_good");
    await page.locator("#cloud-save").click();
    await expect(page.locator("#cloud-error")).toContainText("public");
    expect(await page.evaluate(() => localStorage.getItem("fitness-cloud"))).toBeNull();
  });

  test("Sync now starts the workflow, follows the run and loads the new numbers", async ({ page }) => {
    const gh = await github(page, { onDispatch: (_i, g) => { g.status = { ...SYNCED, synced: new Date().toISOString() }; } });
    await page.goto("/fitness/");
    await signIn(page);
    await page.reload();
    await expect(page.locator("#load")).toBeVisible();
    await page.locator("#databar [data-action=sync]").click();
    await expect(page.locator("#job-text")).toContainText("Syncing");
    await expect.poll(() => gh.dispatches.length).toBe(1);
    expect(gh.dispatches[0]).toEqual({ ref: "main", inputs: { action: "sync", code: "" } });
    await expect(page.locator("#databar [data-action=sync]")).toBeVisible({ timeout: 15_000 });   // reloaded with the run's results
    await expect(page.locator("#load")).toBeVisible();
  });

  test("connecting Garmin: the code Garmin emails goes back as its own run", async ({ page }) => {
    const gh = await github(page, { status: FRESH, data: null, onDispatch: (inputs, g) => {
      if (inputs.action === "connect-garmin") g.runs[0].status = "in_progress";     // waits for the code…
      if (inputs.action === "garmin-code") {                                          // …which finishes the sign-in and the sync
        Object.assign(g.runs.find(r => r.display_title === "connect-garmin"), { status: "completed" });
        g.status = { ...SYNCED, strava: FRESH.strava };
        g.data = DATA;
      }
    } });
    await page.goto("/fitness/");
    await signIn(page);
    await page.reload();
    await expect(page.locator(".welcome")).toContainText("Garmin not connected");
    expect(await axe(page)).toEqual([]);
    await page.locator(".welcome [data-action=connect-garmin]").click();
    await expect(page.locator("#garmin-code")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.locator("#garmin-code").fill("482913");
    await page.locator("[data-action=send-code]").click();
    await expect.poll(() => gh.dispatches.map(d => d.inputs.action)).toEqual(["connect-garmin", "garmin-code"]);
    expect(gh.dispatches[1].inputs.code).toBe("482913");
    await expect(page.locator("#load")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#databar [data-action=connect-strava]")).toBeVisible();   // Strava still to do
  });

  test("connecting Strava: its authorize page, and the code it sends back starts connect-strava", async ({ page }) => {
    const gh = await github(page, { status: { ...SYNCED, strava: FRESH.strava } });
    await page.route("https://www.strava.com/**", route => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Strava</title>" }));
    await page.goto("/fitness/");
    await signIn(page);
    await page.reload();
    await page.locator("#databar [data-action=connect-strava]").click();
    await page.waitForURL(url => url.hostname === "www.strava.com");
    const auth = new URL(page.url());
    expect(Object.fromEntries(auth.searchParams)).toMatchObject({ client_id: "4242", response_type: "code", scope: "read,activity:read_all", state: "strava",
      redirect_uri: "http://127.0.0.1:8765/fitness/" });
    await page.goto("/fitness/?state=strava&code=abc123&scope=read,activity:read_all");
    await expect.poll(() => gh.dispatches.length).toBe(1);
    expect(gh.dispatches[0].inputs).toEqual({ action: "connect-strava", code: "abc123" });
    expect(new URL(page.url()).search).toBe("");                                     // the one-time code leaves the address bar
    await page.goto("/fitness/?state=strava&code=x&scope=read");                     // "private activities" unticked
    await expect(page.locator("#databar")).toContainText("private activities");
  });

  test("without Strava's secrets the app never asks for Strava (its API needs a paid subscription)", async ({ page }) => {
    await github(page, { status: { ...FRESH, strava: { connected: false, client_id: null, activities: 812, error: null,
      export: { file: "activities.csv", rows: 812, at: new Date().toISOString() } } }, data: null });
    await page.goto("/fitness/");
    await signIn(page);
    await page.reload();
    await expect(page.locator(".welcome [data-action=connect-garmin]")).toBeVisible();
    await expect(page.locator("[data-action=connect-strava]")).toHaveCount(0);
    await expect(page.locator(".welcome")).not.toContainText("Strava not connected");
    await expect(page.locator(".welcome")).toContainText("Strava history imported · 812 activities from activities.csv");
  });

  test("a failed sync says what went wrong, from status.json", async ({ page }) => {
    await github(page, { onDispatch: (_i, g) => { g.runs[0].conclusion = "failure"; g.status = { ...SYNCED, garmin: { ...SYNCED.garmin, error: "Garmin is rate-limiting this account" } }; } });
    await page.goto("/fitness/");
    await signIn(page);
    await page.reload();
    await page.locator("#databar [data-action=sync]").click();
    await expect(page.locator("#databar [role=alert]")).toContainText("Garmin: Garmin is rate-limiting this account", { timeout: 15_000 });
  });
});
