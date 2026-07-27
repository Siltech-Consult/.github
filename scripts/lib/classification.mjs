const FIELD_NAMES = ["Priority", "Workflow", "Effort", "Wave"];
const EFFORT_RANK = {XS: 1, S: 2, M: 3, L: 4, XL: 5};

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function issueLabels(issue) {
  return (Array.isArray(issue.labels) ? issue.labels : [])
    .map((label) => typeof label === "string" ? label : label?.name)
    .filter((label) => label !== undefined)
    .map(normalize);
}

function setIfMissing(proposed, sources, field, value, source) {
  if (!hasValue(proposed[field]) && hasValue(value)) {
    proposed[field] = value;
    sources[field] = source;
  }
}

function overrideKey(issue) {
  return `${issue.repository}#${issue.number}`;
}

function linkedPullRequestWorkflow(issue) {
  const pullRequests = Array.isArray(issue.linkedPullRequests) ? issue.linkedPullRequests : [];
  if (pullRequests.some((pullRequest) => normalize(pullRequest?.state) === "open" && pullRequest?.merged !== true)) {
    return {value: "In progress", source: "rule: linked open pull request"};
  }
  if (pullRequests.some((pullRequest) => pullRequest?.merged === true || normalize(pullRequest?.state) === "merged")) {
    return {value: "Validation", source: "rule: linked merged pull request"};
  }
  return undefined;
}

function priorityFromLabels(labels, rules) {
  const priorities = (Array.isArray(rules.priorityLabels) ? rules.priorityLabels : [])
    .map((priority) => ({priority, normalized: normalize(priority)}));
  return priorities.find(({normalized}) => labels.includes(normalized) || labels.includes(`priority:${normalized}`));
}

function priorityFromTitle(title, rules) {
  const match = String(title ?? "").match(/^\s*(?:\[\s*(p[0-5])\s*\]|(p[0-5])\s*:)/i);
  if (!match) return undefined;
  const normalized = normalize(match[1] ?? match[2]);
  const priorities = (Array.isArray(rules.priorityLabels) ? rules.priorityLabels : [])
    .map((priority) => ({priority, normalized: normalize(priority)}));
  return priorities.find(({normalized: candidate}) => candidate === normalized);
}

function waveFromLabels(labels, rules) {
  const waves = rules.waveLabels && typeof rules.waveLabels === "object" ? rules.waveLabels : {};
  return Object.entries(waves)
    .map(([label, wave]) => ({label: normalize(label), wave}))
    .find(({label}) => labels.includes(label));
}

function effortMatches(text, rules) {
  const patterns = rules.effortPatterns && typeof rules.effortPatterns === "object" ? rules.effortPatterns : {};
  return Object.entries(patterns).flatMap(([effort, values]) =>
    (Array.isArray(values) ? values : [])
      .filter((pattern) => text.includes(normalize(pattern)))
      .map((pattern) => ({effort, pattern: normalize(pattern)}))
  );
}

function defaultWave(priority) {
  if (["P0", "P1"].includes(priority)) return "Onda 1";
  if (priority === "P2") return "Onda 2";
  if (["P3", "P4", "P5"].includes(priority)) return "Futuro";
  return undefined;
}

export function classifyIssue(issue, rules = {}, overrides = {}) {
  const current = {...(issue.fields && typeof issue.fields === "object" ? issue.fields : {})};
  const proposed = {...current};
  const sources = Object.fromEntries(Object.keys(proposed).map((field) => [field, "existing"]));
  const warnings = [];
  const unresolvedFields = new Set();
  const labels = issueLabels(issue);
  const override = overrides && typeof overrides === "object" ? overrides[overrideKey(issue)] : undefined;

  if (override && typeof override === "object") {
    for (const [field, value] of Object.entries(override)) {
      if (field !== "reason") setIfMissing(proposed, sources, field, value, `override: ${override.reason ?? "sem justificativa"}`);
    }
    if (Object.keys(override).some((field) => field !== "reason") && !hasValue(override.reason)) {
      warnings.push(`Override ${overrideKey(issue)} sem justificativa`);
    }
  }

  const frozen = (Array.isArray(rules.frozenLabels) ? rules.frozenLabels : [])
    .map(normalize)
    .some((label) => labels.includes(label));
  if (frozen) {
    setIfMissing(proposed, sources, "Workflow", "Frozen", "rule: frozen label");
    setIfMissing(proposed, sources, "Wave", "Futuro", "rule: frozen label");
  }

  const pullRequestWorkflow = linkedPullRequestWorkflow(issue);
  if (pullRequestWorkflow) {
    setIfMissing(proposed, sources, "Workflow", pullRequestWorkflow.value, pullRequestWorkflow.source);
  }

  const priority = priorityFromLabels(labels, rules);
  if (priority) {
    setIfMissing(proposed, sources, "Priority", priority.priority, `rule: label ${priority.normalized}`);
  } else {
    const titlePriority = priorityFromTitle(issue.title, rules);
    if (titlePriority) {
      setIfMissing(proposed, sources, "Priority", titlePriority.priority, `rule: title prefix ${titlePriority.normalized}`);
    }
  }

  const wave = waveFromLabels(labels, rules);
  if (wave) {
    setIfMissing(proposed, sources, "Wave", wave.wave, `rule: label ${wave.label}`);
  }

  const text = `${issue.title ?? ""}\n${issue.body ?? ""}`.toLowerCase();
  const matches = effortMatches(text, rules);
  if (matches.length > 0) {
    const unranked = matches.filter(({effort}) => !EFFORT_RANK[effort]);
    if (unranked.length > 0) {
      unresolvedFields.add("Effort");
      warnings.push(`Effort sem ranking: ${unranked.map(({effort}) => effort).join(", ")}`);
    } else {
      const largest = matches.reduce((selected, match) =>
        EFFORT_RANK[match.effort] > EFFORT_RANK[selected.effort] ? match : selected
      );
      const distinctEfforts = [...new Set(matches.map(({effort}) => effort))];
      const source = distinctEfforts.length > 1
        ? `rule: effort maior ${largest.effort} (pattern ${largest.pattern})`
        : `rule: effort pattern ${largest.pattern}`;
      setIfMissing(proposed, sources, "Effort", largest.effort, source);
      if (distinctEfforts.length > 1) {
        warnings.push(`Effort signals conflitantes; selecionado maior ${largest.effort}`);
      }
    }
  }

  setIfMissing(proposed, sources, "Priority", "P2", "default");
  setIfMissing(proposed, sources, "Workflow", "Backlog", "default");
  if (!unresolvedFields.has("Effort")) {
    setIfMissing(proposed, sources, "Effort", "M", "default");
  }
  setIfMissing(proposed, sources, "Wave", defaultWave(proposed.Priority), "default by Priority");

  for (const field of FIELD_NAMES) {
    if (!hasValue(proposed[field])) {
      sources[field] = "unresolved";
      warnings.push(`${field} sem valor`);
    }
  }

  return {
    current,
    proposed,
    sources,
    ambiguous: FIELD_NAMES.some((field) => !hasValue(proposed[field])),
    warnings
  };
}
