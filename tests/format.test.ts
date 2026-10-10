import { describe, expect, it } from 'vitest';
import { formatRawUsd, formatUsd, rawToNumber } from '../apps/web/src/lib/format';

describe('raw amount conversion for chart display', () => {
  it('handles integer assets with zero decimals without shifting the amount', () => {
    expect(rawToNumber('12345', 0)).toBe(12345);
    expect(rawToNumber('-42', 0)).toBe(-42);
    expect(rawToNumber('0', 0)).toBe(0);
  });

  it('distinguishes native USDC units and protocol accounting units', () => {
    expect(rawToNumber('10779000000', 6)).toBe(10779);
    expect(rawToNumber('10779000000000000000000')).toBe(10779);
    expect(rawToNumber('1', 18)).toBe(1e-18);
    expect(rawToNumber('-1250000', 6)).toBe(-1.25);
  });

  it('rejects invalid raw amounts, scales and overflowing chart values', () => {
    for (const raw of [null, undefined, '', '1.2', '1e18', 'NaN', '--1', '+5']) expect(rawToNumber(raw)).toBeNull();
    for (const scale of [-1, .5, Number.NaN, Infinity, 256]) expect(rawToNumber('10', scale)).toBeNull();
    expect(rawToNumber('9'.repeat(400), 0)).toBeNull();
    expect(formatUsd(Infinity)).toBe('—');
    expect(formatUsd(Number.NaN)).toBe('—');
  });
});

describe('exact raw USDC formatting', () => {
  it('rounds at half-cent boundaries using integer arithmetic', () => {
    expect(formatRawUsd('4999999999999999')).toBe('$0.00');
    expect(formatRawUsd('5000000000000000')).toBe('$0.01');
    expect(formatRawUsd('-5000000000000000')).toBe('−$0.01');
    expect(formatRawUsd('9994999999999999999')).toBe('$9.99');
    expect(formatRawUsd('9995000000000000000')).toBe('$10.00');
  });

  it('preserves cents for values above the safe floating point range', () => {
    const whole = 9007199254740993n;
    expect(formatRawUsd((whole * 10n ** 18n + 12n * 10n ** 16n).toString())).toBe('$9,007,199,254,740,993.12');
    expect(formatRawUsd((whole * 10n ** 18n + 125n * 10n ** 15n).toString())).toBe('$9,007,199,254,740,993.13');
    const maxUint256 = (2n ** 256n - 1n).toString();
    expect(formatRawUsd(maxUint256)).toBe('$115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457.58');
  });

  it('keeps unavailable distinct from zero', () => {
    expect(formatRawUsd(null)).toBe('—');
    expect(formatRawUsd('invalid')).toBe('—');
    expect(formatRawUsd('0')).toBe('$0.00');
    expect(formatRawUsd('-0')).toBe('$0.00');
  });
});
