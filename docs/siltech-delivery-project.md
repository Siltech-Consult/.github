# Siltech Delivery

O Project privado [Siltech Delivery](https://github.com/orgs/Siltech-Consult/projects/11)
consolida as issues abertas da organizacao para triagem, acompanhamento de
entrega e planejamento por prioridade, fluxo, onda e repositorio. Ele usa os
Issue Fields organizacionais `Priority`, `Workflow`, `Effort` e `Wave`; nao
crie versoes locais desses campos no Project.

## Views

| View | Uso | Layout, filtro, agrupamento e ordenacao |
|---|---|---|
| `Triage` | Priorizar itens que ainda aguardam inicio. | Tabela; `workflow:Backlog`; agrupar por Priority; Priority crescente. |
| `P0 e P1` | Acompanhar trabalho urgente e de proximo ciclo que ainda esta ativo. | Tabela; `priority:P0,P1 -workflow:Frozen,Done`; agrupar por Workflow; Priority crescente. |
| `Onda 1` | Acompanhar entrega da primeira onda pelo estado do fluxo. | Board; `wave:"Onda 1"`; colunas de Workflow; Priority crescente. |
| `Em andamento` | Acompanhar itens em execucao. | Tabela; `workflow:"In progress"`; agrupar por Repository; Priority crescente. |
| `Bloqueados` | Dar visibilidade a impedimentos. | Tabela; `workflow:Blocked`; agrupar por Repository; Priority crescente. |
| `Validacao` | Acompanhar itens aguardando validacao. | Tabela; `workflow:Validation`; agrupar por Repository; Priority crescente. |
| `Congelados e Futuro` | Acompanhar issues simultaneamente `Frozen` e `Futuro`. | Tabela; `workflow:Frozen wave:Futuro`; agrupar por Wave; Priority crescente. |
| `Por repositorio` | Ver backlog completo por responsavel tecnico. | Tabela; sem filtro; agrupar por Repository; Priority crescente. |

Nas views de tabela, mantenha visiveis `Title`, `Repository`, `Type`,
`Priority`, `Workflow`, `Effort`, `Wave`, `Assignees` e `Updated`.

## Operacao diaria

Mova uma issue pelo campo `Workflow` no Project ou na issue original. Os
campos sao organizacionais e a alteracao aparece nos dois lugares. Use a
transicao compativel com o trabalho: `Backlog` para ainda nao iniciado,
`Ready` para pronto, `In progress` durante execucao, `Blocked` com impedimento,
`Validation` durante validacao, `Frozen` para trabalho suspenso e `Done` ao
concluir. Ao mover para `Blocked`, registre o impedimento na issue.

Para incluir uma issue isolada, use `Add item` no Project e selecione a issue.
Para atualizar o conjunto completo depois de novas issues, execute o fluxo de
inventario e sincronizacao abaixo; o criador do Project adiciona apenas content
IDs ausentes.

## Classificacao e sincronizacao

Execute a partir da raiz deste repositorio, autenticado no `gh` com permissao
para ler e escrever as issues e o Project da organizacao:

```bash
node scripts/inventory-open-issues.mjs

node scripts/classify-open-issues.mjs \
  --input artifacts/open-issues.json \
  --output artifacts/issue-classification-plan.json
```

Revise as ambiguidades no plano. Resolva cada uma em
`config/issue-classification-overrides.json` com a chave
`organizacao/repositorio#numero` e `reason`, depois refaca o dry-run. Nao
aplique um plano com ambiguidades.

```bash
node scripts/apply-issue-classification.mjs \
  --plan artifacts/issue-classification-plan.json \
  --apply

node scripts/validate-open-issue-classification.mjs \
  --plan artifacts/issue-classification-plan.json \
  --result artifacts/issue-classification-result.json

node scripts/create-delivery-project.mjs \
  --inventory artifacts/open-issues.json \
  --apply

node scripts/validate-delivery-project.mjs \
  --inventory artifacts/open-issues.json
```

O dry-run nao altera issues. A aplicacao relê os Issue Fields antes de cada
escrita e nunca sobrescreve `Priority`, `Workflow`, `Effort` ou `Wave` ja
preenchidos. Nao edite manualmente os artefatos de resultado ou manifest para
contornar essa protecao; corrija regras ou overrides e gere um novo plano.

O manifest padrao do Project e o arquivo versionado
`config/delivery-project-manifest.json`. Ele preserva a identidade do Project
#11 e os mappings dos quatro Issue Fields sem armazenar tokens. Novas
associacoes de campo atualizam esse arquivo e devem ser revisadas e commitadas.
Durante associacao de campo ou inclusao de item, `pendingOperation` registra a
intencao antes da mutacao; em resposta perdida ou retomada, o sincronizador rele
o Project e nao repete uma operacao ja observada.

Um resultado terminal de classificacao pertencente a plano anterior e
arquivado com o digest no nome antes de iniciar o plano novo. Resultado
pendente, falho ou incoerente bloqueia a troca. O inventario tambem falha
fechado ao atingir o limite de 1000 resultados do `gh search issues`, pois esse
retorno nao prova que a organizacao foi enumerada por completo.

## Rotacao de token

Os workflows `Sync organization labels` e `Organization governance` usam o
secret `ORG_LABEL_SYNC_TOKEN` do repositorio `.github`. Para a governanca, o
token precisa ler e escrever Issues, Issue Fields organizacionais e Projects
da organizacao, alem de ler seus metadados.

Na rotacao:

1. Crie um novo token com as permissoes exigidas pelos workflows.
2. Atualize o secret `ORG_LABEL_SYNC_TOKEN` nas configuracoes de Actions da
   organizacao sem remover o valor atual antes de ter o novo token.
3. Dispare manualmente `Sync organization labels` e `Organization governance`
   em modo `audit`; confirme as duas execucoes.
4. Revogue o token anterior depois da validacao e registre a data da rotacao
   no controle operacional da organizacao.

Tokens usados localmente pelos scripts devem ser fornecidos por `GH_TOKEN` ou
pela sessao autenticada do `gh`; nao os grave em arquivos versionados, planos,
manifestos ou artefatos.

## Automacao agendada

O workflow `Organization governance` roda de segunda a sexta-feira as 06:00 no
horario de Sao Paulo (`09:00 UTC`). A agenda usa modo `apply`: inventaria as
issues abertas, gera o plano deterministico, interrompe se houver ambiguidade,
preenche somente campos vazios, sincroniza o Project e valida as
pos-condicoes. Uma unica execucao pode ficar ativa; uma nova aguarda a anterior
em vez de cancela-la.

O disparo manual oferece:

- `audit`: executa testes, inventario, classificacao sem escrita e auditoria do
  Project.
- `apply`: executa o ciclo completo usado pela agenda.

Cada ciclo publica por 30 dias o inventario, plano, resultados, auditorias e
manifest do Project como artefato da execucao. Se o manifest versionado mudar,
o ciclo falha depois de enviar a evidencia; revise e commit a alteracao antes
do proximo `apply`.

Para o primeiro ciclo ou depois de alterar regras, overrides, token ou
permissoes:

1. Dispare `audit` e confira testes, ausencia de ambiguidades e auditoria.
2. Dispare `apply` e acompanhe todas as etapas ate a validacao final.
3. Baixe o artefato e preserve a URL da execucao como evidencia.
4. Confirme no Project que itens novos e campos esperados foram sincronizados.
