/**
 * lib/http/cache/config.js
 * Configuração do cache HTTP lida de variáveis de ambiente.
 * createConfig(env) — pura.
 * getConfig() — memoizada em globalThis.
 */

import os from 'os';
import path from 'path';
import categoriesData from './categories.json';

const CONFIG_KEY = Symbol.for('brasilapi.http-cache-config.v1');

const { categories, defaults } = categoriesData;

const CATEGORY_NAMES = new Set(categories.map((c) => c.name));
const CATEGORY_ENVS = Object.fromEntries(categories.map((c) => [c.name, c.env]));
const CATEGORY_DEFAULT_TTLS = Object.fromEntries(
  categories.map((c) => [c.name, c.ttlSeconds])
);

/**
 * Parse a boolean env var (true/1/yes = true; false/0/no = false).
 * Returns defaultValue if unrecognized.
 */
function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const lower = String(value).toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  /* eslint-disable no-console */
  console.warn(`[http-cache] Invalid boolean env var value: "${value}", using default ${defaultValue}`);
  return defaultValue;
}

/**
 * Parse a non-negative integer env var within [min, max].
 * Returns defaultValue + console.warn on failure.
 */
function parseIntRange(value, name, min, max, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.warn(
      `[http-cache] Invalid value for ${name}: "${value}" (expected integer ${min}..${max}), using default ${defaultValue}`
    );
    return defaultValue;
  }
  return n;
}

/**
 * Determine the default SQLite path.
 */
function defaultSqlitePath(env) {
  if (env.VERCEL) {
    return path.join(os.tmpdir(), 'brasilapi-http-cache.sqlite');
  }
  return path.join(process.cwd(), '.cache', 'http-cache.sqlite');
}

/**
 * Pure config factory. Throws TypeError only on programming errors
 * (e.g., an unknown category name in the JSON, which can't happen at runtime).
 */
export function createConfig(env) {
  const isTest = (env.NODE_ENV || '').toLowerCase() === 'test';
  const enabledDefault = !isTest;
  const enabled = parseBool(env.HTTP_CACHE_ENABLED, enabledDefault);

  let sqlitePath;
  if (env.HTTP_CACHE_SQLITE_PATH && env.HTTP_CACHE_SQLITE_PATH.trim()) {
    const p = env.HTTP_CACHE_SQLITE_PATH.trim();
    sqlitePath = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  } else {
    sqlitePath = defaultSqlitePath(env);
  }

  const staleRetention = parseIntRange(
    env.HTTP_CACHE_STALE_RETENTION,
    'HTTP_CACHE_STALE_RETENTION',
    0,
    31536000,
    604800
  );

  const maxEntryBytes = parseIntRange(
    env.HTTP_CACHE_MAX_ENTRY_BYTES,
    'HTTP_CACHE_MAX_ENTRY_BYTES',
    0,
    104857600,
    5242880
  );

  const opTimeoutMs = parseIntRange(
    env.HTTP_CACHE_OP_TIMEOUT_MS,
    'HTTP_CACHE_OP_TIMEOUT_MS',
    50,
    10000,
    1000
  );

  const categoryConfigs = {};
  CATEGORY_NAMES.forEach((name) => {
    const envKey = CATEGORY_ENVS[name];
    const defaultTtl = CATEGORY_DEFAULT_TTLS[name];
    const ttlSeconds = parseIntRange(
      env[envKey],
      envKey,
      0,
      31536000,
      defaultTtl
    );
    categoryConfigs[name] = {
      name,
      ttlSeconds,
      ttlMs: ttlSeconds * 1000,
    };
  });

  return {
    enabled,
    sqlitePath,
    staleRetention,
    staleRetentionMs: staleRetention * 1000,
    maxEntryBytes,
    opTimeoutMs,
    categories: categoryConfigs,
    defaults,
  };
}

/**
 * Memoized config reader. On exception, returns disabled config + console.error once.
 */
export function getConfig() {
  if (!globalThis[CONFIG_KEY]) {
    try {
      globalThis[CONFIG_KEY] = createConfig(process.env);
    } catch (err) {
      /* eslint-disable no-console */
      console.error('[http-cache] Failed to load config, cache disabled:', err.message);
      globalThis[CONFIG_KEY] = {
        enabled: false,
        categories: {},
        defaults,
        sqlitePath: '',
        staleRetention: 604800,
        staleRetentionMs: 604800000,
        maxEntryBytes: 5242880,
        opTimeoutMs: 1000,
      };
    }
  }
  return globalThis[CONFIG_KEY];
}
