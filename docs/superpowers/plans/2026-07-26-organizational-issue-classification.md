# Organizational Issue Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classificar todos os issues abertos da Siltech-Consult sem sobrescrever valores existentes e criar o Project privado `Siltech Delivery` com os Issue Fields oficiais.

**Architecture:** Um nucleo Node.js puro classifica snapshots JSON por regras versionadas e excecoes explicitas. Adaptadores finos usam `gh` para inventario, dry-run, aplicacao idempotente, auditoria e criacao do Project; a configuracao das views usa o navegador porque o schema GraphQL atual nao oferece mutacoes de views.

**Tech Stack:** Node.js 22 LTS sem dependencias externas, `node:test`, GitHub CLI, GitHub REST API `2026-03-10`, GitHub GraphQL API, Bash 3 compativel e `jq`.

## Global Constraints

- Preservar qualquer valor existente de Priority, Workflow, Effort ou Wave.
- Nunca fechar, renomear ou remover um issue.
- Nunca remover labels ou prefixos legados nesta rodada.
- Dry-run e auditoria sao obrigatorios antes e depois da aplicacao.
- Issues ambiguos nao podem ser alterados sem override versionado.
- Chamadas de escrita usam lotes pequenos, retry exponencial e pausa entre issues.
- Issue Fields organizacionais sao a fonte oficial; nao criar campos duplicados no Project.
- O Project deve ser privado para a organizacao.
- A contagem de referencia e 173 issues abertos em 2026-07-26; a execucao deve aceitar crescimento posterior.

---

### Task 1: Runtime de testes e modelo de regras

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `config/issue-classification-rules.json`
- Create: `config/issue-classification-overrides.json`
- Create: `scripts/lib/classification.mjs`
- Create: `tests/classification.test.mjs`
- Modify: `tests/governance-scripts.test.sh`

**Interfaces:**
- Consumes: snapshot com `{repository, number, title, body, labels, type, fields, linkedPullRequests}`.
- Produces: `classifyIssue(issue, rules, overrides): ClassificationResult`.
- `ClassificationResult` contem `current`, `proposed`, `sources`, `ambiguous` e `warnings`.

- [ ] **Step 1: Criar o teste falhando do contrato de classificacao**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { classifyIssue } from "../scripts/lib/classification.mjs";

const rules = {
  priorityLabels: ["P0", "P1", "P2", "P3", "P4", "P5"],
  frozenLabels: ["status:congelado"],
  waveLabels: {
    "onda-1": "Onda 1",
    "onda-2": "Onda 2",
    "onda-3": "Futuro",
    "fase-2": "Futuro"
  }
};

test("preserva campos existentes", () => {
  const result = classifyIssue({
    repository: "Siltech-Consult/Windows_Health",
    number: 25,
    title: "Publicar release",
    body: "",
    labels: ["priority:p0"],
    fields: {
      Priority: "P1",
      Workflow: "Ready",
      Effort: "S",
      Wave: "Onda 2"
    },
    linkedPullRequests: []
  }, rules, {});

  assert.deepEqual(result.proposed, {
    Priority: "P1",
    Workflow: "Ready",
    Effort: "S",
    Wave: "Onda 2"
  });
  assert.equal(result.ambiguous, false);
});

test("congelado recebe Frozen e Futuro", () => {
  const result = classifyIssue({
    repository: "Siltech-Consult/Report-Worker",
    number: 52,
    title: "Integrar IIS",
    body: "",
    labels: ["status:congelado"],
    fields: {},
    linkedPullRequests: []
  }, rules, {});

  assert.equal(result.proposed.Workflow, "Frozen");
  assert.equal(result.proposed.Wave, "Futuro");
});

