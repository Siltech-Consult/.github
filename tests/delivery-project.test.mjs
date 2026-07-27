import test from "node:test";
import assert from "node:assert/strict";
import {
  applyProjectOperations,
  buildProjectOperations,
  createOrReuseDeliveryProject,
  extractProjectIssueFieldIds,
  fetchProject,
  findDeliveryProject,
  synchronizeDeliveryProject,
  validateDeliveryProject as validateDeliveryProjectCore
} from "../scripts/create-delivery-project.mjs";
import { validateDeliveryProject as validateDeliveryProjectCli } from "../scripts/validate-delivery-project.mjs";

const validateDeliveryProject = validateDeliveryProjectCli;

function boundManifest(project = {}) {
  return {
    schemaVersion: 2,
    state: "bound",
    pendingCreate: {organization: "Siltech-Consult", title: "Siltech Delivery", runNonce: "bound-adversarial", timestamp: "2026-07-27T00:00:00.000Z"},
    project: {
      id: "PVT_1",
      number: 7,
      title: "Siltech Delivery",
      owner: "Siltech-Consult",
      url: "https://github.com/orgs/Siltech-Consult/projects/7",
      ...project
    },
    issueFields: {}
  };
}

function liveDeliveryProject() {
  return {
    id: "PVT_1",
    number: 7,
    title: "Siltech Delivery",
    owner: "Siltech-Consult",
    url: "https://github.com/orgs/Siltech-Consult/projects/7",
    public: false,
    projectFields: []
  };
}

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
      id: "PVT_1",
      number: 7,
      title: "Siltech Delivery",
      owner: "Siltech-Consult",
      url: "https://github.com/orgs/Siltech-Consult/projects/7",
      public: false,
      projectFields: [
        {id: "PF_PRIORITY", name: "Priority", dataType: "SINGLE_SELECT"},
        {id: "PF_WORKFLOW", name: "Workflow", dataType: "SINGLE_SELECT"},
        {id: "PF_EFFORT", name: "Effort", dataType: "SINGLE_SELECT"},
        {id: "PF_WAVE", name: "Wave", dataType: "SINGLE_SELECT"},
        {id: "PF_WAVE_2", name: "Wave", dataType: "SINGLE_SELECT"}
      ],
      contentIds: ["I_1"]
    },
    requiredIssueFields: {
      Priority: "IF_PRIORITY",
      Workflow: "IF_WORKFLOW",
      Effort: "IF_EFFORT",
      Wave: "IF_WAVE"
    },
    manifest: {
      schemaVersion: 2,
      state: "bound",
      pendingCreate: {organization: "Siltech-Consult", title: "Siltech Delivery", runNonce: "run-0", timestamp: "2026-07-27T00:00:00.000Z"},
      project: {id: "PVT_1", number: 7, title: "Siltech Delivery", owner: "Siltech-Consult", url: "https://github.com/orgs/Siltech-Consult/projects/7"},
      issueFields: {
        Priority: {issueFieldId: "IF_PRIORITY", projectFieldId: "PF_PRIORITY", name: "Priority", dataType: "SINGLE_SELECT"},
        Workflow: {issueFieldId: "IF_WORKFLOW", projectFieldId: "PF_WORKFLOW", name: "Workflow", dataType: "SINGLE_SELECT"},
        Effort: {issueFieldId: "IF_EFFORT", projectFieldId: "PF_EFFORT", name: "Effort", dataType: "SINGLE_SELECT"},
        Wave: {issueFieldId: "IF_WAVE", projectFieldId: "PF_WAVE", name: "Wave", dataType: "SINGLE_SELECT"}
      }
    },
    issues: [{id: "I_1"}, {id: "I_2"}]
  });

  assert.equal(audit.ok, false);
  assert.deepEqual(audit.failures.map((failure) => failure.type), [
    "duplicate_project_field",
    "project_field_untrusted",
    "missing_project_item"
  ]);
});

test("validador falha fechado para Project existente sem manifest confiavel", () => {
  const audit = validateDeliveryProject({
    project: {id: "PVT_1", title: "Siltech Delivery", owner: "Siltech-Consult", public: false, projectFields: []},
    requiredIssueFields: {Priority: "IF_PRIORITY", Workflow: "IF_WORKFLOW", Effort: "IF_EFFORT", Wave: "IF_WAVE"},
    issues: []
  });

  assert.equal(audit.ok, false);
  assert.deepEqual(audit.failures.map((failure) => failure.type), ["missing_project_manifest"]);
});

