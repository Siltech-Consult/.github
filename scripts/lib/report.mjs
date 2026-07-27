import {mkdir, rename, unlink, writeFile} from "node:fs/promises";
import {basename, dirname, join} from "node:path";
import {randomUUID} from "node:crypto";

const CLASSIFICATION_FIELDS = ["Priority", "Workflow", "Effort", "Wave"];

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function countFields(result, predicate) {
  return CLASSIFICATION_FIELDS
    .filter((field) => hasValue(result.proposed?.[field]) && predicate(result.sources?.[field]))
    .length;
}

function issueUrl(issue) {
  return issue.url ?? `https://github.com/${issue.repository}/issues/${issue.number}`;
}

function organizationFromIssue(issue) {
  return String(issue?.repository ?? "").split("/")[0] || "Siltech-Consult";
}

function compareIssues(left, right) {
  const leftRepository = String(left.repository ?? "");
  const rightRepository = String(right.repository ?? "");
  if (leftRepository < rightRepository) return -1;
  if (leftRepository > rightRepository) return 1;
  return Number(left.number) - Number(right.number);
}

export function validateOverrides(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Overrides devem ser um objeto JSON");
  }

  for (const [key, override] of Object.entries(overrides)) {
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      throw new Error(`Override ${key} deve ser um objeto`);
    }
    const hasClassification = Object.entries(override)
      .some(([field, value]) => field !== "reason" && hasValue(value));
    if (hasClassification && !hasValue(override.reason)) {
      throw new Error(`Override ${key} sem justificativa`);
    }
  }
}

export function buildClassificationPlan(issues, {
  classify,
  organization,
  now = () => new Date().toISOString()
} = {}) {
  if (!Array.isArray(issues)) throw new Error("Inventario deve ser uma lista de issues");
  if (typeof classify !== "function") throw new Error("classify e obrigatorio");

  const summary = {
    total: issues.length,
    complete: 0,
    ambiguous: 0,
    preserved_fields: 0,
    proposed_fields: 0
  };
  const items = [...issues].sort(compareIssues).map((issue) => {
    const result = classify(issue);
    const preservedFields = countFields(result, (source) => source === "existing");
    const proposedFields = countFields(result, (source) => source !== "existing");
    summary.preserved_fields += preservedFields;
    summary.proposed_fields += proposedFields;
    if (result.ambiguous) summary.ambiguous += 1;
    else summary.complete += 1;

    return {
      repository: issue.repository,
      number: issue.number,
      url: issueUrl(issue),
      current: result.current,
      proposed: result.proposed,
      sources: result.sources,
      ambiguous: result.ambiguous,
      warnings: result.warnings
    };
  });

  return {
    generated_at: now(),
    organization: organization ?? organizationFromIssue(issues[0]),
    summary,
    items
  };
}

export async function writeJsonAtomically(outputPath, value) {
  const directory = dirname(outputPath);
  const temporaryPath = join(directory, `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(directory, {recursive: true});
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
