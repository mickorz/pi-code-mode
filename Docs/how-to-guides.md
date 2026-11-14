# How-To Guides

> Task-oriented: one section per common task, step-by-step. Grows as features land.

## Write a workflow script

1. Create `.pi/workflows/my-flow.js` in your project root (or a subfolder, referenced by path).
2. First statement must export `meta` (snake_case `name`, required `description`).
3. Orchestrate with primitives: `agent(prompt, opts)` / `parallel` / `pipeline` / `phase` / `log`; `return` the result explicitly.
4. Load it either by registry name (top-level scripts) or via the `workflow` tool with `scriptPath`.

Constraints: no import/require, no `Math.random`/`Date.now` (neutralized by the sandbox), at least one `agent()` call.

## Background runs & control

1. Submit with `background: true` on the `workflow` tool; returns a runId immediately.
2. Use the `workflow_control` tool to stop/pause/resume.
3. On completion the result is delivered back to the main session automatically.

## Resume from journal

1. First run: note the runId from the output.
2. Modify the script, then rerun with `resumeFromRunId`: the longest unchanged prefix replays from the journal (zero tokens); only changed nodes execute.
3. Sample: `scripts/resume-test.js` (two-step method).

## Scheduled runs (P2, planned)

Describe the schedule in natural language → `/schedule` → cron expression → `schedule_create`. Note: no execution while pi is closed; missed schedules do not backfill.
