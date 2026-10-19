# Revisão de design — Cache HTTP persistente (Got + Keyv/@keyv/sqlite), iteração 2

**Veredito: APPROVED** — 0 HIGH, 0 MEDIUM, 9 NIT.

A iteração 2 tratou corretamente todos os 24 achados da iteração 1. O design é consistente, implementável e tecnicamente sólido. Os únicos achados restantes são NITs sem nenhum bloqueio real à implementação.

---

## Como a revisão foi feita

- Li o design completo (iteração 2), incluindo a §26 com as respostas a cada achado anterior.
- Li `requisitos-atividade-a2.md`, `design-review.md` (iteração 1) e `design-verdict.json`.
- Li o código real do repositório: `package.json`, `app.js`, `middlewares/cache.js`, `middlewares/errorHandler.js`, `services/cnpj.js`, `services/indices/helpers.js`, `lib/fetchGeocoordinateFromBrazilLocation.js`, `tests/cnpj-contract.test.js`, `tests/fetchGeocoordinateFromBrazilLocation.test.js`, `vite.config.js`, `.eslintrc.js` e `tests/helpers/server/setup.js`.
- Verifiquei as restrições do workflow: retrocompatibilidade de rotas, axios em dependencies, middlewares/cache.js intocado, caminho do SQLite, X-Cache aditivo, sem commit/push/PR.

---

## Verificação das correções da iteração 1

### Achado 1 [HIGH → CORRIGIDO] — Diferença de caixa em Cache-Control

`normalizeCacheHeaders` no `policy.js` coloca `cache-control`, `pragma` e `vary` em minúsculas antes de qualquer `new CachePolicy`, antes dos parsers próprios e antes do merge do 304. O R3 agora tem checagens próprias (`cc.has('no-store')`, `cc.has('private')`) além de `policy.storable()`. O I4 e o AC-08 cobrem os casos `No-Store`, `Private` e `Pragma: No-Cache`. **Corrigido corretamente.**

### Achado 2 [MEDIUM → CORRIGIDO] — Predicado explícito × heurístico

`parseDirectives` (Map<nome, Array<string|null>>), `freshnessSource` (inclui `Pragma: no-cache` sem `Cache-Control`) e `explicitFreshnessValid` (`/^\d+$/` por token, duplicata conflitante = inválido) estão definidos em §5.2. A tabela de `computeFreshness` cobre todos os ramos, inclusive inválido (`lifetime = 0`). **Corrigido corretamente.**

### Achado 3 [MEDIUM → CORRIGIDO] — Paridade de timeout

A solução proposta (`timeout.response + timeout.socket`) foi medida e rejeitada (5028 ms no connect). A nova abordagem — `createDeadline` com relógio de parede até os cabeçalhos, compartilhado entre saltos, mais `timeout.socket` para inatividade após os cabeçalhos — reproduz a semântica do follow-redirects. Quatro cenários foram medidos e os resultados estão na tabela de §10.2. **Corrigido corretamente, com alternativa fundamentada.**

### Achado 4 [MEDIUM → CORRIGIDO] — methodRewriting no Got 11

O Got fica sempre em `followRedirect: false`. O único seguidor é `redirects.js`, que implementa as regras exatas do follow-redirects 1.15.11 para todos os métodos: 301/302 POST→GET, 303 não-GET→GET, 307/308 mantêm método e corpo; remoção de `content-*`, `host` e credenciais conforme o host/protocolo. Limite de 21 fixo. **Corrigido corretamente.**

### Achado 5 [MEDIUM → CORRIGIDO] — TTL do índice de Vary

O índice de Vary é gravado sem TTL no Keyv, regravado a cada `write` de variante. O `remove` não o apaga (evita tornar variantes irmãs inalcançáveis). Índice com variante ausente gera MISS normal. **Corrigido corretamente.**

### Achado 6 [MEDIUM → CORRIGIDO] — Exceções fora do store sem degradação

`prepare` (F1) tem try/catch; falha → transporte direto (MISS) sem nova chamada. `finalize` (F2) tem try/catch; falha → `fallbackResult` com a resposta já obtida, nunca nova chamada. A única segunda chamada de rede é a recondicional do R12 (304 sem correspondência), documentada como I14 e D6. **Corrigido corretamente.**

### Achado 7 [MEDIUM → CORRIGIDO] — axios em devDependencies quebra lint

`axios 1.8.3` permanece em `dependencies`, inalterado. AC-01 inclui `npx eslint . --ext .js` (cobre `scripts/generate-*.js`). **Corrigido corretamente; confirmado no repositório: axios 1.8.3 está em dependencies.**

