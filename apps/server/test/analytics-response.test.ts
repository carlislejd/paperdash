import { gunzipSync } from "node:zlib";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { analyticsResponse } from "../src/analytics-response.js";

it("compresses repeated history fields, preserves JSON, revalidates snapshots and varies by encoding", async () => {
  const app = Fastify();
  let snapshot = {
    points: Array.from({ length: 600 }, (_, i) => ({
      time: 1800000000000 + i * 60000,
      longRaw: "1000000000000000000",
      shortRaw: "2000000000000000000",
      sourceBlock: null,
    })),
    stale: false,
  };
  app.get("/analytics", (request, reply) =>
    analyticsResponse(request, reply, snapshot),
  );
  try {
    const first = await app.inject({
      url: "/analytics",
      headers: { "accept-encoding": "gzip" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-encoding"]).toBe("gzip");
    expect(JSON.parse(gunzipSync(first.rawPayload).toString())).toEqual(
      snapshot,
    );
    expect(first.rawPayload.length).toBeLessThan(
      JSON.stringify(snapshot).length / 4,
    );
    expect(first.headers.vary).toContain("Origin");
    const same = await app.inject({
      url: "/analytics",
      headers: {
        "accept-encoding": "gzip",
        "if-none-match": String(first.headers.etag),
      },
    });
    expect(same.statusCode).toBe(304);
    expect(same.rawPayload.length).toBe(0);
    const plain = await app.inject({
      url: "/analytics",
      headers: { "accept-encoding": "gzip;q=0" },
    });
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.json()).toEqual(snapshot);
    expect(plain.headers.etag).not.toBe(first.headers.etag);
    snapshot = { ...snapshot, stale: true };
    const changed = await app.inject({
      url: "/analytics",
      headers: {
        "accept-encoding": "gzip",
        "if-none-match": String(first.headers.etag),
      },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(first.headers.etag);
    expect(JSON.parse(gunzipSync(changed.rawPayload).toString()).stale).toBe(
      true,
    );
  } finally {
    await app.close();
  }
});
