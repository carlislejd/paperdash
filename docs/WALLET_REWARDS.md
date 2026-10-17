# Wallet rewards and P&L cards

P&L cards show lifetime realized trading P&L plus lifetime claimed and currently pending staking rewards. The two components remain visible beneath the headline. Open-position P&L and the value of PAPER tokens are not part of this total. The portfolio-history P&L series is not reused because its source definition can already include rewards.

All amounts are integer strings in 18-decimal USDC units until display formatting. Claimed rewards come from `wallet.lifetime.paperRewardsClaimedRaw`. Pending rewards use:

```text
pendingBase + floor(staked * accumulator / 10^27) - rewardDebt
```

The wallet's `pendingBase` is only one component. Neither protocol-wide pending rewards nor the directory's `stakingRewards` field supplies the wallet's complete claimable amount. In the checked live accounts, the directory field matched lifetime claimed rewards only.

## Source verification

Verified October 14, 2026 using the official [staking documentation](https://docs.papertrade.xyz/#/paper/staking), public wallet streams, protocol summary, and read-only contract calls to the deployed PaperStaking address `0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016` through `https://rpc.hyperliquid.xyz/evm`.

At fixed block `48573349`, `accRewardPerShare()` returned `11885583543202400471492696`. The formula matched `pendingReward(address)` exactly for three wallets, including one with a nonzero `pendingBase`. The selectors were `0x939d6237` for the accumulator and `0xf40f0f52` for pending rewards. [Captured verification vectors](../research/sources/staking-2026-10-14/pending-reward-verification.json) retain the input fields and exact contract outputs; a regression test uses the first vector.

The official account wire exposes `pendingBase` and `rewardDebt`, and validates that `walletRevision <= indexedThroughBlock`. Its rewards selector uses `walletRevision` as the account state revision separately from the indexed watermark. The live sample's wallet revision was `48562247` while its indexed watermark was `48567718`. An advancing watermark therefore does not itself mean that the stake changed. Older snapshots without `walletRevision` use the indexed watermark conservatively.

The public summary's accumulator was slightly behind the direct contract value even at the same advertised block. The application consequently describes an observed indexer calculation, not a claim of independently reconciled current chain state. Production reads remain the existing public summary and wallet stream; contract calls were used only for verification.

## Coherence, caching and missing data

During the existing wallet snapshot refresh, the server reads the retained protocol summary before opening the account stream. It requires the summary block to reach the account's last state revision, rejects an impossible revision above the indexed watermark, and requires valid source and receipt clocks. Missing reward fields, a failed summary, an older accumulator, or accrued rewards below reward debt leave pending unavailable.

The computed pending amount and its clocks are stored atomically inside the same cached snapshot. Subsequent wallet reads reuse that pair; a newer global accumulator cannot accrue rewards against an older cached stake after a stake or unstake. Claimed and pending amounts always come from the same paired wallet state, so a claim transfers value between the two components without increasing their sum. This adds no source request, polling loop, RPC dependency, database migration, or history scan.

The public `WalletResponse.stakingRewards` block contains `pendingRaw`, `receivedAt`, `sourceAt`, and `stale`. Its receipt clock is the older receipt of the paired account and summary; its source clock is the accumulator observation. Saved pairs age after 30 seconds and retain their original clocks. An old cache entry without a pair remains unavailable until its normal account refresh. Missing pending is not interpreted as zero or as claimed-only total P&L. The card shows the available trading and claimed values with an explicit pending-unavailable note.

The wallet's last account-change timestamp may remain old for an inactive account after a successful fresh check. That timestamp alone does not make the account stale. Future or inconsistent timestamps are rejected; summary age and successful observation receipts determine reward freshness.

## PAPER break-even price

The wallet sidepanel and all three P&L card layouts use the same reward-adjusted break-even calculation:

```text
rewards = lifetime claimed USDC + verified pending USDC
remaining loss = max(0, -(lifetime realized trading P&L + rewards))
PAPER owned = staked PAPER + unstaked PAPER
PAPER break-even = remaining loss / PAPER owned
```

The result is USDC per PAPER: the price at which the currently owned PAPER would cover the remaining realized trading loss after rewards. It excludes open-position P&L and is neither a market quote nor an acquisition cost basis. A positive PAPER balance with a known nonnegative combined result displays **Cost recovered**, including when rewards exactly cover the trading loss. Zero PAPER or missing/invalid trading, claimed, pending or ownership data leaves the value unavailable. Missing pending is never treated as zero.

Arithmetic uses raw integers until formatting. Positive prices show six decimal places; a smaller positive price shows `<$0.000001`, never a rounded zero. Retained but stale inputs show a Last available note. P&L cards freeze the same calculation and source freshness at creation; preview, exported PNG and accessible/share text use the frozen value.
