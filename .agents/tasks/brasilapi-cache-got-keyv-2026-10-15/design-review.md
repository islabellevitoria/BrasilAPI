# Revisão de design — Cache HTTP persistente (Got + Keyv/@keyv/sqlite), etapas 1–4

**Veredito: CHANGES_REQUESTED** — 1 HIGH, 8 MEDIUM, 15 NIT.

O design é sólido e quase todas as premissas técnicas se confirmaram no código e em testes reais (versões, cadeia de dependências, externals do Next 12, Keyv/KeyvSqlite, http-cache-semantics, next-connect + ALS, CNPJ, CI). Os bloqueios são pontuais e têm correção direta:

- o parser de `Cache-Control` do http-cache-semantics diferencia maiúsculas e minúsculas, então `No-Store`/`Private` podem ser gravados (HIGH);
- falta o predicado exato que separa frescor explícito de heurístico;
- duas paridades com o axios estão erradas (timeout e reescrita de método em redirect de POST);
- o índice de Vary tem TTL que quebra o RN02;
- falta uma rota de degradação para exceções fora do store;
- mover o axios para devDependencies quebra o lint;
- o TTL de `banks` contradiz o F03.1;
- o documento de implementação pedido pelo usuário ficou fora do escopo.

## Como a revisão foi feita

- Li `design.md` inteiro, `requisitos-atividade-a2.md`, `.github/copilot-instructions.md` e `setup-report.md`.
- Li o código real: `package.json`, `app.js`, `middlewares/*`, os 33 arquivos com `axios` e `lib/fetchGeocoordinateFromBrazilLocation.js`, os 13 testes que mockam axios/fetch, workflows de CI, `.eslintrc.js` e as regras do airbnb, `next-connect@0.12.1`, `next@12.3.7` (`webpack-config.js` e o webpack 5 embutido em `bundle5.js`), `axios@1.8.3` e `follow-redirects@1.15.11`.
- Baixei com `npm pack` e li o código de `got@11.8.6`, `keyv@5.6.0`, `@keyv/sqlite@4.0.8` (e `3.6.7`), `http-cache-semantics@4.3.0`, `sqlite3@5.1.7` e `cacheable-request@7.0.4`. Também consultei `npm view` para `@keyv/sqlite@6.1.0`, `keyv@6.1.0` e `got@14`.
- Montei um sandbox temporário fora do repositório com Node 20.20.2 portátil e instalei a stack fixada. Lá rodei smoke tests de Keyv/KeyvSqlite (CJS e `import()` ESM, `getMany`, TTL, `clear` por namespace, caminho não gravável, linha corrompida), de Got 11 (`followRedirect: false`, `cancel()`) e uma comparação medida de timeout entre axios e Got. Também testei casos-limite do http-cache-semantics.
- Conferi os cabeçalhos de IBGE localidades, BCB `ParticipantesSTR.csv` e registro.br, e os binários prebuilt do sqlite3 (`win32-x64` e `linux-x64` responderam HTTP 200).
- Simulei o ESLint com o axios em devDependencies (via `packageDir` temporário).
- Nada no repositório foi alterado. O sandbox foi removido ao final.

## Achados

### 1. [HIGH] Diretivas de `Cache-Control` comparadas com diferença de caixa: `no-store`/`private` podem ser gravados (viola R3, I4 e NF02.2)

**Onde:** §5.2 R3, R5 e R6; §18 (linha `Cache-Control`); §19 I4.

**Problema:** o R3 delega a proibição de armazenar a `policy.storable()`. Só que o `parseCacheControl` do http-cache-semantics 4.3.0 faz `cc[k.trim()] = …` sem normalizar a caixa, enquanto a RFC 7234 §5.2 diz que diretivas são *case-insensitive*. Medido no sandbox:

- `Cache-Control: Private, Max-Age=60` → `storable() === true`;
- `Cache-Control: No-Store` → `storable() === true`, `maxAge() === 0`.

Pelo R6 (sem frescor explícito ⇒ `lifetime = ttlCategoria`), uma resposta `No-Store` sem `Last-Modified` vira HIT por até 7 dias. Uma resposta `Private` com ETag é gravada e reutilizada após 304. Os provedores levantados em §7.2 usam minúsculas, mas CPTEC, TSE, Google Books, Mercado Editorial e universities não foram levantados, e a decisão é tomada em runtime.

