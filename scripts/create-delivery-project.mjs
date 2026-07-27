#!/usr/bin/env node

import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";
import {createRunGh} from "./lib/github-client.mjs";
import {writeJsonAtomically} from "./lib/report.mjs";
import {isTransientGitHubError, withRetry} from "./lib/retry.mjs";
import {CLASSIFICATION_FIELDS, fetchOrganizationFields} from "./apply-issue-classification.mjs";

export const DELIVERY_PROJECT_TITLE = "Siltech Delivery";
export const DEFAULT_MANIFEST_PATH = "artifacts/delivery-project-manifest.json";
const CREATE_DELAYS = [1000, 2000, 4000, 8000];

const FIND_PROJECT_QUERY = `query($login: String!, $title: String!, $after: String) {
  organization(login: $login) { id projectsV2(first: 100, query: $title, after: $after) {
    nodes { id number title url public owner { ... on Organization { login } ... on User { login } } }
    pageInfo { hasNextPage endCursor }
  } }
}`;
const PROJECT_QUERY = `query($projectId: ID!, $itemsAfter: String, $fieldsAfter: String) {
  node(id: $projectId) { ... on ProjectV2 {
    id number title url public owner { ... on Organization { login } ... on User { login } }
    fields(first: 100, after: $fieldsAfter) { nodes {
      __typename
      ... on ProjectV2Field { id name dataType }
      ... on ProjectV2IterationField { id name dataType }
      ... on ProjectV2SingleSelectField { id name dataType }
    } pageInfo { hasNextPage endCursor } }
    items(first: 100, after: $itemsAfter, archivedStates: [ARCHIVED, NOT_ARCHIVED]) {
      nodes { id isArchived content { ... on Issue { id } } }
      pageInfo { hasNextPage endCursor }
    }
  } }
}`;
const CREATE_PROJECT_MUTATION = `mutation($ownerId: ID!, $title: String!) {
  createProjectV2(input: {ownerId: $ownerId, title: $title}) { projectV2 { id number title url } }
}`;
const ADD_ISSUE_FIELD_MUTATION = `mutation($projectId: ID!, $issueFieldId: ID!) {
  createProjectV2IssueField(input: {projectId: $projectId, issueFieldId: $issueFieldId}) {
    projectV2Field { ... on ProjectV2Field { id name dataType } }
  }
}`;
const ADD_ITEM_MUTATION = `mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
    item { id content { ... on Issue { id } } }
  }
}`;

function option(name, argv = process.argv) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function graphqlArgs(query, variables = {}) {
  return ["api", "graphql", "-f", `query=${query}`,
    ...Object.entries(variables).filter(([, value]) => value != null).flatMap(([name, value]) => ["-F", `${name}=${value}`])];
}

function data(response) { return response?.data ?? response ?? {}; }
function pageNodes(connection) { return Array.isArray(connection?.nodes) ? connection.nodes.filter(Boolean) : []; }
function fieldRecord(field) { return {id: field?.id ?? null, name: field?.name ?? null, dataType: field?.dataType ?? null, type: field?.__typename ?? null}; }
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

export function normalizeProject(project = {}) {
  const projectFields = (project.projectFields ?? pageNodes(project.fields)).map(fieldRecord);
  const items = project.projectItems ?? pageNodes(project.items);
  const contentIds = project.contentIds ?? items.map((item) => item?.content?.id).filter(Boolean);
  return {
    id: project.id ?? null, number: project.number ?? null, title: project.title ?? null, url: project.url ?? null,
    public: project.public, owner: project.owner?.login ?? project.owner ?? null,
    projectFields, contentIds, rawItemCount: items.length, rawItems: items
  };
}

function requireIssueIds(issues) {
  if (!Array.isArray(issues)) throw new Error("Inventario deve ser uma lista de issues");
  const ids = issues.map((issue) => issue?.id);
  if (ids.some((id) => !id)) throw new Error("Inventario possui issue sem ID organizacional");
  if (new Set(ids).size !== ids.length) throw new Error("Inventario possui IDs de issue duplicados");
}

export function extractProjectIssueFieldIds(fields) {
  const byName = new Map((Array.isArray(fields) ? fields : []).map((field) => [field?.name, field?.node_id ?? field?.nodeId]));
  return Object.fromEntries(CLASSIFICATION_FIELDS.map((name) => {
    const id = byName.get(name);
    if (!id) throw new Error(`Node ID do Issue Field oficial ausente: ${name}`);
    return [name, id];
  }));
}

