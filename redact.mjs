const SENSITIVE_KEY = /pass|token|secret|otp|code|auth|cookie|jwt|mfa|session/i;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, SENSITIVE_KEY.test(key) ? '[redacted]' : redact(inner)]),
    );
  }
  return value;
}

export function readBody(text) {
  if (!text) return undefined;
  if (text.includes('otpauth://')) return '[redacted otpauth link]';
  try {
    return redact(JSON.parse(text));
  } catch {
    return `[non-JSON, ${text.length} chars]`;
  }
}