**Correção:** normalizar antes de qualquer `new CachePolicy(...)`, tanto no MISS quanto nos cabeçalhos mesclados do 304, e antes dos parsers próprios de `policy.js`:

```js
// lib/http/cache/policy.js
export function normalizeCacheHeaders(headers) {
  const out = { ...headers };
  if (typeof out['cache-control'] === 'string') out['cache-control'] = out['cache-control'].toLowerCase();
  if (typeof out.pragma === 'string') out.pragma = out.pragma.toLowerCase();
  return out;
}
```

Aplicar também aos cabeçalhos de saída no R14 e guardar os cabeçalhos já normalizados no registro. Acrescentar ao I4 "diretivas comparadas sem diferença de caixa (RFC 7234 §5.2)". Incluir em AC-08 um caso com `Cache-Control: No-Store`.

### 2. [MEDIUM] Fronteira entre frescor explícito e heurístico (R4/R5/R6) não está definida com precisão

**Onde:** §5.2 R4–R6; §3 (`policy.js`, `computeFreshness`); I3.

**Problema:** `_hasExplicitExpiration()` é privado e a regra `no-underscore-dangle` proíbe usá-lo, então o `policy.js` precisa de um predicado próprio. O design não o define. Três casos concretos ficam abertos:

- (a) `Pragma: no-cache` sem `Cache-Control`: o http-cache-semantics trata como `no-cache` (verificado: `maxAge() === 0`), mas o caso não está na lista do R5. Pelo R6 a resposta ganharia `ttlCategoria`.
- (b) Valores inválidos ou vazios, como `max-age=abc` e `max-age=`: presença da diretiva e valor verdadeiro divergem. Verificado: `max-age=` + `Last-Modified` de 10 dias atrás dá `maxAge() === 86400` pela heurística de LM. A RFC 7234 §4.2.1 encoraja tratar frescor inválido como vencido.
- (c) Diretivas repetidas com valores conflitantes.

**Correção:** especificar o predicado, usando o parse sem diferença de caixa do achado 1:

```js
// cc = Cache-Control normalizado e parseado; "presença" = nome da diretiva presente
export function freshnessSource(h, cc) {
  const revalidate = 'no-cache' in cc
    || (h['cache-control'] === undefined && /no-cache/.test(h.pragma || ''))
    || 'proxy-revalidate' in cc
    || (h['set-cookie'] !== undefined && !('public' in cc) && !('immutable' in cc));
  if (revalidate) return 'revalidate';                                    // lifetime = 0 (R5)
  if ('s-maxage' in cc || 'max-age' in cc || h.expires !== undefined) return 'explicit'; // R4
  return 'heuristic';                                                     // R6
}
// 'explicit' com valor que não casa /^\d+$/, ou diretiva repetida com valores diferentes ⇒ lifetime = 0.
// 'explicit' válido ⇒ lifetime = min(policy.maxAge() * 1000, ttlCategoria).
```

### 3. [MEDIUM] A paridade de timeout com o axios está errada: follow-redirects usa relógio de parede até os cabeçalhos

**Onde:** §10.2 (linha "Timeout"); §14 (`timeout: … inatividade de socket`); I7.

**Problema:** o axios 1.8.3 usa follow-redirects 1.15.11 sempre que `maxRedirects !== 0` (`lib/adapters/http.js` l. 440–449). O `RedirectableRequest#setTimeout` (follow-redirects l. 205–265) inicia um `setTimeout` de parede quando o socket é atribuído e só o limpa no evento `response`, isto é, nos cabeçalhos da resposta final. Por cima disso aplica o timeout de inatividade do socket. O `timeout.socket` do Got é só inatividade.

Medido em Node 20 contra um servidor local que envia os cabeçalhos aos poucos, sem nunca ficar 100 ms parado:

| Cliente | Resultado |
|---|---|
| axios `timeout: 500` | `ECONNABORTED` em 531 ms |
| Got `{ socket: 500 }` | 200 em 1650 ms |

