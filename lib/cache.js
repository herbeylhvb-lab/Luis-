// Simple in-memory TTL cache for idempotent expensive computations.
//
// Used to wrap dashboard stats / list aggregations that are called
// many times per second across the app but only need to be fresh
// within a small time window.  First request pays the DB cost;
// subsequent requests within the TTL hit the cache.
//
// API:
//   cached(key, ttlMs, fn)         — get-or-compute
//   cacheBust(key)                 — drop a single key
//   cacheBustPrefix(prefix)        — drop all keys starting with prefix
//
// Single-process, no eviction beyond TTL — fine for our scale (a few
// hundred entries at most).  Opportunistic GC walks the map every
// ~50 inserts to drop expired keys so it doesn't grow unbounded.
const _cache = new Map();

function cached(key, ttlMs, fn) {
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && hit.expires > now) return hit.value;
  const value = fn();
  _cache.set(key, { value, expires: now + ttlMs });
  if (_cache.size > 100 && Math.random() < 0.02) {
    // Opportunistic GC of expired entries
    for (const [k, v] of _cache) if (v.expires <= now) _cache.delete(k);
  }
  return value;
}

function cacheBust(key) { _cache.delete(key); }

function cacheBustPrefix(prefix) {
  for (const k of _cache.keys()) if (k.startsWith(prefix)) _cache.delete(k);
}

module.exports = { cached, cacheBust, cacheBustPrefix };
