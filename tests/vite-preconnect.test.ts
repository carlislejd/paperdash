import { describe, expect, it } from "vitest";
import { apiConnectionHint } from "../vite.config";

async function tags(api: string | undefined, site = "https://papertrade.club") {
  const plugin = apiConnectionHint(api, site);
  expect(plugin.apply).toBe("build");
  const transform = plugin.transformIndexHtml;
  if (typeof transform !== "function")
    throw new Error("Missing HTML transform");
  return transform("", {} as never);
}

describe("production API connection hint", () => {
  it("connects only the configured API origin, preserving metadata and excluding paths", async () => {
    expect(await tags("https://api.example/base/")).toEqual([
      {
        tag: "link",
        attrs: {
          rel: "preconnect",
          href: "https://api.example",
          crossorigin: "anonymous",
        },
        injectTo: "head-prepend",
      },
    ]);
  });
  it.each([
    undefined,
    "",
    "/api",
    "not a URL",
    "https://papertrade.club",
    "data:text/plain,hello",
    "https://user:password@api.example",
  ])("does not speculate an unrelated connection for %s", async (value) => {
    expect(await tags(value)).toEqual([]);
  });
});