Um provedor lento que "goteja" seguraria a rota até o limite de 10 s da Vercel, em vez de cair no fallback (CEP 3 s → cep-promise; ISBN 5 s).

**Correção:** usar `timeout: { socket: N, response: N }` no Got. Medido:

| Cenário | Got `{ socket: 500, response: 500 }` | axios |
|---|---|---|
| Cabeçalhos gotejando | `ETIMEDOUT` em 515 ms | timeout em ~530 ms |
| Corpo lento após os cabeçalhos | 200 | 200 |

Mapear `TimeoutError` antes dos cabeçalhos (eventos `socket` ou `response`) para `code: 'ECONNABORTED'` com a mensagem `timeout of Nms exceeded`. Depois dos cabeçalhos, o erro sai sem `response` (o CNPJ continua indo para 503). Corrigir no texto a frase "mesmo mecanismo".

### 4. [MEDIUM] `methodRewriting: true` no Got 11.8.6 não reproduz o axios em POST com 301/302

**Onde:** §10.2 (opções do Got: `methodRewriting: true`); R16 (chamadas sem cache seguem redirect pelo Got); Decisão 1.

**Problema:** no Got 11.8.6 (`dist/source/core/index.js` l. 841–842), com `methodRewriting: true` só o 303 vira GET. Um POST que recebe 301/302 é reenviado como POST, com corpo. O follow-redirects (axios, l. 442–448) troca POST→GET em 301/302 e qualquer método não GET/HEAD→GET em 303, removendo os cabeçalhos `content-*`. Já `methodRewriting: false` no 11.8.6 troca tudo para GET, inclusive 307/308. Nenhuma das duas opções dá paridade. Os afetados são os POSTs de FIPE (`fipePost` → fallback parallelum) e CBL.

**Correção:** usar um único seguidor de redirects, o recursivo do R16, para todas as chamadas, com o Got sempre em `followRedirect: false`, seguindo as regras do follow-redirects:

- 301/302 com POST → GET, sem corpo e sem cabeçalhos `content-*`; 303 com método não GET/HEAD → GET, idem; 307/308 mantêm método e corpo;
- salto para outro host remove `authorization`, `cookie` e `proxy-authorization`;
- só GET com categoria consulta ou grava cache em cada salto.

Isso também elimina o mapeamento duplicado do `ERR_TOO_MANY_REDIRECTS` do Got para `ERR_FR_TOO_MANY_REDIRECTS`.

### 5. [MEDIUM] O ciclo de vida do índice de Vary quebra o RN02 nos provedores que enviam `Vary`

**Onde:** §5.4 (registro `kind: "vary"`, "mesmo Keyv ttl da última variante gravada"); `store.writeMetaOnly` em §5.3.

**Problema:**

- (a) O 304 regrava só os metadados da variante. O índice fica com o TTL da escrita original e expira em `remaining + staleRetention`. A partir daí a variante, que ainda podia ser revalidada, fica inalcançável: vira MISS completo sem requisição condicional (viola RN02) e deixa meta e corpo órfãos. Afeta Anatel PGCN, IBPT e open-meteo, que mandam `Vary` (§7.2).
- (b) Uma variante nova com TTL menor encurta o índice das outras variantes.

**Correção:** gravar o índice de Vary **sem TTL** no Keyv, como já acontece com o corpo. Ele é regravado a cada `write` de variante e removido junto com a entrada (`remove`) e pelo CLI. Na leitura, índice presente com variante ausente ⇒ MISS normal.

### 6. [MEDIUM] Falhas fora do store (policy, keys, orquestração) não têm rota de degradação definida

**Onde:** §5.3 (algoritmo sem `try/catch`); I6 ("cachedFetch cai para o transporte"); §17 (linha "`CachePolicy.fromObject` lança").

**Problema:** o requisito é degradar para a origem em **qualquer** falha de cache. O §5.3 não protege as chamadas a `keys.base`, `CachePolicy.fromObject`, `policy.revalidationHeaders`, `revalidatedPolicy`, `mergeNotModifiedHeaders` e `evaluateStorability`: uma exceção em qualquer delas propaga e vira 500. Também falta a regra que impede uma segunda chamada à origem quando a exceção ocorre depois que a resposta já chegou, o que quebraria a garantia de uma chamada por requisição.

