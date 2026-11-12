#!/usr/bin/env node
/**
 * Install this plugin into a DSH profile (idempotent; safe to re-run).
 *
 *   node tools/install.mjs --profile desktop --dsh "C:\path\to\dsh"
 *   node tools/install.mjs --profile desktop --dsh-node-modules "…\node_modules"
 *   node tools/install.mjs --uninstall --profile desktop
 *
 * A profile resolves bare specifiers from its own directory and reads
 * `dsh.client` from the installed package, so the plugin lives in
 * `<profile>/node_modules/dsh-vibe-bridge`, and its `@deepseek-ai` dependencies
 * are a link to the host install so both halves share one module instance.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { flagValue, resolveDshModules } from './resolve-dsh.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const argv = process.argv.slice(2)
const profileName = flagValue(argv, 'profile') ?? 'desktop'
const dshHome = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
const profile = path.join(dshHome, 'profiles', profileName)
const target = path.join(profile, 'node_modules', 'dsh-vibe-bridge')
const patchFile = path.join(profile, 'cordis.patch.yml')
const ENTRY_ID = 'vibe-bridge'

if (!existsSync(profile)) {
  throw new Error(`profile not found: ${profile}\nCreate it by launching DSH once with --profile ${profileName}.`)
}

if (argv.includes('--uninstall')) {
  if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  if (existsSync(patchFile)) {
    const text = readFileSync(patchFile, 'utf8')
    const stripped = text.replace(/\n?(- insert:\n)?(    )?- id: vibe-bridge[\s\S]*?(?=\n- insert:|\s*$)/, '\n')
    writeFileSync(patchFile, stripped.trim().length === 0 ? '[]\n' : stripped, 'utf8')
  }
  console.log(`uninstalled from ${profile}`)
  process.exit(0)
}

const modules = resolveDshModules(argv)

// 1) The package itself: host half, client half, package manifest, nudge copy.
mkdirSync(path.join(target, 'lib'), { recursive: true })
mkdirSync(path.join(target, 'test'), { recursive: true })
for (const file of ['index.js', 'client.js']) {
  copyFileSync(path.join(root, 'lib', file), path.join(target, 'lib', file))
}
for (const file of ['package.json', 'nudge.md']) {
  copyFileSync(path.join(root, file), path.join(target, file))
}
for (const file of readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.mjs'))) {
  copyFileSync(path.join(root, 'test', file), path.join(target, 'test', file))
}
console.log(`installed package -> ${target}`)

// 2) Dependencies resolve to the host's own modules.
const depLink = path.join(target, 'node_modules', '@deepseek-ai')
mkdirSync(path.dirname(depLink), { recursive: true })
if (existsSync(depLink)) {
  unlinkSync(depLink)
}
symlinkSync(path.join(modules, '@deepseek-ai'), depLink, process.platform === 'win32' ? 'junction' : 'dir')
console.log(`linked ${depLink} -> ${path.join(modules, '@deepseek-ai')}`)

// 3) Smoke the two halves where they actually resolve from.
for (const spec of ['test/smoke.mjs', 'test/client-smoke.mjs']) {
  execFileSync(process.execPath, [path.join(target, spec)], { cwd: target, stdio: 'inherit' })
}
console.log('smoke tests passed')

// 4) Register the plugin in the profile patch, unless it is already there.
const existing = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
if (new RegExp(`^\\s*-?\\s*id:\\s*${ENTRY_ID}\\s*$`, 'm').test(existing)) {
  console.log(`${patchFile} already registers ${ENTRY_ID}`)
  process.exit(0)
}
const nudge = path.join(target, 'nudge.md')
const block = [
  '- insert:',
  `    - id: ${ENTRY_ID}`,
  "      name: 'dsh-vibe-bridge'",
  '      config:',
  '        enabled: true',
  '        provider: spawn',
  '        rules:',
  '          - name: verify',
  `            file: '${nudge}'`,
  '            everyTurns: 4',
  '            fullEveryTurns: 12',
  '            fromTurn: 1',
  '            skipSubagentSessions: true',
  '            speakOnFirstSeen: true',
].join('\n')
const merged = existing.trim().length === 0 || existing.trim() === '[]'
  ? block
  : `${existing.trimEnd()}\n${block}`
writeFileSync(patchFile, `${merged}\n`, 'utf8')
console.log(`registered ${ENTRY_ID} in ${patchFile}`)
console.log('\nDone. Restart DSH (host half), then refresh the page (client half).')
