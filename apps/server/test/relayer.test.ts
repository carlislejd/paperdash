import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { prepareRelayerIntent, readRelayerQueueRanks, RELAYER_REFERENCE, submitSignedRelayerIntent,
  verifyRelayerProtocol, type RelayerIntent } from "../src/relayer.js";

// Large third-party bundles are represented by fingerprints/excerpts in the evidence.
// Stub their known digest only; small protocol files and all changed bodies are really hashed.
vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  const snapshots: Record<string, string> = {
    "fixture:app": "a33fc666ef399f226862ea5e03930409ee6db6d262a1f7e9ef57fe61b6a433d9",
    "fixture:hooks": "adede39fbffcaa7a6088a51eec792006cea1635d045a3560a8bb0167c0b1cf58",
  };
  return { ...crypto, createHash: (algorithm: string) => ({
    update: (body: string) => ({ digest: (encoding: "hex") => snapshots[body] ?? crypto.createHash(algorithm).update(body).digest(encoding) }),
  }) };
});

const now = 1800000000000;
const wallet = "0x1234567890123456789012345678901234567890";
const id = "0x" + "12".repeat(32);
const signature = { v: "27" as const, r: "0x" + "34".repeat(32), s: "0x" + "56".repeat(32) };
const base = { user: wallet, nonce: "900719925474099312345", deadline: String(now / 1000 + 3600) };
const open: RelayerIntent = { action: "openPosition", ...base, instrumentId: "0", isLong: true,
  size: "250000000000000000000", leverage: "100", useDebt: false };
const fixture = JSON.parse(readFileSync(new URL("../../../research/sources/relayer-2026-10-22.json", import.meta.url), "utf8")) as {
  sources: Array<{ name: string; url: string; body?: string }>;
};
const html = [RELAYER_REFERENCE.appPath, RELAYER_REFERENCE.hooksPath, ...RELAYER_REFERENCE.sources.map((s) => s.path)]
  .map((path) => `<script src="${path}"></script>`).join("");
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function transport(post = response({ action: "openPosition", intentId: id, state: "queued", queueRevision: "42" })) {
  return vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
    if (options?.method === "POST") return post;
    if (String(url).endsWith("/trade/btc")) return new Response(html);
    const source = fixture.sources.find((source) => source.url === String(url));
    if (source?.body) return new Response(source.body);
    if (source) return new Response(`fixture:${source.name}`);
    throw new Error("Unexpected request");
  });
}

