import { readFile } from "node:fs/promises";
import { prepareRelayerIntent, readRelayerQueueRanks, verifyRelayerProtocol } from "../apps/server/src/relayer.js";

// This CLI deliberately has no sign, submit, cancel, or key-handling command.
const [command, argument, ...extra] = process.argv.slice(2);
try {
  if (extra.length) throw new Error("Too many arguments");
  let result: unknown;
  if (command === "verify" && !argument) result = await verifyRelayerProtocol();
  else if (command === "queue" && argument) result = await readRelayerQueueRanks(argument);
  else if (command === "prepare" && argument) {
    const source = await readFile(argument, "utf8");
    if (Buffer.byteLength(source) > 16384) throw new Error("Intent input exceeds size limit");
    const protocol = await verifyRelayerProtocol();
    result = { protocol, ...prepareRelayerIntent(JSON.parse(source)) };
  } else {
    throw new Error("Usage: npx tsx scripts/papertrade-relayer.ts verify | queue <wallet> | prepare <intent.json>\n"
      + "prepare requires action, user, nonce and deadline (Unix seconds, next hour). All integers are decimal strings.\n"
      + "openPosition also requires instrumentId (0 BTC / 1 ETH), isLong, size (18-decimal margin), leverage, useDebt.\n"
      + "closePositions requires positionIds (1–12). paperStake/paperUnstake require amount (18-decimal PAPER). paperClaim needs no amount.\n"
      + "Preparation does not reserve the nonce or validate balances, market limits, position ownership or authorization.");
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : "Relayer operation failed") + "\n");
  process.exitCode = 1;
}
