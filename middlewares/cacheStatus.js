/**
 * middlewares/cacheStatus.js
 * Injeta o cabeçalho X-Cache via AsyncLocalStorage.
 * NÃO cria timers.
 */

import { runWithCacheContext, aggregateCacheStatus } from '@/lib/http/cacheContext';

const cacheStatus = (req, res, next) => {
  const store = { calls: [] };

  // Salva o writeHead original
  const originalWriteHead = res.writeHead.bind(res);

  // Substitui writeHead por wrapper que injeta X-Cache
  res.writeHead = function writeHead(statusCode, statusMessage, headers) {
    try {
      const status = aggregateCacheStatus(store.calls);
      if (status && !res.getHeader('X-Cache')) {
        res.setHeader('X-Cache', status);
      }
    } catch {
      // nunca deixar o wrapper derrubar o writeHead original
    }

    if (typeof statusMessage === 'string') {
      return originalWriteHead(statusCode, statusMessage, headers);
    }
    return originalWriteHead(statusCode, statusMessage);
  };

  return runWithCacheContext(store, () => next());
};

export default cacheStatus;
