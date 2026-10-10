import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { FastifyReply, FastifyRequest } from "fastify";

const compress = promisify(gzip);
// Public analytics snapshots are shared across viewers. Compress each distinct
// representation once while cached per API process; retain at most 24 entries.
const compressed = new Map<string, Promise<Buffer>>();
// Read cache values are immutable snapshots. Reuse JSON + digest for every viewer.
const representations = new WeakMap<
  object,
  { json: string; hash: string; bytes: number }
>();
function representation(value: unknown) {
  if (value && typeof value === "object") {
    const cached = representations.get(value);
    if (cached) return cached;
  }
  const json = JSON.stringify(value);
  const result = {
    json,
    hash: createHash("sha256").update(json).digest("hex"),
    bytes: Buffer.byteLength(json),
  };
  if (value && typeof value === "object") representations.set(value, result);
  return result;
}
export async function analyticsResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  value: unknown,
) {
  const { json, hash, bytes } = representation(value);
  const acceptsGzip = (request.headers["accept-encoding"] ?? "")
    .split(",")
    .some((part) => {
      const [name, ...parameters] = part.trim().toLowerCase().split(";");
      const q = parameters.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return name === "gzip" && (!q || Number(q.slice(2)) > 0);
    });
  const useGzip = acceptsGzip && bytes >= 1024;
  const etag = `"${hash}${useGzip ? "-gzip" : ""}"`;
  reply.header("Cache-Control", "no-cache");
  reply.header("Vary", "Accept-Encoding, Origin");
  reply.header("ETag", etag);
  const tags = request.headers["if-none-match"]
    ?.split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""));
  if (tags?.includes(etag) || tags?.includes("*"))
    return reply.code(304).send();
  reply.type("application/json; charset=utf-8");
  if (!useGzip) return reply.send(json);
  let body = compressed.get(hash);
  if (!body) {
    body = compress(json, { level: 4 }).catch((error) => {
      compressed.delete(hash);
      throw error;
    });
    compressed.set(hash, body);
    if (compressed.size > 24)
      compressed.delete(compressed.keys().next().value!);
  } else {
    compressed.delete(hash);
    compressed.set(hash, body);
  }
  const encoded = await body;
  reply.header("Content-Encoding", "gzip");
  return reply.send(encoded);
}
