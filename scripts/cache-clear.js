/**
 * scripts/cache-clear.js
 * CLI para invalidar o cache HTTP SQLite em desenvolvimento.
 * Recusa executar em produção (RN06).
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const categoriesData = require('../lib/http/cache/categories.json');

const { categories, defaults } = categoriesData;
const CATEGORY_NAMES = new Set(categories.map((c) => c.name));

// Mapa de rotas: mapeamento de prefixo para categorias
const ROUTES_MAP = {};
categories.forEach((cat) => {
  (cat.routes || []).forEach((route) => {
    if (!ROUTES_MAP[route]) {
      ROUTES_MAP[route] = [];
    }
    ROUTES_MAP[route].push(cat.name);
  });
});

function printUsage() {
  console.log('Uso: npm run cache:clear -- <categoria>');
  console.log('     npm run cache:clear -- --route <caminho>');
  console.log('     npm run cache:clear -- --all');
  console.log('\nCategorias disponíveis:', [...CATEGORY_NAMES].sort().join(', '));
  console.log('\nRotas disponíveis:', Object.keys(ROUTES_MAP).sort().join(', '));
}

// Guarda RN06
function checkProduction() {
  const env = process.env.NODE_ENV || '';
  const vercelEnv = process.env.VERCEL_ENV || '';
  const nextPublicVercelEnv = process.env.NEXT_PUBLIC_VERCEL_ENV || '';
  if (
    env.toLowerCase() === 'production' ||
    vercelEnv.toLowerCase() === 'production' ||
    nextPublicVercelEnv.toLowerCase() === 'production'
  ) {
    console.error('[cache:clear] RN06: recusado em ambiente de produção.');
    process.exit(1);
  }
}

function resolveSqlitePath() {
  const envPath = process.env.HTTP_CACHE_SQLITE_PATH;
  if (envPath && envPath.trim()) {
    const p = envPath.trim();
    return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  }
  if (process.env.VERCEL) {
    return path.join(os.tmpdir(), 'brasilapi-http-cache.sqlite');
  }
  return path.join(process.cwd(), '.cache', 'http-cache.sqlite');
}

function resolveCategories(args) {
  if (args.includes('--all')) return [...CATEGORY_NAMES];

  const routeIdx = args.indexOf('--route');
  if (routeIdx !== -1) {
    const route = args[routeIdx + 1];
    if (!route) {
      console.error('[cache:clear] --route requer um caminho.');
      printUsage();
      process.exit(1);
    }
    // Remove query string e barra final
    const cleanRoute = route.split('?')[0].replace(/\/$/, '');

    // Encontra o prefixo mais longo que casa
    const routeKeys = Object.keys(ROUTES_MAP).sort((a, b) => b.length - a.length);
    const matched = routeKeys.find(
      (k) => cleanRoute === k || cleanRoute.startsWith(k + '/')
    );

    if (!matched) {
      console.error(
        `[cache:clear] Rota "${cleanRoute}" não usa cache ou não foi encontrada.`
      );
      console.error('Prefixos conhecidos:', routeKeys.join(', '));
      process.exit(1);
    }

    const cats = ROUTES_MAP[matched];
    // Valida que todas as categorias existem
    cats.forEach((cat) => {
      if (!CATEGORY_NAMES.has(cat)) {
        console.error(
          `[cache:clear] Erro de programação: categoria "${cat}" no mapa de rotas não existe.`
        );
        process.exit(1);
      }
    });

    return cats;
  }

  // Categoria única
  const cat = args[0];
  if (!cat || !CATEGORY_NAMES.has(cat)) {
    console.error(
      `[cache:clear] Categoria "${cat}" inválida ou não encontrada.`
    );
    printUsage();
    process.exit(1);
  }
  return [cat];
}

async function main() {
  checkProduction();

  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  const targetCategories = resolveCategories(args);
  const sqlitePath = resolveSqlitePath();

  console.log(`[cache:clear] Caminho SQLite: ${sqlitePath}`);

  if (sqlitePath === ':memory:') {
    console.error('[cache:clear] Caminho :memory: não pode ser limpo via CLI.');
    process.exit(1);
  }

  if (!fs.existsSync(sqlitePath)) {
    console.log('[cache:clear] Arquivo SQLite não existe — nada a limpar.');
    process.exit(0);
  }

  const busyTimeoutMs = defaults ? defaults.busyTimeoutMs : 250;

  let KeyvSqlite;
  let Keyv;

  try {
    ({ default: KeyvSqlite } = await import('@keyv/sqlite'));
    ({ default: Keyv } = await import('keyv'));
  } catch (err) {
    console.error('[cache:clear] Falha ao carregar dependências:', err.message);
    process.exit(2);
  }

  let sqlite;
  try {
    sqlite = new KeyvSqlite({ uri: `sqlite://${sqlitePath}`, busyTimeout: busyTimeoutMs });
  } catch (err) {
    console.error('[cache:clear] Falha ao abrir SQLite:', err.message);
    process.exit(2);
  }

  // Processar categorias em sequência via reduce (sem await em laço direto)
  await targetCategories.reduce((chain, cat) => {
    return chain.then(async () => {
      try {
        const namespace = `brasilapi-http:${cat}`;
        const pattern = `${namespace}:%`;

        let countResult;
        try {
          countResult = await sqlite.query(
            'SELECT COUNT(*) AS n FROM keyv WHERE key LIKE ?',
            [pattern]
          );
        } catch {
          countResult = [{ n: 0 }];
        }

        const count = countResult && countResult[0] ? countResult[0].n : 0;

        const keyv = new Keyv({ store: sqlite, namespace });
        await keyv.clear();

        console.log(
          `[cache:clear] ${cat}: ${count} entrada(s) removida(s).`
        );
      } catch (err) {
        console.error(`[cache:clear] Erro ao limpar categoria "${cat}":`, err.message);
        throw err;
      }
    });
  }, Promise.resolve());

  console.log('[cache:clear] Concluído.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[cache:clear] Erro:', err.message);
  process.exit(2);
});
