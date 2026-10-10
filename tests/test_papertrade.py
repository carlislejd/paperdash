import unittest
from decimal import Decimal as D
import papertrade as p


class Mechanics(unittest.TestCase):
    def test_bbo_scaling_and_invalid_books(self):
        encoded = '0x'+format(800001,'064x')+format(800002,'064x')
        self.assertEqual(p.decode_bbo(encoded,10)['mid'],D('80000.15'))
        self.assertEqual(p.decode_bbo(encoded,10)['integer_mid'],D('80000.1'))
        for bid, ask in [(0,1),(2,1),(1,2**64)]:
            with self.assertRaises(ValueError):
                p.decode_bbo('0x'+format(bid,'064x')+format(ask,'064x'),10)

    def test_loss_basis(self):
        self.assertEqual(p.mint_estimate(D(100),'solvent-close')['paper'],9800)
        self.assertEqual(p.mint_estimate(D(100),'liquidation')['paper'],10000)

    def test_high_leverage_bust(self):
        r=p.plan('BTC','long',D(100),D(1000),D(100000))
        self.assertEqual(r['approx_bust_price'],99950)
        self.assertEqual(r['approx_adverse_move_bps'],5)
        self.assertEqual(p.plan('BTC','short',D(100),D(100),D(100000))['approx_bust_price'],100950)

    def test_deadband_and_scale(self):
        def quote(move): return p.impact(D(100),D(10),D(move),D('.01'),D(1000),D(1000000),D(1000))
        self.assertEqual(quote('.2')['adjusted_gain_usd'],0)
        self.assertGreater(quote('100')['scale'],quote('10')['scale'])
        self.assertLess(quote('100')['adjusted_gain_usd'],quote('100')['raw_gain_usd'])

    def test_docs_coverage(self):
        source=(p.ROOT/'research/sources/docs-bundle.js').read_text()
        self.assertEqual(len(p.extract_docs(source)),26)
        with self.assertRaises(ValueError): p.extract_docs('changed format')

    def test_reject_invalid_plans(self):
        for margin, leverage in [(D(0),D(1)),(D(1),D(1001)),(D(20000),D(1000))]:
            with self.assertRaises(ValueError): p.plan('BTC','long',margin,leverage,D(100))

    def test_rpc_cannot_write(self):
        with self.assertRaises(ValueError): p.rpc('eth_sendRawTransaction',[])


if __name__=='__main__': unittest.main()
