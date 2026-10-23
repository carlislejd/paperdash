import { createHash } from "node:crypto";
import { z } from "zod";

// Audited against the official published frontend; see research/sources/relayer-2026-10-22.json.
export const RELAYER_REFERENCE = Object.freeze({
  origin: "https://exchange.papertrade.xyz",
  build: "534f834f9fba",
  chainId: 999,
  exchange: "0x6cd5661646289fb6e65ea5c032310fded797d0a2",
  paperStaking: "0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016",
  appPath: "/assets/app-CFJuu9ZC.js",
  hooksPath: "/assets/hooks-BJZTi_5H.js",
  sources: Object.freeze([
    { path: "/assets/typed-data-B0hqt2-N.js", sha256: "ff04eb15141ecc5fd02bf9a2f7cf3a0440396b5e7d08bb6aed6d545e244213de", maxBytes: 16384 },
    { path: "/assets/deployment-DAcrFcif.js", sha256: "2f412ab34c15071d5108853b2463482c602897a6dc194a880fff8b90ac8c8da2", maxBytes: 16384 },
    { path: "/assets/build-CtUUdw4p.js", sha256: "864760ff104564547300e0608ed57af8555a79d95dfbcff5cfd0b482b8deaa71", maxBytes: 16384 },
    { path: "/assets/app-CFJuu9ZC.js", sha256: "a33fc666ef399f226862ea5e03930409ee6db6d262a1f7e9ef57fe61b6a433d9", maxBytes: 1048576 },
    { path: "/assets/hooks-BJZTi_5H.js", sha256: "adede39fbffcaa7a6088a51eec792006cea1635d045a3560a8bb0167c0b1cf58", maxBytes: 131072 },
  ]),
});

const address = z.string().regex(/^0x[\da-fA-F]{40}$/).transform((value) => value.toLowerCase());
const hash = z.string().regex(/^0x[\da-f]{64}$/);
const decimalPattern = /^(0|[1-9]\d*)$/;
const uint = (bits: number) => z.string().max(78).regex(decimalPattern)
  .refine((value) => value.length <= 78 && decimalPattern.test(value) && BigInt(value) < 1n << BigInt(bits), `Value exceeds uint${bits}`);
const positive = (bits: number) => uint(bits).refine((value) => value.length <= 78 && decimalPattern.test(value) && BigInt(value) > 0n, "Value must be positive");
const base = { user: address, nonce: uint(256), deadline: positive(64) };
const commonFields = [
  { name: "user", type: "address" },
];
const suffixFields = [{ name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" }];
const definitions = {
  openPosition: {
    primaryType: "OpenPosition",
    fields: [...commonFields, { name: "instrumentId", type: "uint32" }, { name: "isLong", type: "bool" },
      { name: "size", type: "uint128" }, { name: "leverage", type: "uint32" }, { name: "useDebt", type: "bool" }, ...suffixFields],
  },
  closePositions: {
    primaryType: "Close", fields: [...commonFields, { name: "positionIds", type: "uint256[]" }, ...suffixFields],
  },
  paperStake: { primaryType: "Stake", fields: [...commonFields, { name: "amount", type: "uint256" }, ...suffixFields] },
  paperUnstake: { primaryType: "Unstake", fields: [...commonFields, { name: "amount", type: "uint256" }, ...suffixFields] },
  paperClaim: { primaryType: "Claim", fields: [...commonFields, ...suffixFields] },
} as const;

const intentSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("openPosition"), ...base, instrumentId: uint(32).refine((id) => id === "0" || id === "1", "Unknown deployment instrument"),
    isLong: z.boolean(), size: positive(128), leverage: positive(32), useDebt: z.boolean() }).strict(),
  z.object({ action: z.literal("closePositions"), ...base,
    positionIds: z.array(uint(256)).min(1).max(12).refine((ids) => new Set(ids).size === ids.length, "Duplicate position IDs") }).strict(),
  z.object({ action: z.literal("paperStake"), ...base, amount: positive(256) }).strict(),
  z.object({ action: z.literal("paperUnstake"), ...base, amount: positive(256) }).strict(),
  z.object({ action: z.literal("paperClaim"), ...base }).strict(),
]);
export type RelayerIntent = z.input<typeof intentSchema>;

/** Pure preparation: does not reserve a nonce, check balance/session/market admission, sign, or submit. */
export function prepareRelayerIntent(value: unknown, nowMs = Date.now()) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid preparation time");
  const { action, ...message } = intentSchema.parse(value);
  const now = BigInt(Math.floor(nowMs / 1000));
  if (BigInt(message.deadline) <= now || BigInt(message.deadline) > now + 3600n) {
    throw new Error("Deadline must be in the next hour, in Unix seconds");
  }
  if (/^0x0{40}$/.test(message.user)) throw new Error("A nonzero user address is required");
  const staking = action.startsWith("paper");
  const definition = definitions[action];
  return {
    action,
    typedData: {
      domain: {
        name: staking ? "PaperStaking" : "String", version: "1", chainId: RELAYER_REFERENCE.chainId,
        verifyingContract: staking ? RELAYER_REFERENCE.paperStaking : RELAYER_REFERENCE.exchange,
      },
      types: { [definition.primaryType]: definition.fields.map((field) => ({ ...field })) },
      primaryType: definition.primaryType,
      message,
    },
    checks: { nonceReserved: false, admissionChecked: false, signatureCreated: false },
  };
}

