import test from "node:test";
import assert from "node:assert/strict";
import {chmod, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {
  applyClassificationPlan,
  buildIssueFieldPayload
} from "../scripts/apply-issue-classification.mjs";
import {auditOpenIssueClassification} from "../scripts/validate-open-issue-classification.mjs";

const fieldIds = {
  Priority: 1,
  Workflow: 2,
  Effort: 3,
  Wave: 4
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const applyScript = join(projectRoot, "scripts/apply-issue-classification.mjs");

const item = {
  repository: "Siltech-Consult/demo",
  number: 7,
  current: {Priority: "P1"},
  proposed: {
    Priority: "P1",
    Workflow: "Backlog",
    Effort: "M",
    Wave: "Onda 1"
  }
};

test("envia somente campos que estavam vazios", () => {
  const payload = buildIssueFieldPayload(item, fieldIds);

  assert.deepEqual(payload.issue_field_values, [
    {field_id: 2, value: "Backlog"},
    {field_id: 3, value: "M"},
    {field_id: 4, value: "Onda 1"}
  ]);
});

test("rele campos antes de escrever e preserva valor preenchido apos plano", async () => {
  const calls = [];
  const result = await applyClassificationPlan({
    plan: {summary: {ambiguous: 0}, items: [item]},
    fieldIds,
    apply: true,
    sleep: async () => {},
    runGh: async (args, {input} = {}) => {
      calls.push({args, input});
      if (args.at(-1).endsWith("/issue-field-values")) {
        return [
          {issue_field_name: "Priority", single_select_option: {name: "P1"}},
          {issue_field_name: "Workflow", single_select_option: {name: "Ready"}}
        ];
      }
      return {};
    }
  });

  assert.deepEqual(result.items[0].changed_since_plan, {
    Workflow: {planned: null, current: "Ready"}
  });
  const post = calls.find(({args}) => args.includes("--method"));
  assert.equal(post.args[post.args.indexOf("--input") + 1], "-");
  assert.deepEqual(JSON.parse(post.input), {
    issue_field_values: [
      {field_id: 3, value: "M"},
      {field_id: 4, value: "Onda 1"}
    ]
  });
});

test("recusa escrita quando apply nao foi confirmado", async () => {
  await assert.rejects(
    applyClassificationPlan({
      plan: {summary: {ambiguous: 0}, items: [item]},
      fieldIds,
      runGh: async () => {
        throw new Error("nao deve consultar GitHub");
      }
    }),
    /--apply/
  );
});

test("CLI recusa sem --apply antes de executar gh", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "apply-classification-cli-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const planPath = join(directory, "plan.json");
  const ghPath = join(directory, "gh");
  const markerPath = join(directory, "gh-called");
  await Promise.all([
    writeFile(planPath, JSON.stringify({summary: {ambiguous: 0}, items: [item]}), "utf8"),
    writeFile(ghPath, `#!/bin/sh\ntouch "${markerPath}"\nexit 99\n`, "utf8")
  ]);
  await chmod(ghPath, 0o755);

  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [applyScript, "--plan", planPath], {
      cwd: projectRoot,
      env: {...process.env, PATH: `${directory}:${process.env.PATH}`}
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({code, stderr}));
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /--apply/);
  await assert.rejects(readFile(markerPath, "utf8"));
});

test("auditoria aponta campos ausentes, mudanca, opcao invalida e inventario divergente", () => {
  const audit = auditOpenIssueClassification({
    plan: {
      summary: {total: 2},
      items: [
        {repository: "Siltech-Consult/demo", number: 1, current: {Priority: "P1"}},
        {repository: "Siltech-Consult/demo", number: 2, current: {}}
      ]
    },
    issues: [{
      repository: "Siltech-Consult/demo",
      number: 1,
      fields: {Priority: "P2", Workflow: "Backlog", Wave: "Onda 9"}
    }],
    officialOptions: {
      Priority: ["P0", "P1", "P2"],
      Workflow: ["Backlog"],
      Effort: ["M"],
      Wave: ["Onda 1"]
    }
  });

  assert.equal(audit.ok, false);
  assert.deepEqual(audit.failures.map((failure) => failure.type), [
    "inventory_count_mismatch",
    "previous_value_changed",
    "missing_field",
    "invalid_option",
    "missing_issue"
  ]);
});
