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

const effortRules = {
  ...rules,
  effortPatterns: {
    XS: ["changelog", "comentario", "texto"],
    S: ["documentar", "readme", "release"],
    L: ["integrar", "arquitetura"],
    XL: ["epico", "multi-tenant"]
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

test("le prioridade em titulo com prefixos compostos", () => {
  for (const [title, expected] of [
    ["[Bug][P0] Correlacionar identidades", "P0"],
    ["[Incidentes][P1] Separar qualidade", "P1"],
    ["P2 - Melhorar fallback", "P2"]
  ]) {
    const result = classifyIssue({
      repository: "Siltech-Consult/Report-Worker",
      number: 1,
      title,
      body: "",
      labels: [],
      fields: {},
      linkedPullRequests: []
    }, rules, {});

    assert.equal(result.proposed.Priority, expected);
  }
});

test("valores nulos e vazios recebem classificacao", () => {
  const result = classifyIssue({
    repository: "Siltech-Consult/Report-Worker",
    number: 80,
    title: "Documentar release",
    body: "",
    labels: ["PRIORITY:P1", "ONDA-1"],
    fields: {
      Priority: null,
      Workflow: "",
      Effort: undefined,
      Wave: "  "
    },
    linkedPullRequests: []
  }, effortRules, {});

  assert.deepEqual(result.proposed, {
    Priority: "P1",
    Workflow: "Backlog",
    Effort: "S",
    Wave: "Onda 1"
  });
  assert.equal(result.ambiguous, false);
});

test("esforco escolhe maior sinal e registra advertencia", () => {
  const result = classifyIssue({
    repository: "Siltech-Consult/Report-Worker",
    number: 81,
    title: "Documentar e integrar epico multi-tenant",
    body: "",
    labels: [],
    fields: {},
    linkedPullRequests: []
  }, effortRules, {});

  assert.equal(result.proposed.Effort, "XL");
  assert.match(result.sources.Effort, /maior.*XL/i);
  assert.match(result.warnings.join(" "), /XL/i);
  assert.equal(result.ambiguous, false);
});

test("conflito de esforco sem ranking permanece ambiguo", () => {
  const result = classifyIssue({
    repository: "Siltech-Consult/Report-Worker",
    number: 82,
    title: "Trabalho especial",
    body: "",
    labels: [],
    fields: {},
    linkedPullRequests: []
  }, {
    ...rules,
    effortPatterns: {
      customA: ["trabalho"],
      customB: ["especial"]
    }
  }, {});

  assert.equal(result.proposed.Effort, undefined);
  assert.equal(result.ambiguous, true);
  assert.match(result.warnings.join(" "), /sem ranking/i);
});

test("prefixo de titulo define prioridade depois dos labels", () => {
  const result = classifyIssue({
    repository: "Siltech-Consult/Report-Worker",
    number: 83,
    title: "[P0] P1: publicar release",
    body: "",
    labels: ["priority:p2"],
    fields: {},
    linkedPullRequests: []
  }, rules, {});

  assert.equal(result.proposed.Priority, "P2");
  assert.match(result.sources.Priority, /label/);
});

test("prefixo P colon define prioridade quando nao ha label", () => {
  const result = classifyIssue({
    repository: "Siltech-Consult/Report-Worker",
    number: 84,
    title: "P4: publicar release",
    body: "",
    labels: [],
    fields: {},
    linkedPullRequests: []
  }, rules, {});

  assert.equal(result.proposed.Priority, "P4");
  assert.match(result.sources.Priority, /title prefix/);
});

test("PR merged define Validation", () => {
  const result = classifyIssue({
    repository: "Siltech-Consult/Report-Worker",
    number: 85,
    title: "Publicar release",
    body: "",
    labels: [],
    fields: {},
    linkedPullRequests: [{state: "MERGED", merged: true}]
  }, rules, {});

  assert.equal(result.proposed.Workflow, "Validation");
});

test("congelado prevalece sobre PR merged", () => {
  const result = classifyIssue({
    repository: "Siltech-Consult/Report-Worker",
    number: 86,
    title: "Publicar release",
    body: "",
    labels: ["status:congelado"],
    fields: {},
    linkedPullRequests: [{state: "MERGED", merged: true}]
  }, rules, {});

  assert.equal(result.proposed.Workflow, "Frozen");
});
