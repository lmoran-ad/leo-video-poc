import { expect, test } from '@playwright/test';
import { totp } from './totp';

// RFC 6238 appendix B vectors: SHA-1, ASCII secret "12345678901234567890"
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('totp matches the RFC 6238 test vectors', () => {
  expect(totp(RFC_SECRET, 59_000, 8)).toBe('94287082');
  expect(totp(RFC_SECRET, 1_111_111_109_000, 8)).toBe('07081804');
  expect(totp(RFC_SECRET, 2_000_000_000_000, 8)).toBe('69279037');
});

test('totp accepts the spaced lowercase form authenticator apps display', () => {
  expect(totp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', 59_000, 8)).toBe('94287082');
});

test('totp rejects a malformed secret', () => {
  expect(() => totp('not-base32!')).toThrow('not valid base32');
});
