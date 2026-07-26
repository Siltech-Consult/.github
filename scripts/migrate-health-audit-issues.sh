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

fields="$(
  gh api \
    -H "X-GitHub-Api-Version: ${API_VERSION}" \
    "orgs/${ORG}/issue-fields"
)"
priority_field_id="$(
  jq -r '.[] | select(.name == "Priority") | .id' <<<"${fields}"
)"
status_field_id="$(
  jq -r '.[] | select(.name == "Status") | .id' <<<"${fields}"
)"

if [[ -z "${priority_field_id}" || -z "${status_field_id}" ]]; then
  echo "Erro: configure Priority e Status antes da migracao." >&2
  exit 1
fi

issue_type() {
  local ref="$1"

  case "${ref}" in
    Windows_Health#26|Windows_Health#27|Windows_Health#28|Windows_Health#29|Windows_Health#30|\
    SQLServer_Health#45|\
    Linux_Health#20|Linux_Health#21|Linux_Health#22|\
    Oracle_Health#9|Oracle_Health#10|\
    IIS_Health#18|\
    nginx_health#14|nginx_health#15|nginx_health#17|nginx_health#18|\
    aws_health#20)
      echo "Bug"
      ;;
    SQLServer_Health#39|Linux_Health#16|Oracle_Health#7|IIS_Health#17)
      echo "Feature"
      ;;
    *)
      echo "Task"
      ;;
  esac
}

current_priority() {
  local repo="$1"
  local number="$2"

  gh api \
    -H "X-GitHub-Api-Version: ${API_VERSION}" \
    "repos/${ORG}/${repo}/issues/${number}/issue-field-values" \
    --jq '.[] | select(.issue_field_name == "Priority") | .single_select_option.name'
}

migrate_issue() {
  local repo="$1"
  local number="$2"
  local tech_label="$3"
  local title priority clean_title type payload

  title="$(
    gh issue view "${number}" \
      --repo "${ORG}/${repo}" \
      --json title \
      --jq '.title'
  )"

  if [[ "${title}" =~ ^\[(P[0-5])\][[:space:]]*(.*)$ ]]; then
    priority="${BASH_REMATCH[1]}"
    clean_title="${BASH_REMATCH[2]}"
  else
    priority="$(current_priority "${repo}" "${number}")"
    clean_title="${title}"
  fi

  if [[ ! "${priority}" =~ ^P[0-5]$ ]]; then
    echo "Erro: prioridade nao identificada em ${repo}#${number}." >&2
    exit 1
  fi

  type="$(issue_type "${repo}#${number}")"
  echo "${repo}#${number}: ${priority}, ${type}"

  gh issue edit "${number}" \
    --repo "${ORG}/${repo}" \
    --title "${clean_title}" \
    --type "${type}" \
    --add-label "area:collector" \
    --add-label "${tech_label}" >/dev/null

  payload="$(
    jq -n \
      --argjson priority_field_id "${priority_field_id}" \
      --argjson status_field_id "${status_field_id}" \
      --arg priority "${priority}" \
      '{
        issue_field_values: [
          {field_id:$priority_field_id,value:$priority},
          {field_id:$status_field_id,value:"Backlog"}
        ]
      }'
  )"

  gh api \
    --method POST \
    -H "X-GitHub-Api-Version: ${API_VERSION}" \
    "repos/${ORG}/${repo}/issues/${number}/issue-field-values" \
    --input - <<<"${payload}" >/dev/null
}

while IFS='|' read -r repo first last tech_label; do
  for number in $(seq "${first}" "${last}"); do
    migrate_issue "${repo}" "${number}" "${tech_label}"
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

echo "Migracao Health concluida."