async function boundedText(response: Response, maxBytes: number) {
  const length = Number(response.headers.get("content-length"));
  if (length > maxBytes) throw new Error("Relayer response exceeds size limit");
  if (!response.body) throw new Error("Empty relayer response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Relayer response exceeds size limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

type Transport = { fetcher?: typeof fetch; signal?: AbortSignal };
function signal(options: Transport, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

/** Fail closed when the active frontend no longer references the audited protocol modules. */
export async function verifyRelayerProtocol(options: Transport = {}) {
  const fetcher = options.fetcher ?? fetch;
  const deadline = signal(options, 10000);
  const read = async (path: string, limit: number) => {
    const response = await fetcher(RELAYER_REFERENCE.origin + path, {
      method: "GET", redirect: "error", cache: "no-store", signal: deadline,
    });
    if (!response.ok) throw new Error(`Relayer source verification returned HTTP ${response.status}`);
    return boundedText(response, limit);
  };
  const html = await read("/trade/btc", 65536);
  for (const path of [RELAYER_REFERENCE.appPath, RELAYER_REFERENCE.hooksPath, ...RELAYER_REFERENCE.sources.map((source) => source.path)]) {
    if (!html.includes(`"${path}"`)) throw new Error("Papertrade frontend changed; relayer protocol needs review");
  }
  await Promise.all(RELAYER_REFERENCE.sources.map(async (source) => {
    const body = await read(source.path, source.maxBytes);
    if (createHash("sha256").update(body).digest("hex") !== source.sha256) {
      throw new Error("Papertrade relayer source fingerprint changed");
    }
  }));
  return { build: RELAYER_REFERENCE.build, chainId: RELAYER_REFERENCE.chainId };
}

const ranksSchema = z.object({
  ok: z.literal(true), queueRevision: uint(256).optional(),
  entries: z.array(z.object({ intentId: hash, position: positive(256) })).max(1000),
});

/** Queue placement is a relayer read, not an execution receipt or complete intent history. */
export async function readRelayerQueueRanks(wallet: string, options: Transport = {}) {
  const user = address.parse(wallet);
  const response = await (options.fetcher ?? fetch)(`${RELAYER_REFERENCE.origin}/queue-rank/accounts/${user}`, {
    method: "GET", headers: { Accept: "application/json" }, redirect: "error", cache: "no-store", signal: signal(options, 10000),
  });
  if (!response.ok) throw new Error(`Relayer queue read returned HTTP ${response.status}`);
  const data = ranksSchema.parse(JSON.parse(await boundedText(response, 262144)));
  if (new Set(data.entries.map((entry) => entry.intentId)).size !== data.entries.length) throw new Error("Duplicate queue intent IDs");
  return { wallet: user, queueRevision: data.queueRevision ?? null, entries: data.entries };
}

const signatureSchema = z.object({ v: z.enum(["27", "28"]), r: hash, s: hash }).strict();
const receiptSchema = z.object({ intentId: hash, action: z.enum(Object.keys(definitions) as [keyof typeof definitions, ...Array<keyof typeof definitions>]),
  state: z.enum(["queued", "prepared", "confirmed", "failed", "reverted", "expired", "cancelled"]), queueRevision: uint(256) });
const rejectionCodes = new Set(["invalid_intent", "deadline_expired", "unauthorized_intent", "intent_conflict", "admission_rejected",
  "below_minimum_paper_stake", "below_minimum_withdrawal", "invalid_onward", "intake_action_paused", "rate_limited"]);

export class RelayerSubmissionError extends Error {
  constructor(public readonly outcome: "rejected" | "unknown", public readonly code: string) {
    super(outcome === "unknown" ? "Relayer outcome is unknown; reconcile before another submission" : `Relayer rejected intent: ${code}`);
    this.name = "RelayerSubmissionError";
  }
}

/**
 * Sends only an explicitly supplied, already signed intent after source verification.
 * Caller owns signer recovery, nonce persistence and expectedIntentId derivation.
 * Never retries. Acknowledgement and reported state are not independent chain confirmation.
 * Not wired to the public server or CLI; no keys or wallet signing are accepted here.
 */
export async function submitSignedRelayerIntent(
  input: { intent: RelayerIntent; signature: z.input<typeof signatureSchema>; expectedIntentId: string },
  options: Transport & { now?: () => number } = {},
) {
  const expected = hash.parse(input.expectedIntentId);
  const signature = signatureSchema.parse(input.signature);
  const initial = prepareRelayerIntent(input.intent, (options.now ?? Date.now)());
  await verifyRelayerProtocol(options);
  // Verification itself takes time; reject an intent that expired during that preflight.
  const prepared = prepareRelayerIntent({ action: initial.action, ...initial.typedData.message }, (options.now ?? Date.now)());
  const body = JSON.stringify({ action: prepared.action, signed: { ...prepared.typedData.message, ...signature } });
  try {
    const response = await (options.fetcher ?? fetch)(`${RELAYER_REFERENCE.origin}/intents`, {
      method: "POST", redirect: "error", cache: "no-store", signal: signal(options, 35000),
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Papertrade-Build": RELAYER_REFERENCE.build }, body,
    });
    const payload: unknown = JSON.parse(await boundedText(response, 32768));
    const envelope = z.record(z.string(), z.unknown()).parse(payload);
    if (!response.ok || envelope.error || envelope.ok === false) {
      const code = typeof envelope.code === "string" ? envelope.code : typeof envelope.error === "string" ? envelope.error : "request_failed";
      throw new RelayerSubmissionError(rejectionCodes.has(code) ? "rejected" : "unknown", code);
    }
    const receipt = receiptSchema.parse(payload);
    if (receipt.intentId !== expected || receipt.action !== prepared.action) throw new Error("Mismatched relayer acknowledgement");
    return { ...receipt, acknowledgementReceived: true as const, executionVerified: false as const };
  } catch (error) {
    if (error instanceof RelayerSubmissionError) throw error;
    throw new RelayerSubmissionError("unknown", "acknowledgement_unknown");
  }
}
