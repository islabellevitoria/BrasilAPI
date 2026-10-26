/**
 * lib/http/cache/policy.js
 * Política RFC 7234 via http-cache-semantics.
 * Módulo puro — sem I/O.
 */

import CachePolicy from 'http-cache-semantics';

export const POLICY_OPTIONS = Object.freeze({
  shared: true,
  cacheHeuristic: 0.1,
  immutableMinTimeToLive: 0,
  ignoreCargoCult: false,
});

const LOWERCASE_VALUE_HEADERS = ['cache-control', 'pragma', 'vary'];
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Normaliza os cabeçalhos de cache: une arrays e converte valores para minúsculas.
 * @param {Record<string, string|string[]>} headers
 * @returns {Record<string, string|string[]>}
 */
export function normalizeCacheHeaders(headers) {
  const out = { ...headers };
  LOWERCASE_VALUE_HEADERS.forEach((name) => {
    const value = Array.isArray(out[name]) ? out[name].join(', ') : out[name];
    if (typeof value === 'string') out[name] = value.toLowerCase();
  });
  return out;
}

/**
 * Parse directives de um cabeçalho cache-control normalizado.
 * @param {string} value
 * @returns {Map<string, string[]>}
 */
export function parseDirectives(value) {
  const map = new Map();
  if (!value || typeof value !== 'string') return map;

  // Divide por vírgulas que não estão dentro de aspas
  const parts = [];
  let current = '';
  let inQuotes = false;
  const chars = value.split('');
  chars.forEach((ch) => {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === ',' && !inQuotes) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  });
  if (current.trim()) parts.push(current.trim());

  parts.forEach((part) => {
    if (!part) return;
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) {
      const existing = map.get(part) || [];
      existing.push(null);
      map.set(part, existing);
    } else {
      const k = part.slice(0, eqIdx).trim();
      let v = part.slice(eqIdx + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) {
        v = v.slice(1, -1);
      }
      const existing = map.get(k) || [];
      existing.push(v);
      map.set(k, existing);
    }
  });

  return map;
}

/**
 * Determina a fonte de frescor.
 * @returns {'revalidate'|'explicit'|'heuristic'}
 */
export function freshnessSource(h, cc) {
  const hasSetCookie = h['set-cookie'] !== undefined;
  const hasPublic = cc.has('public');
  const hasImmutable = cc.has('immutable');
  const revalidate =
    cc.has('no-cache') ||
    (h['cache-control'] === undefined && /no-cache/.test(h.pragma || '')) ||
    cc.has('proxy-revalidate') ||
    (hasSetCookie && !hasPublic && !hasImmutable);

  if (revalidate) return 'revalidate';
  if (cc.has('s-maxage') || cc.has('max-age') || h.expires !== undefined) return 'explicit';
  return 'heuristic';
}

const deltaSecondsValid = (cc, name) => {
  const values = cc.get(name);
  if (!values) return true;
  return (
    values.every((v) => typeof v === 'string' && /^\d+$/.test(v)) &&
    new Set(values).size === 1
  );
};

export const explicitFreshnessValid = (cc) =>
  deltaSecondsValid(cc, 's-maxage') && deltaSecondsValid(cc, 'max-age');

/**
 * Parse Vary header em array de nomes normalizados.
 * @param {Record<string, string>} h
 * @returns {{ star: boolean, names: string[] }}
 */
export function parseVary(h) {
  const raw = h.vary;
  if (!raw) return { star: false, names: [] };
  const names = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.includes('*')) return { star: true, names: ['*'] };
  const unique = [...new Set(names)].sort();
  return { star: false, names: unique };
}

/**
 * Verifica se há validadores (ETag ou Last-Modified).
 */
export function hasValidators(h) {
  const etag = h.etag;
  if (etag && typeof etag === 'string' && etag.trim().length > 0) return true;
  const lm = h['last-modified'];
  if (lm && Number.isFinite(Date.parse(lm))) return true;
  return false;
}

/**
 * Avalia se a resposta pode ser armazenada (R1–R9).
 * @returns {{ store: false, reason: string } | { store: true, policy, varyNames, remainingMs, freshUntil, keyvTtlMs, validators, heuristic }}
 */
