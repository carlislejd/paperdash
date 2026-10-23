import { createHash } from "node:crypto";

export const HYPEREVM_RPC_URL = "https://rpc.hyperliquid.xyz/evm";
export const HYPEREVM_PAPER_INTERVAL_MS = 30000;
export const HYPEREVM_PAPER_MAX_AGE_MS = 90000;
export const HYPEREVM_DEPLOYMENT = {
  paper: "0xe40f17915daa230324030003a197cdaef2261c0e",
  staking: "0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016",
  paperImplementation: "0x433bd418ec92818a960585f4d5fae563e735bb4a",
  stakingImplementation: "0xe6e3519455170913c5c3bfe541dd918a2d0cbb15",
  paperCodeSha256: "f77b91537421a0092f1c068f85af316caf7fd8d8461e8b0305022ee6f5f0faae",
  stakingCodeSha256: "3e006d0daee1fcbaa71c160a72291374783da5f720a33db0a51c8f84bde3aa04",
  multicall: "0xca11bde05977b3631167028862be2a173976ca11",
  multicallCodeSha256: "2756d7c52baee85cacb504f6ee1df7aad6809ac8d94a4a111d76991f90d36d6e",
} as const;
export const HYPEREVM_SELECTORS = {
  aggregate: "252dba42", totalSupply: "18160ddd", totalStaked: "817b1cd2",
  accumulator: "939d6237", balanceOf: "70a08231", decimals: "313ce567",
  timestamp: "0f28c97d", parentHash: "27e86d6e", chainId: "3408e470",
} as const;
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const MAX_RESPONSE_BYTES = 65536;
const TIMEOUT_MS = 5000;
const OVERALL_TIMEOUT_MS = 20000;
const uint = /^(?:0|[1-9]\d{0,77})$/;
const hash = /^0x[0-9a-f]{64}$/;
const quantity = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;
const word = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0");

export interface HyperEvmPaperSnapshot {
  source: "hyperevm-rpc";
  chainId: 999;
  block: { number: string; hash: string; timestampMs: number };
  consistency: "atomic-multicall";
  paper: { supplyRaw: string; stakedRaw: string; stakingCustodyRaw: string };
  staking: { accumulatorRaw: string };
  /** BLOCKTIMESTAMP in the simulated latest call. Live probes observed a
   * one-second difference from its matching canonical header. The two-second
   * tolerance is a conservative compatibility bound, not a protocol promise.
   * No view here uses time. Keep this clock distinct in downstream provenance. */
  callTimestampMs: number;
  receivedAt: number;
  deployment: {
    paperImplementation: string;
    stakingImplementation: string;
    multicallCodeSha256: string;
  };
}
export class HyperEvmReadError extends Error {
  constructor(message: string, public retryAt = 0) { super(message); }
}
interface ReadOptions { rpcUrl?: string; fetcher?: typeof fetch; clock?: () => number }
function fail(message: string): never { throw new HyperEvmReadError(message); }
function isRaw(value: unknown): value is string {
  return typeof value === "string" && uint.test(value) && BigInt(value) <= UINT256_MAX;
}
function validClock(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
}

/** Validate persisted observations without renewing either provenance clock. */
export function validHyperEvmPaperSnapshot(value: unknown): HyperEvmPaperSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const v = value as HyperEvmPaperSnapshot;
  if (v.source !== "hyperevm-rpc" || v.chainId !== 999 || v.consistency !== "atomic-multicall" ||
      !v.block || !isRaw(v.block.number) || BigInt(v.block.number) === 0n ||
      !hash.test(v.block.hash) || !validClock(v.block.timestampMs) ||
      !validClock(v.callTimestampMs) || Math.abs(v.callTimestampMs - v.block.timestampMs) > 2000 ||
      !validClock(v.receivedAt) || v.block.timestampMs > v.receivedAt + 30000 ||
      !v.paper || !isRaw(v.paper.supplyRaw) || !isRaw(v.paper.stakedRaw) ||
      !isRaw(v.paper.stakingCustodyRaw) || v.paper.stakedRaw !== v.paper.stakingCustodyRaw ||
      BigInt(v.paper.stakedRaw) > BigInt(v.paper.supplyRaw) ||
      !v.staking || !isRaw(v.staking.accumulatorRaw) || !v.deployment ||
      v.deployment.paperImplementation !== HYPEREVM_DEPLOYMENT.paperImplementation ||
      v.deployment.stakingImplementation !== HYPEREVM_DEPLOYMENT.stakingImplementation ||
      v.deployment.multicallCodeSha256 !== HYPEREVM_DEPLOYMENT.multicallCodeSha256) return null;
  return v;
}
export function hyperEvmPaperDelayed(value: unknown, now = Date.now()): boolean {
  const v = validHyperEvmPaperSnapshot(value);
  return !v || !validClock(now) || v.receivedAt > now || v.block.timestampMs > now + 30000 ||
    now - v.receivedAt > HYPEREVM_PAPER_MAX_AGE_MS ||
    now - v.block.timestampMs > HYPEREVM_PAPER_MAX_AGE_MS;
}

