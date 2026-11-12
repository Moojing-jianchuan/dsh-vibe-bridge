#!/usr/bin/env node
/**
 * Link a local DSH installation's `@deepseek-ai` scope into this package so the
 * host-half tests resolve the same module instances the host loads.
 *
 *   node tools/dev-link.mjs --dsh "C:\path\to\dsh"     # app dir, or
 *   node tools/dev-link.mjs --dsh-node-modules "…\node_modules"
 *
 * Creates `node_modules/@deepseek-ai` as a junction (Windows) or directory
 * symlink (POSIX). Re-running is a no-op; `--remove` drops the link.
 */
import { existsSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshModules } from './resolve-dsh.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const linkPath = path.join(root, 'node_modules', '@deepseek-ai')

if (process.argv.includes('--remove')) {
  if (!existsSync(linkPath)) {
    console.log(`nothing to remove: ${linkPath}`)
    process.exit(0)
  }
  unlinkSync(linkPath)
  console.log(`removed ${linkPath}`)
  process.exit(0)
}

const target = resolveDshModules(process.argv.slice(2))
mkdirSync(path.dirname(linkPath), { recursive: true })

if (existsSync(linkPath)) {
  console.log(`link already present: ${linkPath} -> ${target}`)
  process.exit(0)
}

symlinkSync(path.join(target, '@deepseek-ai'), linkPath, process.platform === 'win32' ? 'junction' : 'dir')
console.log(`linked ${linkPath} -> ${path.join(target, '@deepseek-ai')}`)
console.log('now run: node test/smoke.mjs && node test/client-smoke.mjs')
