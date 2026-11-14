# Troubleshooting

## Installation

**No workflow tools after loading pi**
- Check pi version: deferred tool exposure requires pi >= 0.99; on older hosts tools stay behind tool_search or upgrade the host.
- Make sure `npm run build` ran: the extension bridge loads `dist/` output; missing output means silent registration failure.
- For local trials use `pi -e ./` (local path); the npm package-name form installs an older cached version.

## Runtime

**Script rejected: non-deterministic call detected**
- The sandbox forbids `Math.random` / `Date.now()` / parameterless `new Date()`; handle randomness and timestamps in agent prompts or on the host side, not in the orchestration script.

**Sub-agents see the workflow tools again (recursive nesting)**
- Sub-sessions must disable host extensions and workflow tools (`noExtensions` + `excludeTools`). If you whitelisted this package via providerMiddlewareExtensions, you reintroduced the recursion risk — remove that entry.

**Registry cannot find my workflow**
- Only `*.js` at the **top level** of the workflow directory join the registry; subfolder scripts are addressable by explicit path only. Confirm the directory is `.pi/workflows/` or the compatible `.opencode-workflows/workflows/`.

**Resume produces wrong results**
- The journal replays by call position; changing the script's prefix structure causes misalignment. Verify the journal against the original script first, then modify in small steps.

## Still Stuck

- Check `dev-docs/experience/` for a recorded similar problem.
- Open an issue with journal and run snapshot files attached (not just terminal output).
