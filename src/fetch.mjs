#!/usr/bin/env node
// Stage Gmail attachments, then score whatever landed. Read-only: the fetcher holds
// gmail.readonly, so this can pull mail but cannot label, move, or delete anything.
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { formatReport, triageFile } from './triage.mjs'

const run = promisify(execFile)
const FETCH = 'skills/steg-triage/scripts/fetch_gmail.py'
const STAGE = process.env.STAGE_DIR ?? 'data/staged'
const MANIFEST = `${STAGE}/manifest.json`

export async function fetchManifest({ query, max, dest = STAGE } = {}) {
  const args = [FETCH, '--dest', dest]
  if (query) args.push('--query', query)
  if (max) args.push('--max', String(max))
  const { stdout } = await run('python3', args, { maxBuffer: 8 << 20 })
  const manifest = JSON.parse(stdout)
  // The manifest is the handoff to the agent, so it is written here rather than in the CLI:
  // every caller that ingests needs it on disk, not just the one that prints a report.
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

async function main() {
  const args = process.argv.slice(2)
  const only = args.includes('--stage-only')

  let manifest
  try {
    manifest = await fetchManifest()
  } catch (error) {
    // The fetcher already explains the fix in plain language; don't bury it in a dump.
    const detail = error.stderr?.trim().split('\n').map(line => `  ${line}`).join('\n')
    console.error(detail ?? error.message)
    process.exitCode = 1
    return
  }

  const seen = new Set()
  for (const record of manifest.attachments) {
    if (seen.has(record.sha256)) {
      console.log(`   dup  ${basename(record.path)} (already triaged)`)
      continue
    }
    seen.add(record.sha256)
    if (only) {
      console.log(`   staged ${basename(record.path)} ${record.size} bytes`)
      continue
    }
    console.log(formatReport(await triageFile(record.path)))
  }

  const messages = manifest.messages.length
  console.log(
    `${messages} message(s), ${manifest.attachments.length} attachment(s), ` +
      `${seen.size} unique — manifest: ${MANIFEST}`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
