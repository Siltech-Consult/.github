#!/usr/bin/env bash
set -euo pipefail

ORG="${ORG:-Siltech-Consult}"
API_VERSION="${GITHUB_API_VERSION:-2026-03-10}"

command -v gh >/dev/null || {
  echo "Erro: GitHub CLI (gh) nao encontrado." >&2
  exit 1
}

command -v jq >/dev/null || {
  echo "Erro: jq nao encontrado." >&2
  exit 1
}

checked=0
failures=0

validate_issue() {
  local repo="$1"
  local number="$2"
  local tech_label="$3"
  local issue values title type priority workflow

  issue="$(
    gh api \
      -H "X-GitHub-Api-Version: ${API_VERSION}" \
      "repos/${ORG}/${repo}/issues/${number}"
  )"
  values="$(
    gh api \
      -H "X-GitHub-Api-Version: ${API_VERSION}" \
      "repos/${ORG}/${repo}/issues/${number}/issue-field-values"
  )"

  title="$(jq -r '.title' <<<"${issue}")"
  type="$(jq -r '.type.name // empty' <<<"${issue}")"
  priority="$(
    jq -r '.[] | select(.issue_field_name == "Priority") |
      .single_select_option.name' <<<"${values}"
  )"
  workflow="$(
    jq -r '.[] | select(.issue_field_name == "Workflow") |
      .single_select_option.name' <<<"${values}"
  )"

  checked=$((checked + 1))

  if [[ "${title}" =~ ^\[P[0-5]\] ]]; then
    echo "ERRO ${repo}#${number}: prioridade ainda esta no titulo." >&2
    failures=$((failures + 1))
  fi
  if [[ ! "${type}" =~ ^(Bug|Feature|Task)$ ]]; then
    echo "ERRO ${repo}#${number}: Issue Type ausente ou invalido." >&2
    failures=$((failures + 1))
  fi
  if ! jq -e --arg label "area:collector" \
    '[.labels[].name] | index($label) != null' <<<"${issue}" >/dev/null; then
    echo "ERRO ${repo}#${number}: label area:collector ausente." >&2
    failures=$((failures + 1))
  fi
  if ! jq -e --arg label "${tech_label}" \
    '[.labels[].name] | index($label) != null' <<<"${issue}" >/dev/null; then
    echo "ERRO ${repo}#${number}: label ${tech_label} ausente." >&2
    failures=$((failures + 1))
  fi
  if [[ ! "${priority}" =~ ^P[0-5]$ ]]; then
    echo "ERRO ${repo}#${number}: Priority ausente ou invalida." >&2
    failures=$((failures + 1))
  fi
  if [[ "${workflow}" != "Backlog" ]]; then
    echo "ERRO ${repo}#${number}: Workflow nao esta em Backlog." >&2
    failures=$((failures + 1))
  fi
}

while IFS='|' read -r repo first last tech_label; do
  for number in $(seq "${first}" "${last}"); do
    validate_issue "${repo}" "${number}" "${tech_label}"
  done
done <<'TARGETS'
Windows_Health|25|36|tech:windows
SQLServer_Health|38|49|tech:sqlserver
Linux_Health|15|27|tech:linux
Oracle_Health|7|16|tech:oracle
IIS_Health|17|22|tech:iis
nginx_health|14|20|tech:nginx
aws_health|20|21|tech:aws
TARGETS

if [[ "${failures}" -gt 0 ]]; then
  echo "Falha: ${failures} problema(s) em ${checked} issue(s)." >&2
  exit 1
fi

echo "Migracao Health validada: ${checked} issue(s), sem divergencias."
