# Design técnico — Cache HTTP persistente com Got + Keyv/@keyv/sqlite (Atividade A2, etapas 1–4)

Documento de design, **iteração 2**. Revisa a iteração 1 a partir de `design-review.md` / `design-verdict.json` (CHANGES_REQUESTED: 1 HIGH, 8 MEDIUM, 15 NIT). Todos os 24 achados foram tratados; a resposta a cada um está na §26. Fonte de requisitos: `requisitos-atividade-a2.md` (F01.1–F03.3, NF01.1–NF03.1, RN01–RN06, UC01–UC03). Escopo: etapas 1 a 4 do cronograma.

Nenhum código de aplicação foi alterado na elaboração deste documento. As verificações de bibliotecas e os experimentos de timeout foram feitos num sandbox temporário fora do repositório (`%TEMP%\a2-design-sandbox`, removido ao final), com o Node 20.20.2 portátil de `.tools/node20`.

## 0. Visão geral

Todas as chamadas HTTP externas do código de produção do BrasilAPI (33 arquivos que importam `axios` e 1 arquivo que usa `fetch` nativo) passam a usar um único cliente, `lib/http/client.js`, construído sobre **Got 11.8.6**. O cliente reproduz a semântica que o código já espera do axios 1.8.3: `{ status, data, headers }` no sucesso; erro com `error.response.status`, `error.response.data`, `error.code` e `error.request`; mesmo timeout (relógio de parede até os cabeçalhos mais inatividade de socket), mesmas regras de redirect do follow-redirects, mesma serialização de `params`. Os serviços mudam só a linha da chamada.

Todo redirect é seguido por um único seguidor recursivo nosso (`lib/http/redirects.js`), com o Got sempre em `followRedirect: false`. Quando a chamada é um `GET` com uma **categoria de cache**, cada salto passa pela camada `lib/http/cache/*`. Ela aplica a RFC 7234 como cache **compartilhado**, usando **http-cache-semantics 4.3.0** (a mesma biblioteca do cache nativo do Got) sobre cabeçalhos normalizados sem diferença de caixa. As respostas ficam num arquivo SQLite via **Keyv 5.6.0 + @keyv/sqlite 4.0.8** (driver nativo **sqlite3 5.1.7**).

O TTL por categoria fica numa tabela única, sobrescrevível por variável de ambiente. Ele serve de **frescor heurístico** (RFC 7234 §4.2.2) quando a origem não declara frescor explícito, e de **teto** quando declara: nunca estende o que a origem permite. Entradas vencidas com validadores (`ETag`/`Last-Modified`) ficam retidas por uma janela configurável e são revalidadas com `If-None-Match`/`If-Modified-Since`. Um `304` renova só os metadados, sem regravar o corpo.

A camada separa a fase de preparação (sem rede) da fase de finalização (depois da resposta). Qualquer falha de cache degrada para a origem sem alterar o resultado da rota e sem uma segunda chamada à origem. A única segunda chamada que pode acontecer num salto é a requisição incondicional que a RFC exige depois de um `304` sem correspondência, e ela é decisão de protocolo, não degradação.

As rotas montadas com `app()` ganham o cabeçalho aditivo `X-Cache: HIT|MISS|REVALIDATED`. A invalidação manual em desenvolvimento é um script npm (`npm run cache:clear`), recusado em produção. O `axios` continua em `dependencies` (testes e `scripts/` o usam; nenhum código de produção o importa). A implementação termina com o documento pedido pelo usuário, `docs/HTTP_CACHE_GOT_KEYV.md`.

## 1. Escopo, premissas e restrições

**Dentro do escopo (etapas 1–4 + pedido explícito do usuário):**

- Etapa 1: instalar e fixar as dependências.
- Etapa 2: substituir o axios pelo Got em todas as chamadas externas de produção.
- Etapa 3: camada Keyv/SQLite com TTL por categoria e isolamento por rota e parâmetros.
- Etapa 4: requisições condicionais e conformidade com a RFC 7234.
- Adaptar os **13 testes existentes** que mockam `axios`/`fetch` para o novo módulo. É necessário para não quebrá-los; não é suíte nova.
- `.gitignore`.
- Script de invalidação manual.
- **Documento de implementação** `docs/HTTP_CACHE_GOT_KEYV.md` (português; segue a convenção dos documentos de funcionalidade em `docs/`, como `BANKS_HEADQUARTERS_ADDRESS.md`). É o entregável de "Gere um documento com todos os detalhes da implementação" e é escrito **depois** do código, com resultados reais. Conteúdo obrigatório:
  1. dependências e versões instaladas (`npm ls`), com a justificativa;
  2. arquitetura e módulos, com as assinaturas públicas;
  3. regras R1–R16 e o algoritmo (preparação/finalização/degradação);
  4. formato persistido e chave;
  5. tabela de TTL e variáveis de ambiente;
  6. `X-Cache`;
  7. CLI `cache:clear`;
  8. paridade com o axios (timeout, redirects, erros, params);
  9. mudanças arquivo a arquivo e testes adaptados;
  10. resultados sob Node 20.20.2 de `npm ci`, ESLint, `next build`, `npm test` e dos critérios de aceite da §22;
  11. desvios deliberados (§23.1), riscos e backlog;
  12. aviso de que a documentação OpenAPI do `X-Cache` é obrigatória na etapa 7.

**Fora do escopo:**

- Etapa 5: suíte nova de testes da camada de cache.
- Etapa 6: benchmark com autocannon.
- Etapa 7: documentação OpenAPI do `X-Cache` (obrigatória nessa etapa), atualização de `docs/ENDPOINT_GUIDE.md`/`CLAUDE.md`, que ainda mostram axios, e o PR.
- Commit, push e PR.

Verificações ad hoc durante a implementação, como scripts descartáveis para os critérios da §22, ficam fora do repositório ou são apagadas ao final.

**Premissas (verificadas):**

- P1. O runner de testes real é **Vitest 3.0.8**: `package.json` (`test`, `test:unit`) e `vite.config.js` (`setupFiles: tests/helpers/server/setup.js`, `fileParallelism: false`). O PDF cita Jest; vale o `package.json`.
- P2. Node local: portátil **v20.20.2** em `.tools/node20/` (`setup-report.md`). Todo comando npm/node do implementador prefixa `$env:PATH="c:\Users\islabelle.bastos_big\Documents\BrasilAPI\.tools\node20;$env:PATH"`. O E2E do CI usa `node-version: '20.x'` e `.nvmrc` = `20`. `package.json#engines.node` continua `"24.x"`: não alterar, porque afeta o runtime da Vercel. Toda a stack escolhida também roda em Node 24 (o sqlite3 usa N-API v6, com ABI estável).
- P3. Next instalado: **12.3.7**. Em `node_modules/next/dist/build/webpack-config.js` (`handleExternals`), todo `.js/.mjs/.cjs` de `node_modules` é externalizado (`commonjs <pkg>` ou `module <pkg>`). Assim, `got`, `keyv`, `@keyv/sqlite` e `sqlite3` **não são empacotados** e o binário `.node` do sqlite3 é carregado em runtime (via `bindings`). Precedente de pacote dual resolvido como ESM em rota de produção: `zod` em `services/tickers/listTickers.js`. A revisão confirmou que o webpack 5 embutido trata externals `module` como módulo assíncrono, o que viabiliza `await import('keyv')`.
- P4. E2E (`.github/workflows/e2e-tests.yml`):
  - `npm ci` (com scripts de instalação, então o prebuilt do sqlite3 é baixado);
  - ESLint em `pages/ services/ lib/ util/ middlewares/ errors/`;
  - `npm test` = `concurrently` com `next` (dev, `NODE_ENV=development`) + `vitest run`;
  - os testes usam `global.SERVER_URL = 'http://localhost:3000'` (`tests/helpers/server/setup.js`, que exige `NODE_ENV === 'test'` no processo do Vitest).
- P5. `vercel.json`: funções `pages/api/**` com 256 MB e 10 s. Na Vercel o FS é somente leitura, exceto `/tmp` (efêmero, por instância).
- P6. Cabeçalhos dos provedores levantados em 2026-10-15/16 (§7.2). Podem mudar, então a decisão de armazenar é tomada **por resposta, em runtime**.
- P7. Código das bibliotecas lido no sandbox: `got@11.8.6` (`as-promise/index.js` repassa o evento `'response'` do core ao chegar os cabeçalhos; `core/utils/timed-out.js`: `socket` usa `ClientRequest#setTimeout`, que mede inatividade e o Node só arma após o connect; `response` só começa após o upload), `http-cache-semantics@4.3.0`, `keyv@5.6.0`, `@keyv/sqlite@4.0.8`, `follow-redirects@1.15.11` e `axios@1.8.3` (`lib/adapters/http.js`, `helpers/buildURL.js`, `helpers/toFormData.js`).

## 2. Stack tecnológica (travada após aprovação)

| Pacote | Versão exata | Onde | Motivo |
|---|---|---|---|
| `got` | **11.8.6** | dependencies | Única linha CommonJS do Got (12+ é ESM-only; 16.x exige Node ≥ 22). Ver Decisão 1. |
| `http-cache-semantics` | **4.3.0** (latest) | dependencies | Motor RFC 7234 (`storable`, `maxAge`, `age`, `revalidationHeaders`, `revalidatedPolicy`, `toObject`/`fromObject`). CJS, sem dependências. Já vem via `got → cacheable-request@7.0.4`; o pin top-level deduplica. |
| `keyv` | **5.6.0** (último 5.x) | dependencies | Gerenciador de cache (F02.1). Dual ESM/CJS (`exports.import`/`exports.require`), sem `engines`, opção `throwOnErrors`, `getMany`/`deleteMany`. Pareia com `@keyv/sqlite@4` (peer `keyv ^5.6.0`). Traz `@keyv/serialize`, que não usamos (serializador explícito). |
| `@keyv/sqlite` | **4.0.8** (último 4.x) | dependencies | Adapter KeyvSQLite (F02.2). `engines: node >= 18`, dual, `sqlite3 ^5.1.7`. Propaga o erro de conexão (`.catch(e => { this.emit('error', e); throw e; })`); a 3.6.7 engole o erro. |
| `sqlite3` | **5.1.7** | dependencies | Driver nativo do adapter. O pin explícito controla a versão do binário. Prebuilt N-API v6 confirmado (HTTP 200) para `win32-x64` e `linux-x64` (CI/Vercel). Instala com `prebuild-install -r napi \|\| node-gyp rebuild`. |
| `axios` | 1.8.3 (inalterada) | **permanece em dependencies** | Não é importado por código de produção (AC-02). Continua necessário para `tests/**` e `scripts/generate-*.js`; mover para devDependencies quebraria o lint de `scripts/` (achado 7). Ver Decisão 10. |

**Combinações rejeitadas (verificadas no registry npm):**

- `@keyv/sqlite@6.1.0` + `keyv@6.1.0`: `engines.node >= 22.19` com `better-sqlite3@13`, o que viola NF02.1.
- `@keyv/sqlite@3.6.7` + `keyv@4.5.4`: CJS, mas congelada e com bug de conexão (toda query vira `TypeError` depois de uma falha de abertura).
- `sqlite3@6.x`: fora do range `^5.1.7` do adapter; forçar via `overrides` seria gambiarra.
- `better-sqlite3`: não é o driver do KeyvSQLite compatível com Node 20.
- Got 12–16: ESM-only; ver Decisão 1.

**Comando de instalação (etapa 1, sob o Node 20 portátil):**

```powershell
$env:PATH="c:\Users\islabelle.bastos_big\Documents\BrasilAPI\.tools\node20;$env:PATH"
npm install --save-exact got@11.8.6 http-cache-semantics@4.3.0 keyv@5.6.0 @keyv/sqlite@4.0.8 sqlite3@5.1.7
npm ls got keyv @keyv/sqlite sqlite3 http-cache-semantics
```

**Resultado esperado no `npm ls`:**

- `keyv@5.6.0` no topo;
- `keyv@4.5.4` aninhado **duas vezes**: em `got@11.8.6 → cacheable-request@7.0.4` e em `eslint@8.57.1 → file-entry-cache@6.0.1 → flat-cache@3.2.0` (hoje esse é o `keyv` top-level; verificado com `npm ls keyv`);
- um único `sqlite3@5.1.7`;
- um único `http-cache-semantics@4.3.0`, deduplicado.

`package.json` passa a listar as cinco versões sem `^`/`~`. O `axios` continua exatamente como está.

## 3. Arquitetura e layout de módulos

```
pages/api/** ──► services/** / lib/fetchGeocoordinateFromBrazilLocation.js / util/getCsvAsJson.js
                     │  httpClient.get(url, { cache: CACHE_CATEGORY.X, ... })  /  httpClient.post(url, body, ...)
                     ▼
lib/http/client.js ── valida opções, monta URL (params estilo axios) + cabeçalhos + corpo,
   │                  escolhe o salto, decodifica o corpo, valida status (2xx), registra X-Cache
   ▼
lib/http/redirects.js ── seguidor recursivo ÚNICO (regras do follow-redirects 1.15.11, máx. 21)
   │      cada salto ──► GET + categoria ativa ──► lib/http/cache/cachedHop.js
   │                                                  ├─ prepare  (keys.js, store.read, policy.js)  ── sem rede
   │                                                  ├─ transport.send (1 chamada)
   │                                                  └─ finalize (policy.js, store.write/writeMetaOnly/remove)
   │      cada salto ──► demais (POST, sem categoria, cache off) ──► lib/http/transport.js
   ▼
lib/http/transport.js ── Got 11 (followRedirect:false, retry 0, buffer), prazo de parede + socket, signal, erros
middlewares/cacheStatus.js ── AsyncLocalStorage por requisição + gancho em writeHead → X-Cache
scripts/cache-clear.js ── CLI dev-only (F03.3)
```

| Arquivo novo | Responsabilidade e exports |
|---|---|
| `lib/http/client.js` | API pública. `export default httpClient`, onde `const httpClient = { get, post }` é um objeto **mutável** (não congelado), para permitir `vi.spyOn(httpClient, 'get')`, como no padrão `axios.get`. Valida as opções, monta a requisição, escolhe o salto, decodifica, aplica erro por status e registra o `X-Cache`. |
| `lib/http/transport.js` | `send(hopReq, deadline)` faz **um** envio via `got.extend(...)` e devolve `{ status, statusText, headers, body: Buffer, url }`; nunca lança por status HTTP. `createDeadline(timeoutMs)`. Mapeia erros do Got para `HttpClientError`. Ponte `AbortSignal → promise.cancel()`. |
| `lib/http/redirects.js` | `follow(req, hop)`: seguidor recursivo único para todas as chamadas (R16). Puro, exceto pelo `hop` injetado. |
| `lib/http/errors.js` | `HttpClientError`, `isHttpClientError`, `fromStatus`, `fromGotError`, `canceledError`, `timeoutError`. Separado do client para não ser afetado por `vi.mock('@/lib/http/client', factory)`. |
| `lib/http/codec.js` | `buildUrl(url, params)` (serialização do axios), `encodeBody(body, headers)` e `decodeBody(buffer, responseType, encoding)`. Puro. |
| `lib/http/cacheContext.js` | `AsyncLocalStorage` (singleton em `globalThis`), `runWithCacheContext(store, fn)`, `recordCacheStatus(status)`, `aggregateCacheStatus(list)`. |
| `lib/http/cache/categories.json` | **Fonte única** de: namespace, caminho padrão do SQLite, limites padrão, TTL padrão + justificativa de cada categoria, e mapa `routes → categorias` (usado só pelo CLI). |
| `lib/http/cache/categories.js` | `export const CACHE_CATEGORY` (constantes `BANKS: 'banks'`, …) derivadas do JSON. Importado pelos serviços, não pelo client, para sobreviver a mocks de fábrica. |
| `lib/http/cache/config.js` | `createConfig(env)` (pura; lança em erro de programação) e `getConfig()` (memoizado em `globalThis`; captura qualquer exceção de `createConfig` e devolve config com cache desligado). Único lugar que lê TTLs. |
| `lib/http/cache/keys.js` | `normalizeUrl`, `base(category, url)`, `variant(base, names, headers)`. Puro. |
| `lib/http/cache/policy.js` | `POLICY_OPTIONS`, `normalizeCacheHeaders`, `parseDirectives`, `freshnessSource`, `explicitFreshnessValid`, `parseVary`, `hasValidators`, `evaluateStorability`, `mergeNotModifiedHeaders`, `sanitizeStoredHeaders`, `requestSnapshot`. Puro. |
| `lib/http/cache/store.js` | Singleton lazy (Keyv + KeyvSqlite) em `globalThis`; `import()` dinâmico de `keyv`/`@keyv/sqlite`; `mkdir`; sondas; timeout por operação; circuit breaker com meia-abertura. `read`/`write`/`writeMetaOnly`/`remove`/`isAvailable`; nunca rejeita. |
| `lib/http/cache/cachedHop.js` | `createCachedHop({ store, transport, getConfig, now, log })`, com `prepare` / `finalize` / `storeFull` / `fallbackResult` (§5.4). Injeção de dependências para testabilidade. |
| `middlewares/cacheStatus.js` | Middleware do `app()`: roda o handler dentro do contexto ALS e injeta `X-Cache` no `writeHead`. |
| `scripts/cache-clear.js` | CLI `npm run cache:clear -- <categoria> \| --route <caminho> \| --all` (CJS, bloqueado em produção). |
| `docs/HTTP_CACHE_GOT_KEYV.md` | Documento de implementação (§1). |