describe("verified relayer protocol", () => {
  it("prepares lossless raw-unit fields in the published EIP-712 domain and field order", () => {
    const prepared = prepareRelayerIntent(open, now);
    expect(prepared.typedData.domain).toEqual({ name: "String", version: "1", chainId: 999, verifyingContract: RELAYER_REFERENCE.exchange });
    expect(prepared.typedData.primaryType).toBe("OpenPosition");
    expect(prepared.typedData.message).toEqual({ ...base, instrumentId: "0", isLong: true,
      size: "250000000000000000000", leverage: "100", useDebt: false });
    expect(prepared.typedData.types.OpenPosition).toEqual([
      { name: "user", type: "address" }, { name: "instrumentId", type: "uint32" }, { name: "isLong", type: "bool" },
      { name: "size", type: "uint128" }, { name: "leverage", type: "uint32" }, { name: "useDebt", type: "bool" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
    ]);
    expect(prepared.checks).toEqual({ nonceReserved: false, admissionChecked: false, signatureCreated: false });
  });

  it("separates staking and exchange nonce/signing domains and matches every published schema", () => {
    const source = fixture.sources.find((source) => source.name === "typedData")!.body!;
    const intents: RelayerIntent[] = [open, { action: "closePositions", ...base, positionIds: ["1"] },
      { action: "paperStake", ...base, amount: "1" }, { action: "paperUnstake", ...base, amount: "1" }, { action: "paperClaim", ...base }];
    for (const intent of intents) {
      const prepared = prepareRelayerIntent(intent, now);
      const type = prepared.typedData.primaryType;
      const published = source.match(new RegExp(`${type}:\\[(.+?)\\](?:,|})`))![1];
      const fields = Array.from(published.matchAll(/name:`([^`]+)`,type:`([^`]+)`/g), (match) => ({ name: match[1], type: match[2] }));
      expect(prepared.typedData.types[type]).toEqual(fields);
      expect(prepared.typedData.domain.name).toBe(intent.action.startsWith("paper") ? "PaperStaking" : "String");
      expect(prepared.typedData.domain.verifyingContract).toBe(intent.action.startsWith("paper") ? RELAYER_REFERENCE.paperStaking : RELAYER_REFERENCE.exchange);
    }
  });

  it("rejects ambiguous units, out-of-range integers, expired deadlines, unsupported markets and extra signed fields", () => {
    for (const patch of [{ size: 250 }, { size: "1.2" }, { size: "01" }, { size: String(1n << 128n) },
      { size: "0" }, { instrumentId: "2" }, { leverage: "0" }, { leverage: String(1n << 32n) },
      { nonce: String(1n << 256n) }, { deadline: String(now / 1000) }, { deadline: String(now / 1000 + 3601) },
      { user: "0x" + "00".repeat(20) }, { isLong: "true" }, { v: "27" }, { chainId: 1 }]) {
      expect(() => prepareRelayerIntent({ ...open, ...patch }, now)).toThrow();
    }
    for (const positionIds of [[], ["1", "1"], Array.from({ length: 13 }, (_, i) => String(i)), ["-1"]]) {
      expect(() => prepareRelayerIntent({ action: "closePositions", ...base, positionIds }, now)).toThrow();
    }
  });

  it("verifies the active frontend and exact source fingerprints using GET only", async () => {
    const fetcher = transport();
    expect(await verifyRelayerProtocol({ fetcher })).toEqual({ build: RELAYER_REFERENCE.build, chainId: 999 });
    expect(fetcher).toHaveBeenCalledTimes(6);
    for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
  });

  it("fails closed on changed frontend references, changed source bytes, errors and large responses", async () => {
    for (const body of ["<html>new release</html>", " ".repeat(65537)]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(verifyRelayerProtocol({ fetcher })).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = transport();
    fetcher.mockImplementation(async (url) => new Response(String(url).endsWith("/trade/btc") ? html : "changed"));
    await expect(verifyRelayerProtocol({ fetcher })).rejects.toThrow("fingerprint changed");
  });

  it("verifies app and status-parser bytes, not only the filenames in the active HTML", async () => {
    for (const changed of [RELAYER_REFERENCE.appPath, RELAYER_REFERENCE.hooksPath]) {
      const fetcher = transport();
      const normal = fetcher.getMockImplementation()!;
      fetcher.mockImplementation((url, options) => String(url).endsWith(changed) ? Promise.resolve(new Response("changed bundle")) : normal(url, options));
      await expect(verifyRelayerProtocol({ fetcher })).rejects.toThrow("fingerprint changed");
    }
  });
});

describe("relayer queue reads", () => {
  it("retains decimal revisions and positions without inventing execution status", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true, entries: [{ intentId: id, position: "9007199254740994" }] }));
    expect(await readRelayerQueueRanks(wallet, { fetcher })).toEqual({ wallet, queueRevision: null, entries: [{ intentId: id, position: "9007199254740994" }] });
    expect(fetcher).toHaveBeenCalledWith(`${RELAYER_REFERENCE.origin}/queue-rank/accounts/${wallet}`, expect.objectContaining({ method: "GET", redirect: "error" }));
    await expect(readRelayerQueueRanks("../intents", { fetcher })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate IDs, malformed responses and unavailable service", async () => {
    for (const value of [{ ok: false, entries: [] }, { ok: true, entries: [{ intentId: id, position: "0" }] },
      { ok: true, entries: [{ intentId: id, position: "1" }, { intentId: id, position: "2" }] }]) {
      await expect(readRelayerQueueRanks(wallet, { fetcher: vi.fn().mockResolvedValue(response(value)) })).rejects.toThrow();
    }
    await expect(readRelayerQueueRanks(wallet, { fetcher: vi.fn().mockResolvedValue(response({}, 503)) })).rejects.toThrow("503");
  });
});

