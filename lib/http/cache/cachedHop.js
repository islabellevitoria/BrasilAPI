/**
 * lib/http/cache/cachedHop.js
 * Orquestra um salto HTTP com cache RFC 7234.
 * createCachedHop({ store, transport, getConfig, now, log }) => cachedHop(req, deadline)
 */

import CachePolicy from 'http-cache-semantics';
import * as keys from './keys.js';
import {
  normalizeCacheHeaders,
  requestSnapshot,
  evaluateStorability,
  mergeNotModifiedHeaders,
  parseVary,
} from './policy.js';
import { canceledError } from '../errors.js';

function throwIfAborted(req) {
  if (req.signal && req.signal.aborted) {
    throw canceledError(req);
  }
}

function withoutHost(headers) {
  const out = { ...headers };
  delete out.host;
  return out;
}

function toResult(cached, cacheStatus) {
  return {
    status: cached.meta.status,
    statusText: cached.meta.statusText || '',
    headers: cached.meta.headers,
    body: cached.body,
    url: cached.meta.url || '',
    cacheStatus,
  };
}

function sameVaryNames(storedHeaders, mergedHeaders) {
  const storedVary = parseVary(storedHeaders);
  const mergedVary = parseVary(mergedHeaders);
  if (storedVary.star || mergedVary.star) return storedVary.star === mergedVary.star;
  if (storedVary.names.length !== mergedVary.names.length) return false;
  return storedVary.names.every((n, i) => n === mergedVary.names[i]);
}

/**
 * @param {{ store, transport, getConfig, now?, log? }} deps
 */
export function createCachedHop({ store, transport, getConfig, now = Date.now, log }) {
  const safeLog = log || {
    warnOnce(key, err) {
      const warned = globalThis[Symbol.for('brasilapi.cache-warnonce')] || new Set();
      globalThis[Symbol.for('brasilapi.cache-warnonce')] = warned;
      if (!warned.has(key)) {
        warned.add(key);
        /* eslint-disable no-console */
        console.warn(`[http-cache] ${key}:`, err && (err.message || err));
      }
    },
  };

  async function prepare(req) {
    const config = getConfig();
    const catCfg = config.categories[req.category];
    const snapshot = requestSnapshot(req);
    const baseKeys = keys.base(req.category, req.url);
    const cached = await store.read(baseKeys, req.headers);

    if (!cached) {
      return {
        catCfg,
        snapshot,
        base: baseKeys,
        cached: null,
        conditional: false,
        sendHeaders: req.headers,
      };
    }

    let policy;
    try {
      policy = CachePolicy.fromObject(cached.meta.policy);
    } catch (err) {
      safeLog.warnOnce('cache-policy-restore', err);
      await store.remove(cached.location);
      return {
        catCfg,
        snapshot,
        base: baseKeys,
        cached: null,
        conditional: false,
        sendHeaders: req.headers,
      };
    }

    if (now() < cached.meta.freshUntil) {
      return { hit: toResult(cached, 'HIT') };
    }

    if (!cached.meta.validators) {
      return {
        catCfg,
        snapshot,
        base: baseKeys,
        cached,
        conditional: false,
        sendHeaders: req.headers,
      };
    }

    const revalHeaders = withoutHost(policy.revalidationHeaders(snapshot));
    const conditional =
      'if-none-match' in revalHeaders || 'if-modified-since' in revalHeaders;

    return {
      catCfg,
      snapshot,
      base: baseKeys,
      cached,
      policy,
      conditional,
      sendHeaders: conditional ? revalHeaders : req.headers,
    };
  }

  async function storeFull(prep, res) {
    const normalizedHeaders = normalizeCacheHeaders(res.headers);
    const decision = evaluateStorability(
      prep.snapshot,
      { status: res.status, headers: normalizedHeaders },
      res.body ? res.body.length : 0,
      prep.catCfg,
      now()
    );

    if (decision.store) {
      await store.write(prep.base, prep.snapshot.headers, { ...res, headers: normalizedHeaders }, decision);
    } else if (prep.cached && res.status < 500) {
      await store.remove(prep.cached.location);
    }

    return { ...res, cacheStatus: 'MISS' };
  }

  async function finalize(prep, res) {
    if (res.status !== 304 || !prep.conditional) {
      return { result: await storeFull(prep, res) };
    }

    const resHeaders = normalizeCacheHeaders(res.headers);
    const { policy: revalPolicy, matches } = prep.policy.revalidatedPolicy(
      prep.snapshot,
      { status: 304, headers: resHeaders }
    );

    const merged = mergeNotModifiedHeaders(prep.cached.meta.headers, resHeaders);

    if (!matches || !sameVaryNames(prep.cached.meta.headers, merged)) {
      return { refetch: true };
    }

    const decision = evaluateStorability(
      prep.snapshot,
      { status: prep.cached.meta.status, headers: merged },
      prep.cached.meta.bodyBytes || (prep.cached.body ? prep.cached.body.length : 0),
      prep.catCfg,
      now()
    );

    // Use revalPolicy if available, otherwise use existing decision's policy
    const finalDecision = {
      ...decision,
      policy: revalPolicy || (decision.store ? decision.policy : null),
    };

    if (decision.store && finalDecision.policy) {
      await store.writeMetaOnly(
        prep.cached.location,
        prep.cached.meta,
        merged,
        finalDecision
      );
    } else {
      await store.remove(prep.cached.location);
    }

    return {
      result: toResult(
        { ...prep.cached, meta: { ...prep.cached.meta, headers: merged } },
        'REVALIDATED'
      ),
    };
  }

  function fallbackResult(prep, res) {
    if (res.status === 304 && prep.conditional) {
      return toResult(prep.cached, 'REVALIDATED');
    }
    return { ...res, cacheStatus: 'MISS' };
  }

  return async function cachedHop(req, deadline) {
    throwIfAborted(req);

    let prep = null;
    try {
      prep = await prepare(req);
    } catch (err) {
      safeLog.warnOnce('cache-prepare', err);
    }

    throwIfAborted(req);

    if (prep && prep.hit) return prep.hit;

    if (!prep) {
      const res = await transport.send(req, deadline);
      return { ...res, cacheStatus: 'MISS' };
    }

    const res = await transport.send(
      { ...req, headers: prep.sendHeaders },
      deadline
    );

    let outcome;
    try {
      outcome = await finalize(prep, res);
    } catch (err) {
      safeLog.warnOnce('cache-finalize', err);
      return fallbackResult(prep, res);
    }

    if (!outcome.refetch) return outcome.result;

    // Única segunda chamada: 304 sem correspondência
    const full = await transport.send(req, deadline);
    try {
      return await storeFull(prep, full);
    } catch (err) {
      safeLog.warnOnce('cache-finalize', err);
      return { ...full, cacheStatus: 'MISS' };
    }
  };
}