export async function fetchProjectIssueFieldIds({organization, runGh}) {
  return extractProjectIssueFieldIds(await fetchOrganizationFields({org: organization, runGh}));
}

export function buildProjectOperations({project = {}, requiredIssueFields = {}, issues = [], manifest} = {}) {
  requireIssueIds(issues);
  const mapped = new Set(Object.values(manifest?.issueFields ?? {}).map((field) => field.issueFieldId));
  const legacyIds = new Set(project.issueFieldIds ?? []);
  const legacyNames = new Set(project.issueFieldNames ?? []);
  const contentIds = new Set(project.contentIds ?? []);
  return {
    addIssueFields: CLASSIFICATION_FIELDS.map((name) => ({name, id: requiredIssueFields[name]}))
      .map(({name, id}) => {
        if (!id) throw new Error(`ID do Issue Field oficial ausente: ${name}`);
        return {name, id};
      })
      .filter(({name, id}) => !mapped.has(id) && !legacyIds.has(id) && !legacyNames.has(name))
      .map(({id}) => id),
    addItems: issues.map((issue) => issue.id).filter((id) => !contentIds.has(id))
  };
}

export async function findDeliveryProject({organization, runGh}) {
  let after = null;
  let ownerId;
  const matches = [];
  do {
    const response = await withRetry(() => runGh(graphqlArgs(FIND_PROJECT_QUERY, {login: organization, title: DELIVERY_PROJECT_TITLE, after})));
    const owner = data(response).organization;
    if (!owner?.id) throw new Error(`Organizacao nao encontrada: ${organization}`);
    ownerId ??= owner.id;
    matches.push(...pageNodes(owner.projectsV2).filter((project) => project.title === DELIVERY_PROJECT_TITLE));
    const page = owner.projectsV2?.pageInfo ?? {hasNextPage: false};
    if (page.hasNextPage && (!page.endCursor || page.endCursor === after)) throw new Error("Cursor de Projects nao avancou");
    after = page.hasNextPage ? page.endCursor : null;
  } while (after);
  if (matches.length > 1) throw new Error(`Mais de um Project encontrado com titulo ${DELIVERY_PROJECT_TITLE}`);
  return {ownerId, project: matches[0] ? normalizeProject(matches[0]) : null};
}

export async function fetchProject({projectId, runGh}) {
  let itemsAfter = null;
  let fieldsAfter = null;
  let state;
  let previousItemsAfter;
  let previousFieldsAfter;
  do {
    const requestedItemsAfter = itemsAfter;
    const requestedFieldsAfter = fieldsAfter;
    const response = await withRetry(() => runGh(graphqlArgs(PROJECT_QUERY, {projectId, itemsAfter, fieldsAfter})));
    const project = data(response).node;
    if (!project?.id) throw new Error(`Project nao encontrado: ${projectId}`);
    if (!state) state = {...project, fields: {nodes: []}, items: {nodes: []}};
    if (requestedFieldsAfter !== previousFieldsAfter) state.fields.nodes.push(...pageNodes(project.fields));
    if (requestedItemsAfter !== previousItemsAfter) state.items.nodes.push(...pageNodes(project.items));
    previousFieldsAfter = requestedFieldsAfter;
    previousItemsAfter = requestedItemsAfter;
    const nextItems = project.items?.pageInfo ?? {hasNextPage: false};
    const nextFields = project.fields?.pageInfo ?? {hasNextPage: false};
    if (nextItems.hasNextPage && (!nextItems.endCursor || nextItems.endCursor === requestedItemsAfter)) throw new Error("Cursor de items nao avancou");
    if (nextFields.hasNextPage && (!nextFields.endCursor || nextFields.endCursor === requestedFieldsAfter)) throw new Error("Cursor de campos nao avancou");
    itemsAfter = nextItems.hasNextPage ? nextItems.endCursor : null;
    fieldsAfter = nextFields.hasNextPage ? nextFields.endCursor : null;
  } while (itemsAfter || fieldsAfter);
  return normalizeProject(state);
}

function projectManifest(project) {
  return {schemaVersion: 1, project: {id: project.id, number: project.number, title: DELIVERY_PROJECT_TITLE, owner: project.owner ?? null, url: project.url ?? null}, issueFields: {}};
}

function manifestFailure(manifest, project, organization) {
  if (!manifest) return {type: "missing_project_manifest"};
  if (manifest.project?.id !== project.id || manifest.project?.title !== DELIVERY_PROJECT_TITLE || manifest.project?.owner !== organization) {
    return {type: "untrusted_project_manifest"};
  }
  return null;
}

