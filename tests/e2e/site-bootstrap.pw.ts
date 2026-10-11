import { test as base, expect, type Page, type Route } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mockSources, WALLET } from "./fixtures";

const canonical = "https://canonical.example";
const legacy = "https://paperdash-web.onrender.com";
const api = "https://api.example";
const beacon = "https://static.cloudflareinsights.com/beacon.min.js";
const repository = fileURLToPath(new URL("../../", import.meta.url));

const test = base.extend<{}, { productionBuild: string }>({
  productionBuild: [
    async ({}, use) => {
      const directory = await mkdtemp(
        join(tmpdir(), "paperdash-bootstrap-browser-"),
      );
      try {
        await promisify(execFile)(
          process.execPath,
          [
            join(repository, "node_modules/vite/bin/vite.js"),
            "build",
            "--outDir",
            directory,
            "--emptyOutDir",
          ],
          {
            cwd: repository,
            env: {
              ...process.env,
              NODE_ENV: "production",
              VITE_SITE_URL: canonical,
              VITE_CF_WEB_ANALYTICS_TOKEN: "0123456789abcdef0123456789abcdef",
              VITE_API_URL: api,
            },
            maxBuffer: 1024 * 1024,
          },
        );
        await use(directory);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    { scope: "worker", timeout: 60000 },
  ],
});

/** Keep the shared API fixtures while adding real cross-origin response headers. */
async function mockCrossOriginSources(page: Page) {
  await mockSources({
    route: async (
      pattern: Parameters<Page["route"]>[0],
      handler: (route: Route) => Promise<void>,
    ) => {
      await page.route(pattern, async (route) => {
        const corsRoute = new Proxy(route, {
          get(target, property) {
            if (property === "fulfill")
              return (options: Parameters<Route["fulfill"]>[0]) =>
                target.fulfill({
                  ...options,
                  headers: {
                    ...options?.headers,
                    "Access-Control-Allow-Origin": canonical,
                  },
                });
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        await handler(corsRoute);
      });
    },
  } as Page);
}

test("production bootstrap redirects before data/tracking and initializes one canonical beacon", async ({
  page,
  productionBuild,
}) => {
  const unexpected: string[] = [];
  const requests: { url: string; pageUrl: string; referrer: string }[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(api) || request.url().startsWith(beacon))
      requests.push({
        url: request.url(),
        pageUrl: request.frame().url(),
        referrer: request.headers().referer ?? "",
      });
  });

  // Every request is intercepted, including production modules/fonts/images.
  // Unknown hosts fail closed rather than contacting the public network.
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (![canonical, legacy].includes(url.origin)) {
      unexpected.push(request.url());
      await route.abort();
      return;
    }
    const path =
      request.resourceType() === "document"
        ? join(productionBuild, "index.html")
        : resolve(productionBuild, `.${decodeURIComponent(url.pathname)}`);
    if (!path.startsWith(`${productionBuild}${sep}`)) {
      await route.abort();
      return;
    }
    const mime: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".woff2": "font/woff2",
      ".ico": "image/x-icon",
    };
    try {
      await route.fulfill({
        status: 200,
        contentType: mime[extname(path)] ?? "application/octet-stream",
        body: await readFile(path),
        headers: { "Referrer-Policy": "strict-origin-when-cross-origin" },
      });
    } catch {
      await route.fulfill({ status: 404, body: "Missing test build asset" });
    }
  });
  await mockCrossOriginSources(page);
  await page.route(beacon, (route) =>
    route.fulfill({
      contentType: "text/javascript",
      headers: { "Access-Control-Allow-Origin": canonical },
      body: "globalThis.__paperdashBeaconLoads = (globalThis.__paperdashBeaconLoads || 0) + 1;",
    }),
  );

  const suffix = `/shared/deep%2Flink?view=assets&asset=1&wallet=${WALLET}&note=a%26b#saved-chart`;
  await page.goto(`${legacy}${suffix}`);
  await expect(page).toHaveURL(`${canonical}${suffix}`);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __paperdashBeaconLoads?: number })
            .__paperdashBeaconLoads,
      ),
    )
    .toBe(1);
  await expect
    .poll(
      () =>
        requests.filter(
          (request) =>
            new URL(request.url).origin === api &&
            new URL(request.url).pathname === "/api/events",
        ).length,
    )
    .toBeGreaterThan(0);

  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    `${canonical}/`,
  );
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
    "content",
    `${canonical}/`,
  );
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    `${canonical}/art/paperclub-social-v4.png`,
  );
  await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute(
    "content",
    `${canonical}/art/paperclub-social-v4.png`,
  );
  await expect(page.locator("script[data-cf-beacon]")).toHaveCount(1);
  await expect(page.locator("script[data-cf-beacon]")).toHaveAttribute(
    "type",
    "module",
  );

  await page.getByRole("button", { name: "Close wallet details" }).click();
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation
    .getByRole("button", { name: "Overview", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Protocol overview" }),
  ).toBeVisible();
  await navigation.getByRole("button", { name: "Assets", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Assets", exact: true }),
  ).toBeVisible();

  // The redirected document never mounted React or opened an SSE/API request.
  // Normal SPA navigation also leaves the single production beacon in place.
  expect(requests.length).toBeGreaterThan(2);
  for (const request of requests) {
    expect(new URL(request.pageUrl).origin).toBe(canonical);
    expect(new URL(request.referrer).origin).toBe(canonical);
  }
  expect(requests.filter((request) => request.url === beacon)).toHaveLength(1);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __paperdashBeaconLoads?: number })
          .__paperdashBeaconLoads,
    ),
  ).toBe(1);
  expect(unexpected).toEqual([]);
});
