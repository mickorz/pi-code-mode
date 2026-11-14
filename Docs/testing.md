# Install & Run Acceptance Checklist

> Baseline: the 8 script categories in `thirdparties/opencode-dynamic-workflows/examples/sample-project/` (category detail: chapter 3 of `dev-docs/design/pi-code-mode插件需求文档.md`).

## Overview

| Batch | Categories | Gate |
|---|---|---|
| 1 | A basic orchestration + B sub-workflows | MVP |
| 2 | C quality/structured + D persistence/resume + E isolation/background | P1 |
| 3 | F scheduling + G UI observability + H tiers/benchmarks | P2 |

## Installation Checks

- [ ] `npm run build` produces `dist/` without errors
- [ ] `pi -e ./` exposes the `workflow` / `workflow_control` tools
- [ ] Registry recognizes `.pi/workflows/` (and the compatible `.opencode-workflows/workflows/`)

## Smoke Test

- [ ] `scripts/smoke-test.js`: 3 agent calls complete, returns info + results
- [ ] `scripts/chain-root.js`: sequential chain passes prev results correctly
- [ ] `scripts/native/deep_parent.js`: nesting depth limit enforced

## Final Checklist

- [ ] All of category A passes (smoke/chain/multi-tree/concurrency/acceptance)
- [ ] All of category B passes (native 16 + composite 13, incl. self-reference rejection, depth limit, error propagation)
- [ ] Category C passes (judgePanel/verify/checkpoint, schema structured output)
- [ ] Category D passes (resume-test.js two-step: journal replay at zero cost, only changed nodes rerun)
- [ ] Category E passes (worktree isolation leaves main dir untouched, background run delivers result back)
- [ ] Category F passes (schedule-test.js fires on cron)
- [ ] Category G visually verified (node detail panel, progress, checkpoint confirmation)
- [ ] Category H (optional) tier fallback and benchmark regression
