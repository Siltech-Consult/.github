#!/usr/bin/env node

import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";
import {createRunGh} from "./lib/github-client.mjs";
import {withRetry} from "./lib/retry.mjs";
import {CLASSIFICATION_FIELDS, fetchOrganizationFields} from "./apply-issue-classification.mjs";

export const DELIVERY_PROJECT_TITLE = "Siltech Delivery";

const FIND_PROJECT_QUERY = `query($login: String!, $title: String!, $after: String) {
  organization(login: $login) {
    id
    projectsV2(first: 100, query: $title, after: $after) {
      nodes {
        id
        number
        title
        url
        public
        owner {
          ... on Organization { login }
          ... on User { login }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const PROJECT_QUERY = `query($projectId: ID!, $itemsAfter: String, $fieldsAfter: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      id
      number
      title
      url
      public
      owner {
        ... on Organization { login }
        ... on User { login }
      }
      fields(first: 100, after: $fieldsAfter) {
        nodes {
          __typename
          ... on ProjectV2Field { id name }
          ... on ProjectV2IterationField { id name }
          ... on ProjectV2SingleSelectField { id name }
        }
        pageInfo { hasNextPage endCursor }
      }
      items(first: 100, after: $itemsAfter) {
        nodes {
          content {
            ... on Issue { id }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
const CREATE_PROJECT_MUTATION = `mutation($ownerId: ID!, $title: String!) {
  createProjectV2(input: {ownerId: $ownerId, title: $title}) {
    projectV2 { id number title url }
  }
}`;
const ADD_ISSUE_FIELD_MUTATION = `mutation($projectId: ID!, $issueFieldId: ID!) {
  createProjectV2IssueField(
    input: {projectId: $projectId, issueFieldId: $issueFieldId}
  ) {
    projectV2Field { id }
  }
}`;
const ADD_ITEM_MUTATION = `mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
    item { id }
  }
}`;

function option(name, argv = process.argv) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function graphqlArgs(query, variables = {}) {
  return [
    "api", "graphql", "-f", `query=${query}`,
    ...Object.entries(variables)
      .filter(([, value]) => value !== undefined && value !== null)
      .flatMap(([name, value]) => ["-F", `${name}=${value}`])
  ];
}

function data(response) {
  return response?.data ?? response ?? {};
}

function pageNodes(connection) {
  return Array.isArray(connection?.nodes) ? connection.nodes.filter(Boolean) : [];
}

function projectField(field) {
  return {
    id: field?.id ?? null,
    name: field?.issueField?.name ?? field?.name ?? null,
    issueFieldId: field?.issueField?.id ?? null,
    type: field?.__typename ?? null
  };
}

export function normalizeProject(project = {}) {
  const projectFields = (project.projectFields ?? pageNodes(project.fields)).map(projectField);
  const contentIds = project.contentIds ?? pageNodes(project.items)
    .map((item) => item?.content?.id)
    .filter(Boolean);
  return {
    id: project.id ?? null,
    number: project.number ?? null,
    title: project.title ?? null,
    url: project.url ?? null,
    public: project.public,
    owner: project.owner?.login ?? project.owner ?? null,
    projectFields,
    issueFields: projectFields.filter((field) => field.issueFieldId),
    issueFieldIds: projectFields.map((field) => field.issueFieldId).filter(Boolean),
    issueFieldNames: projectFields.map((field) => field.name).filter(Boolean),
    contentIds
  };
}

function requireIssueIds(issues) {
  if (!Array.isArray(issues)) throw new Error("Inventario deve ser uma lista de issues");
  const ids = issues.map((issue) => issue?.id);
  if (ids.some((id) => !id)) throw new Error("Inventario possui issue sem ID organizacional");
  if (new Set(ids).size !== ids.length) throw new Error("Inventario possui IDs de issue duplicados");
}

export function extractProjectIssueFieldIds(fields) {
  const byName = new Map((Array.isArray(fields) ? fields : []).map((field) => [
    field?.name,
    field?.node_id ?? field?.nodeId
  ]));
  return Object.fromEntries(CLASSIFICATION_FIELDS.map((name) => {
    const id = byName.get(name);
    if (!id) throw new Error(`Node ID do Issue Field oficial ausente: ${name}`);
    return [name, id];
  }));
}

export async function fetchProjectIssueFieldIds({organization, runGh}) {
  return extractProjectIssueFieldIds(await fetchOrganizationFields({org: organization, runGh}));
}

export function buildProjectOperations({project = {}, requiredIssueFields = {}, issues = []} = {}) {
  requireIssueIds(issues);
  const issueFieldIds = new Set(project.issueFieldIds ?? []);
  const issueFieldNames = new Set(project.issueFieldNames ?? []);
  const contentIds = new Set(project.contentIds ?? []);
  const requiredIds = CLASSIFICATION_FIELDS.map((name) => {
    const id = requiredIssueFields[name];
    if (!id) throw new Error(`ID do Issue Field oficial ausente: ${name}`);
    return {name, id};
  });
  return {
    addIssueFields: requiredIds
      .filter(({name, id}) => !issueFieldIds.has(id) && !issueFieldNames.has(name))
      .map(({id}) => id),
    addItems: issues.map((issue) => issue.id).filter((id) => !contentIds.has(id))
  };
}

export async function findDeliveryProject({organization, runGh}) {
  let after = null;
  let ownerId;
  const matches = [];
  do {
    const response = await withRetry(() => runGh(graphqlArgs(FIND_PROJECT_QUERY, {
      login: organization,
      title: DELIVERY_PROJECT_TITLE,
      after
    })));
    const owner = data(response).organization;
    if (!owner?.id) throw new Error(`Organizacao nao encontrada: ${organization}`);
    ownerId ??= owner.id;
    matches.push(...pageNodes(owner.projectsV2).filter((project) => project.title === DELIVERY_PROJECT_TITLE));
    const pageInfo = owner.projectsV2?.pageInfo ?? {hasNextPage: false};
    if (pageInfo.hasNextPage && !pageInfo.endCursor) throw new Error("Paginacao de Projects sem cursor");
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after);
  if (matches.length > 1) throw new Error(`Mais de um Project encontrado com titulo ${DELIVERY_PROJECT_TITLE}`);
  return {ownerId, project: matches[0] ? normalizeProject(matches[0]) : null};
}

export async function fetchProject({projectId, runGh}) {
  let itemsAfter = null;
  let fieldsAfter = null;
  let state;
  do {
    const response = await withRetry(() => runGh(graphqlArgs(PROJECT_QUERY, {projectId, itemsAfter, fieldsAfter})));
    const project = data(response).node;
    if (!project?.id) throw new Error(`Project nao encontrado: ${projectId}`);
    if (!state) state = {...project, fields: {nodes: []}, items: {nodes: []}};
    const knownFields = new Set(state.fields.nodes.map((field) => field.id));
    state.fields.nodes.push(...pageNodes(project.fields).filter((field) => !knownFields.has(field.id)));
    const knownContent = new Set(state.items.nodes.map((item) => item?.content?.id));
    state.items.nodes.push(...pageNodes(project.items).filter((item) => !knownContent.has(item?.content?.id)));
    const nextItems = project.items?.pageInfo ?? {hasNextPage: false};
    const nextFields = project.fields?.pageInfo ?? {hasNextPage: false};
    if (nextItems.hasNextPage && !nextItems.endCursor) throw new Error("Paginacao de items sem cursor");
    if (nextFields.hasNextPage && !nextFields.endCursor) throw new Error("Paginacao de campos sem cursor");
    itemsAfter = nextItems.hasNextPage ? nextItems.endCursor : null;
    fieldsAfter = nextFields.hasNextPage ? nextFields.endCursor : null;
  } while (itemsAfter || fieldsAfter);
  return normalizeProject(state);
}

export async function createOrReuseDeliveryProject({organization, runGh, apply = false}) {
  const existing = await findDeliveryProject({organization, runGh});
  if (existing.project) return {created: false, project: existing.project};
  if (!apply) throw new Error("Recusando criar Project sem --apply");
  const response = await withRetry(() => runGh(graphqlArgs(CREATE_PROJECT_MUTATION, {
    ownerId: existing.ownerId,
    title: DELIVERY_PROJECT_TITLE
  })));
  const project = data(response).createProjectV2?.projectV2;
  if (!project?.id) throw new Error("GitHub nao devolveu Project criado");
  return {created: true, project: normalizeProject(project)};
}

export async function applyProjectOperations({
  projectId,
  operations,
  runGh,
  apply = false,
  batchSize = 20,
  itemPauseMs = 250,
  batchPauseMs = 2000,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  retrySleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
} = {}) {
  if (!apply) throw new Error("Recusando escrita sem --apply");
  if (!projectId) throw new Error("ID do Project ausente");
  if (typeof runGh !== "function") throw new Error("runGh e obrigatorio");
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batchSize deve ser inteiro positivo");
  const fields = operations?.addIssueFields ?? [];
  const items = operations?.addItems ?? [];
  for (const issueFieldId of fields) {
    await withRetry(
      () => runGh(graphqlArgs(ADD_ISSUE_FIELD_MUTATION, {projectId, issueFieldId})),
      {sleep: retrySleep}
    );
  }
  for (let index = 0; index < items.length; index += 1) {
    if (index > 0) await sleep(index % batchSize === 0 ? batchPauseMs : itemPauseMs);
    await withRetry(
      () => runGh(graphqlArgs(ADD_ITEM_MUTATION, {projectId, contentId: items[index]})),
      {sleep: retrySleep}
    );
  }
}

export async function synchronizeDeliveryProject({
  organization = "Siltech-Consult",
  issues,
  requiredIssueFields,
  runGh,
  apply = false,
  ...options
} = {}) {
  requireIssueIds(issues);
  const {created, project: selected} = await createOrReuseDeliveryProject({organization, runGh, apply});
  const project = await fetchProject({projectId: selected.id, runGh});
  if (project.public !== false) throw new Error(`Project ${DELIVERY_PROJECT_TITLE} deve ser privado`);
  const operations = buildProjectOperations({project, requiredIssueFields, issues});
  await applyProjectOperations({projectId: project.id, operations, runGh, apply, ...options});
  const updatedProject = await fetchProject({projectId: project.id, runGh});
  if (updatedProject.public !== false) throw new Error(`Project ${DELIVERY_PROJECT_TITLE} deve ser privado`);
  return {created, operations, project: updatedProject};
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Falha ao ler inventario em ${path}: ${error.message}`);
  }
}

export async function main(argv = process.argv) {
  const inventoryPath = option("--inventory", argv) ?? "artifacts/open-issues.json";
  const organization = option("--organization", argv) ?? "Siltech-Consult";
  const executable = option("--gh", argv) ?? process.env.GH_BIN ?? "gh";
  try {
    if (!argv.includes("--apply")) throw new Error("Recusando escrita sem --apply");
    const issues = await readJson(inventoryPath);
    const runGh = createRunGh({executable});
    const requiredIssueFields = await fetchProjectIssueFieldIds({organization, runGh});
    const result = await synchronizeDeliveryProject({
      organization,
      issues,
      requiredIssueFields,
      runGh,
      apply: true
    });
    console.log(`Project ${result.created ? "criado" : "reutilizado"}: #${result.project.number} ${result.project.url}`);
    console.log(`Campos associados: ${result.operations.addIssueFields.length}; issues adicionadas: ${result.operations.addItems.length}`);
  } catch (error) {
    console.error(`Falha ao preparar Project: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