### Achado 8 [MEDIUM → CORRIGIDO] — TTL de banks

`banks = 604800` (7 d) com justificativa citando F03.1 e o efeito prático (`private`/`Expires: 0` impedem gravação hoje). `feriados` e outros sem chamada externa têm nota explícita. **Corrigido corretamente.**

### Achado 9 [MEDIUM → CORRIGIDO] — Documento de implementação fora do escopo

`docs/HTTP_CACHE_GOT_KEYV.md` está em "Dentro do escopo" com 12 seções obrigatórias e resultados reais. AC-17 verifica a existência e o conteúdo. Separado da etapa 7 (OpenAPI/PR). **Corrigido corretamente.**

### Achados 10–24 [NIT → todos resolvidos]

- 10 (`request` exportado sem assinatura): `export default { get, post }`, sem `request`. ✓
- 11 (contratos não escritos): §3.1 tem assinaturas completas de `HttpClientError`, `isHttpClientError`, `send`, `createDeadline`, `follow`, store e `createCachedHop`. ✓
- 12 (listener 'error' impreciso): listener no-op documentado; falhas tratadas só pelas rejeições com `throwOnErrors`. ✓
- 13 (sonda ambígua): sequência explícita `SELECT 1` → `PRAGMA` → sonda de escrita `_probe`, com a regra de chamar `query` na mesma volta síncrona da construção para evitar unhandled rejection. ✓
- 14 (breaker permanente): meia-abertura após `breakerCooldownMs` (5 min). ✓
- 15 (`Age` antigo em 304): `age` armazenado é removido se o 304 não o trouxer. ✓
- 16 (`maxRedirects: 0`): opção removida; opção desconhecida lança `TypeError`; limite fixo em 21. ✓
- 17 (`params` com array): `buildUrl` reproduz o axios (`k[]=v`, `null`/`undefined` descartados, `Date` ISO). ✓
- 18 (corpos órfãos): metadados ausentes com corpo presente → corpo removido (best-effort). ✓
- 19 (CLI e `.env*`): mesmo algoritmo de três ramos, caminho absoluto impresso, documentação sobre variáveis no shell. ✓
- 20 (nomes de categoria): `/^[a-z][a-z0-9]*$/` em `createConfig`; desliga cache em vez de derrubar rota. ✓
- 21 (desvios não destacados): §23.1 D1–D10 com mapa `routes → categorias` no JSON e `--route` no CLI. ✓
- 22 (`npm ls` incompleto): dois aninhamentos de `keyv@4.5.4` (cacheable-request e flat-cache). ✓
- 23 (R5 sobre `s-maxage`): `s-maxage` define o tempo de vida (R4); a revalidação obrigatória que implica só importa para vencido. ✓
- 24 (`X-Cache` sem OpenAPI): obrigatório na etapa 7, citado em §11 e §1 item 12. ✓

---

## Achados desta iteração

### 1. [NIT] `sameVaryNames` usada em `cachedHop.finalize()` mas não declarada em nenhuma tabela de exports

**Onde:** §5.4 (`if (!matches || !sameVaryNames(prep.cached.meta.headers, merged))`).

**Problema:** `sameVaryNames` está ausente da lista de exports de `policy.js` (§3) e não aparece nos contratos de §3.1. A função é inferível pelo contexto (compara nomes de Vary parseados de dois conjuntos de cabeçalhos), mas deixa dúvida se é helper local de `cachedHop.js` ou importada de `policy.js`.

**Correção:** acrescentar `sameVaryNames(h1, h2)` à lista de exports de `policy.js` em §3 ou explicitar que é um helper privado de `cachedHop.js` com a assinatura `(h1: headers, h2: headers) => boolean` (compara `parseVary(h1.vary)` com `parseVary(h2.vary)`).

---

### 2. [NIT] `normalizeHeaderValue` referenciada em §6 mas ausente dos exports de `keys.js`

**Onde:** §6 (cálculo de `variantHash`).

**Problema:** o comentário do `variantHash` menciona `normalizeHeaderValue(outgoingHeaders[n])` (trim + colapso de espaços internos, RFC 7234 §4.1), mas a função não aparece na tabela de exports de `keys.js` (§3: "`normalizeUrl`, `base(category, url)`, `variant(base, names, headers)`").

**Correção:** acrescentar `normalizeHeaderValue` à lista de exports de `keys.js`, ou declarar que é helper privado com a especificação: `valor ausente → ''`; trim + colapso de espaços em branco internos; recebe a string já inteira do cabeçalho (não o nome).

---

