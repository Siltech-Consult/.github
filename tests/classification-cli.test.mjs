import test from "node:test";
import assert from "node:assert/strict";
import {buildClassificationPlan, validateOverrides} from "../scripts/lib/report.mjs";

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

test("override com classificacao exige justificativa", () => {
  assert.throws(() => validateOverrides({
    "Siltech-Consult/demo#1": {Priority: "P1"}
  }), /sem justificativa/i);
});

test("JSON do plano usa contadores do contrato de dry-run", () => {
  const plan = buildClassificationPlan([], {
    classify: () => assert.fail("classify nao deve ser chamado")
  });

  assert.deepEqual(Object.keys(plan.summary).sort(), [
    "ambiguous",
    "complete",
    "preserved_fields",
    "proposed_fields",
    "total"
  ]);
});
