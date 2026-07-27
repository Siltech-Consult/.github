import test from "node:test";
import assert from "node:assert/strict";
import {chmod, mkdtemp, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import { createRunGh, inventoryOpenIssues } from "../scripts/lib/github-client.mjs";

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

test("preserva status e headers de rate limit retornados pelo gh", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "github-client-error-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const executable = join(directory, "gh");
  await writeFile(executable, [
    "#!/bin/sh",
    "echo 'HTTP/2.0 403 secondary rate limit' >&2",
    "echo 'Retry-After: 3' >&2",
    "exit 1"
  ].join("\n"), "utf8");
  await chmod(executable, 0o755);

  await assert.rejects(createRunGh({executable})(["api", "repos/demo"]), (error) => {
    assert.equal(error.status, 403);
    assert.equal(error.headers["retry-after"], "3");
    return true;
  });
});

test("usa --include e preserva JSON quando gh devolve headers de sucesso", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "github-client-include-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const executable = join(directory, "gh");
  await writeFile(executable, [
    "#!/bin/sh",
    "case \"$*\" in *--include*) ;; *) exit 99 ;; esac",
    "printf 'HTTP/2.0 200 OK\\nX-RateLimit-Remaining: 42\\n\\n{\"ok\":true}\\n'"
  ].join("\n"), "utf8");
  await chmod(executable, 0o755);

  assert.deepEqual(await createRunGh({executable})(["api", "repos/demo"]), {ok: true});
});

test("preserva headers de erro no caminho POST com stdin", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "github-client-input-error-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const executable = join(directory, "gh");
  await writeFile(executable, [
    "#!/bin/sh",
    "cat >/dev/null",
    "printf 'HTTP/2.0 429 Too Many Requests\\nRetry-After: 2\\n\\n{}\\n'",
    "exit 1"
  ].join("\n"), "utf8");
  await chmod(executable, 0o755);

  await assert.rejects(createRunGh({executable})(["api", "repos/demo"], {input: "{}"}), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.headers["retry-after"], "2");
    return true;
  });
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

test("ordena inventario por repositorio e numero da issue", async () => {
  const runGh = async (args) => {
    if (args.includes("search")) {
      return [
        {id: "I_3", repository: {nameWithOwner: "Siltech-Consult/zeta"}, number: 10, title: "z", labels: []},
        {id: "I_2", repository: {nameWithOwner: "Siltech-Consult/alpha"}, number: 2, title: "a2", labels: []},
        {id: "I_1", repository: {nameWithOwner: "Siltech-Consult/alpha"}, number: 1, title: "a1", labels: []}
      ];
    }
    return {data: {nodes: []}};
  };

  const issues = await inventoryOpenIssues({org: "Siltech-Consult", runGh});

  assert.deepEqual(issues.map(({repository, number}) => `${repository}#${number}`), [
    "Siltech-Consult/alpha#1",
    "Siltech-Consult/alpha#2",
    "Siltech-Consult/zeta#10"
  ]);
});