### 3. [NIT] `withoutHost` usada no algoritmo de `cachedHop.js` mas não definida em lugar algum do design

**Onde:** §5.4 (`const headers = withoutHost(policy.revalidationHeaders(snapshot))`).

**Problema:** `withoutHost` remove o campo `host` dos cabeçalhos de revalidação antes de enviá-los (o Got define `host` pela URL). A finalidade é clara pelo contexto, mas a função não está em nenhuma tabela de exports nem é descrita formalmente.

**Correção:** adicionar uma linha em §5.3 R11 ou §3: "`withoutHost(headers)` — helper puro que devolve `{ ...headers }` sem o campo `host`." Pode ser local de `cachedHop.js` ou importado de `policy.js`.

---

### 4. [NIT] Tipo de retorno de `keys.variant` não especificado

**Onde:** §3 ("variant(base, names, headers). Puro.").

**Problema:** o contrato diz o que a função recebe, mas não o que devolve. `store.read` precisa calcular as chaves da variante a partir do resultado. Sem o tipo declarado, o coder pode escolher formatos incompatíveis.

**Correção:** especificar o retorno: `{ metaKey: string, bodyKey: string }` — as versões com sufixo `.<variantHash>` das chaves do `base`. Exemplo: `metaKey = '${base.metaKey}.${variantHash}'`.

---

### 5. [NIT] Estrutura completa de `categories.json` não está exemplificada

**Onde:** §3 (descrição do arquivo), §7.1 (tabela de TTL), §7.4 (mapa `routes`), §9 (bloco `defaults`).

**Problema:** o JSON é referenciado em quatro seções diferentes mas nunca aparece como bloco completo. O coder precisa inferir a hierarquia dos campos (`schemaVersion`, `defaults`, `categories[*].ttlSeconds`, `categories[*].justification`, `routes`). Um erro de naming (ex.: `ttl` em vez de `ttlSeconds`) passaria despercebido até o `createConfig` falhar.

**Correção:** adicionar em §3 ou §7.1 um exemplo esquelético com dois ou três campos:

```jsonc
{
  "schemaVersion": 1,
  "defaults": { "minStoreFreshnessSeconds": 5, "busyTimeoutMs": 250, "breakerThreshold": 5, "breakerCooldownMs": 300000 },
  "categories": {
    "banks": { "ttlSeconds": 604800, "justification": "F03.1 pede TTL longo; ..." },
    "cep":   { "ttlSeconds": 86400,  "justification": "..." }
  },
  "routes": { "/api/banks/v1": ["banks"] }
}
```

---

### 6. [NIT] Comportamento de `createDeadline` com `timeoutMs` falsy e o timer em `transport.js` não especificado explicitamente

**Onde:** §3.1 (`createDeadline` retorna `{ remaining(): number }` — `Infinity` se falsy).

**Problema:** o design especifica que `remaining()` retorna `Infinity` quando `timeoutMs` é falsy, mas não diz explicitamente que `transport.js` não deve armar um `setTimeout` nesse caso. O comportamento de `setTimeout(Infinity)` no Node varia (clamp para ~24,8 dias), podendo resultar num timer pendurado que viola o I13.

**Correção:** acrescentar a regra: "em `transport.send`, o timer de prazo de parede só é armado quando `deadline.remaining() !== Infinity`."

---

### 7. [NIT] Mapeamento de `cache` option → `category` field no `req` interno de `client.js` não é declarado explicitamente

**Onde:** §14 (`httpClient.get` recebe `cache: CACHE_CATEGORY.*`) vs §3.1/§5.4 (`cachedHop` recebe `req.category`).

**Problema:** o `httpClient.get` aceita `{ cache: CACHE_CATEGORY.X }`, mas o algoritmo de `cachedHop.js` usa `req.category`. A renomeação (`cache → category`) e o momento em que isso ocorre (dentro de `client.js`, ao montar o `req` para o `follow`) são inferíveis mas não declarados.

**Correção:** em §14 (Fluxo de `get`, passo 1 ou 2), acrescentar: "`req` é montado com `category: activeCategory` (a categoria resolvida em passo 2, ou `null` se bypass/desativada), não com `cache` diretamente."

---

### 8. [NIT] Interface de `log` injetado em `createCachedHop` não é especificada formalmente

**Onde:** §3.1 (`createCachedHop({ store, transport, getConfig, now = Date.now, log })`), §5.4 (`log.warnOnce(...)`).

**Problema:** `log` é injetado para testabilidade, e o algoritmo chama `log.warnOnce(key, error)`. Não há definição de interface: shape do objeto, semântica da deduplicação ("1× por tipo", como diz §17), ou se o Set de deduplicação é do módulo, do `store.js` ou passado externamente. O coder pode implementar qualquer coisa.

