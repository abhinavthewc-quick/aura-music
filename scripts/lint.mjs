#!/usr/bin/env node
/* Zero-dependency project lint.
 *
 * ESLint is not part of this project's toolchain, so this script enforces the
 * handful of invariants that actually broke UI/accessibility before:
 *   - no console.log/debugger left in shipped source,
 *   - every <button> has an explicit type,
 *   - every <img> has alt text,
 *   - index.html ids stay unique,
 *   - no random placeholder image services,
 *   - new-tab links carry rel="noopener".
 *
 * Run with: npm run lint
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'

const root = process.cwd()
const problems = []

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) return name === 'node_modules' || name === 'dist' ? [] : walk(full)
    return /\.(ts|js|mjs|html)$/.test(name) ? [full] : []
  })
}

const sourceFiles = walk(join(root, 'src'))
const htmlFiles = [join(root, 'index.html')].filter((f) => {
  try { return statSync(f).isFile() } catch { return false }
})

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

for (const file of sourceFiles) {
  const text = stripComments(readFileSync(file, 'utf8'))
  const rel = relative(root, file)

  if (/\bconsole\.(log|debug)\s*\(/.test(text))
    problems.push(`${rel}: remove console.log/debug`)
  if (/\bdebugger\b/.test(text))
    problems.push(`${rel}: remove debugger`)

  if (/<img\b(?![^>]*\balt=)/.test(text))
    problems.push(`${rel}: <img> without alt`)
  if (/<button\b(?![^>]*\btype=)/.test(text))
    problems.push(`${rel}: <button> without type`)

  if (/picsum\.photos/.test(text))
    problems.push(`${rel}: random placeholder image (use DEFAULT_COVER)`)
}

for (const file of htmlFiles) {
  const text = readFileSync(file, 'utf8')
  const rel = relative(root, file)

  if (/<img\b(?![^>]*\balt=)/.test(text))
    problems.push(`${rel}: <img> without alt`)
  if (/<button\b(?![^>]*\btype=)/.test(text))
    problems.push(`${rel}: <button> without type`)
  if (/<a\b[^>]*target="_blank"[^>]*>/.test(text)) {
    for (const tag of text.match(/<a\b[^>]*target="_blank"[^>]*>/g) || []) {
      if (!/rel="[^"]*noopener/.test(tag)) problems.push(`${rel}: target=_blank without rel=noopener -> ${tag.slice(0, 80)}`)
    }
  }

  const ids = [...text.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])
  const seen = new Set()
  for (const id of ids) {
    if (seen.has(id)) problems.push(`${rel}: duplicate id="${id}"`)
    seen.add(id)
  }
}

if (problems.length) {
  console.error(`lint: ${problems.length} problem${problems.length === 1 ? '' : 's'}`)
  for (const p of problems) console.error('  •', p)
  process.exit(1)
}

console.log(`lint: clean (${sourceFiles.length} source files, ${htmlFiles.length} html file)`)