**Arquivos alterados:**

- `app.js` (um `.use(cacheStatus)`);
- `package.json`/`package-lock.json` (cinco dependências + script `cache:clear`);
- `.gitignore`;
- os 34 arquivos de produção da §15;
- os 13 testes da §16.

**Não alterar:**

- `middlewares/cache.js`: o `Cache-Control` da CDN continua idêntico;
- `middlewares/errorHandler.js`;
- `errors/*`;
- o cache em memória de 6 h de `services/banco-central/index.js`;
- a lógica de deadline e 503 de `services/cnpj.js` (só troca a chamada e o predicado de tipo).

### 3.1 Contratos internos (assinaturas que a implementação deve seguir)

```js
// lib/http/errors.js
export class HttpClientError extends Error {
  // opts: { code?: string, request?: { method, url }, response?: { status, statusText?, headers?, data },
  //         name?: string = 'AxiosError', cause?: unknown }
  constructor(message, { code, request, response, name = 'AxiosError', cause } = {}) {
    super(message);
    this.name = name;                         // nome legado de compatibilidade (ver §10.3)
    if (code !== undefined) this.code = code;
    if (request !== undefined) this.request = request;     // NUNCA preenchido por padrão (o CNPJ testa a ausência)
    if (response !== undefined) { this.response = response; this.status = response.status; }
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause, enumerable: false });
  }
}
HttpClientError.prototype.isHttpClientError = true;    // no protótipo: não entra no `...error` do errorHandler
export const isHttpClientError = (e) => Boolean(e) && e.isHttpClientError === true;

// lib/http/transport.js
export function createDeadline(timeoutMs) {}  // => { remaining(): number }  (Infinity se timeoutMs falsy;
                                               //    o relógio começa na 1ª chamada a remaining())
export async function send(hopReq, deadline) {}
// hopReq: { method: 'GET'|'POST'|..., url: string (absoluta, params já aplicados), headers: {minúsculos},
//           body?: string|Buffer, timeout: number (0 = sem), signal?: AbortSignal }
// => { status, statusText, headers, body: Buffer, url }   | lança HttpClientError (rede/timeout/abort)

// lib/http/redirects.js
export async function follow(req, hop, redirects = 0, deadline = createDeadline(req.timeout)) {}
// o mesmo `deadline` é repassado à recursão e a todos os saltos (§10.2)
// hop(hopReq, deadline) => { status, statusText, headers, body, url, cacheStatus? }
// => resposta final (status qualquer), com `cacheStatus` agregado de todos os saltos (MISS > REVALIDATED > HIT;
//    undefined se nenhum salto passou pelo cache)
//    | lança HttpClientError ERR_FR_TOO_MANY_REDIRECTS / ERR_FR_REDIRECTION_FAILURE

// lib/http/cache/store.js  (nenhuma função rejeita; falhas viram null/void + breaker)
export function isAvailable() {}                              // boolean síncrono (habilitado, não desligado, breaker não aberto)
export async function read(base, reqHeaders) {}               // => null | { meta, body: Buffer, location: { metaKey, bodyKey } }
                                                              //    (location aponta para a entrada base ou para a variante)
export async function write(base, reqHeaders, res, decision) {}           // => void
export async function writeMetaOnly(location, meta, mergedHeaders, decision) {} // => void
export async function remove(location) {}                     // => void (não remove o índice de Vary; ver §5.5)

// lib/http/cache/cachedHop.js
export function createCachedHop({ store, transport, getConfig, now = Date.now, log }) {}
// => async cachedHop(hopReq & { category }, deadline) => { status, statusText, headers, body, url, cacheStatus }
```

**Regras de estilo que afetam a implementação** (Airbnb + Prettier do projeto):

- sem `for…of`/`for…in` (`no-restricted-syntax`);
- sem `await` dentro de laço (`no-await-in-loop`), por isso o seguimento de redirects é **recursivo**;
- `no-param-reassign` com `props: true`: nada muta parâmetros. O prazo é um objeto com método (`deadline.remaining()`), e o contador de redirects é parâmetro da recursão;
- `+= 1` em vez de `++`;
- sem acesso a campos `_privados` (`no-underscore-dangle`), por isso o predicado explícito × heurístico é nosso (§5.2);
- JSON importado com extensão `.json` (precedente: `./banksList.json`);
- `import()` dinâmico em vez de `require` dentro de função (`global-require`);
- módulos Node sem prefixo `node:` (padrão do repositório: `import fs from 'fs'`).

## 4. Decisão 1 — Major do Got: **11.8.6**

**Fatos verificados:**

- `got@16.1.0` (latest) é ESM-only com `engines.node >= 22`, incompatível com NF02.1.
- Got 12–15 são ESM-only.
- `got@11.8.6` é CommonJS (`main: dist/source`), `engines.node >= 10.19.0`, e depende de `cacheable-request ^7.0.2` (que usa `keyv@^4` e `http-cache-semantics@^4`), `p-cancelable ^2` e `decompress-response ^6`.

**Escolha: 11.8.6.** Razões:

1. CommonJS funciona sem ressalvas nas três frentes: o Next 12 o externaliza como `commonjs got` (P3), o Vitest o importa por interop CJS e Node 20/24 o carregam sem `require(esm)`.
2. Não usamos o cache nativo do Got (Decisão 2), então as versões novas não trazem vantagem nesse ponto.
3. A API necessária existe e foi lida no código: `throwHttpErrors`, `retry.limit`, `timeout.socket`, `responseType: 'buffer'`, `followRedirect: false` (devolve o 3xx com corpo), `decompress`, `promise.cancel()` → `CancelError`, `promise.on('response')` (emitido ao chegar os cabeçalhos, antes do corpo; medido: 22 ms com corpo terminando em 1650 ms) e as classes `RequestError`/`TimeoutError`/`CancelError`.

**Não usamos** `methodRewriting` nem o seguimento de redirects do Got, porque nenhuma das duas opções reproduz o follow-redirects (achado 4). O redirect é nosso (R16).

**Contras aceitos:**

- a linha 11 não recebe releases desde 2022 (CVE-2022-33987 corrigido em 11.8.5);
- não tem `signal` nativo, então a ponte para `AbortSignal` fica no `transport.js`.

Mitigação: o Got fica confinado a `lib/http/transport.js`; trocar de major no futuro é mudar um arquivo. O Got 14 (Node ≥ 20) seria viável via externals ESM do Next 12, mas não traz ganho funcional e aumenta a superfície de risco; rejeitado.

## 5. Decisão 2 — Estratégia RFC 7234: **(b) módulo fino sobre Got + http-cache-semantics + Keyv**

### 5.1 Alternativas

**(a) Opção `cache` nativa do Got 11** (cacheable-request@7) com uma instância Keyv por categoria. Rejeitada porque:

1. Sem frescor explícito e sem `Last-Modified`, `maxAge()` retorna 0: a entrada nasce vencida e, sem validadores, toda requisição vai à origem. A maioria dos provedores governamentais não envia cabeçalhos de cache (§7.2), então F03.1/UC01 não seriam atendidos. O Got 11 não oferece TTL heurístico configurável nem gancho antes do armazenamento.
2. Um erro do Keyv vira `CacheError` e **derruba a requisição**, o que viola o "zero downtime".
3. `isFromCache` não distingue HIT de revalidação 304, o que impede o `X-Cache: REVALIDATED`.
4. A retenção de vencidas com validadores (RN02) não é controlável: sem `maxTtl` a entrada nunca expira; com `maxTtl` ela expira mesmo tendo validadores.
5. Um `304` regrava o valor inteiro, corpo incluso, o que contraria UC03.
6. A chave é `METHOD:url`, sem namespace por categoria e sem Vary. Além disso, compartilhar um store entre várias instâncias Keyv sobrescreve `store.namespace`.
7. O parser de `Cache-Control` do http-cache-semantics diferencia caixa (achado 1) e o cacheable-request não oferece ponto para normalizar.

**(b) Escolhida.** O Got continua sendo o cliente HTTP de todas as chamadas de rede, e Keyv + @keyv/sqlite continuam sendo o gerenciador e a persistência. A política RFC 7234 é decidida pela mesma biblioteca que o Got usa internamente (`http-cache-semantics`), agora com normalização de caixa e controle explícito de heurística, teto, retenção, Vary, revalidação e falhas. Isso atende F02.1 ("conectar o cliente Got ao Keyv") no sentido da arquitetura da §7 do PDF (Rotas → Got → Keyv → @keyv/sqlite → SQLite). O cliente HTTP do BrasilAPI é a composição `client.js` (Got) + `cachedHop.js` (Keyv). Desvio literal registrado em D1 (§23.1).

### 5.2 Normalização e predicados de frescor (`policy.js`)

O BrasilAPI é tratado como **cache compartilhado**. Antes de qualquer `new CachePolicy(...)`, seja no MISS, seja nos cabeçalhos mesclados de um 304, e antes de qualquer parser próprio, os cabeçalhos de resposta passam por `normalizeCacheHeaders`. A RFC 7234 §5.2 define as diretivas como *case-insensitive*, mas o `parseCacheControl` do http-cache-semantics 4.3.0 faz `cc[k.trim()]` sem normalizar. Medido pela revisão: `Private, Max-Age=60` e `No-Store` davam `storable() === true`.

```js
// lib/http/cache/policy.js
export const POLICY_OPTIONS = Object.freeze({
  shared: true,
  cacheHeuristic: 0.1,
  // A 4.3.0 compara immutableMinTimeToLive (ms) com segundos em maxAge(); com o padrão (86400000) um
  // `immutable` sem max-age valeria 86.400.000 s. 0 neutraliza o defeito e nunca estende frescor.
  immutableMinTimeToLive: 0,
  ignoreCargoCult: false,
});

const LOWERCASE_VALUE_HEADERS = ['cache-control', 'pragma', 'vary'];

export function normalizeCacheHeaders(headers) {
  // cópia; nomes já chegam minúsculos do Node. Arrays (linhas repetidas) são unidos com ', '.
  const out = { ...headers };
  LOWERCASE_VALUE_HEADERS.forEach((name) => {
    const value = Array.isArray(out[name]) ? out[name].join(', ') : out[name];
    if (typeof value === 'string') out[name] = value.toLowerCase();
  });
  return out;
}

// Map<nome, Array<string|null>>: null = diretiva sem '='; vírgulas dentro de aspas não separam;
// valor sem aspas externas; partes vazias ignoradas. Recebe o valor JÁ normalizado.
export function parseDirectives(value) {}

export function freshnessSource(h, cc) {
  const revalidate =
    cc.has('no-cache') ||                                                   // com ou sem nomes de campo
    (h['cache-control'] === undefined && /no-cache/.test(h.pragma || '')) || // Pragma só sem Cache-Control (RFC 7234 §5.4)
    cc.has('proxy-revalidate') ||                                           // shared: mais estrito que a RFC, seguro
    (h['set-cookie'] !== undefined && !cc.has('public') && !cc.has('immutable'));
  if (revalidate) return 'revalidate';                                      // lifetime = 0 (R5)
  if (cc.has('s-maxage') || cc.has('max-age') || h.expires !== undefined) return 'explicit'; // R4
  return 'heuristic';                                                       // R6
}

const deltaSecondsValid = (cc, name) => {
  const values = cc.get(name);
  if (!values) return true;                                                 // ausente
  return values.every((v) => typeof v === 'string' && /^\d+$/.test(v)) && new Set(values).size === 1;
};
// RFC 7234 §4.2.1: frescor inválido (valor não numérico, vazio ou diretiva repetida com valores diferentes)
// é tratado como vencido. Expires inválido (ex.: "0") já dá maxAge() === 0 na biblioteca.
export const explicitFreshnessValid = (cc) =>
  deltaSecondsValid(cc, 's-maxage') && deltaSecondsValid(cc, 'max-age');
```

`computeFreshness(policy, h, cc, ttlMs, nowMs)`, em que `ttlMs = ttlCategoria × 1000`:

| `freshnessSource` | `lifetimeMs` | `heuristic` |
|---|---|---|
| `'revalidate'` | `0` | `false` |
| `'explicit'` e `explicitFreshnessValid(cc)` | `Math.min(policy.maxAge() * 1000, ttlMs)`; a biblioteca aplica `s-maxage` > `max-age` > `Expires` para cache compartilhado | `false` |
| `'explicit'` e inválido | `0` | `false` |
| `'heuristic'` com `Last-Modified` válido e anterior a `Date` (ou a agora, sem `Date`) | `Math.min(policy.maxAge() * 1000, ttlMs)` (10 % da idade do `Last-Modified`) | `true` |
| `'heuristic'` sem `Last-Modified` utilizável | `ttlMs` | `true` |

Depois: `remainingMs = Math.max(0, lifetimeMs − policy.age() × 1000)` e `freshUntil = nowMs + remainingMs`. **Não** usar `policy.timeToLive()`: na 4.3.0 ele soma `stale-while-revalidate`/`stale-if-error`.

`parseVary(h)` separa por vírgula, faz trim (o valor já está em minúsculas), remove duplicatas e ordena. Qualquer token `*` faz o resultado ser `{ star: true }`. A biblioteca só reconhece o `Vary` exatamente igual a `*`.

`hasValidators(h)` é verdadeiro se houver `etag` não vazio ou `last-modified` com `Date.parse` finito.

### 5.3 Regras normativas

Toda `CachePolicy` é construída com `POLICY_OPTIONS` e com o *snapshot* da requisição `requestSnapshot(req)`:

```js
{ method: 'GET', url: u.pathname + u.search, headers: { ...req.headers, host: u.host } }   // u = new URL(req.url)
```

- **R1 Métodos.** Só `GET` é armazenado ou servido do cache. `POST` (FIPE oficial, CBL) e qualquer outro método vão direto ao transporte. HEAD não é usado no código e não é armazenado. Um POST redirecionado para GET (R16) também não usa cache: a categoria só existe em chamadas `get`.
- **R2 Status armazenáveis.** Somente `200`, `301` e `308`, todos cacheáveis por padrão (RFC 7231 §6.1, RFC 7538 §3). Nenhum status de erro é armazenado, o que mantém idêntica a semântica de erro das rotas. 302/303/307 nunca são armazenados: a RFC permite quando há frescor explícito, mas é um "MAY" que não usamos.
- **R3 Proibições** (defesa em profundidade: as regras próprias **e** `policy.storable()`, ambas sobre cabeçalhos normalizados). Não armazena se:
  - `cc.has('no-store')` ou `cc.has('private')` na resposta;
  - `policy.storable()` for falso (cobre também `Authorization` sem `public`/`s-maxage`/`must-revalidate` e status não entendido);
  - `parseVary(h).star`;
  - o corpo decodificado passar de `maxEntryBytes`;
  - for 301/308 sem `Location`.
- **R4 Frescor explícito** (`s-maxage` > `max-age` > `Expires`): `lifetime = min(maxAge, ttlCategoria)`. O TTL da categoria **só reduz**, nunca estende. Valor inválido ou duplicado conflitante dá `lifetime = 0` (§5.2).
- **R5 Revalidação obrigatória.** `no-cache` (com ou sem nomes de campo), `Pragma: no-cache` sem `Cache-Control`, `proxy-revalidate` e `Set-Cookie` sem `public`/`immutable` dão `lifetime = 0`: toda reutilização exige revalidação condicional bem-sucedida. `must-revalidate` e a revalidação obrigatória que o `s-maxage` implica para cache compartilhado (RFC 7234 §5.2.2.9) só importam para resposta **vencida**. Como nunca servimos conteúdo vencido sem revalidação, ficam honradas por construção. O `s-maxage` em si define o tempo de vida (R4).
- **R6 Frescor heurístico** (RFC 7234 §4.2.2): só quando `freshnessSource` = `'heuristic'` e o status é cacheável por padrão (R2 garante). Usa a tabela da §5.2. `Warning: 113` não se aplica, porque cabeçalhos de origem nunca são repassados aos clientes do BrasilAPI.
- **R7 Idade.** `remaining = max(0, lifetime − age)`, onde `age()` = cabeçalho `Age` + tempo residente.
- **R8 Utilidade mínima.** Sem validadores e com `remaining < minStoreFreshnessSeconds` (5 s), não armazena (ex.: IBGE CNAE com `max-age=1`). Com validadores, armazena mesmo com `remaining = 0`, porque a revalidação é útil.
- **R9 Retenção (RN02).** TTL do registro de metadados no Keyv = `remaining + (temValidadores ? staleRetention : 0)`. Se o resultado for `< 1 ms`, não armazena: no Keyv 5, `ttl: 0` significa "sem expiração".
- **R10 Vary.** Os nomes do `Vary` e os valores correspondentes dos cabeçalhos **de saída** da requisição entram na chave (§6). `Vary` com `*` cai no R3.
- **R11 Revalidação.** Uma entrada vencida com validadores gera requisição condicional com `policy.revalidationHeaders(snapshot)`. A biblioteca acrescenta `If-None-Match` com o ETag e, em GET, `If-Modified-Since` com o `Last-Modified`. O `host` do snapshot é removido antes do envio (o Got o define pela URL). A requisição é **condicional** se o resultado tiver `if-none-match` ou `if-modified-since`.
- **R12 304.** `policy.revalidatedPolicy(snapshot, { status: 304, headers: normalizeCacheHeaders(res.headers) })` só é chamada quando o status é 304 **e** a requisição foi condicional. Na 4.3.0, para 5xx com `stale-if-error`, ela devolve `matches: true`, o que não queremos. Se `matches` e o conjunto de nomes de `Vary` dos cabeçalhos mesclados for igual ao armazenado:
  1. mescla os cabeçalhos com `mergeNotModifiedHeaders`: *add-or-replace* dos campos do 304, exceto `content-length`, `content-encoding`, `transfer-encoding`, `content-range` e hop-by-hop (RFC 7234 §4.3.4, na redação da RFC 9111 §3.2); **remove o `age` armazenado se o 304 não trouxer `Age`**;
  2. cria nova `CachePolicy` a partir do status armazenado + cabeçalhos mesclados;
  3. recalcula R3–R9;
  4. **regrava só o registro de metadados** e reutiliza o corpo, resultando em `REVALIDATED`.

  Caso contrário (validador do 304 diverge do armazenado, e a RFC proíbe usar o 304 para atualizar, ou o `Vary` mudou), faz **uma** requisição **incondicional**, tratada como MISS. É a única segunda chamada de rede permitida por salto (I14).
