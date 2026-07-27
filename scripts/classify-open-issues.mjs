#!/usr/bin/env node

import {readFile} from "node:fs/promises";
import {classifyIssue} from "./lib/classification.mjs";
import {buildClassificationPlan, validateOverrides, writeJsonAtomically} from "./lib/report.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readJson(path, description) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Falha ao ler ${description} em ${path}: ${error.message}`);
  }
}

const inputPath = option("--input") ?? process.env.INPUT_PATH ?? "artifacts/open-issues.json";
const outputPath = option("--output") ?? process.env.OUTPUT_PATH ?? "artifacts/issue-classification-plan.json";
const rulesPath = option("--rules") ?? process.env.RULES_PATH ?? "config/issue-classification-rules.json";
const overridesPath = option("--overrides") ?? process.env.OVERRIDES_PATH ?? "config/issue-classification-overrides.json";
const organization = option("--org") ?? process.env.ORG ?? "Siltech-Consult";

try {
  const [issues, rules, overrides] = await Promise.all([
    readJson(inputPath, "inventario"),
    readJson(rulesPath, "regras"),
    readJson(overridesPath, "overrides")
  ]);
  validateOverrides(overrides);
  const plan = buildClassificationPlan(issues, {
    organization,
    classify: (issue) => classifyIssue(issue, rules, overrides)
  });
  await writeJsonAtomically(outputPath, plan);
  console.log(
    `Plano gravado: ${plan.summary.total} issue(s), ${plan.summary.complete} completa(s), ` +
    `${plan.summary.ambiguous} ambigua(s) em ${outputPath}`
  );
  if (plan.summary.ambiguous > 0) process.exitCode = 2;
} catch (error) {
  console.error(`Falha na classificacao: ${error.message}`);
  process.exitCode = 1;
}
