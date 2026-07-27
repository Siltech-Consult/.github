import {execFile, spawn} from "node:child_process";
import {promisify} from "node:util";
import {mkdir, rename, unlink, writeFile} from "node:fs/promises";
import {dirname, basename, join} from "node:path";
import {randomUUID} from "node:crypto";

const execFileAsync = promisify(execFile);
const SEARCH_FIELDS = "id,repository,number,title,body,labels,createdAt,updatedAt,url";
const FIELD_VALUE_SELECTION = `
        __typename
        ... on IssueFieldSingleSelectValue {
          id
          field {
            __typename
            ... on IssueFieldSingleSelect { id name dataType }
          }
          name
          value
          optionId
        }
        ... on IssueFieldTextValue {
          id
          field {
            __typename
            ... on IssueFieldText { id name dataType }
          }
          value
        }
        ... on IssueFieldNumberValue {
          id
          field {
            __typename
            ... on IssueFieldNumber { id name dataType }
          }
          value
        }
        ... on IssueFieldDateValue {
          id
          field {
            __typename
            ... on IssueFieldDate { id name dataType }
          }
          value
        }
        ... on IssueFieldMultiSelectValue {
          id
          field {
            __typename
            ... on IssueFieldMultiSelect { id name dataType }
          }
          value
          options { id name color }
        }`;
const ISSUE_FIELD_CONNECTION_SELECTION = `{
        nodes {${FIELD_VALUE_SELECTION}
        }
        pageInfo { hasNextPage endCursor }
      }`;
const PULL_REQUEST_CONNECTION_SELECTION = `{
        nodes { state merged }
        pageInfo { hasNextPage endCursor }
      }`;
