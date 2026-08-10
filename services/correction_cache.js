/**
 * Correction / grade cache — stop paying to re-grade the same answer.
 *
 * A large fraction of answers repeat across students: the same opening probe
 * gets the same wrong answer ("non-renewable means it can't be recycled")
 * thousands of times. Grading is deterministic given (topic, question, answer),
 * so we cache the grade and skip the LLM call on a repeat.
 *
 * The store is pluggable: the default is an in-process LRU (good for a single
 * node), but any object with async get(key)/set(key,val) works — swap in Redis
 * or a DB table for a shared cache across your fleet.
 *
 * Cache key normalises casing / punctuation / whitespace so trivial variations
 * ("Octogon" vs "octogon.") share an entry, while genuinely different answers
 * do not collide.
 */

/** Normalise free-text so cosmetic differences map to the same key. */
function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a stable cache key for a graded answer.
 * @param {{topicId:(number|string), question:string, answer:string}} p
 */
function cacheKey({ topicId, question, answer }) {
  return `${topicId}::${normalize(question)}::${normalize(answer)}`;
}

/**
 * Minimal in-process LRU with an async get/set interface (so it's a drop-in for
 * a Redis client). Evicts the least-recently-used entry past `max`.
 */
class LruCache {
  constructor(max = 2000) {
    this.max = max;
    this.map = new Map(); // insertion-ordered
  }
  async get(key) {
    if (!this.map.has(key)) return null;
    const val = this.map.get(key);
    this.map.delete(key); // refresh recency
    this.map.set(key, val);
    return val;
  }
  async set(key, val) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    if (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value); // evict LRU
    }
  }
  get size() {
    return this.map.size;
  }
}

/**
 * Wrap a store with grade-specific get/set that only caches confident,
 * reusable grades. We deliberately DO NOT cache:
 *  - no-attempts (cheap already, and answer text is empty/uninformative)
 *  - low-confidence fallbacks (the neutral 0.5 grade used when the grader fails)
 * so a transient failure never poisons the cache.
 *
 * @param {{get:Function, set:Function}} [store]
 */
function createCorrectionCache(store = new LruCache()) {
  return {
    keyFor: cacheKey,
    async get(p) {
      return store.get(cacheKey(p));
    },
    async set(p, grade) {
      if (!grade || grade.is_no_attempt) return;
      if (grade._fallback) return; // never cache the failure fallback
      await store.set(cacheKey(p), grade);
    },
    _store: store,
  };
}

module.exports = { createCorrectionCache, LruCache, cacheKey, normalize };
