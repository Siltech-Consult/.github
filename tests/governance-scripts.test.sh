#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
configure_script="${root_dir}/scripts/configure-issue-fields.sh"
migration_script="${root_dir}/scripts/migrate-health-audit-issues.sh"
validation_script="${root_dir}/scripts/validate-health-audit-issues.sh"
labels_workflow="${root_dir}/.github/workflows/sync-labels.yml"
governance_workflow="${root_dir}/.github/workflows/organization-governance.yml"
classifier_runtime="${root_dir}/scripts/lib/classification.mjs"
classifier_rules="${root_dir}/config/issue-classification-rules.json"
classifier_overrides="${root_dir}/config/issue-classification-overrides.json"
classifier_test="${root_dir}/tests/classification.test.mjs"

grep -qxF '.worktrees/' "${root_dir}/.gitignore"

test -f "${classifier_runtime}"
test -f "${classifier_rules}"
test -f "${classifier_overrides}"
test -f "${classifier_test}"

grep -q 'name: "Workflow"' "${configure_script}"
grep -q 'field_by_name "Workflow"' "${configure_script}"
grep -q 'select(.name == "Workflow")' "${migration_script}"
grep -q 'issue-field-values' "${validation_script}"
grep -q 'Migracao Health validada' "${validation_script}"
grep -q 'uses: actions/checkout@v6' "${labels_workflow}"
test -f "${governance_workflow}"
grep -qF 'cron: "0 9 * * 1-5"' "${governance_workflow}"
grep -q 'workflow_dispatch:' "${governance_workflow}"
grep -q 'concurrency:' "${governance_workflow}"
grep -q 'ORG_LABEL_SYNC_TOKEN' "${governance_workflow}"
grep -q 'node scripts/classify-open-issues.mjs' "${governance_workflow}"
grep -q 'node scripts/apply-issue-classification.mjs' "${governance_workflow}"
grep -q 'node scripts/validate-open-issue-classification.mjs' "${governance_workflow}"
grep -q 'node scripts/create-delivery-project.mjs' "${governance_workflow}"
grep -q 'node scripts/validate-delivery-project.mjs' "${governance_workflow}"
grep -q 'actions/upload-artifact@v4' "${governance_workflow}"

if grep -q 'name: "Status"' "${configure_script}"; then
  echo "Erro: Status e nome reservado pelo GitHub." >&2
  exit 1
fi

echo "OK governance scripts"