**Correção:** separar a fase de preparação da fase de finalização:

```js
async function fetchHop(req) {
  throwIfAborted(req.signal);
  let prep;
  try {
    prep = await prepareFromCache(req); // chave, leitura, fromObject, cabeçalhos condicionais
  } catch (error) {
    warnOnce('cache-prepare', error);   // remoção best-effort da entrada, se houver
    const res = await transport.send({ ...req, followRedirect: false });
    return { ...res, cacheStatus: 'MISS' };
  }
  if (prep.hit) return prep.hit;
  const res = await transport.send(prep.request); // erros de rede propagam como hoje
  try {
    return await finalizeWithCache(req, prep, res); // 304, merge, avaliação, gravação
  } catch (error) {
    warnOnce('cache-finalize', error);
    return fallbackResult(res, prep); // nunca refaz a chamada
  }
}
```

Regras do `fallbackResult`:

- 200/301/308 → devolve `res` como MISS, sem gravar;
- 304 → devolve o corpo já lido em `prep` como REVALIDATED, sem regravar;
- só se o corpo em cache for inutilizável é feita **uma** requisição incondicional. Documentar isso como a única exceção.

### 7. [MEDIUM] Mover o axios para devDependencies quebra o lint de `scripts/` e o hook de pre-commit

**Onde:** Decisão 10 (§13); §2 (tabela e comando de instalação); AC-01.

**Problema:** a regra `import/no-extraneous-dependencies` do airbnb só libera devDependencies em `tests/**`, `**/*.test.js` e afins. `scripts/**` não está na lista, e os três `scripts/generate-*.js` fazem `require('axios')`. A simulação deu 3 erros (`'axios' should be listed in the project's dependencies, not devDependencies`). O CI não pega, porque o ESLint dele só roda em `pages/ services/ lib/ util/ middlewares/ errors/`. Mas `npm run fix` roda `eslint .`, e o hook husky (`npm run precommit` → `lint-staged` → `npm run fix`) passaria a falhar em todo commit que tocar JS.

**Correção (escolha):** manter `axios 1.8.3` em `dependencies`. Nenhum código de produção o importa (AC-02 garante), então o nft não o empacota e o custo em runtime é zero. Atualizar §0, §2 (remover `npm install --save-dev --save-exact axios@1.8.3`), §13 e AC-01.

### 8. [MEDIUM] O TTL de `banks` contradiz o F03.1

**Onde:** §7.1 (`banks` = 86400, faixa "médio").

**Problema:** o F03.1 diz "TTL longo para bancos e feriados". O design define "longo" = 7 d, coloca `banks` em "médio" e não registra o desvio. A tabela também não explica que `feriados` não tem chamada externa (§7.3).

**Correção:** `banks` = `604800` (7 d), com a justificativa "F03.1 pede TTL longo; o valor só vale quando a origem permite cache (hoje o BCB envia `private` e a Olinda `Expires: 0`, então nada é gravado)". Abaixo da tabela, acrescentar: "`feriados`: dados locais, sem chamada externa, fora do cache".

### 9. [MEDIUM] O documento de implementação pedido pelo usuário não está no escopo

**Onde:** §1 ("Fora do escopo: … etapa 7 (documentação técnica …)").

**Problema:** a mensagem do usuário pede "Gere um documento com todos os detalhes da implementação, e altere o código". O design não lista esse documento como entregável e ainda coloca "documentação técnica" fora do escopo. Um implementador pode ler isso como "não documentar".

**Correção:** em §1, em "Dentro do escopo", incluir: "Documento de implementação em `docs/cache-http-got-keyv.md`", ou outro caminho fixo, desde que declarado. Conteúdo:

- dependências e versões, com a justificativa;
- módulos e arquitetura;
- regras R1–R16;
- tabela de TTL e variáveis de ambiente;
- `X-Cache` e o CLI;
- mudanças arquivo a arquivo e testes adaptados;
- resultados de build, lint e testes sob Node 20;
- desvios deliberados e riscos.

