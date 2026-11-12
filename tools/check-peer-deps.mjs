#!/usr/bin/env node
/**
 * Check that every bare `@deepseek-ai/*` import in the shipped host modules is
 * declared in `peerDependencies`. Runs in CI without a DSH installation.
 * @returns exit code 1 when an import is undeclared.
 */
import { readFileSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const declared = new Set(Object.keys(manifest.peerDependencies ?? {}))

const files = [
  ...readdirSync(path.join(root, 'lib')).filter(name => name.endsWith('.js')).map(name => path.join('lib', name)),
  ...readdirSync(path.join(root, 'tools')).filter(name => name.endsWith('.mjs')).map(name => path.join('tools', name)),
]

const missing = []
for (const file of files) {
  const text = readFileSync(path.join(root, file), 'utf8')
  for (const match of text.matchAll(/^import[^'"]*['"]((?:@deepseek-ai)\/[^'"]+)['"]/gm)) {
    const specifier = match[1]
    const scope = specifier.split('/').slice(0, 2).join('/')
    if (!declared.has(scope)) missing.push(`${file}: ${specifier}`)
  }
}

if (missing.length > 0) {
  console.error('undeclared @deepseek-ai imports (add them to peerDependencies):')
  for (const entry of missing) console.error(`  ${entry}`)
  process.exit(1)
}
console.log(`peer dependencies cover ${files.length} shipped module(s)`)
