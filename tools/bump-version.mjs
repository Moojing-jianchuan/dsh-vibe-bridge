/** 去掉 package.json 的 BOM 并升版本（UTF-8 无 BOM 输出）。 */
import { readFileSync, writeFileSync } from 'node:fs'

const version = process.argv[2]
if (version === undefined) throw new Error('usage: node tools/bump-version.mjs 0.10.0')

const pkgPath = 'package.json'
const raw = readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, '')
const pkg = JSON.parse(raw)
pkg.version = version
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

const libPath = 'lib/index.js'
const lib = readFileSync(libPath, 'utf8')
const next = lib.replace(/const VERSION = "[^"]*"/, `const VERSION = "${version}"`)
if (next === lib) throw new Error('VERSION constant not found in lib/index.js')
writeFileSync(libPath, next, 'utf8')

const check = JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''))
const shown = readFileSync(libPath, 'utf8').split('\n').find((line) => line.startsWith('const VERSION'))
console.log(`version -> ${check.version} | ${shown.trim()} | BOM: ${readFileSync(pkgPath).subarray(0, 3).toString('hex') === 'efbbbf'}`)
