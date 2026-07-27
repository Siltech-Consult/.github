#!/usr/bin/env node

import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";
import {createRunGh, inventoryOpenIssues} from "./lib/github-client.mjs";
import {writeJsonAtomically} from "./lib/report.mjs";
import {withRetry} from "./lib/retry.mjs";
import {API_VERSION, CLASSIFICATION_FIELDS} from "./apply-issue-classification.mjs";

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function option(name, argv = process.argv) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function issueKey(issue) {
  return `${issue.repository}#${issue.number}`;
}

function apiArgs(endpoint) {
  return ["api", "-H", `X-GitHub-Api-Version: ${API_VERSION}`, endpoint];
}

export function extractOfficialOptions(fields) {
  const byName = new Map((Array.isArray(fields) ? fields : []).map((field) => [field?.name, field]));
  return Object.fromEntries(CLASSIFICATION_FIELDS.map((field) => {
    const definition = byName.get(field);
    if (!definition) throw new Error(`Issue Field oficial ausente: ${field}`);
    return [field, (definition.options ?? []).map((item) => item?.name).filter(hasValue)];
  }));
}

export function auditOpenIssueClassification({
  plan,
  result,
  issues,
  officialOptions,
  now = () => new Date().toISOString()
} = {}) {
  if (!plan || !Array.isArray(plan.items)) throw new Error("Plano deve conter items");
  if (!result || !Array.isArray(result.items)) {
    throw new Error("Resultado da aplicacao deve conter items");
  }
  if (!Array.isArray(issues)) throw new Error("Inventario deve ser uma lista de issues");
  const failures = [];
  if (plan.items.length !== issues.length) {
    failures.push({type: "inventory_count_mismatch", planned: plan.items.length, audited: issues.length});
  }

  const planned = new Map(plan.items.map((item) => [issueKey(item), item]));
  const applied = new Map(result.items.map((item) => [issueKey(item), item]));
  const actual = new Set();
  for (const issue of issues) {
    const key = issueKey(issue);
    actual.add(key);
    const item = planned.get(key);
    const applyResult = applied.get(key);
    for (const field of CLASSIFICATION_FIELDS) {
      const previous = item?.current?.[field];
      const current = issue.fields?.[field];
      if (hasValue(previous) && previous !== current) {
        failures.push({type: "previous_value_changed", issue: key, field, planned: previous, audited: current ?? null});
      }
      const changedSincePlan = applyResult?.changed_since_plan?.[field]?.current;
      if (hasValue(changedSincePlan) && changedSincePlan !== current) {
        failures.push({
          type: "changed_since_plan_value_changed",
          issue: key,
          field,
          expected: changedSincePlan,
          audited: current ?? null
        });
      }
      if (!hasValue(current)) {
        failures.push({type: "missing_field", issue: key, field});
      } else if (!officialOptions?.[field]?.includes(current)) {
        failures.push({type: "invalid_option", issue: key, field, value: current});
      }
    }
  }
  for (const item of plan.items) {
    if (!actual.has(issueKey(item))) {
      failures.push({type: "missing_issue", issue: issueKey(item)});
    }
  }

  return {
    generated_at: now(),
    plan_generated_at: plan.generated_at ?? null,
    summary: {planned: plan.items.length, audited: issues.length, failures: failures.length},
    ok: failures.length === 0,
    failures
  };
}

async function readJson(path, description) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Falha ao ler ${description} em ${path}: ${error.message}`);
  }
}

export async function main(argv = process.argv) {
  const planPath = option("--plan", argv) ?? "artifacts/issue-classification-plan.json";
  const resultPath = option("--result", argv) ?? "artifacts/issue-classification-result.json";
  const outputPath = option("--output", argv) ?? "artifacts/issue-classification-audit.json";
  const executable = option("--gh", argv) ?? process.env.GH_BIN ?? "gh";
  try {
    const [plan, result] = await Promise.all([
      readJson(planPath, "plano"),
      readJson(resultPath, "resultado da aplicacao")
    ]);
    const runGh = createRunGh({executable});
    const retryingRunGh = (args) => withRetry(() => runGh(args));
    const [issues, fields] = await Promise.all([
      inventoryOpenIssues({org: plan.organization, runGh: retryingRunGh}),
      retryingRunGh(apiArgs(`orgs/${plan.organization}/issue-fields`))
    ]);
    const audit = auditOpenIssueClassification({
      plan,
      result,
      issues,
      officialOptions: extractOfficialOptions(fields)
    });
    await writeJsonAtomically(outputPath, audit);
    console.log(`Auditoria concluida: ${audit.summary.audited} issue(s), ${audit.summary.failures} falha(s) em ${outputPath}`);
    if (!audit.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Falha na auditoria: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
