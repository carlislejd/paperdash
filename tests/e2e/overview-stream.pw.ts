import { expect, test } from "@playwright/test";
import { mockSources, overview } from "./fixtures";

test("healthy overview stream replaces duplicate polling and switches topics with one active connection", async ({
  page,
}) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const sources: {
      url: string;
      closed: boolean;
      onmessage: ((event: { data: string }) => void) | null;
      onerror: (() => void) | null;
    }[] = [];
    class Source {
      closed = false;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) {
        sources.push(this);
        queueMicrotask(() => this.onopen?.());
      }
      close() {
        this.closed = true;
      }
    }
    Object.assign(window, {
      EventSource: Source,
      inspectSources: () =>
        sources.map((s) => ({ url: s.url, closed: s.closed })),
      emitOverview: (data: unknown) =>
        sources
          .filter((s) => !s.closed)
          .forEach((s) =>
            s.onmessage?.({ data: JSON.stringify({ type: "overview", data }) }),
          ),
      failStream: () =>
        sources.filter((s) => !s.closed).forEach((s) => s.onerror?.()),
    });
  });
  await mockSources(page);
  let reads = 0;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/overview") reads++;
  });
  await page.goto("/");
  const emit = () =>
    page.evaluate(
      (data) =>
        (
          window as unknown as { emitOverview: (data: unknown) => void }
        ).emitOverview(data),
      overview(),
    );
  const connections = () =>
    page.evaluate(() =>
      (
        window as unknown as {
          inspectSources: () => { url: string; closed: boolean }[];
        }
      ).inspectSources(),
    );
  await emit();
  await expect(
    page.getByRole("region", { name: "Protocol overview" }),
  ).toContainText("$66.32M");
  await page.clock.fastForward(60001);
  expect(reads).toBe(0);
  expect((await connections()).filter((s) => !s.closed)).toHaveLength(1);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Assets", exact: true })
    .click();
  await emit();
  const active = (await connections()).filter((s) => !s.closed);
  expect(active).toHaveLength(1);
  expect(new URL(active[0].url, "http://test").searchParams.get("topics")).toBe(
    "overview,asset:0",
  );
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Liquidations", exact: true })
    .click();
  await emit();
  expect(
    new URL(
      (await connections()).find((s) => !s.closed)!.url,
      "http://test",
    ).searchParams.get("topics"),
  ).toBe("overview,liquidations");
  await page.evaluate(() =>
    (window as unknown as { failStream: () => void }).failStream(),
  );
  expect((await connections()).filter((s) => !s.closed)).toHaveLength(0);
  await page.clock.fastForward(2000);
  expect((await connections()).filter((s) => !s.closed)).toHaveLength(1);
  await page.clock.fastForward(31000);
  expect(reads).toBeGreaterThan(0);
});
