import type { FastifyReply, FastifyRequest } from "fastify";

const snapshots = new Set([
  "/api/overview",
  "/api/assets",
  "/api/assets/0/market",
  "/api/assets/1/market",
  ...[0, 1].flatMap((instrument) =>
    ["5m", "15m", "1h"].map(
      (window) => `/api/assets/${instrument}/market?window=${window}`,
    ),
  ),
  "/api/house",
  "/api/protocol/charts",
  "/api/paper/economics",
  "/api/position-metrics",
  "/api/liquidations/stats",
]);

/** Opt in only shared snapshots and fixed chart-window variants. Browser revalidation stays separate. */
export function applyEdgeCachePolicy(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigins: readonly string[],
) {
  const origin = request.headers.origin;
  const hasCredentials =
    request.headers.authorization !== undefined ||
    request.headers.cookie !== undefined ||
    reply.hasHeader("set-cookie");
  const allowedOrigin =
    origin === undefined ||
    (allowedOrigins.includes(origin) &&
      reply.getHeader("access-control-allow-origin") === origin);
  const eligible =
    (request.method === "GET" || request.method === "HEAD") &&
    (reply.statusCode === 200 || reply.statusCode === 304) &&
    snapshots.has(request.raw.url ?? "") &&
    allowedOrigin &&
    !hasCredentials;
  // Render's native CDN gives this header precedence over Cache-Control.
  // No stale-while-revalidate/error grace: the maximum edge freshness is 1s.
  reply.header(
    "CDN-Cache-Control",
    eligible ? "public, s-maxage=1, must-revalidate" : "no-store",
  );
  if (hasCredentials || !reply.hasHeader("cache-control"))
    reply.header("Cache-Control", "no-store");
}