Separar isso da etapa 7, que fica com OpenAPI, `ENDPOINT_GUIDE.md`/`CLAUDE.md` e PR.

### 10. [NIT] `httpClient.request` é exportado mas não tem assinatura

**Onde:** §3 (`export default { get, post, request }`) e §14.

**Correção:** remover `request` do export, já que nenhum call site precisa dele (`services/ddd.js` migra para `get`).

### 11. [NIT] Contratos citados mas não escritos: construtor de `HttpClientError`, `isHttpClientError` e interface do store

**Onde:** §3, §10.2, §16 e §5.3 (`cached.location`, `store.read/write/writeMetaOnly/remove`).

**Correção:** acrescentar:

```js
class HttpClientError extends Error {
  // opts: { code?, request?, response?: { status, statusText?, headers?, data }, name? = 'AxiosError', cause? }
  // status = response?.status; isHttpClientError = true; cause não enumerável
}
export const isHttpClientError = (e) => e?.isHttpClientError === true;
// store.read(base, reqHeaders) -> null | { meta, body: Buffer, location: { metaKey, bodyKey } }
// store.write(base, reqHeaders, res, decision) / writeMetaOnly(location, meta, headers, decision) / remove(location) -> Promise<void> (nunca rejeitam)
```

### 12. [NIT] A justificativa do listener `'error'` do Keyv está imprecisa e o handler não está definido

**Onde:** §10.1.

**Problema:** o construtor do Keyv 5.6.0 já registra `store.on('error', …)` no EventEmitter do KeyvSqlite, e o `EventManager` do Keyv não lança quando não há listener. Com `throwOnErrors`, `set` e `delete` emitem `'error'` **e** rejeitam. Logar nos dois lugares duplica o log e pode contar a mesma falha duas vezes no breaker.

**Correção:** o handler é no-op. As falhas são tratadas só pelas rejeições de cada operação.

### 13. [NIT] A sonda de inicialização é ambígua

**Onde:** §10.1 ("falha do PRAGMA em si é tolerada; rejeição por conexão desliga").

**Problema:** as duas falhas chegam pela mesma rejeição de `store.query`. Além disso, um arquivo somente leitura abre em modo leitura: as leituras zeram o contador do breaker e cada escrita só gera um warn.

**Correção:** primeiro `await store.query('SELECT 1')` (falha ⇒ desliga, `code` registrado), depois o PRAGMA (falha ⇒ warn). Opcional: uma sonda de escrita (`INSERT OR REPLACE` de uma chave sentinela e `DELETE`) que desliga o cache se falhar.

### 14. [NIT] O circuit breaker é permanente por processo

**Onde:** §10.1.

**Problema:** atende o zero downtime, mas em `next start` uma rajada transitória (por exemplo, `SQLITE_BUSY` durante o `cache:clear`) desliga o cache até reiniciar.

**Correção:** half-open após N minutos, ou registrar no backlog.

### 15. [NIT] O merge do 304 mantém um `Age` antigo

**Onde:** R12 e `mergeNotModifiedHeaders`.

**Problema:** quando o 304 não traz `Age`, o `age` antigo continua no conjunto mesclado, e a nova policy superestima a idade. O efeito é conservador.

**Correção:** remover `age` dos cabeçalhos armazenados quando o 304 não o enviar.

### 16. [NIT] `maxRedirects: 0` difere do axios

**Onde:** §5.3 (`if (hop >= req.maxRedirects) throw …`) e §14.

**Problema:** com 0, o axios usa `http`/`https` sem follow e devolve o 3xx como erro de status. O design lançaria `ERR_FR_TOO_MANY_REDIRECTS`.

**Correção:** com `maxRedirects === 0`, o 3xx é a resposta final.

### 17. [NIT] `params` com array é rejeitado

**Onde:** §14 (valores de `params` só escalares) e §10.2.

**Problema:** o axios serializa arrays como `k[]=v`. Em `/api/geolocation/v1?…&language=pt&language=en`, o `language` chega como array e a rota passaria de 200 para 500 (`InternalError`).

**Correção:** aceitar arrays de escalares e serializar como o axios (`key[]=v1&key[]=v2`).

