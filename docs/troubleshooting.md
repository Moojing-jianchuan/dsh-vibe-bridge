# Troubleshooting

Real failures hit while building and running this plugin, with the cause and the fix.

## `cannot get property "X" without inject`

The plugin reads a Cordis service through the property proxy (`ctx.subagents`, `ctx.agents`, `ctx.tools`, `ctx.commands`) without declaring it. Add the service name to the plugin's `inject` array. Strict `ctx.get(name)` reads the global store and does not need the declaration; the property proxy does.

## `ERR_MODULE_NOT_FOUND` for `dsh-vibe-bridge`

The plugin must be installed **inside the profile's** `node_modules`. DSH resolves bare specifiers from the profile directory, and the client half's `dsh.client` manifest is read from the installed package. `tools/install.mjs` does this; copying files into the app directory does not work.

## The plugin loads but the sidebar entry is missing

Check, in order:

1. the page was refreshed after the client bundle changed (the client half is served, not read from disk);
2. `lib/client.js` is listed when you inspect the host's plugin inventory (`pluginInventory/list`);
3. the browser console has no slot error — a `slots.register` into an undeclared slot fails at load.

## Host-half edits do nothing until a restart

`node_modules` is excluded from HMR. Editing `lib/index.js` in the installed location requires restarting DSH; editing `lib/client.js` requires a page refresh.

## `Cannot read properties of undefined (reading 'throwIfAborted')`

`subagents.startActivation` expects an `AbortSignal`. A caller that has none (a host command, for example) must pass `new AbortController().signal`.

## Notices arrive twice

DSH already sends a settlement notice when a child finishes. Passing `delivery: "parent"` keeps it; this plugin passes `delivery: "caller"` and sends its own id-carrying notice instead. If you see duplicates, something else is also calling `agent.followup` for the same child.

## `wake-state.json` grows or wakes the wrong parent

The file lives at `<DSH_HOME>/vibe-bridge/wake-state.json`, entries expire after `wakeStateTtlMs` (12 h default). Delete it while DSH is stopped to reset; nothing else depends on it. A stale entry can only cause one extra "finished" notice, because `announced` is persisted before the notice is sent.

## `dsh --profile <name>` refuses to start: "managed exclusively by the Electron application"

The desktop app owns its profile. For experiments use a separate profile (`dsh --profile vetest web --port 62xxx --no-open`) instead of touching the app-managed one.

## Multi-frame zstd: `query_session` returns partial rounds

DSH session logs are zstd frames concatenated back-to-back. Splitting on the frame magic (`28 B5 2F FD`) and decompressing each frame independently is required; a single `zstd -d` pass reads only the first frame.

## `test:gui` red in a DSH checkout (Windows)

Two different causes, neither related to this plugin:

- `ui-deliverables > Presented workspace file native open route` — `EPERM` creating a symlink; Windows needs admin or Developer Mode for `symlink`. Fails alone too.
- `connection/binary-rpc` (gzip cases) and `ui-sidebar-documentpreview` (license bundle) — fail under the full parallel lane, pass when run alone. Flaky under load.

Reproduce either with `pnpm exec vitest run <spec path>`.
