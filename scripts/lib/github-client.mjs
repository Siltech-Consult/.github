import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdir, rename, unlink, writeFile} from "node:fs/promises";
import {dirname, basename, join} from "node:path";
import {randomUUID} from "node:crypto";

const execFileAsync = promisify(execFile);
const SEARCH_FIELDS = "id,repository,number,title,body,labels,createdAt,updatedAt,url";
const GRAPHQL_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Issue {
      id
      number
      repository { nameWithOwner }
      issueType { name }
      issueFieldValues(first: 20) {
        nodes {
          ... on IssueFieldSingleSelectValue {
            field { ... on IssueFieldSingleSelect { name } }
            name
          }
        }
      }
      closedByPullRequestsReferences(first: 20) {
        nodes { state merged }
      }
    }
  }
}`;

export function createRunGh({executable = "gh"} = {}) {
  return async (args) => {
    const {stdout} = await execFileAsync(executable, args, {
      maxBuffer: 32 * 1024 * 1024
    });
    return JSON.parse(stdout);
  };
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

function graphqlNodes(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.data?.nodes)) return response.data.nodes;
  if (Array.isArray(response?.nodes)) return response.nodes;
  return [];
}

function normalizeLabels(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((label) => typeof label === "string" ? label : label?.name)
    .filter((label) => label !== undefined && label !== null);
}

function normalizeFields(detail) {
  if (detail?.fields && typeof detail.fields === "object" && !Array.isArray(detail.fields)) {
    return {...detail.fields};
  }

  const fields = {};
  const values = detail?.issueFieldValues?.nodes;
  for (const value of Array.isArray(values) ? values : []) {
    const name = value?.field?.name;
    if (name && value.name !== undefined) fields[name] = value.name;
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
    fields: normalizeFields(detail),
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
    for (const [id, detail] of detailsById(response, batch)) details.set(id, detail);
  }

  const issues = searchIssues.map((issue) => normalizeIssue(issue, details.get(issue.id)));
  if (outputPath) await writeJsonAtomically(outputPath, issues);
  return issues;
}

export {GRAPHQL_QUERY};