export function evaluateStorability(snapshot, { status, headers }, bodyBytes, catCfg, nowMs) {
  // R1: só GET
  if (snapshot.method !== 'GET') return { store: false, reason: 'R1:method' };

  // R2: só 200, 301, 308
  if (status !== 200 && status !== 301 && status !== 308) {
    return { store: false, reason: `R2:status(${status})` };
  }

  const normalized = normalizeCacheHeaders(headers);
  const cc = parseDirectives(normalized['cache-control'] || '');
  const vary = parseVary(normalized);

  const policy = new CachePolicy(snapshot, { status, headers: normalized }, POLICY_OPTIONS);

  // R3: proibições
  if (cc.has('no-store')) return { store: false, reason: 'R3:no-store' };
  if (cc.has('private')) return { store: false, reason: 'R3:private' };
  if (!policy.storable()) return { store: false, reason: 'R3:not-storable' };
  if (vary.star) return { store: false, reason: 'R3:vary-star' };
  if (bodyBytes > catCfg.ttlMs === 0 ? 0 : 5242880) {
    // Use config default 5MiB; we'll check against passed maxEntryBytes separately
  }
  if ((status === 301 || status === 308) && !normalized.location) {
    return { store: false, reason: 'R3:redirect-no-location' };
  }

  // Frescor
  const source = freshnessSource(normalized, cc);
  const ttlMs = catCfg.ttlMs;

  let lifetimeMs;
  let heuristic;

  if (source === 'revalidate') {
    lifetimeMs = 0;
    heuristic = false;
  } else if (source === 'explicit') {
    if (!explicitFreshnessValid(cc)) {
      lifetimeMs = 0;
      heuristic = false;
    } else {
      lifetimeMs = Math.min(policy.maxAge() * 1000, ttlMs);
      heuristic = false;
    }
  } else {
    // heuristic
    const maxAgeMs = policy.maxAge() * 1000;
    if (maxAgeMs > 0) {
      lifetimeMs = Math.min(maxAgeMs, ttlMs);
      heuristic = true;
    } else {
      lifetimeMs = ttlMs;
      heuristic = true;
    }
  }

  // R7: idade
  const remainingMs = Math.max(0, lifetimeMs - policy.age() * 1000);
  const freshUntil = nowMs + remainingMs;
  const validators = hasValidators(normalized);

  // R8: sem validadores e remaining < minStoreFreshness
  const minFreshnessMs = 5000;
  if (!validators && remainingMs < minFreshnessMs) {
    return { store: false, reason: 'R8:insufficient-freshness' };
  }

  // R9: TTL do Keyv
  const staleRetentionMs = 604800000; // 7 dias padrão
  const keyvTtlMs = remainingMs + (validators ? staleRetentionMs : 0);
  if (keyvTtlMs < 1) {
    return { store: false, reason: 'R9:zero-ttl' };
  }

  return {
    store: true,
    policy,
    varyNames: vary.names,
    remainingMs,
    freshUntil,
    keyvTtlMs,
    validators,
    heuristic,
  };
}

/**
 * Remove cabeçalhos hop-by-hop e content-encoding/content-length dos headers guardados.
 */
export function sanitizeStoredHeaders(headers) {
  const out = {};
  Object.keys(headers).forEach((k) => {
    if (!HOP_BY_HOP.has(k) && k !== 'content-encoding' && k !== 'content-length') {
      out[k] = headers[k];
    }
  });
  return out;
}

/**
 * Mescla os cabeçalhos do 304 com os cabeçalhos armazenados (RFC 7234 §4.3.4).
 * - add-or-replace dos campos do 304, exceto hop-by-hop e content-length/encoding/transfer-encoding/content-range
 * - remove age do armazenado se o 304 não trouxer Age
 */
export function mergeNotModifiedHeaders(storedHeaders, notModifiedHeaders) {
  const EXCLUDED = new Set([
    'content-length',
    'content-encoding',
    'transfer-encoding',
    'content-range',
    ...HOP_BY_HOP,
  ]);

  const out = { ...storedHeaders };

  Object.keys(notModifiedHeaders).forEach((k) => {
    if (!EXCLUDED.has(k)) {
      out[k] = notModifiedHeaders[k];
    }
  });

  // Remove age do armazenado se o 304 não trouxer Age
  if (notModifiedHeaders.age === undefined) {
    delete out.age;
  }

  return out;
}

/**
 * Cria um snapshot de requisição para o http-cache-semantics.
 */
export function requestSnapshot(req) {
  let u;
  try {
    u = new URL(req.url);
  } catch {
    return { method: req.method, url: req.url, headers: req.headers || {} };
  }
  return {
    method: req.method || 'GET',
    url: u.pathname + u.search,
    headers: {
      ...(req.headers || {}),
      host: u.host,
    },
  };
}