describe("explicit signed submission (mocked transport only)", () => {
  const input = { intent: open, signature, expectedIntentId: id };
  it("sends exactly once after source verification and distinguishes acknowledgement from execution", async () => {
    const fetcher = transport();
    expect(await submitSignedRelayerIntent(input, { fetcher, now: () => now })).toEqual({ action: "openPosition", intentId: id,
      state: "queued", queueRevision: "42", acknowledgementReceived: true, executionVerified: false });
    const posts = fetcher.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe(`${RELAYER_REFERENCE.origin}/intents`);
    expect(posts[0][1]).toMatchObject({ redirect: "error", headers: { "X-Papertrade-Build": RELAYER_REFERENCE.build } });
    expect(JSON.parse(posts[0][1]!.body as string)).toEqual({ action: "openPosition", signed: { ...prepareRelayerIntent(open, now).typedData.message, ...signature } });
  });

  it("does not submit when the source changed, input is malformed or deadline expires during verification", async () => {
    const changed = vi.fn<typeof fetch>().mockResolvedValue(new Response("new frontend"));
    await expect(submitSignedRelayerIntent(input, { fetcher: changed, now: () => now })).rejects.toThrow("changed");
    expect(changed.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
    const fetcher = transport();
    await expect(submitSignedRelayerIntent({ ...input, signature: { ...signature, v: "0" as "27" } }, { fetcher, now: () => now })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    const clock = vi.fn().mockReturnValueOnce(now).mockReturnValueOnce(now + 3600000);
    await expect(submitSignedRelayerIntent(input, { fetcher, now: clock })).rejects.toThrow("Deadline");
    expect(fetcher.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });

  it("keeps known rejection separate from uncertainty and never retries either", async () => {
    for (const [post, outcome] of [[response({ code: "admission_rejected", reason: "funding" }, 400), "rejected"],
      [response({}, 503), "unknown"], [new Response("not JSON"), "unknown"],
      [response({ action: "openPosition", intentId: "0x" + "ab".repeat(32), state: "confirmed", queueRevision: "4" }), "unknown"]] as const) {
      const fetcher = transport(post);
      await expect(submitSignedRelayerIntent(input, { fetcher, now: () => now })).rejects.toMatchObject({ outcome });
      expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    }
  });

  it("treats connection loss after sending as unknown and does not leak transport content", async () => {
    const fetcher = transport();
    const normal = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, options) => options?.method === "POST" ? Promise.reject(new Error("sensitive transport detail")) : normal(url, options));
    await expect(submitSignedRelayerIntent(input, { fetcher, now: () => now })).rejects.toMatchObject({ outcome: "unknown", message: "Relayer outcome is unknown; reconcile before another submission" });
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });

  it.each(["headers", "body"])("bounds a submission during %s and leaves an unknown outcome", async (phase) => {
    const controller = new AbortController();
    const original = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => ms === 35000 ? controller.signal : original(ms));
    const fetcher = transport();
    const normal = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, options) => {
      if (options?.method !== "POST") return normal(url, options);
      if (phase === "headers") return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(new Error("timeout"))));
      return new Response(new ReadableStream({ start(body) { options.signal!.addEventListener("abort", () => body.error(new Error("timeout"))); } }));
    });
    try {
      const result = submitSignedRelayerIntent(input, { fetcher, now: () => now });
      const rejection = expect(result).rejects.toMatchObject({ outcome: "unknown" });
      await vi.waitFor(() => expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1));
      controller.abort();
      await rejection;
      expect(timeout).toHaveBeenCalledWith(35000);
    } finally { timeout.mockRestore(); }
  });
});
