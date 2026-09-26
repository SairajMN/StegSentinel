#!/usr/bin/env node
// Local triage: run the skill's scorer over local files without going through the harness.
// The agent's sandbox is remote (Daytona) and cannot see this machine's disk, so this is
// how you check files before wiring Gmail.
import { execFile } from 'node:child_process'
import { basename, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

const run = promisify(execFile)
const TRIAGE = 'skills/steg-triage/scripts/triage.py'

const MARK = {
  clean: '·',
  suspicious: '!',
  likely_steganographic: '!!',
}

function color(mark) {
  const tint = { '·': '\x1b[90m', '!': '\x1b[33m', '!!': '\x1b[31m' }
  return `${tint[mark]}${mark}\x1b[0m`
}

export async function triageFile(path) {
  const { stdout } = await run('python3', [TRIAGE, resolve(path)], { maxBuffer: 8 << 20 })
  const report = JSON.parse(stdout)
  report.sha256 = createHash('sha256').update(await readFile(path)).digest('hex')
  return report
}

export function formatReport(report) {
  const lines = [`${color(MARK[report.verdict])} ${report.verdict}  ${report.file}  ${report.size} bytes  sha256:${report.sha256.slice(0, 16)}`]
  for (const signal of report.signals) {
    lines.push(`    ${signal.source} -> ${signal.name}: ${signal.detail}`)
  }
  const missing = Object.entries(report.tools).filter(([, out]) => out === 'not installed').map(([name]) => name)
  if (missing.length > 0) lines.push(`    (not installed: ${missing.join(', ')})`)
  // A tool that cannot read this format is not a gap in the analysis, so it is not worth
  // printing on every row; the verdict already accounts for which tools actually ran.
  return lines.join('\n')
}

async function main() {
  const paths = process.argv.slice(2)
  if (paths.length === 0) {
    console.error('usage: npm run triage -- <file> [file...]')
    process.exit(1)
  }

  for (const path of paths) {
    try {
      console.log(formatReport(await triageFile(path)))
    } catch (error) {
      console.error(`${basename(path)}: ${error.message}`)
      process.exitCode = 1
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}