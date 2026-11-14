# Getting Started

> Project is in early development (requirements and design done, see `dev-docs/design/pi-code-mode插件需求文档.md`). This page updates as implementation progresses.

## Prerequisites

- Node.js >= 20 (ESM project, TypeScript build)
- pi agent (`@earendil-works/pi-coding-agent` >= 0.99, deferred tool exposure required)
- git (worktree isolation depends on it)

## Install

```bash
git clone https://github.com/mickorz/pi-code-mode.git
cd pi-code-mode
npm install
npm run build
```

Try locally without touching settings:

```bash
pi -e ./pi-code-mode
```

## Verify

After pi starts, confirm the `workflow` and `workflow_control` tools are available.

## First Run

Start pi inside `thirdparties/opencode-dynamic-workflows/examples/sample-project/` and ask the Main Agent to run the smoke script via the `workflow` tool:

```
Run scripts/smoke-test.js with the workflow tool, passing the file path as scriptPath
```

Expected: 3 sub-agent calls complete (1 discovery + 2 parallel), returning `info` and `results`.

## Next Steps

- Configuration: `configuration.md`
- Acceptance checklist (8 categories of test scripts): `testing.md`
