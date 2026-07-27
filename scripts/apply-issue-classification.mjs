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

function fieldsFromValueResponse(response) {
  const values = Array.isArray(response) ? response : response?.issue_field_values ?? [];
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
  const response = await withRetry(() => runGh(apiArgs(`repos/${repository}/issues/${number}/issue-field-values`)));
  return fieldsFromValueResponse(response);
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
  now = () => new Date().toISOString()
} = {}) {
  if (!apply) throw new Error("Recusando escrita sem --apply");
  validatePlan(plan);
  if (typeof runGh !== "function") throw new Error("runGh e obrigatorio");

  const result = {
    generated_at: now(),
    plan_generated_at: plan.generated_at ?? null,
    summary: {total: plan.items.length, applied: 0, preserved: 0, changed_since_plan: 0, failed: 0},
    items: []
  };

  for (let index = 0; index < plan.items.length; index += 1) {
    const item = plan.items[index];
    if (index > 0) await sleep(index % batchSize === 0 ? batchPauseMs : issuePauseMs);
    try {
      const current = await fetchIssueFields({...item, runGh});
      const changed_since_plan = changedFields(item.current, current);
      const payload = buildIssueFieldPayload({current, proposed: item.proposed}, fieldIds);
      const fields = payload.issue_field_values.map(({field_id}) =>
        CLASSIFICATION_FIELDS.find((field) => fieldIds[field] === field_id));

      if (payload.issue_field_values.length > 0) {
        await withRetry(() => runGh(apiArgs(
          `repos/${item.repository}/issues/${item.number}/issue-field-values`,
          {method: "POST", input: "-"}
        ), {input: JSON.stringify(payload)}));
        result.summary.applied += 1;
      } else {
        result.summary.preserved += 1;
      }
      if (Object.keys(changed_since_plan).length > 0) result.summary.changed_since_plan += 1;
      result.items.push({
        repository: item.repository,
        number: item.number,
        status: payload.issue_field_values.length > 0 ? "applied" : "preserved",
        applied_fields: fields.filter(Boolean),
        changed_since_plan
      });
    } catch (error) {
      result.summary.failed += 1;
      result.items.push({
        repository: item.repository,
        number: item.number,
        status: "failed",
        error: error.message
      });
      break;
    }
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
    const result = await applyClassificationPlan({plan, fieldIds, runGh, apply});
    await writeJsonAtomically(outputPath, result);
    console.log(`Aplicacao concluida: ${result.summary.applied} aplicada(s), ${result.summary.preserved} preservada(s), ${result.summary.failed} falha(s) em ${outputPath}`);
    if (result.summary.failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`Falha na aplicacao: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
