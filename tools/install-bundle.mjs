#!/usr/bin/env node
/**
 * Install a locally built `@deepseek-ai/dsh-client-ui-workspace` bundle into a
 * DSH installation, or restore the shipped one. This is the second half of the
 * optional "child rows in the native sidebar" enhancement: the plugin works
 * without it, and this step binds to one DSH build.
 *
 *   node tools/install-bundle.mjs --bundle <path/to/built/client.js> --dsh-node-modules <…>
 *   node tools/install-bundle.mjs --restore --dsh-node-modules <…>
 *   node tools/install-bundle.mjs --check   --dsh-node-modules <…>
 *
 * The first run keeps the shipped bundle next to it as
 * `client.js.vibe-bridge-original.js`; `--restore` copies it back. No DSH build
 * output is distributed by this repository — you build it from your own checkout
 * with `pnpm run build:artifacts` after applying
 * `tools/source-patch/nested-sessions.patch`.
 */
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as path from 'node:path'
import { flagValue, resolveDshModules } from './resolve-dsh.mjs'

const argv = process.argv.slice(2)
const modules = resolveDshModules(argv)
const target = path.join(modules, '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js')
const backup = `${target}.vibe-bridge-original.js`

const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
const hasFeature = file => /CHILD_ROWS_KEY_PREFIX|ChildRowsToggle/.test(readFileSync(file, 'utf8'))

if (!existsSync(target)) {
  throw new Error(`workspace client bundle not found: ${target}\nIs this a DSH installation root? Pass --dsh-node-modules <path>.`)
}

const report = () => {
  console.log(`target ${target}`)
  console.log(`  sha ${sha(target)}  ${statSync(target).size} bytes  child rows: ${hasFeature(target) ? 'present' : 'absent'}`)
  if (existsSync(backup)) console.log(`  backup ${backup}  sha ${sha(backup)}`)
}

if (argv.includes('--check')) {
  report()
  process.exit(0)
}

if (argv.includes('--restore')) {
  if (!existsSync(backup)) throw new Error(`no shipped-bundle backup at ${backup}`)
  copyFileSync(backup, target)
  console.log('restored the shipped bundle')
  report()
  process.exit(0)
}

const bundle = flagValue(argv, 'bundle')
if (bundle === undefined) {
  throw new Error('pass --bundle <path/to/built/lib/client.js>, or --check / --restore')
}
if (!existsSync(bundle)) throw new Error(`bundle not found: ${bundle}`)
if (!hasFeature(bundle)) {
  throw new Error(`${bundle} does not contain the child-row implementation; apply tools/source-patch/nested-sessions.patch and rebuild.`)
}
if (!existsSync(backup) && !hasFeature(target)) {
  copyFileSync(target, backup)
  console.log(`kept the shipped bundle as ${path.basename(backup)}`)
}
copyFileSync(bundle, target)
console.log(`installed ${sha(bundle)} -> ${sha(target)}`)
report()
console.log('\nRestart DSH (or refresh the page) to load it. Undo with --restore.')
