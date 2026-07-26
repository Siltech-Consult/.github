# Classificacao Organizacional de Issues e Project Consolidado

Data: 2026-07-26

## Objetivo

Classificar todos os issues abertos da organizacao Siltech-Consult com os
Issue Fields oficiais e criar um GitHub Project consolidado para planejamento
e acompanhamento.

O inventario inicial possui 173 issues abertos em 15 repositorios:

- 62 ja possuem Priority e Workflow.
- 111 ainda nao possuem Priority e Workflow.
- Nenhum possui Effort ou Wave.

## Principios

1. Issue Fields organizacionais sao a fonte oficial.
2. Valores existentes nunca sao sobrescritos pela migracao.
3. Labels e prefixos antigos servem apenas como entrada para campos vazios.
4. A classificacao deve ser deterministica, reproduzivel e auditavel.
5. A migracao deve produzir uma previa antes de alterar o GitHub.
6. Uma falha parcial deve interromper a execucao e deixar um relatorio claro.

## Campos

### Priority

Precedencia:

1. Preservar valor existente.
2. Usar label `priority:p0` a `priority:p5`.
3. Usar prefixo de titulo `[P0]` a `[P5]` ou `P0:` a `P5:`.
4. Aplicar regras deterministicas:
   - P0: bloqueio da Onda 1, risco imediato de seguranca, perda ou corrupcao
     de dados, indisponibilidade atual.
   - P1: bug de corretude, seguranca, confiabilidade, dependencia direta da
     Onda 1 ou entrega essencial do ciclo atual.
   - P2: feature, teste, CI, refatoracao ou documentacao importante e
     planejavel.
   - P3: backlog priorizado sem urgencia operacional.
   - P4: melhoria futura opcional.
   - P5: pesquisa ou oportunidade de longo prazo.

### Workflow

Precedencia:

1. Preservar valor existente.
2. Label `status:congelado` define `Frozen`.
3. Pull request aberto vinculado define `In progress`.
4. Pull request integrado com issue ainda aberta define `Validation`.
5. Demais issues recebem `Backlog`.

`Blocked`, `Ready` e `Done` nao serao inferidos sem evidencia explicita. Eles
serao usados no acompanhamento diario.

### Effort

Classificacao por escopo:

- XS: ajuste textual, changelog ou configuracao muito pequena.
- S: documentacao focada, CI simples, release, validacao ou correcao isolada.
- M: feature ou correcao normal em um repositorio, com testes.
- L: integracao, modulo completo, migracao ou alteracao em varios componentes.
- XL: epico, iniciativa entre repositorios ou escopo que deve ser decomposto.

Quando houver conflito entre palavras-chave e corpo do issue, prevalece o maior
esforco identificavel.

### Wave

Precedencia:

1. Label `onda-1` define `Onda 1`.
2. Label `onda-2` define `Onda 2`.
3. Labels `onda-3`, `fase-2` ou `status:congelado` definem `Futuro`.
4. Corretude, seguranca, CI, release e aderencia ao standard dos coletores
   atuais definem `Onda 1`.
5. Expansao multi-tecnologia, modulos gerenciais e integracoes posteriores
   definem `Onda 2`.
6. Pesquisa, conveniencia e features opcionais definem `Futuro`.
7. Na ausencia de sinal suficiente:
   - P0/P1 recebem `Onda 1`.
   - P2 recebe `Onda 2`.
   - P3/P4/P5 recebem `Futuro`.

## Motor de Classificacao

O repositorio `.github` recebera:

- Um arquivo de regras versionado.
- Um script de inventario e classificacao.
- Um modo `--dry-run`, obrigatorio antes da aplicacao.
- Um artefato JSON com valor atual, valor proposto, regra aplicada e motivo.
- Um script de validacao posterior.

O motor consultara titulo, corpo, labels, tipo, repositorio, campos existentes e
pull requests vinculados. As regras mais especificas terao precedencia sobre
defaults.

Para cada issue, a previa mostrara:

- repositorio e numero;
- valores preservados;
- valores propostos;
- origem de cada decisao;
- alertas de ambiguidade.

Issues ambiguos nao serao alterados automaticamente. A execucao falhara ate que
exista uma regra explicita ou uma excecao versionada.

## GitHub Project

Nome: `Siltech Delivery`

Visibilidade: privada para a organizacao.

Todos os 173 issues abertos serao adicionados. Os Issue Fields organizacionais
serao usados diretamente, sem criar campos duplicados no Project.

Visoes:

1. `Triage`: Workflow Backlog, agrupado por Priority.
2. `P0 e P1`: prioridades P0/P1, excluindo Frozen e Done.
3. `Onda 1`: Wave Onda 1, agrupado por Workflow.
4. `Em andamento`: Workflow In progress.
5. `Bloqueados`: Workflow Blocked.
6. `Validacao`: Workflow Validation.
7. `Congelados e Futuro`: Workflow Frozen ou Wave Futuro.
8. `Por repositorio`: todos os itens, agrupados por Repository e ordenados por
   Priority.

O Project nao criara uma segunda versao de Priority, Workflow, Effort ou Wave.

## Execucao

1. Gerar inventario atualizado.
2. Gerar classificacao em modo dry-run.
3. Validar que todos os 173 issues possuem quatro valores propostos.
4. Confirmar que nenhum campo existente sera sobrescrito.
5. Aplicar em lotes pequenos, com pausa para evitar rate limit secundario.
6. Auditar 173/173 issues pela API.
7. Criar o Project e adicionar os issues.
8. Configurar as visoes.
9. Validar contagem, filtros e agrupamentos.

## Tratamento de Falhas

- A API deve ser chamada com retry e backoff para erros transitivos.
- Falha em um issue interrompe o lote atual.
- Reexecucao e idempotente: valores ja preenchidos sao preservados.
- O relatorio final lista aplicados, preservados, ambiguos e falhas.
- Nenhum issue sera removido, fechado ou renomeado.

## Testes

- Regras unitarias para labels, prefixos, palavras-chave e defaults.
- Teste de preservacao de valores existentes.
- Teste de classificacao de congelados e ondas explicitas.
- Teste de deteccao de PR aberto e integrado.
- Teste de issue ambiguo.
- Dry-run sobre o inventario real.
- Auditoria posterior com expectativa de 173/173 issues completos.
- Validacao do Project com 173 itens e sem campos duplicados.

## Criterios de Aceite

- Todos os issues abertos possuem Priority, Workflow, Effort e Wave.
- Nenhum valor anterior foi sobrescrito.
- Nenhum prefixo ou label legado precisa ser removido nesta rodada.
- A classificacao pode ser reproduzida a partir das regras versionadas.
- O Project `Siltech Delivery` contem todos os issues abertos.
- As oito visoes permitem acompanhar prioridade, onda, fluxo e repositorio.
- Scripts, testes, relatorios de auditoria e instrucoes estao publicados no
  repositorio `.github`.