export function validateDeliveryProject({organization = "Siltech-Consult", project, requiredIssueFields = {}, issues = [], manifest, complete = true, now = () => new Date().toISOString()} = {}) {
  const failures = [];
  if (!project) failures.push({type: "missing_project", title: DELIVERY_PROJECT_TITLE});
  else {
    if (project.title !== DELIVERY_PROJECT_TITLE) failures.push({type: "project_title_mismatch", expected: DELIVERY_PROJECT_TITLE, actual: project.title ?? null});
    if (project.owner !== organization) failures.push({type: "project_owner_mismatch", expected: organization, actual: project.owner ?? null});
    if (project.public !== false) failures.push({type: "project_not_private"});
    const trust = manifestFailure(manifest, project, organization);
    if (trust) failures.push(trust);
    const fields = project.projectFields ?? [];
    for (const name of CLASSIFICATION_FIELDS) {
      const matches = fields.filter((field) => field?.name === name);
      if (matches.length > 1) failures.push({type: "duplicate_project_field", field: name, count: matches.length});
      const mapping = manifest?.issueFields?.[name];
      if (!mapping) {
        if (matches.length > 0) failures.push({type: "untrusted_project_field", field: name});
        else if (complete && !trust) failures.push({type: "missing_project_issue_field", field: name});
        continue;
      }
      if (mapping.issueFieldId !== requiredIssueFields[name]) failures.push({type: "manifest_issue_field_id_changed", field: name});
      const byId = fields.filter((field) => field?.id === mapping.projectFieldId);
      if (byId.length !== 1 || byId[0].name !== mapping.name || byId[0].dataType !== mapping.dataType || mapping.name !== name) {
        failures.push({type: "project_field_manifest_mismatch", field: name});
      }
      if (matches.length !== 1 || matches[0]?.id !== mapping.projectFieldId) failures.push({type: "project_field_untrusted", field: name});
    }
    const counts = new Map();
    for (const id of project.contentIds ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const issue of issues) {
      if (!issue?.id) failures.push({type: "inventory_issue_without_id"});
      else if (!counts.has(issue.id)) failures.push({type: "missing_project_item", contentId: issue.id});
      else if (counts.get(issue.id) !== 1) failures.push({type: "duplicate_project_item", contentId: issue.id, count: counts.get(issue.id)});
    }
  }
  return {generated_at: now(), summary: {issues: issues.length, project_items: project?.rawItemCount ?? 0, failures: failures.length}, ok: failures.length === 0, failures};
}

export async function createOrReuseDeliveryProject({organization, runGh, apply = false, retrySleep = sleep} = {}) {
  let existing = await findDeliveryProject({organization, runGh});
  if (existing.project) return {created: false, project: existing.project};
  if (!apply) throw new Error("Recusando criar Project sem --apply");
  for (let attempt = 0; attempt <= CREATE_DELAYS.length; attempt += 1) {
    try {
      const response = await runGh(graphqlArgs(CREATE_PROJECT_MUTATION, {ownerId: existing.ownerId, title: DELIVERY_PROJECT_TITLE}));
      const project = data(response).createProjectV2?.projectV2;
      if (!project?.id) throw new Error("ID do Project criado ausente");
      return {created: true, project: normalizeProject(project)};
    } catch (error) {
      if (!isTransientGitHubError(error)) throw error;
      existing = await findDeliveryProject({organization, runGh});
      if (existing.project) return {created: false, project: existing.project};
      if (attempt === CREATE_DELAYS.length) throw error;
      await retrySleep(CREATE_DELAYS[attempt]);
    }
  }
  throw new Error("Create Project esgotado");
}