test("PR aberto define In progress", () => {
  const result = classifyIssue({
    repository: "Siltech-Consult/siltech_put",
    number: 4,
    title: "Contrato S3",
    body: "",
    labels: ["onda-1"],
    fields: {},
    linkedPullRequests: [{state: "OPEN", merged: false}]
  }, rules, {});

  assert.equal(result.proposed.Workflow, "In progress");
  assert.equal(result.proposed.Wave, "Onda 1");
});

test("override resolve ambiguidade com justificativa", () => {
  const key = "Siltech-Consult/Report-Worker#79";
  const result = classifyIssue({
    repository: "Siltech-Consult/Report-Worker",
    number: 79,
    title: "Epico v2.0",
    body: "",
    labels: ["onda-1"],
    fields: {},
    linkedPullRequests: []
  }, rules, {
    [key]: {
      Effort: "XL",
      Priority: "P1",
      reason: "Epico de fundacao da Onda 1"
    }
  });

  assert.equal(result.proposed.Effort, "XL");
  assert.equal(result.proposed.Priority, "P1");
  assert.match(result.sources.Effort, /override/);
});
```

- [ ] **Step 2: Executar o teste e confirmar a falha**

Run: `node --test tests/classification.test.mjs`

Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `classification.mjs`.

- [ ] **Step 3: Criar runtime e regras versionadas**

`package.json`:

```json
{
  "name": "@siltech-consult/github-governance",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22 <25"
  },
  "scripts": {
    "test": "bash tests/governance-scripts.test.sh && node --test tests/*.test.mjs"
  }
}
```

`.gitignore`:

```gitignore
artifacts/
node_modules/
.DS_Store
```

`config/issue-classification-rules.json` deve conter:

```json
{
  "priorityLabels": ["P0", "P1", "P2", "P3", "P4", "P5"],
  "frozenLabels": ["status:congelado"],
  "waveLabels": {
    "onda-1": "Onda 1",
    "onda-2": "Onda 2",
    "onda-3": "Futuro",
    "fase-2": "Futuro"
  },
  "collectorRepositories": [
    "Windows_Health",
    "SQLServer_Health",
    "Linux_Health",
    "Oracle_Health",
    "IIS_Health",
    "nginx_health",
    "aws_health"
  ],
  "effortPatterns": {
    "XS": ["changelog", "comentario", "texto"],
    "S": ["documentar", "readme", "release", "--version", "ci minimo", "migrar ci"],
    "L": ["integrar", "migrar banco", "modulo", "arquitetura", "api m2m"],
    "XL": ["epico", "multi-tenant", "multi-tecnologia"]
  }
}
```

`config/issue-classification-overrides.json` inicia como `{}`. O modulo deve:

- normalizar labels para lowercase;
- preservar campos existentes antes de qualquer regra;
- registrar a origem de cada valor;
- aplicar override antes dos defaults, mas nunca sobre campo existente;
- marcar `ambiguous=true` quando um campo continuar sem valor;
- usar defaults apenas depois das regras:
  - Priority P2;
  - Workflow Backlog;
  - Effort M;
  - Wave por Priority: P0/P1 Onda 1, P2 Onda 2, P3-P5 Futuro.

- [ ] **Step 4: Executar testes**

Run: `npm test`

Expected: todos os testes Bash e Node passam.

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore config scripts/lib/classification.mjs tests
git commit -m "feat: add deterministic issue classifier"
```

---

### Task 2: Inventario GitHub e estado de pull requests

**Files:**
- Create: `scripts/lib/github-client.mjs`
- Create: `scripts/inventory-open-issues.mjs`
- Create: `tests/github-client.test.mjs`
- Create: `tests/fixtures/open-issues.json`

**Interfaces:**
- Consumes: `ORG`, caminho de saida e executavel `gh`.
- Produces: `inventoryOpenIssues({org, outputPath, runGh}): Promise<IssueSnapshot[]>`.
- `runGh(args)` retorna JSON parseado e permite stub nos testes.

- [ ] **Step 1: Criar teste falhando do inventario**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { inventoryOpenIssues } from "../scripts/lib/github-client.mjs";

