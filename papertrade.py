#!/usr/bin/env python3
"""Papertrade research CLI. Read-only network calls; no keys or transactions."""
import argparse
import base64
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
from urllib.error import URLError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
RPC = 'https://rpc.hyperliquid.xyz/evm'
BBO = '0x000000000000000000000000000000000000080e'
MARKETS = {'BTC': (0, 10), 'ETH': (1, 100)}
D = Decimal


def now():
    return datetime.now(timezone.utc).isoformat()


def number(value):
    try:
        n = D(value)
    except InvalidOperation as exc:
        raise argparse.ArgumentTypeError('expected a decimal number') from exc
    if not n.is_finite():
        raise argparse.ArgumentTypeError('number must be finite')
    return n


def fetch(url, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = Request(url, data=data, headers={'User-Agent': 'papertrade-research/0.1',
                                         'Content-Type': 'application/json'})
    with urlopen(req, timeout=20) as response:
        return response.read().decode()


def rpc(method, params):
    if method not in {'eth_chainId', 'eth_blockNumber', 'eth_call'}:
        raise ValueError('Only read-only RPC methods are allowed')
    result = json.loads(fetch(RPC, {'jsonrpc': '2.0', 'id': 1,
                                  'method': method, 'params': params}))
    if 'error' in result:
        raise ValueError(f'RPC error: {result["error"]}')
    return result['result']


def decode_bbo(encoded, scale):
    if not re.fullmatch(r'0x[0-9a-fA-F]{128}', encoded):
        raise ValueError('BBO must contain two ABI words')
    bid, ask = int(encoded[2:66], 16), int(encoded[66:130], 16)
    if not 0 < bid <= ask < 2**64:
        raise ValueError('Zero, crossed, or out-of-range BBO')
    return {'bid': D(bid)/scale, 'ask': D(ask)/scale,
            'mid': D(bid+ask)/(2*scale),
            'integer_mid': D((bid+ask)//2)/scale}


def bbo(coin):
    chain = int(rpc('eth_chainId', []), 16)
    if chain != 999:
        raise ValueError(f'Unexpected chain ID {chain}')
    block = rpc('eth_blockNumber', [])
    asset, scale = MARKETS[coin]
    quote = decode_bbo(rpc('eth_call', [{'to': BBO,
                         'data': '0x'+format(asset, '064x')}, block]), scale)
    return dict(coin=coin, chain_id=chain, block=int(block, 16),
                observed_at=now(), source='HyperCore BBO precompile', **quote)


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.assets = []
        self.runtime = None
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('src'):
            self.assets.append(attrs['src'])
        if tag == 'meta' and attrs.get('name') == 'papertrade-runtime-deployment':
            self.runtime = attrs.get('content')


def status():
    source = fetch('https://papertrade.xyz/')
    page = Page(); page.feed(source)
    descriptor = None
    if page.runtime:
        descriptor = json.loads(base64.b64decode(page.runtime, validate=True))
    return {'checked_at': now(), 'official_url': 'https://papertrade.xyz/',
            'announced_launch_date': '2026-10-10',
            'announcement_url': 'https://x.com/papertrade_xyz/status/2104985864602636607',
            'launch_time': None,
            'coming_soon_text_present': 'coming soon' in source.lower(),
            'runtime_metadata_present': bool(page.runtime),
            'runtime_metadata_unverified': descriptor,
            'trading_enabled_in_this_cli': False,
            'blockers': ['Verified deployment addresses and ABIs',
                         'EIP-712 domains, typed structs, nonce rules',
                         'Authorized relayer API and acceptance/receipt semantics',
                         'Testnet access and end-to-end rehearsal',
                         'Official launch time and user loss budget']}


def extract_docs(source):
    pattern = r'"([a-z-]+/[a-z-]+)":\{title:`([^`]*)`,eyebrow:`([^`]*)`,lead:`([^`]*)`,body:`([\s\S]*?)`\}'
    pages = {}
    for slug, title, eyebrow, lead, body in re.findall(pattern, source):
        body = re.sub(r'<svg[\s\S]*?</svg>', '', body)
        body = html.unescape(re.sub(r'<[^>]+>', ' ', body))
        pages[slug] = {'title': title, 'lead': lead,
                       'text': re.sub(r'[ \t]+', ' ', body),
                       'url': 'https://docs.papertrade.xyz/#/'+slug}
    expected = set(re.findall(r'slug:`([^`]+)`', source))
    if not expected or set(pages) != expected:
        raise ValueError('Docs format changed or extraction incomplete; snapshot not replaced')
    return pages


def refresh_docs():
    url = 'https://docs.papertrade.xyz/'
    source = fetch(url); page = Page(); page.feed(source)
    assets = [urljoin(url, x) for x in page.assets if x.endswith('.js')]
    if len(assets) != 1 or urlparse(assets[0]).netloc != 'docs.papertrade.xyz':
        raise ValueError('Unexpected docs asset layout')
    bundle = fetch(assets[0]); pages = extract_docs(bundle)
    folder = ROOT/'research'/'sources'; folder.mkdir(parents=True, exist_ok=True)
    target = folder/'docs.json'
    old = json.loads(target.read_text()) if target.exists() else {}
    changed = sorted(k for k in pages if old.get(k) != pages[k])
    removed = sorted(set(old)-set(pages))
    # Preserve content-addressed originals so later changes remain reviewable.
    if target.exists():
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        (folder/f'docs-{digest}.json').write_bytes(target.read_bytes())
    target.write_text(json.dumps(pages, indent=2)+'\n')
    (folder/'docs-bundle.js').write_text(bundle)
    record = {'checked_at': now(), 'url': url, 'asset_url': assets[0],
              'sha256': hashlib.sha256(bundle.encode()).hexdigest(),
              'page_count': len(pages), 'changed': changed, 'removed': removed}
    (folder/'docs-manifest.json').write_text(json.dumps(record, indent=2)+'\n')
    return record


def mint_estimate(loss, mode):
    if loss <= 0:
        raise ValueError('loss must be positive')
    basis = loss * (D('.98') if mode == 'solvent-close' else 1)
    tokens = basis * 100
    return {'model': 'Flat-region estimate only; not an onchain quote',
            'assumptions': '100 PAPER per eligible dollar; no threshold crossing',
            'loss_usd': loss, 'mode': mode, 'eligible_basis_usd': basis,
            'paper': tokens, 'loss_cost_per_paper_usd': loss/tokens}


def impact(margin, leverage, move_bps, base_rate, rate_multiplier,
           position_multiplier, reference_notional):
    if margin <= 0 or not 1 <= leverage <= 1000 or move_bps < 0:
        raise ValueError('Require positive margin, leverage 1..1000, and nonnegative move')
    if not 0 <= base_rate < 1 or min(rate_multiplier, position_multiplier) <= 0 or reference_notional < 0:
        raise ValueError('Invalid curve parameters')
    move = move_bps / 10000
    raw = margin * leverage * move
    after_deadband = margin * leverage * max(D(0), move-D('.00002'))
    scale = D(0) if move == 0 else (1-base_rate)/(1+1/(move*rate_multiplier)+reference_notional/(move*position_multiplier))
    return {'model': 'Documentation approximation, not contract-exact; user-supplied curve parameters',
            'raw_gain_usd': raw, 'after_deadband_usd': after_deadband,
            'scale': scale, 'adjusted_gain_usd': after_deadband*scale,
            'assumption': 'Curve uses original entry-to-exit move; contract rounding unverified'}


def plan(coin, side, margin, leverage, entry):
    if margin <= 0 or entry <= 0 or not 1 <= leverage <= 1000:
        raise ValueError('Positive margin/entry and leverage 1..1000 required')
    if margin*leverage > 10_000_000:
        raise ValueError('Exceeds documented $10M cap; live account aggregate cap still needs checking')
    distance = 1/leverage-D('.0005')
    return {'mode': 'UNSIGNED LOCAL PLAN — NOT SUBMITTABLE', 'coin': coin,
            'side': side, 'margin_usd': margin, 'leverage': leverage,
            'notional_usd': margin*leverage, 'reference_entry': entry,
            'approx_bust_price': entry*(1-distance if side == 'long' else 1+distance),
            'approx_adverse_move_bps': distance*10000,
            'maximum_isolated_margin_loss_usd': margin,
            'warning': '5 bps buffer approximation. Not a live liquidation quote or an EIP-712 intent.',
            'unverified': ['instrument ID', 'live OI and user cap', 'available balance',
                           'market retirement/global pause', 'execution price protections']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest='command', required=True)
    subs.add_parser('status', help='Inspect official landing page; never enables trading')
    b = subs.add_parser('bbo', help='Read live bid/ask from the chain'); b.add_argument('coin', choices=MARKETS)
    docs = subs.add_parser('docs'); docs.add_argument('slug', nargs='?'); docs.add_argument('--refresh', action='store_true')
    mint = subs.add_parser('mint', help='Flat-region loss-to-PAPER estimate')
    mint.add_argument('--loss', type=number, required=True)
    mint.add_argument('--mode', choices=['solvent-close', 'insolvent-close', 'liquidation'], required=True)
    tail = subs.add_parser('tail-rate', help='Marginal rate in the tail regime only')
    tail.add_argument('--hwm', type=number, required=True)
    p = subs.add_parser('plan', help='Unsigned local trade plan, never submitted')
    p.add_argument('coin', choices=MARKETS); p.add_argument('side', choices=['long', 'short'])
    for name in ['margin', 'leverage', 'entry']:
        p.add_argument('--'+name, type=number, required=True)
    imp = subs.add_parser('impact', help='Illustrative gain haircut; parameters must be supplied')
    for name in ['margin', 'leverage', 'move-bps', 'base-rate', 'rate-multiplier', 'position-multiplier', 'reference-notional']:
        imp.add_argument('--'+name, type=number, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == 'status': result = status()
        elif args.command == 'bbo': result = bbo(args.coin)
        elif args.command == 'docs':
            if args.refresh: result = refresh_docs()
            else:
                pages = json.loads((ROOT/'research/sources/docs.json').read_text())
                result = pages[args.slug] if args.slug else {k: v['title'] for k,v in pages.items()}
        elif args.command == 'mint': result = mint_estimate(args.loss, args.mode)
        elif args.command == 'tail-rate':
            if args.hwm < 0: raise ValueError('hwm must be nonnegative')
            result = {'tail_hwm_usd': args.hwm, 'paper_per_eligible_dollar': 100*(D(120000000)/(120000000+args.hwm))**2,
                      'model': 'Marginal tail-region rate, not a finite-loss mint quote or current network state'}
        elif args.command == 'plan': result = plan(args.coin,args.side,args.margin,args.leverage,args.entry)
        else:
            result = impact(args.margin,args.leverage,args.move_bps,args.base_rate,args.rate_multiplier,args.position_multiplier,args.reference_notional)
        print(json.dumps(result, indent=2, default=str))
        return 0
    except (ValueError, KeyError, OSError, URLError) as exc:
        print(json.dumps({'error': str(exc)}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