export async function applyProjectOperations({projectId, operations, fieldNamesById = {}, manifest, runGh, apply = false, batchSize = 20, itemPauseMs = 250, batchPauseMs = 2000, sleep: pause = sleep, retrySleep = sleep, checkpoint = async () => {}} = {}) {
  if (!apply) throw new Error("Recusando escrita sem --apply");
  if (!projectId || typeof runGh !== "function" || !manifest) throw new Error("Project, runGh e manifest sao obrigatorios");
  const fields = operations?.addIssueFields ?? [];
  const items = operations?.addItems ?? [];
  for (const entry of fields) {
    const issueFieldId = typeof entry === "string" ? entry : entry.id;
    const name = typeof entry === "string" ? fieldNamesById[entry] : entry.name;
    const response = await withRetry(() => runGh(graphqlArgs(ADD_ISSUE_FIELD_MUTATION, {projectId, issueFieldId})), {sleep: retrySleep});
    const field = data(response).createProjectV2IssueField?.projectV2Field;
    if (!field?.id) throw new Error("ID do campo do Project ausente");
    if (!name || field.name !== name || !field.dataType) throw new Error(`Resposta invalida para campo ${name ?? issueFieldId}`);
    manifest.issueFields[name] = {issueFieldId, projectFieldId: field.id, name: field.name, dataType: field.dataType};
    await checkpoint(manifest);
  }
  for (let index = 0; index < items.length; index += 1) {
    if (index > 0) await pause(index % batchSize === 0 ? batchPauseMs : itemPauseMs);
    const contentId = items[index];
    const response = await withRetry(() => runGh(graphqlArgs(ADD_ITEM_MUTATION, {projectId, contentId})), {sleep: retrySleep});
    const item = data(response).addProjectV2ItemById?.item;
    if (!item?.id) throw new Error("ID do item do Project ausente");
    if (item.content?.id !== contentId) throw new Error("content ID inesperado na resposta do Project");
  }
}

async function readJson(path, description = "inventario") { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { throw new Error(`Falha ao ler ${description} em ${path}: ${error.message}`); } }
async function readOptionalJson(path) { try { return await readJson(path, "manifest"); } catch (error) { if (error.cause?.code === "ENOENT" || /ENOENT/.test(error.message)) return null; throw error; } }

export async function synchronizeDeliveryProject({organization = "Siltech-Consult", issues, requiredIssueFields, runGh, apply = false, manifestPath = DEFAULT_MANIFEST_PATH, manifest: suppliedManifest, readManifest = readOptionalJson, writeManifest = writeJsonAtomically, ...options} = {}) {
  requireIssueIds(issues);
  const selected = await createOrReuseDeliveryProject({organization, runGh, apply, retrySleep: options.retrySleep});
  let manifest = suppliedManifest ?? await readManifest(manifestPath);
  if (!manifest && !selected.created) throw new Error(`Project existente sem manifest confiavel: ${manifestPath}`);
  const project = await fetchProject({projectId: selected.project.id, runGh});
  if (!manifest) { manifest = projectManifest(project); manifest.project.owner = organization; await writeManifest(manifestPath, manifest); }
  const baseline = validateDeliveryProject({organization, project, requiredIssueFields, issues: [], manifest, complete: false});
  if (!baseline.ok) throw new Error(`Project sem estado confiavel: ${baseline.failures.map((failure) => failure.type).join(", ")}`);
  const operations = buildProjectOperations({project, requiredIssueFields, issues, manifest});
  await applyProjectOperations({projectId: project.id, operations, fieldNamesById: Object.fromEntries(CLASSIFICATION_FIELDS.map((name) => [requiredIssueFields[name], name])), manifest, runGh, apply, checkpoint: (state) => writeManifest(manifestPath, state), ...options});
  const updatedProject = await fetchProject({projectId: project.id, runGh});
  const audit = validateDeliveryProject({organization, project: updatedProject, requiredIssueFields, issues, manifest});
  if (!audit.ok) throw new Error(`Postcondicoes do Project falharam: ${audit.failures.map((failure) => failure.type).join(", ")}`);
  await writeManifest(manifestPath, manifest);
  return {created: selected.created, operations, project: updatedProject, manifest, audit};
}

export async function main(argv = process.argv) {
  const inventoryPath = option("--inventory", argv) ?? "artifacts/open-issues.json";
  const manifestPath = option("--manifest", argv) ?? DEFAULT_MANIFEST_PATH;
  const organization = option("--organization", argv) ?? "Siltech-Consult";
  const executable = option("--gh", argv) ?? process.env.GH_BIN ?? "gh";
  try {
    if (!argv.includes("--apply")) throw new Error("Recusando escrita sem --apply");
    const issues = await readJson(inventoryPath);
    const runGh = createRunGh({executable});
    const requiredIssueFields = await fetchProjectIssueFieldIds({organization, runGh});
    const result = await synchronizeDeliveryProject({organization, issues, requiredIssueFields, runGh, apply: true, manifestPath});
    console.log(`Project ${result.created ? "criado" : "reutilizado"}: #${result.project.number} ${result.project.url}`);
  } catch (error) { console.error(`Falha ao preparar Project: ${error.message}`); process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
