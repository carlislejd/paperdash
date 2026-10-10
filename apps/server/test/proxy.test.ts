import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { describe, expect, it } from "vitest";
import { trustProxy } from "../src/proxy.js";

describe("visitor identity behind Render and Cloudflare", () => {
  it.each([
    ["10.0.0.4", "192.0.2.99, 203.0.113.10, 104.16.1.2", "203.0.113.10"],
    [
      "::ffff:10.0.0.4",
      "192.0.2.99, 203.0.113.10, ::ffff:172.64.1.2",
      "203.0.113.10",
    ],
    ["fd00::1", "192.0.2.99, 2001:db8::10, 2606:4700::1", "2001:db8::10"],
    ["104.16.1.2", "192.0.2.99, 203.0.113.10", "104.16.1.2"],
    ["104.16.1.2", "192.0.2.99, 104.24.1.2", "104.16.1.2"],
    ["127.0.0.1", "192.0.2.99, 203.0.113.10", "203.0.113.10"],
    ["203.0.113.10", "192.0.2.99, 104.16.1.2", "203.0.113.10"],
    ["10.0.0.4", "192.0.2.99, 104.16.1.2, 104.24.1.2", "104.16.1.2"],
    ["10.0.0.4", "192.0.2.99, 10.0.0.5", "10.0.0.5"],
  ])(
    "resolves only the verified chain from %s",
    async (remoteAddress, forwarded, expected) => {
      const app = Fastify({ trustProxy });
      app.get("/identity", (request) => ({ ip: request.ip }));
      try {
        const response = await app.inject({
          url: "/identity",
          remoteAddress,
          headers: { "x-forwarded-for": forwarded },
        });
        expect(response.json()).toEqual({ ip: expected });
      } finally {
        await app.close();
      }
    },
  );

  it("separates visitors sharing an edge while forged prefixes cannot reset a visitor's limit", async () => {
    const app = Fastify({ trustProxy });
    await app.register(rateLimit, { max: 2, timeWindow: "1 minute" });
    app.get("/identity", (request) => ({ ip: request.ip }));
    const request = (visitor: string, prefix: string) =>
      app.inject({
        url: "/identity",
        remoteAddress: "10.0.0.4",
        headers: { "x-forwarded-for": `${prefix}, ${visitor}, 104.16.1.2` },
      });
    try {
      expect((await request("203.0.113.10", "192.0.2.1")).statusCode).toBe(200);
      expect((await request("203.0.113.10", "192.0.2.2")).statusCode).toBe(200);
      expect((await request("203.0.113.10", "192.0.2.3")).statusCode).toBe(429);
      const second = await request("203.0.113.11", "192.0.2.1");
      expect(second.statusCode).toBe(200);
      expect(second.json().ip).toBe("203.0.113.11");
    } finally {
      await app.close();
    }
  });
});