- **R13 Resposta completa durante revalidação ou MISS.** 200/301/308 armazenável substitui a entrada (corpo novo + metadados novos). Resposta não armazenável com status < 500 remove a entrada antiga. 5xx ou erro de rede mantém a entrada, que pode revalidar depois; **não serve conteúdo vencido** e propaga o erro exatamente como sem cache (sem `stale-if-error`).
- **R14 Diretivas e credenciais na requisição.** O cache é ignorado (bypass total, sem `X-Cache`) se a chamada de saída tiver `cache-control`, `pragma`, `authorization`, `proxy-authorization` ou `cookie`, qualquer que seja o valor (a caixa não importa). Nenhuma GET atual envia esses cabeçalhos. Credenciais nunca vão para o SQLite: o `CachePolicy#toObject()` guarda os cabeçalhos de requisição quando há `Vary`. Chamadas com chave de API em cabeçalho próprio, como o `Api-Key` do CBL, não recebem categoria (hoje só existe em POST). Cabeçalhos de cache enviados **pelos clientes do BrasilAPI** não são propagados.
- **R15 Invalidação por método inseguro (RFC 7234 §4.4).** Não se aplica: as únicas URIs que recebem POST (`veiculos.fipe.org.br/api/veiculos/*` e `isbn-search-br.search.windows.net/.../search`) não coincidem com nenhuma URI armazenada por GET (I11).
- **R16 Redirects (todas as chamadas, com ou sem cache).** O Got roda **sempre** com `followRedirect: false`, e `lib/http/redirects.js` segue os saltos recursivamente com as regras do follow-redirects 1.15.11 (§10.2). Cada salto passa pelo `hop` escolhido para a chamada. Num GET com cache, cada salto é consultado e armazenado sob a **sua própria URL efetiva** (RFC: a resposta fica associada à URI efetiva da requisição). 301/308 podem ser armazenados (R2); 302/303/307, nunca. Um 301 em HIT conta como redirect normalmente.

### 5.4 Algoritmo de um salto com cache (`cachedHop.js`)

A orquestração separa três fases. A **preparação** (F1) não usa a rede, e qualquer exceção nela degrada para o transporte direto. O **envio** usa a rede, e os erros de rede propagam como hoje. A **finalização** (F2) acontece depois da resposta, e qualquer exceção nela devolve a resposta já obtida, **sem nova chamada**.

```js
export function createCachedHop({ store, transport, getConfig, now = Date.now, log }) {
  async function prepare(req) {                              // F1 — nunca toca a rede
    const catCfg = getConfig().categories[req.category];
    const snapshot = requestSnapshot(req);
    const base = keys.base(req.category, req.url);           // { pk, baseHash, metaKey, bodyKey }
    const cached = await store.read(base, req.headers);      // null em ausência/erro/timeout/corrupção (nunca rejeita)
    if (!cached) return { catCfg, snapshot, base, cached: null, conditional: false, sendHeaders: req.headers };
    let policy;
    try {
      policy = CachePolicy.fromObject(cached.meta.policy);
    } catch (error) {
      log.warnOnce('cache-policy-restore', error);
      await store.remove(cached.location);                   // auto-correção; segue como MISS com gravação
      return { catCfg, snapshot, base, cached: null, conditional: false, sendHeaders: req.headers };
    }
    if (now() < cached.meta.freshUntil) return { hit: toResult(cached, 'HIT') };
    if (!cached.meta.validators) {                           // vencida sem validadores (resíduo de arredondamento do TTL)
      return { catCfg, snapshot, base, cached, conditional: false, sendHeaders: req.headers };
    }
    const headers = withoutHost(policy.revalidationHeaders(snapshot));
    const conditional = 'if-none-match' in headers || 'if-modified-since' in headers;
    return { catCfg, snapshot, base, cached, policy, conditional, sendHeaders: conditional ? headers : req.headers };
  }

  async function storeFull(prep, res) {                     // 200/301/308/… completos (R13)
    const headers = normalizeCacheHeaders(res.headers);
    const decision = evaluateStorability(prep.snapshot, { status: res.status, headers }, res.body.length, prep.catCfg, now());
    if (decision.store) await store.write(prep.base, prep.snapshot.headers, { ...res, headers }, decision);
    else if (prep.cached && res.status < 500) await store.remove(prep.cached.location);
    return { ...res, cacheStatus: 'MISS' };
  }

  async function finalize(prep, res) {                       // F2 — nunca toca a rede; devolve diretiva
    if (res.status !== 304 || !prep.conditional) return { result: await storeFull(prep, res) };
    const resHeaders = normalizeCacheHeaders(res.headers);
    const { matches } = prep.policy.revalidatedPolicy(prep.snapshot, { status: 304, headers: resHeaders });
    const merged = mergeNotModifiedHeaders(prep.cached.meta.headers, resHeaders);
    if (!matches || !sameVaryNames(prep.cached.meta.headers, merged)) return { refetch: true };
    const decision = evaluateStorability(prep.snapshot, { status: prep.cached.meta.status, headers: merged },
                                         prep.cached.meta.bodyBytes, prep.catCfg, now());
    if (decision.store) await store.writeMetaOnly(prep.cached.location, prep.cached.meta, merged, decision);
    else await store.remove(prep.cached.location);
    return { result: toResult({ ...prep.cached, meta: { ...prep.cached.meta, headers: merged } }, 'REVALIDATED') };
  }

  function fallbackResult(prep, res) {                       // degradação de F2: nunca refaz a chamada
    if (res.status === 304 && prep.conditional) return toResult(prep.cached, 'REVALIDATED'); // sem regravar (D6)
    return { ...res, cacheStatus: 'MISS' };                  // 2xx/3xx/4xx/5xx como chegou, sem gravar
  }

  return async function cachedHop(req, deadline) {
    throwIfAborted(req);                                     // CanceledError, paridade axios
    let prep = null;
    try {
      prep = await prepare(req);
    } catch (error) {
      log.warnOnce('cache-prepare', error);                  // ex.: bug em keys.base → transporte direto, sem gravar
    }
    throwIfAborted(req);
    if (prep && prep.hit) return prep.hit;
    if (!prep) return { ...(await transport.send(req, deadline)), cacheStatus: 'MISS' };
    const res = await transport.send({ ...req, headers: prep.sendHeaders }, deadline); // erros de rede propagam (R13)
    let outcome;
    try {
      outcome = await finalize(prep, res);
    } catch (error) {
      log.warnOnce('cache-finalize', error);
      return fallbackResult(prep, res);
    }
    if (!outcome.refetch) return outcome.result;
    const full = await transport.send(req, deadline);      // única 2ª chamada: 304 sem correspondência (R12, I14)
    try {
      return await storeFull(prep, full);
    } catch (error) {
      log.warnOnce('cache-finalize', error);
      return { ...full, cacheStatus: 'MISS' };
    }
  };
}
```

- `toResult(cached, status)` devolve `{ status: meta.status, statusText: meta.statusText, headers: meta.headers, body: cached.body, url: meta.url, cacheStatus }`. Respostas servidas do cache sempre reportam o status **armazenado** (200/301/308), nunca 304. O axios também nunca entregou 304 como sucesso.
- `evaluateStorability(snapshot, { status, headers }, bodyBytes, catCfg, nowMs)` aplica R1–R3 e R4–R9 sobre cabeçalhos já normalizados. Devolve `{ store: false, reason }` ou `{ store: true, policy, varyNames, remainingMs, freshUntil, keyvTtlMs, validators, heuristic }`.
- As gravações são aguardadas ("grava no SQLite antes de responder", UC02), e cada uma é limitada por `opTimeoutMs` dentro do `store`.
- `throwIfAborted(req)` lança `canceledError(req)` se `req.signal?.aborted`.
- A rota de degradação de F1 (`prep = null`) não grava nada. As falhas previsíveis de leitura (registro corrompido, `fromObject` lançando) são tratadas dentro de `prepare`/`store.read` com remoção e permitem gravar a resposta nova (auto-correção).
- Se a requisição incondicional do R12 lançar erro de rede, ele propaga como sem cache: a entrada antiga é mantida e nada vencido é servido.

### 5.5 Formato persistido (versão de esquema 1)

São quatro tipos de registro no Keyv, no namespace `brasilapi-http`, com serializador explícito `JSON.stringify`/`JSON.parse`. Isso evita o reviver `:base64:` do `@keyv/serialize`.

```jsonc
// metadados da entrada — "<cat>:m:<baseHash>" (sem Vary) ou "<cat>:m:<baseHash>.<variantHash>"; Keyv ttl = keyvTtlMs (R9)
{ "v": 1, "kind": "entry", "pk": "<chave primária em texto>",
  "vary": { "names": ["accept-encoding"], "values": ["gzip, deflate, br"] },     // names: [] sem Vary
  "status": 200, "statusText": "OK",
  "headers": { /* resposta da origem: normalizeCacheHeaders + sanitizeStoredHeaders */ },
  "policy": { /* CachePolicy#toObject() */ }, "storedAt": 0, "freshUntil": 0,
  "validators": true, "heuristic": false, "bodyId": "<crypto.randomUUID()>", "bodyBytes": 1234, "url": "<URL do salto>" }
// índice de Vary — "<cat>:m:<baseHash>" quando a resposta tem Vary; SEM ttl no Keyv
{ "v": 1, "kind": "vary", "pk": "<chave primária>", "names": ["accept-encoding", "origin"] }
// corpo — "<cat>:b:<baseHash>" ou "<cat>:b:<baseHash>.<variantHash>"; SEM ttl no Keyv
{ "v": 1, "id": "<mesmo bodyId>", "b64": "<corpo bruto já descomprimido, em base64>" }
// sonda de escrita da inicialização — "_probe" (ttl 60 s, apagada logo em seguida)
```

**Corpo e cabeçalhos guardados:**

- O corpo guardado é o **byte bruto já descomprimido** (`decompress: true`). A decodificação (`json`/`text`/`buffer` e encoding) é aplicada a cada uso, então chamadas à mesma URL com `responseType` diferentes compartilham a entrada com segurança.
- `sanitizeStoredHeaders` remove dos `headers` guardados os hop-by-hop (`connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`) e `content-encoding`/`content-length`, porque o corpo guardado está decodificado. O `policy` é construído **antes** da sanitização. Nenhum call site lê cabeçalhos de resposta de provedor (verificado por busca em `services/ pages/api/ lib/ util/`).

**Leitura (`store.read`):**

1. `keyv.getMany([metaKey, bodyKey])` numa única query SQL (`json_each`; a ordem das chaves é preservada pelo adapter).
2. Rejeição (erro de SQLite, timeout, ou `SyntaxError` de JSON corrompido, porque o `getMany` do Keyv 5 não captura) devolve `null`. No caso de `SyntaxError`, remove meta e corpo (best-effort).
3. Metadados ausentes com corpo presente (o Keyv apaga metadados expirados na leitura e o corpo não tem TTL): remove o corpo (best-effort) e devolve `null`.
4. Registro base `kind: 'vary'`: valida o índice (`v`, `kind`, `pk`, `names` como array de strings). Inválido: remove índice e corpo base e devolve `null`. Válido: calcula a variante com os cabeçalhos atuais e faz um segundo `getMany`. Variante ausente: devolve `null`, removendo o corpo órfão da variante, se houver; o índice permanece.
5. Valida `v === 1`, `kind === 'entry'`, os tipos dos campos, `pk` igual ao calculado, `vary.values` iguais aos atuais e `Buffer.from(b64, 'base64').length === bodyBytes`. Se `body.id !== meta.bodyId` (escrita concorrente), devolve `null` sem remover. Qualquer outra inconsistência: `null` + remoção de meta e corpo (best-effort) + `console.warn`.

**Escrita completa (`store.write`):**

1. Gera um `bodyId` novo.
2. Grava o corpo (sem TTL) e **depois** os metadados (TTL R9). Se só o corpo for gravado, a leitura detecta o `bodyId` divergente e a entrada se corrige no próximo MISS.
3. Com `Vary`: corpo e metadados vão nas chaves da variante. O índice é regravado na chave base **sem TTL**, a cada escrita de variante. O corpo base `<cat>:b:<baseHash>` é removido (best-effort), cobrindo a conversão de "sem Vary" para "com Vary".
4. Sem `Vary` com índice existente: os metadados da entrada sobrescrevem o índice na chave base. As variantes antigas ficam inalcançáveis; os metadados delas expiram pelo TTL e os corpos ficam até o CLI (raro: a origem deixou de variar).

**304 (`store.writeMetaOnly`):** regrava só o registro de metadados (novos `headers`, `policy`, `storedAt`, `freshUntil`, `validators`, `heuristic`, com TTL R9). O corpo e o índice não são tocados (UC03 literal). Como o índice não tem TTL, uma variante revalidada continua alcançável (RN02).

**Remoção (`store.remove(location)`):** `keyv.deleteMany([metaKey, bodyKey])` da entrada. **Não** remove o índice de Vary, porque isso tornaria inalcançáveis as variantes irmãs ainda revalidáveis. Um índice sem a variante pedida resulta em MISS normal, e a próxima escrita o regrava. Índices só saem pelo CLI ou quando sobrescritos por uma entrada sem Vary.

**Crescimento:** é limitado pela cardinalidade de URLs. Os metadados expirados só são apagados pelo Keyv quando lidos, e corpos e índices de chaves nunca mais lidas ficam até o CLI. A opção `--expired` fica no backlog.

## 6. Decisão 3 — Composição da chave (RN04 / F02.3)

```
normalizedUrl = normalizeUrl(url)
  // WHATWG URL: esquema/host minúsculos, porta padrão removida, dot-segments resolvidos, fragmento removido;
  // query: segmentos crus separados por '&' (texto e codificação preservados, inclusive vazios),
  //        reordenados por ordenação ESTÁVEL pelo nome (texto antes do 1º '=', decodeURIComponent com
  //        fallback para o texto cru se a decodificação falhar). Nomes iguais mantêm a ordem original.
pk          = `${category}\nGET\n${normalizedUrl}`
baseHash    = sha256hex(pk)
variantHash = sha256hex(varyNames.map((n) => `${n}:${normalizeHeaderValue(outgoingHeaders[n])}`).join('\n'))
              // valor ausente => '' ; trim + colapso de espaços em branco internos (RFC 7234 §4.1)
metaKey     = `${category}:m:${baseHash}`  |  `${category}:m:${baseHash}.${variantHash}`
bodyKey     = `${category}:b:${baseHash}`  |  `${category}:b:${baseHash}.${variantHash}`
chave SQLite = `brasilapi-http:` + metaKey/bodyKey      // prefixo do namespace do Keyv (≤ 160 caracteres < keySize 255)
```

- A URL da chave é a URL final **depois** de aplicar `params` (§10.2). A requisição real sai na ordem original; só a chave é ordenada. A normalização só reordena e nunca recodifica, então duas URLs que diferem em algo além da ordem dos parâmetros nunca compartilham entrada. Uma diferença só de codificação percentual gera um MISS a mais, que é a direção segura.
- A chave cobre categoria + método + URL completa normalizada + cabeçalhos selecionados pelo `Vary`. O `pk` em texto fica gravado e é conferido na leitura, como proteção contra colisão ou bug.
- **Isolamento:** o que se armazena é a **resposta do provedor**, não a da rota. Duas rotas que pedem a mesma URL ao mesmo provedor na mesma categoria (ex.: `/api/banks/v1` e `/api/banks/v1/{code}`) recebem a mesma representação que receberiam da origem e aplicam suas próprias transformações depois. Nenhuma rota recebe a resposta pronta de outra, e categorias diferentes nunca compartilham entradas, mesmo para a mesma URL. Desvio literal do RN04 registrado em D2.
- **Nomes de categoria** são validados em `createConfig` com `/^[a-z][a-z0-9]*$/`: entram em chaves separadas por `:` e em padrões `LIKE` do CLI, onde `_` e `%` são curingas. Um nome inválido no JSON é erro de programação: `createConfig` lança, o que a quebra em qualquer teste que carregue a config. `getConfig()` captura, desliga o cache no processo e loga `console.error` uma vez, para não derrubar rotas em produção.

## 7. Decisão 4 — TTL por categoria (F03.1 / RN05)

### 7.1 Tabela única (`lib/http/cache/categories.json`, override `HTTP_CACHE_TTL_<CATEGORIA>` em segundos)

