import { createHmac } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function totp(secret: string, now = Date.now(), digits = 6) {
  const clean = secret.replace(/[\s=]/g, '').toUpperCase();
  if (!/^[A-Z2-7]+$/.test(clean)) throw new Error('TOTP secret is not valid base32');

  const bits = [...clean].map((char) => BASE32.indexOf(char).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));

  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
