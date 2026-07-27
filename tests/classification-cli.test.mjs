import test from "node:test";
import assert from "node:assert/strict";
import {chmod, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {buildClassificationPlan, validateOverrides} from "../scripts/lib/report.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(projectRoot, "scripts/classify-open-issues.mjs");
const rules = {
  priorityLabels: ["P0", "P1", "P2", "P3", "P4", "P5"],
  frozenLabels: [],
  waveLabels: {},
  effortPatterns: {}
};

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function createCliFixture(t, {issues, fixtureRules = rules, overrides = {}} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "classification-cli-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const inputPath = join(directory, "input.json");
  const rulesPath = join(directory, "rules.json");
  const overridesPath = join(directory, "overrides.json");
  const outputPath = join(directory, "plan.json");
  const ghPath = join(directory, "gh");
  const ghMarkerPath = join(directory, "gh-called");
  await Promise.all([
    writeJson(inputPath, issues ?? []),
    writeJson(rulesPath, fixtureRules),
    writeJson(overridesPath, overrides),
    writeFile(ghPath, `#!/bin/sh\ntouch "${ghMarkerPath}"\nexit 99\n`, "utf8")
  ]);
  await chmod(ghPath, 0o755);
  return {directory, inputPath, rulesPath, overridesPath, outputPath, ghMarkerPath};
}

function runCli(fixture) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [
      cliPath,
      "--input", fixture.inputPath,
      "--rules", fixture.rulesPath,
      "--overrides", fixture.overridesPath,
      "--output", fixture.outputPath
    ], {
      cwd: projectRoot,
      env: {...process.env, PATH: `${fixture.directory}:${process.env.PATH}`}
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({code, stdout, stderr}));
  });
}

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
  assert.equal(plan.summary.preserved_fields, 1);
  assert.equal(plan.summary.preserved, undefined);
  assert.equal(plan.summary.ambiguous, 0);
  assert.equal(plan.items[0].proposed.Effort, "S");
});

test("contadores ignoram campos organizacionais fora da classificacao", () => {
  const plan = buildClassificationPlan([{}], {
    classify: () => ({
      current: {},
      proposed: {
        Priority: "P2",
        Workflow: "Backlog",
        Effort: "M",
        Wave: "Onda 2",
        Customer: "Acme",
        Milestone: "Julho"
      },
      sources: {
        Priority: "existing",
        Workflow: "default",
        Effort: "default",
        Wave: "default",
        Customer: "existing",
        Milestone: "default"
      },
      ambiguous: false,
      warnings: []
    })
  });

  assert.equal(plan.summary.preserved_fields, 1);
  assert.equal(plan.summary.proposed_fields, 3);
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

test("CLI retorna 0, ordena itens, grava atomicamente e nao executa gh", async (t) => {
  const fixture = await createCliFixture(t, {
    issues: [
      {repository: "Siltech-Consult/z", number: 1, title: "Z", fields: {}},
      {repository: "Siltech-Consult/a", number: 12, title: "A12", fields: {}},
      {repository: "Siltech-Consult/a", number: 2, title: "A2", fields: {}}
    ]
  });

  const result = await runCli(fixture);
  const plan = JSON.parse(await readFile(fixture.outputPath, "utf8"));
  const files = await readdir(fixture.directory);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(plan.items.map((item) => `${item.repository}#${item.number}`), [
    "Siltech-Consult/a#2",
    "Siltech-Consult/a#12",
    "Siltech-Consult/z#1"
  ]);
  assert.equal(files.some((file) => file.startsWith(".plan.json.") && file.endsWith(".tmp")), false);
  await assert.rejects(readFile(fixture.ghMarkerPath, "utf8"));
});

test("CLI retorna 2 e grava plano para classificacoes ambiguas", async (t) => {
  const fixture = await createCliFixture(t, {
    issues: [{repository: "Siltech-Consult/demo", number: 1, title: "Especial", fields: {}}],
    fixtureRules: {...rules, effortPatterns: {Custom: ["especial"]}}
  });

  const result = await runCli(fixture);
  const plan = JSON.parse(await readFile(fixture.outputPath, "utf8"));

  assert.equal(result.code, 2);
  assert.equal(plan.summary.ambiguous, 1);
});

test("CLI retorna 1 e preserva output anterior quando override e invalido", async (t) => {
  const fixture = await createCliFixture(t, {
    issues: [{repository: "Siltech-Consult/demo", number: 1, title: "Normal", fields: {}}],
    overrides: {"Siltech-Consult/demo#1": {Priority: "P1"}}
  });
  await writeFile(fixture.outputPath, "output-anterior\n", "utf8");

  const result = await runCli(fixture);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /sem justificativa/i);
  assert.equal(await readFile(fixture.outputPath, "utf8"), "output-anterior\n");
});