| Categoria | Env de override | TTL padrão | Provedor(es) | Justificativa |
|---|---|---|---|---|
| `banks` | `HTTP_CACHE_TTL_BANKS` | **604800 (7 d)** | BCB `ParticipantesSTR.csv`; Olinda `Sedes*` (4 URLs) | O F03.1 pede TTL **longo** para bancos. O cadastro STR muda raramente e o serviço já mantém cache em memória de 6 h. Hoje o valor só vale como teto: o BCB envia `private` e a Olinda `Expires: 0` sem validadores, então nada é gravado (§7.2, D4). |
| `cambio` | `HTTP_CACHE_TTL_CAMBIO` | 86400 (24 h) | Olinda PTAX `Moedas`, `CotacaoMoedaDia` | A rota recusa a data de hoje e datas futuras ("política de cache"); a cotação de dia passado é definitiva. 24 h limita correções eventuais da lista de moedas. |
| `cep` | `HTTP_CACHE_TTL_CEP` | 86400 | `opencep.com/v1/{cep}` | Endereços mudam raramente. 24 h (médio), somados aos 48 h da CDN da rota, limitam a defasagem. |
| `geocoding` | `HTTP_CACHE_TTL_GEOCODING` | 604800 | `photon.komoot.io`, `geocoding-api.open-meteo.com` | Coordenadas de logradouro e cidade são estáveis, e o cache reduz a carga em serviços com política de uso justo. |
| `cptec` | `HTTP_CACHE_TTL_CPTEC` | 604800 | CPTEC `listaCidades` | Catálogo de cidades praticamente estático. |
| `clima` | `HTTP_CACHE_TTL_CLIMA` | 1800 (30 min) | CPTEC `condicoesAtuais`, `previsao`, `7dias`, `previsaoLatLon`, `ondas` | O METAR é atualizado de hora em hora e as previsões algumas vezes ao dia; 30 min = metade do ciclo horário. |
| `cvm` | `HTTP_CACHE_TTL_CVM` | 86400 | `dados.cvm.gov.br` (`cad_intermed.zip`, `cad_fi.csv`) | A CVM publica diariamente. |
| `ddd` | `HTTP_CACHE_TTL_DDD` | 604800 | Anatel `PGCN.csv` | O plano de numeração muda raramente (arquivo de 2019). |
| `eleicoes` | `HTTP_CACHE_TTL_ELEICOES` | 21600 (6 h) | TSE `divulgacandcontas` | A situação das candidaturas muda durante campanhas; anos, eleições e cargos mudam raramente. 6 h equilibra os dois. |
| `fipe` | `HTTP_CACHE_TTL_FIPE` | 86400 | `parallelum.com.br/fipe/api/v1` (GETs de fallback) | A tabela FIPE é mensal. Os POSTs oficiais não são cacheáveis (R1). |
| `ibge` | `HTTP_CACHE_TTL_IBGE` | 604800 | `servicodados.ibge.gov.br` (localidades, agregados, CNAE), `educacao.dadosabertosbr.com` | Localidades e CNAE mudam raramente; a estimativa populacional é anual. |
| `ibpt` | `HTTP_CACHE_TTL_IBPT` | 86400 | `raw.githubusercontent.com/lucashpmelo/TabelaIBPTax` | As tabelas IBPT são semestrais. |
| `indices` | `HTTP_CACHE_TTL_INDICES` | 86400 | `api.bcb.gov.br` SGS (IGP-M) | Índice mensal. |
| `isbn` | `HTTP_CACHE_TTL_ISBN` | 604800 | Google Books, Open Library (2 GETs), Mercado Editorial | Metadados de livros são estáveis. |
| `ncm` | `HTTP_CACHE_TTL_NCM` | 86400 | `portalunico.siscomex.gov.br` (download JSON) | A NCM muda por resolução Camex com data de vigência; diário basta. |
| `registrobr` | `HTTP_CACHE_TTL_REGISTROBR` | 300 (5 min) | `registro.br/v2/ajax/avail/raw` | Disponibilidade de domínio é quase tempo real. |
| `solar` | `HTTP_CACHE_TTL_SOLAR` | 3600 (1 h) | `api.sunrise-sunset.org` | A resposta é do "dia atual" (UTC); 1 h limita a defasagem na virada do dia. |
| `b3` | `HTTP_CACHE_TTL_B3` | 86400 | `sistemaswebb3-listados.b3.com.br` | Listagens mudam no máximo diariamente. |
| `universities` | `HTTP_CACHE_TTL_UNIVERSITIES` | 604800 | `api.universities.com.br` | Cadastro estático. |

**Faixas:** "longo" = 7 d; "médio" = 24 h (6 h para eleições); "curto" = 5 min a 1 h. `ttlSeconds = 0` desliga a categoria (bypass, sem `X-Cache`). O TTL de categoria não altera o `Cache-Control` que o BrasilAPI devolve aos clientes (CDN, `middlewares/cache.js`). Sobre o RN05 ("reavaliado ao final de cada ciclo"): a cada revalidação ou refetch, o frescor é recalculado a partir dos cabeçalhos atuais e da configuração vigente.

**Rotas sem chamada externa, portanto fora do cache** (e por isso alguns agrupamentos sugeridos no enunciado não se aplicam):

- `feriados` calcula feriados com dados locais (o F03.1 cita "feriados" como exemplo de TTL longo, mas não existe resposta de provedor a guardar);
- `pix/v1/participants` lê um snapshot local gerado por `scripts/generate-pix-participants-snapshot.js`;
- `taxas` usa a biblioteca `selic`, com `https` nativo (exceção ao RN01, §8);
- `cpf`, `diasuteis`, `oms/cid10`, `tuss`, `status` e `hospitais` (exceto `proximos`).

O câmbio fica em "médio", e não em "curto", porque a rota só aceita datas passadas. A FIPE também fica em "médio", porque a tabela é mensal.

### 7.2 Comportamento efetivo observado (levantamento 2026-10-15/16; a decisão é tomada em runtime)

| Provedor | Cabeçalhos observados | Efeito com as regras |
|---|---|---|
| IBGE localidades | `max-age=2592000` | Explícito de 30 d com teto de 7 d: HIT. |
| IBGE CNAE | `max-age=1`, sem validadores | R8: não armazena. |
| opencep | `public, max-age=2678400`, ETag, Last-Modified | Explícito de 31 d com teto de 24 h; depois, 304 via ETag. |
| CVM corretoras / fundos | `public, max-age=14400`, `Age`, ETag, LM; fundos com 17,9 MB | Corretoras: 4 h − Age, depois 304. Fundos: excede 5 MiB e não armazena (padrão). |
| Anatel PGCN | `public, max-age=14400`, ETag, LM, `Vary: accept-encoding` | 4 h, depois 304; o Vary entra na chave e o índice sem TTL mantém a variante alcançável. |
| raw.githubusercontent (IBPT) | `max-age=300`, ETag, `Vary: Authorization,Accept-Encoding` | 5 min, depois 304 (demonstra UC03). |
| Siscomex NCM | 307 (`max-age=0`) para `?perfil=PUBLICO` 200 `public, max-age=3600` (3,1 MB) | O 307 é sempre buscado (pequeno); o alvo é armazenado por 1 h sob a sua própria URL (R16). |
| photon | `max-age=3600` | Explícito de 1 h. |
| open-meteo, parallelum, Open Library, B3, sunrise-sunset | sem cabeçalhos de frescor (alguns com `Vary: Origin/Accept-Encoding`) | Heurística = TTL da categoria. |
| BCB `ParticipantesSTR.csv` | `private, max-age=0`, ETag, LM | `private` em cache compartilhado: **não armazena** (o banks fica só com o cache em memória existente). |
| Olinda (Sedes, PTAX) | `Pragma: no-cache`, `Expires: 0`, sem validadores | Revalidação obrigatória sem validadores (R5 + R8): não armazena. |
| BCB SGS (IGP-M) | `public, max-age=900` + `private` | `private`: não armazena. |
| registro.br | `no-cache, no-store, must-revalidate` | `no-store`: não armazena. |
| minhareceita (CNPJ) | `max-age=86400`, `Vary: Accept-Encoding` | Não passa pelo cache, por decisão (Decisão 5). |
| CPTEC, TSE, Google Books, Mercado Editorial, universities | 403/429/timeout/DNS a partir do host do levantamento | Indeterminado; o motor RFC decide em runtime, com caixa normalizada (§5.2). |

Consequência explícita (D4): honrar a RFC (RN01, NF02.2) faz com que `banks`, `cambio`, `indices` e `registrobr` hoje não gerem entradas no SQLite. O exemplo de UC01 do PDF (`/api/banks/v1`) é demonstrado com outras rotas (ex.: `/api/ibge/uf/v1`, `/api/ddd/v1/62`, `/api/cvm/corretoras/v1`, `/api/ibpt/versao/v1`). As categorias continuam declaradas porque, se o provedor passar a permitir cache, o comportamento muda sozinho dentro do TTL definido.

### 7.3 Inventário completo das rotas de `pages/api`

| Rotas | Chamadas externas → categoria |
|---|---|
| `/api/banks/v1`, `/api/banks/v1/{code}` | BCB CSV + Olinda Sedes → `banks`; minhareceita → sem cache |
| `/api/cambio/v1/moedas`, `/api/cambio/v1/cotacao/{moeda}/{data}` | Olinda PTAX → `cambio` |
| `/api/cep/v1/{cep}` | opencep → `cep`; `update.opencep.com` → sem cache; cep-promise → exceção |
| `/api/cep/v2/{cep}` | idem v1 + photon/open-meteo → `geocoding` |
| `/api/cep/v3/{cep}` (micro-cors) | cep-promise → exceção; photon/open-meteo → `geocoding` |
| `/api/cnpj/v1/{cnpj}` | minhareceita → sem cache |
| `/api/cptec/v1/cidade`, `/api/cptec/v1/cidade/{name}` | CPTEC → `cptec` |
| `/api/cptec/v1/clima/aeroporto/{airport}`, `/clima/capital`, `/clima/previsao/{cityCode}`, `/clima/previsao/{cityCode}/{days}`, `/clima/previsao/semana/{lat}/{long}`, `/ondas/{cityCode}`, `/ondas/{cityCode}/{days}` | CPTEC → `clima` |
| `/api/cvm/corretoras/v1`, `/{cnpj}`, `/api/cvm/fundos/v1`, `/{cnpj}` | CVM → `cvm` |
| `/api/ddd/v1`, `/api/ddd/v1/{ddd}`, `/api/ddd/v2/{ddd}`, `/api/ddd/uf/v1/{uf}` | Anatel → `ddd` |
| `/api/eleicoes/anos-eleitorais`, `/ordinarias`, `/cargos-por-municipio`, `/candidaturas`, `/candidaturas/{candidato}` (handlers sem `app()`) | TSE → `eleicoes` |
| `/api/fipe/tabelas/v1`, `/marcas/v1`, `/marcas/v1/{vehicleType}`, `/veiculos/v1/{vehicleType}/{makerCode}`, `/anos/v1/{vehicleType}/{makerCode}/{modelCode}`, `/detalhes/v1/{vehicleType}/{makerCode}/{modelCode}/{yearCode}`, `/preco/v1/{fipeCode}` | FIPE POST → sem cache; parallelum GET → `fipe` |
| `/api/geolocation/v1` | bigdatacloud → sem cache |
| `/api/hospitais/v1/proximos` | opencep → `cep`; photon/open-meteo → `geocoding`; cep-promise → exceção |
| `/api/hospitais/v1`, `/ciatox`, `/estados`, `/opcoes`, `/cnes/{cnes}` | nenhuma (snapshot) |
| `/api/ibge/uf/v1`, `/uf/v1/{code}`, `/uf/v1/regiao/{regionCode}`, `/regioes/v1`, `/regioes/v1/{regionCode}`, `/cnae/v1/classes`, `/classes/{classe}`, `/divisoes/{divisao}`, `/grupos/{grupo}` | IBGE → `ibge` |
| `/api/ibge/municipios/v1/{uf}` | IBGE e dadosabertosbr → `ibge`; Wikipedia (wikijs) → exceção |
| `/api/ibpt/ncm/v1/{uf}`, `/{uf}/{codigo}`, `/nbs/v1/{uf}`, `/{uf}/{codigo}`, `/lc116/v1/{uf}`, `/{uf}/{codigo}`, `/versao/v1` | GitHub raw → `ibpt` |
| `/api/indices/igpm/v1`, `/intervalo`, `/ultimos` | BCB SGS → `indices` |
| `/api/isbn/v1/{isbn}` | CBL POST → sem cache; Google Books, Open Library, Mercado Editorial → `isbn` |
| `/api/ncm/v1`, `/api/ncm/v1/{code}` | Siscomex → `ncm` |
| `/api/registrobr/v1/{domain}` | registro.br → `registrobr` |
| `/api/solar/v1` | open-meteo → `geocoding`; sunrise-sunset → `solar` |
| `/api/taxas/v1`, `/api/taxas/v1/{sigla}` | lib `selic` (https nativo) → exceção |
| `/api/tickers/b3/acoes/v1`, `/api/tickers/b3/fundos/v1/{typeFund}` | B3 → `b3` |
| `/api/universities/v1`, `/api/universities/v1/{id}` (micro-cors) | universities → `universities` |
| `/api/cpf/v1/{cpf}`, `/api/diasuteis/v1`, `/api/feriados/v1`, `/api/feriados/v1/{ano}`, `/api/oms/cid10/v1`, `/{code}`, `/api/pix/v1/participants`, `/api/status/v1`, `/api/tuss/v1`, `/{tuss}`, `/autocomplete`, `/search` | nenhuma (dados locais/snapshot) |

### 7.4 Mapa `routes` do JSON (usado só pelo CLI, §12)

Prefixos de rota (casamento por segmento, o mais longo vence) → categorias que a rota usa:

```json
{
  "/api/banks/v1": ["banks"],            "/api/cambio/v1": ["cambio"],
  "/api/cep/v1": ["cep"],                "/api/cep/v2": ["cep", "geocoding"],      "/api/cep/v3": ["geocoding"],
  "/api/cptec/v1/cidade": ["cptec"],     "/api/cptec/v1/clima": ["clima"],         "/api/cptec/v1/ondas": ["clima"],
  "/api/cvm": ["cvm"],                   "/api/ddd": ["ddd"],                      "/api/eleicoes": ["eleicoes"],
  "/api/fipe": ["fipe"],                 "/api/hospitais/v1/proximos": ["cep", "geocoding"],
  "/api/ibge": ["ibge"],                 "/api/ibpt": ["ibpt"],                    "/api/indices": ["indices"],
  "/api/isbn/v1": ["isbn"],              "/api/ncm/v1": ["ncm"],                   "/api/registrobr/v1": ["registrobr"],
  "/api/solar/v1": ["geocoding", "solar"], "/api/tickers/b3": ["b3"],              "/api/universities/v1": ["universities"]
}
```

Rotas ausentes do mapa (CNPJ, geolocation, taxas e as de dados locais) não usam o cache.

## 8. Decisão 5 — O que é cacheável

**Passam pelo Got sem cache** (chamada sem a opção `cache`):

- **`minhareceita.org`** (CNPJ, também usado no enriquecimento de bancos). O #923 fixou um contrato testado em `tests/cnpj-contract.test.js`:
  - exatamente uma chamada ao provedor por requisição;
  - deadline total de 5 s via `AbortController`;
  - 5xx e falhas de transporte viram 503 sanitizado com `Cache-Control: no-store`;
  - 4xx são preservados.

  Manter a chamada fora do cache preserva esse contrato byte a byte e a semântica de "situação cadastral" consultada para compliance. A chamada continua com `{ timeout: PROVIDER_TIMEOUT_MS, signal: controller.signal }`, objeto de opções idêntico ao atual, e o novo cliente não faz retry. O provedor permite 24 h (`max-age=86400`); habilitar no futuro é acrescentar `cache: CACHE_CATEGORY.X` (backlog).
- **`update.opencep.com/{cep}`**: chamada de efeito colateral ("pede ao OpenCEP para atualizar"). Armazená-la suprimiria o efeito.
- **`api.bigdatacloud.net/data/reverse-geocode-client`** (`/api/geolocation/v1`): a coordenada informada pelo usuário é dado de localização pessoal (LGPD). Além disso, a cardinalidade (até 18 casas decimais) deixa a taxa de acerto praticamente nula e só incharia o SQLite.
- **Todos os `POST`** (FIPE oficial com `fallback`; CBL com `Api-Key`): R1 e R14.

**Exceções documentadas ao RN01** (bibliotecas de terceiros com HTTP próprio, sem ponto de injeção do cliente):

- `cep-promise@4.4.1` (`node-fetch`);
- `wikijs@6.4.0` (`cross-fetch`);
- `selic@1.1.0` (`https` nativo).

Os `scripts/generate-*.js` são ferramentas offline de snapshot executadas pelo GitHub Actions, não requisições do BrasilAPI em produção, e continuam com axios.

## 9. Decisão 6 — Configuração por variáveis de ambiente

| Variável | Tipo / faixa | Padrão | Falha de validação |
|---|---|---|---|
| `HTTP_CACHE_ENABLED` | `true`/`false`/`1`/`0` (sem diferença de caixa) | `false` se `NODE_ENV === 'test'`; senão `true` | usa o padrão + `console.warn` uma vez |
| `HTTP_CACHE_SQLITE_PATH` | caminho não vazio; relativo é resolvido contra `process.cwd()`; `:memory:` permitido | com `VERCEL` definido: `path.join(os.tmpdir(), 'brasilapi-http-cache.sqlite')`; senão `<cwd>/.cache/http-cache.sqlite` | string vazia → padrão + warn |
| `HTTP_CACHE_TTL_<CATEGORIA>` | inteiro decimal `0..31536000` (s) | tabela 7.1 | não inteiro, negativo ou acima do limite → padrão + warn |
| `HTTP_CACHE_STALE_RETENTION` | inteiro `0..31536000` (s) | `604800` (7 d) | padrão + warn |
| `HTTP_CACHE_MAX_ENTRY_BYTES` | inteiro `0..104857600` | `5242880` (5 MiB) | padrão + warn |
| `HTTP_CACHE_OP_TIMEOUT_MS` | inteiro `50..10000` | `1000` | padrão + warn |