test("normaliza campos e PRs vinculados", async () => {
  const calls = [];
  const runGh = async (args) => {
    calls.push(args);
    if (args.includes("search")) {
      return [{
        id: "I_1",
        repository: {nameWithOwner: "Siltech-Consult/demo"},
        number: 7,
        title: "[P1] Corrigir parser",
        body: "Falha atual",
        labels: [{name: "bug"}]
      }];
    }
    return {
      fields: {Priority: null, Workflow: null, Effort: null, Wave: null},
      linkedPullRequests: [{state: "OPEN", merged: false}]
    };
  };

  const issues = await inventoryOpenIssues({
    org: "Siltech-Consult",
    runGh
  });

  assert.equal(issues.length, 1);
  assert.equal(issues[0].repository, "Siltech-Consult/demo");
  assert.equal(issues[0].linkedPullRequests[0].state, "OPEN");
  assert.ok(calls.length >= 2);
});
```

- [ ] **Step 2: Executar o teste e confirmar a falha**

Run: `node --test tests/github-client.test.mjs`

Expected: FAIL com export ausente.

- [ ] **Step 3: Implementar cliente e CLI**

O cliente deve executar:

```bash
gh search issues --owner Siltech-Consult --state open --limit 1000 \
  --json id,repository,number,title,body,labels,createdAt,updatedAt,url
```

Depois consultar os IDs em lotes de no maximo 100 via GraphQL:

```graphql
query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Issue {
      id
      number
      repository { nameWithOwner }
      issueType { name }
      issueFieldValues(first: 20) {
        nodes {
          ... on IssueFieldSingleSelectValue {
            field { ... on IssueFieldSingleSelect { name } }
            name
          }
        }
      }
      closedByPullRequestsReferences(first: 20) {
        nodes { state merged }
      }
    }
  }
}
```

O CLI grava JSON atomico em `artifacts/open-issues.json`, usando arquivo
temporario seguido de rename.

- [ ] **Step 4: Executar testes**

Run: `npm test`

Expected: todos passam.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/github-client.mjs scripts/inventory-open-issues.mjs tests
git commit -m "feat: inventory organization issues"
```

---

### Task 3: Dry-run, excecoes e relatorio de classificacao

**Files:**
- Create: `scripts/classify-open-issues.mjs`
- Create: `scripts/lib/report.mjs`
- Create: `tests/classification-cli.test.mjs`
- Modify: `config/issue-classification-overrides.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: `artifacts/open-issues.json`, regras e overrides.
- Produces: `artifacts/issue-classification-plan.json` e resumo no terminal.
- Exit code 0 significa plano completo; 2 significa ambiguidades; 1 significa erro.

- [ ] **Step 1: Criar teste falhando do dry-run**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { buildClassificationPlan } from "../scripts/lib/report.mjs";

test("plano informa preservados, propostos e ambiguidades", () => {
  const plan = buildClassificationPlan([{
    repository: "Siltech-Consult/demo",
    number: 1,
    title: "Documentar execucao",
    body: "",
    labels: [],
    fields: {Priority: "P1"},
    linkedPullRequests: []
  }], {
    classify: () => ({
      current: {Priority: "P1"},
      proposed: {
        Priority: "P1",
        Workflow: "Backlog",
        Effort: "S",
        Wave: "Onda 1"
      },
      sources: {
        Priority: "existing",
        Workflow: "default",
        Effort: "pattern:documentar",
        Wave: "priority:P1"
      },
      ambiguous: false,
      warnings: []
    })
  });

  assert.equal(plan.summary.total, 1);
  assert.equal(plan.summary.preserved, 1);
  assert.equal(plan.summary.ambiguous, 0);
  assert.equal(plan.items[0].proposed.Effort, "S");
});
```

- [ ] **Step 2: Executar o teste e confirmar a falha**

