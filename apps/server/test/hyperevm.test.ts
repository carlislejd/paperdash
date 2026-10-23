import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HYPEREVM_DEPLOYMENT as deployment, HYPEREVM_RPC_URL,
  hyperEvmPaperCalldata, hyperEvmPaperDelayed, readHyperEvmPaperSnapshot,
  validHyperEvmPaperSnapshot,
} from "../src/hyperevm.js";

// Tiny code stand-ins keep network fixtures small. The actual fingerprint
// computation is node:crypto; only the three successful fixture hashes change.
vi.mock("node:crypto", async (original) => {
  const crypto = await original<typeof import("node:crypto")>();
  return { ...crypto, createHash: (algorithm: string) => {
    let data: Buffer;
    const instance = {
      update(value: Buffer) { data = value; return instance; },
      digest() {
        const key = data.toString("hex");
        return ({ "01": "2756d7c52baee85cacb504f6ee1df7aad6809ac8d94a4a111d76991f90d36d6e",
          "02": "f77b91537421a0092f1c068f85af316caf7fd8d8461e8b0305022ee6f5f0faae",
          "03": "3e006d0daee1fcbaa71c160a72291374783da5f720a33db0a51c8f84bde3aa04",
        } as Record<string, string>)[key] ?? crypto.createHash(algorithm).update(data).digest("hex");
      },
    }; return instance;
  } };
});
afterEach(() => vi.restoreAllMocks());
const now = 1800000000000;
const blockHash = "0x" + "a".repeat(64), parentHash = "0x" + "b".repeat(64);
const word = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0");
const exactSupply = 9007199254740993000000000000000001n;
function aggregate(overrides: Record<string, bigint | string> = {}) {
  const state = { supply: exactSupply, staked: 100n, accumulator: 200n,
    custody: 100n, decimals: 18n, time: BigInt(now / 1000), parent: parentHash.slice(2), chain: 999n,
    ...overrides };
  const values = Object.values(state).map((v) => typeof v === "string" ? v : word(v));
  return "0x" + word(100) + word(64) + word(values.length) +
    values.map((_v, i) => word(values.length * 32 + i * 64)).join("") +
    values.map((v) => word(32) + v).join("");
}
type RpcRequest = { id: number; method: string; params: unknown[] };
function transport(override?: (request: RpcRequest, ordinary: unknown) => unknown | Response) {
  return vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const request = JSON.parse(init!.body as string) as RpcRequest;
    let value: unknown;
    if (request.method === "eth_chainId") value = "0x3e7";
    else if (request.method === "eth_getStorageAt") {
      const impl = request.params[0] === deployment.paper ? deployment.paperImplementation : deployment.stakingImplementation;
      value = "0x" + impl.slice(2).padStart(64, "0");
    } else if (request.method === "eth_getCode") {
      value = request.params[0] === deployment.multicall ? "0x01" :
        request.params[0] === deployment.paperImplementation ? "0x02" : "0x03";
    } else if (request.method === "eth_call") value = aggregate();
    else if (request.method === "eth_getBlockByNumber") value = {
      number: "0x64", timestamp: "0x" + (now / 1000).toString(16), hash: blockHash, parentHash,
    };
    else throw new Error("Unexpected test method");
    const output = override ? override(request, value) : value;
    return output instanceof Response ? output : new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: output }));
  });
}
const read = (fetcher: typeof fetch) => readHyperEvmPaperSnapshot({ fetcher, clock: () => now });

