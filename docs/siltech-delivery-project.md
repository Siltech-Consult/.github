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
  --manifest artifacts/delivery-project-manifest.json \
  --apply

node scripts/validate-delivery-project.mjs \
  --inventory artifacts/open-issues.json \
  --manifest artifacts/delivery-project-manifest.json
```

O dry-run nao altera issues. A aplicacao relê os Issue Fields antes de cada
escrita e nunca sobrescreve `Priority`, `Workflow`, `Effort` ou `Wave` ja
preenchidos. Nao edite manualmente os artefatos de resultado ou manifest para
contornar essa protecao; corrija regras ou overrides e gere um novo plano.

## Rotacao de token

O workflow `Sync organization labels` usa o secret de organizacao
`ORG_LABEL_SYNC_TOKEN`. Na rotacao:

1. Crie um novo token com acesso de escrita em Issues para os repositorios da
   organizacao, conforme o modelo de permissao adotado.
2. Atualize o secret `ORG_LABEL_SYNC_TOKEN` nas configuracoes de Actions da
   organizacao sem remover o valor atual antes de ter o novo token.
3. Dispare manualmente `Sync organization labels` e confirme a execucao com
   sucesso nos repositorios esperados.
4. Revogue o token anterior depois da validacao e registre a data da rotacao
   no controle operacional da organizacao.

Tokens usados localmente pelos scripts devem ser fornecidos por `GH_TOKEN` ou
pela sessao autenticada do `gh`; nao os grave em arquivos versionados, planos,
manifestos ou artefatos.
