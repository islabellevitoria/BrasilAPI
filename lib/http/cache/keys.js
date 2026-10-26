/**
 * lib/http/cache/keys.js
 * Composição de chaves de cache baseada em URL normalizada + SHA-256.
 */

import crypto from 'crypto';

/**
 * Normaliza uma URL para uso na chave de cache:
 * - Porta padrão removida
 * - Query params reordenados por nome (ordenação estável)
 * - Fragmento removido
 */
export function normalizeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  // Remove porta padrão
  if (
    (parsed.protocol === 'https:' && parsed.port === '443') ||
    (parsed.protocol === 'http:' && parsed.port === '80')
  ) {
    parsed.port = '';
  }

  // Reordena query params por nome (ordenação estável)
  const rawSearch = parsed.search ? parsed.search.slice(1) : '';
  if (rawSearch) {
    const segments = rawSearch.split('&');
    segments.sort((a, b) => {
      const nameA = safeDecodeComponent(a.split('=')[0]);
      const nameB = safeDecodeComponent(b.split('=')[0]);
      if (nameA < nameB) return -1;
      if (nameA > nameB) return 1;
      return 0;
    });
    parsed.search = `?${segments.join('&')}`;
  }

  // Remove fragmento
  parsed.hash = '';

  return parsed.toString();
}

function safeDecodeComponent(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

function sha256hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Computa as chaves base para uma URL de categoria.
 * @param {string} category
 * @param {string} url
 * @returns {{ pk: string, baseHash: string, metaKey: string, bodyKey: string }}
 */
export function base(category, url) {
  const normalizedUrl = normalizeUrl(url);
  const pk = `${category}\nGET\n${normalizedUrl}`;
  const baseHash = sha256hex(pk);
  return {
    pk,
    baseHash,
    metaKey: `${category}:m:${baseHash}`,
    bodyKey: `${category}:b:${baseHash}`,
  };
}

/**
 * Computa o hash de variante a partir dos nomes Vary e dos cabeçalhos de saída.
 * @param {{ metaKey: string, bodyKey: string, baseHash: string }} baseKeys
 * @param {string[]} names
 * @param {Record<string, string>} headers
 * @returns {string} hash da variante
 */
export function variant(baseKeys, names, headers) {
  const parts = names.map((name) => {
    const value = headers[name.toLowerCase()];
    const normalized =
      value != null
        ? String(value)
            .trim()
            .replace(/\s+/g, ' ')
        : '';
    return `${name}:${normalized}`;
  });
  return sha256hex(parts.join('\n'));
}