/** Only this fixed list of verified read calls is ever encoded. aggregate() is
 * simulated with eth_call; it cannot submit a transaction or move funds.
 * Multicall3 source/deployment: https://github.com/mds1/multicall3
 * PAPER addresses: https://docs.papertrade.xyz/dev/contract-addresses/
 * Staking totalStaked selector is live-verified against token custody; both
 * implementations are pinned and the invariant is rechecked in every call. */
export function hyperEvmPaperCalldata(): string {
  const d = HYPEREVM_DEPLOYMENT, s = HYPEREVM_SELECTORS;
  const calls = [
    [d.paper, s.totalSupply], [d.staking, s.totalStaked], [d.staking, s.accumulator],
    [d.paper, s.balanceOf + d.staking.slice(2).padStart(64, "0")],
    [d.paper, s.decimals], [d.multicall, s.timestamp],
    [d.multicall, s.parentHash], [d.multicall, s.chainId],
  ];
  const tails = calls.map(([target, data]) => target.slice(2).padStart(64, "0") + word(64) +
    word(data.length / 2) + data.padEnd(Math.ceil(data.length / 64) * 64, "0"));
  let offset = 32 * tails.length;
  const offsets = tails.map((tail) => { const result = word(offset); offset += tail.length / 2; return result; });
  return "0x" + s.aggregate + word(32) + word(tails.length) + offsets.join("") + tails.join("");
}