test("preserva todos os tipos de valores de Issue Fields", async () => {
  const runGh = async (args) => {
    if (args.includes("search")) {
      return [{
        id: "I_TYPED",
        repository: {nameWithOwner: "Siltech-Consult/demo"},
        number: 8,
        title: "Campos tipados",
        labels: []
      }];
    }
    return {
      data: {
        nodes: [{
          id: "I_TYPED",
          issueFieldValues: {
            nodes: [
              {
                __typename: "IssueFieldSingleSelectValue",
                id: "V_PRIORITY",
                field: {__typename: "IssueFieldSingleSelect", id: "F_PRIORITY", name: "Priority", dataType: "SINGLE_SELECT"},
                name: "P1",
                value: "P1",
                optionId: "O_P1"
              },
              {
                __typename: "IssueFieldTextValue",
                id: "V_TEXT",
                field: {__typename: "IssueFieldText", id: "F_TEXT", name: "Summary", dataType: "TEXT"},
                value: "Texto livre"
              },
              {
                __typename: "IssueFieldNumberValue",
                id: "V_NUMBER",
                field: {__typename: "IssueFieldNumber", id: "F_NUMBER", name: "Score", dataType: "NUMBER"},
                value: 3.5
              },
              {
                __typename: "IssueFieldDateValue",
                id: "V_DATE",
                field: {__typename: "IssueFieldDate", id: "F_DATE", name: "Due Date", dataType: "DATE"},
                value: "2026-08-01"
              },
              {
                __typename: "IssueFieldMultiSelectValue",
                id: "V_MULTI",
                field: {__typename: "IssueFieldMultiSelect", id: "F_MULTI", name: "Tags", dataType: "MULTI_SELECT"},
                value: "Backend,Frontend",
                options: [
                  {id: "O_BACKEND", name: "Backend"},
                  {id: "O_FRONTEND", name: "Frontend"}
                ]
              }
            ],
            pageInfo: {hasNextPage: false, endCursor: null}
          },
          closedByPullRequestsReferences: {
            nodes: [],
            pageInfo: {hasNextPage: false, endCursor: null}
          }
        }]
      }
    };
  };

  const [issue] = await inventoryOpenIssues({org: "Siltech-Consult", runGh});

  assert.deepEqual(issue.fields, {
    Priority: "P1",
    Summary: "Texto livre",
    Score: 3.5,
    "Due Date": "2026-08-01",
    Tags: "Backend,Frontend"
  });
  assert.deepEqual(issue.fieldValues.map(({dataType, value}) => [dataType, value]), [
    ["SINGLE_SELECT", "P1"],
    ["TEXT", "Texto livre"],
    ["NUMBER", 3.5],
    ["DATE", "2026-08-01"],
    ["MULTI_SELECT", "Backend,Frontend"]
  ]);
  assert.equal(issue.fieldValues[0].optionId, "O_P1");
  assert.deepEqual(issue.fieldValues[4].options, [
    {id: "O_BACKEND", name: "Backend"},
    {id: "O_FRONTEND", name: "Frontend"}
  ]);
});

test("pagina valores de fields e PRs alem da primeira pagina", async () => {
  const calls = [];
  const runGh = async (args) => {
    calls.push(args);
    if (args.includes("search")) {
      return [{
        id: "I_PAGE",
        repository: {nameWithOwner: "Siltech-Consult/demo"},
        number: 9,
        title: "Paginado",
        labels: []
      }];
    }

    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("node(id:")) {
      const isFieldQuery = query.includes("issueFieldValues") && !query.includes("closedByPullRequestsReferences");
      if (isFieldQuery) {
        return {data: {node: {
          id: "I_PAGE",
          issueFieldValues: {
            nodes: [{
              __typename: "IssueFieldTextValue",
              id: "V_FIELD_2",
              field: {__typename: "IssueFieldText", id: "F_TEXT_2", name: "Notes", dataType: "TEXT"},
              value: "segunda pagina"
            }],
            pageInfo: {hasNextPage: false, endCursor: "FIELD_END"}
          }
        }}};
      }
      return {data: {node: {
        id: "I_PAGE",
        closedByPullRequestsReferences: {
          nodes: [{state: "MERGED", merged: true}],
          pageInfo: {hasNextPage: false, endCursor: "PR_END"}
        }
      }}};
    }

    return {data: {nodes: [{
      id: "I_PAGE",
      issueFieldValues: {
        nodes: [{
          __typename: "IssueFieldTextValue",
          id: "V_FIELD_1",
          field: {__typename: "IssueFieldText", id: "F_TEXT_1", name: "Summary", dataType: "TEXT"},
          value: "primeira pagina"
        }],
        pageInfo: {hasNextPage: true, endCursor: "FIELD_CURSOR_1"}
      },
      closedByPullRequestsReferences: {
        nodes: [{state: "OPEN", merged: false}],
        pageInfo: {hasNextPage: true, endCursor: "PR_CURSOR_1"}
      }
    }]}};
  };

  const [issue] = await inventoryOpenIssues({org: "Siltech-Consult", runGh});

  assert.deepEqual(issue.fields, {
    Summary: "primeira pagina",
    Notes: "segunda pagina"
  });
  assert.deepEqual(issue.linkedPullRequests, [
    {state: "OPEN", merged: false},
    {state: "MERGED", merged: true}
  ]);
  assert.equal(calls.filter((args) => args.some((arg) => arg.startsWith("query=") && arg.includes("node(id:"))).length, 2);
});