const GRAPHQL_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Issue {
      id
      number
      repository { nameWithOwner }
      issueType { name }
      issueFieldValues(first: 100) ${ISSUE_FIELD_CONNECTION_SELECTION}
      closedByPullRequestsReferences(first: 100) ${PULL_REQUEST_CONNECTION_SELECTION}
    }
  }
}`;
const FIELD_PAGE_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) {
    ... on Issue {
      issueFieldValues(first: 100, after: $after) ${ISSUE_FIELD_CONNECTION_SELECTION}
    }
  }
}`;
const PULL_REQUEST_PAGE_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) {
    ... on Issue {
      closedByPullRequestsReferences(first: 100, after: $after) ${PULL_REQUEST_CONNECTION_SELECTION}
    }
  }
}`;

export function createRunGh({executable = "gh"} = {}) {
  return async (args, {input} = {}) => {
    if (input !== undefined) return runGhWithInput(executable, args, input);
    const {stdout} = await execFileAsync(executable, args, {
      maxBuffer: 32 * 1024 * 1024
    });
    return JSON.parse(stdout);
  };
}

function runGhWithInput(executable, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {stdio: ["pipe", "pipe", "pipe"]});
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `gh api exited with ${code}`));
      try {
        resolve(stdout.trim() === "" ? null : JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

function searchArgs(org) {
  return [
    "search", "issues", "--owner", org, "--state", "open", "--limit", "1000",
    "--json", SEARCH_FIELDS
  ];
}

function graphqlArgs(ids) {
  return [
    "api", "graphql", "-f", `query=${GRAPHQL_QUERY}`,
    ...ids.flatMap((id) => ["-F", `ids[]=${id}`])
  ];
}

function graphqlPageArgs(query, id, after) {
  const args = ["api", "graphql", "-f", `query=${query}`, "-F", `id=${id}`];
  if (after !== undefined && after !== null) args.push("-F", `after=${after}`);
  return args;
}

function graphqlNodes(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.data?.nodes)) return response.data.nodes;
  if (Array.isArray(response?.nodes)) return response.nodes;
  return [];
}

function graphqlNode(response) {
  return response?.data?.node ?? response?.node ?? null;
}

function normalizeLabels(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((label) => typeof label === "string" ? label : label?.name)
    .filter((label) => label !== undefined && label !== null);
}

const VALUE_DATA_TYPES = {
  IssueFieldSingleSelectValue: "SINGLE_SELECT",
  IssueFieldTextValue: "TEXT",
  IssueFieldNumberValue: "NUMBER",
  IssueFieldDateValue: "DATE",
  IssueFieldMultiSelectValue: "MULTI_SELECT"
};

function fieldValueValue(value) {
  if (value?.value !== undefined) return value.value;
  if (value?.name !== undefined) return value.name;
  return null;
}

function normalizeFieldValue(value) {
  const type = value?.__typename ?? null;
  const field = value?.field ?? {};
  return {
    id: value?.id ?? null,
    field: field.name ?? null,
    fieldId: field.id ?? null,
    fieldType: field.__typename ?? null,
    dataType: field.dataType ?? VALUE_DATA_TYPES[type] ?? null,
    valueType: type,
    value: fieldValueValue(value),
    name: value?.name ?? null,
    optionId: value?.optionId ?? null,
    options: Array.isArray(value?.options) ? value.options : []
  };
}

function normalizeFieldValues(detail) {
  if (Array.isArray(detail?.fieldValues)) return detail.fieldValues;
  const values = detail?.issueFieldValues?.nodes;
  return (Array.isArray(values) ? values : []).filter(Boolean).map(normalizeFieldValue);
}

function normalizeFields(detail, fieldValues = normalizeFieldValues(detail)) {
  const fields = detail?.fields && typeof detail.fields === "object" && !Array.isArray(detail.fields)
    ? {...detail.fields}
    : {};
  for (const fieldValue of fieldValues) {
    if (fieldValue.field && fieldValue.value !== null) fields[fieldValue.field] = fieldValue.value;
  }
  return fields;
}

function normalizePullRequests(detail) {
  if (Array.isArray(detail?.linkedPullRequests)) return detail.linkedPullRequests;
  const references = detail?.closedByPullRequestsReferences?.nodes;
  return Array.isArray(references) ? references.filter(Boolean) : [];
}

function normalizeIssue(issue, detail = {}) {
  const repository = issue.repository?.nameWithOwner ?? detail.repository?.nameWithOwner;
  const issueType = detail.issueType?.name ?? detail.type?.name ?? detail.type ?? null;
  const fieldValues = normalizeFieldValues(detail);
  return {
    id: issue.id ?? detail.id,
    repository,
    number: issue.number ?? detail.number,
    title: issue.title ?? "",
    body: issue.body ?? "",
    labels: normalizeLabels(issue.labels),
    createdAt: issue.createdAt ?? null,
    updatedAt: issue.updatedAt ?? null,
    url: issue.url ?? null,
    type: issueType,
    fields: normalizeFields(detail, fieldValues),
    fieldValues,
    linkedPullRequests: normalizePullRequests(detail)
  };
}

function detailsById(response, issues) {
  const nodes = graphqlNodes(response).filter(Boolean);
  const details = new Map(nodes.filter((node) => node.id).map((node) => [node.id, node]));
  if (details.size === 0 && nodes.length === 1 && issues.length === 1) {
    details.set(issues[0].id, nodes[0]);
  }
  if (details.size === 0 && response && !Array.isArray(response) &&
    (response.fields || response.linkedPullRequests || response.issueFieldValues)) {
    details.set(issues[0]?.id, response);
  }
  return details;
}

async function fetchConnectionPages({issueId, initial, query, connectionName, runGh}) {
  if (!initial) return initial;
  const nodes = Array.isArray(initial.nodes) ? [...initial.nodes] : [];
  let pageInfo = initial.pageInfo ?? {hasNextPage: false, endCursor: null};
  while (pageInfo.hasNextPage) {
    const cursor = pageInfo.endCursor;
    if (!cursor) throw new Error(`Pagination cursor missing for ${connectionName} on ${issueId}`);
    const response = await runGh(graphqlPageArgs(query, issueId, cursor));
    const node = graphqlNode(response);
    const connection = node?.[connectionName];
    if (!connection) throw new Error(`Pagination response missing ${connectionName} for ${issueId}`);
    nodes.push(...(Array.isArray(connection.nodes) ? connection.nodes : []));
    const nextPageInfo = connection.pageInfo;
    if (!nextPageInfo) throw new Error(`Pagination pageInfo missing for ${connectionName} on ${issueId}`);
    if (nextPageInfo.hasNextPage && nextPageInfo.endCursor === cursor) {
      throw new Error(`Pagination cursor did not advance for ${connectionName} on ${issueId}`);
    }
    pageInfo = nextPageInfo;
  }
  return {...initial, nodes, pageInfo};
}

async function completeDetail(detail, issueId, runGh) {
  if (!detail?.issueFieldValues && !detail?.closedByPullRequestsReferences) return detail;
  const issueFieldValues = await fetchConnectionPages({
    issueId,
    initial: detail.issueFieldValues,
    query: FIELD_PAGE_QUERY,
    connectionName: "issueFieldValues",
    runGh
  });
  const closedByPullRequestsReferences = await fetchConnectionPages({
    issueId,
    initial: detail.closedByPullRequestsReferences,
    query: PULL_REQUEST_PAGE_QUERY,
    connectionName: "closedByPullRequestsReferences",
    runGh
  });
  return {...detail, issueFieldValues, closedByPullRequestsReferences};
}

function compareIssues(left, right) {
  const leftRepository = String(left.repository ?? "");
  const rightRepository = String(right.repository ?? "");
  if (leftRepository < rightRepository) return -1;
  if (leftRepository > rightRepository) return 1;
  return Number(left.number) - Number(right.number);
}

async function writeJsonAtomically(outputPath, value) {
  const directory = dirname(outputPath);
  const temporaryPath = join(directory, `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(directory, {recursive: true});
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function inventoryOpenIssues({org, outputPath, runGh = createRunGh()} = {}) {
  if (!org) throw new Error("org is required");

  const searchResult = await runGh(searchArgs(org));
  const searchIssues = Array.isArray(searchResult) ? searchResult : [];
  const details = new Map();

  for (let offset = 0; offset < searchIssues.length; offset += 100) {
    const batch = searchIssues.slice(offset, offset + 100);
    const ids = batch.map((issue) => issue.id).filter(Boolean);
    if (ids.length === 0) continue;
    const response = await runGh(graphqlArgs(ids));
    for (const [id, detail] of detailsById(response, batch)) {
      details.set(id, await completeDetail(detail, id, runGh));
    }
  }

  const issues = searchIssues
    .map((issue) => normalizeIssue(issue, details.get(issue.id)))
    .sort(compareIssues);
  if (outputPath) await writeJsonAtomically(outputPath, issues);
  return issues;
}

export {GRAPHQL_QUERY};
