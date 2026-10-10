import type { Page } from '@playwright/test';
import type { Account, AccountsResponse, Cashflow, Overview, WalletResponse } from '../../packages/shared/src/types';

// Synthetic, test-only source data. No production module imports these fixtures.
export const WALLET = `0x${'11'.repeat(20)}`;
export const SECOND_WALLET = `0x${'22'.repeat(20)}`;
const usd = (amount: number) => (BigInt(amount) * 10n ** 18n).toString();

export function account(address: string, name: string): Account {
  return {
    address, leaderboardName: name, currentBalance: usd(10779), currentQueued: '0',
    currentOpenNotional: '0', currentOpenPositionCount: 0, currentUnrealizedPnl: '0',
    realizedPnl: '0', totalVolume: '0', totalWindowedPnl: '0', paperTotal: '0', lastActiveTs: Date.now(),
  };
}

export function overview(stale = false): Overview {
  const at = Date.now() - (stale ? 120_000 : 0);
  return {
    summary: {
      ok: true, source: { block: '12345', at },
      balances: { tvl: usd(66320000), margin: '0', lp: usd(66320000), reserve: '0', queue: '0' },
      activity: { volume: '0', open: 0 }, fees: { pending: '0', lifetime: '0' }, paper: { supply: '0', staked: '0' },
    },
    accountCount: 5902,
    history: [{ time: at - 86400000, value: 64000000 }, { time: at, value: 66320000 }],
    historyCoverage: 'upstream', trades: [],
    status: { receivedAt: at, sourceAt: at, indexedBlock: '12345', stale, persistence: 'postgres', stream: 'connected' },
  };
}

export function deposit(amount: number, suffix: string, timestampMs = Date.now() - 86400000): Cashflow {
  return { timestampMs, txHash: `0x${suffix.repeat(64)}`, amountRaw: usd(amount), kind: 'Deposit', recipientAmountRaw: null, route: null, withdrawalStatus: null };
}

export function walletResponse(address = WALLET, at = Date.now()): WalletResponse {
  return {
    address,
    snapshot: {
      address, indexedThroughBlock: 12345, indexedThroughTimestamp: at, balance: usd(10779), queued: '0', locked: '0', accountRevision: 3,
      lifetime: { depositedRaw: usd(10779), withdrawnRaw: '0', realizedPnlRaw: '0', feesPaidRaw: '0', tradedNotionalRaw: '0', paperRewardsClaimedRaw: '0' },
      paper: { balance: '0', staked: '0' }, openPositions: [],
    },
    cashflows: { items: [deposit(3000, 'a', at - 86400000)], nextCursor: 'older-deposits' },
    trades: { items: [], nextCursor: null },
    portfolio: {
      baseTimeMs: at - 86400000, timeOffsetsMs: [0, 43200000, 86400000],
      columns: { equity: [3000, 7000, 10779], pnl: [0, 0, 0] }, gapIndices: [1],
      coverage: { availableFromMs: at - 86400000, availableToMs: at, complete: false },
    },
    receivedAt: at, stale: false, errors: [],
  };
}

export async function mockSources(page: Page, options: { stale?: boolean; walletFailure?: boolean; missingWalletSnapshot?: boolean } = {}) {
  const walletDataAt = Date.now();
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/events') {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': deterministic test stream\n\n' });
      return;
    }
    if (url.pathname === '/api/overview') {
      await route.fulfill({ json: overview(options.stale) });
      return;
    }
    if (url.pathname === '/api/accounts') {
      const query = (url.searchParams.get('q') ?? '').toLowerCase();
      const number = Number(url.searchParams.get('page') ?? '0');
      const all = [account(WALLET, 'Aoi'), account(SECOND_WALLET, 'Yuki')];
      const accounts = query ? all.filter(a => `${a.address} ${a.leaderboardName}`.toLowerCase().includes(query)) : [all[Math.min(number, 1)]];
      const result: AccountsResponse = {
        accounts, count: 2, pageInfo: { page: number, totalPages: query ? 1 : 2 },
        summary: { uniqueAccounts: 2, trackedBalance: usd(21558), trackedQueued: '0', trackedOpenNotional: '0', trackedPaper: '0' },
        receivedAt: Date.now(), stale: Boolean(options.stale),
      };
      await route.fulfill({ json: result });
      return;
    }
    const match = url.pathname.match(/^\/api\/wallets\/(0x[0-9a-f]{40})(\/cashflows|\/trades)?$/i);
    if (match) {
      if (options.walletFailure) { await route.fulfill({ status: 503, json: { message: 'Source temporarily unavailable' } }); return; }
      if (match[2]) { await route.fulfill({ json: { items: match[2] === '/cashflows' ? [deposit(7779, 'b', walletDataAt - 172800000)] : [], nextCursor: null } }); return; }
      const wallet = walletResponse(match[1], walletDataAt);
      if (options.missingWalletSnapshot) { wallet.snapshot = null; wallet.errors = ['Wallet snapshot unavailable']; }
      await route.fulfill({ json: wallet });
      return;
    }
    await route.fulfill({ status: 404, json: { message: 'Unexpected test API route' } });
  });
}
