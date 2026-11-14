# Configuration Reference

> Planned configuration surface; final behavior follows the implementation. Design basis: `dev-docs/design/pi-code-mode插件需求文档.md`.

## Configuration Fields

| Name | Type | Default | Description |
|---|---|---|---|
| Workflow script directory | Convention | `.pi/workflows/*.js` | Top-level scripts join the registry; `.opencode-workflows/workflows/` also scanned for compatibility |
| model-tiers | JSON file | `~/.pi/workflows/model-tiers.json` | small/medium/big tiers mapped to `provider/modelId:thinking` |
| inheritMainModel | Boolean | TBD | Agents without tier/model inherit the main session model |
| State directory | Directory | `~/.pi/workflows/` | settings, runs, journals, saved workflows; redirect via `PI_CODING_AGENT_DIR` |

## Taking Effect & Verification

After changing tier mappings or directory conventions, run `/reload` in pi; check the registered workflow list via `/workflows`.

## Upgrade

`pi update --extensions` reconciles the package installation; reference submodules are updated with `git submodule update --remote` and logged in `thirdparties/REFERENCES.md`.

## Uninstall

`pi remove <source>` removes the package; runtime state under `~/.pi/workflows/` must be cleaned manually.
