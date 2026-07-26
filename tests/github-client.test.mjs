import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readdir, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import { inventoryOpenIssues } from "../scripts/lib/github-client.mjs";

test("normaliza campos e PRs vinculados", async () => {
  const calls = [];
  const runGh = async (args) => {
    calls.push(args);
    if (args.includes("search")) {
      return [{
        id: "I_1",
        repository: {nameWithOwner: "Siltech-Consult/demo"},
        number: 7,
        title: "[P1] Corrigir parser",
        body: "Falha atual",
        labels: [{name: "bug"}]
      }];
    }
    return {
      fields: {Priority: null, Workflow: null, Effort: null, Wave: null},
      linkedPullRequests: [{state: "OPEN", merged: false}]
    };
  };

  const issues = await inventoryOpenIssues({
    org: "Siltech-Consult",
    runGh
  });

  assert.equal(issues.length, 1);
  assert.equal(issues[0].repository, "Siltech-Consult/demo");
  assert.equal(issues[0].linkedPullRequests[0].state, "OPEN");
  assert.ok(calls.length >= 2);
});

test("normaliza resposta GraphQL e consulta IDs em lotes de 100", async () => {
  const calls = [];
  const searchIssues = Array.from({length: 101}, (_, index) => ({
    id: `I_${index}`,
    repository: {nameWithOwner: "Siltech-Consult/demo"},
    number: index + 1,
    title: `Issue ${index}`,
    body: null,
    labels: [{name: "bug"}]
  }));
  const runGh = async (args) => {
    calls.push(args);
    if (args.includes("search")) return searchIssues;
    const ids = args
      .filter((arg) => arg.startsWith("ids[]="))
      .map((arg) => arg.slice("ids[]=".length));
    return {
      data: {
        nodes: ids.map((id) => ({
          id,
          issueType: {name: "Bug"},
          issueFieldValues: {
            nodes: [{
              field: {name: "Priority"},
              name: "P1"
            }]
          },
          closedByPullRequestsReferences: {
            nodes: [{state: "MERGED", merged: true}]
          }
        }))
      }
    };
  };

  const issues = await inventoryOpenIssues({org: "Siltech-Consult", runGh});

  const graphqlCalls = calls.filter((args) => args.includes("graphql"));
  assert.equal(graphqlCalls.length, 2);
  assert.equal(graphqlCalls[0].filter((arg) => arg.startsWith("ids[]=")).length, 100);
  assert.equal(graphqlCalls[1].filter((arg) => arg.startsWith("ids[]=")).length, 1);
  assert.equal(issues[0].type, "Bug");
  assert.deepEqual(issues[0].fields, {Priority: "P1"});
  assert.deepEqual(issues[0].linkedPullRequests, [{state: "MERGED", merged: true}]);
  assert.equal(issues[0].body, "");
});

test("grava inventario em arquivo temporario e renomeia ao final", async () => {
  const directory = await mkdtemp(join(tmpdir(), "github-inventory-"));
  const outputPath = join(directory, "open-issues.json");
  const runGh = async (args) => args.includes("search") ? [] : {data: {nodes: []}};

  await inventoryOpenIssues({org: "Siltech-Consult", outputPath, runGh});

  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), []);
  assert.deepEqual(await readdir(directory), ["open-issues.json"]);
});
