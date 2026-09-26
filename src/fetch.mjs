#!/usr/bin/env node
// Stage Gmail attachments, then score whatever landed. Read-only: the fetcher holds
// gmail.readonly, so this can pull mail but cannot label, move, or delete anything.
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
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
  return JSON.parse(stdout)
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

  await mkdir(STAGE, { recursive: true })
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2))

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