test("validador recusa schema de manifest desconhecido antes de confiar em mappings", () => {
  const audit = validateDeliveryProject({
    project: {id: "PVT_1", title: "Siltech Delivery", owner: "Siltech-Consult", public: false, projectFields: []},
    requiredIssueFields: {Priority: "IF_PRIORITY", Workflow: "IF_WORKFLOW", Effort: "IF_EFFORT", Wave: "IF_WAVE"},
    manifest: {schemaVersion: 1, project: {id: "PVT_1"}, issueFields: {}},
    issues: []
  });

  assert.equal(audit.ok, false);
  assert.equal(audit.failures[0].type, "invalid_project_manifest");
  assert.match(audit.failures[0].reason, /schemaVersion/);
});

test("sincronizacao recusa Project existente sem manifest antes de mutar", async () => {
  await assert.rejects(synchronizeDeliveryProject({
    organization: "Siltech-Consult",
    issues: [],
    requiredIssueFields: {Priority: "IF_PRIORITY", Workflow: "IF_WORKFLOW", Effort: "IF_EFFORT", Wave: "IF_WAVE"},
    apply: true,
    readManifest: async () => null,
    runGh: async () => ({data: {organization: {
      id: "ORG_1",
      projectsV2: {
        nodes: [{id: "PVT_1", number: 7, title: "Siltech Delivery", url: "https://example.test/project/7", public: false, owner: {login: "Siltech-Consult"}}],
        pageInfo: {hasNextPage: false, endCursor: null}
      }
    }}})
  }), /Project existente sem manifest confiavel/);
});

test("sincronizacao recusa manifest malformado antes de consultar Project", async () => {
  let calls = 0;
  await assert.rejects(synchronizeDeliveryProject({
    organization: "Siltech-Consult",
    issues: [],
    requiredIssueFields: {Priority: "IF_PRIORITY", Workflow: "IF_WORKFLOW", Effort: "IF_EFFORT", Wave: "IF_WAVE"},
    apply: true,
    manifest: {schemaVersion: 1},
    runGh: async () => { calls += 1; return {}; }
  }), /Manifest invalido: schemaVersion/);
  assert.equal(calls, 0);
});

test("reconcilia create transitivo por owner e titulo antes de repetir mutacao", async () => {
  let finds = 0;
  let creates = 0;
  const runGh = async (args) => {
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("createProjectV2")) {
      creates += 1;
      const error = new Error("service unavailable");
      error.status = 503;
      throw error;
    }
    finds += 1;
    return {data: {organization: {
      id: "ORG_1",
      projectsV2: {
        nodes: finds === 1 ? [] : [{id: "PVT_1", number: 7, title: "Siltech Delivery", url: "https://example.test/project/7", public: false, owner: {login: "Siltech-Consult"}}],
        pageInfo: {hasNextPage: false, endCursor: null}
      }
    }}};
  };

  const result = await createOrReuseDeliveryProject({organization: "Siltech-Consult", runGh, apply: true, retrySleep: async () => {}, writeManifest: async () => {}});

  assert.equal(result.project.id, "PVT_1");
  assert.equal(result.created, false);
  assert.equal(creates, 1);
});

test("persiste create pendente antes da mutacao e vincula Project recuperado", async () => {
  const states = [];
  let finds = 0;
  const runGh = async (args) => {
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("createProjectV2")) {
      const error = new Error("service unavailable");
      error.status = 503;
      throw error;
    }
    finds += 1;
    return {data: {organization: {id: "ORG_1", projectsV2: {
      nodes: finds === 1 ? [] : [{id: "PVT_1", number: 7, title: "Siltech Delivery", url: "https://example.test/project/7", public: false, owner: {login: "Siltech-Consult"}}],
      pageInfo: {hasNextPage: false, endCursor: null}
    }}}};
  };

  const result = await createOrReuseDeliveryProject({
    organization: "Siltech-Consult",
    runGh,
    apply: true,
    runNonce: "run-1",
    now: () => "2026-07-27T00:00:00.000Z",
    retrySleep: async () => {},
    writeManifest: async (_path, state) => states.push(structuredClone(state))
  });

  assert.equal(result.project.id, "PVT_1");
  assert.deepEqual(states.map((state) => state.state), ["pending_create", "bound"]);
  assert.equal(states[0].pendingCreate.runNonce, "run-1");
  assert.equal(states[1].project.id, "PVT_1");
});

