# Infra roadmap — Team Assistant

Schema: [`../README.md`](../README.md). Use-case tier only (ADR-0012): Bicep in `infra/main.bicep`
and `infra/main.<env>.bicepparam`; roles on the shared platform are requested in
`infra/grant-request.md`. Planned by `/plan-roadmap infra` once ARCHITECTURE.md Part B is filled in.

## Phase 1 — Foundation

### 1.1 — First dev apply

- **status:** todo
- **depends_on:** []
- **layers:** [infra]
- **acceptance:**
  - `infra/main.bicep` is deployed to `dev` with `deployContainerApps = false`, then `true` after the cloud team's grants
  - the deployed api answers `/health` and the web answers `/` in `dev`
- **how_to_test:**
  - _(filled in by `implement-next` when the item reaches `awaiting-test`)_
- **needs_human:**
  - real values in `infra/platform/dev.json` (subscription id and the platform resource names) from the cloud team
  - `sqlEntraAdmin` (group login + object id) and `alertEmails` in `main.dev.bicepparam`
  - the apply itself: `make infra-deploy ENV=dev` (step 1), then `node scripts/grant-request.mjs` → the cloud team grants → the contained SQL user → step 2
- **notes:**
  - 2026-10-06 — created by `/init-project`. The developer states the Azure resources already exist ("no need for any infra"); confirm against `infra/platform/dev.json` before applying anything — this item may reduce to recording the existing names.
