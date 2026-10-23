import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createChainEventRpc, decodeChainLogs, openChainEventArchive, scanChainEvents,
  type ChainBlock, type ChainEventArchive, type ChainEventRpc, type RawChainLog,
} from "../src/chain-events.js";

const contract = `0x${"a".repeat(40)}`;
const hash = (number: number) => `0x${number.toString(16).padStart(64, "0")}`;
const block = (number: number): ChainBlock => ({ number, hash: hash(number), parentHash: hash(number - 1), timestamp: 1_800_000_000 + number });
const scope = { chainId: 999, deploymentId: "published-runtime-digest", addresses: [contract], startBlock: 100 };
const log = (number: number): RawChainLog => ({
  address: contract, blockNumber: number, blockHash: hash(number), transactionHash: hash(number + 1000),
  transactionIndex: 0, logIndex: 0, topics: [hash(5000)], data: "0x1234",
});
const wireLog = (number: number) => ({ ...log(number), removed: false, blockNumber: `0x${number.toString(16)}`, transactionIndex: "0x0", logIndex: "0x0" });
const rpc = (): ChainEventRpc => ({
  chainId: vi.fn(async () => 999), blockNumber: vi.fn(async () => 250),
  block: vi.fn(async (number) => block(number)),
  logs: vi.fn(async (_addresses, from, to) => Array.from({ length: to - from + 1 }, (_, i) => log(from + i))),
});
const archives: ChainEventArchive[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const archive of archives.splice(0)) { try { archive.close(); } catch {} }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function open(path = ":memory:", options: Parameters<typeof openChainEventArchive>[2] = {}) {
  const archive = openChainEventArchive(path, scope, options); archives.push(archive); return archive;
}

