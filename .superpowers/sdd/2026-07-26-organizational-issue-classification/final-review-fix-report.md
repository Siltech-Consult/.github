# Final Whole-Branch Review Fix Report

Date: 2026-07-27

## Status

All four final review findings were fixed with test-first regression coverage.
No command in this work changed live GitHub organization, issue, field, item, or
Project data.

## RED Evidence

### 1. Durable Project manifest

Command:

```bash
node --test --test-name-pattern='manifest default survives fresh checkout' tests/delivery-project.test.mjs
```

Expected RED:

```text
actual:   artifacts/delivery-project-manifest.json
expected: config/delivery-project-manifest.json
tests 1, pass 0, fail 1
```

### 2. Classification result rollover

Command:

```bash
node --test --test-name-pattern='CLI arquiva resultado terminal coerente' tests/apply-classification.test.mjs
```

Expected RED:

```text
Falha na aplicacao: Resultado anterior invalido: digest do plano nao confere
tests 1, pass 0, fail 1
```

### 3. Project mutation response loss

Command:

```bash
node --test --test-name-pattern='resposta perdida sem repetir mutacao' tests/delivery-project.test.mjs
```

Expected RED for both field association and item add:

```text
actual mutation count: 2
expected mutation count: 1
tests 2, pass 0, fail 2
```

Restart durability was also driven RED:

```bash
node --test --test-name-pattern='retomada reconcilia operacao preparada' tests/delivery-project.test.mjs
```

```text
field: Project sem estado confiavel: untrusted_project_field
item: pendingOperation remained uncleared
tests 3, pass 0, fail 3
```

### 4. Inventory cap

Command:

```bash
node --test --test-name-pattern='limite de 1000' tests/github-client.test.mjs
```

Expected RED:

```text
AssertionError: Missing expected rejection.
tests 1, pass 0, fail 1
```

## GREEN Evidence

Targeted regressions passed after minimal production changes:

```text
durable manifest: 1/1 passed
terminal rollover/archive: 1/1 passed
response-loss reconciliation: 2/2 passed
prepared-operation restart: 3/3 passed
inventory cap refusal: 1/1 passed
```

Fresh full-suite command:

```bash
npm test
```

Result:

```text
OK governance scripts
tests 104
pass 104
fail 0
duration_ms 1482.329667
```

Additional checks:

```text
git diff --check: clean
secret-pattern scan of tracked manifest/docs: no matches
config/delivery-project-manifest.json: not ignored and staged as tracked
```

## Changes

- Persisted Project #11 identity and four non-secret Issue Field mappings in
  `config/delivery-project-manifest.json`; create and validate scripts now use
  that tracked path by default.
- Added terminal-only classification rollover. A coherent completed prior
  result is archived as `<output-stem>.<prior-digest>.json`; malformed,
  nonterminal, duplicate, contradictory, or summary-incoherent state fails
  before `gh`.
- Added durable `pendingOperation` intent for field association and item add.
  Mutations checkpoint before dispatch, reconcile Project state after errors
  and on restart, and do not repeat effects already observed.
- Refused organization inventory when `gh search issues` returns 1000 rows
  without independent proof of exhaustiveness.
- Updated README and Siltech Delivery runbook for all changed defaults and
  failure modes.

## Commits

- `7777c821e28a3534a7e03a41c423ffb13b8bea4c` -
  `fix: close organizational review safety gaps`

## Concerns

- Inventory now intentionally blocks at 1000 open issues. Supporting larger
  organizations requires a different exhaustive enumeration source before
  lifting this guard.
- Future live Project field association changes will update the tracked
  manifest and must be reviewed and committed after successful synchronization.
- Live GitHub behavior was not exercised by this fix run, by explicit request;
  all mutation scenarios used deterministic local fakes.
