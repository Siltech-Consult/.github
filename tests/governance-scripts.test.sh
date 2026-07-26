#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
configure_script="${root_dir}/scripts/configure-issue-fields.sh"
migration_script="${root_dir}/scripts/migrate-health-audit-issues.sh"
validation_script="${root_dir}/scripts/validate-health-audit-issues.sh"
labels_workflow="${root_dir}/.github/workflows/sync-labels.yml"

grep -q 'name: "Workflow"' "${configure_script}"
grep -q 'field_by_name "Workflow"' "${configure_script}"
grep -q 'select(.name == "Workflow")' "${migration_script}"
grep -q 'issue-field-values' "${validation_script}"
grep -q 'Migracao Health validada' "${validation_script}"
grep -q 'uses: actions/checkout@v6' "${labels_workflow}"

if grep -q 'name: "Status"' "${configure_script}"; then
  echo "Erro: Status e nome reservado pelo GitHub." >&2
  exit 1
fi

echo "OK governance scripts"
