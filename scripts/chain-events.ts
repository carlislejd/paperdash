import { parseArgs } from "node:util";
import { createChainEventRpc, openChainEventArchive, scanChainEvents } from "../apps/server/src/chain-events.js";

const { values } = parseArgs({ options: {
  rpc: { type: "string", default: "https://rpc.hyperliquid.xyz/evm" },
  database: { type: "string" }, deployment: { type: "string" }, addresses: { type: "string" },
  "from-block": { type: "string" }, "chain-id": { type: "string", default: "999" },
  "max-blocks": { type: "string", default: "50" }, confirmations: { type: "string", default: "20" },
  "max-bytes": { type: "string", default: String(128 * 1024 * 1024) },
  "max-logs": { type: "string", default: "100000" }, "max-retained-blocks": { type: "string", default: "100000" },
  help: { type: "boolean", default: false },
} });
if (values.help) {
  console.log(`Read-only raw HyperEVM event archive (no ABI decoding or analytics import).

Usage: npx tsx scripts/chain-events.ts --database PATH --deployment ID --addresses 0x...,0x... --from-block NUMBER

Required scope is pinned permanently in the archive. Supply the published deployment
fingerprint and verified contract addresses; start block is your chosen coverage
start, not an inferred genesis. Repeat the same command to resume atomically.

Options: --rpc URL --chain-id 999 --max-blocks 50 (maximum 1000 per run)
         --confirmations 20 --max-bytes 134217728 --max-logs 100000
         --max-retained-blocks 100000

Each getLogs request covers at most 50 blocks. A hash disagreement or storage quota
stops collection without deleting evidence. A confirmation delay is not a proof of
finality. Retained logs are RPC observations, not independently verified completeness.
SQLite tables: archive_scope, chain_blocks, chain_logs (JSON payload + immutable ID).`);
} else {
  if (!values.database || !values.deployment || !values.addresses || values["from-block"] === undefined)
    throw new Error("Required: --database --deployment --addresses --from-block (see --help)");
  const decimal = (name: string, value: string | undefined) => {
    if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid --${name}`);
    return Number(value);
  };
  const rpc = createChainEventRpc(values.rpc!);
  const archive = openChainEventArchive(values.database, {
    chainId: decimal("chain-id", values["chain-id"]), deploymentId: values.deployment,
    addresses: values.addresses.split(","), startBlock: decimal("from-block", values["from-block"]),
  }, {
    maxBytes: decimal("max-bytes", values["max-bytes"]), maxLogs: decimal("max-logs", values["max-logs"]),
    maxBlocks: decimal("max-retained-blocks", values["max-retained-blocks"]),
  });
  try {
    console.log(JSON.stringify(await scanChainEvents({ rpc, archive,
      maxBlocks: decimal("max-blocks", values["max-blocks"]),
      confirmations: decimal("confirmations", values.confirmations),
    }), null, 2));
  } finally { archive.close(); }
}
