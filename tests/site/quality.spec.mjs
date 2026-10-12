// Quality gates on the built site, next to the smoke test: an axe-core accessibility scan of every page and the
// main views (WCAG 2.1 AA, no violations), and the files a crawler, a share sheet or an installed app asks for —
// robots.txt, sitemap.xml, canonical and social tags, the content-hashed assets index.html names, and the 404 page.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/** @param {import("@playwright/test").Page} page @param {string} path */
async function open(page, path) {
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  await page.goto(path);
  if (path === "/index.html" || path === "/") await expect(page.locator("#meta")).not.toHaveText(/loading feed/, { timeout: 15_000 });
  return errors;
}
/** WCAG 2.1 A and AA plus the best-practice rules, on what is on screen. @param {import("@playwright/test").Page} page */
async function scan(page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  return r.violations.map(v => `${v.id} (${v.impact}): ${v.help}\n` + v.nodes.slice(0, 5).map(n => "    " + n.target.join(" ") + " — " + n.failureSummary?.split("\n")[1]?.trim()).join("\n"));
}

test.describe("accessibility (axe-core, WCAG 2.1 AA)", () => {
  test("the feed, list view on a desktop", async ({ page }) => {
    await open(page, "/index.html");
    expect(await scan(page)).toEqual([]);
  });
  test("the feed, the deck on a phone, and the settings sheet", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await open(page, "/index.html");
    expect(await scan(page)).toEqual([]);
    await page.click("#settings-btn");
    await expect(page.locator("#settings")).toBeVisible();
    expect(await scan(page)).toEqual([]);
    await ctx.close();
  });
  test("the feed in the dark set", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const page = await ctx.newPage();
    await open(page, "/index.html");
    expect(await scan(page)).toEqual([]);
    await ctx.close();
  });
  for (const [name, path] of [["the Concerts tab", "concerts"], ["the Catalog tab", "catalog"], ["the Picks tab", "picks"]]) {
    test(name, async ({ page }) => {
      await open(page, `/index.html?view=${path}`);
      await page.waitForTimeout(500);
      expect(await scan(page)).toEqual([]);
    });
  }
  for (const path of ["/privacy.html", "/terms.html", "/404.html"]) {
    test(path, async ({ page }) => {
      const errors = await open(page, path);
      expect(errors).toEqual([]);
      expect(await scan(page)).toEqual([]);
    });
  }
  test("the skip link is the first tab stop and lands on the content", async ({ page }) => {
    await open(page, "/privacy.html");
    await page.keyboard.press("Tab");
    const skip = page.locator(".skip-link");
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);
  });
});

