# Contributor Guide

## Environment & Common Commands

```bash
npm install        # install dependencies
npm run build      # tsc build to dist/ (extension entry loads dist output; rebuild after changes)
npm run test       # tsx --test tests/*.test.ts (planned)
```

## Architecture at a Glance

Three layers (ported from the opencode version; adaptation layer modeled on pi-dynamic-workflows):

- **Runtime engine layer**: VM sandbox, DSL primitives (agent/parallel/pipeline/sequence/fallback/race/workflow), journal. Must not import any pi SDK.
- **Session adapter layer**: the only layer allowed to touch pi SDK. `createAgentSession` sub-sessions, structured output, usage accounting.
- **Extension registration layer**: pi package manifest, `pi.registerTool`, `pi.registerCommand`, TUI widget.

Architecture constraints and platform-difference matrix: chapter 2 of `dev-docs/design/pi-code-mode插件需求文档.md`.

## Tests

- Unit tests: `tests/*.test.ts`, session runner injected via an interface seam with fakes.
- Live acceptance: run the 8 categories of scripts in `thirdparties/opencode-dynamic-workflows/examples/sample-project/` in batches (A+B = MVP gate); see `docs/testing.md`.

## Local Development Loop

Edit → `npm run build` → `/reload` in pi → verify with sample-project scripts. Load via `pi -e ./` (local path), never by npm package name (registry cache ignores local changes).

## Release

Before publishing to npm, verify peerDependencies gates (pi-coding-agent) and that `dist/` output, `extensions/` bridge, and `skills/` resources are complete.
