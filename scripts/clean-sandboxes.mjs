#!/usr/bin/env node
// Delete Daytona sandboxes that are no longer running. Each session provisions one and each
// holds a venv plus the analysis tools, so a busy morning fills the account's disk and the
// next run dies with "sandbox has reached its total disk limit". A sandbox left stopped but
// still claimed by a finished session also blocks the next provision.
//
// The harness has no delete route, so this talks to Daytona's API directly.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const API = 'https://app.daytona.io/api/sandbox'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function key() {
  // Absolute: this is imported by src/run.mjs, where a relative '.env' would not resolve.
  const match = readFileSync(join(ROOT, '.env'), 'utf8').match(/^DAYTONA_API_KEY=(.*)$/m)
  if (!match?.[1]?.trim()) throw new Error('DAYTONA_API_KEY is not set in .env')
  return match[1].trim()
}

export async function cleanSandboxes({ dryRun = false, quiet = false } = {}) {
  const headers = { Authorization: `Bearer ${key()}` }
  const { items = [] } = await (await fetch(API, { headers })).json()
  const removable = items.filter(sandbox => sandbox.state !== 'running')
  const log = quiet ? () => {} : console.log

  if (!quiet) {
    const byState = {}
    for (const sandbox of items) byState[sandbox.state] = (byState[sandbox.state] || 0) + 1
    log(`${items.length} sandbox(es):`, byState)
  }

  let removed = 0
  for (const sandbox of removable) {
    if (dryRun) {
      log(`  would delete ${sandbox.id} (${sandbox.state}) ${sandbox.name ?? ''}`)
      continue
    }
    const res = await fetch(`${API}/${sandbox.id}`, { method: 'DELETE', headers })
    if (res.ok) removed++
    if (!quiet) log(`  ${res.ok ? 'deleted' : `failed ${res.status}`} ${sandbox.id} (${sandbox.state})`)
  }

  if (!quiet) log(dryRun ? 'dry run — nothing deleted' : `deleted ${removed}`)
  return { total: items.length, removed }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await cleanSandboxes({ dryRun: process.argv.includes('--dry-run') })
}
