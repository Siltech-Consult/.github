import test from "node:test";
import assert from "node:assert/strict";
import {chmod, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {
  applyClassificationPlan,
  buildIssueFieldPayload,
  fetchIssueFields
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

function issueFieldEndpoint(args) {
  return args.find((arg) => String(arg).includes("/issue-field-values"));
}

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
      if (issueFieldEndpoint(args)) {
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

test("rele e remonta payload em cada retry de mutacao", async () => {
  const payloads = [];
  let reads = 0;
  const result = await applyClassificationPlan({
    plan: {summary: {ambiguous: 0}, items: [item]},
    fieldIds,
    apply: true,
    sleep: async () => {},
    retrySleep: async () => {},
    runGh: async (args, {input} = {}) => {
      const endpoint = issueFieldEndpoint(args);
      if (!args.includes("--method") && endpoint) {
        reads += 1;
        return reads === 1
          ? [{issue_field_name: "Priority", single_select_option: {name: "P1"}}]
          : [
            {issue_field_name: "Priority", single_select_option: {name: "P1"}},
            {issue_field_name: "Workflow", single_select_option: {name: "Ready"}}
          ];
      }
      if (args.includes("--method")) {
        payloads.push(JSON.parse(input));
        if (payloads.length === 1) {
          const error = new Error("rate limited");
          error.status = 429;
          throw error;
        }
      }
      return {};
    }
  });

  assert.equal(reads, 2);
  assert.deepEqual(payloads.map((payload) => payload.issue_field_values.map((value) => value.field_id)), [
    [2, 3, 4],
    [3, 4]
  ]);
  assert.deepEqual(result.items[0].attempted_fields, ["Effort", "Wave"]);
});

test("le todas as paginas de Issue Fields antes de aplicar", async () => {
  const pages = [];
  const fields = await fetchIssueFields({
    repository: "Siltech-Consult/demo",
    number: 7,
    runGh: async (args) => {
      const endpoint = issueFieldEndpoint(args);
      pages.push(endpoint);
      if (endpoint.endsWith("page=1")) {
        return Array.from({length: 100}, (_, index) => ({
          issue_field_name: `Extra ${index}`,
          single_select_option: {name: "unused"}
        }));
      }
      return [{issue_field_name: "Priority", single_select_option: {name: "P1"}}];
    }
  });

  assert.equal(pages.length, 2);
  assert.equal(fields.Priority, "P1");
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

test("inicializa e atualiza checkpoint duravel antes de mutacoes e apos falha", async () => {
  const checkpoints = [];
  const failedItem = {...item, number: 8, current: {}, proposed: {
    Priority: "P2", Workflow: "Backlog", Effort: "M", Wave: "Onda 2"
  }};
  const result = await applyClassificationPlan({
    plan: {generated_at: "2026-07-27T00:00:00Z", summary: {ambiguous: 0}, items: [item, failedItem]},
    fieldIds,
    apply: true,
    sleep: async () => {},
    checkpoint: async (state) => checkpoints.push(JSON.parse(JSON.stringify(state))),
    runGh: async (args) => {
      const endpoint = issueFieldEndpoint(args);
      if (!args.includes("--method") && endpoint) {
        return endpoint.includes("/8/")
          ? [{issue_field_name: "Workflow", single_select_option: {name: "Ready"}}]
          : [];
      }
      if (args.includes("--method") && endpoint.includes("/8/")) {
        const error = new Error("invalid field value");
        error.status = 422;
        throw error;
      }
      return {};
    }
  });

  assert.deepEqual(checkpoints[0].items, []);
  const preparedFailure = checkpoints.filter((state) => state.items.some((entry) =>
    entry.number === 8 && entry.status === "pending")).at(-1);
  assert.deepEqual(preparedFailure.items.find((entry) => entry.number === 8).attempted_fields, [
    "Priority", "Effort", "Wave"
  ]);
  assert.equal(result.items.find((entry) => entry.number === 8).status, "failed");
  assert.deepEqual(result.items.find((entry) => entry.number === 8).attempted_fields, [
    "Priority", "Effort", "Wave"
  ]);
  assert.deepEqual(result.items.find((entry) => entry.number === 8).changed_since_plan, {
    Workflow: {planned: null, current: "Ready"}
  });
});

test("retoma checkpoint sem repetir issue ja aplicada", async () => {
  const laterItem = {...item, number: 8, current: {}, proposed: {
    Priority: "P2", Workflow: "Backlog", Effort: "M", Wave: "Onda 2"
  }};
  const calls = [];
  const result = await applyClassificationPlan({
    plan: {generated_at: "2026-07-27T00:00:00Z", summary: {ambiguous: 0}, items: [item, laterItem]},
    fieldIds,
    apply: true,
    sleep: async () => {},
    resumeResult: {
      plan_generated_at: "2026-07-27T00:00:00Z",
      items: [
        {repository: item.repository, number: item.number, status: "applied"},
        {repository: laterItem.repository, number: laterItem.number, status: "failed"}
      ]
    },
    runGh: async (args) => {
      calls.push(args);
      if (!args.includes("--method")) return [];
      return {};
    }
  });

  assert.equal(calls.some((args) => issueFieldEndpoint(args)?.includes("/7/")), false);
  assert.equal(calls.some((args) => issueFieldEndpoint(args)?.includes("/8/")), true);
  assert.equal(result.items.find((entry) => entry.number === 8).attempts, 1);
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
    },
    result: {items: []}
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

test("auditoria protege valor preenchido depois do plano", () => {
  const audit = auditOpenIssueClassification({
    plan: {items: [{repository: "Siltech-Consult/demo", number: 1, current: {}}]},
    result: {
      items: [{
        repository: "Siltech-Consult/demo",
        number: 1,
        changed_since_plan: {Workflow: {planned: null, current: "Ready"}}
      }]
    },
    issues: [{
      repository: "Siltech-Consult/demo",
      number: 1,
      fields: {Priority: "P1", Workflow: "Backlog", Effort: "M", Wave: "Onda 1"}
    }],
    officialOptions: {
      Priority: ["P1"], Workflow: ["Ready", "Backlog"], Effort: ["M"], Wave: ["Onda 1"]
    }
  });

  assert.deepEqual(audit.failures, [{
    type: "changed_since_plan_value_changed",
    issue: "Siltech-Consult/demo#1",
    field: "Workflow",
    expected: "Ready",
    audited: "Backlog"
  }]);
});

test("auditoria verifica campos de issues abertas que nao estavam no plano", () => {
  const audit = auditOpenIssueClassification({
    plan: {items: [{repository: "Siltech-Consult/demo", number: 1, current: {}}]},
    result: {items: []},
    issues: [
      {
        repository: "Siltech-Consult/demo",
        number: 1,
        fields: {Priority: "P1", Workflow: "Backlog", Effort: "M", Wave: "Onda 1"}
      },
      {
        repository: "Siltech-Consult/demo",
        number: 2,
        fields: {Priority: "P99", Effort: "M", Wave: "Onda 1"}
      }
    ],
    officialOptions: {
      Priority: ["P1"], Workflow: ["Backlog"], Effort: ["M"], Wave: ["Onda 1"]
    }
  });

  assert.equal(audit.failures.some((failure) =>
    failure.issue === "Siltech-Consult/demo#2" && failure.type === "invalid_option"), true);
  assert.equal(audit.failures.some((failure) =>
    failure.issue === "Siltech-Consult/demo#2" && failure.type === "missing_field" && failure.field === "Workflow"), true);
});