test("retomada pendente reconcilia janela completa antes de nova criacao", async () => {
  let finds = 0;
  let creates = 0;
  const manifest = {
    schemaVersion: 2,
    state: "pending_create",
    pendingCreate: {organization: "Siltech-Consult", title: "Siltech Delivery", runNonce: "restart-1", timestamp: "2026-07-27T00:00:00.000Z"},
    project: null,
    issueFields: {}
  };
  const result = await createOrReuseDeliveryProject({
    organization: "Siltech-Consult",
    manifest,
    apply: true,
    retrySleep: async () => {},
    writeManifest: async () => {},
    runGh: async (args) => {
      const query = args.find((arg) => arg.startsWith("query=")) ?? "";
      if (query.includes("createProjectV2")) { creates += 1; throw new Error("nao deveria criar"); }
      finds += 1;
      return {data: {organization: {id: "ORG_1", projectsV2: {
        nodes: finds < 3 ? [] : [{id: "PVT_1", number: 7, title: "Siltech Delivery", url: "https://github.com/orgs/Siltech-Consult/projects/7", public: false, owner: {login: "Siltech-Consult"}}],
        pageInfo: {hasNextPage: false, endCursor: null}
      }}}};
    }
  });
  assert.equal(result.project.id, "PVT_1");
  assert.equal(creates, 0);
  assert.equal(manifest.state, "bound");
});

test("bound ID divergente falha fechado sem rebind ou create", async () => {
  const manifest = {
    schemaVersion: 2,
    state: "bound",
    pendingCreate: {organization: "Siltech-Consult", title: "Siltech Delivery", runNonce: "bound-1", timestamp: "2026-07-27T00:00:00.000Z"},
    project: {id: "PVT_RECORDED", number: 7, title: "Siltech Delivery", owner: "Siltech-Consult", url: "https://github.com/orgs/Siltech-Consult/projects/7"},
    issueFields: {}
  };
  await assert.rejects(createOrReuseDeliveryProject({
    organization: "Siltech-Consult",
    manifest,
    apply: true,
    writeManifest: async () => { throw new Error("nao deveria gravar"); },
    runGh: async () => ({data: {organization: {id: "ORG_1", projectsV2: {
      nodes: [{id: "PVT_OTHER", number: 8, title: "Siltech Delivery", url: "https://github.com/orgs/Siltech-Consult/projects/8", public: false, owner: {login: "Siltech-Consult"}}],
      pageInfo: {hasNextPage: false, endCursor: null}
    }}}})
  }), /reset manual do manifest/);
  assert.equal(manifest.project.id, "PVT_RECORDED");
});

test("reuso recusa bound com ID correto e numero divergente", async () => {
  await assert.rejects(createOrReuseDeliveryProject({
    organization: "Siltech-Consult",
    manifest: boundManifest({number: 8}),
    apply: true,
    writeManifest: async () => { throw new Error("nao deveria gravar"); },
    runGh: async () => ({data: {organization: {id: "ORG_1", projectsV2: {
      nodes: [{...liveDeliveryProject(), owner: {login: "Siltech-Consult"}}],
      pageInfo: {hasNextPage: false, endCursor: null}
    }}}})
  }), /reset manual do manifest/);
});

test("reuso recusa bound com ID correto e URL GitHub divergente", async () => {
  await assert.rejects(createOrReuseDeliveryProject({
    organization: "Siltech-Consult",
    manifest: boundManifest({url: "https://github.com/orgs/Siltech-Consult/projects/8"}),
    apply: true,
    writeManifest: async () => { throw new Error("nao deveria gravar"); },
    runGh: async () => ({data: {organization: {id: "ORG_1", projectsV2: {
      nodes: [{...liveDeliveryProject(), owner: {login: "Siltech-Consult"}}],
      pageInfo: {hasNextPage: false, endCursor: null}
    }}}})
  }), /reset manual do manifest/);
});

test("validadores core e CLI recusam bound com ID correto e numero divergente", () => {
  for (const validate of [validateDeliveryProjectCore, validateDeliveryProjectCli]) {
    const audit = validate({
      project: liveDeliveryProject(),
      manifest: boundManifest({number: 8}),
      complete: false
    });
    assert.deepEqual(audit.failures.map((failure) => failure.type), ["untrusted_project_manifest"]);
  }
});

test("validadores core e CLI recusam bound com ID correto e URL GitHub divergente", () => {
  for (const validate of [validateDeliveryProjectCore, validateDeliveryProjectCli]) {
    const audit = validate({
      project: liveDeliveryProject(),
      manifest: boundManifest({url: "https://github.com/orgs/Siltech-Consult/projects/8"}),
      complete: false
    });
    assert.deepEqual(audit.failures.map((failure) => failure.type), ["untrusted_project_manifest"]);
  }
});

