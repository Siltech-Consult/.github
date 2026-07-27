#!/usr/bin/env node

import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";
import {createRunGh} from "./lib/github-client.mjs";
import {writeJsonAtomically} from "./lib/report.mjs";
import {isAuthoritativeTransientMutationRejection, isTransientGitHubError, withRetry} from "./lib/retry.mjs";
import {canonicalPlanDigest} from "./lib/plan-digest.mjs";

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
  const keys = new Set();
  for (const item of plan.items) {
    const key = resultItemKey(item);
    if (keys.has(key)) throw new Error(`Plano possui issue duplicada: ${key}`);
    keys.add(key);
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

export async function fetchOrganizationFields({org, runGh}) {
  const fields = [];
  for (let page = 1; ; page += 1) {
    const response = await withRetry(() => runGh(apiArgs(`orgs/${org}/issue-fields?per_page=100&page=${page}`)));
    const values = Array.isArray(response) ? response : response?.items ?? [];
    fields.push(...values);
    if (values.length < 100) return fields;
  }
}

export async function fetchOrganizationFieldIds({org, runGh}) {
  return extractFieldIds(await fetchOrganizationFields({org, runGh}));
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

function createPendingRecord(item) {
  return {
    repository: item.repository,
    number: item.number,
    status: "pending",
    attempted_fields: [],
    attempted_field_values: [],
    changed_since_plan: {},
    attempts: []
  };
}

const RESULT_STATUSES = new Set(["pending", "applied", "preserved", "failed"]);
const PREPARED_OUTCOMES = new Set(["in_flight", "preserved"]);
const OUTCOME_OUTCOMES = new Set(["applied", "preserved", "authoritative_rejection", "uncertain", "confirmed_after_uncertain"]);
const CONFIRMATION_OUTCOMES = new Set(["confirmed_after_uncertain", "not_applied_after_uncertain", "confirmation_failed"]);

function validObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateAttemptHistory(record, key) {
  if (!Array.isArray(record.attempts)) throw new Error(`Resultado anterior invalido para ${key}: attempts ausente`);
  let openAttempt;
  let lastAttempt = 0;
  for (const entry of record.attempts) {
    if (!validObject(entry)) throw new Error(`Resultado anterior invalido para ${key}: tentativa malformada`);
    if (!Number.isInteger(entry.attempt) || entry.attempt < 1) {
      throw new Error(`Resultado anterior invalido para ${key}: numero de tentativa invalido`);
    }
    if (!validObject(entry.payload) || !Array.isArray(entry.payload.issue_field_values) || !validObject(entry.changed_since_plan)) {
      throw new Error(`Resultado anterior invalido para ${key}: tentativa sem payload ou changed_since_plan valido`);
    }
    if (entry.payload.issue_field_values.some((value) =>
      !validObject(value) || !hasValue(value.field_id) || !hasValue(value.value))) {
      throw new Error(`Resultado anterior invalido para ${key}: payload de tentativa malformado`);
    }
    if (entry.phase === "prepared") {
      if (openAttempt || entry.attempt !== lastAttempt + 1 || !PREPARED_OUTCOMES.has(entry.outcome)) {
        throw new Error(`Resultado anterior invalido para ${key}: historico de tentativas nao append-only`);
      }
      openAttempt = entry;
      lastAttempt = entry.attempt;
      continue;
    }
    if (entry.phase === "outcome") {
      if (!openAttempt || entry.attempt !== openAttempt.attempt || !OUTCOME_OUTCOMES.has(entry.outcome) ||
        JSON.stringify(entry.payload) !== JSON.stringify(openAttempt.payload) ||
        JSON.stringify(entry.changed_since_plan) !== JSON.stringify(openAttempt.changed_since_plan)) {
        throw new Error(`Resultado anterior invalido para ${key}: historico de tentativas nao append-only`);
      }
      openAttempt = entry.outcome === "uncertain" ? {...entry, awaiting_confirmation: true} : undefined;
      continue;
    }
    if (entry.phase === "confirmation") {
      if (!openAttempt?.awaiting_confirmation || entry.attempt !== openAttempt.attempt ||
        !CONFIRMATION_OUTCOMES.has(entry.outcome) ||
        JSON.stringify(entry.payload) !== JSON.stringify(openAttempt.payload) ||
        JSON.stringify(entry.changed_since_plan) !== JSON.stringify(openAttempt.changed_since_plan)) {
        throw new Error(`Resultado anterior invalido para ${key}: historico de tentativas nao append-only`);
      }
      openAttempt = undefined;
      continue;
    }
    throw new Error(`Resultado anterior invalido para ${key}: fase de tentativa invalida`);
  }
  if (openAttempt && record.status !== "pending" && record.status !== "failed") {
    throw new Error(`Resultado anterior invalido para ${key}: tentativa em voo com estado terminal`);
  }
}

function validateResumeResult(plan, resumeResult, planDigest) {
  if (!validObject(resumeResult)) throw new Error("Resultado anterior invalido: objeto ausente");
  if (resumeResult.plan_digest !== planDigest) throw new Error("Resultado anterior invalido: digest do plano nao confere");
  if (!Array.isArray(resumeResult.items)) throw new Error("Resultado anterior invalido: items ausente");
  if (resumeResult.items.length !== plan.items.length) throw new Error("Resultado anterior invalido: quantidade de issues nao confere");

  const planned = new Map(plan.items.map((item) => [resultItemKey(item), item]));
  const seen = new Set();
  for (const record of resumeResult.items) {
    if (!validObject(record)) throw new Error("Resultado anterior invalido: registro malformado");
    const key = resultItemKey(record);
    const plannedItem = planned.get(key);
    if (!plannedItem) throw new Error(`Resultado anterior invalido: issue nao planejada ${key}`);
    if (seen.has(key)) throw new Error(`Resultado anterior invalido: issue duplicada ${key}`);
    if (record.repository !== plannedItem.repository || record.number !== plannedItem.number) {
      throw new Error(`Resultado anterior invalido: identidade da issue malformada ${key}`);
    }
    if (!RESULT_STATUSES.has(record.status)) throw new Error(`Resultado anterior invalido: status invalido para ${key}`);
    if (!validObject(record.changed_since_plan) || !Array.isArray(record.attempted_fields) ||
      !Array.isArray(record.attempted_field_values)) {
      throw new Error(`Resultado anterior invalido: campos duraveis ausentes para ${key}`);
    }
    validateAttemptHistory(record, key);
    seen.add(key);
  }
  for (const key of planned.keys()) {
    if (!seen.has(key)) throw new Error(`Resultado anterior invalido: issue ausente ${key}`);
  }
}

function createResult(plan, resumeResult, planDigest, now) {
  const resumable = resumeResult !== undefined;
  if (resumable) validateResumeResult(plan, resumeResult, planDigest);
  const knownItems = new Map((resumable ? resumeResult.items : []).map((item) => [resultItemKey(item), item]));
  const result = {
    generated_at: resumable ? resumeResult.generated_at : now(),
    updated_at: now(),
    plan_generated_at: plan.generated_at ?? null,
    plan_digest: planDigest,
    summary: {},
    items: plan.items
      .map((item) => structuredClone(knownItems.get(resultItemKey(item)) ?? createPendingRecord(item)))
  };
  updateSummary(result, plan.items.length);
  return result;
}

function fieldsForPayload(payload, fieldIds) {
  return payload.issue_field_values.map(({field_id}) =>
    CLASSIFICATION_FIELDS.find((field) => fieldIds[field] === field_id)).filter(Boolean);
}

function payloadApplied(payload, current, fieldIds) {
  return payload.issue_field_values.every(({field_id, value}) => {
    const field = CLASSIFICATION_FIELDS.find((name) => fieldIds[name] === field_id);
    return field && current[field] === value;
  });
}

function unfinishedAttempt(record) {
  const last = record.attempts.at(-1);
  return last?.phase === "prepared" ? last : undefined;
}

function awaitingConfirmationAttempt(record) {
  const last = record.attempts.at(-1);
  return last?.phase === "outcome" && last.outcome === "uncertain" ? last : undefined;
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

  const planDigest = canonicalPlanDigest(plan);
  const result = createResult(plan, resumeResult, planDigest, now);
  await checkpoint(result);

  for (let index = 0; index < plan.items.length; index += 1) {
    const item = plan.items[index];
    const key = resultItemKey(item);
    let record = result.items.find((entry) => resultItemKey(entry) === key);
    if (record.status !== "pending") continue;
    const interrupted = unfinishedAttempt(record);
    if (interrupted) {
      if (interrupted.outcome === "preserved") {
        record.attempts.push({...interrupted, phase: "outcome", outcome: "preserved"});
        record.status = "preserved";
      } else {
        try {
          const confirmed = await withRetry(
            () => fetchIssueFields({...item, runGh}),
            {sleep: retrySleep, shouldRetry: isTransientGitHubError}
          );
          if (payloadApplied(interrupted.payload, confirmed, fieldIds)) {
            record.attempts.push({...interrupted, phase: "outcome", outcome: "confirmed_after_uncertain"});
            record.status = "applied";
          } else {
            record.attempts.push({...interrupted, phase: "outcome", outcome: "uncertain", error: "POST interrompido sem confirmacao"});
            record.status = "failed";
            record.error = "POST interrompido sem confirmacao; retomada nao repetiu a mutacao";
          }
        } catch (error) {
          record.attempts.push({...interrupted, phase: "outcome", outcome: "uncertain", error: error.message});
          record.status = "failed";
          record.error = `Falha ao confirmar POST interrompido: ${error.message}`;
        }
      }
      updateSummary(result, plan.items.length);
      result.updated_at = now();
      await checkpoint(result);
      if (record.status === "failed") break;
      continue;
    }
    const uncertain = awaitingConfirmationAttempt(record);
    if (uncertain) {
      try {
        const confirmed = await withRetry(
          () => fetchIssueFields({...item, runGh}),
          {sleep: retrySleep, shouldRetry: isTransientGitHubError}
        );
        if (payloadApplied(uncertain.payload, confirmed, fieldIds)) {
          record.attempts.push({...uncertain, phase: "confirmation", outcome: "confirmed_after_uncertain"});
          record.status = "applied";
        } else {
          record.attempts.push({...uncertain, phase: "confirmation", outcome: "not_applied_after_uncertain"});
          record.status = "failed";
          record.error = "POST incerto sem confirmacao; retomada nao repetiu a mutacao";
        }
      } catch (error) {
        record.attempts.push({...uncertain, phase: "confirmation", outcome: "confirmation_failed", error: error.message});
        record.status = "failed";
        record.error = `Falha ao confirmar POST incerto: ${error.message}`;
      }
      updateSummary(result, plan.items.length);
      result.updated_at = now();
      await checkpoint(result);
      if (record.status === "failed") break;
      continue;
    }
    if (index > 0) await sleep(index % batchSize === 0 ? batchPauseMs : issuePauseMs);
    try {
      const outcome = await withRetry(async () => {
        const current = await fetchIssueFields({...item, runGh});
        const changed_since_plan = changedFields(item.current, current);
        const payload = buildIssueFieldPayload({current, proposed: item.proposed}, fieldIds);
        const attempted_fields = fieldsForPayload(payload, fieldIds);
        const attempt = {
          attempt: record.attempts.filter((entry) => entry.phase === "prepared").length + 1,
          phase: "prepared",
          payload,
          changed_since_plan,
          outcome: payload.issue_field_values.length === 0 ? "preserved" : "in_flight"
        };
        Object.assign(record, {
          status: "pending",
          attempted_fields,
          attempted_field_values: payload.issue_field_values,
          changed_since_plan
        });
        record.attempts.push(attempt);
        updateSummary(result, plan.items.length);
        result.updated_at = now();
        await checkpoint(result);
        if (payload.issue_field_values.length === 0) {
          record.attempts.push({...attempt, phase: "outcome", outcome: "preserved"});
          return {status: "preserved"};
        }
        try {
          await runGh(apiArgs(
            `repos/${item.repository}/issues/${item.number}/issue-field-values`,
            {method: "POST", input: "-"}
          ), {input: JSON.stringify(payload)});
          record.attempts.push({...attempt, phase: "outcome", outcome: "applied"});
          return {status: "applied"};
        } catch (error) {
          const authoritativeRejection = isAuthoritativeTransientMutationRejection(error);
          record.attempts.push({
            ...attempt,
            phase: "outcome",
            outcome: authoritativeRejection ? "authoritative_rejection" : "uncertain",
            error: error.message
          });
          updateSummary(result, plan.items.length);
          result.updated_at = now();
          await checkpoint(result);
          if (authoritativeRejection) throw error;
          try {
            const confirmed = await fetchIssueFields({...item, runGh});
            if (payloadApplied(payload, confirmed, fieldIds)) {
              record.attempts.push({...attempt, phase: "confirmation", outcome: "confirmed_after_uncertain"});
              return {status: "applied"};
            }
          } catch (confirmationError) {
            error.confirmation_error = confirmationError.message;
          }
          error.uncertainMutation = true;
          throw error;
        }
      }, {
        sleep: retrySleep,
        shouldRetry: isAuthoritativeTransientMutationRejection
      });
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
