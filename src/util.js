import crypto from 'node:crypto';

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hmac(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function randomKey(prefix = 'an_live') {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = clamp(Math.ceil((p / 100) * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[idx];
}

export function median(values) {
  return percentile(values, 50);
}

export function nowIso() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function capitalize(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

export function round(value, places = 3) {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

export function formatMoney(amount) {
  if (!Number.isFinite(amount)) return null;
  if (amount >= 10000000) return `₹${round(amount / 10000000, 1)}Cr`;
  if (amount >= 100000) return `₹${round(amount / 100000, 1)}L`;
  if (amount >= 1000) return `₹${round(amount / 1000, 1)}k`;
  return `₹${Math.round(amount)}`;
}

export function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
