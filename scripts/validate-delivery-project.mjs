#!/usr/bin/env node

import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";
import {writeJsonAtomically} from "./lib/report.mjs";
import {CLASSIFICATION_FIELDS} from "./apply-issue-classification.mjs";
import {
  DELIVERY_PROJECT_TITLE,
  fetchProject,
  fetchProjectIssueFieldIds,
  findDeliveryProject
} from "./create-delivery-project.mjs";
import {createRunGh} from "./lib/github-client.mjs";

function option(name, argv = process.argv) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function validateDeliveryProject({
  organization = "Siltech-Consult",
  project,
  requiredIssueFields = {},
  issues = [],
  now = () => new Date().toISOString()
} = {}) {
  const failures = [];
  if (!project) {
    failures.push({type: "missing_project", title: DELIVERY_PROJECT_TITLE});
  } else {
    if (project.title !== DELIVERY_PROJECT_TITLE) {
      failures.push({type: "project_title_mismatch", expected: DELIVERY_PROJECT_TITLE, actual: project.title ?? null});
    }
    if (project.owner !== organization) {
      failures.push({type: "project_owner_mismatch", expected: organization, actual: project.owner ?? null});
    }
    if (project.public !== false) failures.push({type: "project_not_private"});
    const fields = project.projectFields ?? project.issueFields ?? [];
    for (const name of CLASSIFICATION_FIELDS) {
      const expectedId = requiredIssueFields[name];
      if (!expectedId) {
        failures.push({type: "missing_official_issue_field", field: name});
        continue;
      }
      const matching = fields.filter((field) => field?.name === name);
      if (matching.length === 0) {
        failures.push({type: "missing_project_issue_field", field: name, expectedId});
        continue;
      }
      if (matching.length > 1) {
        failures.push({type: "duplicate_project_field", field: name, count: matching.length});
      }
      if (matching.some((field) => field?.issueFieldId !== expectedId)) {
        failures.push({type: "wrong_project_issue_field", field: name, expectedId});
      }
    }
    const contentIds = new Set(project.contentIds ?? []);
    for (const issue of issues) {
      if (!issue?.id) {
        failures.push({type: "inventory_issue_without_id"});
      } else if (!contentIds.has(issue.id)) {
        failures.push({type: "missing_project_item", contentId: issue.id});
      }
    }
  }
  return {
    generated_at: now(),
    summary: {issues: issues.length, failures: failures.length},
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
  const inventoryPath = option("--inventory", argv) ?? "artifacts/open-issues.json";
  const outputPath = option("--output", argv) ?? "artifacts/delivery-project-audit.json";
  const organization = option("--organization", argv) ?? "Siltech-Consult";
  const executable = option("--gh", argv) ?? process.env.GH_BIN ?? "gh";
  try {
    const issues = await readJson(inventoryPath, "inventario");
    const runGh = createRunGh({executable});
    const [{project}, requiredIssueFields] = await Promise.all([
      findDeliveryProject({organization, runGh}),
      fetchProjectIssueFieldIds({organization, runGh})
    ]);
    const hydratedProject = project ? await fetchProject({projectId: project.id, runGh}) : null;
    const audit = validateDeliveryProject({organization, project: hydratedProject, requiredIssueFields, issues});
    await writeJsonAtomically(outputPath, audit);
    console.log(`Validacao do Project: ${audit.summary.issues} issue(s), ${audit.summary.failures} falha(s) em ${outputPath}`);
    if (!audit.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Falha na validacao do Project: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