/** Strictly decode the one known aggregate response, not arbitrary ABI data. */
function decodeAggregate(input: unknown): { number: string; values: string[] } {
  if (typeof input !== "string" || !/^0x(?:[0-9a-f]{64})+$/.test(input))
    fail("HyperEVM returned malformed aggregate data.");
  const bytes = input.slice(2);
  const at = (offset: number) => {
    if (offset < 0 || offset * 2 + 64 > bytes.length) fail("HyperEVM aggregate is truncated.");
    return BigInt("0x" + bytes.slice(offset * 2, offset * 2 + 64));
  };
  if (at(32) !== 64n || at(64) !== 8n || at(0) === 0n)
    fail("HyperEVM aggregate shape changed.");
  const values: string[] = [];
  // Every expected return value is precisely one ABI word. Canonical offsets
  // reject overlapping/trailing data and never convert untrusted offsets.
  for (let i = 0; i < 8; i++) {
    const expected = 8 * 32 + i * 64;
    if (at(96 + i * 32) !== BigInt(expected) || at(96 + expected) !== 32n)
      fail("HyperEVM aggregate offsets changed.");
    values.push(bytes.slice((128 + expected) * 2, (160 + expected) * 2));
  }
  if (bytes.length !== (96 + 8 * 32 + 8 * 64) * 2)
    fail("HyperEVM aggregate length changed.");
  return { number: at(0).toString(), values };
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) fail("HyperEVM response is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) fail("HyperEVM response exceeds its size limit.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function retryDeadline(value: string | null, now: number): number {
  if (!value) return 0;
  const seconds = /^\d{1,8}$/.test(value) ? Number(value) : NaN;
  const time = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(value);
  return Number.isFinite(time) ? Math.max(now, Math.min(time, now + 86400000)) : 0;
}

/** Ten bounded RPC requests, zero retries, no indexer/API dependency. All
 * financial reads and their chain clock come from ONE latest eth_call. The
 * block header supplies the matching hash and canonical time; historical state is never
 * requested. Call from the shared collector at most once per 30 seconds.
 * Implementations are checked before and after; upgrades fail closed. */
export async function readHyperEvmPaperSnapshot(options: ReadOptions = {}): Promise<HyperEvmPaperSnapshot> {
  const { fetcher = fetch, clock = Date.now, rpcUrl = HYPEREVM_RPC_URL } = options;
  const startedAt = clock();
  if (!validClock(startedAt)) fail("HyperEVM observation clock is invalid.");
  let url: URL;
  try { url = new URL(rpcUrl); } catch { return fail("HyperEVM RPC URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    fail("HyperEVM RPC URL must use HTTPS without embedded credentials.");
  const overall = AbortSignal.timeout(OVERALL_TIMEOUT_MS);
  let id = 0;
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    const requestId = ++id;
    try {
      const response = await fetcher(url.toString(), {
        method: "POST", headers: { "content-type": "application/json" },
        redirect: "error", credentials: "omit",
        body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
        signal: AbortSignal.any([overall, AbortSignal.timeout(TIMEOUT_MS)]),
      });
      if (!response.ok) {
        const retryAt = retryDeadline(response.headers.get("Retry-After"), clock());
        await response.body?.cancel();
        throw new HyperEvmReadError(`HyperEVM RPC HTTP ${response.status}.`, retryAt);
      }
      const payload = await readResponse(response) as Record<string, unknown> | null;
      if (!payload || payload.jsonrpc !== "2.0" || payload.id !== requestId ||
          "error" in payload || !("result" in payload)) fail("HyperEVM RPC response is invalid.");
      return payload.result;
    } catch (error) {
      if (error instanceof HyperEvmReadError) throw error;
      // Transport errors and RPC errors may contain private provider URLs or
      // credentials. Expose only a fixed message to callers and saved status.
      return fail("HyperEVM RPC read failed.");
    }
  };
  const d = HYPEREVM_DEPLOYMENT;
  const readImplementation = async (address: string, expected: string) => {
    const result = await rpc("eth_getStorageAt", [address, IMPLEMENTATION_SLOT, "latest"]);
    if (result !== "0x" + expected.slice(2).padStart(64, "0"))
      fail("HyperEVM implementation changed; verification is required.");
  };
  const verifyCode = async (address: string, expected: string) => {
    const result = await rpc("eth_getCode", [address, "latest"]);
    if (typeof result !== "string" || !/^0x(?:[0-9a-f]{2})+$/.test(result) ||
        createHash("sha256").update(Buffer.from(result.slice(2), "hex")).digest("hex") !== expected)
      fail("HyperEVM contract code changed; verification is required.");
  };
  const identity = await Promise.allSettled([
    rpc("eth_chainId", []), verifyCode(d.multicall, d.multicallCodeSha256),
    verifyCode(d.paperImplementation, d.paperCodeSha256),
    verifyCode(d.stakingImplementation, d.stakingCodeSha256),
    readImplementation(d.paper, d.paperImplementation),
    readImplementation(d.staking, d.stakingImplementation),
  ]);
  for (const result of identity) if (result.status === "rejected") throw result.reason;
  if (identity[0].status !== "fulfilled" || identity[0].value !== "0x3e7")
    fail("HyperEVM RPC returned the wrong chain.");
  const aggregate = decodeAggregate(await rpc("eth_call", [
    { to: d.multicall, data: hyperEvmPaperCalldata() }, "latest",
  ]));
  const [supply, staked, accumulator, custody, decimals, timestamp, parentHash, chain] = aggregate.values;
  if (BigInt("0x" + decimals) !== 18n || BigInt("0x" + chain) !== 999n)
    fail("HyperEVM PAPER units or chain changed.");
  const timestampMs = Number(BigInt("0x" + timestamp) * 1000n);
  if (!validClock(timestampMs)) fail("HyperEVM block clock is invalid.");
  const after = await Promise.allSettled([
    readImplementation(d.paper, d.paperImplementation),
    readImplementation(d.staking, d.stakingImplementation),
    rpc("eth_getBlockByNumber", ["0x" + BigInt(aggregate.number).toString(16), false]),
  ]);
  for (const result of after) if (result.status === "rejected") throw result.reason;
  const header = after[2].status === "fulfilled" ? after[2].value as Record<string, unknown> | null : null;
  if (!header || typeof header.number !== "string" || !quantity.test(header.number) ||
      BigInt(header.number) !== BigInt(aggregate.number) ||
      typeof header.timestamp !== "string" || !quantity.test(header.timestamp) ||
      header.parentHash !== "0x" + parentHash || typeof header.hash !== "string" || !hash.test(header.hash))
    fail("HyperEVM block header does not match the atomic observation.");
  const canonicalTimestampMs = Number(BigInt(header.timestamp) * 1000n);
  if (!validClock(canonicalTimestampMs) || Math.abs(canonicalTimestampMs - timestampMs) > 2000)
    fail("HyperEVM call clock does not match its block context.");
  const snapshot: HyperEvmPaperSnapshot = {
    source: "hyperevm-rpc", chainId: 999, consistency: "atomic-multicall",
    block: { number: aggregate.number, hash: header.hash, timestampMs: canonicalTimestampMs },
    paper: { supplyRaw: BigInt("0x" + supply).toString(), stakedRaw: BigInt("0x" + staked).toString(),
      stakingCustodyRaw: BigInt("0x" + custody).toString() },
    staking: { accumulatorRaw: BigInt("0x" + accumulator).toString() },
    receivedAt: clock(), callTimestampMs: timestampMs,
    deployment: { paperImplementation: d.paperImplementation,
      stakingImplementation: d.stakingImplementation, multicallCodeSha256: d.multicallCodeSha256 },
  };
  if (!validHyperEvmPaperSnapshot(snapshot) || hyperEvmPaperDelayed(snapshot, snapshot.receivedAt) ||
      snapshot.receivedAt < startedAt || snapshot.receivedAt - startedAt > OVERALL_TIMEOUT_MS)
    fail("HyperEVM observation is inconsistent or delayed.");
  return snapshot;
}
