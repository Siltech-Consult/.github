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
  fetchOrganizationFieldIds,
  fetchIssueFields
} from "../scripts/apply-issue-classification.mjs";
import {auditOpenIssueClassification} from "../scripts/validate-open-issue-classification.mjs";
import {canonicalPlanDigest} from "../scripts/lib/plan-digest.mjs";

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

const attemptPayload = {
  issue_field_values: [
    {field_id: 2, value: "Backlog"},
    {field_id: 3, value: "M"},
    {field_id: 4, value: "Onda 1"}
  ]
};

function attemptEntry(phase, outcome, payload = attemptPayload) {
  return {attempt: 1, phase, payload, changed_since_plan: {}, outcome};
}

function resumeRecord(status, attempts, entry = item) {
  return {
    repository: entry.repository,
    number: entry.number,
    status,
    attempted_fields: [],
    attempted_field_values: [],
    changed_since_plan: {},
    attempts
  };
}

function issueFieldEndpoint(args) {
  return args.find((arg) => String(arg).includes("/issue-field-values"));
}

function terminalResult(plan, changes = {}) {
  return {
    plan_digest: canonicalPlanDigest(plan),
    items: plan.items.map((entry) => ({
      repository: entry.repository,
      number: entry.number,
      status: "applied",
      attempts: [],
      changed_since_plan: changes[`${entry.repository}#${entry.number}`] ?? {}
    }))
  };
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

test("rele e remonta payload apos rejeicao 429 autoritativa do POST", async () => {
  const payloads = [];
  let reads = 0;
  let posts = 0;
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
        if (reads === 1) {
          return [{issue_field_name: "Priority", single_select_option: {name: "P1"}}];
        }
        return [
          {issue_field_name: "Priority", single_select_option: {name: "P1"}},
          {issue_field_name: "Workflow", single_select_option: {name: "Ready"}}
        ];
      }
      if (args.includes("--method")) {
        payloads.push(JSON.parse(input));
        posts += 1;
        if (posts === 1) {
          const error = new Error("rate limited");
          error.status = 429;
          throw error;
        }
      }
      return {};
    }
  });

  assert.equal(reads, 2);
  assert.deepEqual(payloads.map((payload) => payload.issue_field_values.map((value) => value.field_id)), [[2, 3, 4], [3, 4]]);
  assert.deepEqual(result.items[0].attempted_fields, ["Effort", "Wave"]);
});

test("repete POST para 403 de rate limit e 422 de spam qualificados", async () => {
  for (const rejection of [
    {status: 403, message: "secondary rate limit"},
    {status: 422, message: "Validation Failed: endpoint has been spammed"}
  ]) {
    let posts = 0;
    const result = await applyClassificationPlan({
      plan: {summary: {ambiguous: 0}, items: [item]},
      fieldIds,
      apply: true,
      sleep: async () => {},
      retrySleep: async () => {},
      runGh: async (args) => {
        if (!args.includes("--method")) return [];
        posts += 1;
        if (posts === 1) {
          const error = new Error(rejection.message);
          error.status = rejection.status;
          throw error;
        }
        return {};
      }
    });
    assert.equal(posts, 2);
    assert.equal(result.items[0].status, "applied");
  }
});