describe("bounded raw chain event evidence", () => {
  it("persists empty blocks, immutable raw logs and checkpoint atomically, then resumes after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chain-evidence-")); directories.push(directory);
    const path = join(directory, "logs.sqlite");
    let archive = open(path);
    const source = rpc();
    source.logs = vi.fn(async () => [log(101)]);
    const first = await scanChainEvents({ rpc: source, archive, maxBlocks: 3 });
    expect(first).toMatchObject({ blocks: 3, logs: 1, scannedBlocks: 3, checkpoint: block(102) });
    archive.close();
    archive = open(path);
    source.logs = vi.fn(async () => [log(103)]);
    const second = await scanChainEvents({ rpc: source, archive, maxBlocks: 2 });
    expect(second).toMatchObject({ blocks: 5, logs: 2, scannedBlocks: 2, checkpoint: block(104) });
    expect(source.logs).toHaveBeenCalledWith([contract], 103, 104);
    const read = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = read.prepare("SELECT identity,payload FROM chain_logs ORDER BY block_number").all();
      expect(rows[0].identity).toBe(`999:${hash(101)}:${hash(1101)}:0`);
      expect(JSON.parse(String(rows[0].payload))).toEqual(log(101));
    } finally { read.close(); }
  });

  it("bounds getLogs ranges to 50 blocks and stops at the confirmation-delayed head", async () => {
    const source = rpc();
    const archive = open();
    const result = await scanChainEvents({ rpc: source, archive, maxBlocks: 200, confirmations: 30 });
    expect(result.scannedBlocks).toBe(121);
    expect(source.logs).toHaveBeenNthCalledWith(1, [contract], 100, 149);
    expect(source.logs).toHaveBeenNthCalledWith(2, [contract], 150, 199);
    expect(source.logs).toHaveBeenNthCalledWith(3, [contract], 200, 220);
  });

  it("keeps the previous checkpoint on network failure and retries exactly the uncommitted range", async () => {
    const archive = open();
    const source = rpc();
    const underlying = source.logs;
    source.logs = vi.fn().mockImplementationOnce(underlying).mockRejectedValueOnce(new Error("offline")).mockImplementation(underlying);
    await expect(scanChainEvents({ rpc: source, archive, maxBlocks: 60 })).rejects.toThrow("offline");
    expect(archive.status()).toMatchObject({ blocks: 50, logs: 50, checkpoint: block(149) });
    const resumed = await scanChainEvents({ rpc: source, archive, maxBlocks: 10 });
    expect(resumed).toMatchObject({ blocks: 60, logs: 60, checkpoint: block(159) });
    expect(source.logs).toHaveBeenLastCalledWith([contract], 150, 159);
  });

  it("refuses wrong networks and changed checkpoints without advancing or deleting evidence", async () => {
    const archive = open();
    const source = rpc();
    await scanChainEvents({ rpc: source, archive, maxBlocks: 2 });
    source.chainId = async () => 1;
    await expect(scanChainEvents({ rpc: source, archive })).rejects.toThrow("chain ID");
    source.chainId = async () => 999;
    source.block = async (number) => ({ ...block(number), hash: hash(9999) });
    await expect(scanChainEvents({ rpc: source, archive })).rejects.toThrow("Checkpoint block hash changed");
    expect(archive.status()).toMatchObject({ blocks: 2, logs: 2, checkpoint: block(101) });
  });

  it("rejects inconsistent ancestry, logs, and a reorg during fetch with atomic rollback", async () => {
    for (const variant of ["ancestry", "log", "reorg"] as const) {
      const archive = open();
      const source = rpc();
      if (variant === "ancestry") source.block = async (number) => ({ ...block(number), parentHash: hash(9999) });
      if (variant === "log") source.logs = async () => [{ ...log(100), blockHash: hash(9999) }];
      if (variant === "reorg") {
        let reads = 0;
        source.block = async (number) => ({ ...block(number), hash: hash(++reads > 2 ? 9999 : number) });
      }
      await expect(scanChainEvents({ rpc: source, archive, maxBlocks: 2 })).rejects.toThrow();
      expect(archive.status()).toMatchObject({ blocks: 0, logs: 0, checkpoint: null });
    }
  });

  it("fails closed on quotas and cannot reuse an archive for another deployment", async () => {
    const archive = open(":memory:", { maxLogs: 1 });
    await expect(scanChainEvents({ rpc: rpc(), archive, maxBlocks: 2 })).rejects.toThrow("quota");
    expect(archive.status()).toMatchObject({ blocks: 0, logs: 0 });
    const blockLimited = open(":memory:", { maxBlocks: 1 });
    await expect(scanChainEvents({ rpc: rpc(), archive: blockLimited, maxBlocks: 2 })).rejects.toThrow("quota");
    const directory = mkdtempSync(join(tmpdir(), "chain-evidence-")); directories.push(directory);
    const path = join(directory, "logs.sqlite");
    const persisted = open(path); persisted.close();
    expect(() => openChainEventArchive(path, { ...scope, deploymentId: "another-version" })).toThrow("different deployment");
    expect(() => openChainEventArchive(path, { ...scope, startBlock: 101 })).toThrow("different deployment");
  });

  it("does not let a competing writer append past a stale checkpoint", () => {
    const archive = open();
    archive.append(null, [block(100)], [log(100)]);
    expect(() => archive.append(null, [block(101)], [log(101)])).toThrow("changed concurrently");
    expect(archive.status()).toMatchObject({ blocks: 1, logs: 1 });
  });

  it("rolls back logs and checkpoint when the SQLite byte quota is exhausted", () => {
    const archive = open(":memory:", { maxBytes: 65_536 });
    archive.append(null, [block(100)], [log(100)]);
    expect(() => archive.append(block(100), [block(101)], [{ ...log(101), data: `0x${"ff".repeat(60_000)}` }])).toThrow();
    expect(archive.status()).toMatchObject({ blocks: 1, logs: 1, checkpoint: block(100) });
    expect(archive.status().databaseBytes).toBeLessThanOrEqual(65_536);
  });

  it("validates event identity, removal flags, contracts, block bounds and exact hex", () => {
    expect(decodeChainLogs([wireLog(100)], [contract], 100, 100)).toEqual([log(100)]);
    for (const value of [
      [{ ...wireLog(100), removed: true }], [{ ...wireLog(100), removed: undefined }],
      [{ ...wireLog(100), address: `0x${"b".repeat(40)}` }], [wireLog(101)],
      [{ ...wireLog(100), blockNumber: "0x064" }], [{ ...wireLog(100), topics: ["0x12"] }],
      [{ ...wireLog(100), data: "0x1" }], [wireLog(100), wireLog(100)],
      [{ ...wireLog(100), transactionIndex: "0x20000000000000" }],
    ]) expect(() => decodeChainLogs(value, [contract], 100, 100)).toThrow();
  });

  it("uses only read-only JSON-RPC methods, bounded requests and strict response matching", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      const result = body.method === "eth_chainId" ? "0x3e7" : [];
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
    const source = createChainEventRpc("https://rpc.hyperliquid.xyz/evm", { fetcher });
    expect(await source.chainId()).toBe(999);
    await source.logs([contract], 100, 149);
    await expect(source.logs([contract], 100, 150)).rejects.toThrow("1–50");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const init = fetcher.mock.calls[1][1]!;
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toMatchObject({ method: "eth_getLogs", params: [{ address: [contract], fromBlock: "0x64", toBlock: "0x95" }] });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 999, result: "0x3e7" })));
    await expect(source.chainId()).rejects.toThrow("JSON-RPC");
    fetcher.mockResolvedValueOnce(new Response("{}", { headers: { "content-length": "9000000" } }));
    await expect(source.chainId()).rejects.toThrow("byte limit");
    expect(() => createChainEventRpc("http://untrusted.example")).toThrow("RPC URL");
    expect(() => createChainEventRpc("https://user:secret@example.com")).toThrow("RPC URL");
  });
});
