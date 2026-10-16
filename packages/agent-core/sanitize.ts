export function sanitize(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED]');
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /token$|api.?key|authorization|password|secret|email/i.test(k) && !/Tokens$/.test(k) ? '[REDACTED]' : sanitize(v)]));
  return value;
}
