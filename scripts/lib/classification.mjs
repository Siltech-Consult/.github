const FIELD_NAMES = ["Priority", "Workflow", "Effort", "Wave"];

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
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
  if (!hasOwn(proposed, field) && hasValue(value)) {
    proposed[field] = value;
    sources[field] = source;
  }
}

function overrideKey(issue) {
  return `${issue.repository}#${issue.number}`;
}

function openPullRequest(issue) {
  return (Array.isArray(issue.linkedPullRequests) ? issue.linkedPullRequests : [])
    .some((pullRequest) => normalize(pullRequest?.state) === "open" && pullRequest?.merged === false);
}

function priorityFromLabels(labels, rules) {
  const priorities = (Array.isArray(rules.priorityLabels) ? rules.priorityLabels : [])
    .map((priority) => ({priority, normalized: normalize(priority)}));
  return priorities.find(({normalized}) => labels.includes(normalized) || labels.includes(`priority:${normalized}`));
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

  if (openPullRequest(issue)) {
    setIfMissing(proposed, sources, "Workflow", "In progress", "rule: linked open pull request");
  }

  const priority = priorityFromLabels(labels, rules);
  if (priority) {
    setIfMissing(proposed, sources, "Priority", priority.priority, `rule: label ${priority.normalized}`);
  }

  const wave = waveFromLabels(labels, rules);
  if (wave) {
    setIfMissing(proposed, sources, "Wave", wave.wave, `rule: label ${wave.label}`);
  }

  const text = `${issue.title ?? ""}\n${issue.body ?? ""}`.toLowerCase();
  const matches = effortMatches(text, rules);
  if (matches.length > 0) {
    const first = matches[0];
    setIfMissing(proposed, sources, "Effort", first.effort, `rule: effort pattern ${first.pattern}`);
    const distinctEfforts = [...new Set(matches.map(({effort}) => effort))];
    if (distinctEfforts.length > 1) {
      warnings.push(`Effort ambigua: ${distinctEfforts.join(", ")}`);
    }
  }

  setIfMissing(proposed, sources, "Priority", "P2", "default");
  setIfMissing(proposed, sources, "Workflow", "Backlog", "default");
  setIfMissing(proposed, sources, "Effort", "M", "default");
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
