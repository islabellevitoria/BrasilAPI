/**
 * lib/http/client.js
 * API pública do cliente HTTP — substituto do axios com semântica idêntica.
 * Objeto NÃO congelado para permitir vi.spyOn(httpClient, 'get').
 */

import { buildUrl, encodeBody, decodeBody } from './codec.js';
import { send, createDeadline } from './transport.js';
import { follow } from './redirects.js';
import { fromStatus, canceledError } from './errors.js';
import { recordCacheStatus } from './cacheContext.js';
import { getConfig } from './cache/config.js';
import { createCachedHop } from './cache/cachedHop.js';
import * as store from './cache/store.js';

const KNOWN_OPTIONS = new Set([
  'params', 'headers', 'timeout', 'signal', 'responseType', 'encoding', 'cache',
]);

const DEFAULT_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'user-agent': 'axios/1.8.3',
  'accept-encoding': 'gzip, deflate, br',
};

function validateOptions(opts, extraAllowed = []) {
  if (!opts) return;
  const allowed = new Set([...KNOWN_OPTIONS, ...extraAllowed]);
  const keys = Object.keys(opts);
  keys.forEach((k) => {
    if (!allowed.has(k)) {
      throw new TypeError(`Unknown option: ${k}`);
    }
  });
}

function mergeHeaders(defaults, custom) {
  if (!custom) return { ...defaults };
  const result = { ...defaults };
  const customKeys = Object.keys(custom);
  customKeys.forEach((k) => {
    result[k.toLowerCase()] = custom[k];
  });
  return result;
}

function buildHopReq(method, url, opts) {
  const { params, headers, timeout, signal, body } = opts;
  const finalUrl = buildUrl(url.trim(), params);
  const finalHeaders = mergeHeaders(DEFAULT_HEADERS, headers);
  return {
    method: method.toUpperCase(),
    url: finalUrl,
    headers: finalHeaders,
    body,
    timeout: timeout || 0,
    signal,
  };
}

/**
 * Verifica se a opção cache está ativa e configurada.
 */
function isCacheActive(category) {
  if (!category) return false;
  const config = getConfig();
  if (!config.enabled) return false;
  const catCfg = config.categories[category];
  if (!catCfg || catCfg.ttlSeconds <= 0) return false;
  return true;
}

/**
 * Verifica se os cabeçalhos da requisição contêm diretivas de bypass (R14).
 */
function hasBypassHeaders(headers) {
  const bypassKeys = ['cache-control', 'pragma', 'authorization', 'proxy-authorization', 'cookie'];
  return bypassKeys.some((k) => headers[k] !== undefined);
}

async function execute(req, opts) {
  const { responseType, encoding, signal, cache } = opts;

  if (signal && signal.aborted) {
    throw canceledError(req);
  }

  const deadline = createDeadline(req.timeout);

  const useCache =
    req.method === 'GET' &&
    cache &&
    isCacheActive(cache) &&
    !hasBypassHeaders(req.headers);

  let res;
  if (useCache) {
    const cachedHop = createCachedHop({
      store,
      transport: { send },
      getConfig,
      now: Date.now,
    });
    try {
      res = await follow(
        { ...req, category: cache },
        (hopReq, dl) => cachedHop({ ...hopReq, category: cache }, dl),
        0,
        deadline
      );
      recordCacheStatus(res.cacheStatus || 'MISS');
    } catch (err) {
      recordCacheStatus('MISS');
      throw err;
    }
  } else {
    res = await follow(req, (hopReq, dl) => send(hopReq, dl), 0, deadline);
  }

  if (res.status < 200 || res.status > 299) {
    throw fromStatus(
      req.method,
      req.url,
      res.status,
      res.statusText,
      res.headers,
      decodeBody(res.body, responseType, encoding)
    );
  }

  const data = decodeBody(res.body, responseType, encoding);

  return {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    data,
    config: { url: req.url, method: req.method },
  };
}

/**
 * httpClient.get(url, opts?)
 * opts: { params?, headers?, timeout?, signal?, responseType?, encoding?, cache? }
 */
async function get(url, opts = {}) {
  validateOptions(opts);
  const req = buildHopReq('GET', url, opts);
  return execute(req, opts);
}

/**
 * httpClient.post(url, body, opts?)
 * opts: { params?, headers?, timeout?, signal?, responseType?, encoding? }
 */
async function post(url, body, opts = {}) {
  // post não aceita 'cache'
  validateOptions(opts, []);
  const headers = opts.headers ? { ...opts.headers } : {};
  const { encodedBody, headers: encodedHeaders } = encodeBody(body, {
    ...DEFAULT_HEADERS,
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  });
  const req = buildHopReq('POST', url, { ...opts, headers: encodedHeaders, body: encodedBody });
  return execute(req, opts);
}

const httpClient = { get, post };

export default httpClient;
