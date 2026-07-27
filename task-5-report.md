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