describe("independent HyperEVM PAPER state", () => {
  it("reads exact atomic state with a chain clock, checks identities and preserves integer precision", async () => {
    const fetcher = transport();
    const snapshot = await read(fetcher);
    expect(snapshot).toEqual({ source: "hyperevm-rpc", chainId: 999, consistency: "atomic-multicall",
      block: { number: "100", hash: blockHash, timestampMs: now },
      paper: { supplyRaw: exactSupply.toString(), stakedRaw: "100", stakingCustodyRaw: "100" },
      staking: { accumulatorRaw: "200" }, receivedAt: now, callTimestampMs: now,
      deployment: { paperImplementation: deployment.paperImplementation,
        stakingImplementation: deployment.stakingImplementation, multicallCodeSha256: deployment.multicallCodeSha256 },
    });
    expect(fetcher).toHaveBeenCalledTimes(10);
    const requests = fetcher.mock.calls.map(([url, init]) => {
      expect(url).toBe(HYPEREVM_RPC_URL);
      expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit" });
      expect(init!.signal).toBeInstanceOf(AbortSignal);
      return JSON.parse(init!.body as string) as RpcRequest;
    });
    const call = requests.filter((r) => r.method === "eth_call");
    expect(call).toHaveLength(1);
    expect(call[0].params).toEqual([{ to: deployment.multicall, data: hyperEvmPaperCalldata() }, "latest"]);
    expect(requests.filter((r) => r.method === "eth_getStorageAt")).toHaveLength(4);
    expect(requests.find((r) => r.method === "eth_getBlockByNumber")!.params).toEqual(["0x64", false]);
    expect(validHyperEvmPaperSnapshot(snapshot)).toBe(snapshot);
    expect(hyperEvmPaperDelayed(snapshot, now + 90000)).toBe(false);
    expect(hyperEvmPaperDelayed(snapshot, now + 90001)).toBe(true);
  });

  it("encodes the fixed atomic call list with canonical ABI offsets", () => {
    const data = hyperEvmPaperCalldata();
    expect(data.slice(0, 10)).toBe("0x252dba42");
    const body = data.slice(10);
    const at = (byte: number) => BigInt("0x" + body.slice(byte * 2, byte * 2 + 64));
    expect(at(0)).toBe(32n);
    expect(at(32)).toBe(8n);
    // First tuple starts after the offset and eight element offsets.
    expect(at(64)).toBe(256n);
    expect(body.slice((64 + 256) * 2, (64 + 256 + 32) * 2)).toBe(deployment.paper.slice(2).padStart(64, "0"));
    expect(at(64 + 256 + 32)).toBe(64n);
    expect(at(64 + 256 + 64)).toBe(4n);
    expect(body.slice((64 + 256 + 96) * 2, (64 + 256 + 100) * 2)).toBe("18160ddd");
  });

  it.each(["chain", "implementation", "code"])("fails closed on %s changes before publishing values", async (kind) => {
    const fetcher = transport((r, value) => {
      if (kind === "chain" && r.method === "eth_chainId") return "0x1";
      if (kind === "implementation" && r.method === "eth_getStorageAt") return "0x" + word(99);
      if (kind === "code" && r.method === "eth_getCode") return "0x99";
      return value;
    });
    await expect(read(fetcher)).rejects.toThrow(/wrong chain|implementation changed|contract code changed/);
    expect(fetcher.mock.calls.every(([, init]) => JSON.parse(init!.body as string).method !== "eth_call")).toBe(true);
  });

  it("rejects an upgrade during the atomic read", async () => {
    let calls = 0;
    const fetcher = transport((r, value) => {
      if (r.method === "eth_call") calls++;
      return r.method === "eth_getStorageAt" && calls ? "0x" + word(99) : value;
    });
    await expect(read(fetcher)).rejects.toThrow("implementation changed");
  });

  it.each([
    { staked: 101n }, { supply: 99n }, { decimals: 6n }, { chain: 998n },
    { time: BigInt((now - 91000) / 1000) }, { time: BigInt((now + 31000) / 1000) },
    { time: (1n << 256n) - 1n },
  ])("rejects changed accounting invariants, units or clocks: %s", async (overrides) => {
    const fetcher = transport((r, value) => r.method === "eth_call" ? aggregate(overrides) : value);
    await expect(read(fetcher)).rejects.toThrow(/changed|invalid|inconsistent|does not match/);
  });

  it.each(["0x", "0x00", aggregate() + word(0), aggregate().slice(0, -64),
    aggregate().slice(0, 66) + word(0) + aggregate().slice(130),
  ])("rejects malformed, truncated and noncanonical aggregate results", async (output) => {
    await expect(read(transport((r, value) => r.method === "eth_call" ? output : value))).rejects.toThrow("aggregate");
  });

  it.each(["number", "timestamp", "parentHash", "hash"])("checks %s against the atomic provenance", async (field) => {
    const fetcher = transport((r, value) => r.method === "eth_getBlockByNumber" ? {
      ...(value as object), [field]: field === "hash" ? "invalid" : "0x1",
    } : value);
    await expect(read(fetcher)).rejects.toThrow(/block header does not match|call clock does not match/);
  });

  it("preserves observed latest-call clock skew separately from the canonical block time", async () => {
    const fetcher = transport((r, value) => r.method === "eth_call" ? aggregate({ time: BigInt(now / 1000 - 1) }) : value);
    const snapshot = await read(fetcher);
    expect(snapshot.callTimestampMs).toBe(now - 1000);
    expect(snapshot.block.timestampMs).toBe(now);
    expect(validHyperEvmPaperSnapshot(snapshot)).toBe(snapshot);
    expect(validHyperEvmPaperSnapshot({ ...snapshot, callTimestampMs: now - 3000 })).toBeNull();
    await expect(read(transport((r, value) => r.method === "eth_call" ?
      aggregate({ time: BigInt(now / 1000 - 3) }) : value)))
      .rejects.toThrow("call clock does not match");
  });

  it("bounds request/body timeouts, rejects oversized bodies and suppresses private transport errors", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await read(transport());
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([20000, ...Array(10).fill(5000)]);
    await expect(read(transport(() => new Response(" ".repeat(65537))))).rejects.toThrow("size limit");
    await expect(read(vi.fn<typeof fetch>().mockRejectedValue(new Error("secret-provider-url"))))
      .rejects.toThrow(/^HyperEVM RPC read failed\.$/);
    await expect(read(transport(() => new Response(JSON.stringify({
      jsonrpc: "2.0", id: 1, error: { message: "secret-provider-url" },
    }))))).rejects.toThrow(/^HyperEVM RPC response is invalid\.$/);
  });

  it("surfaces bounded Retry-After without automatic retries or response content", async () => {
    const fetcher = transport(() => new Response("private error", { status: 429, headers: { "Retry-After": "90" } }));
    await expect(read(fetcher)).rejects.toMatchObject({ message: "HyperEVM RPC HTTP 429.", retryAt: now + 90000 });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it.each(["headers", "body"])("aborts stalled %s without exposing the transport error", async (phase) => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (phase === "headers") return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new Error("private provider timeout")));
      });
      return new Response(new ReadableStream({ start(body) {
        init!.signal!.addEventListener("abort", () => body.error(new Error("private provider timeout")));
      } }));
    });
    const result = read(fetcher);
    const rejection = expect(result).rejects.toThrow(/^HyperEVM RPC read failed\.$/);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(6));
    controller.abort();
    await rejection;
  });

  it("validates persisted snapshots and independent freshness without fabricating zero data", async () => {
    const snapshot = await read(transport());
    for (const value of [null, {}, { ...snapshot, chainId: 1 },
      { ...snapshot, receivedAt: NaN }, { ...snapshot, block: { ...snapshot.block, number: "01" } },
      { ...snapshot, paper: { ...snapshot.paper, stakedRaw: "101" } },
      { ...snapshot, staking: { accumulatorRaw: "9".repeat(78) } },
      { ...snapshot, deployment: {} },
    ]) expect(validHyperEvmPaperSnapshot(value)).toBeNull();
    expect(hyperEvmPaperDelayed(snapshot, now - 1)).toBe(true);
    expect(hyperEvmPaperDelayed(snapshot, NaN)).toBe(true);
    expect(hyperEvmPaperDelayed({ ...snapshot, receivedAt: now + 90001 }, now + 90001)).toBe(true);
    await expect(readHyperEvmPaperSnapshot({ rpcUrl: "https://user:secret@example.test", fetcher: transport() }))
      .rejects.toThrow("embedded credentials");
  });
});
