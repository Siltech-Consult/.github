#!/usr/bin/env node

import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";
import {createRunGh} from "./lib/github-client.mjs";
import {writeJsonAtomically} from "./lib/report.mjs";
import {withRetry} from "./lib/retry.mjs";

export const CLASSIFICATION_FIELDS = ["Priority", "Workflow", "Effort", "Wave"];
export const API_VERSION = "2026-03-10";

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function option(name, argv = process.argv) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function apiArgs(endpoint, {method, input} = {}) {
  const args = ["api"];
  if (method) args.push("--method", method);
  args.push("-H", `X-GitHub-Api-Version: ${API_VERSION}`, endpoint);
  if (input !== undefined) args.push("--input", input);
  return args;
}

function fieldValuesFromResponse(response) {
  return Array.isArray(response) ? response : response?.issue_field_values ?? [];
}

function fieldsFromValueResponse(response) {
  const values = fieldValuesFromResponse(response);
  const fields = {};
  for (const value of values) {
    const name = value?.issue_field_name ?? value?.field?.name;
    const selected = value?.single_select_option?.name ?? value?.value ?? value?.name;
    if (name && hasValue(selected)) fields[name] = selected;
  }
  return fields;
}

function changedFields(planned = {}, current = {}) {
  return Object.fromEntries(CLASSIFICATION_FIELDS
    .filter((field) => (planned[field] ?? null) !== (current[field] ?? null))
    .map((field) => [field, {planned: planned[field] ?? null, current: current[field] ?? null}]));
}

function validatePlan(plan) {
  if (!plan || !Array.isArray(plan.items)) throw new Error("Plano deve conter items");
  if (Number(plan.summary?.ambiguous ?? 0) > 0) throw new Error("Plano possui classificacoes ambiguas");
  for (const item of plan.items) {
    const incomplete = CLASSIFICATION_FIELDS.filter((field) => !hasValue(item?.proposed?.[field]));
    if (incomplete.length > 0) {
      throw new Error(`${item?.repository}#${item?.number}: campos propostos ausentes: ${incomplete.join(", ")}`);
    }
  }
}

export function buildIssueFieldPayload({current = {}, proposed = {}}, fieldIds) {
  const issue_field_values = CLASSIFICATION_FIELDS
    .filter((field) => !hasValue(current[field]) && hasValue(proposed[field]))
    .map((field) => {
      if (!hasValue(fieldIds?.[field])) throw new Error(`ID do Issue Field ${field} ausente`);
      return {field_id: fieldIds[field], value: proposed[field]};
    });
  return {issue_field_values};
}

export function extractFieldIds(fields) {
  const byName = new Map((Array.isArray(fields) ? fields : []).map((field) => [field?.name, field?.id]));
  return Object.fromEntries(CLASSIFICATION_FIELDS.map((field) => {
    const id = byName.get(field);
    if (!hasValue(id)) throw new Error(`Issue Field oficial ausente: ${field}`);
    return [field, id];
  }));
}

export async function fetchOrganizationFieldIds({org, runGh}) {
  const fields = await withRetry(() => runGh(apiArgs(`orgs/${org}/issue-fields`)));
  return extractFieldIds(fields);
}

export async function fetchIssueFields({repository, number, runGh}) {
  const fields = {};
  for (let page = 1; ; page += 1) {
    const response = await runGh(apiArgs(
      `repos/${repository}/issues/${number}/issue-field-values?per_page=100&page=${page}`
    ));
    const values = fieldValuesFromResponse(response);
    Object.assign(fields, fieldsFromValueResponse(values));
    if (values.length < 100) return fields;
  }
}

function resultItemKey(item) {
  return `${item.repository}#${item.number}`;
}

function updateSummary(result, total) {
  const items = result.items;
  result.summary = {
    total,
    applied: items.filter((item) => item.status === "applied").length,
    preserved: items.filter((item) => item.status === "preserved").length,
    changed_since_plan: items.filter((item) => Object.keys(item.changed_since_plan ?? {}).length > 0).length,
    failed: items.filter((item) => item.status === "failed").length,
    pending: items.filter((item) => item.status === "pending").length
  };
}