test("apply false nao grava bind de manifest pendente", async () => {
  let writes = 0;
  const manifest = {
    schemaVersion: 2,
    state: "pending_create",
    pendingCreate: {organization: "Siltech-Consult", title: "Siltech Delivery", runNonce: "dry-1", timestamp: "2026-07-27T00:00:00.000Z"},
    project: null,
    issueFields: {}
  };
  await createOrReuseDeliveryProject({
    organization: "Siltech-Consult",
    manifest,
    apply: false,
    writeManifest: async () => { writes += 1; },
    runGh: async () => ({data: {organization: {id: "ORG_1", projectsV2: {
      nodes: [{id: "PVT_1", number: 7, title: "Siltech Delivery", url: "https://github.com/orgs/Siltech-Consult/projects/7", public: false, owner: {login: "Siltech-Consult"}}],
      pageInfo: {hasNextPage: false, endCursor: null}
    }}}})
  });
  assert.equal(writes, 0);
  assert.equal(manifest.state, "pending_create");
});

test("validador exige timestamp ISO e metadados completos em bound", () => {
  const base = {
    schemaVersion: 2,
    state: "bound",
    pendingCreate: {organization: "Siltech-Consult", title: "Siltech Delivery", runNonce: "type-1", timestamp: "not-a-date"},
    project: {id: "PVT_1", number: 0, title: "Siltech Delivery", owner: "Siltech-Consult", url: "not-url"},
    issueFields: {}
  };
  const audit = validateDeliveryProject({
    project: {id: "PVT_1", title: "Siltech Delivery", owner: "Siltech-Consult", public: false, projectFields: []},
    requiredIssueFields: {Priority: "IF_PRIORITY", Workflow: "IF_WORKFLOW", Effort: "IF_EFFORT", Wave: "IF_WAVE"},
    manifest: base,
    issues: []
  });
  assert.equal(audit.failures[0].type, "invalid_project_manifest");
  assert.match(audit.failures[0].reason, /timestamp/);
});

test("validador recusa numero ou URL invalidos em bound", () => {
  for (const project of [
    {id: "PVT_1", number: 0, title: "Siltech Delivery", owner: "Siltech-Consult", url: "https://github.com/orgs/Siltech-Consult/projects/7"},
    {id: "PVT_1", number: 7, title: "Siltech Delivery", owner: "Siltech-Consult", url: "http://example.test/project/7"}
  ]) {
    const audit = validateDeliveryProject({
      project: {id: "PVT_1", title: "Siltech Delivery", owner: "Siltech-Consult", public: false, projectFields: []},
      requiredIssueFields: {Priority: "IF_PRIORITY", Workflow: "IF_WORKFLOW", Effort: "IF_EFFORT", Wave: "IF_WAVE"},
      manifest: {
        schemaVersion: 2,
        state: "bound",
        pendingCreate: {organization: "Siltech-Consult", title: "Siltech Delivery", runNonce: "type-2", timestamp: "2026-07-27T00:00:00.000Z"},
        project,
        issueFields: {}
      },
      issues: []
    });
    assert.equal(audit.failures[0].type, "invalid_project_manifest");
    assert.match(audit.failures[0].reason, /Project vinculado/);
  }
});

test("le items arquivados e preserva content IDs duplicados para auditoria", async () => {
  const project = await fetchProject({
    projectId: "PVT_1",
    runGh: async (args) => {
      const query = args.find((arg) => arg.startsWith("query=")) ?? "";
      assert.match(query, /archivedStates: \[ARCHIVED, NOT_ARCHIVED\]/);
      return {data: {node: {
        id: "PVT_1",
        number: 7,
        title: "Siltech Delivery",
        url: "https://example.test/project/7",
        public: false,
        owner: {login: "Siltech-Consult"},
        fields: {nodes: [], pageInfo: {hasNextPage: false, endCursor: null}},
        items: {
          nodes: [{id: "PVTI_1", content: {id: "I_1"}}, {id: "PVTI_2", content: {id: "I_1"}}],
          pageInfo: {hasNextPage: false, endCursor: null}
        }
      }}};
    }
  });

  assert.equal(project.rawItemCount, 2);
  assert.deepEqual(project.contentIds, ["I_1", "I_1"]);
});

test("recusa cursor de items que nao avanca", async () => {
  let calls = 0;
  await assert.rejects(fetchProject({
    projectId: "PVT_1",
    runGh: async () => {
      calls += 1;
      if (calls > 2) throw new Error("consulta repetida");
      return {data: {node: {
        id: "PVT_1",
        fields: {nodes: [], pageInfo: {hasNextPage: false, endCursor: null}},
        items: {nodes: [], pageInfo: {hasNextPage: true, endCursor: "CURSOR"}}
      }}};
    }
  }), /Cursor de items nao avancou/);
});

