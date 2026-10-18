/**
 * lib/http/cacheContext.js
 * AsyncLocalStorage singleton para rastreamento de status de cache por requisição.
 */

import { AsyncLocalStorage } from 'async_hooks';

const ALS_KEY = Symbol.for('brasilapi.cache-ctx.v1');

if (!globalThis[ALS_KEY]) {
  globalThis[ALS_KEY] = new AsyncLocalStorage();
}

const als = globalThis[ALS_KEY];

/**
 * Executa fn dentro de um contexto de cache com o store fornecido.
 * @param {{ calls: string[] }} store
 * @param {Function} fn
 * @returns {*}
 */
export function runWithCacheContext(store, fn) {
  return als.run(store, fn);
}

/**
 * Registra um status de cache no contexto ALS ativo, se houver.
 * @param {'HIT'|'MISS'|'REVALIDATED'} status
 */
export function recordCacheStatus(status) {
  const store = als.getStore();
  if (store) {
    store.calls.push(status);
  }
}

const STATUS_PRIORITY = { MISS: 3, REVALIDATED: 2, HIT: 1 };

/**
 * Agrega uma lista de status: MISS > REVALIDATED > HIT.
 * Retorna undefined se a lista estiver vazia.
 * @param {string[]} list
 * @returns {'HIT'|'MISS'|'REVALIDATED'|undefined}
 */
export function aggregateCacheStatus(list) {
  if (!list || list.length === 0) return undefined;
  return list.reduce((best, current) => {
    const bestPriority = STATUS_PRIORITY[best] || 0;
    const currentPriority = STATUS_PRIORITY[current] || 0;
    return currentPriority > bestPriority ? current : best;
  });
}
