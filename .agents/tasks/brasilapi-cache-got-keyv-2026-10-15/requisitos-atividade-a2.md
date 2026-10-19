# Atividade A2 (UFG) — Requisitos extraídos do PDF da proposta

Projeto: "Implementação de Sistema de Cache Persistente em Requisições HTTP com Got e KeyvSQLite no BrasilAPI"
Autores: Islabelle Vitória Mendonça Bastos, Igor Daniel Toledo Campos, Guilherme Augusto Brilhante Leal.
Referência: Issue #648 do repositório oficial do BrasilAPI (https://github.com/BrasilAPI/BrasilAPI/issues/648).

## Visão geral (resumo fiel do PDF)

Hoje o BrasilAPI encaminha diretamente aos provedores oficiais (Receita Federal, Correios, Banco Central etc.)
todas as requisições recebidas, usando axios como cliente HTTP, sem nenhuma camada de cache entre a API e as
fontes externas. A proposta é substituir o cliente HTTP pelo Got (suporte nativo às regras de cache da RFC 7234)
e conectá-lo ao Keyv por meio do adapter KeyvSQLite (@keyv/sqlite). As respostas das rotas cacheáveis passam a
ser gravadas em um arquivo SQLite local, sem serviço externo. Uma requisição repetida com dado ainda válido é
atendida pelo cache, sem nova chamada ao provedor, e só volta à fonte original quando o TTL expira ou quando o
provedor indica, pelos cabeçalhos de resposta, que a informação mudou.

## Cronograma (escopo desta implementação = etapas 1 a 4)

| # | Etapa | Entregável | No escopo agora? |
|---|-------|------------|------------------|
| 1 | Configuração do ambiente (Node LTS, Got, Keyv, KeyvSQLite) | Ambiente pronto e dependências instaladas | SIM |
| 2 | Substituição do axios pelo Got nas rotas mapeadas | Rotas críticas usando Got nas chamadas externas | SIM |
| 3 | Integração do Keyv e do KeyvSQLite, definição de TTL por rota | Camada de cache funcional, TTL por categoria de rota | SIM |
| 4 | Requisições condicionais e conformidade com a RFC 7234 | Suporte a ETag e requisições condicionais | SIM |
| 5 | Testes unitários e de integração | Suíte de testes da camada de cache | NÃO (etapa futura) |
| 6 | Benchmark comparativo com autocannon (cold/warm) | Relatório de métricas | NÃO (etapa futura) |
| 7 | Documentação técnica e preparação do PR | PR submetido à Issue #648 | NÃO (etapa futura) |

## Requisitos funcionais

### Categoria 1: Cliente HTTP e Conformidade com a RFC 7234
- F01.1 (Alta) Substituição do cliente HTTP: trocar o axios pelo Got como biblioteca padrão para requisições externas. RN01
- F01.2 (Alta) Leitura de cabeçalhos de cache: interpretar Cache-Control, ETag e Last-Modified das respostas dos provedores, conforme RFC 7234. RN01, RN02
- F01.3 (Média) Requisições condicionais: emitir If-None-Match ou If-Modified-Since quando o cache estiver expirado, para checar se o dado mudou antes de baixar tudo novamente. RN02

### Categoria 2: Armazenamento Persistente do Cache
- F02.1 (Alta) Integração com o Keyv: conectar o cliente Got ao Keyv como camada de gerenciamento de cache. RN03
- F02.2 (Alta) Persistência em SQLite: usar o adapter KeyvSQLite para gravar as respostas em arquivo SQLite local, sem Redis. RN03
- F02.3 (Média) Isolamento por rota: registros de cache separados por rota e por parâmetros de requisição. RN04

### Categoria 3: Regras de Expiração e Renovação de Cache (TTL)
- F03.1 (Alta) Definição de TTL por rota: TTLs diferentes conforme a volatilidade (TTL longo para bancos e feriados, curto para dados que mudam mais). RN05
- F03.2 (Média) Renovação automática: após expirar o TTL, buscar a origem novamente na próxima requisição àquela rota. RN05
- F03.3 (Baixa) Invalidação manual em desenvolvimento: permitir invalidar o cache de uma rota específica em dev, para facilitar testes. RN06