test("recusa ciclo de cursor A-B-A", async () => {
  let index = 0;
  const cursors = ["A", "B", "A"];
  await assert.rejects(fetchProject({
    projectId: "PVT_1",
    runGh: async () => ({data: {node: {
      id: "PVT_1",
      fields: {nodes: [], pageInfo: {hasNextPage: false, endCursor: null}},
      items: {nodes: [], pageInfo: {hasNextPage: true, endCursor: cursors[index++]}}
    }}})
  }), /Ciclo de cursor de items/);
});

test("aplica apenas operacoes ausentes com retry por item", async () => {
  const calls = [];
  const manifest = {issueFields: {}};
  const checkpoints = [];
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
    if (query.includes("createProjectV2IssueField")) {
      return {data: {createProjectV2IssueField: {projectV2Field: {id: "PF_WORKFLOW", name: "Workflow", dataType: "SINGLE_SELECT"}}}};
    }
    return {data: {addProjectV2ItemById: {item: {id: "PVTI_2", content: {id: contentId}}}}};
  };

  await applyProjectOperations({
    projectId: "PVT_1",
    operations: {addIssueFields: ["IF_WORKFLOW"], addItems: ["I_2"]},
    manifest,
    fieldNamesById: {IF_WORKFLOW: "Workflow"},
    runGh,
    apply: true,
    batchSize: 1,
    sleep: async () => {},
    retrySleep: async () => {},
    checkpoint: async (state) => checkpoints.push(structuredClone(state))
  });

  assert.equal(calls.filter((args) => (args.find((arg) => arg.startsWith("query=")) ?? "").includes("createProjectV2IssueField")).length, 1);
  assert.equal(calls.filter((args) => (args.find((arg) => arg.startsWith("query=")) ?? "").includes("addProjectV2ItemById")).length, 2);
  assert.deepEqual(manifest.issueFields.Workflow, {
    issueFieldId: "IF_WORKFLOW",
    projectFieldId: "PF_WORKFLOW",
    name: "Workflow",
    dataType: "SINGLE_SELECT"
  });
  assert.equal(checkpoints.length, 1);
});

test("recusa resposta de mutacao sem ID do campo ou item", async () => {
  await assert.rejects(applyProjectOperations({
    projectId: "PVT_1",
    operations: {addIssueFields: ["IF_WORKFLOW"], addItems: []},
    fieldNamesById: {IF_WORKFLOW: "Workflow"},
    manifest: {issueFields: {}},
    runGh: async () => ({
      data: {createProjectV2IssueField: {projectV2Field: {}}}
    }),
    apply: true
  }), /ID do campo do Project ausente/);

  await assert.rejects(applyProjectOperations({
    projectId: "PVT_1",
    operations: {addIssueFields: [], addItems: ["I_1"]},
    manifest: {issueFields: {}},
    runGh: async () => ({
      data: {addProjectV2ItemById: {item: {id: "PVTI_1", content: {id: "I_2"}}}}
    }),
    apply: true
  }), /content ID inesperado/);
});

test("aceita cada membro suportado de ProjectV2FieldConfiguration", async () => {
  for (const type of ["ProjectV2Field", "ProjectV2SingleSelectField", "ProjectV2IterationField"]) {
    let query = "";
    await applyProjectOperations({
      projectId: "PVT_1",
      operations: {addIssueFields: ["IF_WORKFLOW"], addItems: []},
      fieldNamesById: {IF_WORKFLOW: "Workflow"},
      manifest: {issueFields: {}},
      apply: true,
      runGh: async (args) => {
        query = args.find((arg) => arg.startsWith("query=")) ?? "";
        return {data: {createProjectV2IssueField: {projectV2Field: {__typename: type, id: `PF_${type}`, name: "Workflow", dataType: "SINGLE_SELECT"}}}};
      }
    });
    assert.match(query, new RegExp(`\.\.\. on ${type} \\{ id name dataType \\}`));
  }
});

test("recusa batchSize que nao seja inteiro positivo", async () => {
  await assert.rejects(applyProjectOperations({
    projectId: "PVT_1",
    operations: {addIssueFields: [], addItems: []},
    manifest: {issueFields: {}},
    runGh: async () => ({}),
    apply: true,
    batchSize: 0
  }), /batchSize deve ser inteiro positivo/);
});
