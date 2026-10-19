# Implementation Plan — Cache HTTP com Got + Keyv/SQLite (Etapas 1–4)

Design aprovado: `.agents/tasks/brasilapi-cache-got-keyv-2026-10-15/design.md` (iteração 2).

Workspace: `c:\Users\islabelle.bastos_big\Documents\BrasilAPI`  
Node portátil: `.tools/node20/` — prefixar todo comando npm/node com:
`$env:PATH="c:\Users\islabelle.bastos_big\Documents\BrasilAPI\.tools\node20;$env:PATH"`  
Verificação: `$env:PATH="..."; cd c:\Users\islabelle.bastos_big\Documents\BrasilAPI; npm run test:unit`  
Nunca commitar/push/PR.

---

## Fase 1 — Instalar Dependências (Etapa 1)

- [ ] 1. Instalar os 5 pacotes com versões exatas.
      ```powershell
      $env:PATH="c:\Users\islabelle.bastos_big\Documents\BrasilAPI\.tools\node20;$env:PATH"
      cd c:\Users\islabelle.bastos_big\Documents\BrasilAPI
      npm install --save-exact got@11.8.6 http-cache-semantics@4.3.0 keyv@5.6.0 "@keyv/sqlite@4.0.8" sqlite3@5.1.7
      npm ls got keyv "@keyv/sqlite" sqlite3 http-cache-semantics
      ```
      Resultado esperado: `got@11.8.6`, `keyv@5.6.0`, `@keyv/sqlite@4.0.8`, `sqlite3@5.1.7`, `http-cache-semantics@4.3.0` no topo.
      Files: `package.json`, `package-lock.json`
      Verify: `npm ls` retorna os pacotes sem erro.

- [ ] 2. Adicionar `.cache/http-cache.sqlite*` ao `.gitignore`.
      Acrescentar ao final, com comentário, após a seção existente:
      ```
      # HTTP cache layer (etapa 3)
      /.cache/http-cache.sqlite*
      ```
      Files: `.gitignore`
      Verify: linha presente no arquivo.

---

## Fase 2 — Camada HTTP (Etapa 2)

Criar os 5 módulos da camada HTTP em `lib/http/`, em ordem de dependência.
Regras de estilo: sem `for…of`/`for…in`; sem `await` em laço; `no-param-reassign props: true`; sem `require` dentro de função (`import()` dinâmico); módulos Node sem prefixo `node:`.

- [ ] 3. Criar `lib/http/errors.js`.
      `HttpClientError extends Error` com campos opcionais `code`, `request`, `response`, `status`, `cause`.
      `name` padrão `'AxiosError'` (compatibilidade com errorHandler — design §10.3).
      `isHttpClientError` no protótipo (não enumerável).
      `export const isHttpClientError = (e) => Boolean(e) && e.isHttpClientError === true`.
      Funções auxiliares: `fromStatus(method, url, status, statusText, headers, data)`, 
      `fromGotError(err, method, url)`, `canceledError(req)`, `timeoutError(req)`.
      Files: `lib/http/errors.js`
      Verify: `npm run test:unit` — sem falhas novas.