**Constantes não sobrescrevíveis**, no bloco `defaults` do mesmo JSON, para manter um único lugar de ajuste:

- `minStoreFreshnessSeconds: 5`;
- `busyTimeoutMs: 250`;
- `breakerThreshold: 5`;
- `breakerCooldownMs: 300000`.

**Leitura e padrões:**

- A configuração é lida uma vez por processo (`getConfig()` memoizado em `globalThis`); mudar a env exige reiniciar. `createConfig(env)` é pura e testável. A leitura é sempre em runtime (o Next só embute `NEXT_PUBLIC_*`).
- **Por que desligado em `NODE_ENV=test`:** os testes de unidade do Vitest importam serviços no próprio processo, e um arquivo em disco compartilhado entre arquivos de teste os tornaria dependentes de ordem. Os E2E batem no `next dev` (`NODE_ENV=development`), onde o cache está ligado e é exercitado. A futura suíte da etapa 5 liga explicitamente com `HTTP_CACHE_ENABLED=true` + caminho temporário ou `:memory:`.
- **Por que 5 MiB:** o limite é de 256 MB por função (`vercel.json`), e uma entrada custa ~3,3× o seu tamanho em memória transitória (Buffer + base64 + envelope JSON). 5 MiB cobre NCM (3,1 MB), CNAE (0,76 MB), IBPT (~0,2 MB por UF) e corretoras (0,34 MB), e exclui `cad_fi.csv` (17,9 MB).

**`.gitignore`:** acrescentar, com comentário, `/.cache/http-cache.sqlite*` (o `*` cobre `-wal`, `-shm` e `-journal`). A pasta `.cache` já é ignorada pela regra existente; a linha explícita documenta a intenção.

**Limitação da Vercel:** o FS é somente leitura, exceto `/tmp`; por isso o padrão muda para `os.tmpdir()` quando `VERCEL` existe. O `/tmp` é por instância e efêmero: o cache não é compartilhado entre instâncias nem sobrevive a cold start. Portanto o RN03 ("sobreviver a reinicializações") só é plenamente atendido em processo de longa duração (`next dev`, `next start`, servidor próprio) (D10). Os mantenedores podem desligar com `HTTP_CACHE_ENABLED=false`. Se o caminho configurado não for gravável, a sonda de escrita desliga o cache (§10.1) e as rotas seguem iguais.

## 10. Decisão 7 — Resiliência e semântica HTTP

### 10.1 Singleton, inicialização e circuit breaker (`store.js`)

**Estado.** Fica em `globalThis[Symbol.for('brasilapi.http-cache.v1')] = { initPromise, keyv, sqlite, disabled, disabledReason, consecutiveFailures, openUntil, warned: Set }`. Sobrevive ao hot reload do `next dev` e é compartilhado por todos os bundles de rota (no Next 12, cada rota tem sua cópia do módulo). **Nenhum timer nem I/O na carga do módulo** (I13): o breaker usa carimbos de tempo, não `setTimeout`.

**Inicialização lazy** na primeira operação, num `initPromise` único:

1. Se o caminho não for `:memory:`, `fs.mkdirSync(path.dirname(p), { recursive: true })`.
2. `const [{ Keyv }, { KeyvSqlite }] = await Promise.all([import('keyv'), import('@keyv/sqlite')])`. O import é dinâmico para que uma falha ao carregar o binário nativo não derrube o carregamento da rota.
3. `const sqlite = new KeyvSqlite({ uri: 'sqlite://' + p, busyTimeout: busyTimeoutMs })`.
4. `const keyv = new Keyv({ store: sqlite, namespace: 'brasilapi-http', serialize: JSON.stringify, deserialize: JSON.parse, throwOnErrors: true })`. O construtor do Keyv 5.6.0 já registra `store.on('error', …)` no EventEmitter do KeyvSqlite e reemite no próprio `EventManager`, que não lança sem ouvintes. Registramos `keyv.on('error', () => {})` como **no-op documentado**: as falhas são tratadas só pelas rejeições de cada operação (`throwOnErrors`), sem log nem contagem duplicados.
5. **Na mesma volta síncrona dos passos 3–4, sem `await` entre eles**, chama-se `const probe = sqlite.query('SELECT 1')`. Isso anexa um tratador à promessa interna `connected` antes que a falha de abertura a rejeite, o que evita *unhandled rejection* (verificado na revisão). `await probe`: se falhar, a inicialização falha e o `code` é registrado (ex.: `SQLITE_CANTOPEN`).
6. `await sqlite.query('PRAGMA journal_mode=WAL')`. Se falhar, só `console.warn` uma vez e continua: em `:memory:` o retorno é `memory`.
7. **Sonda de escrita:** `await keyv.set('_probe', 1, 60000)` e `await keyv.delete('_probe')`. Se falhar (arquivo ou diretório somente leitura, `SQLITE_READONLY`), a inicialização falha. Nomes de categoria não começam com `_`, então não há colisão.

**Falha de inicialização.** O cache fica `disabled` até o fim do processo, com `console.error` **uma vez** com motivo e `code`, sem stack. Isso é ambiental (binário, caminho, permissão) e não se corrige sozinho; tentar a cada requisição só somaria latência e log.

**Inicialização lenta.** Cada operação faz `await withTimeout(ensureStore(), opTimeoutMs)`, e cada operação SQL também passa por `withTimeout(…, opTimeoutMs)`. O timer do `withTimeout` é sempre limpo no `finally`, então nenhum timer fica pendurado depois da operação (I13). Se a inicialização ainda não terminou, **essa** requisição segue como MISS sem cache e a inicialização continua em segundo plano.

**Circuit breaker com meia-abertura:**

- `breakerThreshold` (5) falhas **consecutivas** de operação (rejeição ou timeout de `read`/`write`/`writeMetaOnly`/`remove`) fazem `openUntil = now + breakerCooldownMs` (5 min), com `console.error` a cada abertura. Isso dá no máximo 12 por hora.
- Enquanto aberto, `isAvailable()` é `false` e as operações retornam imediatamente (null/void).
- Depois do cooldown, a próxima operação é tentativa (meia-abertura): sucesso fecha o circuito (contador 0, `console.warn` "cache reativado"); falha reabre imediatamente.
- Sucesso em estado fechado zera o contador. Registros corrompidos (§5.5) não contam como falha do store.

**Sem camada em memória** na frente do SQLite (I9): o SQLite é a única fonte, então a invalidação feita pelo CLI vale imediatamente para o servidor.

**Contingência (só se AC-01/AC-05 falharem por causa do `import()` dinâmico no webpack do Next 12):** carregar com `const { createRequire } = await import('module'); const load = createRequire(path.join(process.cwd(), 'package.json'));` e chamar `load('keyv')` / `load('@keyv/sqlite')` (builds CJS). O risco residual de tracing na Vercel fica registrado em §24.

### 10.2 Paridade de semântica HTTP com axios 1.8.3 (follow-redirects 1.15.11)

**Opções fixas do Got** (`got.extend` em `transport.js`):

- `throwHttpErrors: false`;
- `retry: { limit: 0 }` (o axios não faz retry; o Got 11 faria 2 em GET, e o teste do CNPJ exige exatamente 1 chamada);
- `followRedirect: false` (R16);
- `responseType: 'buffer'`;
- `decompress: true`;
- `http2: false`;
- `cache: undefined`;
- `timeout: timeout > 0 ? { socket: timeout } : undefined`.

| Aspecto | axios 1.8.3 hoje | Novo |
|---|---|---|
| Timeout antes dos cabeçalhos | O follow-redirects inicia um relógio de **parede** de N ms quando o socket é atribuído e só o limpa nos cabeçalhos da resposta **final**. Cobre DNS, connect, TLS, envio, espera e todos os saltos de redirect. Resultado: `AxiosError`, `code 'ECONNABORTED'`, `'timeout of Nms exceeded'`, sem `response`. | `createDeadline(N)`, cujo relógio começa no 1º envio de rede da chamada, é compartilhado por todos os saltos. Cada `send` arma `setTimeout(deadline.remaining())` e o desarma no evento `'response'` do Got (cabeçalhos). Restante ≤ 0 antes de enviar, ou disparo, faz `promise.cancel()` e lança `HttpClientError('timeout of Nms exceeded', { code: 'ECONNABORTED', request })`. **Medido (Node 20.20.2, N = 500):** connect sem resposta (`10.255.255.1`): axios 532 ms × novo 514 ms. Cabeçalhos gotejando a cada 100 ms: 526 × 516 ms. Para comparação, o Got `{ socket: 500, response: 500 }` sugerido na revisão levou **5028 ms** no connect, por isso essa alternativa foi rejeitada. Pelo código, nenhum dos dois é relógio de parede desde a atribuição do socket: `socket` usa `ClientRequest#setTimeout` (inatividade, que o Node só arma após o connect) e `response` começa só após o upload. |
| Inatividade depois dos cabeçalhos | `socket.setTimeout(N)` + `destroy` gera o evento `aborted`: `'stream has been aborted'`, `code 'ERR_BAD_RESPONSE'`, sem `response`. | Got `timeout.socket: N` gera `TimeoutError` (evento `socket`). Com cabeçalhos já recebidos vira `HttpClientError('stream has been aborted', { code: 'ERR_BAD_RESPONSE', request })`, sem `response`. **Medido:** corpo parado: axios 533 ms × Got 522 ms, mesmo erro. Corpo lento mas contínuo (1 byte a cada 100 ms por 1,5 s): 200 nos dois (1644 × 1632 ms). `TimeoutError` antes dos cabeçalhos é só salvaguarda (o prazo de parede dispara antes) e vira `ECONNABORTED`. |
| `timeout` 0 ou ausente | sem timeout | sem prazo e sem `timeout.socket` |
| Redirects | Segue qualquer 3xx (300–399) com `Location` não vazio, até 21 (o 22º redirect lança `ERR_FR_TOO_MANY_REDIRECTS`, `'Maximum number of redirects exceeded'`). 301/302 com POST viram GET; 303 com método diferente de GET/HEAD vira GET; nos dois casos o corpo é descartado e os cabeçalhos `content-*` removidos. 307/308 mantêm método e corpo. Remove `host`. Remove `authorization`, `proxy-authorization` e `cookie` se o protocolo mudar para algo diferente de `https:`, ou se o host mudar e não for subdomínio do atual. `Location` inválido ou protocolo diferente de http/https dá `ERR_FR_REDIRECTION_FAILURE`, `'Redirected request failed: <causa>'`. 3xx sem `Location` é resposta final (erro por status). | `redirects.js` aplica **exatamente** essas regras a todas as chamadas, com `new URL(location, urlAtual)`, `isSubdomain` idêntico ao do follow-redirects e as mesmas mensagens/códigos (`'Unsupported protocol ftp:'` como causa). O limite fixo é 21; não há opção `maxRedirects` (nenhum call site a usa). O corpo do 3xx intermediário é descartado. |
| Retry | nenhum | nenhum |
| Status | `validateStatus` 2xx. Fora disso: `message 'Request failed with status code N'`; `code` = `['ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE'][Math.floor(N / 100) - 4]` (undefined para 1xx/3xx/6xx); `response { status, statusText, headers, data }`, `status`, `request`. | Idêntico (`fromStatus`), com `response.data` decodificado no mesmo `responseType`. |
| `AbortSignal` | Já abortado ou abortado durante: `CanceledError`, `'canceled'`, `ERR_CANCELED`. | `throwIfAborted` antes de cada salto e depois da preparação do cache. Durante o envio, o listener `abort` (removido no `finally`) chama `promise.cancel()` e vira `HttpClientError('canceled', { code: 'ERR_CANCELED', name: 'CanceledError', request })`. Se o prazo e o abort concorrerem, vale o primeiro a marcar o motivo. |
| Erro de rede (ECONNRESET, ENOTFOUND, ECONNREFUSED, EAI_AGAIN, TLS…) | `AxiosError.from(err)`: mesmo `code` e `message` do Node, sem `response`, `request` presente. | `RequestError`/`ReadError` do Got viram o mesmo `code`/`message`, sem `response`, `request: { method, url }`, `cause` não enumerável. |
| `params` | Chaves com trim; valores `null`/`undefined` descartados; array plano vira `k[]=v` por elemento (ignorando null/undefined); `Date` vira ISO. Codificação: `encodeURIComponent` + restauração de `:`, `$`, `,`, `[`, `]`, e espaço vira `+`. Junta com `&`; anexa com `?` ou `&`; remove o fragmento. | `codec.buildUrl` reproduz isso literalmente. Objetos aninhados dão `TypeError` (nenhum call site usa). Única diferença: o `new URL` do Got codifica `'` como `%27` no query de esquemas especiais, enquanto o axios envia `'` cru; os servidores decodificam igual (D8). |
| Cabeçalhos padrão | `Accept: application/json, text/plain, */*`; `User-Agent: axios/1.8.3`; `Accept-Encoding: gzip, compress, deflate, br` | Mesmo `accept`; `user-agent: axios/1.8.3` (constante `LEGACY_DEFAULT_USER_AGENT`, para manter a impressão digital diante dos WAFs governamentais; D8); `accept-encoding: gzip, deflate, br` (o Got não decodifica `compress`, que é LZW obsoleto). Os cabeçalhos do call site sobrescrevem (nomes normalizados para minúsculas). |
| Corpo de POST | `URLSearchParams`: `toString()` + `content-type: application/x-www-form-urlencoded;charset=utf-8` se ausente. Objeto simples com `content-type` x-www-form-urlencoded: urlencoded (`{}` vira `''`). Outro objeto: JSON + `application/json`. `string`/`Buffer`: como estão. | Idêntico (`codec.encodeBody`). O `content-type` só é definido se ausente; o `FIPE_HEADERS` já o define sem charset e é mantido. |
| Decodificação | `arraybuffer` → `Buffer`. Outros → `toString(responseEncoding)`, removendo o BOM **só** se o encoding for ausente ou `'utf8'` (`'utf-8'` não remove). Sem `responseType`: `JSON.parse` silencioso se não vazio (falha devolve a string). `responseType` não-json (ex.: `'blob'`, `'application/xml'`) não tenta JSON. | `buffer` → `Buffer`. `text` → `toString(encoding)` com a mesma regra de BOM. `json` (padrão) = o comportamento padrão do axios (parse silencioso). `'binary'` é aceito (alias de `latin1`). |
| TLS e agente | `rejectUnauthorized` padrão (true); `globalAgent` (keep-alive no Node 20) | Iguais. Nenhum call site desativa TLS. |

### 10.3 Nome do erro e predicado

`name: 'AxiosError'` é mantido de propósito. O `errorHandler` devolve `{ message, type: 'internal_error', name: error.name }` em 500 não tratados (ex.: rotas IBGE quando o provedor dá 500), e mudar o `name` alteraria o corpo de erro público (NF03.1). O comentário no código explica que é nome legado de compatibilidade.

`isHttpClientError(e)` substitui `axios.isAxiosError` no CNPJ e em `indices/helpers`. Com isso o CNPJ continua igual:

- 5xx, transporte e abort viram `ServiceUnavailableError` (503 + `no-store` na rota);
- 400/404 viram `BadRequestError`/`NotFoundError` com `error.response.data.message`;
- 401/403/429/600 e erros de programação ou configuração são relançados intactos.

O `request` só existe em erros que tocaram a rede, como no axios.

O `errorHandler` loga `{ url, ...error }`. As propriedades enumeráveis do `HttpClientError` são só `name`, `code`, `request`, `response` e `status`: `isHttpClientError` fica no protótipo e `cause` é não enumerável. É menos do que o `AxiosError` expunha (`config`, `ClientRequest`).

## 11. Decisão 8 — Cabeçalho `X-Cache`: **implementado**

**Valores** (por requisição do cliente do BrasilAPI):

- `HIT`: o corpo foi servido do cache sem contato com a origem;
- `REVALIDATED`: 304 + corpo do cache;
- `MISS`: o corpo veio da origem, inclusive pelos caminhos de degradação, ou a chamada falhou depois de tentar a origem.

**Middleware.** `middlewares/cacheStatus.js` entra no `app()` depois de `cache(...)`:

1. cria `{ calls: [] }`;
2. substitui `response.writeHead` na instância por um wrapper que, antes de delegar com `original.apply(this, args)` (preservando todas as assinaturas), faz `setHeader('X-Cache', aggregate(calls))` se houver registros e o cabeçalho ainda não existir. O wrapper tem try/catch próprio e o `writeHead` original é sempre chamado;
3. `return runWithCacheContext(store, next)`.

O `next-connect@0.12.1` chama o handler dentro do `next()` e encadeia erros por promessa, então o contexto ALS cobre o handler e o `errorHandler` (verificado na revisão). O `res.end()` sem `writeHead` explícito chama `this.writeHead` via `_implicitHeader`, o que aciona o wrapper. O middleware não cria timers.