### Categoria 4: Observabilidade e Avaliação de Desempenho (FORA DO ESCOPO AGORA — etapas 5/6)
- F04.1 Benchmark comparativo com autocannon (axios sem cache x Got + Keyv/SQLite). RN07
- F04.2 Medição de cold cache e warm cache. RN07
- F04.3 Relatório de métricas (throughput, p50/p95/p99). RN07

## Requisitos não funcionais
- NF01.1 (Alta, Desempenho) Baixa latência em warm cache: respostas do cache local muito mais rápidas que a chamada direta à origem.
- NF01.2 (Alta, Manutenibilidade) Simplicidade de infraestrutura: sem serviços externos (Redis); cache em um único arquivo SQLite local.
- NF02.1 (Média, Portabilidade) Compatibilidade de ambiente: continuar funcional no Node.js LTS v20 ou v21 (v24 tem incompatibilidade conhecida com Next.js 12).
- NF02.2 (Alta, Confiabilidade) Conformidade com padrões web: respeitar integralmente as diretivas da RFC 7234, sem servir dados desatualizados indevidamente.
- NF03.1 (Média, Usabilidade) Transparência: não alterar o contrato das rotas (URL, parâmetros, formato JSON da resposta).

## Regras de negócio
- RN01 (F01.1, F01.2): toda requisição HTTP externa feita pelo BrasilAPI deve ser feita pelo Got, respeitando os cabeçalhos de cache da origem (RFC 7234).
- RN02 (F01.2, F01.3): quando o cache de uma rota estiver expirado mas ainda existir registro armazenado, tentar requisição condicional antes de descartar o dado.
- RN03 (F02.1, F02.2): toda resposta cacheável deve ser persistida no SQLite local via Keyv, sobrevivendo a reinicializações do processo Node.js.
- RN04 (F02.3): a chave de cache deve ser composta pela rota e pelos parâmetros relevantes da requisição.
- RN05 (F03.1, F03.2): o TTL de cada entrada deve ser definido conforme a volatilidade do dado e reavaliado ao final de cada ciclo de expiração.
- RN06 (F03.3): invalidação manual restrita a desenvolvimento/testes, nunca exposta como funcionalidade pública em produção.
- RN07 (F04.x): validação por testes de carga (etapa futura).

## Casos de uso
- UC01 Cache hit: GET em rota (ex.: /api/banks/v1); existe entrada válida no SQLite dentro do TTL → resposta direto do cache, sem chamar a origem. (F01.2, F02.1, F02.2, F03.1)
- UC02 Cache miss: sem entrada → Got chama a origem, verifica cabeçalhos (RFC 7234) e, se cacheável, grava no SQLite via Keyv antes de responder. (F01.1, F01.2, F02.1, F02.2; RN01, RN03)
- UC03 Renovar cache expirado com validação condicional: entrada com TTL expirado → requisição condicional; se a origem responder que não mudou (304), o TTL é renovado sem gravar novo conteúdo; caso contrário, o conteúdo novo substitui o anterior. (F01.3, F03.2; RN02, RN05)
- UC04 Benchmark (etapa futura).

## Arquitetura proposta (seção 7 do PDF)
Aplicação Cliente → Rotas de API (pages/api/*, Next.js) → Cliente HTTP (Got) → Gerenciador de Cache (Keyv) →
Adapter de Persistência (@keyv/sqlite) → Arquivo SQLite (cache local em disco). Provedores externos só são
acionados em cache miss ou para validar se o dado mudou (requisição condicional), retornando resposta +
headers de cache (RFC 7234).

Diagrama de sequência: no cache hit com TTL válido a rota responde `200 OK (X-Cache: HIT)`; no cache miss
ou TTL expirado, GET via Got (ou requisição condicional) → resposta + Cache-Control/ETag → grava/atualiza
cache (Keyv) → `200 OK (X-Cache: MISS)`. O PDF cita "um eventual cabeçalho HTTP indicando se aquela resposta
veio do cache ou da fonte original".

## Tecnologias previstas
Next.js 12 e React 17 (sem alterações estruturais), Got, Keyv, @keyv/sqlite, Node.js LTS v20/v21,
autocannon (futuro), Jest (o PDF cita Jest; usar o runner de testes que o projeto realmente usa), Git/GitHub.
