# Task 5 Report

## Round 4

- Status: complete.
- Bound Project identity now requires exact live `id`, `number`, `title`, `owner`, and canonical `url` equality in both manifest validation and Project reuse.
- Added adversarial coverage for correct ID with wrong number and correct ID with wrong GitHub Project URL across create/reuse, core validation, and the validator CLI export.
- TDD RED: focused suite failed exactly the four new adversarial cases.
- TDD GREEN: `node --test tests/delivery-project.test.mjs` passed 27/27.
- Full verification: `npm test` passed 91/91 plus `OK governance scripts`.
- Scope: no live writes and no Task 6 work.
- Concerns: none known.

## Round 5

- Status: complete.
- Root cause: the single immediate final Project hydration could return a successful but stale GraphQL view after the last field or item mutations.
- Added bounded final postcondition reconciliation using the existing 1s, 2s, 4s, and 8s retry delays. Each attempt only re-fetches, hydrates, and validates; mutations remain outside the loop.
- Retries are allowed only when every failure is a missing item written in this run or the total absence of a mapped field written in this run. Identity, privacy, duplicate, pre-existing-item, and mismatched-field defects remain fail-fast.
- TDD RED: stale three-item hydration failed immediately, stale field hydration failed immediately, and exhaustion stopped after the first final read.
- TDD GREEN: `node --test tests/delivery-project.test.mjs` passed 31/31, including mutation-once, convergence, bounded exhaustion, stale field, and structural fail-fast coverage.
- Full verification: `npm test` passed 95/95 plus `OK governance scripts`.
- Scope: no live writes and no Task 6 work.
- Concern: eventual consistency lasting beyond the bounded 15-second delay window still exits 1 by design.