**Registro.** O `client.js` chama `recordCacheStatus` para toda chamada `get` com **categoria ativa**: cache habilitado, categoria conhecida com TTL > 0 e sem bypass do R14. O status da chamada agrega os saltos: algum `MISS` dá `MISS`; senão algum `REVALIDATED` dá `REVALIDATED`; senão `HIT`. Se a chamada lançar, registra `MISS`. Fora de um contexto ALS, ou sem categoria ativa, nada é registrado. Com o store desligado ou o breaker aberto, as chamadas com categoria registram `MISS`, o que é verdadeiro: o corpo veio da origem.

**Agregação por requisição:** a mesma regra (MISS > REVALIDATED > HIT). Sem registros, não há cabeçalho. Só contam chamadas concluídas antes do envio dos cabeçalhos (ex.: no ISBN, perdedores do `Promise.any` ainda em voo não contam).

**Onde não aparece:** nas rotas sem `app()`, que são `/api/eleicoes/*` (5), `/api/cep/v3/{cep}`, `/api/universities/v1` e `/{id}` (D7). Respostas servidas pela CDN carregam o `X-Cache` do momento em que a origem as gerou; a CDN tem seu próprio `x-vercel-cache`.

**Contrato.** O cabeçalho é aditivo: não altera URL, parâmetros nem JSON (NF03.1), e nenhum teste compara o conjunto completo de cabeçalhos (verificado por busca). A **documentação OpenAPI do `X-Cache` é obrigatória na etapa 7**, porque a convenção do projeto exige OpenAPI atualizado ao modificar endpoints. Fica registrada no documento de implementação e no backlog.

## 12. Decisão 9 — Invalidação manual em desenvolvimento (F03.3 / RN06): **CLI**

**Script.** `package.json`: `"cache:clear": "node scripts/cache-clear.js"`. Uso:

- `npm run cache:clear -- ibge`: uma categoria;
- `npm run cache:clear -- --route /api/cep/v2/01001000`: as categorias que a rota usa, pelo mapa da §7.4;
- `npm run cache:clear -- --all`: tudo.

O script é CommonJS, como os demais de `scripts/`. Lê `lib/http/cache/categories.json` por `require` no topo (namespace, categorias, mapa `routes`, nome do arquivo padrão). Carrega `keyv`/`@keyv/sqlite` por `import()` dinâmico dentro de `main()`, para respeitar o `global-require` e para que falha do binário nativo vire código 2.

**Ordem de execução:**

1. **Guarda RN06:** recusa com código 1 e mensagem citando RN06 se `NODE_ENV === 'production'`, `VERCEL_ENV === 'production'` ou `NEXT_PUBLIC_VERCEL_ENV === 'production'`. A guarda vem antes de qualquer acesso ao banco.
2. **Argumentos:** exatamente `<categoria>` presente no JSON, `--route <caminho>` ou `--all`; qualquer outra coisa imprime o uso e sai com código 1. `--route`: remove query e barra final e escolhe o prefixo mais longo `k` tal que `caminho === k` ou `caminho.startsWith(k + '/')`. Sem casamento, sai com código 1, listando que a rota não usa cache e os prefixos conhecidos. O mapa referenciar categoria inexistente também dá código 1 (erro de programação).
3. **Caminho:** aplica **a mesma regra de três ramos** da §9 (`HTTP_CACHE_SQLITE_PATH` → `VERCEL` ? `os.tmpdir()/brasilapi-http-cache.sqlite` → `<cwd>/.cache/http-cache.sqlite`) e **imprime o caminho absoluto resolvido** antes de agir. `:memory:` dá código 1. Arquivo inexistente: imprime "nada a limpar" e sai com 0, sem criar o banco. O CLI **não** lê `.env*` (o Next lê, o Node puro não). Se o servidor usar `HTTP_CACHE_SQLITE_PATH` de um `.env.local`, a variável precisa estar no ambiente do shell. O caminho impresso deixa a divergência visível, e o documento de implementação explica isso.
4. **Execução:**
   1. abre `new KeyvSqlite({ uri, busyTimeout: 2000 })`;
   2. para cada categoria-alvo, ou uma vez com `--all`, conta as linhas com `sqlite.query('SELECT COUNT(*) AS n FROM keyv WHERE key LIKE ?', pattern)` e executa `new Keyv({ store: sqlite, namespace }).clear()`, com `namespace = 'brasilapi-http:<categoria>'` ou `'brasilapi-http'` (`--all`). O `clear()` roda `DELETE … WHERE key LIKE '<namespace>:%'`, que casa exatamente com as chaves gravadas (nomes validados sem curingas, §6; todas as chaves são minúsculas). As categorias são processadas **em sequência**, numa cadeia de promessas com `reduce` (sem `await` em laço), cada uma com seu `new Keyv(...)` criado logo antes do próprio `clear()`. Em paralelo não daria, porque o construtor do Keyv sobrescreve `store.namespace`;
   3. imprime as linhas removidas por categoria e sai com 0;
   4. erro de SQLite ou de carregamento: mensagem em stderr e código 2.

**Granularidade:** categoria, a mesma do TTL. `--route` traduz rota em categorias: limpar `/api/cep/v2` limpa `cep` e `geocoding`, o que também afeta `/api/cep/v1`, `/v3`, `/api/hospitais/v1/proximos` e `/api/solar/v1` (D3). A invalidação por URL individual fica no backlog.

**Sem endpoint HTTP** de invalidação: não há nada a desabilitar em produção (I8).

## 13. Decisão 10 — `axios` no `package.json`: **permanece em `dependencies`**

Depois da etapa 2, a busca por `from 'axios'`/`require('axios')` em `pages/ services/ lib/ util/ middlewares/ errors/ app.js` deve retornar zero, inclusive no bloco comentado de `services/cptec/weather.js`, que passa a citar `httpClient.get`.

O axios continua necessário em `tests/**` (os E2E chamam o próprio BrasilAPI) e em `scripts/generate-*.js` (workflows de snapshot). Ele **fica em `dependencies`, versão 1.8.3, sem mudança**, porque a regra `import/no-extraneous-dependencies` do airbnb só libera devDependencies em `tests/**`/`*.test.js`. Movê-lo quebraria `npm run fix` (`eslint .`) nos três `scripts/generate-*.js` e, com isso, o hook husky/lint-staged (simulado na revisão: 3 erros).

Como nenhum código de produção o importa, o tracing do Next não o inclui nas funções e o custo em runtime é zero. Há precedente no próprio `package.json`: o `vite`, em `dependencies`, só é usado pelo `vite.config.js` dos testes.

## 14. API do cliente (`lib/http/client.js`)

```js
import httpClient from '@/lib/http/client';
import { CACHE_CATEGORY } from '@/lib/http/cache/categories';
import { isHttpClientError } from '@/lib/http/errors';

const response = await httpClient.get(url, {
  params,        // opcional: objeto simples; valores string|number|boolean|Date|null|undefined ou array plano deles
  headers,       // opcional: objeto simples; valores string|number (undefined descartado)
  timeout,       // opcional: inteiro 0..600000 ms (0 = sem timeout); semântica da §10.2
  signal,        // opcional: AbortSignal
  responseType,  // 'json' (padrão; = padrão do axios) | 'text' | 'buffer'
  encoding,      // opcional: qualquer Buffer.isEncoding (padrão 'utf8')
  cache,         // opcional: CACHE_CATEGORY.* ; ausente = sem cache
});
// => { status, statusText, headers, data, url, cacheStatus }   cacheStatus: 'HIT'|'MISS'|'REVALIDATED'|undefined
await httpClient.post(url, body, { headers, timeout, signal, responseType, encoding });
```

O export default é `{ get, post }`. Não existe `request` genérico (achado 10), nem `maxRedirects` (achado 16; fixo em 21).

**Validação** (a promessa rejeita com `TypeError` antes de qualquer I/O, sem embrulhar):

- `url` deve ser string absoluta http/https;
- opções desconhecidas (ex.: `responseEncoding`, `baseURL`, `maxRedirects`) são **rejeitadas**, para pegar resquícios da migração;
- tipos e faixas como acima;
- `body` só aceita `string`, `Buffer`, `URLSearchParams`, objeto simples ou `undefined`;
- `cache` com valor que não seja string dá `TypeError`.

**Exceção deliberada:** `cache` string desconhecida **não** lança. Gera `console.error` uma vez por nome e segue sem cache, porque um erro de digitação não pode derrubar rota em produção; as constantes `CACHE_CATEGORY` evitam o caso.

**Fluxo de `get`:**

1. Valida e monta `req` (`buildUrl` com `params`; cabeçalhos padrão + do call site).
2. Resolve a categoria ativa (`getConfig()`, R14).
3. `hop = categoria ativa ? cachedHop : transport.send`.
4. `result = await follow(req, hop)`; se lançar, registra `MISS` quando houver categoria ativa e relança.
5. Registra `result.cacheStatus`, já agregado pelo `follow`.
6. `data = decodeBody(...)`.
7. Status fora de 2xx: lança `fromStatus(...)`; senão, devolve a resposta.

O `post` faz o mesmo, sempre com `transport.send` como salto e sem registro.

## 15. Migração arquivo a arquivo (etapa 2 + marcação de categoria da etapa 3)

| Arquivo | Hoje | Depois |
|---|---|---|
| `util/getCsvAsJson.js` | `axios.get(url, { responseType: 'blob' })` | `getCsvAsJson(url, { cache } = {})` → `httpClient.get(url, { responseType: 'text', cache })` (utf8 com remoção de BOM, como o `'blob'` no Node) |
| `services/banco-central/index.js` | `getCsvAsJson(STR)`; `axios.get(sede, { timeout: 15000 })` | `getCsvAsJson(STR, { cache: BANKS })`; `httpClient.get(sede, { timeout: 15000, cache: BANKS })`. O cache em memória de 6 h fica intocado. |
| `services/cambio/moedas.js`, `cotacao.js` | `axios.get(url)` | `httpClient.get(url, { cache: CAMBIO })` |
| `services/cep/cep.js` | `fetchOpenCep`/`updateOpenCep` com `{ timeout }` | `fetchOpenCep`: `{ timeout: DEFAULT_TIMEOUT, cache: CEP }`; `updateOpenCep`: `{ timeout: DEFAULT_TIMEOUT }` (sem cache) |
| `services/cnpj.js` | `axios.get(url, { timeout, signal })`, `axios.isAxiosError` | `httpClient.get(url, { timeout: PROVIDER_TIMEOUT_MS, signal: controller.signal })` (objeto de opções idêntico, sem `cache`), `isHttpClientError`. O resto fica inalterado. |
| `services/cptec/cities.js` (2) | `responseType 'application/xml'`, `responseEncoding 'binary'` | `{ responseType: 'text', encoding: 'latin1', cache: CPTEC }` |
| `services/cptec/weather.js` (4 + comentário) | `'utf-8'` (capitais, aeroporto), `'binary'` (previsões) | `{ responseType: 'text', encoding: 'utf-8' \| 'latin1', cache: CLIMA }` (`'utf-8'` mantido literal: preserva a regra de BOM do axios) |
| `services/cptec/swell.js` | `'binary'` | `{ responseType: 'text', encoding: 'latin1', cache: CLIMA }` |
| `services/cvm/corretoras.js` | `responseType 'arraybuffer'` | `{ responseType: 'buffer', cache: CVM }` |
| `services/cvm/fundos.js` | `{ timeout: 3000, responseType: 'arraybuffer' }` | `{ timeout: 3000, responseType: 'buffer', cache: CVM }` |
| `services/dados-abertos-br/cities.js` | `axios.get(url)` | `{ cache: IBGE }` |
| `services/ddd.js` | `axios({ url, method: 'get', responseEncoding: 'binary' })` | `httpClient.get(url, { responseType: 'text', encoding: 'latin1', cache: DDD })` (o `.toString('binary')` posterior vira no-op sobre string) |
| `services/eleicoes/anos-eleitorais.js`, `ordinarias.js`, `cargos-por-municipio.js`, `candidaturas.js` (2) | `axios.get(url)` | `{ cache: ELEICOES }` |
| `services/fipe/http.js` | `axios.post(url, body, { headers: FIPE_HEADERS })` | `httpClient.post(url, body, { headers: FIPE_HEADERS })`. A detecção de HTML do Cloudflare (`typeof data === 'string'`) continua válida com o JSON silencioso. |
| `services/fipe/parallelum.js` (4) | `axios.get(url)` | `{ cache: FIPE }` |
| `services/ibge/cnae.js` (4), `services/ibge/gov.js` (7) | `axios.get(...)` (retornam o objeto de resposta) | `httpClient.get(url, { cache: IBGE })`. `{ data, status }` preservados; `getUfs`/`getUfByCode` continuam reatribuindo `response.data` (objeto novo a cada chamada). |
| `services/ibpt/index.js` | `axios.get(url)` | `{ cache: IBPT }` |
| `services/indices/helpers.js` | `axios.get(url, { params })`, `axios.isAxiosError` | `{ params, cache: INDICES }`, `isHttpClientError`. Manter o `return schema.validateAsync(...)` sem `await` (comportamento atual). |
| `services/isbn/cbl.js` | `axios.post(url, payload, { headers, timeout: 5000 })` | `httpClient.post(...)` com as mesmas opções |
| `services/isbn/googleBooks.js`, `mercadoEditorial.js`, `openLibrary.js` (2) | `axios.get(url, { params?, headers, timeout: 5000 })` | + `cache: ISBN` |
| `services/registro.js` | `return axios.get(url)` | `return httpClient.get(url, { cache: REGISTROBR })` (validação síncrona do domínio intocada; a rota usa `result.status`, que continua 200) |
| `services/sefaz/index.js` | `axios.get(url)` | `{ cache: NCM }` (fallback para `ncmList.json` intocado) |
| `services/solarIncidenceService.js` | geocoding `{ params, timeout: 10000 }`; sunrise `{ timeout: 10000 }` | + `cache: GEOCODING`; + `cache: SOLAR` |
| `services/tickers/listTickers.js` (2) | `axios.get(url)` | `{ cache: B3 }` |
| `services/universities.js` | `axios.create({ baseURL }).get(endpoint)` | `httpClient.get(\`${UNIVERSITIES_URL}${endpoint}\`, { cache: UNIVERSITIES })` |
| `pages/api/geolocation/v1/index.js` | `axios.get(\` \n https://… \n \`, { params })` | `httpClient.get('https://api.bigdatacloud.net/data/reverse-geocode-client', { params })` (mesma URL efetiva; sem cache; `language` repetido continua virando `localityLanguage[]=…`, achado 17) |
| `lib/fetchGeocoordinateFromBrazilLocation.js` | `fetch(url, { agent, headers: new Headers(...), signal: AbortSignal.timeout(2000) })` | `httpClient.get(url, { headers: { 'User-Agent': getRandomUserAgent() }, signal: AbortSignal.timeout(GEOCODING_TIMEOUT_MS), cache: GEOCODING })`. Qualquer erro dá `null`; `data` que não seja objeto dá `null`. Remover `getAgent`, porque o `fetch`/undici ignorava `agent` e era no-op. As URLs continuam montadas como hoje (`URLSearchParams`), então as asserções do teste sobre `calls[i][0]` seguem válidas. |

Os serviços importam `httpClient` por **default import** e chamam `httpClient.get/post` (necessário para `vi.spyOn(httpClient, 'get')`). Importam `CACHE_CATEGORY` de `@/lib/http/cache/categories` e `isHttpClientError`/`HttpClientError` de `@/lib/http/errors`.

## 16. Adaptação dos testes existentes (mantendo a intenção)

| Teste | Adaptação |
|---|---|
| `tests/cnpj-contract.test.js` | `import httpClient from '@/lib/http/client'` e `import { HttpClientError } from '@/lib/http/errors'`; `vi.spyOn(httpClient, 'get')`. `providerError(status, code)` → `new HttpClientError('Private provider error', { code, request: { method: 'GET', url: 'https://minhareceita.org/private' }, response: status ? { status, data: { message: 'Mensagem do provedor.' } } : undefined })`. `new axios.AxiosError('Invalid configuration', 'ERR_BAD_OPTION')` → `new HttpClientError('Invalid configuration', { code: 'ERR_BAD_OPTION' })`, sem `request`, e por isso continua relançado. `new axios.CanceledError('canceled')` → `new HttpClientError('canceled', { code: 'ERR_CANCELED', name: 'CanceledError' })`, **sem** `request`, como o original (o `CanceledError` do axios construído só com a mensagem também não tem `request`). Assim o teste continua exercitando o ramo `controller.signal.aborted` do serviço. **Todas** as asserções permanecem: status, corpos, `access-control-allow-origin`, `s-maxage=86400`, `no-store`, `toHaveBeenCalledExactlyOnceWith(url, { timeout: 5000, signal })`, `vi.getTimerCount() === 0` (I13) e timers. |
| `tests/cep-timeout.test.js` | `vi.mock('@/lib/http/client')` (automock) e `import httpClient from '@/lib/http/client'`; `httpClient.get.mockImplementation(...)` com a mesma lógica por URL. A asserção de < 4 s é mantida. |
| `tests/solarIncidence.test.js`, `tests/services/isbn/searchInMercadoEditorial.test.js` | `vi.mock('@/lib/http/client')`; `httpClient.get.mockResolvedValue(Once)(...)` / `mockRejectedValue(...)`. Asserções mantidas. |
| `tests/eleicoes/*.test.js` (8: `anos-eleitorais`, `anos-eleitorais-api`, `ordinarias`, `ordinarias-api`, `cargos-por-municipio`, `cargos-por-municipio-api`, `candidatos/candidatos`, `candidatos/candidaturas-api`) | `vi.mock('@/lib/http/client', () => ({ default: { get: vi.fn() } }))`; `vi.mocked(httpClient.get)`. A única asserção de argumentos exatos (`anos-eleitorais-api`) passa a `toHaveBeenCalledWith(url, { cache: 'eleicoes' })`: continua verificando a URL e agora também a categoria. |
| `tests/fetchGeocoordinateFromBrazilLocation.test.js` | `vi.spyOn(httpClient, 'get')` no lugar de `vi.spyOn(global, 'fetch')`; `createFetchResponse(data)` → `{ status: 200, data }` (o arquivo não tem casos `ok: false`). As asserções sobre `mock.calls[i][0]` e os resultados são mantidas. |
| `tests/ncm-contract.test.js` | **Nenhuma**: mocka `@/services/sefaz` e `@/app`, não o axios. |

