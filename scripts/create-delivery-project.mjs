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
export const MANIFEST_SCHEMA_VERSION = 2;
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
    projectV2Field {
      ... on ProjectV2Field { id name dataType }
      ... on ProjectV2SingleSelectField { id name dataType }
      ... on ProjectV2IterationField { id name dataType }
    }
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
  const seenCursors = new Set();
  do {
    const response = await withRetry(() => runGh(graphqlArgs(FIND_PROJECT_QUERY, {login: organization, title: DELIVERY_PROJECT_TITLE, after})));
    const owner = data(response).organization;
    if (!owner?.id) throw new Error(`Organizacao nao encontrada: ${organization}`);
    ownerId ??= owner.id;
    matches.push(...pageNodes(owner.projectsV2).filter((project) => project.title === DELIVERY_PROJECT_TITLE));
    const page = owner.projectsV2?.pageInfo ?? {hasNextPage: false};
    if (page.hasNextPage && !page.endCursor) throw new Error("Cursor de Projects ausente");
    if (page.hasNextPage && page.endCursor === after) throw new Error("Cursor de Projects nao avancou");
    if (page.hasNextPage && seenCursors.has(page.endCursor)) throw new Error("Ciclo de cursor de Projects");
    if (page.hasNextPage) seenCursors.add(page.endCursor);
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
  const seenItemCursors = new Set();
  const seenFieldCursors = new Set();
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
    if (nextItems.hasNextPage && !nextItems.endCursor) throw new Error("Cursor de items ausente");
    if (nextFields.hasNextPage && !nextFields.endCursor) throw new Error("Cursor de campos ausente");
    if (nextItems.hasNextPage && nextItems.endCursor === requestedItemsAfter) throw new Error("Cursor de items nao avancou");
    if (nextFields.hasNextPage && nextFields.endCursor === requestedFieldsAfter) throw new Error("Cursor de campos nao avancou");
    if (nextItems.hasNextPage && seenItemCursors.has(nextItems.endCursor)) throw new Error("Ciclo de cursor de items");
    if (nextFields.hasNextPage && seenFieldCursors.has(nextFields.endCursor)) throw new Error("Ciclo de cursor de campos");
    if (nextItems.hasNextPage) seenItemCursors.add(nextItems.endCursor);
    if (nextFields.hasNextPage) seenFieldCursors.add(nextFields.endCursor);
    itemsAfter = nextItems.hasNextPage ? nextItems.endCursor : null;
    fieldsAfter = nextFields.hasNextPage ? nextFields.endCursor : null;
  } while (itemsAfter || fieldsAfter);
  return normalizeProject(state);
}

function pendingCreateManifest({organization, runNonce, now}) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    state: "pending_create",
    pendingCreate: {organization, title: DELIVERY_PROJECT_TITLE, runNonce, timestamp: now()},
    project: null,
    issueFields: {}
  };
}

function bindManifest(manifest, project, organization) {
  manifest.state = "bound";
  manifest.project = {id: project.id, number: project.number ?? null, title: DELIVERY_PROJECT_TITLE, owner: organization, url: project.url ?? null};
  manifest.issueFields ??= {};
  return manifest;
}

function manifestStructureFailure(manifest, organization) {
  if (!manifest) return {type: "missing_project_manifest"};
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return {type: "invalid_project_manifest", reason: "manifest deve ser objeto"};
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) return {type: "invalid_project_manifest", reason: `schemaVersion deve ser ${MANIFEST_SCHEMA_VERSION}`};
  if (!["pending_create", "bound"].includes(manifest.state)) return {type: "invalid_project_manifest", reason: "state invalido"};
  const pending = manifest.pendingCreate;
  if (!pending || typeof pending !== "object" || pending.organization !== organization || pending.title !== DELIVERY_PROJECT_TITLE ||
    typeof pending.runNonce !== "string" || pending.runNonce === "") {
    return {type: "invalid_project_manifest", reason: "pendingCreate invalido"};
  }
  if (!validIsoTimestamp(pending.timestamp)) return {type: "invalid_project_manifest", reason: "timestamp pendente invalido"};
  if (!manifest.issueFields || typeof manifest.issueFields !== "object" || Array.isArray(manifest.issueFields)) return {type: "invalid_project_manifest", reason: "issueFields invalido"};
  for (const [name, mapping] of Object.entries(manifest.issueFields)) {
    if (!CLASSIFICATION_FIELDS.includes(name) || !mapping || typeof mapping !== "object" || mapping.name !== name ||
      !["issueFieldId", "projectFieldId", "name", "dataType"].every((key) => typeof mapping[key] === "string" && mapping[key] !== "")) {
      return {type: "invalid_project_manifest", reason: `mapping invalido para ${name}`};
    }
  }
  if (manifest.state === "pending_create") {
    if (manifest.project !== null) return {type: "invalid_project_manifest", reason: "Project pendente nao pode ter ID"};
    if (Object.keys(manifest.issueFields).length !== 0) return {type: "invalid_project_manifest", reason: "Project pendente nao pode ter mappings"};
  } else if (!manifest.project || typeof manifest.project !== "object" || typeof manifest.project.id !== "string" || manifest.project.id === "" ||
    !Number.isInteger(manifest.project.number) || manifest.project.number < 1 || !githubUrl(manifest.project.url) ||
    manifest.project.title !== DELIVERY_PROJECT_TITLE || manifest.project.owner !== pending.organization) {
    return {type: "invalid_project_manifest", reason: "Project vinculado invalido"};
  }
  return null;
}