Run: `node --test tests/classification-cli.test.mjs`

Expected: FAIL com export ausente.

- [ ] **Step 3: Implementar relatorio e CLI**

O JSON final deve usar:

```json
{
  "generated_at": "ISO-8601",
  "organization": "Siltech-Consult",
  "summary": {
    "total": 173,
    "complete": 173,
    "ambiguous": 0,
    "preserved_fields": 124,
    "proposed_fields": 568
  },
  "items": [
    {
      "repository": "Siltech-Consult/demo",
      "number": 1,
      "url": "https://github.com/Siltech-Consult/demo/issues/1",
      "current": {},
      "proposed": {
        "Priority": "P2",
        "Workflow": "Backlog",
        "Effort": "S",
        "Wave": "Onda 2"
      },
      "sources": {
        "Priority": "default",
        "Workflow": "default",
        "Effort": "pattern:documentar",
        "Wave": "priority:P2"
      },
      "ambiguous": false,
      "warnings": []
    }
  ]
}
```

O CLI aceita:

```bash
node scripts/classify-open-issues.mjs \
  --input artifacts/open-issues.json \
  --output artifacts/issue-classification-plan.json
```

Documentar no README os comandos de inventario, dry-run e interpretacao dos
exit codes.

- [ ] **Step 4: Executar dry-run real**

Run:

```bash
node scripts/inventory-open-issues.mjs
node scripts/classify-open-issues.mjs
jq '.summary' artifacts/issue-classification-plan.json
```

Expected: `total` igual ao inventario; `complete` igual ao total; `ambiguous`
igual a zero.

- [ ] **Step 5: Resolver ambiguidades por override**

Para cada item ambiguo, acrescentar uma entrada:

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

Executar novamente o dry-run ate obter zero ambiguidades. Overrides sem
`reason` devem falhar nos testes.

- [ ] **Step 6: Commit**

```bash
git add config/issue-classification-overrides.json scripts README.md tests
git commit -m "feat: generate issue classification dry run"
```

---

### Task 4: Aplicacao idempotente e auditoria

**Files:**
- Create: `scripts/apply-issue-classification.mjs`
- Create: `scripts/validate-open-issue-classification.mjs`
- Create: `scripts/lib/retry.mjs`
- Create: `tests/apply-classification.test.mjs`
- Create: `tests/retry.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: plano completo gerado na Task 3.
- Produces: atualizacoes REST e `artifacts/issue-classification-result.json`.
- `withRetry(operation, options)` usa atrasos 1s, 2s, 4s, 8s e no maximo cinco tentativas.

- [ ] **Step 1: Criar testes falhando de aplicacao e retry**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { buildIssueFieldPayload } from "../scripts/apply-issue-classification.mjs";

test("envia somente campos que estavam vazios", () => {
  const payload = buildIssueFieldPayload({
    current: {Priority: "P1"},
    proposed: {
      Priority: "P1",
      Workflow: "Backlog",
      Effort: "M",
      Wave: "Onda 1"
    }
  }, {
    Priority: 1,
    Workflow: 2,
    Effort: 3,
    Wave: 4
  });

  assert.deepEqual(payload.issue_field_values, [
    {field_id: 2, value: "Backlog"},
    {field_id: 3, value: "M"},
    {field_id: 4, value: "Onda 1"}
  ]);
});
```

```js
import { withRetry } from "../scripts/lib/retry.mjs";

test("retry recupera falha transitiva", async () => {
  let attempts = 0;
  const value = await withRetry(async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error("secondary rate limit");
      error.status = 403;
      throw error;
    }
    return "ok";
  }, {sleep: async () => {}, delays: [1, 2, 4, 8]});

  assert.equal(value, "ok");
  assert.equal(attempts, 3);
});
```

- [ ] **Step 2: Executar testes e confirmar falhas**

Run: `node --test tests/apply-classification.test.mjs tests/retry.test.mjs`