### 18. [NIT] Corpos órfãos e crescimento sem limite

**Onde:** §5.4 (corpo sem TTL).

**Problema:** o Keyv apaga na leitura os metadados expirados (verificado), mas o corpo, que não tem TTL, fica.

**Correção:** em `store.read`, metadados ausentes com corpo presente ⇒ remover o corpo (best-effort). Manter `--expired` no backlog.

### 19. [NIT] O CLI duplica a regra de caminho e não lê os arquivos `.env*`

**Onde:** §12.

**Problema:** a regra copiada omite o ramo `VERCEL`, e o CLI não carrega os `.env*` que o Next carrega. Um `HTTP_CACHE_SQLITE_PATH` definido em `.env.local` faz o CLI limpar outro arquivo e responder "nada a limpar".

**Correção:** o CLI imprime o caminho absoluto resolvido. Documentar que a variável precisa estar no ambiente do shell.

### 20. [NIT] Nomes de categoria não são validados

**Onde:** §7.1, §6 e §12.

**Problema:** os nomes entram em padrões `LIKE` (onde `_` e `%` são curingas) e em chaves separadas por `:`.

**Correção:** o `config.js` valida cada nome do JSON com `/^[a-z][a-z0-9]*$/` e falha no carregamento (erro de programação).

### 21. [NIT] Os desvios deliberados não estão destacados na rastreabilidade

**Onde:** §23.

**Problema:** três decisões se afastam da leitura literal dos requisitos:

- F02.1: o Got não usa a opção `cache` nativa (decisão justificada em §5.1);
- RN04: a chave é categoria + URL do provedor, e não a rota do BrasilAPI;
- F03.3: a invalidação é por categoria; `/api/cep/v2` exige limpar `cep` e `geocoding`.

**Correção:** criar uma subseção "Desvios deliberados" em §23. Opcional: um mapa `routes → categorias` no JSON, para permitir `npm run cache:clear -- --route /api/cep/v2`.

### 22. [NIT] O `npm ls` esperado está incompleto

**Onde:** §2.

**Problema:** o `keyv@4.5.4` de hoje vem de `eslint → file-entry-cache → flat-cache`. Com o `keyv@5.6.0` no topo, ele fica aninhado também em `flat-cache`, não só em `cacheable-request`.

**Correção:** citar os dois aninhamentos no resultado esperado.

### 23. [NIT] Redação do R5 sobre `s-maxage`

**Onde:** §5.2 R5 ("`must-revalidate`, `proxy-revalidate` e `s-maxage` só importam para resposta vencida").

**Problema:** o `s-maxage` define o tempo de vida (R4). O que só importa para resposta vencida é a revalidação obrigatória que ele implica.

**Correção:** ajustar a frase.

### 24. [NIT] `X-Cache` sem OpenAPI

**Onde:** §11.

**Problema:** conflita com a convenção "SEMPRE atualize a documentação OpenAPI". É aceitável, porque não há PR neste escopo e o item já está no backlog.

**Correção:** marcar como obrigatório na etapa 7 e citar no documento de implementação (achado 9).

## Cobertura dos pontos pedidos

| Ponto | Situação |
|---|---|
| Versões exatas e cadeia got ↔ cacheable-request ↔ keyv ↔ @keyv/sqlite válida para Next 12 + Vitest + Node 20 | OK. O `cacheable-request@7`/`keyv@4` do Got fica sem uso, por decisão justificada. Instalação e smoke sob Node 20.20.2 passaram. Restam os achados 7 e 22. |
| RFC 7234: explícito nunca estendido, TTL só heurístico, no-store/private/no-cache/must-revalidate/Vary, condicionais, 304 × 200, só GET, cache compartilhado | Estrutura coerente. Usar o TTL também como teto é mais conservador e é permitido. Bloqueios: achados 1 e 2; complementares: 5, 15, 23. |
| Chave de cache (RN04) | Correta e determinística, conferida pelo `pk` gravado. Desvio literal a declarar: achado 21. |
| Tabela de TTL única, sobrescrevível por env e justificada | OK, exceto o achado 8. Ver também o 20. |
| Escopo cacheável, CNPJ e `middlewares/cache.js` | OK. CNPJ fica sem cache, com `retry.limit: 0` e as mesmas opções `{ timeout, signal }`; `cache.js` fica intocado. |
| Erros idênticos aos do axios e contratos (NF03.1) | Bom no geral. `name: 'AxiosError'` e as mensagens estão corretos. Bloqueios: achados 3 e 4; complementares: 16 e 17. |
| Singleton lazy resiliente, degradando em qualquer falha | Store bem coberto. Bloqueio: achado 6; complementares: 12, 13, 14. |
| `X-Cache` e guarda do RN06 | Decididos e coerentes com next-connect + ALS (verificado). |
| axios disponível para os testes | Sim. Achado 7. |
| Etapas 1–4, sem suíte nova, sem PR/push/commit | OK. Só adapta os 13 testes existentes. Achado 9 sobre o documento pedido. |