- [ ] 4. Criar `lib/http/codec.js`.
      `buildUrl(url, params)` — serialização idêntica ao axios (trim, null/undefined descartados, array plano → `k[]=v`, Date → ISO, espaço → `+`, restaura `:$,[]\`).
      `encodeBody(body, existingHeaders)` — retorna `{ body: string|Buffer, contentType?: string }`.
      `decodeBody(buffer, responseType, encoding)` — `buffer` → Buffer; `text` → string (remove BOM se utf8); padrão → JSON.parse silencioso.
      Files: `lib/http/codec.js`
      Verify: `npm run test:unit` — sem falhas novas.

- [ ] 5. Criar `lib/http/transport.js`.
      `createDeadline(timeoutMs)` — relógio começa na primeira chamada a `remaining()`.
      `send(hopReq, deadline)` — usa `got.extend({ throwHttpErrors: false, retry: { limit: 0 }, followRedirect: false, responseType: 'buffer', decompress: true, http2: false })`. Arma `setTimeout(deadline.remaining())` e desmonta no evento `'response'`. Mapeia erros do Got para `HttpClientError`. Retorna `{ status, statusText, headers, body: Buffer, url }`.
      `hopReq` shape: `{ method, url, headers, body?, timeout, signal? }`.
      Files: `lib/http/transport.js`
      Verify: `npm run test:unit` — sem falhas novas.

- [ ] 6. Criar `lib/http/redirects.js`.
      `follow(req, hop, redirects = 0, deadline = createDeadline(req.timeout))` — recursivo (sem await em laço; no-await-in-loop).
      Segue regras do follow-redirects 1.15.11: máx. 21 saltos; 301/302 com POST → GET; 303 não-GET → GET; 307/308 mantêm método; remove `host`; remove `authorization`/`proxy-authorization`/`cookie` em mudança de host ou protocolo.
      O mesmo `deadline` é repassado à recursão e a todos os saltos.
      Erros: `ERR_FR_TOO_MANY_REDIRECTS`, `ERR_FR_REDIRECTION_FAILURE`.
      Agrega `cacheStatus` dos saltos: MISS > REVALIDATED > HIT.
      Files: `lib/http/redirects.js`
      Verify: `npm run test:unit` — sem falhas novas.

- [ ] 7. Criar `lib/http/client.js`.
      `export default httpClient = { get, post }` — objeto mutável (não `Object.freeze`) para `vi.spyOn`.
      `get(url, opts)`: opções aceitas — `params`, `headers`, `timeout`, `signal`, `responseType`, `encoding`, `cache`.
      Opções desconhecidas rejeitadas com `TypeError` (detecta resquícios de migração).
      Cabeçalhos padrão: `accept: 'application/json, text/plain, */*'`, `user-agent: 'axios/1.8.3'`, `accept-encoding: 'gzip, deflate, br'`.
      Nesta etapa (antes da camada de cache), `cache` é reconhecido mas ignorado — todo GET usa o transporte direto.
      `post(url, body, opts)`: sem opção `cache`.
      Decodifica o corpo com `codec.decodeBody`; lança `HttpClientError` para status não-2xx via `fromStatus`.
      Files: `lib/http/client.js`
      Verify: `npm run test:unit` — sem falhas novas.

---

## Fase 3 — Migrar arquivos de produção (Etapa 2 cont.)

Migrar os 34 arquivos de produção de `axios`/`fetch` nativo para `httpClient`.
Preservar semântica `{ status, data, headers }` e os predicados de erro.
**Não** adicionar opção `cache` nesta fase (vem na Fase 5).

- [ ] 8. Migrar os 31 arquivos de `services/` que importam `axios`.
      Padrão geral: `import axios from 'axios'` → `import httpClient from '@/lib/http/client'`.
      `axios.get(url, opts)` → `httpClient.get(url, opts)`.
      `axios.post(url, body, opts)` → `httpClient.post(url, body, opts)`.
      `axios.isAxiosError(err)` → `isHttpClientError(err)` (import de `@/lib/http/errors`).
      `axios.create({ baseURL })`: substituir por constante de URL e chamar `httpClient.get` com URL completa.
      Especificidades por arquivo:
        - `services/cnpj.js`: `axios.isAxiosError` → `isHttpClientError`; `axios.get(url, { timeout, signal })` → `httpClient.get(url, { timeout, signal })`.
        - `services/indices/helpers.js`: `axios.isAxiosError` → `isHttpClientError`.
        - `services/universities.js`: remover `axios.create`; usar constante `const BASE_URL = 'https://api.universities.com.br'`; `axiosInstance.get(endpoint)` → `httpClient.get(BASE_URL + endpoint)`.
      Files: todos os 31 arquivos em `services/` identificados no §15 do design.
      Verify: `npm run test:unit` — sem falhas novas.

- [ ] 9. Migrar `util/getCsvAsJson.js` e `pages/api/geolocation/v1/index.js` de `axios` para `httpClient`.
      Files: `util/getCsvAsJson.js`, `pages/api/geolocation/v1/index.js`
      Verify: `npm run test:unit` — sem falhas novas.

- [ ] 10. Migrar `lib/fetchGeocoordinateFromBrazilLocation.js` de `fetch` nativo para `httpClient`.
       Remover `import https from 'https'`, função `getAgent()` e função `fetchJson()`.
       `fetchPhoton(query)`: `httpClient.get(url, { timeout: 2000 })` dentro de try/catch (retorna `[]` em erro).
       `fetchOpenMeteo(city, state)`: idem.
       O `User-Agent` randômico que hoje vai no fetch pode ser omitido (o httpClient usa `axios/1.8.3`).
       Files: `lib/fetchGeocoordinateFromBrazilLocation.js`
       Verify: `npm run test:unit` — sem falhas novas.

---

## Fase 4 — Adaptar testes (Etapa 2 cont.)

Adaptar os 13 testes que mockam `axios` ou `global.fetch`.
Padrão geral: substituir `vi.mock('axios')` / `vi.mock('axios', ...)` por `vi.mock('@/lib/http/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }))`.
`axios.get.mock...` → `httpClient.get.mock...`.

- [ ] 11. Adaptar `tests/solarIncidence.test.js`.
       `vi.mock('axios')` → `vi.mock('@/lib/http/client', ...)`.
       `axios.get.mockResolvedValueOnce({ data: mockGeocode })` → `httpClient.get.mockResolvedValueOnce({ data: mockGeocode })`.
       Adicionar import de `httpClient` após o mock.
       Files: `tests/solarIncidence.test.js`
       Verify: `npm run test:unit -- --reporter verbose 2>&1 | Select-String solarIncidence` — teste passa.

- [ ] 12. Adaptar `tests/cep-timeout.test.js`.
       `vi.mock('axios')` → `vi.mock('@/lib/http/client', ...)`.
       `axios.get.mockImplementation(url => ...)` → `httpClient.get.mockImplementation(url => ...)`.
       Manter a mesma lógica de URL-matching e timing.
       Files: `tests/cep-timeout.test.js`
       Verify: `npm run test:unit -- --reporter verbose 2>&1 | Select-String "cep-timeout"` — teste passa.

- [ ] 13. Adaptar `tests/cnpj-contract.test.js`.
       Substituir `vi.spyOn(axios, 'get')` → `vi.spyOn(httpClient, 'get')`.
       Substituir `new axios.AxiosError(message, code, config, request, response)` → `new HttpClientError(message, { code, request: request ? { method: 'GET', url: request.url } : undefined, response })`.
       Substituir `new axios.CanceledError('canceled')` → `new HttpClientError('canceled', { code: 'ERR_CANCELED', name: 'CanceledError' })`.
       `axios.get` → `httpClient.get` em todas as assertivas.
       Imports: adicionar `httpClient` de `@/lib/http/client` e `HttpClientError` de `@/lib/http/errors`; remover `import axios from 'axios'`.
       Files: `tests/cnpj-contract.test.js`
       Verify: `npm run test:unit -- --reporter verbose 2>&1 | Select-String "cnpj-contract"` — todos os testes do describe passam.

- [ ] 14. Adaptar os 8 testes de eleições (anos-eleitorais, cargos-por-municipio, ordinarias, candidatos, candidaturas-api — ambas as variantes api e service).
       `vi.mock('axios', () => ({ default: { get: vi.fn() } }))` → `vi.mock('@/lib/http/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }))`.
       `vi.mocked(axios.get)` → `vi.mocked(httpClient.get)`.
       `axios.get.mockResolvedValueOnce(...)` → `httpClient.get.mockResolvedValueOnce(...)`.
       Files: `tests/eleicoes/anos-eleitorais-api.test.js`, `tests/eleicoes/anos-eleitorais.test.js`, `tests/eleicoes/cargos-por-municipio-api.test.js`, `tests/eleicoes/cargos-por-municipio.test.js`, `tests/eleicoes/ordinarias-api.test.js`, `tests/eleicoes/ordinarias.test.js`, `tests/eleicoes/candidatos/candidatos.test.js`, `tests/eleicoes/candidatos/candidaturas-api.test.js`
       Verify: `npm run test:unit` — todos os testes de eleições passam.

- [ ] 15. Adaptar `tests/services/isbn/searchInMercadoEditorial.test.js`.
       `vi.mock('axios')` → `vi.mock('@/lib/http/client', ...)`.
       `axios.get.mockResolvedValue(...)` → `httpClient.get.mockResolvedValue(...)`.
       Files: `tests/services/isbn/searchInMercadoEditorial.test.js`
       Verify: `npm run test:unit` — sem falhas novas.

- [ ] 16. Adaptar `tests/fetchGeocoordinateFromBrazilLocation.test.js`.
       Remover `vi.spyOn(global, 'fetch')` e helper `createFetchResponse`.
       Substituir por `vi.mock('@/lib/http/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }))`.
       `fetchMock = vi.spyOn(httpClient, 'get')` → ou usar `httpClient.get.mockResolvedValueOnce({ data: { features: [...] } })`.
       Ajustar assertivas de `fetchMock` para `httpClient.get`.
       O URL das chamadas muda: os parâmetros agora são passados via `params` no httpClient, mas a URL base permanece igual — checar se o teste verifica URLSearchParams ou apenas o prefixo da URL.
       Files: `tests/fetchGeocoordinateFromBrazilLocation.test.js`
       Verify: `npm run test:unit` — sem falhas novas.

---

## Fase 5 — Camada de Cache (Etapa 3)

- [ ] 17. Criar `lib/http/cacheContext.js`.
       `AsyncLocalStorage` singleton em `globalThis[Symbol.for('brasilapi.cache-ctx.v1')]`.
       Exports: `runWithCacheContext(store, fn)`, `recordCacheStatus(status)`, `aggregateCacheStatus(list)`.
       Agregação: MISS > REVALIDATED > HIT.
       Files: `lib/http/cacheContext.js`
       Verify: `npm run test:unit` — sem falhas novas.

- [ ] 18. Criar `lib/http/cache/categories.json`.
       JSON com array de categorias, cada uma contendo: `name`, `ttlSeconds` (padrão), `staleRetention`, `maxEntryBytes`, `namespace`, routes.
       19 categorias: banks (604800), cambio (86400), cep (86400), geocoding (604800), cptec (604800), clima (1800), cvm (86400), ddd (604800), eleicoes (21600), fipe (86400), ibge (604800), ibpt (86400), indices (86400), isbn (604800), ncm (86400), registrobr (300), solar (3600), b3 (86400), universities (604800).
       Mapa `routes` conforme design §7.4.
       Constantes `defaults`: `minStoreFreshnessSeconds: 5`, `busyTimeoutMs: 250`, `breakerThreshold: 5`, `breakerCooldownMs: 300000`.
       Files: `lib/http/cache/categories.json`
       Verify: `node -e "require('./lib/http/cache/categories.json')"` — sem erros.

- [ ] 19. Criar `lib/http/cache/categories.js` e `lib/http/cache/config.js`.
       `categories.js`: derivar `export const CACHE_CATEGORY = { BANKS: 'banks', ... }` do JSON.
       `config.js`: `createConfig(env)` pura — lê TTLs de `HTTP_CACHE_TTL_*`, valida, lança em erro de programação. `getConfig()` memoizado em `globalThis`; captura exceções de `createConfig` e retorna config com cache desligado.
       `HTTP_CACHE_ENABLED`: padrão `false` em NODE_ENV=test, `true` nos demais.
       Caminhos: `HTTP_CACHE_SQLITE_PATH` → VERCEL → `.cache/http-cache.sqlite`.
       Files: `lib/http/cache/categories.js`, `lib/http/cache/config.js`
       Verify: `npm run test:unit` — sem falhas novas.

- [ ] 20. Criar `lib/http/cache/keys.js`.
       `normalizeUrl(url)`: WHATWG URL, porta padrão removida, query params reordenados por nome (ordenação estável, decodificação com fallback, fragmento removido).
       `base(category, url)`: retorna `{ pk, baseHash, metaKey, bodyKey }`.
       `variant(base, names, headers)`: hash SHA-256 dos pares nome:valor.
       Files: `lib/http/cache/keys.js`
       Verify: `npm run test:unit` — sem falhas novas.

- [ ] 21. Criar `lib/http/cache/policy.js`.
       `POLICY_OPTIONS`: `{ shared: true, cacheHeuristic: 0.1, immutableMinTimeToLive: 0 }`.
       `normalizeCacheHeaders(headers)`: faz lowercase de valores de `cache-control`, `pragma`, `vary`; une arrays.
       `parseDirectives(value)`: `Map<nome, Array<string|null>>`.
       `freshnessSource(h, cc)`: retorna `'revalidate' | 'explicit' | 'heuristic'` conforme §5.2.
       `explicitFreshnessValid(cc)`: verifica que s-maxage/max-age são únicos e numéricos.
       `parseVary(h)`: retorna `{ star: boolean, names?: string[] }`.
       `hasValidators(h)`: ETag ou Last-Modified válido.
       `evaluateStorability(snapshot, { status, headers }, bodyBytes, catCfg, nowMs)`: aplica R1–R9 do design; retorna `{ store: false, reason }` ou `{ store: true, policy, varyNames, remainingMs, freshUntil, keyvTtlMs, validators, heuristic }`.
       `sanitizeStoredHeaders(headers)`: remove hop-by-hop + content-encoding/length.
       `mergeNotModifiedHeaders(stored, notModifiedHeaders)`: add-or-replace exceto os campos da RFC.
       `requestSnapshot(req)`: `{ method: 'GET', url: pathname+search, headers: { ...req.headers, host } }`.
       Files: `lib/http/cache/policy.js`
       Verify: `npm run test:unit` — sem falhas novas.

- [ ] 22. Criar `lib/http/cache/store.js`.
       Singleton em `globalThis[Symbol.for('brasilapi.http-cache.v1')]`.
       Import dinâmico de `keyv` e `@keyv/sqlite` (nunca `require`).
       Inicialização lazy com sonda de escrita (`_probe`), WAL journal, circuit breaker com meia-abertura.
       `read(base, reqHeaders)` → `null | { meta, body: Buffer, location: { metaKey, bodyKey } }`.
       `write(base, reqHeaders, res, decision)`, `writeMetaOnly(location, meta, merged, decision)`, `remove(location)` — nunca rejeitam.
       `isAvailable()` — síncrono.
       Cada operação limitada por `opTimeoutMs` do `withTimeout`.
       Leitura: `keyv.getMany([metaKey, bodyKey])`; validação de `v`, `kind`, `pk`, `vary.values`, `body.id === meta.bodyId`.
       Files: `lib/http/cache/store.js`
       Verify: `npm run test:unit` — sem falhas novas.

- [ ] 23. Criar `lib/http/cache/cachedHop.js`.
       `createCachedHop({ store, transport, getConfig, now = Date.now, log })` → `cachedHop(req, deadline)`.
       Algoritmo: prepare (F1, sem rede) → send (com rede, erros propagam) → finalize (F2, sem rede, erros degradam).
       HIT sem rede: `freshUntil > now()`.
       Revalidação condicional: `policy.revalidationHeaders`, remove `host`, checa se condicional.
       Finalização de 304: `policy.revalidatedPolicy`, `mergeNotModifiedHeaders`, `sameVaryNames`; writeMetaOnly ou remoção.
       Refetch (304 sem correspondência): segunda chamada incondicional → única segunda chamada por salto.
       `fallbackResult`: sem nova chamada de rede.
       Files: `lib/http/cache/cachedHop.js`
       Verify: `npm run test:unit` — sem falhas novas.

---

## Fase 6 — Integração e X-Cache (Etapa 4)

- [ ] 24. Atualizar `lib/http/client.js` para usar o cache.
       Importar `getConfig` de `@/lib/http/cache/config`, `createCachedHop` de `@/lib/http/cache/cachedHop`, `store` de `@/lib/http/cache/store`, `recordCacheStatus` de `@/lib/http/cacheContext`.
       Em `get(url, opts)`: quando `cache` está definido e `getConfig().categories[cache]` existe, usar `createCachedHop(...)` como `hop`; caso contrário transporte direto.
       Após retorno, chamar `recordCacheStatus(result.cacheStatus)` se `cache` estiver ativo.
       Files: `lib/http/client.js`
       Verify: `npm run test:unit` — sem falhas novas.

- [ ] 25. Adicionar opção `cache: CACHE_CATEGORY.X` às chamadas de serviços que fazem GET para provedores cacheáveis.
       Conforme tabela §7 do design. Exemplos de chamadas que recebem cache:
         - `services/ddd.js` → `{ cache: CACHE_CATEGORY.ddd }` (Anatel)
         - `services/ibge/gov.js`, `ibge/cnae.js` → `{ cache: CACHE_CATEGORY.ibge }` (IBGE)
         - `services/cep/cep.js` → `{ cache: CACHE_CATEGORY.cep }` (opencep.com)
         - `services/solarIncidenceService.js` → `{ cache: CACHE_CATEGORY.geocoding }` (open-meteo geocoding) e `{ cache: CACHE_CATEGORY.solar }` (sunrise-sunset)
         - `lib/fetchGeocoordinateFromBrazilLocation.js` → `{ cache: CACHE_CATEGORY.geocoding }` (photon, open-meteo)
         - etc. (ver mapa completo no design §7.1 e §7.3)
       **Não adicionar** `cache` em: `services/cnpj.js`, `pages/api/geolocation/v1/index.js`, `update.opencep.com`, POSTs, `services/fipe/http.js` (POST).
       Files: os serviços listados no design §7.3 que fazem GET para provedores com categoria.
       Verify: `npm run test:unit` — sem falhas novas.

- [ ] 26. Criar `middlewares/cacheStatus.js`.
       Usa `AsyncLocalStorage` de `lib/http/cacheContext.js`.
       Envolve `next()` em `runWithCacheContext({ calls: [] }, next)`.
       Substitui `response.writeHead` na instância com wrapper que injeta `X-Cache` antes de delegar.
       Try/catch no wrapper — `writeHead` original é SEMPRE chamado.
       `X-Cache` só é definido se houver registros e o cabeçalho ainda não existir.
       Files: `middlewares/cacheStatus.js`
       Verify: `npm run test:unit` — sem falhas novas.

- [ ] 27. Atualizar `app.js` para adicionar o middleware `cacheStatus`.
       Importar `cacheStatus` de `./middlewares/cacheStatus`.
       Adicionar `.use(cacheStatus)` APÓS `.use(cache(configurations.cache))` na cadeia.
       Files: `app.js`
       Verify: `npm run test:unit` — sem falhas novas (especialmente `cnpj-contract.test.js`).

- [ ] 28. Criar `scripts/cache-clear.js` e adicionar script ao `package.json`.
       CJS (como os demais scripts). Carrega `keyv`/`@keyv/sqlite` com `import()` dinâmico dentro de `main()`.
       Guarda RN06: recusa em `NODE_ENV === 'production'`, `VERCEL_ENV === 'production'` ou `NEXT_PUBLIC_VERCEL_ENV === 'production'`.
       Argumentos: `<categoria>`, `--route <caminho>` ou `--all`.
       Caminho SQLite: segue mesma regra de três ramos de `config.js`.
       Imprime linhas removidas por categoria.
       `package.json`: adicionar `"cache:clear": "node scripts/cache-clear.js"` em `scripts`.
       Files: `scripts/cache-clear.js`, `package.json`
       Verify: `npm run test:unit` — sem falhas novas.

---

## Fase 7 — Documentação

- [ ] 29. Criar `docs/HTTP_CACHE_GOT_KEYV.md`.
       Documento em português. Seções obrigatórias (design §1):
       1. Dependências e versões (com saída real de `npm ls`), justificativa de cada uma.
       2. Arquitetura e módulos, com assinaturas públicas de cada arquivo.
       3. Regras R1–R16 e algoritmo prepare/finalize/degradação.
       4. Formato persistido e chave (schema v1).
       5. Tabela de TTL por categoria e variáveis de ambiente.
       6. Cabeçalho `X-Cache` (valores, onde aparece, onde não aparece).
       7. CLI `npm run cache:clear` — uso e limitações.
       8. Paridade com axios (timeout, redirects, erros, params, decodificação).
       9. Mudanças arquivo a arquivo (lista dos 34 arquivos migrados e 13 testes adaptados).
       10. Resultados reais de `npm ci`, ESLint, `next build`, `npm test` sob Node 20.20.2.
       11. Desvios deliberados (D1–D10 do design §23.1), riscos e backlog.
       12. Aviso sobre OpenAPI do X-Cache ser obrigatório na etapa 7.
       Files: `docs/HTTP_CACHE_GOT_KEYV.md`
       Verify: arquivo existe e contém todas as seções listadas.

---

## Verificação Final

```powershell
$env:PATH="c:\Users\islabelle.bastos_big\Documents\BrasilAPI\.tools\node20;$env:PATH"
cd c:\Users\islabelle.bastos_big\Documents\BrasilAPI
npm run test:unit
```

Todos os testes devem passar. Nenhum arquivo de produção deve importar `axios` diretamente (exceto `scripts/` e `tests/` E2E). Verificar com busca:

```powershell
Select-String -Path "services\**\*.js","lib\**\*.js","util\**\*.js","pages\api\**\*.js","app.js","middlewares\**\*.js" -Pattern "from 'axios'" -SimpleMatch
```

Deve retornar zero resultados.