Os demais testes (E2E via `axios` contra `SERVER_URL`) não mudam. Com o cache ligado no `next dev` do E2E, chamadas repetidas à mesma rota podem virar HIT; os dados são os mesmos que a origem daria dentro do frescor.

## 17. Tratamento de erros por operação

| Operação | Falha | Recuperável? | O chamador recebe | Log |
|---|---|---|---|---|
| Carregar config | env inválida | sim (padrão) | nada | `console.warn` 1× por variável |
| Carregar config | JSON inválido (nome de categoria, TTL fora de faixa) | cache: fatal no processo; requisição: sim | origem (sem `X-Cache`) | `console.error` 1× |
| Inicializar store | `mkdir` EROFS/EACCES, binário nativo ausente, `SELECT 1`, sonda de escrita | cache: fatal (desligado no processo); requisição: sim | origem (`MISS`) | `console.error` 1× com motivo e `code`, sem stack |
| Inicializar store | `PRAGMA journal_mode=WAL` | sim | nada | `console.warn` 1× |
| Inicialização lenta | > `opTimeoutMs` | sim | origem nesta requisição | nenhum |
| Leitura | erro SQLite / timeout | sim (+ breaker) | origem (`MISS`) | `console.warn` (1× por `code` por janela de breaker) |
| Entrada corrompida | JSON inválido, esquema ≠ 1, campos inválidos, `pk`/Vary divergentes, tamanho do corpo ≠ `bodyBytes`, `CachePolicy.fromObject` lança | sim | origem (`MISS`) e nova gravação; remoção best-effort | `console.warn` |
| Corpo com `id` divergente | escrita concorrente | sim | origem (`MISS`), sem remoção | nenhum |
| Metadados ausentes com corpo | expirado/órfão | sim | origem (`MISS`); corpo removido | nenhum |
| Exceção em F1 (`prepare`) | bug em keys/policy/orquestração | sim | transporte direto (`MISS`), sem gravar | `console.warn` 1× por tipo |
| Exceção em F2 (`finalize`) | bug em `revalidatedPolicy`/merge/`evaluateStorability` | sim | resposta já obtida (`MISS`); 304 condicional → corpo do cache (`REVALIDATED`) sem regravar; **nunca** nova chamada | `console.warn` 1× por tipo |
| Escrita / remoção | erro / timeout | sim (+ breaker) | resposta normal (dado da origem) | `console.warn` |
| Breaker | 5 falhas seguidas | cache: aberto por 5 min, depois meia-abertura | origem (`MISS`) | `console.error` a cada abertura; `console.warn` ao fechar |
| Transporte | rede / timeout / abort | não (para a chamada) | `HttpClientError` (§10.2) | nenhum no client (rotas/`errorHandler` logam como hoje) |
| Status não-2xx | 4xx/5xx | não | `HttpClientError` com `response`. No cache: < 500 remove a entrada, 5xx mantém | nenhum no client |
| Revalidação | rede / 5xx | não | erro propagado; entrada mantida; nada vencido é servido | nenhum |
| 304 sem correspondência | validador ou Vary divergem | sim | 1 requisição incondicional extra (única exceção, I14) | nenhum |
| Redirect | > 21 / `Location` inválido / protocolo não http(s) | não | `ERR_FR_TOO_MANY_REDIRECTS` / `ERR_FR_REDIRECTION_FAILURE` | nenhum |
| Opções inválidas | programação | não | `TypeError` (→ 500 pelo `errorHandler`) | pelo `errorHandler` |
| Categoria desconhecida | digitação | sim | resposta sem cache | `console.error` 1× por nome |
| Middleware `X-Cache` | exceção interna | sim | resposta sem o cabeçalho (o `writeHead` original é sempre chamado) | nenhum |
| CLI | produção / argumento inválido / rota sem cache / `:memory:` / SQLite ou binário | — | código 1 / 1 / 1 / 1 / 2 | stderr |

## 18. Validação de entradas externas

| Entrada | Regras | Em caso de falha |
|---|---|---|
| Variáveis `HTTP_CACHE_*` | §9 | padrão + warn |
| `categories.json` | `schemaVersion === 1`; nomes `/^[a-z][a-z0-9]*$/`; `ttlSeconds` inteiro `0..31536000`; `defaults` com inteiros nas faixas da §9 | `createConfig` lança; `getConfig` desliga o cache + `console.error` 1× |
| Opções do client | §14 | `TypeError` (exceto categoria desconhecida) |
| `Cache-Control`, `Pragma`, `Vary` | Valores normalizados para minúsculas antes de qualquer uso (§5.2); diretivas por presença; `max-age`/`s-maxage` só `/^\d+$/` e sem duplicata conflitante | frescor inválido = vencido (`lifetime = 0`) |
| `Expires`, `Age`, `Date`, `Last-Modified`, `ETag` | Interpretados por `http-cache-semantics` (inválidos tratados como ausentes ou vencidos; `Expires: 0` = vencido) | regra mais conservadora |
| `Vary` | split por vírgula, trim, dedupe, ordenado; `*` em qualquer posição | `*` → não armazena |
| `Location` | `new URL(location, base)`; só `http:`/`https:` | `ERR_FR_REDIRECTION_FAILURE` (paridade); ausente → resposta final |
| Corpo da origem | tamanho decodificado ≤ `maxEntryBytes`; leitura incompleta → erro do Got (não armazena) | não armazena |
| Registros lidos do SQLite | §5.5 passo 5 (`v`, `kind`, tipos, `pk`, Vary, `bodyId`, `bodyBytes`) | MISS + remoção best-effort |
| Argumentos do CLI | §12 | código 1 |
| Entradas das rotas | inalteradas (validadas pelos handlers atuais) | — |

## 19. Invariantes e responsável pela garantia

| # | Invariante | Responsável | Por quê ali |
|---|---|---|---|
| I1 | Só GET com categoria ativa e sem bypass (R14) passa pelo cache | `client.js` (roteamento) + `policy.evaluateStorability` (método, defesa em profundidade) | o client conhece método e categoria; a policy é a última barreira antes de gravar |
| I2 | Nunca servir resposta de outra (categoria, método, URL normalizada, valores de Vary) | `keys.js` (derivação; só reordena a query) + `store.read` (confere `pk` e Vary) | chave determinística + verificação no dado persistido |
| I3 | Frescor explícito nunca é estendido; inválido = vencido | `policy.computeFreshness` (`min`, `explicitFreshnessValid`) | regra pura, testável isoladamente |
| I4 | `no-store`/`private`/`Vary: *`/status fora de {200, 301, 308}/acima do limite nunca são gravados, **com diretivas comparadas sem diferença de caixa** (RFC 7234 §5.2) | `policy.normalizeCacheHeaders` + `evaluateStorability` (regras próprias e `storable()`) | ponto único de decisão de gravação |
| I5 | Conteúdo vencido nunca é servido sem um 304 em resposta a uma condicional montada com os validadores dessa entrada; no caminho normal, o 304 também precisa corresponder (R12) | `cachedHop` (único lugar que decide HIT/REVALIDATED) | a única exceção à correspondência é D6 |
| I6 | Falha de cache nunca falha a rota | `store.js` (timeout + try/catch, nunca rejeita) + `cachedHop` (F1 → transporte; F2 → resposta obtida) + `getConfig` | isola o I/O de disco e as regras do caminho de rede |
| I7 | Semântica de erro, timeout e redirect igual à do axios | `errors.js` + `transport.js` + `redirects.js` + status no `client.js` | um único mapeamento para todos os call sites |
| I8 | Invalidação manual nunca disponível em produção | `scripts/cache-clear.js` (guarda antes de abrir o banco) + inexistência de endpoint | só há uma superfície |
| I9 | Nenhuma camada em memória na frente do SQLite | `store.js` / `cachedHop.js` | invalidação do CLI vale imediatamente |
| I10 | Corpo só é escrito em resposta completa (200/301/308); 304 só regrava metadados | `cachedHop` + `store.writeMetaOnly` | UC03 |
| I11 | URIs com POST são disjuntas das URIs armazenadas | revisão de código (tabela 15) | torna o R15 não aplicável |
| I12 | O `Cache-Control` público das rotas não muda | `middlewares/cache.js` intocado | NF03.1 e CDN |
| I13 | Nenhum timer ou I/O na carga de módulo, no middleware ou com `httpClient.get` mockado | `store.js` (lazy, breaker por carimbo de tempo), `cacheStatus.js`, `cacheContext.js` | `tests/cnpj-contract.test.js` exige `vi.getTimerCount() === 0`; o `next build` não deve tocar disco |
| I14 | No máximo **uma** chamada de rede por salto, exceto a requisição incondicional após 304 sem correspondência | `cachedHop` (F2 devolve diretiva, nunca chama a rede; `fallbackResult` não refaz) | preserva "uma chamada por requisição" e o custo nos provedores |
| I15 | Credenciais de requisição nunca são persistidas | R14 (bypass) | o `toObject()` guarda cabeçalhos de requisição quando há Vary |

## 20. Casos de borda

- **Concorrência / stampede:** MISS simultâneos da mesma chave vão todos à origem (sem coalescência). A última escrita vence, e o `bodyId` evita mistura entre meta e corpo. A coalescência em memória fica no backlog.
- **Redirect + Vary + categoria:** cada salto usa a mesma categoria e é uma chave própria. O Siscomex (307) sempre busca o 307 e acerta o alvo. O CPTEC (301 http→https) pode ter o 301 armazenado. Um POST com 302 vira GET sem corpo (R16) e sem cache.
- **Prazo atravessando saltos:** o tempo gasto em redirects e numa eventual requisição incondicional pós-304 consome o mesmo prazo de N ms até os cabeçalhos finais, como no follow-redirects. HIT não consome prazo, e a leitura do cache não inicia o relógio (ele começa no 1º envio).
- **304 com cabeçalhos novos** (ex.: `Cache-Control` ausente antes): mesclados por *add-or-replace* e considerados no novo frescor. O merge do `revalidatedPolicy` só substitui campos já existentes, por isso fazemos o merge nós mesmos. `age` antigo é removido se o 304 não o trouxer.
- **`Set-Cookie` sem `public`:** sempre revalida (R5); sem validadores, não grava.
- **`Age` maior que o TTL heurístico:** `remaining = 0`, então só grava se houver validadores.
- **Diretivas com caixa mista** (`No-Store`, `Private`, `Max-Age=60`, `Pragma: No-Cache`): normalizadas antes de tudo (I4).
- **`max-age=`/`max-age=abc`/`max-age=60, max-age=120`:** frescor inválido; grava só se houver validadores, com `remaining = 0`.
- **`immutable` sem `max-age`:** tratado como heurístico (TTL da categoria ou 10 % do LM), sem o mínimo de 24 h da biblioteca.
- **Relógio:** `freshUntil` e o TTL do Keyv usam `Date.now()` (compatível com fake timers).
- **Respostas vazias:** `json` devolve `''` (axios); 204 não é armazenado.
- **Corpo > limite com entrada antiga:** a entrada antiga é removida (R13), evitando servir versão desatualizada.
- **`HTTP_CACHE_ENABLED=false`:** nenhum arquivo é criado, nenhum `X-Cache` é emitido, e o comportamento é o da migração Got pura.
- **Hot reload / vários bundles:** singleton em `globalThis`; um único `Database` do sqlite3 por processo.
- **CLI com o servidor rodando:** `busyTimeout` (250 ms no servidor, 2000 ms no CLI) + WAL. Um eventual `SQLITE_BUSY` no servidor vira MISS e conta no breaker; com meia-abertura, o cache volta sozinho.
- **Defasagem acumulada:** origem do BrasilAPI (≤ TTL da categoria) + CDN (`s-maxage` da rota). Os TTLs da tabela 7.1 consideram isso.
- **Rotas que reatribuem `response.data`** (IBGE): o objeto retornado é sempre novo, desserializado a cada uso.
- **Promise.any / allSettled** (ISBN, municípios, Sedes): o comportamento de corrida não muda; cada chamada decide seu cache sozinha.
- **Vary mudou entre respostas:** a escrita regrava o índice com os nomes novos; as variantes antigas ficam inalcançáveis até expirar ou até o CLI.

## 21. Testabilidade (a suíte em si é da etapa 5)

- **Unidade, sem rede nem disco:**
  - `keys.js`: normalização, ordenação estável, Vary;
  - `policy.js`: cada regra R1–R14 com respostas sintéticas, inclusive caixa mista e frescor inválido;
  - `config.js` via `createConfig(env)`;
  - `codec.js`: BOM, JSON silencioso, encodings, `params` com arrays e caracteres especiais, corpo de POST;
  - `redirects.js` com um `hop` stub (métodos, cabeçalhos removidos, limite 21, `Location` inválido);
  - `errors.js` e o mapeamento do `transport.js` com erros sintéticos do Got;
  - `cacheContext.aggregate`.
- **Unidade do orquestrador:** `createCachedHop({ store, transport, getConfig, now, log })` aceita store e transporte stub. Cobre HIT, MISS, REVALIDATED, 304 sem correspondência, F1/F2 lançando, R13 e I14 (contagem de chamadas ao transporte), sem rede.
- **Integração:**
  - `store.js` com SQLite real via `HTTP_CACHE_ENABLED=true` + `HTTP_CACHE_SQLITE_PATH` temporário ou `:memory:`;
  - falha de inicialização com caminho não gravável;
  - breaker com store falhando.
  - `transport.js` contra um servidor `net` local (cenários de timeout da §10.2).
- **E2E:** `next dev` + chamadas repetidas observando o `X-Cache` (MISS → HIT; REVALIDATED em IBPT com `HTTP_CACHE_TTL_IBPT` baixo).

## 22. Critérios de aceite verificáveis

Todos rodam sob o Node 20.20.2 portátil. Verificações ad hoc, como chamadas diretas a funções puras ou um servidor local descartável, são feitas fora do repositório ou apagadas ao final. Não constituem suíte nova.

1. **AC-01 (etapa 1, NF02.1):** `package.json` tem, em `dependencies` e sem `^`/`~`, exatamente `got 11.8.6`, `http-cache-semantics 4.3.0`, `keyv 5.6.0`, `@keyv/sqlite 4.0.8` e `sqlite3 5.1.7`. O `axios 1.8.3` continua em `dependencies`, inalterado. `npm ls` corresponde à §2. Sob Node 20.20.2 concluem:
   - `npm ci`;
   - `npx eslint pages/ services/ lib/ util/ middlewares/ errors/ --ext .js`;
   - `npx eslint . --ext .js` (o mesmo alvo do `npm run fix`, sem `--fix`, incluindo `scripts/cache-clear.js` e `scripts/generate-*.js`);
   - `next build`.
2. **AC-02 (RN01/F01.1):** a busca por `from 'axios'` e `require('axios')` em `pages/ services/ lib/ util/ middlewares/ errors/ app.js` retorna zero, e `fetch(` não aparece em `lib/fetchGeocoordinateFromBrazilLocation.js`. As únicas exceções restantes são cep-promise, wikijs, selic e `scripts/`.
3. **AC-03 (NF03.1):** os testes existentes, com as adaptações da §16, passam com `npm test`. `tests/cnpj-contract.test.js` mantém todas as asserções originais, inclusive `vi.getTimerCount() === 0`.
4. **AC-04 (I7):** um status 500 não tratado de provedor produz o mesmo corpo de antes: `{"message":"Request failed with status code 500","type":"internal_error","name":"AxiosError"}`.
5. **AC-05 (UC02/F02.2):** com `next dev`, a primeira chamada a `/api/ibge/uf/v1` responde `X-Cache: MISS` e cria `.cache/http-cache.sqlite`; a segunda responde `X-Cache: HIT` sem chamada ao IBGE.
6. **AC-06 (RN03):** depois de reiniciar o `next dev`, a mesma chamada responde `HIT`.
7. **AC-07 (UC03/F01.3/RN02):** com `HTTP_CACHE_TTL_IBPT=10`, `/api/ibpt/versao/v1` chamada após mais de 10 s responde `X-Cache: REVALIDATED`. O registro de corpo no SQLite não é regravado (mesmo `bodyId`, mesmo conteúdo da linha `…:b:…`), e o `freshUntil` dos metadados avança.
8. **AC-08 (F01.2/NF02.2, achado 1):** respostas com `no-store` (registro.br) ou `private` (BCB CSV) não geram linhas no SQLite. `evaluateStorability` devolve `store: false` para `Cache-Control: No-Store`, `Private, Max-Age=60` e `Pragma: No-Cache` sem validadores. Um `max-age` explícito menor que o TTL da categoria determina o `freshUntil`, e um maior é limitado pelo TTL. `max-age=abc` dá `lifetime = 0`.
9. **AC-09 (F02.3/RN04):** a chave contém categoria, método, URL normalizada e valores de `Vary`. Duas URLs que diferem só na ordem dos parâmetros compartilham a entrada; `?a=1&a=2` e `?a=2&a=1` não compartilham; a mesma URL em categorias diferentes não compartilha.
10. **AC-10 (F03.1/RN05):** todos os TTLs estão em `lib/http/cache/categories.json`, com `banks = 604800`. `HTTP_CACHE_TTL_IBGE=60` muda o frescor da categoria `ibge`. Um valor inválido mantém o padrão e loga um aviso.
11. **AC-11 (zero downtime):** com `HTTP_CACHE_SQLITE_PATH` apontando para um local não gravável, todas as rotas respondem com o mesmo status e corpo de sem cache, e há exatamente uma linha `console.error` de cache desligado.
12. **AC-12 (F03.3/RN06):**
    - `npm run cache:clear -- ibge` imprime o caminho absoluto e remove só as linhas `brasilapi-http:ibge:%`; a próxima chamada é `MISS`;
    - `npm run cache:clear -- --route /api/cep/v2/01001000` limpa `cep` e `geocoding`;
    - com `NODE_ENV=production`, o comando sai com código 1 sem abrir o banco.
