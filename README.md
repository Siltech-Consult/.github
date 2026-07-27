# Governanca GitHub - Siltech Consult

Este repositorio centraliza formularios de issue, taxonomia de labels e
automacao de governanca para os repositorios da organizacao
`Siltech-Consult`.

## Classificacao oficial

Use recursos nativos da organizacao para classificacoes de planejamento:

- Issue Type: `Bug`, `Feature` ou `Task`.
- Priority: `P0`, `P1`, `P2`, `P3`, `P4` ou `P5`.
- Workflow: `Backlog`, `Ready`, `In progress`, `Blocked`, `Validation`,
  `Frozen` ou `Done`.
- Effort: `XS`, `S`, `M`, `L` ou `XL`.
- Wave: `Onda 1`, `Onda 2` ou `Futuro`.

Nao codifique prioridade, status ou tipo no titulo da issue. Labels devem
descrever apenas contexto tecnico, dependencia ou necessidade de evidencia.

## Labels administrados

O arquivo [`labels.json`](labels.json) e a fonte oficial. A sincronizacao:

- cria labels ausentes;
- atualiza cor e descricao;
- nao remove labels locais adicionais;
- ignora repositorios arquivados.

Execucao local:

```bash
GH_TOKEN=... ./scripts/sync-labels.sh
```

Para limitar repositorios:

```bash
REPOSITORIES="Report-Worker,Windows_Health" ./scripts/sync-labels.sh
```

O workflow `Sync organization labels` exige o secret de organizacao
`ORG_LABEL_SYNC_TOKEN`, com permissao de escrita em Issues nos repositorios.

## Campos da organizacao

O script abaixo configura os campos oficiais de forma idempotente:

```bash
./scripts/configure-issue-fields.sh
```

Ele preserva os IDs das opcoes existentes durante a migracao:

- Priority: `Urgent -> P0`, `High -> P1`, `Medium -> P2`, `Low -> P3`.
- Effort: `Low -> S`, `Medium -> M`, `High -> L`.

Depois acrescenta `P4/P5`, `XS/XL`, `Workflow` e `Wave`. O nome `Status`
e reservado pelo GitHub e nao pode ser usado em um Issue Field customizado.

Requisito: token de administrador da organizacao com escopo `admin:org` ou
permissao granular de escrita em Issue Fields.

## Migracao Health

As issues abertas pela auditoria de conformidade dos coletores Health podem
ser normalizadas por:

```bash
./scripts/migrate-health-audit-issues.sh
```

O script remove o prefixo `[P0]` a `[P5]` do titulo, aplica Priority,
Workflow `Backlog`, Issue Type, `area:collector` e o label `tech:*`
correspondente. A execucao e idempotente.

Valide toda a migracao com:

```bash
./scripts/validate-health-audit-issues.sh
```

## Planejamento de issues abertas

O inventario consulta somente dados de leitura do GitHub e grava as issues
abertas da organizacao em `artifacts/open-issues.json`:

```bash
node scripts/inventory-open-issues.mjs
```

O dry-run nao altera issues, campos, labels nem projetos. Ele le o inventario,
as regras e os overrides, depois grava o plano proposto:

```bash
node scripts/classify-open-issues.mjs \
  --input artifacts/open-issues.json \
  --output artifacts/issue-classification-plan.json
```

Cada item do plano mostra os campos `current`, `proposed`, `sources`,
`ambiguous` e `warnings`. O resumo informa quantos campos foram preservados e
quantos foram propostos. Os codigos de saida sao:

- `0`: plano completo, sem ambiguidades.
- `2`: plano gravado, mas ha classificacoes ambiguas para resolver.
- `1`: erro de leitura, configuracao ou escrita; nenhum plano confiavel foi gerado.

Resolva cada ambiguidade em
`config/issue-classification-overrides.json`, usando a chave
`organizacao/repositorio#numero`. Todo override que definir classificacao deve
incluir `reason`; overrides sem justificativa falham antes do dry-run.

```json
{
  "Siltech-Consult/Report-Worker#79": {
    "Priority": "P1",
    "Effort": "XL",
    "Wave": "Onda 1",
    "reason": "Epico de fundacao que agrega entregas da Onda 1"
  }
}
```

## Formularios

Os formularios em `.github/ISSUE_TEMPLATE` funcionam como padrao para
repositorios publicos da organizacao que nao tenham formularios proprios.
Cada formulario define o Issue Type correspondente.

## Regras

1. Bug descreve comportamento incorreto, regressao ou risco operacional.
2. Feature descreve capacidade nova percebida por usuario ou integracao.
3. Task descreve manutencao, teste, documentacao, CI ou trabalho interno.
4. P0 bloqueia operacao, seguranca ou confiabilidade basica.
5. P1 deve entrar no proximo ciclo de execucao.
6. P2 e importante, mas pode ser planejado sem interromper entregas atuais.
7. P3-P5 seguem backlog progressivo.