function createResult(plan, resumeResult, now) {
  const resumable = resumeResult?.plan_generated_at === (plan.generated_at ?? null) &&
    Array.isArray(resumeResult?.items);
  const knownItems = new Map((resumable ? resumeResult.items : [])
    .map((item) => [resultItemKey(item), item]));
  const result = {
    generated_at: resumable ? resumeResult.generated_at : now(),
    updated_at: now(),
    plan_generated_at: plan.generated_at ?? null,
    summary: {},
    items: plan.items
      .map((item) => knownItems.get(resultItemKey(item)))
      .filter(Boolean)
  };
  updateSummary(result, plan.items.length);
  return result;
}

export async function applyClassificationPlan({
  plan,
  fieldIds,
  runGh,
  apply = false,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  issuePauseMs = 250,
  batchPauseMs = 2000,
  batchSize = 20,
  retrySleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  checkpoint = async () => {},
  resumeResult,
  now = () => new Date().toISOString()
} = {}) {
  if (!apply) throw new Error("Recusando escrita sem --apply");
  validatePlan(plan);
  if (typeof runGh !== "function") throw new Error("runGh e obrigatorio");

  const result = createResult(plan, resumeResult, now);
  await checkpoint(result);

  for (let index = 0; index < plan.items.length; index += 1) {
    const item = plan.items[index];
    const key = resultItemKey(item);
    let record = result.items.find((entry) => resultItemKey(entry) === key);
    if (record?.status === "applied" || record?.status === "preserved") continue;
    if (index > 0) await sleep(index % batchSize === 0 ? batchPauseMs : issuePauseMs);
    if (!record) {
      record = {
        repository: item.repository,
        number: item.number,
        status: "pending",
        attempts: 0,
        attempted_fields: [],
        attempted_field_values: [],
        changed_since_plan: {}
      };
      result.items.push(record);
    } else {
      record.status = "pending";
      delete record.error;
    }
    updateSummary(result, plan.items.length);
    result.updated_at = now();
    await checkpoint(result);
    try {
      const outcome = await withRetry(async () => {
        const current = await fetchIssueFields({...item, runGh});
        const changed_since_plan = changedFields(item.current, current);
        const payload = buildIssueFieldPayload({current, proposed: item.proposed}, fieldIds);
        const attempted_fields = payload.issue_field_values.map(({field_id}) =>
          CLASSIFICATION_FIELDS.find((field) => fieldIds[field] === field_id)).filter(Boolean);
        Object.assign(record, {
          status: "pending",
          attempts: Number(record.attempts ?? 0) + 1,
          attempted_fields,
          attempted_field_values: payload.issue_field_values,
          changed_since_plan
        });
        updateSummary(result, plan.items.length);
        result.updated_at = now();
        await checkpoint(result);
        if (payload.issue_field_values.length === 0) return {status: "preserved"};
        await runGh(apiArgs(
          `repos/${item.repository}/issues/${item.number}/issue-field-values`,
          {method: "POST", input: "-"}
        ), {input: JSON.stringify(payload)});
        return {status: "applied"};
      }, {sleep: retrySleep});
      record.status = outcome.status;
    } catch (error) {
      record.status = "failed";
      record.error = error.message;
    }
    updateSummary(result, plan.items.length);
    result.updated_at = now();
    await checkpoint(result);
    if (record.status === "failed") break;
  }
  return result;
}

async function readJson(path, description) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Falha ao ler ${description} em ${path}: ${error.message}`);
  }
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`Falha ao ler resultado anterior em ${path}: ${error.message}`);
  }
}

export async function main(argv = process.argv) {
  const planPath = option("--plan", argv) ?? "artifacts/issue-classification-plan.json";
  const outputPath = option("--output", argv) ?? "artifacts/issue-classification-result.json";
  const executable = option("--gh", argv) ?? process.env.GH_BIN ?? "gh";
  const apply = argv.includes("--apply");
  try {
    const plan = await readJson(planPath, "plano");
    if (!apply) throw new Error("Recusando escrita sem --apply");
    const runGh = createRunGh({executable});
    const fieldIds = await fetchOrganizationFieldIds({org: plan.organization, runGh});
    const resumeResult = await readOptionalJson(outputPath);
    const result = await applyClassificationPlan({
      plan,
      fieldIds,
      runGh,
      apply,
      resumeResult,
      checkpoint: (state) => writeJsonAtomically(outputPath, state)
    });
    console.log(`Aplicacao concluida: ${result.summary.applied} aplicada(s), ${result.summary.preserved} preservada(s), ${result.summary.failed} falha(s) em ${outputPath}`);
    if (result.summary.failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`Falha na aplicacao: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