Expected: FAIL com exports ausentes.

- [ ] **Step 3: Implementar aplicacao**

Para cada issue, consultar novamente os campos imediatamente antes da escrita.
Se um campo foi preenchido depois do dry-run, preserva-lo e registrar
`changed_since_plan`. Enviar somente campos vazios:

```http
POST /repos/{owner}/{repo}/issues/{number}/issue-field-values
X-GitHub-Api-Version: 2026-03-10

{
  "issue_field_values": [
    {"field_id": 1, "value": "P2"},
    {"field_id": 2, "value": "Backlog"},
    {"field_id": 3, "value": "M"},
    {"field_id": 4, "value": "Onda 2"}
  ]
}
```

Aplicar 20 issues por lote, com pausa de dois segundos entre lotes e 250 ms
entre issues. O CLI exige `--apply`; sem essa flag, deve recusar escrita.

- [ ] **Step 4: Implementar auditoria**

O validador gera novo inventario e falha quando:

- algum issue aberto nao possui os quatro campos;
- algum valor anterior mudou;
- existe valor fora das opcoes oficiais;
- a quantidade auditada diverge do inventario atual.

Run:

```bash
node scripts/validate-open-issue-classification.mjs \
  --plan artifacts/issue-classification-plan.json \
  --output artifacts/issue-classification-audit.json
```

- [ ] **Step 5: Executar testes**

Run: `npm test`

Expected: todos passam.

- [ ] **Step 6: Aplicar e auditar no GitHub**

Run:

```bash
node scripts/apply-issue-classification.mjs \
  --plan artifacts/issue-classification-plan.json \
  --apply
node scripts/validate-open-issue-classification.mjs \
  --plan artifacts/issue-classification-plan.json
```

Expected: todos os issues abertos completos, zero sobrescritos e zero falhas.

- [ ] **Step 7: Commit**

```bash
git add scripts README.md tests
git commit -m "feat: apply and audit issue classification"
```

---

### Task 5: Project `Siltech Delivery`

**Files:**
- Create: `scripts/create-delivery-project.mjs`
- Create: `scripts/validate-delivery-project.mjs`
- Create: `tests/delivery-project.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: inventario auditado e os IDs organizacionais de Issue Fields.
- Produces: ProjectV2 privado, campos associados e todos os issues adicionados.
- Reexecucao encontra o Project por titulo e adiciona apenas itens ausentes.

- [ ] **Step 1: Criar teste falhando do plano do Project**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { buildProjectOperations } from "../scripts/create-delivery-project.mjs";

test("nao duplica campos nem itens existentes", () => {
  const operations = buildProjectOperations({
    project: {
      id: "PVT_1",
      issueFieldIds: ["IF_PRIORITY"],
      contentIds: ["I_1"]
    },
    requiredIssueFields: {
      Priority: "IF_PRIORITY",
      Workflow: "IF_WORKFLOW",
      Effort: "IF_EFFORT",
      Wave: "IF_WAVE"
    },
    issues: [{id: "I_1"}, {id: "I_2"}]
  });

  assert.deepEqual(operations.addIssueFields, [
    "IF_WORKFLOW",
    "IF_EFFORT",
    "IF_WAVE"
  ]);
  assert.deepEqual(operations.addItems, ["I_2"]);
});
```

- [ ] **Step 2: Executar teste e confirmar falha**

Run: `node --test tests/delivery-project.test.mjs`

Expected: FAIL com export ausente.

- [ ] **Step 3: Implementar criacao idempotente**

Criar o Project quando ausente:

```graphql
mutation($ownerId: ID!, $title: String!) {
  createProjectV2(input: {ownerId: $ownerId, title: $title}) {
    projectV2 { id number title url }
  }
}
```

Associar cada Issue Field:

```graphql
mutation($projectId: ID!, $issueFieldId: ID!) {
  createProjectV2IssueField(
    input: {projectId: $projectId, issueFieldId: $issueFieldId}
  ) {
    projectV2IssueField { id }
  }
}
```

