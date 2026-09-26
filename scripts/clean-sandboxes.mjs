#!/usr/bin/env node
// Delete Daytona sandboxes that are no longer running. Each session provisions one and each
// holds a venv plus the analysis tools, so a busy morning fills the account's disk and the
// next run dies with "sandbox has reached its total disk limit".
//
// The harness has no delete route, so this talks to Daytona's API directly.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const API = 'https://app.daytona.io/api/sandbox'
const KEEP_RUNNING = true
const dryRun = process.argv.includes('--dry-run')

function key() {
  const match = readFileSync('.env', 'utf8').match(/^DAYTONA_API_KEY=(.*)$/m)
  if (!match?.[1]?.trim()) throw new Error('DAYTONA_API_KEY is not set in .env')
  return match[1].trim()
}

async function main() {
  const headers = { Authorization: `Bearer ${key()}` }
  const { items = [] } = await (await fetch(API, { headers })).json()

  const removable = items.filter(s => (KEEP_RUNNING ? s.state !== 'running' : true))
  const byState = {}
  for (const sandbox of items) byState[sandbox.state] = (byState[sandbox.state] || 0) + 1
  console.log(`${items.length} sandbox(es):`, byState)
  console.log(`${removable.length} eligible for deletion`)

  let deleted = 0
  for (const sandbox of removable) {
    if (dryRun) {
      console.log(`  would delete ${sandbox.id} (${sandbox.state}) ${sandbox.name ?? ''}`)
      continue
    }
    const res = await fetch(`${API}/${sandbox.id}`, { method: 'DELETE', headers })
    console.log(`  ${res.ok ? 'deleted' : `failed ${res.status}`} ${sandbox.id} (${sandbox.state})`)
    if (res.ok) deleted++
  }
  console.log(dryRun ? 'dry run — nothing deleted' : `deleted ${deleted}`)
}

await main()
