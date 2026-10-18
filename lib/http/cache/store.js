/**
 * lib/http/cache/store.js
 * Singleton Keyv/SQLite com circuit breaker.
 * Todas as funções exportadas nunca rejeitam.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getConfig } from './config.js';
import { variant as computeVariant } from './keys.js';

const STORE_KEY = Symbol.for('brasilapi.http-cache.v1');

function getState() {
  if (!globalThis[STORE_KEY]) {
    globalThis[STORE_KEY] = {
      initPromise: null,
      keyv: null,
      sqlite: null,
      disabled: false,
      disabledReason: null,
      consecutiveFailures: 0,
      openUntil: 0,
      warned: new Set(),
    };
  }
  return globalThis[STORE_KEY];
}

function warnOnce(key, msg) {
  const state = getState();
  if (!state.warned.has(key)) {
    state.warned.add(key);
    /* eslint-disable no-console */
    console.warn(`[http-cache] ${msg}`);
  }
}

/**
 * Promise com timeout. Rejeita com erro de timeout se exceder timeoutMs.
 */
function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      timer = null;
      reject(new Error(`cache op timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (val) => {
        if (timer) clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function initStore() {
  const config = getConfig();
  const { sqlitePath, opTimeoutMs, defaults: def } = config;
  const busyTimeoutMs = def ? def.busyTimeoutMs : 250;

  // Import dinâmico para evitar require() dentro de função
  const [{ default: Keyv }, { default: KeyvSqlite }] = await Promise.all([
    import('keyv'),
    import('@keyv/sqlite'),
  ]);

  if (sqlitePath !== ':memory:') {
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  }

  const sqlite = new KeyvSqlite({ uri: `sqlite://${sqlitePath}`, busyTimeout: busyTimeoutMs });
  const keyv = new Keyv({
    store: sqlite,
    namespace: 'brasilapi-http',
    serialize: JSON.stringify,
    deserialize: JSON.parse,
    throwOnErrors: true,
  });

  // no-op listener para evitar unhandled rejection no EventEmitter
  keyv.on('error', () => {});

  // Sonda SELECT 1 — na mesma volta síncrona antes de aguardar
  const probe = sqlite.query('SELECT 1');
  await withTimeout(probe, opTimeoutMs);

  // WAL — falha não é fatal
  try {
    await withTimeout(sqlite.query('PRAGMA journal_mode=WAL'), opTimeoutMs);
  } catch (err) {
    warnOnce('wal-pragma', `PRAGMA WAL falhou: ${err.message}`);
  }

  // Sonda de escrita
  await withTimeout(keyv.set('_probe', 1, 60000), opTimeoutMs);
  await withTimeout(keyv.delete('_probe'), opTimeoutMs);

  return { keyv, sqlite };
}

async function ensureStore() {
  const state = getState();
  if (state.disabled) return;
  if (state.initPromise) {
    await state.initPromise;
    return;
  }

  state.initPromise = initStore()
    .then(({ keyv, sqlite }) => {
      state.keyv = keyv;
      state.sqlite = sqlite;
    })
    .catch((err) => {
      state.disabled = true;
      state.disabledReason = err.message;
      /* eslint-disable no-console */
      console.error(`[http-cache] Cache disabled: ${err.message} (${err.code || 'no-code'})`);
    });

  await state.initPromise;
}

/**
 * Verifica se o store está disponível (habilitado, inicializado, breaker fechado).
 */
export function isAvailable() {
  const state = getState();
  if (state.disabled) return false;
  if (!getConfig().enabled) return false;
  if (state.openUntil > 0 && Date.now() < state.openUntil) return false;
  return true;
}

function recordFailure() {
  const state = getState();
  state.consecutiveFailures += 1;
  const threshold = getConfig().defaults ? getConfig().defaults.breakerThreshold : 5;
  if (state.consecutiveFailures >= threshold) {
    const cooldown = getConfig().defaults ? getConfig().defaults.breakerCooldownMs : 300000;
    state.openUntil = Date.now() + cooldown;
    /* eslint-disable no-console */
    console.error(`[http-cache] Circuit breaker OPEN — ${state.consecutiveFailures} consecutive failures`);
  }
}

function recordSuccess() {
  const state = getState();
  if (state.consecutiveFailures > 0) {
    warnOnce('breaker-closed', 'Cache circuit breaker CLOSED — store reactivated');
  }
  state.consecutiveFailures = 0;
  state.openUntil = 0;
}

async function doWithBreaker(fn) {
  if (!isAvailable()) return null;
  const config = getConfig();
  try {
    const result = await withTimeout(fn(), config.opTimeoutMs || 1000);
    recordSuccess();
    return result;
  } catch (err) {
    recordFailure();
    return null;
  }
}

/**
 * Lê uma entrada do cache.
 * @returns {Promise<null | { meta, body: Buffer, location: { metaKey, bodyKey } }>}
 */
export async function read(baseKeys, reqHeaders) {
  const state = getState();
  if (!isAvailable()) return null;

  try {
    await withTimeout(ensureStore(), getConfig().opTimeoutMs || 1000);
  } catch {
    recordFailure();
    return null;
  }

  if (!state.keyv) return null;

  const { metaKey, bodyKey } = baseKeys;
  const config = getConfig();

  try {
    const result = await withTimeout(
      (async () => {
        const [metaRaw, bodyRaw] = await state.keyv.getMany([metaKey, bodyKey]);

        if (!metaRaw) {
          // Meta ausente mas corpo presente — limpa corpo
          if (bodyRaw) {
            state.keyv.delete(bodyKey).catch(() => {});
          }
          return null;
        }

        // Verifica se é índice de Vary
        if (metaRaw.kind === 'vary') {
          if (
            !metaRaw.v ||
            metaRaw.v !== 1 ||
            !Array.isArray(metaRaw.names) ||
            !metaRaw.names.every((n) => typeof n === 'string')
          ) {
            state.keyv.deleteMany([metaKey, bodyKey]).catch(() => {});
            return null;
          }

          // Calcula variante
          const variantHash = computeVariant(baseKeys, metaRaw.names, reqHeaders || {});
          const category = metaKey.split(':')[0];
          const variantMetaKey = `${category}:m:${baseKeys.baseHash}.${variantHash}`;
          const variantBodyKey = `${category}:b:${baseKeys.baseHash}.${variantHash}`;

          const [vMetaRaw, vBodyRaw] = await state.keyv.getMany([variantMetaKey, variantBodyKey]);

          if (!vMetaRaw) {
            if (vBodyRaw) {
              state.keyv.delete(variantBodyKey).catch(() => {});
            }
            return null;
          }

          if (!vBodyRaw) return null;

          const body = parseBody(vBodyRaw);
          if (!body) return null;

          return {
            meta: vMetaRaw,
            body,
            location: { metaKey: variantMetaKey, bodyKey: variantBodyKey },
          };
        }

        // Entrada direta (kind === 'entry')
        if (!validateEntry(metaRaw, baseKeys.pk)) {
          state.keyv.deleteMany([metaKey, bodyKey]).catch(() => {});
          return null;
        }

        if (!bodyRaw) return null;

        const body = parseBody(bodyRaw);
        if (!body) {
          state.keyv.deleteMany([metaKey, bodyKey]).catch(() => {});
          return null;
        }

        if (body.id !== metaRaw.bodyId) return null;

        if (metaRaw.bodyBytes !== undefined && body.data.length !== metaRaw.bodyBytes) {
          /* eslint-disable no-console */
          console.warn('[http-cache] Body length mismatch, discarding entry');
          state.keyv.deleteMany([metaKey, bodyKey]).catch(() => {});
          return null;
        }

        return {
          meta: metaRaw,
          body: body.data,
          location: { metaKey, bodyKey },
        };
      })(),
      config.opTimeoutMs || 1000
    );

    if (result !== null) recordSuccess();
    return result;
  } catch {
    recordFailure();
    return null;
  }
}

function validateEntry(meta, expectedPk) {
  if (!meta) return false;
  if (meta.v !== 1) return false;
  if (meta.kind !== 'entry') return false;
  if (meta.pk !== expectedPk) return false;
  if (!Array.isArray(meta.vary ? meta.vary.names : [])) return false;
  return true;
}

function parseBody(bodyRaw) {
  if (!bodyRaw || !bodyRaw.b64) return null;
  try {
    const data = Buffer.from(bodyRaw.b64, 'base64');
    return { id: bodyRaw.id, data };
  } catch {
    return null;
  }
}

/**
 * Grava uma entrada completa no cache (meta + corpo).
 */
export async function write(baseKeys, reqHeaders, res, decision) {
  const state = getState();
  if (!isAvailable()) return;

  try {
    await withTimeout(ensureStore(), getConfig().opTimeoutMs || 1000);
  } catch {
    recordFailure();
    return;
  }

  if (!state.keyv) return;

  const bodyId = crypto.randomUUID();
  const category = baseKeys.metaKey.split(':')[0];
  const { varyNames, freshUntil, keyvTtlMs, validators, heuristic, remainingMs } = decision;

  let effectiveMetaKey = baseKeys.metaKey;
  let effectiveBodyKey = baseKeys.bodyKey;

  if (varyNames && varyNames.length > 0) {
    const variantHash = computeVariant(baseKeys, varyNames, reqHeaders || {});
    effectiveMetaKey = `${category}:m:${baseKeys.baseHash}.${variantHash}`;
    effectiveBodyKey = `${category}:b:${baseKeys.baseHash}.${variantHash}`;
  }

  const bodyEntry = {
    v: 1,
    id: bodyId,
    b64: res.body.toString('base64'),
  };

  const metaEntry = {
    v: 1,
    kind: 'entry',
    pk: baseKeys.pk,
    vary: {
      names: varyNames || [],
      values:
        varyNames && varyNames.length > 0
          ? varyNames.map((n) => {
              const val = (reqHeaders || {})[n.toLowerCase()];
              return val != null ? String(val) : '';
            })
          : [],
    },
    status: res.status,
    statusText: res.statusText || '',
    headers: res.headers,
    policy: decision.policy.toObject(),
    storedAt: Date.now(),
    freshUntil,
    validators,
    heuristic,
    bodyId,
    bodyBytes: res.body.length,
    url: res.url || '',
    remainingMs,
  };

  try {
    await withTimeout(
      (async () => {
        // Grava corpo primeiro (sem TTL)
        await state.keyv.set(effectiveBodyKey, bodyEntry);

        // Grava metadados (com TTL)
        await state.keyv.set(effectiveMetaKey, metaEntry, keyvTtlMs);

        // Com Vary: regrava índice sem TTL e remove corpo base
        if (varyNames && varyNames.length > 0) {
          const varyIndex = {
            v: 1,
            kind: 'vary',
            pk: baseKeys.pk,
            names: varyNames,
          };
          await state.keyv.set(baseKeys.metaKey, varyIndex);
          // Remove corpo base (best-effort)
          state.keyv.delete(baseKeys.bodyKey).catch(() => {});
        }
      })(),
      getConfig().opTimeoutMs || 1000
    );
    recordSuccess();
  } catch {
    recordFailure();
  }
}

/**
 * Regrava apenas os metadados (para 304 revalidado).
 */
export async function writeMetaOnly(location, meta, mergedHeaders, decision) {
  const state = getState();
  if (!isAvailable()) return;

  try {
    await withTimeout(ensureStore(), getConfig().opTimeoutMs || 1000);
  } catch {
    recordFailure();
    return;
  }

  if (!state.keyv) return;

  const { freshUntil, keyvTtlMs, validators, heuristic, remainingMs } = decision;

  const updatedMeta = {
    ...meta,
    headers: mergedHeaders,
    policy: decision.policy.toObject(),
    storedAt: Date.now(),
    freshUntil,
    validators,
    heuristic,
    remainingMs,
  };

  try {
    await withTimeout(
      state.keyv.set(location.metaKey, updatedMeta, keyvTtlMs),
      getConfig().opTimeoutMs || 1000
    );
    recordSuccess();
  } catch {
    recordFailure();
  }
}

/**
 * Remove uma entrada do cache (meta + corpo, mas não o índice de Vary).
 */
export async function remove(location) {
  const state = getState();
  if (!isAvailable()) return;

  try {
    await withTimeout(ensureStore(), getConfig().opTimeoutMs || 1000);
  } catch {
    recordFailure();
    return;
  }

  if (!state.keyv) return;

  try {
    await withTimeout(
      state.keyv.deleteMany([location.metaKey, location.bodyKey]),
      getConfig().opTimeoutMs || 1000
    );
    recordSuccess();
  } catch {
    recordFailure();
  }
}