13. **AC-13:** `middlewares/cache.js` inalterado; `Cache-Control` das rotas idêntico ao atual.
14. **AC-14:** o `.gitignore` contém a entrada do arquivo SQLite, e o `git status` não mostra arquivos de cache.
15. **AC-15 (achado 3):** com `timeout: 500`, `httpClient.get` rejeita com `code 'ECONNABORTED'` e `'timeout of 500ms exceeded'` em menos de 1000 ms quando:
    - o connect não recebe resposta (`http://10.255.255.1/`; neste host Windows o SYN fica sem resposta, verificado no design; num host em que esse endereço dê `EHOSTUNREACH` imediato, este item não se aplica);
    - um servidor `net` local aceita a conexão e nunca responde;
    - um servidor `net` local goteja cabeçalhos a cada 100 ms.

    Um servidor local que envia os cabeçalhos e depois para o corpo dá `code 'ERR_BAD_RESPONSE'` / `'stream has been aborted'`, sem `response`. Um corpo lento mas contínuo resolve 200.
16. **AC-16 (achado 4):** com um servidor local, um `httpClient.post` que recebe 302 segue como GET sem corpo e sem `content-type`, e um 307 mantém POST e corpo.
17. **AC-17 (achado 9):** `docs/HTTP_CACHE_GOT_KEYV.md` existe, com as 12 seções da §1 e os resultados reais de AC-01 a AC-16.

## 23. Rastreabilidade

| Requisito | Onde é atendido |
|---|---|
| F01.1 / RN01 | Decisão 1, §10.2, §14–15, AC-02, AC-15, AC-16 |
| F01.2 | §5.2–5.3 (R3–R10), §7.2, AC-08 |
| F01.3 / RN02 | R9, R11, R12, §5.5 (índice sem TTL), AC-07 |
| F02.1 / RN03 | §5.1(b), §5.5, §10.1, AC-05, AC-06 |
| F02.2 / NF01.2 | §2, §5.5, Decisão 6 |
| F02.3 / RN04 | Decisão 3, AC-09 |
| F03.1 / F03.2 / RN05 | Decisão 4, R6–R9, AC-10 |
| F03.3 / RN06 | Decisão 9, AC-12 |
| NF01.1 | HIT servido do SQLite local sem rede (medição na etapa 6) |
| NF02.1 | §2, P2, AC-01 |
| NF02.2 | §5.2–5.3 (caixa normalizada; nunca servir vencido sem 304; nunca estender frescor explícito) |
| NF03.1 | §10.2–10.3, §11, AC-03, AC-04, AC-13 |
| UC01 / UC02 / UC03 | §5.4; AC-05 / AC-05 / AC-07 |
| Pedido do usuário: "documento com todos os detalhes" | §1, AC-17 |

### 23.1 Desvios deliberados (leitura literal × decisão)

| # | Requisito | Leitura literal | Decisão e justificativa |
|---|---|---|---|
| D1 | F02.1 | "conectar o cliente Got ao Keyv" (a opção `cache` nativa do Got) | O Got continua sendo o cliente de todas as chamadas e o Keyv o gerenciador, mas a ligação é o nosso `cachedHop`. A opção nativa não cumpre F03.1, zero downtime, UC03 nem RN04 (§5.1). |
| D2 | RN04 | "chave composta pela rota e pelos parâmetros" | A chave é categoria + método + URL do **provedor** (com parâmetros) + Vary. O que se armazena é a resposta do provedor; cada rota aplica suas transformações, e categorias nunca compartilham entradas (§6). |
| D3 | F03.3 | "invalidar o cache de uma rota específica" | A granularidade é a categoria. `--route` traduz rota em categorias; limpar `/api/cep/v2` limpa `cep` + `geocoding` e afeta outras rotas dessas categorias (§12). |
| D4 | F03.1 / UC01 | "TTL longo para bancos"; exemplo `/api/banks/v1` | O TTL de `banks` é longo (7 d), mas o BCB (`private`) e a Olinda (`Expires: 0` sem validadores) proíbem armazenar. A RFC prevalece (RN01, NF02.2). UC01 é demonstrado com `/api/ibge/uf/v1`. O mesmo vale para `cambio`, `indices` e `registrobr`. |
| D5 | RFC 7234 §4.2.1 | o frescor explícito da origem vale integralmente | O TTL da categoria também serve de **teto** (mais estrito que a RFC, que permite a um cache reutilizar menos). |
| D6 | RFC 7234 §4.3.4 | 304 só atualiza a entrada selecionada por validador correspondente | No caminho normal, sim (R12). Só na degradação F2, quando a própria checagem lança, o corpo armazenado é servido para um 304 que respondeu à condicional montada com os validadores dessa entrada, **sem** atualizar metadados, e a próxima requisição revalida de novo. |
| D7 | eventual cabeçalho de origem da resposta | `X-Cache` em todas as rotas | Só nas rotas com `app()`; as 8 rotas com handler próprio ficam sem o cabeçalho (§11). |
| D8 | paridade de impressão digital | cabeçalhos idênticos aos do axios | `User-Agent: axios/1.8.3` é mantido; `Accept-Encoding` sem `compress`; `'` em `params` sai como `%27` (§10.2). |
| D9 | RN03 nos testes | cache sempre ativo | Desligado por padrão em `NODE_ENV=test` (processo do Vitest); ligado no `next dev` do E2E (§9). |
| D10 | RN03 na Vercel | sobreviver a reinicializações | O `/tmp` é efêmero e por instância; RN03 pleno só em processo de longa duração (§9). |

## 24. Riscos e pontos não verificados

- **Não verificado nesta etapa:**
  - `next build` e `next dev` com as novas dependências instaladas no repositório (cobertos por AC-01/AC-05);
  - o tracing do binário `.node` do sqlite3 e dos externals `module` pelo `@vercel/nft` num deploy Vercel (a contingência do §10.1 também tem esse risco);
  - os cabeçalhos de CPTEC, TSE, Google Books, Mercado Editorial e universities (bloqueados a partir do host do levantamento; decididos em runtime com caixa normalizada).
- **Verificado neste design (sandbox, Node 20.20.2):** a paridade de timeout nos cenários de connect, cabeçalhos gotejando, corpo parado e corpo lento contínuo (§10.2); o momento do evento `'response'` do Got 11; e os pontos do código citados em P7.
- **Got 11 sem manutenção ativa:** confinado a `transport.js`.
- **`sqlite3@5.1.7`** traz `tar@6`/`prebuild-install`, que geram avisos de instalação. O implementador registra `npm audit --omit=dev` antes e depois e reporta, no documento de implementação, os advisories novos introduzidos pela cadeia nativa.
- **Sem acesso ao GitHub Releases**, a instalação cai em `node-gyp rebuild`, que no Windows exige Python + build tools. Se o binário não carregar, o cache se desliga, mas o `npm ci` ainda precisa concluir.
- **`User-Agent: axios/1.8.3`** é mantido por compatibilidade com WAFs; trocá-lo é decisão a levar aos mantenedores na etapa 7.
- **Corpos e índices órfãos** crescem com a cardinalidade de URLs até o CLI (`--expired` no backlog).

## 25. Backlog (fora do escopo, com motivo)

- `stale-if-error`/`stale-while-revalidate` (servir vencido quando a origem cai): muda a semântica de erro atual e exige decisão de produto.
- Coalescência de requisições em voo: otimização para a etapa 6 (carga).
- Cache para CNPJ: preservar o contrato do #923 agora e reavaliar com os mantenedores.
- Invalidação por URL individual no CLI e limpeza de registros expirados não lidos (`--expired`).
- Armazenar 302/307 com frescor explícito; armazenar HEAD.
- **Etapa 7 (obrigatório):** documentar o `X-Cache` no OpenAPI (`pages/docs/doc/*.json`), atualizar `docs/ENDPOINT_GUIDE.md`/`CLAUDE.md` (os exemplos ainda mostram axios) e rediscutir o `User-Agent`.
- Etapa 5: suíte de testes da camada de cache. Etapa 6: benchmark com autocannon.
- Migrar para um Got ESM mais novo quando o projeto sair do Next 12 (afeta só `transport.js`).

## 26. Respostas à revisão (iteração 1 → 2)

| # | Sev. | Achado | Resposta | Onde |
|---|---|---|---|---|
| 1 | HIGH | `Cache-Control` comparado com diferença de caixa | **Corrigido.** `normalizeCacheHeaders` deixa `cache-control`, `pragma` e `vary` em minúsculas antes de todo `new CachePolicy` (MISS e 304 mesclado) e de todo parser próprio. R3 passa a ter checagens próprias de `no-store`/`private` além de `storable()`. Os cabeçalhos guardados já vão normalizados. O R14 independe de caixa (presença do cabeçalho). I4 e AC-08 ganham os casos `No-Store`/`Private`/`Pragma: No-Cache`. | §5.2, R3, R14, §5.5, I4, AC-08 |
| 2 | MEDIUM | Predicado explícito × heurístico indefinido | **Corrigido.** `parseDirectives`, `freshnessSource` (por presença, incluindo `Pragma: no-cache` sem `Cache-Control`) e `explicitFreshnessValid` (`/^\d+$/`, duplicata conflitante = inválido) definidos, mais a tabela de `computeFreshness`. Frescor inválido dá `lifetime = 0`. | §5.2, R4–R6, AC-08 |
| 3 | MEDIUM | Paridade de timeout errada | **Corrigido, com outra técnica.** A correção sugerida (`{ socket, response }`) foi **medida e rejeitada**: 5028 ms num connect sem resposta, contra 532 ms do axios. Nenhuma das duas fases do Got é relógio de parede desde a atribuição do socket. Adotado: prazo de parede próprio até os cabeçalhos finais, compartilhado entre saltos (`createDeadline` + evento `'response'` + `cancel()`), mais `timeout.socket` para inatividade após os cabeçalhos. Medido em quatro cenários, com o mesmo `code` e mensagem do axios; o `TimeoutError` após os cabeçalhos é mapeado para `'stream has been aborted'`/`ERR_BAD_RESPONSE`. | §10.2, §3.1, AC-15 |
| 4 | MEDIUM | `methodRewriting` não reproduz o axios | **Corrigido.** O Got fica sempre com `followRedirect: false`, e um seguidor único (`redirects.js`) aplica as regras do follow-redirects 1.15.11 a todas as chamadas: métodos, `content-*`, `host`, credenciais em troca de host/protocolo, limite 21 e erros `ERR_FR_*` com as mesmas mensagens. | R16, §10.2, AC-16 |
| 5 | MEDIUM | TTL do índice de Vary quebra o RN02 | **Corrigido.** O índice é gravado **sem TTL**, regravado a cada escrita de variante e não tocado no 304. `remove` não o apaga, para não tornar inalcançáveis as variantes irmãs (justificado); ele sai pelo CLI ou quando sobrescrito por uma entrada sem Vary. Índice presente com variante ausente dá MISS. | §5.5 |
| 6 | MEDIUM | Exceções fora do store sem degradação | **Corrigido.** `prepare` (F1, falha → transporte direto) e `finalize` (F2, falha → `fallbackResult` com a resposta já obtida; 304 condicional → corpo do cache sem regravar). F2 devolve diretiva e nunca chama a rede. A única 2ª chamada é a incondicional do 304 sem correspondência, cujos erros de rede propagam. Invariante I14 e desvio D6 registrados. | §5.4, §17, I5, I6, I14, D6 |
| 7 | MEDIUM | Axios em devDependencies quebra o lint | **Corrigido.** O axios 1.8.3 permanece em `dependencies`, e o comando `npm install --save-dev axios` foi removido. AC-01 inclui `npx eslint . --ext .js`. | §0, §2, §13, AC-01 |
| 8 | MEDIUM | TTL de `banks` contradiz o F03.1 | **Corrigido.** `banks = 604800`, com a justificativa citando o F03.1 e o efeito real (nada é gravado hoje, D4). Acrescentada a nota sobre `feriados`, `pix`, `taxas` e as demais rotas sem chamada externa. | §7.1, D4, AC-10 |
| 9 | MEDIUM | Documento de implementação fora do escopo | **Corrigido.** `docs/HTTP_CACHE_GOT_KEYV.md` está no escopo, com 12 seções obrigatórias e resultados reais, separado da etapa 7. | §1, AC-17 |
| 10 | NIT | `request` exportado sem assinatura | **Corrigido.** O export é só `{ get, post }`. | §3, §14 |
| 11 | NIT | Contratos não escritos | **Corrigido.** Assinaturas de `HttpClientError` (o `request` nunca é preenchido por padrão), `isHttpClientError` (no protótipo), `transport.send`/`createDeadline`, `follow`, store e `createCachedHop`. | §3.1 |
| 12 | NIT | Listener `'error'` impreciso | **Corrigido.** O construtor do Keyv já ouve o store; o nosso listener é no-op documentado, e as falhas são tratadas só pelas rejeições. | §10.1 passo 4 |
| 13 | NIT | Sonda ambígua | **Corrigido.** Sequência `SELECT 1` (falha desliga) → `PRAGMA` (falha só avisa) → sonda de escrita `_probe` obrigatória (falha desliga), com a regra de chamar `query` na mesma volta síncrona da construção. | §10.1 passos 5–7 |
| 14 | NIT | Breaker permanente | **Corrigido.** Meia-abertura após 5 min (`breakerCooldownMs`). Falha de inicialização continua permanente no processo (ambiental, justificado). | §10.1 |
| 15 | NIT | 304 mantém `Age` antigo | **Corrigido.** `age` armazenado é removido se o 304 não o trouxer. | R12, §20 |
| 16 | NIT | `maxRedirects: 0` difere do axios | **Resolvido por remoção.** Nenhum call site usa a opção; ela deixou de existir (opção desconhecida dá `TypeError`), e o limite fixo é 21 com a contagem exata do follow-redirects. | §14, §10.2 |
| 17 | NIT | `params` com array rejeitado | **Corrigido.** `buildUrl` reproduz o axios (`k[]=v`, null/undefined descartados, `Date` ISO, mesma codificação). A única diferença (`'` → `%27`) está documentada. | §10.2, §14, §15 (geolocation) |
| 18 | NIT | Corpos órfãos | **Corrigido.** Na leitura, metadados ausentes com corpo presente fazem o corpo ser removido (base e variante). `--expired` fica no backlog. | §5.5, §25 |
| 19 | NIT | CLI duplica a regra de caminho e ignora `.env*` | **Corrigido.** O CLI aplica a mesma regra de três ramos (com `VERCEL`), imprime o caminho absoluto resolvido e documenta que a variável precisa estar no shell. | §12 passo 3 |
| 20 | NIT | Nomes de categoria não validados | **Corrigido.** `/^[a-z][a-z0-9]*$/` em `createConfig` (lança); `getConfig` desliga o cache em vez de derrubar rotas. A justificativa da escolha (zero downtime) está no texto. | §6, §18 |
| 21 | NIT | Desvios não destacados | **Corrigido.** Nova §23.1 com D1–D10, e o mapa `routes` → categorias no JSON com `cache:clear -- --route`. | §23.1, §7.4, §12 |
| 22 | NIT | `npm ls` incompleto | **Corrigido.** Os dois aninhamentos de `keyv@4.5.4` (cacheable-request e flat-cache) foram conferidos com `npm ls keyv`. | §2 |
| 23 | NIT | Redação do R5 sobre `s-maxage` | **Corrigido.** O `s-maxage` define o tempo de vida (R4); só a revalidação obrigatória que ele implica importa para resposta vencida. | R5 |
| 24 | NIT | `X-Cache` sem OpenAPI | **Registrado.** Obrigatório na etapa 7 e citado no documento de implementação (§1 item 12). | §11, §25 |

Achados adicionais desta iteração, corrigidos sem constar na revisão:

- `immutableMinTimeToLive` da 4.3.0 mistura ms e s; ficou em `0` (§5.2).
- Credenciais de requisição não podem ir para o SQLite via `toObject()`: bypass no R14 e I15.
- Ausência de timers como invariante (I13), exigida pelo `vi.getTimerCount()` do teste do CNPJ.
- Cabeçalhos guardados sem `content-encoding`/`content-length`, porque o corpo é guardado decodificado (§5.5).