## Premissas verificadas

1. **Versões e metadados (`npm view` + código):**
   - `got@11.8.6`: CJS (`main: dist/source`), `engines >= 10.19.0`, depende de `cacheable-request ^7.0.2`.
   - `keyv@5.6.0`: `type: module`, `exports` com `import` → `dist/index.js` e `require` → `dist/index.cjs`, sem `engines`.
   - `@keyv/sqlite@4.0.8`: `engines >= 18`, `sqlite3 ^5.1.7`, peer `keyv ^5.6.0`, dual.
   - `http-cache-semantics@4.3.0`: CJS, sem dependências.
   - `sqlite3@5.1.7`: `install: prebuild-install -r napi || node-gyp rebuild`, `napi_versions [3, 6]`. Prebuilts `napi-v6` `win32-x64` e `linux-x64` → HTTP 200.
2. **Alternativas rejeitadas conferem:**
   - `@keyv/sqlite@6.1.0` e `keyv@6.1.0` exigem Node `>= 22.19.0` (com `better-sqlite3 ^13`);
   - `@keyv/sqlite@3.6.7` tem `.catch(error => this.emit('error', error))`, que engole o erro de conexão;
   - `got@14` é ESM com `engines >= 20`.
3. **Instalação sob Node 20.20.2 no sandbox:** `keyv@4.5.4` aninhado em `cacheable-request@7.0.4`, um único `http-cache-semantics@4.3.0` (deduplicado também com o `node-gyp` do sqlite3) e um único `sqlite3@5.1.7`.
4. **Smoke em Node 20:**
   - Keyv + KeyvSqlite em CJS: PRAGMA retorna `wal`; `getMany` numa única query; `ttl` expira e o Keyv apaga na leitura; `new Keyv({ namespace: 'brasilapi-http:ibge' }).clear()` remove só `brasilapi-http:ibge:%`.
   - Linha com JSON corrompido faz `getMany` rejeitar com `SyntaxError`, o que precisa virar MISS + remoção (§17).
   - Caminho não gravável dá `SQLITE_CANTOPEN` sem *unhandled rejection* quando a sonda é chamada logo após a construção.
   - `import('keyv')` e `import('@keyv/sqlite')` funcionam.
   - Got 11 com `followRedirect: false` devolve o 301 com corpo `Buffer`; `cancel()` gera `CancelError`/`ERR_CANCELED`.
5. **http-cache-semantics 4.3.0:**
   - `timeToLive()` soma `stale-if-error` e `stale-while-revalidate` (R7 correto);
   - `revalidatedPolicy` devolve `matches: true` para 5xx com `stale-if-error` (R12 correto);
   - o merge só substitui campos já existentes (§20 correto);
   - `revalidationHeaders` põe `If-None-Match` e, em GET, `If-Modified-Since`;
   - `storable()` cobre `no-store`/`private`/`Authorization`/status entendidos (só em minúsculas, ver achado 1);
   - `maxAge()` retorna 0 para `no-cache`, `Set-Cookie` sem `public` em cache compartilhado, `proxy-revalidate` e `Vary: *`;
   - `Pragma: no-cache` vira `no-cache` só sem `Cache-Control`.