function validIsoTimestamp(value) {
  if (typeof value !== "string" || value === "") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function githubUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && url.pathname !== "/";
  } catch { return false; }
}

function manifestFailure(manifest, project, organization) {
  const structure = manifestStructureFailure(manifest, organization);
  if (structure) return structure;
  if (manifest.state !== "bound") return {type: "untrusted_project_manifest"};
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

export async function createOrReuseDeliveryProject({organization, runGh, apply = false, manifest: suppliedManifest, manifestPath = DEFAULT_MANIFEST_PATH, writeManifest, runNonce = randomNonce(), now = () => new Date().toISOString(), retrySleep = sleep} = {}) {
  if (suppliedManifest) {
    const invalid = manifestStructureFailure(suppliedManifest, organization);
    if (invalid) throw new Error(`Manifest invalido: ${invalid.reason ?? invalid.type}`);
  }
  let existing = await findDeliveryProject({organization, runGh});
  let manifest = suppliedManifest;
  if (existing.project) {
    if (manifest?.state === "pending_create") {
      if (apply) {
        bindManifest(manifest, existing.project, organization);
        await persistManifest(writeManifest, manifestPath, manifest);
      }
    } else if (manifest?.state === "bound" && manifest.project.id !== existing.project.id) {
      throw new Error("Project vinculado divergente; execute reset manual do manifest antes de continuar");
    }
    return {created: false, project: existing.project, manifest};
  }
  if (manifest?.state === "bound") {
    throw new Error("Project vinculado ausente; execute reset manual do manifest antes de continuar");
  }
  if (manifest?.state === "pending_create") {
    const recovered = await reconcileExactProject({organization, runGh, retrySleep});
    if (recovered) {
      if (apply) {
        bindManifest(manifest, recovered.project, organization);
        await persistManifest(writeManifest, manifestPath, manifest);
      }
      return {created: false, project: recovered.project, manifest};
    }
  }
  if (!apply) throw new Error("Recusando criar Project sem --apply");
  manifest ??= pendingCreateManifest({organization, runNonce, now});
  await persistManifest(writeManifest, manifestPath, manifest);
  for (let createAttempt = 0; createAttempt < 2; createAttempt += 1) {
    try {
      const response = await runGh(graphqlArgs(CREATE_PROJECT_MUTATION, {ownerId: existing.ownerId, title: DELIVERY_PROJECT_TITLE}));
      const project = data(response).createProjectV2?.projectV2;
      if (!project?.id) throw new Error("ID do Project criado ausente");
      const selected = normalizeProject(project);
      bindManifest(manifest, selected, organization);
      await persistManifest(writeManifest, manifestPath, manifest);
      return {created: true, project: selected, manifest};
    } catch (error) {
      if (!isTransientGitHubError(error)) throw error;
      for (let readAttempt = 0; readAttempt <= CREATE_DELAYS.length; readAttempt += 1) {
        existing = await findDeliveryProject({organization, runGh});
        if (existing.project) {
          bindManifest(manifest, existing.project, organization);
          await persistManifest(writeManifest, manifestPath, manifest);
          return {created: false, project: existing.project, manifest};
        }
        if (readAttempt < CREATE_DELAYS.length) await retrySleep(CREATE_DELAYS[readAttempt]);
      }
      if (createAttempt === 1) throw error;
    }
  }
  throw new Error("Create Project esgotado");
}

async function reconcileExactProject({organization, runGh, retrySleep}) {
  for (let readAttempt = 0; readAttempt <= CREATE_DELAYS.length; readAttempt += 1) {
    const existing = await findDeliveryProject({organization, runGh});
    if (existing.project) return existing;
    if (readAttempt < CREATE_DELAYS.length) await retrySleep(CREATE_DELAYS[readAttempt]);
  }
  return null;
}

export async function applyProjectOperations({projectId, operations, fieldNamesById = {}, manifest, runGh, apply = false, batchSize = 20, itemPauseMs = 250, batchPauseMs = 2000, sleep: pause = sleep, retrySleep = sleep, checkpoint = async () => {}} = {}) {
  if (!apply) throw new Error("Recusando escrita sem --apply");
  if (!projectId || typeof runGh !== "function" || !manifest) throw new Error("Project, runGh e manifest sao obrigatorios");
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batchSize deve ser inteiro positivo");
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
function randomNonce() { return Math.random().toString(36).slice(2); }
async function persistManifest(writeManifest, path, manifest) {
  if (typeof writeManifest !== "function") throw new Error("writeManifest e obrigatorio para criar Project");
  await writeManifest(path, manifest);
}

export async function synchronizeDeliveryProject({organization = "Siltech-Consult", issues, requiredIssueFields, runGh, apply = false, manifestPath = DEFAULT_MANIFEST_PATH, manifest: suppliedManifest, readManifest = readOptionalJson, writeManifest = writeJsonAtomically, ...options} = {}) {
  requireIssueIds(issues);
  let manifest = suppliedManifest ?? await readManifest(manifestPath);
  const selected = await createOrReuseDeliveryProject({organization, runGh, apply, manifest, manifestPath, writeManifest, retrySleep: options.retrySleep});
  manifest = selected.manifest ?? manifest;
  if (!manifest && !selected.created) throw new Error(`Project existente sem manifest confiavel: ${manifestPath}`);
  const project = await fetchProject({projectId: selected.project.id, runGh});
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
