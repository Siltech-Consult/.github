#!/usr/bin/env node

import {inventoryOpenIssues, createRunGh} from "./lib/github-client.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const org = option("--org") ?? process.env.ORG ?? "Siltech-Consult";
const outputPath = option("--output") ?? process.env.OUTPUT_PATH ?? process.env.OUT_PATH ??
  "artifacts/open-issues.json";
const executable = option("--gh") ?? process.env.GH_BIN ?? "gh";

try {
  const issues = await inventoryOpenIssues({
    org,
    outputPath,
    runGh: createRunGh({executable})
  });
  console.log(`Inventario gravado: ${issues.length} issue(s) em ${outputPath}`);
} catch (error) {
  console.error(`Falha no inventario: ${error.message}`);
  process.exitCode = 1;
}