6. **cacheable-request 7.0.4:** chave `${method}:${url}`; `ttl` só com `strictTtl`/`maxTtl`; falha vira `CacheError`; o 304 regrava o valor. As razões da rejeição da alternativa (a) procedem.
7. **Next 12.3.7:** o `handleExternals` externaliza `.js/.mjs/.cjs` de `node_modules` e marca ESM por `.mjs` ou `type: module` (`module <pkg>`). O webpack 5 embutido trata externals `module` em saída não ESM como módulo assíncrono (`buildMeta.async = true`), então o `import('keyv')` dinâmico é viável. Precedente: `zod@3.24.4` (`exports.import → ./lib/index.mjs`) em `services/tickers/listTickers.js`.
8. **next-connect 0.12.1:** `handle()` chama `next()` de forma síncrona e encadeia `loop(next).catch(next)`, então o contexto ALS cobre o handler e o `onError`.
9. **Inventário do repositório:**
   - 33 arquivos de produção importam axios, mais 1 com `fetch`;
   - os 13 testes listados em §16 mockam axios/fetch, e só `anos-eleitorais-api` confere os argumentos exatos;
   - nenhum teste compara o conjunto completo de cabeçalhos;
   - nada em `components/` ou nas páginas não-API importa `services/` ou `lib/`;
   - `tests/helpers/server/setup.js` exige `NODE_ENV === 'test'`;
   - `.cache` já está no `.gitignore`;
   - `.nvmrc` = 20 e `engines.node` = `24.x`.
10. **CI:** o E2E usa Node `20.x`, `npm ci`, ESLint nos seis diretórios e `npm test` (concurrently). Os workflows de snapshot usam `npm ci` ou `npm ci --ignore-scripts`, que instalam devDependencies.
11. **Erros e CNPJ:** o `errorHandler` devolve `{ message, type: 'internal_error', name }` em 500, o que justifica manter `name: 'AxiosError'`. A lógica de 503 do `services/cnpj.js` e as asserções de `tests/cnpj-contract.test.js` batem com o §16.
12. **Cabeçalhos reais (2026-10-16):**
   - IBGE localidades: `max-age=2592000`;
   - BCB `ParticipantesSTR.csv`: `private,max-age=0` com ETag e `Last-Modified`;
   - registro.br: `no-cache, no-store, must-revalidate`.
   Tudo bate com §7.2.
13. **Exceções ao RN01:** `cep-promise` usa `node-fetch 2.6.7`, `wikijs` usa `cross-fetch` e `selic` usa `https` nativo.
14. **Keyv 5.6.0:** `set` com `ttl: 0` significa sem expiração (R9 correto). `KeyvSqlite.clear()` usa `${namespace}:%` (premissa do CLI correta).

## Premissas não verificadas ou erradas

1. **ERRADA — "o timeout do axios é inatividade de socket, mesmo mecanismo do Got `timeout.socket`":** o follow-redirects soma um relógio de parede até os cabeçalhos (achado 3, medido).
2. **ERRADA — "`methodRewriting: true` dá paridade com o axios":** o Got 11.8.6 mantém POST em 301/302 (achado 4, lido no código).
3. **ERRADA — "`policy.storable()` cobre `no-store`/`private`":** só funciona com as diretivas em minúsculas (achado 1, medido).
4. **ERRADA — "mover o axios para devDependencies não tem efeito colateral":** quebra o lint de `scripts/` (achado 7, simulado).
5. **IMPRECISA — "sem listener, o `'error'` do KeyvSqlite derrubaria o processo":** o construtor do Keyv já registra um listener (achado 12).
6. **INCOMPLETA — saída esperada do `npm ls`:** falta o aninhamento em `flat-cache` (achado 22).
7. **NÃO VERIFICADA — `next build` e `next dev` com a stack instalada no repositório, e o tracing do binário `.node` do sqlite3 e dos externals `module` pelo `@vercel/nft` no deploy.** A Vercel não foi testada (o design também registra isso). Os dois primeiros ficam cobertos por AC-01/AC-03/AC-05. Se o binário faltar, a falha é contida pela degradação do §10.1.
8. **NÃO VERIFICADA — cabeçalhos de CPTEC, TSE, Google Books, Mercado Editorial e universities.** Isso reforça o achado 1, porque a decisão é tomada em runtime.
