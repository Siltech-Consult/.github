#!/usr/bin/env bash
set -euo pipefail

ORG="${ORG:-Siltech-Consult}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CATALOG="${LABELS_CATALOG:-${ROOT_DIR}/labels.json}"

command -v gh >/dev/null || {
  echo "Erro: GitHub CLI (gh) nao encontrado." >&2
  exit 1
}

command -v jq >/dev/null || {
  echo "Erro: jq nao encontrado." >&2
  exit 1
}

if [[ -n "${REPOSITORIES:-}" ]]; then
  IFS=',' read -r -a repos <<<"${REPOSITORIES}"
else
  mapfile -t repos < <(
    gh repo list "${ORG}" \
      --limit 1000 \
      --json name,isArchived \
      --jq '.[] | select(.isArchived == false) | .name'
  )
fi

for repo in "${repos[@]}"; do
  repo="${repo#"${repo%%[![:space:]]*}"}"
  repo="${repo%"${repo##*[![:space:]]}"}"
  [[ -z "${repo}" ]] && continue

  echo "Sincronizando ${ORG}/${repo}"
  while IFS=$'\t' read -r name color description; do
    gh label create "${name}" \
      --repo "${ORG}/${repo}" \
      --color "${color}" \
      --description "${description}" \
      --force
  done < <(jq -r '.[] | [.name, .color, .description] | @tsv' "${CATALOG}")
done