Adicionar cada issue:

```graphql
mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(
    input: {projectId: $projectId, contentId: $contentId}
  ) {
    item { id }
  }
}
```

O script deve confirmar que o Project e privado, registrar URL e numero e
adicionar itens em lotes com retry.

- [ ] **Step 4: Implementar validador**

O validador consulta o Project e compara:

- titulo `Siltech Delivery`;
- owner `Siltech-Consult`;
- visibilidade privada;
- quatro Issue Fields organizacionais associados;
- todos os content IDs do inventario presentes;
- nenhum campo de projeto duplicado com os nomes oficiais.

- [ ] **Step 5: Executar testes**

Run: `npm test`

Expected: todos passam.

- [ ] **Step 6: Criar e validar Project**

Run:

```bash
node scripts/create-delivery-project.mjs \
  --inventory artifacts/open-issues.json \
  --apply
node scripts/validate-delivery-project.mjs \
  --inventory artifacts/open-issues.json
```

Expected: Project criado ou reutilizado, todos os issues presentes e campos sem
duplicacao.

- [ ] **Step 7: Commit**

```bash
git add scripts README.md tests
git commit -m "feat: create consolidated delivery project"
```

---

### Task 6: Views, validacao visual e publicacao

**Files:**
- Create: `docs/siltech-delivery-project.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: URL do Project criado na Task 5.
- Produces: oito views configuradas e runbook de manutencao.

- [ ] **Step 1: Configurar views no navegador**

Abrir o Project autenticado e configurar:

| View | Layout | Filter | Group | Sort |
|---|---|---|---|---|
| Triage | Table | `field.workflow:Backlog` | Priority | Priority asc |
| P0 e P1 | Table | `field.priority:P0,P1 -field.workflow:Frozen,Done` | Workflow | Priority asc |
| Onda 1 | Board | `field.wave:"Onda 1"` | Workflow | Priority asc |
| Em andamento | Table | `field.workflow:"In progress"` | Repository | Priority asc |
| Bloqueados | Table | `field.workflow:Blocked` | Repository | Priority asc |
| Validacao | Table | `field.workflow:Validation` | Repository | Priority asc |
| Congelados e Futuro | Table | `field.workflow:Frozen,field.wave:Futuro` | Wave | Priority asc |
| Por repositorio | Table | sem filtro | Repository | Priority asc |

Em todas as tabelas, mostrar Title, Repository, Type, Priority, Workflow,
Effort, Wave, Assignees e Updated.

- [ ] **Step 2: Validar visualmente**

Confirmar:

- cada view abre sem erro;
- filtros retornam itens coerentes;
- `Onda 1` usa colunas de Workflow;
- campos editados no Project aparecem no issue original;
- nenhuma coluna Priority, Workflow, Effort ou Wave esta duplicada.

- [ ] **Step 3: Escrever runbook**

`docs/siltech-delivery-project.md` deve registrar:

- URL e finalidade do Project;
- significado das oito views;
- como mover Workflow;
- como executar inventario, dry-run, aplicacao e auditoria;
- como adicionar novos issues ao Project;
- regra de nao sobrescrever valores existentes;
- procedimento de rotacao do token usado pelas automacoes.

- [ ] **Step 4: Executar verificacao final**

Run:

```bash
npm test
node scripts/validate-open-issue-classification.mjs \
  --plan artifacts/issue-classification-plan.json
node scripts/validate-delivery-project.mjs \
  --inventory artifacts/open-issues.json
git diff --check
git status --short
```

Expected: testes e validadores passam; somente documentacao final aparece como
nao commitada.

- [ ] **Step 5: Commit e push**

```bash
git add README.md docs/siltech-delivery-project.md
git commit -m "docs: publish Siltech Delivery runbook"
git push origin main
```