test("nao repete POST para 403 permanente", async () => {
  let posts = 0;
  const result = await applyClassificationPlan({
    plan: {summary: {ambiguous: 0}, items: [item]},
    fieldIds,
    apply: true,
    sleep: async () => {},
    retrySleep: async () => {},
    runGh: async (args) => {
      if (!args.includes("--method")) return [];
      posts += 1;
      const error = new Error("resource not accessible by integration");
      error.status = 403;
      throw error;
    }
  });

  assert.equal(posts, 1);
  assert.equal(result.items[0].status, "failed");
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

test("repete falha transitiva em pagina da leitura pre-escrita antes do POST", async () => {
  let secondPageReads = 0;
  let posts = 0;
  const result = await applyClassificationPlan({
    plan: {summary: {ambiguous: 0}, items: [item]},
    fieldIds,
    apply: true,
    sleep: async () => {},
    retrySleep: async () => {},
    runGh: async (args) => {
      const endpoint = issueFieldEndpoint(args);
      if (args.includes("--method")) {
        posts += 1;
        return {};
      }
      if (endpoint.endsWith("page=1")) {
        return Array.from({length: 100}, (_, index) => ({
          issue_field_name: `Extra ${index}`,
          single_select_option: {name: "unused"}
        }));
      }
      secondPageReads += 1;
      if (secondPageReads === 1) {
        const error = new Error("service unavailable");
        error.status = 503;
        throw error;
      }
      return [{issue_field_name: "Priority", single_select_option: {name: "P1"}}];
    }
  });

  assert.equal(secondPageReads, 2);
  assert.equal(posts, 1);
  assert.equal(result.items[0].status, "applied");
});

test("le todas as paginas de definicoes de Issue Fields", async () => {
  const pages = [];
  const fieldIds = await fetchOrganizationFieldIds({
    org: "Siltech-Consult",
    runGh: async (args) => {
      const endpoint = args.at(-1);
      pages.push(endpoint);
      if (endpoint.endsWith("page=1")) {
        return Array.from({length: 100}, (_, index) => ({name: `Extra ${index}`, id: index + 10}));
      }
      return [
        {name: "Priority", id: 1}, {name: "Workflow", id: 2},
        {name: "Effort", id: 3}, {name: "Wave", id: 4}
      ];
    }
  });

  assert.equal(pages.length, 2);
  assert.deepEqual(fieldIds, {Priority: 1, Workflow: 2, Effort: 3, Wave: 4});
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

  assert.deepEqual(checkpoints[0].items.map((entry) => entry.status), ["pending", "pending"]);
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
      plan_digest: canonicalPlanDigest({generated_at: "2026-07-27T00:00:00Z", summary: {ambiguous: 0}, items: [item, laterItem]}),
      items: [
        resumeRecord("applied", [
          attemptEntry("prepared", "in_flight"),
          attemptEntry("outcome", "applied")
        ]),
        {repository: laterItem.repository, number: laterItem.number, status: "pending", attempts: [], changed_since_plan: {}, attempted_fields: [], attempted_field_values: []}
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
  assert.equal(result.items.find((entry) => entry.number === 8).attempts.length, 2);
});

test("recusa resultado de plano com digest diferente", async () => {
  const changedPlan = {
    generated_at: "2026-07-27T00:00:00Z",
    summary: {ambiguous: 0},
    items: [{...item, proposed: {...item.proposed, Workflow: "Ready"}}]
  };
  let calls = 0;
  await assert.rejects(applyClassificationPlan({
    plan: changedPlan,
    fieldIds,
    apply: true,
    sleep: async () => {},
    resumeResult: {
      plan_generated_at: changedPlan.generated_at,
      plan_digest: canonicalPlanDigest({...changedPlan, items: [item]}),
      items: [{repository: item.repository, number: item.number, status: "applied", attempts: [], changed_since_plan: {}, attempted_fields: [], attempted_field_values: []}]
    },
    runGh: async () => {
      calls += 1;
      return {};
    }
  }), /digest/);

  assert.equal(calls, 0);
});

test("recusa artefatos de retomada duplicados, incompletos, nao planejados ou malformados", async () => {
  const second = {...item, number: 8};
  const plan = {summary: {ambiguous: 0}, items: [item, second]};
  const digest = canonicalPlanDigest(plan);
  const base = {
    plan_digest: digest,
    items: [
      {repository: item.repository, number: item.number, status: "pending", attempts: [], changed_since_plan: {}, attempted_fields: [], attempted_field_values: []},
      {repository: second.repository, number: second.number, status: "pending", attempts: [], changed_since_plan: {}, attempted_fields: [], attempted_field_values: []}
    ]
  };
  const invalidResults = [
    {...base, items: [base.items[0], base.items[0]]},
    {...base, items: [base.items[0]]},
    {...base, items: [base.items[0], {repository: "Siltech-Consult/other", number: 9, status: "pending", attempts: []}]},
    {...base, items: [{...base.items[0], attempts: [{attempt: 1, phase: "outcome", payload: {issue_field_values: []}, changed_since_plan: {}, outcome: "applied"}]}, base.items[1]]}
  ];

  for (const resumeResult of invalidResults) {
    let calls = 0;
    await assert.rejects(applyClassificationPlan({
      plan,
      fieldIds,
      apply: true,
      resumeResult,
      runGh: async () => { calls += 1; }
    }), /resultado anterior/i);
    assert.equal(calls, 0);
  }
});

test("aceita somente combinacoes terminais coerentes de status e resultado final", async () => {
  const validCases = [
    {
      status: "applied",
      attempts: [attemptEntry("prepared", "in_flight"), attemptEntry("outcome", "applied")]
    },
    {
      status: "applied",
      attempts: [attemptEntry("prepared", "in_flight"), attemptEntry("outcome", "confirmed_after_uncertain")]
    },
    {
      status: "applied",
      attempts: [
        attemptEntry("prepared", "in_flight"),
        attemptEntry("outcome", "uncertain"),
        attemptEntry("confirmation", "confirmed_after_uncertain")
      ]
    },
    {
      status: "preserved",
      attempts: [
        attemptEntry("prepared", "preserved", {issue_field_values: []}),
        attemptEntry("outcome", "preserved", {issue_field_values: []})
      ]
    },
    {status: "failed", attempts: []},
    {
      status: "failed",
      attempts: [attemptEntry("prepared", "in_flight"), attemptEntry("outcome", "authoritative_rejection")]
    },
    {
      status: "failed",
      attempts: [attemptEntry("prepared", "in_flight"), attemptEntry("outcome", "uncertain")]
    },
    {
      status: "failed",
      attempts: [
        attemptEntry("prepared", "in_flight"),
        attemptEntry("outcome", "uncertain"),
        attemptEntry("confirmation", "not_applied_after_uncertain")
      ]
    },
    {
      status: "failed",
      attempts: [
        attemptEntry("prepared", "in_flight"),
        attemptEntry("outcome", "uncertain"),
        attemptEntry("confirmation", "confirmation_failed")
      ]
    }
  ];
  let calls = 0;

  for (const [index, validCase] of validCases.entries()) {
    const caseItem = {...item, number: 100 + index};
    const plan = {summary: {ambiguous: 0}, items: [caseItem]};
    const result = await applyClassificationPlan({
      plan,
      fieldIds,
      apply: true,
      resumeResult: {
        plan_digest: canonicalPlanDigest(plan),
        items: [resumeRecord(validCase.status, validCase.attempts, caseItem)]
      },
      runGh: async () => {
        calls += 1;
        throw new Error("nao deve consultar GitHub");
      }
    });

    assert.equal(result.items[0].status, validCase.status);
  }

  assert.equal(calls, 0);
});

test("recusa status retomado que contradiz resultado final antes de consultar API", async () => {
  const prepared = [attemptEntry("prepared", "in_flight")];
  const rejected = [...prepared, attemptEntry("outcome", "authoritative_rejection")];
  const uncertain = [...prepared, attemptEntry("outcome", "uncertain")];
  const applied = [...prepared, attemptEntry("outcome", "applied")];
  const preserved = [
    attemptEntry("prepared", "preserved", {issue_field_values: []}),
    attemptEntry("outcome", "preserved", {issue_field_values: []})
  ];
  const invalidCases = [
    {status: "applied", attempts: rejected},
    {status: "applied", attempts: prepared},
    {status: "applied", attempts: uncertain},
    {status: "preserved", attempts: rejected},
    {status: "preserved", attempts: prepared},
    {status: "preserved", attempts: uncertain},
    {status: "applied", attempts: preserved},
    {status: "preserved", attempts: applied},
    {status: "pending", attempts: applied},
    {status: "failed", attempts: applied}
  ];
  const plan = {summary: {ambiguous: 0}, items: [item]};

  for (const invalidCase of invalidCases) {
    let calls = 0;
    await assert.rejects(applyClassificationPlan({
      plan,
      fieldIds,
      apply: true,
      resumeResult: {
        plan_digest: canonicalPlanDigest(plan),
        items: [resumeRecord(invalidCase.status, invalidCase.attempts)]
      },
      runGh: async () => {
        calls += 1;
        throw new Error("nao deve consultar GitHub");
      }
    }), /resultado anterior/i);
    assert.equal(calls, 0);
  }
});

test("retomada nao repete POST interrompido sem confirmacao", async () => {
  const plan = {summary: {ambiguous: 0}, items: [item]};
  const payload = buildIssueFieldPayload(item, fieldIds);
  let posts = 0;
  const result = await applyClassificationPlan({
    plan,
    fieldIds,
    apply: true,
    resumeResult: {
      plan_digest: canonicalPlanDigest(plan),
      items: [{
        repository: item.repository,
        number: item.number,
        status: "pending",
        attempted_fields: ["Workflow", "Effort", "Wave"],
        attempted_field_values: payload.issue_field_values,
        changed_since_plan: {},
        attempts: [{attempt: 1, phase: "prepared", payload, changed_since_plan: {}, outcome: "in_flight"}]
      }]
    },
    runGh: async (args) => {
      if (args.includes("--method")) posts += 1;
      return [{issue_field_name: "Priority", single_select_option: {name: "P1"}}];
    }
  });

  assert.equal(posts, 0);
  assert.equal(result.items[0].status, "failed");
  assert.equal(result.items[0].attempts.at(-1).outcome, "uncertain");
});

test("retomada confirma POST ambiguo pendente sem repeti-lo", async () => {
  const plan = {summary: {ambiguous: 0}, items: [item]};
  const payload = buildIssueFieldPayload(item, fieldIds);
  let posts = 0;
  const result = await applyClassificationPlan({
    plan,
    fieldIds,
    apply: true,
    resumeResult: {
      plan_digest: canonicalPlanDigest(plan),
      items: [{
        repository: item.repository,
        number: item.number,
        status: "pending",
        attempted_fields: ["Workflow", "Effort", "Wave"],
        attempted_field_values: payload.issue_field_values,
        changed_since_plan: {},
        attempts: [
          {attempt: 1, phase: "prepared", payload, changed_since_plan: {}, outcome: "in_flight"},
          {attempt: 1, phase: "outcome", payload, changed_since_plan: {}, outcome: "uncertain", error: "connection reset"}
        ]
      }]
    },
    runGh: async (args) => {
      if (args.includes("--method")) posts += 1;
      return [
        {issue_field_name: "Priority", single_select_option: {name: "P1"}},
        {issue_field_name: "Workflow", single_select_option: {name: "Backlog"}},
        {issue_field_name: "Effort", single_select_option: {name: "M"}},
        {issue_field_name: "Wave", single_select_option: {name: "Onda 1"}}
      ];
    }
  });

  assert.equal(posts, 0);
  assert.equal(result.items[0].status, "applied");
  assert.equal(result.items[0].attempts.at(-1).phase, "confirmation");
});

test("mantem todos os itens pendentes e historico append-only apos falha incerta", async () => {
  const laterItem = {...item, number: 8, current: {}, proposed: {
    Priority: "P2", Workflow: "Backlog", Effort: "M", Wave: "Onda 2"
  }};
  let posts = 0;
  const result = await applyClassificationPlan({
    plan: {generated_at: "2026-07-27T00:00:00Z", summary: {ambiguous: 0}, items: [item, laterItem]},
    fieldIds,
    apply: true,
    sleep: async () => {},
    retrySleep: async () => {},
    runGh: async (args) => {
      if (!args.includes("--method")) return [];
      posts += 1;
      const error = new Error("connection reset after request");
      error.code = "ECONNRESET";
      throw error;
    }
  });

  assert.equal(posts, 1);
  assert.deepEqual(result.items.map((entry) => entry.status), ["failed", "pending"]);
  assert.deepEqual(result.summary, {
    total: 2,
    applied: 0,
    preserved: 0,
    changed_since_plan: 1,
    failed: 1,
    pending: 1
  });
  assert.equal(result.items[0].attempts.length >= 2, true);
  assert.equal(result.items[0].attempts[0].payload.issue_field_values.length, 4);
  assert.equal(result.items[0].attempts.at(-1).outcome, "uncertain");
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

test("CLI valida resultado anterior antes de executar gh", async (t) => {
  const plan = {organization: "Siltech-Consult", summary: {ambiguous: 0}, items: [item]};
  const invalidResults = [
    {
      name: "JSON malformado",
      contents: "{",
      error: /Falha ao ler resultado anterior/
    },
    {
      name: "status contraditorio",
      contents: JSON.stringify({
        plan_digest: canonicalPlanDigest(plan),
        items: [resumeRecord("applied", [
          attemptEntry("prepared", "in_flight"),
          attemptEntry("outcome", "authoritative_rejection")
        ])]
      }),
      error: /status applied contradiz resultado final/
    },
    {
      name: "digest diferente com estado nao terminal",
      contents: JSON.stringify({
        generated_at: "2026-07-26T00:00:00.000Z",
        updated_at: "2026-07-26T00:01:00.000Z",
        plan_generated_at: null,
        plan_digest: "a".repeat(64),
        summary: {total: 1, applied: 0, preserved: 0, changed_since_plan: 0, failed: 0, pending: 1},
        items: [resumeRecord("pending", [])]
      }),
      error: /nao terminal/
    }
  ];

  for (const invalidResult of invalidResults) {
    await t.test(invalidResult.name, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "apply-classification-cli-resume-"));
      t.after(() => rm(directory, {recursive: true, force: true}));
      const planPath = join(directory, "plan.json");
      const outputPath = join(directory, "result.json");
      const ghPath = join(directory, "gh");
      const markerPath = join(directory, "gh-called");
      await Promise.all([
        writeFile(planPath, JSON.stringify(plan), "utf8"),
        writeFile(outputPath, invalidResult.contents, "utf8"),
        writeFile(ghPath, `#!/bin/sh\ntouch "${markerPath}"\nexit 99\n`, "utf8")
      ]);
      await chmod(ghPath, 0o755);

      const result = await new Promise((resolveResult, reject) => {
        const child = spawn(process.execPath, [
          applyScript,
          "--plan", planPath,
          "--output", outputPath,
          "--gh", ghPath,
          "--apply"
        ], {cwd: projectRoot});
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolveResult({code, stderr}));
      });

      assert.equal(result.code, 1);
      assert.match(result.stderr, invalidResult.error);
      await assert.rejects(readFile(markerPath, "utf8"));
    });
  }
});

test("CLI arquiva resultado terminal coerente de outro plano e inicia nova aplicacao", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "apply-classification-cli-rollover-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const oldPlan = {
    generated_at: "2026-07-26T00:00:00.000Z",
    organization: "Siltech-Consult",
    summary: {ambiguous: 0},
    items: [item]
  };
  const plan = {
    generated_at: "2026-07-27T00:00:00.000Z",
    organization: "Siltech-Consult",
    summary: {ambiguous: 0},
    items: [{...item, proposed: {...item.proposed, Workflow: "Ready"}}]
  };
  const oldDigest = canonicalPlanDigest(oldPlan);
  const previousResult = {
    generated_at: "2026-07-26T00:01:00.000Z",
    updated_at: "2026-07-26T00:02:00.000Z",
    plan_generated_at: oldPlan.generated_at,
    plan_digest: oldDigest,
    summary: {total: 1, applied: 1, preserved: 0, changed_since_plan: 0, failed: 0, pending: 0},
    items: [{
      ...resumeRecord("applied", [
        attemptEntry("prepared", "in_flight"),
        attemptEntry("outcome", "applied")
      ]),
      attempted_fields: ["Workflow", "Effort", "Wave"],
      attempted_field_values: attemptPayload.issue_field_values
    }]
  };
  const planPath = join(directory, "plan.json");
  const outputPath = join(directory, "result.json");
  const archivePath = join(directory, `result.${oldDigest}.json`);
  const ghPath = join(directory, "gh");
  await Promise.all([
    writeFile(planPath, JSON.stringify(plan), "utf8"),
    writeFile(outputPath, JSON.stringify(previousResult), "utf8"),
    writeFile(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
let body;
if (args.some((arg) => arg.includes("orgs/Siltech-Consult/issue-fields"))) {
  body = ["Priority", "Workflow", "Effort", "Wave"].map((name, index) => ({name, id: index + 1}));
} else if (args.includes("--method")) {
  body = {};
} else {
  body = [];
}
process.stdout.write("HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n" + JSON.stringify(body));
`, "utf8")
  ]);
  await chmod(ghPath, 0o755);

  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [
      applyScript,
      "--plan", planPath,
      "--output", outputPath,
      "--gh", ghPath,
      "--apply"
    ], {cwd: projectRoot});
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({code, stderr}));
  });

  assert.deepEqual(result, {code: 0, stderr: ""});
  assert.deepEqual(JSON.parse(await readFile(archivePath, "utf8")), previousResult);
  const currentResult = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(currentResult.plan_digest, canonicalPlanDigest(plan));
  assert.equal(currentResult.summary.applied, 1);
});

test("auditoria aponta campos ausentes, mudanca, opcao invalida e inventario divergente", () => {
  const plan = {
      summary: {total: 2},
      items: [
        {repository: "Siltech-Consult/demo", number: 1, current: {Priority: "P1"}},
        {repository: "Siltech-Consult/demo", number: 2, current: {}}
      ]
    };
  const audit = auditOpenIssueClassification({
    plan,
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
    result: terminalResult(plan)
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
  const plan = {items: [{repository: "Siltech-Consult/demo", number: 1, current: {}}]};
  const audit = auditOpenIssueClassification({
    plan,
    result: terminalResult(plan, {
      "Siltech-Consult/demo#1": {Workflow: {planned: null, current: "Ready"}}
    }),
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

test("auditoria bloqueia digest errado, registros duplicados e estados nao terminais", () => {
  const plan = {
    generated_at: "2026-07-27T00:00:00Z",
    items: [
      {repository: "Siltech-Consult/demo", number: 1, current: {}},
      {repository: "Siltech-Consult/demo", number: 2, current: {}}
    ]
  };
  const audit = auditOpenIssueClassification({
    plan,
    result: {
      plan_digest: "different",
      items: [
        {repository: "Siltech-Consult/demo", number: 1, status: "pending"},
        {repository: "Siltech-Consult/demo", number: 1, status: "applied"}
      ]
    },
    issues: [{
      repository: "Siltech-Consult/demo",
      number: 1,
      fields: {Priority: "P1", Workflow: "Backlog", Effort: "M", Wave: "Onda 1"}
    }, {
      repository: "Siltech-Consult/demo",
      number: 2,
      fields: {Priority: "P1", Workflow: "Backlog", Effort: "M", Wave: "Onda 1"}
    }],
    officialOptions: {
      Priority: ["P1"], Workflow: ["Backlog"], Effort: ["M"], Wave: ["Onda 1"]
    }
  });

  assert.equal(audit.failures.some((failure) => failure.type === "result_plan_digest_mismatch"), true);
  assert.equal(audit.failures.some((failure) => failure.type === "result_duplicate_issue"), true);
  assert.equal(audit.failures.some((failure) => failure.type === "result_nonterminal_issue"), true);
  assert.equal(audit.failures.some((failure) => failure.type === "result_unaccounted_issue"), true);
});
