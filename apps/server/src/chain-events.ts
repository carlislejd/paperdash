import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// Raw evidence only: no guessed ABI, accounting, or claim of lifetime coverage.
// A separate archive keeps this bounded audit out of production snapshot storage.
export interface ChainEventScope {
  chainId: number;
  deploymentId: string;
  addresses: string[];
  startBlock: number;
}
export interface ChainBlock {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
}
export interface RawChainLog {
  address: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  topics: string[];
  data: string;
}
export interface ChainEventRpc {
  chainId(): Promise<number>;
  blockNumber(): Promise<number>;
  block(number: number): Promise<ChainBlock>;
  logs(addresses: string[], fromBlock: number, toBlock: number): Promise<RawChainLog[]>;
}

const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const quantityPattern = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const MAX_RPC_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_LOGS = 20_000;

function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${label}`);
  return value;
}
function quantity(value: unknown, label: string): number {
  if (typeof value !== "string" || !quantityPattern.test(value)) throw new Error(`Invalid ${label}`);
  return integer(Number(BigInt(value)), label);
}
function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !hashPattern.test(value)) throw new Error(`Invalid ${label}`);
  return value.toLowerCase();
}
function address(value: unknown): string {
  if (typeof value !== "string" || !addressPattern.test(value) || /^0x0{40}$/i.test(value))
    throw new Error("Invalid contract address");
  return value.toLowerCase();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid RPC object");
  return value as Record<string, unknown>;
}
function blockTag(number: number): string {
  return `0x${integer(number, "block number").toString(16)}`;
}
function normalizedScope(scope: ChainEventScope): ChainEventScope {
  const addresses = [...new Set(scope.addresses.map(address))].sort();
  if (addresses.length < 1 || addresses.length > 16 ||
      typeof scope.deploymentId !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(scope.deploymentId))
    throw new Error("Invalid archive scope");
  return {
    chainId: integer(scope.chainId, "chain ID", 1), deploymentId: scope.deploymentId,
    addresses, startBlock: integer(scope.startBlock, "start block"),
  };
}

export function decodeChainBlock(value: unknown, requested: number): ChainBlock {
  const item = object(value);
  const number = quantity(item.number, "block number");
  if (number !== requested) throw new Error("RPC returned a different block");
  return {
    number, hash: hash(item.hash, "block hash"), parentHash: hash(item.parentHash, "parent hash"),
    timestamp: quantity(item.timestamp, "block timestamp"),
  };
}
export function decodeChainLogs(value: unknown, addresses: string[], from: number, to: number): RawChainLog[] {
  if (!Array.isArray(value) || value.length > MAX_BATCH_LOGS) throw new Error("Invalid or oversized log batch");
  const allowed = new Set(addresses.map(address));
  const seen = new Set<string>();
  const logs = value.map((raw): RawChainLog => {
    const item = object(raw);
    const contract = address(item.address);
    const blockNumber = quantity(item.blockNumber, "log block number");
    if (!allowed.has(contract) || blockNumber < from || blockNumber > to || item.removed !== false)
      throw new Error("RPC returned removed or out-of-scope log");
    if (!Array.isArray(item.topics) || item.topics.length > 4 ||
        typeof item.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(item.data) || item.data.length > 262146)
      throw new Error("Invalid log topics or data");
    const result: RawChainLog = {
      address: contract, blockNumber, blockHash: hash(item.blockHash, "log block hash"),
      transactionHash: hash(item.transactionHash, "transaction hash"),
      transactionIndex: quantity(item.transactionIndex, "transaction index"),
      logIndex: quantity(item.logIndex, "log index"),
      topics: item.topics.map((topic) => hash(topic, "topic")), data: item.data.toLowerCase(),
    };
    // logIndex is global within its block. Even exact duplicates indicate an
    // unreliable response; never silently merge two potentially different logs.
    const identity = `${result.blockHash}:${result.logIndex}`;
    if (seen.has(identity)) throw new Error("RPC returned duplicate log identity");
    seen.add(identity);
    return result;
  });
  return logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

export function createChainEventRpc(url: string, options: { fetcher?: typeof fetch } = {}): ChainEventRpc {
  const endpoint = new URL(url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if ((endpoint.protocol !== "https:" && !(local && endpoint.protocol === "http:")) ||
      endpoint.username || endpoint.password || endpoint.hash) throw new Error("Invalid read-only RPC URL");
  const fetcher = options.fetcher ?? fetch;
  let nextId = 0;
  // This closure has an explicit read-only allowlist; no signing or submission path.
  async function call(method: "eth_chainId" | "eth_blockNumber" | "eth_getBlockByNumber" | "eth_getLogs", params: unknown[]): Promise<unknown> {
    const id = ++nextId;
    const response = await fetcher(endpoint.href, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`RPC HTTP ${response.status}`); }
    if (Number(response.headers.get("content-length")) > MAX_RPC_BYTES) {
      await response.body?.cancel(); throw new Error("RPC response exceeds byte limit");
    }
    if (!response.body) throw new Error("Empty RPC response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RPC_BYTES) { await reader.cancel(); throw new Error("RPC response exceeds byte limit"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const result = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (result.jsonrpc !== "2.0" || result.id !== id || "error" in result || !("result" in result))
      throw new Error("Invalid or failed JSON-RPC response");
    return result.result;
  }
  return {
    chainId: async () => quantity(await call("eth_chainId", []), "chain ID"),
    blockNumber: async () => quantity(await call("eth_blockNumber", []), "head block"),
    block: async (number) => decodeChainBlock(await call("eth_getBlockByNumber", [blockTag(number), false]), number),
    logs: async (addresses, fromBlock, toBlock) => {
      integer(fromBlock, "from block"); integer(toBlock, "to block");
      if (toBlock < fromBlock || toBlock - fromBlock >= 50 || addresses.length < 1 || addresses.length > 16)
        throw new Error("Log request must cover 1–50 blocks and 1–16 contracts");
      const contracts = addresses.map(address);
      return decodeChainLogs(await call("eth_getLogs", [{
        address: contracts, fromBlock: blockTag(fromBlock), toBlock: blockTag(toBlock),
      }]), contracts, fromBlock, toBlock);
    },
  };
}

export interface ChainArchiveStatus {
  scope: ChainEventScope;
  scopeId: string;
  checkpoint: ChainBlock | null;
  blocks: number;
  logs: number;
  databaseBytes: number;
}
export interface ChainEventArchive {
  readonly scope: ChainEventScope;
  status(): ChainArchiveStatus;
  append(expectedPrevious: ChainBlock | null, blocks: ChainBlock[], logs: RawChainLog[]): void;
  close(): void;
}

export function openChainEventArchive(
  path: string, requestedScope: ChainEventScope,
  options: { maxBytes?: number; maxLogs?: number; maxBlocks?: number } = {},
): ChainEventArchive {
  const scope = normalizedScope(requestedScope);
  const scopeJson = JSON.stringify(scope);
  const scopeId = createHash("sha256").update(scopeJson).digest("hex");
  const maxBytes = integer(options.maxBytes ?? 128 * 1024 * 1024, "archive byte quota", 65_536);
  const maxLogs = integer(options.maxLogs ?? 100_000, "archive log quota", 1);
  const maxBlocks = integer(options.maxBlocks ?? 100_000, "archive block quota", 1);
  const db = new DatabaseSync(path);
  try {
    // DELETE journal bounds temporary storage to roughly another database copy;
    // there is no ever-growing WAL. Durability is explicit for checkpoint commits.
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;");
    const pageSize = Number(db.prepare("PRAGMA page_size").get()!.page_size);
    const pageCount = Number(db.prepare("PRAGMA page_count").get()!.page_count);
    if (pageSize * pageCount > maxBytes) throw new Error("Existing archive exceeds byte quota");
    db.exec(`PRAGMA max_page_count=${Math.floor(maxBytes / pageSize)};`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS archive_scope (id INTEGER PRIMARY KEY CHECK(id=1), scope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chain_blocks (number INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chain_logs (
        identity TEXT PRIMARY KEY, block_number INTEGER NOT NULL, block_hash TEXT NOT NULL,
        transaction_hash TEXT NOT NULL, log_index INTEGER NOT NULL, payload TEXT NOT NULL,
        UNIQUE(block_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS chain_logs_block ON chain_logs(block_number);
    `);
    db.prepare("INSERT OR IGNORE INTO archive_scope(id,scope) VALUES(1,?)").run(scopeJson);
    if (db.prepare("SELECT scope FROM archive_scope WHERE id=1").get()!.scope !== scopeJson)
      throw new Error("Archive belongs to a different deployment, contract set, or start block");
  } catch (error) { db.close(); throw error; }

  function status(): ChainArchiveStatus {
    const last = db.prepare("SELECT payload FROM chain_blocks ORDER BY number DESC LIMIT 1").get();
    return {
      scope: structuredClone(scope), scopeId, checkpoint: last ? JSON.parse(String(last.payload)) as ChainBlock : null,
      blocks: Number(db.prepare("SELECT COUNT(*) AS n FROM chain_blocks").get()!.n),
      logs: Number(db.prepare("SELECT COUNT(*) AS n FROM chain_logs").get()!.n),
      databaseBytes: Number(db.prepare("PRAGMA page_count").get()!.page_count) * Number(db.prepare("PRAGMA page_size").get()!.page_size),
    };
  }
  return {
    get scope() { return structuredClone(scope); }, status,
    append(expectedPrevious, blocks, logs) {
      if (blocks.length < 1 || blocks.length > 50 || logs.length > MAX_BATCH_LOGS) throw new Error("Invalid archive batch");
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = status();
        if (JSON.stringify(current.checkpoint) !== JSON.stringify(expectedPrevious)) throw new Error("Archive checkpoint changed concurrently");
        if (current.blocks + blocks.length > maxBlocks || current.logs + logs.length > maxLogs)
          throw new Error("Archive quota reached; export/rotate deliberately before collecting more evidence");
        let previous = current.checkpoint;
        for (const block of blocks) {
          if (block.number !== (previous ? previous.number + 1 : scope.startBlock) ||
              (previous && block.parentHash !== previous.hash)) throw new Error("Non-contiguous archive block ancestry");
          integer(block.number, "block number"); integer(block.timestamp, "block timestamp");
          hash(block.hash, "block hash"); hash(block.parentHash, "parent hash");
          db.prepare("INSERT INTO chain_blocks(number,hash,payload) VALUES(?,?,?)").run(block.number, block.hash, JSON.stringify(block));
          previous = block;
        }
        const blockHashes = new Map(blocks.map((block) => [block.number, block.hash]));
        const contracts = new Set(scope.addresses);
        for (const log of logs) {
          if (!contracts.has(log.address) || blockHashes.get(log.blockNumber) !== log.blockHash)
            throw new Error("Log does not match archived block or contract");
          const identity = `${scope.chainId}:${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
          db.prepare("INSERT INTO chain_logs(identity,block_number,block_hash,transaction_hash,log_index,payload) VALUES(?,?,?,?,?,?)")
            .run(identity, log.blockNumber, log.blockHash, log.transactionHash, log.logIndex, JSON.stringify(log));
        }
        db.exec("COMMIT");
      } catch (error) { try { db.exec("ROLLBACK"); } catch { /* SQLITE_FULL can already roll back. */ } throw error; }
    },
    close: () => db.close(),
  };
}

export async function scanChainEvents(options: {
  rpc: ChainEventRpc; archive: ChainEventArchive; maxBlocks?: number; confirmations?: number; batchSize?: number;
}): Promise<ChainArchiveStatus & { scannedBlocks: number; scannedLogs: number; observedHead: number }> {
  const { rpc, archive } = options;
  const maxBlocks = integer(options.maxBlocks ?? 50, "run block limit", 1, 1_000);
  const confirmations = integer(options.confirmations ?? 20, "confirmation delay", 1, 10_000);
  const batchSize = integer(options.batchSize ?? 50, "batch size", 1, 50);
  if (await rpc.chainId() !== archive.scope.chainId) throw new Error("RPC chain ID does not match archive");
  const observedHead = integer(await rpc.blockNumber(), "head block");
  let previous = archive.status().checkpoint;
  if (previous && (await rpc.block(previous.number)).hash !== previous.hash)
    throw new Error("Checkpoint block hash changed; preserve archive and investigate reorg or RPC disagreement");
  const start = previous ? previous.number + 1 : archive.scope.startBlock;
  const end = Math.min(observedHead - confirmations, start + maxBlocks - 1);
  let scannedBlocks = 0;
  let scannedLogs = 0;
  for (let from = start; from <= end; from += batchSize) {
    const to = Math.min(from + batchSize - 1, end);
    const blocks: ChainBlock[] = [];
    // Sequential bounded reads avoid an RPC burst and establish every empty
    // block's ancestry too. A run is deliberately an audit, not a live indexer.
    for (let number = from; number <= to; number++) blocks.push(await rpc.block(number));
    const logs = await rpc.logs(archive.scope.addresses, from, to);
    if ((await rpc.block(to)).hash !== blocks.at(-1)!.hash)
      throw new Error("Block hash changed during scan; batch was not checkpointed");
    archive.append(previous, blocks, logs);
    previous = blocks.at(-1)!;
    scannedBlocks += blocks.length;
    scannedLogs += logs.length;
  }
  return { ...archive.status(), scannedBlocks, scannedLogs, observedHead };
}