**Correção:** adicionar em §3.1 ou §5.4: "`log` = `{ warnOnce(key: string, error: unknown): void }` — loga no nível `console.warn` exatamente uma vez por `key` por processo. O Set de deduplicação fica no escopo do módulo de `cachedHop.js`. Padrão (quando omitido): implementação interna usando esse Set."

---

### 9. [NIT] Nome do arquivo SQLite padrão difere do citado no brief do workflow

**Onde:** §9 (`<cwd>/.cache/http-cache.sqlite`) vs restrição do workflow (`.cache/brasilapi.sqlite`).

**Problema:** o design usa `http-cache.sqlite` em todos os contextos (padrão local, Vercel, gitignore, AC-05), enquanto o brief desta revisão cita `brasilapi.sqlite`. Como o caminho é configurável via `HTTP_CACHE_SQLITE_PATH`, o impacto funcional é zero, mas o nome pode divergir de convenção acordada fora do design.

**Correção:** confirmar com o usuário o nome preferido e alinhar no design (§9, AC-05, gitignore, §24). Uma opção: renomear para `brasilapi-http-cache.sqlite` (já usado para a Vercel em `os.tmpdir()`), tornando os nomes consistentes.

---

## Premissas verificadas

1. **`axios 1.8.3` em `dependencies`** — confirmado no `package.json` real do repositório.
2. **`middlewares/cache.js` inalterado** — lido; o design confirma explicitamente (I12, AC-13).
3. **`middlewares/errorHandler.js`** — lido; retorna `{ message, type: 'internal_error', name: error.name }` em 500, confirmando a necessidade de `name: 'AxiosError'` (AC-04).
4. **`tests/cnpj-contract.test.js`** — lido integralmente; todas as asserções da adaptação do §16 são consistentes com o código real (timeout, AbortSignal, vi.getTimerCount, status codes).
5. **`tests/fetchGeocoordinateFromBrazilLocation.test.js`** — lido; usa `vi.spyOn(global, 'fetch')`; 3 chamadas para 2 photon + 1 open-meteo; sem casos `ok: false`; asserções em `mock.calls[i][0]` (URLs pré-montadas com URLSearchParams) permanecem válidas na adaptação.
6. **`lib/fetchGeocoordinateFromBrazilLocation.js`** — lido; `getAgent` é helper privado usado só em `fetchJson`; nenhum export ou import externo; remoção segura.
7. **`services/cnpj.js`** — `isAxiosError` + `controller.signal.aborted`; estrutura do catch confirmada compatível com a adaptação para `isHttpClientError`.
8. **`services/indices/helpers.js`** — `return schema.validateAsync(...)` sem `await` confirmado no código real; `isAxiosError` também presente.
9. **`vite.config.js`** — `fileParallelism: false`, `setupFiles: tests/helpers/server/setup.js`, `isolate: true`; confirma P1.
10. **`.eslintrc.js`** — estende `airbnb`; não tem override de `no-restricted-syntax`, `no-await-in-loop`, `no-param-reassign`, `global-require`, `no-underscore-dangle`, confirmando as regras de estilo do §3.
11. **Correções adicionais da iteração 2** (não constavam na revisão anterior): `immutableMinTimeToLive: 0` para neutralizar bug ms/s da 4.3.0; credenciais de requisição protegidas pelo R14 + I15; I13 (zero timers com mock de `httpClient.get`); `sanitizeStoredHeaders` retira `content-encoding`/`content-length` — todos corretos e bem justificados.
12. **Restrições do workflow**: retrocompatibilidade (NF03.1 + AC-03/04/13); axios em dependencies (Decisão 10, AC-01); middlewares/cache.js intocado; X-Cache aditivo (§11); sem commit/push/PR (§1 e §25).

## Premissas não verificadas ou discrepantes

1. **Nome do SQLite padrão** — `.cache/http-cache.sqlite` no design vs `.cache/brasilapi.sqlite` no brief desta revisão (NIT 9). Sem impacto funcional por ser configurável.
2. **`next build` e `next dev` com novas dependências** — não verificado (permanece da iteração 1 como risco não-bloqueante; coberto por AC-01/AC-05).
3. **Binário nativo do `sqlite3` no tracing `@vercel/nft`** — não verificado (risco documentado em §24 com contingência).
4. **Cabeçalhos de CPTEC, TSE, Google Books, Mercado Editorial, universities** — não verificados (idem iteração 1; decididos em runtime com caixa normalizada).

