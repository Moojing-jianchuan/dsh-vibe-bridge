# Maintenance: keeping up with DSH

Two layers with different lifetimes. The plugin half follows service contracts; the sidebar enhancement follows one build.

## When DSH ships a new version

```bash
# 1) plugin half — usually nothing to do, but prove it
node tools/dev-link.mjs --dsh "/path/to/new/dsh"
npm test
npm run test:wake-state

# 2) re-install into the profile (idempotent)
node tools/install.mjs --profile desktop --dsh "/path/to/new/dsh"
```

`npm test` is the contract check. It fails loudly when a service shape moved:

| Failure | What moved | Where to look |
|---|---|---|
| `ctx.subagents.startActivation is not a function` | subagent service surface | `packages/subagent/subagent/src/*` |
| `activation.result` never settles / no `childId` | activation result shape | same |
| `query_session` throws `no persisted log` | session log location | `<DSH_HOME>/sessions/<workspace-slug>/<dir>/session.v*.jsonl.zstd` |
| `list_children` returns different roles | catalog projection keys | `projectionsBySession[..].values.subagentCatalog` |
| client half: slot register fails | slot names | `packages/client/ui-workspace/src/client/contract/slots.ts` |

## When the sidebar enhancement breaks

The source patch is generated against `dsh-v0.2.1-rc.5`. A new tag means one of two outcomes:

1. **It still applies.** `git apply --check -p1` succeeds → rebuild, reinstall the bundle, done.
2. **It conflicts.** Re-derive it: the diff touches six files and each hunk has one intent —
   `tree.ts` (catalog → child rows, fold key, archive filter), `stores.ts` (retain `session:` fold keys, 200-entry cap),
   `Rows.tsx` (fold toggle, `data-depth`, no menu/drag/rename for child rows), `Rows.module.css` (indent step, toggle),
   `WorkspaceBrowser.tsx` (watermark skips child rows, a selected child keeps its parent), `locales.ts` (accessible name).
   Re-apply each intent against the new sources, then re-run the same gates listed in the README.

Gate list to reproduce a green build (from a DSH checkout):

```bash
pnpm install
pnpm run typecheck                                     # 5 gates
DSH_CLIENT_COMMIT_HASH=<sha> pnpm run build:artifacts  # 7 gates, 327 bundles
pnpm exec vitest run packages/client/ui-workspace/tests # 495 tests
pnpm exec vitest run packages/client/ui-workspace/tests \
  --coverage --coverage.include='packages/client/ui-workspace/src/**' --coverage.reporter=text
node --import tsx scripts/verify-client-ui-i18n.ts
pnpm exec tsx scripts/verify-export-jsdoc.ts
pnpm exec tsx scripts/verify-md-wrap.ts
pnpm exec tsx scripts/verify-translation-pairing.ts packages/client/ui-workspace/README.md
```

`build:artifacts` needs `DSH_CLIENT_COMMIT_HASH` when the checkout has no `.git` (a tarball, for example): it runs `git rev-parse HEAD` otherwise and fails with exit 128.

## Regenerating the patch

Keep a pristine copy of the package's `src/` before editing (`git worktree` or a copy), then:

```bash
git diff --no-index --src-prefix=a/ --dst-prefix=b/ <pristine>/packages/client/ui-workspace/src \
                                                  <checkout>/packages/client/ui-workspace/src \
  > tools/source-patch/nested-sessions.patch
```

Path prefixes must read `a/packages/client/ui-workspace/src/...` so `git apply -p1` works from the repository root.

## Release checklist

1. bump `version` in `package.json`;
2. `npm test` and `npm run test:wake-state` green;
3. if the sidebar patch changed, re-verify the gate list above and re-run `tools/install-bundle.mjs`;
4. commit, tag `vX.Y.Z`, push the tag, create the release notes from the changelog section.