test.describe("what crawlers, share sheets and the installed app ask for", () => {
  test("robots.txt allows the site, hides the data files and names the sitemap", async ({ request }) => {
    const r = await request.get("/robots.txt");
    expect(r.ok()).toBeTruthy();
    const body = await r.text();
    expect(body).toMatch(/^User-agent: \*$/m);
    expect(body).toMatch(/^Disallow: \/data\/$/m);
    expect(body).toMatch(/^Sitemap: https:\/\/chrisrohn\.com\/sitemap\.xml$/m);
  });
  test("sitemap.xml lists the three pages, each of which is served", async ({ request }) => {
    const r = await request.get("/sitemap.xml");
    expect(r.ok()).toBeTruthy();
    expect(r.headers()["content-type"]).toMatch(/xml/);
    const xml = await r.text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    expect(locs).toEqual(["https://chrisrohn.com/", "https://chrisrohn.com/privacy.html", "https://chrisrohn.com/terms.html"]);
    expect(xml).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
    for (const loc of locs) expect((await request.get(new URL(loc).pathname)).ok(), loc).toBeTruthy();
  });
  for (const [path, canonical] of [["/index.html", "https://chrisrohn.com/"], ["/privacy.html", "https://chrisrohn.com/privacy.html"], ["/terms.html", "https://chrisrohn.com/terms.html"]]) {
    test(`${path}: title, description, canonical, social card and theme colours`, async ({ page }) => {
      await open(page, path);
      await expect(page).toHaveTitle(/New Music/);
      expect((await page.locator('meta[name="description"]').getAttribute("content") || "").length).toBeGreaterThan(50);
      expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toBe(canonical);
      expect(await page.locator('meta[property="og:title"]').getAttribute("content")).toMatch(/New Music/);
      expect(await page.locator('meta[property="og:image"]').getAttribute("content")).toMatch(/^https:\/\/chrisrohn\.com\/icons\//);
      expect(await page.locator('meta[name="twitter:card"]').getAttribute("content")).toBe("summary");
      expect(await page.locator('meta[name="theme-color"]').count()).toBeGreaterThan(0);
      expect(await page.locator('link[rel="manifest"]').getAttribute("href")).toBe("/manifest.webmanifest");
      expect(await page.locator("html").getAttribute("lang")).toBe("en");
    });
  }
  test("index.html carries structured data and the feed link", async ({ page }) => {
    await open(page, "/index.html");
    const ld = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent() || "{}");
    expect(ld["@graph"].map(n => n["@type"])).toEqual(["WebSite", "WebApplication", "Person"]);
    expect(await page.locator('link[rel="alternate"][type="application/rss+xml"]').getAttribute("href")).toBe("/feed.xml");
    expect(await page.locator('link[rel="sitemap"]').getAttribute("href")).toBe("/sitemap.xml");
  });
  test("every asset a page names is content-hashed, minified and served, and sw.js precaches those names", async ({ page, request }) => {
    await open(page, "/index.html");
    const app = await page.locator('script[src*="app."]').getAttribute("src");
    const css = await page.locator('link[rel="stylesheet"]').getAttribute("href");
    const theme = await page.locator('script[src*="theme."]').getAttribute("src");
    expect(app).toMatch(/^app\.[0-9a-f]{10}\.js$/);
    expect(css).toMatch(/^\/style\.[0-9a-f]{10}\.css$/);
    expect(theme).toMatch(/^\/theme\.[0-9a-f]{10}\.js$/);
    for (const f of [app, css, theme, app + ".map", theme + ".map"]) expect((await request.get("/" + f.replace(/^\//, ""))).ok(), f).toBeTruthy();
    const js = await (await request.get("/" + app)).text();
    expect(js.length / js.split("\n").length, "the bundle is minified (characters per line)").toBeGreaterThan(400);   // the sources average about 50
    const sw = await (await request.get("/sw.js")).text();
    expect(sw).not.toMatch(/__(APP_JS|STYLE_CSS|THEME_JS|BUILD)__/);
    for (const f of [app, css, theme]) expect(sw, f).toContain(`"/${f.replace(/^\//, "")}"`);
    // the unhashed copies stay for a page cached a moment before a deploy
    for (const f of ["/style.css", "/theme.js"]) expect((await request.get(f)).ok(), f).toBeTruthy();
    // the doc pages point at the same hashed files
    for (const p of ["/privacy.html", "/terms.html", "/404.html"]) {
      const html = await (await request.get(p)).text();
      expect(html, p).toContain(`href="${css}"`); expect(html, p).toContain(`src="${theme}"`);
    }
  });
  test("the 404 page is styled, themed, links home and is kept out of search", async ({ page }) => {
    const errors = await open(page, "/404.html");
    expect(errors).toEqual([]);
    await expect(page.locator("h2")).toHaveText(/404/);
    await expect(page.locator('a[href="/"]').first()).toBeVisible();
    expect(await page.locator('meta[name="robots"]').getAttribute("content")).toBe("noindex");
    await expect(page.locator("#theme-btn")).toBeVisible();
    await page.click("#theme-btn");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
  test("the manifest's id, scope, start_url and share target agree with the pages", async ({ request }) => {
    const m = await (await request.get("/manifest.webmanifest")).json();
    expect(m.id).toBe("/"); expect(m.scope).toBe("/"); expect(m.start_url.startsWith("/")).toBeTruthy();
    expect(m.display).toBe("standalone");
    expect(m.share_target?.action).toBe("/");
    expect(m.theme_color).toBe("#e7e3da"); expect(m.background_color).toBe("#e7e3da");
  });
});
