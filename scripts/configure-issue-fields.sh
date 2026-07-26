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

field_by_name() {
  local name="$1"
  jq -c --arg name "${name}" '.[] | select(.name == $name)' <<<"${fields}"
}

patch_field() {
  local field_id="$1"
  local payload="$2"

  gh api \
    --method PATCH \
    -H "X-GitHub-Api-Version: ${API_VERSION}" \
    "orgs/${ORG}/issue-fields/${field_id}" \
    --input - <<<"${payload}" >/dev/null
}

create_field() {
  local payload="$1"

  gh api \
    --method POST \
    -H "X-GitHub-Api-Version: ${API_VERSION}" \
    "orgs/${ORG}/issue-fields" \
    --input - <<<"${payload}" >/dev/null
}

priority_field="$(field_by_name "Priority")"
if [[ -z "${priority_field}" ]]; then
  echo "Criando Priority"
  create_field "$(
    jq -n '{
      name: "Priority",
      description: "Prioridade operacional oficial da issue",
      data_type: "single_select",
      options: [
        {name:"P0",description:"Bloqueio, seguranca ou confiabilidade critica",color:"red",priority:1},
        {name:"P1",description:"Executar no proximo ciclo",color:"orange",priority:2},
        {name:"P2",description:"Importante e planejavel",color:"yellow",priority:3},
        {name:"P3",description:"Backlog priorizado",color:"green",priority:4},
        {name:"P4",description:"Melhoria futura",color:"blue",priority:5},
        {name:"P5",description:"Oportunidade de longo prazo",color:"gray",priority:6}
      ]
    }'
  )"
else
  echo "Atualizando Priority"
  priority_id="$(jq -r '.id' <<<"${priority_field}")"
  priority_payload="$(
    jq -n --argjson field "${priority_field}" '{
      name: "Priority",
      description: "Prioridade operacional oficial da issue",
      options: [
        {
          id: ([$field.options[] | select(.name == "P0" or .name == "Urgent") | .id][0] // null),
          name:"P0",description:"Bloqueio, seguranca ou confiabilidade critica",color:"red",priority:1
        },
        {
          id: ([$field.options[] | select(.name == "P1" or .name == "High") | .id][0] // null),
          name:"P1",description:"Executar no proximo ciclo",color:"orange",priority:2
        },
        {
          id: ([$field.options[] | select(.name == "P2" or .name == "Medium") | .id][0] // null),
          name:"P2",description:"Importante e planejavel",color:"yellow",priority:3
        },
        {
          id: ([$field.options[] | select(.name == "P3" or .name == "Low") | .id][0] // null),
          name:"P3",description:"Backlog priorizado",color:"green",priority:4
        },
        {
          id: ([$field.options[] | select(.name == "P4") | .id][0] // null),
          name:"P4",description:"Melhoria futura",color:"blue",priority:5
        },
        {
          id: ([$field.options[] | select(.name == "P5") | .id][0] // null),
          name:"P5",description:"Oportunidade de longo prazo",color:"gray",priority:6
        }
      ] | map(if .id == null then del(.id) else . end)
    }'
  )"
  patch_field "${priority_id}" "${priority_payload}"
fi

effort_field="$(field_by_name "Effort")"
if [[ -z "${effort_field}" ]]; then
  echo "Criando Effort"
  create_field "$(
    jq -n '{
      name: "Effort",
      description: "Esforco relativo estimado para concluir a issue",
      data_type: "single_select",
      options: [
        {name:"XS",description:"Ate algumas horas",color:"gray",priority:1},
        {name:"S",description:"Ate um dia",color:"green",priority:2},
        {name:"M",description:"Poucos dias",color:"yellow",priority:3},
        {name:"L",description:"Ate uma semana",color:"orange",priority:4},
        {name:"XL",description:"Mais de uma semana ou exige decomposicao",color:"red",priority:5}
      ]
    }'
  )"
else
  echo "Atualizando Effort"
  effort_id="$(jq -r '.id' <<<"${effort_field}")"
  effort_payload="$(
    jq -n --argjson field "${effort_field}" '{
      name: "Effort",
      description: "Esforco relativo estimado para concluir a issue",
      options: [
        {
          id: ([$field.options[] | select(.name == "XS") | .id][0] // null),
          name:"XS",description:"Ate algumas horas",color:"gray",priority:1
        },
        {
          id: ([$field.options[] | select(.name == "S" or .name == "Low") | .id][0] // null),
          name:"S",description:"Ate um dia",color:"green",priority:2
        },
        {
          id: ([$field.options[] | select(.name == "M" or .name == "Medium") | .id][0] // null),
          name:"M",description:"Poucos dias",color:"yellow",priority:3
        },
        {
          id: ([$field.options[] | select(.name == "L" or .name == "High") | .id][0] // null),
          name:"L",description:"Ate uma semana",color:"orange",priority:4
        },
        {
          id: ([$field.options[] | select(.name == "XL") | .id][0] // null),
          name:"XL",description:"Mais de uma semana ou exige decomposicao",color:"red",priority:5
        }
      ] | map(if .id == null then del(.id) else . end)
    }'
  )"
  patch_field "${effort_id}" "${effort_payload}"
fi

status_field="$(field_by_name "Status")"
if [[ -z "${status_field}" ]]; then
  echo "Criando Status"
  create_field "$(
    jq -n '{
      name: "Status",
      description: "Estado atual do fluxo de trabalho",
      data_type: "single_select",
      options: [
        {name:"Backlog",description:"Ainda nao preparado para execucao",color:"gray",priority:1},
        {name:"Ready",description:"Pronto para iniciar",color:"blue",priority:2},
        {name:"In progress",description:"Implementacao em andamento",color:"yellow",priority:3},
        {name:"Blocked",description:"Aguardando dependencia ou decisao",color:"red",priority:4},
        {name:"Validation",description:"Implementado e aguardando evidencia",color:"purple",priority:5},
        {name:"Frozen",description:"Conscientemente congelado",color:"orange",priority:6},
        {name:"Done",description:"Concluido e validado",color:"green",priority:7}
      ]
    }'
  )"
else
  echo "Status ja existe; preservado"
fi

wave_field="$(field_by_name "Wave")"
if [[ -z "${wave_field}" ]]; then
  echo "Criando Wave"
  create_field "$(
    jq -n '{
      name: "Wave",
      description: "Onda planejada de entrega",
      data_type: "single_select",
      options: [
        {name:"Onda 1",description:"Primeira versao funcional",color:"red",priority:1},
        {name:"Onda 2",description:"Expansao apos estabilizacao",color:"yellow",priority:2},
        {name:"Futuro",description:"Sem compromisso no ciclo atual",color:"gray",priority:3}
      ]
    }'
  )"
else
  echo "Wave ja existe; preservado"
fi

echo "Campos configurados."
