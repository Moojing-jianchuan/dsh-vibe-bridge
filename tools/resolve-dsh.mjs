#!/usr/bin/env node
/**
 * Resolve the `@deepseek-ai` package directory of a local DSH installation.
 *
 * The plugin's host half imports `@deepseek-ai/schemastery`, `dsh-tools`,
 * `dsh-llm`, and `dsh-brand`; tests and installs must resolve them from the
 * user's own DSH install, because that is the module instance the host loads.
 *
 * Order: `--dsh <dir>` (the app dir, e.g. .../resources/app/dsh) wins, then
 * `--dsh-node-modules <dir>`, then `DSH_NODE_MODULES`, then `DSH_HOME` guesses.
 * @param argv - process arguments.
 * @returns absolute path to a directory containing `@deepseek-ai`.
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'

/**
 * Read one `--flag value` pair from argv.
 * @param argv - arguments after the script name.
 * @param flag - flag to look for, without dashes.
 * @returns the value, or undefined when the flag is absent.
 */
export function flagValue(argv, flag) {
  const at = argv.indexOf(`--${flag}`)
  if (at < 0) return undefined
  const value = argv[at + 1]
  if (value === undefined || value.startsWith('--')) return undefined
  return value
}

/**
 * Verify a candidate holds the DSH client packages the plugin needs.
 * @param candidate - directory that should contain `@deepseek-ai`.
 * @returns the candidate when it is usable, otherwise undefined.
 */
function usable(candidate) {
  if (candidate === undefined) return undefined
  const scope = path.join(candidate, '@deepseek-ai')
  if (!existsSync(scope)) return undefined
  for (const name of ['schemastery', 'dsh-tools', 'dsh-llm', 'dsh-brand']) {
    if (!existsSync(path.join(scope, name))) return undefined
  }
  return candidate
}

/**
 * Resolve the node_modules directory that holds `@deepseek-ai`.
 * @param argv - arguments after the script name.
 * @returns absolute path to an existing node_modules directory.
 * @throws When nothing usable is found, naming every path it tried.
 */
export function resolveDshModules(argv) {
  const tried = []
  const explicitApp = flagValue(argv, 'dsh')
  if (explicitApp !== undefined) {
    tried.push(explicitApp)
    const found = usable(path.join(path.resolve(explicitApp), 'node_modules'))
    if (found !== undefined) return found
  }
  const explicitModules = flagValue(argv, 'dsh-node-modules')
  if (explicitModules !== undefined) {
    tried.push(explicitModules)
    const found = usable(path.resolve(explicitModules))
    if (found !== undefined) return found
  }
  const fromEnv = process.env.DSH_NODE_MODULES
  if (fromEnv !== undefined) {
    tried.push(fromEnv)
    const found = usable(fromEnv)
    if (found !== undefined) return found
  }
  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  for (const profile of ['desktop', 'web']) {
    for (const candidate of [
      path.join(home, 'profiles', profile, 'node_modules'),
      path.join(home, 'node_modules'),
    ]) {
      tried.push(candidate)
      const found = usable(candidate)
      if (found !== undefined) return found
    }
  }
  const names = existsSync(home) ? readdirSync(path.join(home, 'profiles')).join(', ') : '(none)'
  throw new Error(
    'Could not find a DSH installation with the @deepseek-ai packages.\n' +
      `Tried:\n${tried.map(entry => `  - ${entry}`).join('\n')}\n` +
      `Profiles under ${home}: ${names}\n` +
      'Pass --dsh <path-to-the-dsh-app-dir> or --dsh-node-modules <path-to-its-node_modules>.',
  )
}
