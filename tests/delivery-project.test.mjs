import test from "node:test";
import assert from "node:assert/strict";
import {
  applyProjectOperations,
  buildProjectOperations,
  extractProjectIssueFieldIds,
  findDeliveryProject
} from "../scripts/create-delivery-project.mjs";
import { validateDeliveryProject } from "../scripts/validate-delivery-project.mjs";

test("nao duplica campos nem itens existentes", () => {
  const operations = buildProjectOperations({
    project: {
      id: "PVT_1",
      issueFieldIds: ["IF_PRIORITY"],
      contentIds: ["I_1"]
    },
    requiredIssueFields: {
      Priority: "IF_PRIORITY",
      Workflow: "IF_WORKFLOW",
      Effort: "IF_EFFORT",
      Wave: "IF_WAVE"
    },
    issues: [{id: "I_1"}, {id: "I_2"}]
  });

  assert.deepEqual(operations.addIssueFields, [
    "IF_WORKFLOW",
    "IF_EFFORT",
    "IF_WAVE"
  ]);
  assert.deepEqual(operations.addItems, ["I_2"]);
});

test("reexecucao reconhece campos organizacionais pelo nome apos leitura do Project", () => {
  const operations = buildProjectOperations({
    project: {issueFieldIds: [], issueFieldNames: ["Priority", "Workflow", "Effort", "Wave"], contentIds: []},
    requiredIssueFields: {
      Priority: "IF_PRIORITY",
      Workflow: "IF_WORKFLOW",
      Effort: "IF_EFFORT",
      Wave: "IF_WAVE"
    },
    issues: []
  });

  assert.deepEqual(operations.addIssueFields, []);
});

test("usa node IDs dos Issue Fields organizacionais no ProjectV2", () => {
  assert.deepEqual(extractProjectIssueFieldIds([
    {id: 1, node_id: "IF_PRIORITY", name: "Priority"},
    {id: 2, node_id: "IF_WORKFLOW", name: "Workflow"},
    {id: 3, node_id: "IF_EFFORT", name: "Effort"},
    {id: 4, node_id: "IF_WAVE", name: "Wave"}
  ]), {
    Priority: "IF_PRIORITY",
    Workflow: "IF_WORKFLOW",
    Effort: "IF_EFFORT",
    Wave: "IF_WAVE"
  });
});

test("localiza Project existente em pagina posterior", async () => {
  const runGh = async (args) => {
    const after = args.find((arg) => arg.startsWith("after="))?.slice("after=".length);
    return {data: {organization: {
      id: "ORG_1",
      projectsV2: after ? {
        nodes: [{id: "PVT_1", number: 7, title: "Siltech Delivery", url: "https://example.test/project/7", public: false, owner: {login: "Siltech-Consult"}}],
        pageInfo: {hasNextPage: false, endCursor: null}
      } : {
        nodes: [{id: "PVT_0", number: 1, title: "Outro", url: "https://example.test/project/1", public: false, owner: {login: "Siltech-Consult"}}],
        pageInfo: {hasNextPage: true, endCursor: "NEXT"}
      }
    }}};
  };

  const result = await findDeliveryProject({organization: "Siltech-Consult", runGh});

  assert.equal(result.ownerId, "ORG_1");
  assert.equal(result.project.id, "PVT_1");
});

test("validador exige projeto privado, campos oficiais unicos e inventario completo", () => {
  const audit = validateDeliveryProject({
    organization: "Siltech-Consult",
    project: {
      title: "Siltech Delivery",
      owner: "Siltech-Consult",
      public: false,
      issueFields: [
        {name: "Priority", issueFieldId: "IF_PRIORITY"},
        {name: "Workflow", issueFieldId: "IF_WORKFLOW"},
        {name: "Effort", issueFieldId: "IF_EFFORT"},
        {name: "Wave", issueFieldId: "IF_WAVE"},
        {name: "Wave", issueFieldId: "IF_WAVE"}
      ],
      contentIds: ["I_1"]
    },
    requiredIssueFields: {
      Priority: "IF_PRIORITY",
      Workflow: "IF_WORKFLOW",
      Effort: "IF_EFFORT",
      Wave: "IF_WAVE"
    },
    issues: [{id: "I_1"}, {id: "I_2"}]
  });

  assert.equal(audit.ok, false);
  assert.deepEqual(audit.failures.map((failure) => failure.type), [
    "duplicate_project_field",
    "missing_project_item"
  ]);
});

test("aplica apenas operacoes ausentes com retry por item", async () => {
  const calls = [];
  let itemAttempts = 0;
  const runGh = async (args) => {
    calls.push(args);
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    const contentId = args.find((arg) => arg.startsWith("contentId="))?.slice("contentId=".length);
    if (query.includes("addProjectV2ItemById") && contentId === "I_2" && itemAttempts++ === 0) {
      const error = new Error("service unavailable");
      error.status = 503;
      throw error;
    }
    return {data: {ok: true}};
  };

  await applyProjectOperations({
    projectId: "PVT_1",
    operations: {addIssueFields: ["IF_WORKFLOW"], addItems: ["I_2"]},
    runGh,
    apply: true,
    batchSize: 1,
    sleep: async () => {},
    retrySleep: async () => {}
  });

  assert.equal(calls.filter((args) => (args.find((arg) => arg.startsWith("query=")) ?? "").includes("createProjectV2IssueField")).length, 1);
  assert.equal(calls.filter((args) => (args.find((arg) => arg.startsWith("query=")) ?? "").includes("addProjectV2ItemById")).length, 2);
});
