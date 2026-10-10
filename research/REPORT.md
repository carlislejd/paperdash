# Papertrade: mechanics, strategies, and October 10 readiness

## October 1 update: predeposit and frontend-only launch

This update supersedes the initial launch-access assumptions below. [Official announcement, October 1](https://x.com/papertrade_xyz/status/2105735549822919150) verified through the browser. The 26 docs pages were refreshed October 1 and their content was unchanged; the homepage still has no runtime deployment metadata.

- October 8, 2026: deposits/account creation open at papertrade.xyz, with trading paused. No time/timezone provided. The team explicitly says there is no additional advantage to depositing earlier within this phase. Completing onboarding before launch avoids deposit processing being deprioritized behind trading. No predeposit reward or allocation multiplier is announced.
- October 10: frontend-only trading through whitelisted relayers. The new announcement is stricter than assuming a third-party CLI may submit compatible intents at launch. No approved direct CLI trading route is established; prepare read-only analysis and await an explicitly supported integration or the open-contract phase.
- Intent scheduling uses transaction type and notional value, not account identity, with adaptive weights. Liquidations outrank opens. Smaller notional trades may face particularly long confirmation delays. Exact weights and close-vs-liquidation priority are not published. Pending intents can be cancelled; acknowledgement/race semantics remain unknown.
- PAPER starts minting from zero on realized losses when trading opens. Initially only stake/unstake transfers are supported.
- Later, undated phases: open contract access for humans/contracts/agents; builder codes; token transferability. The post calls the builder compensation a 1% frontend fee; the older docs call it a share of the LP-revenue carve. Exact fee base must be confirmed before modelling it.

Strategy implication (inference): predeposit offers operational readiness, which may help reach early trading/emissions; depositing itself neither mints PAPER nor reserves an emission rate or queue position. No reason is established to race the first second of the deposit window. Treat available credited balance and completed onboarding as the completion criteria, rather than a source-chain transfer alone.

Execution implication (inference): do not equate an atomic onchain trade with fast relayer inclusion. The $250/1000x idea and a Core hedge now need explicit execution-delay and cancel-race modelling. Placing the Core leg while a Papertrade intent is pending creates unhedged exposure; even after a confirmed Papertrade fill, the Core hedge is not atomic. Higher notional priority does not justify increasing risk without measured results. Launch plans should check pending/filled/cancelled state and actual credited balances. Exact close scheduling, deadlines, price protections, and prelaunch withdrawal availability remain unresolved.

No deposit, wallet connection, trade, or scheduled monitor was performed for this update.

Research date: September 29, 2026 Pacific / September 30 UTC.

## Findings and evidence

I read all 26 pages in the official docs, the linked four-page Martingaler whitepaper, and the publicly served landing JavaScript. I also inspected the official landing page in a browser and read BTC/ETH BBO directly from the HyperEVM precompile. This is a documentation and public-interface review, **not a smart-contract audit**: deployed Papertrade bytecode, implementation source, and ABIs were not available from the discovered official links.

The [official launch announcement](https://x.com/papertrade_xyz/status/2104985864602636607) says “10.10.2026”; browser verification succeeded after the web fetch returned 403. No opening time or timezone is stated in its visible text. The attached video did not play, so its contents were not verified. The public [homepage](https://papertrade.xyz/) still displays trade and agent access as coming soon. No Connect button is available.

The docs describe real-USDC synthetic perpetuals, not simulated paper trading. They document PAPER emissions against losses and explicitly say no airdrop. I found no documented separate points program, volume points, daily check-in reward, or referral multiplier. A later campaign could change this; there is no basis to assume volume farming currently earns anything.

## Trading mechanics

Every position is a synthetic swap against the protocol LP. No trade is placed on Hyperliquid's actual perp book. HyperCore supplies pricing; HyperEVM holds position/accounting logic; USDC custody is on HyperCore. BTC and ETH are the documented initial assets, with up to 1000× leverage and a stated $10M per-user position cap. The precise aggregate/per-position enforcement requires source verification. [Trading](https://docs.papertrade.xyz/#/learn/trades-pricing), [architecture](https://docs.papertrade.xyz/#/how/architecture).

Entry and exit reference the current best-bid/best-ask midpoint through precompile `0x000000000000000000000000000000000000080e`. The public bundle maps BTC to asset 0 / price scale 10 and ETH to asset 1 / scale 100, on chain 999. The CLI successfully reads both. The precompile receives ABI-encoded asset index and returns two uint64 values, each padded to a 32-byte word. Contract midpoint rounding may matter; the CLI exposes both arithmetic and integer-rounded midpoints. [Pricing](https://docs.papertrade.xyz/#/how/pricing-bbo).

“Zero slippage” means no size-driven price impact on Papertrade's synthetic fill. It does not lock the price between a button click, signing, relaying, and block inclusion. Available limit-price or deadline protections must be checked in the signed schema. There is no funding payment, conventional spread, or normal notional swap fee; the relayer covers user transaction gas. This does not mean trading is economically free.

Positions are immutable isolated chunks: no adding/removing margin, changing leverage, cross-margin netting, or partial close. Scale in by opening another position; reduce by closing a chunk and reopening smaller. `closeBySig` can close up to 25 position IDs according to the developer page. [Exchange reference](https://docs.papertrade.xyz/#/dev/exchange).

### Winning and losing closes

Ignoring contract units/rounding, raw PnL is notional × signed entry-to-exit return. Wins lose a 0.2 bps price-move deadband, then undergo asymmetric impact. Tiny wins can be zero. The technical formula is:

```
move = abs(exit - entry) / entry
scale = (1 - baseRate) /
        (1 + 1/(move * rateMultiplier)
           + referenceNotional/(move * positionMultiplier))
adjustedPnl = profitAfterDeadband * scale
```

The four curve parameters are market-specific governance settings, not published numeric launch defaults in these docs. Actual fixed-point implementation and whether every branch uses exactly this ordering remain unverified. The reference-notional term is constant per market: breaking one trade into many small trades does not reduce the documented haircut percentage. Bigger price moves retain a greater fraction of raw profit. [Impact](https://docs.papertrade.xyz/#/how/asymmetric-impact), [deadband](https://docs.papertrade.xyz/#/how/risk).

Losing closes deduct the loss from margin. On a solvent loss close, a 2% fee is carved from the LP's proceeds, not charged as an extra loss to the user. The eligible PAPER mint basis is then 98% of loss. During an active queue the loss fee is waived and losses park in `sideBucket`. Liquidations mint on full lost margin. The precise dev/staker split of fee revenue is not established in the available documentation. [Mint basis](https://docs.papertrade.xyz/#/how/mint-curve).

### Liquidation is a hard bust

The displayed bust trigger is approximately 5 bps of underlying price closer to entry than the zero-equity price. Crossing it lets anyone liquidate and forfeit the **entire isolated margin**, even where voluntary close could still return equity. A documentation approximation for adverse distance is `1/leverage - 0.0005`:

| Leverage | Approximate adverse move to bust | Raw margin loss at that move, before hard-bust rule |
| --- | ---: | ---: |
| 10× | 9.95% | 99.5% |
| 100× | 0.95% | 95% |
| 1000× | 0.05% | 50% |

At 1000×, a 5 bps adverse move can therefore confiscate all margin although raw PnL is only about half the margin. This makes simplistic neutral high-leverage pairs especially unattractive. These are approximations, not executable liquidation quotes. [Liquidations](https://docs.papertrade.xyz/#/learn/liquidations).

## LP, queue, and collateral

The LP starts at zero and grows from trader losses. There is no direct LP deposit. Three accounting components matter: `treasury`, `sideBucket`, and `queueTotal`. Net protocol equity is `treasury + sideBucket - queueTotal` and can be negative. Treasury and side bucket themselves are nonnegative. [Queue accounting](https://docs.papertrade.xyz/#/how/solvency-queue).

USD-funded winning closes return margin immediately; profits can become FIFO claims if available backing is insufficient. Losing closes return remaining margin. Queued profit is not withdrawable cash, though docs permit using it to fund new positions. Debt-funded losing trades destroy the consumed claim and mint PAPER on the eligible destroyed portion. The exact mixed cash/debt funding priorities, queue consumption rules, and gas limits need source verification.

With an active queue, losses park in the side bucket. Permissionless `harvest(maxEntries)` pays claims in order from available backing, debiting side bucket first. Residual side bucket returns to treasury once the queue empties. A keeper normally drives this. Harvest does not create capital. The docs' language about eventual repayment is conditional on enough future backing arriving; FIFO is not a payment deadline or unconditional solvency guarantee.

The introductory description speaks of queuing an unpaid portion; technical pseudocode describes appending a payout when it cannot be paid directly. Partial-payment/head-entry behavior must be established from QueueLib, not inferred from the marketing summary.

## PAPER economics and staking

PAPER starts at zero supply, with no team/VC allocation, premint, vesting, or airdrop. The launch token restricts arbitrary transfers; staking/unstaking remain supported. Treat it as an illiquid revenue claim, not something guaranteed to have a sellable token price. [PAPER](https://docs.papertrade.xyz/#/paper/overview).

Below the $2M tracked-LP threshold, including negative tracked LP, the documented rate is 100 PAPER per eligible dollar. Above the threshold, the tail marginal rate is `100 × (120M / (120M + H))²`, where H is the tail progress high-water mark. H does not reset when staker distributions drain tracked LP. At H=$100M the marginal rate is about 29.75 PAPER/$; it is not determined by visible treasury alone. A finite loss crossing regimes requires integrating the curve using actual state. The interaction between a later fall below threshold and a retained high-water mark requires exact source confirmation. [Curve](https://docs.papertrade.xyz/#/how/mint-curve).

| Documented flat-region event | Realized loss | PAPER estimate | Loss cost per PAPER |
| --- | ---: | ---: | ---: |
| Solvent voluntary close | $100 | 9,800 | $0.010204 |
| Insolvent voluntary close | $100 | 10,000 | $0.010000 |
| Liquidation | $100 | 10,000 | $0.010000 |

These figures assume the entire mint basis remains in the flat regime. The extra 200 tokens from liquidation do not justify accepting a full hard bust where a voluntary close would preserve much more capital.

Staking/unstaking have no documented lockup or cooldown. Stakers receive a proportional share of LP-side revenue and LP excess above a $5M staker-reward cap. The $5M number is **not** a total OI cap or minimum guarantee of backing. The exact revenue allocation needs live parameter reads. `pushStakerFees()` forwards exchange-held rewards; staking uses `accRewardPerShare`; `pendingReward(user)` reports accrued amounts; claims credit Exchange balance, then a separate withdrawal moves USDC to HyperCore. The launch profile routes stake/unstake/claim/distribution through authorized signed execution. [Staking](https://docs.papertrade.xyz/#/paper/staking).

Staking early starts exposure to distributions earlier, but later mints dilute the fraction held. More PAPER supply is not more revenue. Economic value is the discounted sum of future USDC actually claimable per token, with dilution, outages, insolvency and cessation of activity included.

## Deposits, sessions, permissions, and admin

Each wallet has a CREATE2-derived deposit proxy. USDC must reach that address's **HyperCore spot account**. A raw ERC-20 transfer on HyperEVM is not monitored as a deposit. Guided HyperEVM funding uses canonical native USDC and CoreDepositWallet. Solana/Arbitrum/Ethereum routes use Circle CCTP V2 toward HyperEVM domain 19 and a forwarder to Core; canonical asset addresses and the actual route must be verified at launch. [Deposits](https://docs.papertrade.xyz/#/learn/deposits-withdrawals).

`requestSweep(user)` snapshots balances and triggers Core transfer; `finalizeSweep(user)` credits the Exchange after settlement. Proxy deployment is relayer-gated; sweep maintenance is public. Docs differ on whether deployment always precedes funding or may follow address registration. Resolve that before sending anything. Accidental HyperEVM ERC-20s may be recoverable via owner `withdrawStuckToken`; this is not the normal deposit flow.

Withdrawals use available balance and target the user's own HyperCore spot account. Main-wallet authorization is required; a session key cannot withdraw. Session keys can still lose the account's trading funds, so “cannot withdraw” is not equivalent to “cannot cause financial loss.” Docs specify seven-day keys, one-hour intent validity, renewal with less than one hour remaining, single-use nonces, and direct wallet revocation. [Sessions](https://docs.papertrade.xyz/#/learn/session-keys), [manager](https://docs.papertrade.xyz/#/dev/session-key-manager).

The relayer-only launch gates opens, closes, session registration, proxy deployment, and staking through configured executors. Public paths include withdrawals with proper wallet authorization, liquidation, harvest, sweep/finalize, and pushing fees. Permissionless liquidation does not establish that there is a liquidator bounty; none was found. Builder codes are a planned 1% share of the LP-revenue carve, **not live** and without a firm date. [Builders](https://docs.papertrade.xyz/#/how/builder-codes).

The pause guardian can permanently retire an instrument ID, freezing its BBO for closes/liquidations; a relisting uses a fresh ID. A separate global opens pause is reversible. Market keepers adjust long/short OI caps, normally targeting current side OI plus $5M headroom with $4.5M–$5.5M hysteresis. These are trailing headroom controls, not $5M total OI limits. Owner/proxy-admin powers sit behind a governance timelock and can ultimately upgrade implementation. The available pages do not give timelock delay, owner addresses, or audit links. [Risk](https://docs.papertrade.xyz/#/how/risk).

BBO only rejects zero/crossed books; there is no independent deviation/TWAP breaker. Deadband and gain haircuts do not prove manipulation unprofitable. This is a risk to counterparties and stakers, not a strategy this toolkit implements.

## Strategy assessment

**1. Trade only where the signal survives the haircut.** Longer meaningful moves should retain more profit than tick scalps under the documented curve. Evaluate signals against execution-time BBO, deadband, gain scaling, liquidation, and cash-versus-queued settlement. Lower leverage buys more room before the hard bust. This is a candidate research direction, not evidence of a profitable signal.

**2. Acquire and stake PAPER only against a budget and cash-flow thesis.** In the flat region, a solvent $100 loss buys roughly 9,800 units of an illiquid claim. Break-even requires future discounted receipts exceeding that $100. A small user-selected loss budget can test actual minting/claims; unlimited turnover or losing deliberately without a valuation model has no established edge. Budget remains unspecified, and the CLI does not place orders.

**3. Opposing positions are not free farming.** With equal notionals, same entry/exit prices, and neither leg liquidated, let raw move profit on the winning leg be G and its adjusted gain A. The losing leg loses G, so combined realized PnL is `A - G`, before token/dividend value. Gross mint on the loser can compensate for this only if PAPER's eventual receipts cover `G - A`. Queue delay can lock the winning profit while the losing leg consumes immediately available cash. At 1000× the liquidation buffer breaks even this simplified symmetry. This needs simulation and rule verification, not a bot assumption.

**4. External hedging is a separate two-venue trade.** A Hyperliquid hedge introduces native fees, funding, basis, collateral requirements, fill timing and independent liquidation. A profitable Papertrade leg may be queued while the external losing leg needs cash now. Model both directions and all cash timing before considering it. No risk-free carry conclusion follows from Papertrade's zero funding alone.

**5. Reusing queue claims changes liquidity exposure.** Docs permit debt-funded trades and PAPER minting on destroyed debt. Choosing to risk a delayed claim rather than fresh USDC could make sense under a valuation model, but it sacrifices the claim and FIFO recovery opportunity. It does not convert a $1 claim into $1 of free risk capital.

**6. Stake timing and keeper work need evidence.** Docs claim time-proportional earnings, but distribution batching and source code must establish whether any last-minute stake can capture prior accumulated fees. Do not assume that edge exists. Public keeper functions are useful operational fallbacks, but no public bounty schedule was found. Future builder revenue is an integration opportunity, not an available farming incentive.

Useful performance measures are net cash PnL, queued receivables separately, full realized loss, PAPER earned, actual USDC claimed, effective loss cost per PAPER, estimated discounted receipts per PAPER, dilution, time in queue, and worst-case capital tied up. Volume or headline token count alone is misleading.

## CLI integration and remaining launch work

The delivered Python CLI performs real oracle reads and documentation/status checks, plus explicit offline estimates. It does not pretend incomplete function names are an ABI. The public landing bundle contains network profile `hl-mainnet-999-production` and its profile digest, but the homepage has no runtime meta tag. A network-profile digest is not an exchange-deployment fingerprint. The hardcoded collateral address is not an exchange/deposit address.

No verified testnet deployment, source repository, exchange address, public relayer API, or full typed-data definitions were discovered through official links/public searches. Search returned similarly named third-party sites; these were not used for wallet connection or address selection.

Once published, implement the following adapters with verified schemas:

| CLI surface | Contract/protocol route | Requirements |
| --- | --- | --- |
| connect/session create | SessionKeyManager registration by signature | Main-wallet signature, exact domain, expiry, fee recipient, authorized submitter |
| session revoke | revokeSessionKey | Main-wallet transaction and receipt |
| account/positions/queue/rewards | Contract views/events or verified indexer | ABI, units, deployment, finalized block/state consistency |
| open | openPositionBySig via batch executor | Instrument ID, nonce, deadline, margin units, direction/leverage representation, price protections |
| close | closeBySig via batch executor | Owned position IDs, max 25, nonce/receipt reconciliation |
| deposit address/status | Factory, requestSweep/finalizeSweep | Factory salt/init-code hash, deployment lifecycle, Core asset/chain verification |
| stake/unstake/claim | Staking by-sig route | Session permissions and exact structs |
| withdraw | withdrawToCore or wallet-signed by-sig | Main-wallet authorization, available balance, receipt and Core arrival |
| maintenance | harvest/liquidate/push fees/sweeps | Public ABI, simulation, gas estimate; no assumed bounty |

The adapter must pin chain, addresses, proxy implementation/code hashes and release fingerprint; decode proposed typed data before signing; track nonces durably; persist submissions and transaction outcomes; distinguish HTTP acceptance from onchain success; avoid blind retries; and reconcile balances/events after uncertain responses. Detect market retirement, expiry, insufficient OI headroom, queue growth and changed deployment before new trades. Cap per-trade margin, cumulative realized loss and total tied-up capital using user-selected limits. Keep signing material out of command-line arguments and logs. No private key is needed for the existing CLI.

Launch sequence:

1. Verify official time/timezone, deposit window, current rules and any points announcement. Refresh and compare docs; their rendered footer is a static April 22, 2026 date, not reliable change history.
2. Obtain canonical runtime descriptor, ABIs/source/audit evidence, relayer API, typed-data definitions and test environment. Confirm live impact settings, caps, mint state, timelock and contract profile.
3. Complete testnet lifecycle including stale nonce, duplicate submission, relayer failure, expiry, loss mint, queue accounting and withdrawal. If no public testnet is provided, mark those checks untested rather than substituting an unrelated deployment.
4. Choose wallet and explicit capital/loss limits. Verify the canonical deposit route/address derivation. Use a small end-to-end mainnet rehearsal only when trading opens and the user chooses amounts.
5. Reconcile deposit, trade, minted PAPER, stake, claim, withdrawal and fees against receipts. Enable strategies only after observed settlement matches the model.

Current readiness: research and read-only tooling are working; **wallet connection, trade submission, contract verification, testnet rehearsal and live strategy validation remain blocked by unavailable launch interfaces**. October 10 is verified; exact time and user loss budget are open. No future monitoring was scheduled.

## Whitepaper versus deployed design

The four-page [Martingaler whitepaper](https://docs.papertrade.xyz/martingaler-whitepaper.pdf) describes a general asynchronous wagering queue, a configurable solvency invariant, token incentives, and simulation examples. Its liquid-token/buy-and-burn idea, yield-bearing collateral extension and queue-principal escape valve are not evidence those features exist in Papertrade's launch profile. The docs explicitly narrow which mechanisms carry over. A queue manages payout order and liquidity timing; it cannot prove a particular trading population produces enough future losses to repay everyone.

Full original text and bundle snapshots are in `sources/`; `docs-manifest.json` records the official asset URL, SHA-256 and fetch time. The page inventory below records complete docs coverage.

1. [What is Papertrade?](https://docs.papertrade.xyz/#/intro/what-is-papertrade) — read and archived.

2. [FAQ](https://docs.papertrade.xyz/#/intro/faq) — read and archived.

3. [Quick start](https://docs.papertrade.xyz/#/intro/quick-start) — read and archived.

4. [Trades and pricing](https://docs.papertrade.xyz/#/learn/trades-pricing) — read and archived.

5. [Wins and losses](https://docs.papertrade.xyz/#/learn/wins-losses) — read and archived.

6. [Liquidations](https://docs.papertrade.xyz/#/learn/liquidations) — read and archived.

7. [The LP and the payout queue](https://docs.papertrade.xyz/#/learn/lp-queue) — read and archived.

8. [Paper Emissions](https://docs.papertrade.xyz/#/learn/paper-emissions) — read and archived.

9. [Staking Dividends](https://docs.papertrade.xyz/#/learn/staking-dividends) — read and archived.

10. [Deposits and withdrawals](https://docs.papertrade.xyz/#/learn/deposits-withdrawals) — read and archived.

11. [Session keys](https://docs.papertrade.xyz/#/learn/session-keys) — read and archived.

12. [Architecture overview](https://docs.papertrade.xyz/#/how/architecture) — read and archived.

13. [Pricing: BBO precompile](https://docs.papertrade.xyz/#/how/pricing-bbo) — read and archived.

14. [Asymmetric impact PnL](https://docs.papertrade.xyz/#/how/asymmetric-impact) — read and archived.

15. [Solvency & queue](https://docs.papertrade.xyz/#/how/solvency-queue) — read and archived.

16. [PAPER mint curve](https://docs.papertrade.xyz/#/how/mint-curve) — read and archived.

17. [Deposits: CREATE2 proxies](https://docs.papertrade.xyz/#/how/deposits) — read and archived.

18. [Builder codes](https://docs.papertrade.xyz/#/how/builder-codes) — read and archived.

19. [Risk](https://docs.papertrade.xyz/#/how/risk) — read and archived.

20. [Martingaler LP](https://docs.papertrade.xyz/#/martingaler/overview) — read and archived.

21. [$PAPER overview](https://docs.papertrade.xyz/#/paper/overview) — read and archived.

22. [Staking & claims](https://docs.papertrade.xyz/#/paper/staking) — read and archived.

23. [Contract addresses](https://docs.papertrade.xyz/#/dev/contract-addresses) — read and archived.

24. [Exchange contract](https://docs.papertrade.xyz/#/dev/exchange) — read and archived.

25. [SessionKeyManager](https://docs.papertrade.xyz/#/dev/session-key-manager) — read and archived.

26. [PAPER contracts](https://docs.papertrade.xyz/#/dev/paper-contracts) — read and archived.
