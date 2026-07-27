#!/usr/bin/env node

import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";
import {writeJsonAtomically} from "./lib/report.mjs";
import {
  DELIVERY_PROJECT_TITLE,
  fetchProject,
  fetchProjectIssueFieldIds,
  findDeliveryProject,
  validateDeliveryProject as validateProject
} from "./create-delivery-project.mjs";
import {createRunGh} from "./lib/github-client.mjs";

function option(name, argv = process.argv) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export const validateDeliveryProject = validateProject;

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
  const manifestPath = option("--manifest", argv) ?? "artifacts/delivery-project-manifest.json";
  const organization = option("--organization", argv) ?? "Siltech-Consult";
  const executable = option("--gh", argv) ?? process.env.GH_BIN ?? "gh";
  try {
    const [issues, manifest] = await Promise.all([
      readJson(inventoryPath, "inventario"),
      readJson(manifestPath, "manifest")
    ]);
    const runGh = createRunGh({executable});
    const [{project}, requiredIssueFields] = await Promise.all([
      findDeliveryProject({organization, runGh}),
      fetchProjectIssueFieldIds({organization, runGh})
    ]);
    const hydratedProject = project ? await fetchProject({projectId: project.id, runGh}) : null;
    const audit = validateDeliveryProject({organization, project: hydratedProject, requiredIssueFields, issues, manifest});
    await writeJsonAtomically(outputPath, audit);
    console.log(`Validacao do Project: ${audit.summary.issues} issue(s), ${audit.summary.failures} falha(s) em ${outputPath}`);
    if (!audit.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Falha na validacao do Project: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
