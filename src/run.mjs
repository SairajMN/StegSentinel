import { TrueForge } from '@truefoundry/trueforge-sdk'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'

const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790' })
const AGENT_NAME = 'stegsentinel'
const MANIFEST = process.env.MANIFEST_PATH ?? 'data/staged/manifest.json'
const IMAGE = /png|jpe?g|bmp|gif|tiff?|webp/i
const MAX_BYTES = 4 << 20

// Ingestion runs locally (npm run fetch); the sandbox is a separate machine with no Gmail
// credential and no view of data/staged. A local path in the prompt resolves to nothing there,
// so the bytes travel with the message: the harness materialises each data URI as a real file
// in the sandbox, which is what the skill then analyses.
async function buildTurn() {
  if (!existsSync(MANIFEST)) {
    return {
      content: `Triage new Gmail attachments. List messages with image, PDF, or archive attachments,
dedupe by SHA256, run the steg-triage skill in the sandbox on each new file, and report any
suspicious or likely_steganographic result. Propose the next step and wait for my approval.`,
    }
  }

  const { attachments = [] } = JSON.parse(await readFile(MANIFEST, 'utf8'))
  const unique = [...new Map(attachments.map(a => [a.sha256, a])).values()]
  const images = unique.filter(a => IMAGE.test(a.filename) && a.size <= MAX_BYTES)

  const content = [
    {
      type: 'text',
      text: [
        `Gmail ingestion already ran on the operator's machine: ${unique.length} attachments staged,`,
        `deduped by SHA-256. The ${images.length} image file(s) below are attached to this message.`,
        ``,
        `Run the steg-triage skill on each attached file. Report the verdict for each, which tools`,
        `fired, and a plain-language summary. A clean verdict is a real result, not a failure.`,
        `Propose the next step and wait for my approval before anything is labelled or moved.`,
      ].join('\n'),
    },
  ]

  for (const record of images) {
    const bytes = await readFile(record.path)
    content.push({
      type: 'file',
      name: basename(record.path),
      // Deliberately not image/png: the harness treats image/* and application/pdf as inline
      // model input and never writes them to the sandbox, so the skill would have no file to
      // analyse. A neutral MIME takes the upload path and lands the bytes in uploads/. The
      // scorer identifies format by magic bytes, not by this label or the extension.
      data: `data:application/octet-stream;base64,${bytes.toString('base64')}`,
    })
  }

  if (images.length === 0) {
    content[0].text += `\n\nThis batch has no image attachments. Say so plainly; do not explore the filesystem.`
  }
  return { content }
}

const SWEEP_CRON = process.env.SWEEP_CRON ?? '0 * * * *'

async function createSchedule() {
  const name = 'stegsentinel-sweep'
  const page = await client.schedules.list()
  const existing = page.data.find(schedule => schedule.name === name)
  const manifest = {
    cron: SWEEP_CRON,
    task: await task(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }

  if (existing) {
    await client.schedules.update(existing.id, { manifest })
    console.log(`schedule ${name} updated (${SWEEP_CRON})`)
    return
  }
  await client.schedules.create({ name, agentName: AGENT_NAME, manifest })
  console.log(`schedule ${name} created (${SWEEP_CRON})`)
}

async function runOnce() {
  const session = await client.sessions.create({ agent: { name: AGENT_NAME } })
  console.log(`session ${session.data.id}\n`)

  const stream = await client.sessions.createTurnStream(session.data.id, {
    input: [{ type: 'user.message', ...(await buildTurn()) }],
  })

  for await (const event of stream) {
    if (event.type === 'model.message.delta') {
      if (typeof event.content === 'string') process.stdout.write(event.content)
      continue
    }
    if (event.type === 'tool.approval_required') {
      const calls = event.toolCalls.map(call => call.name ?? call.toolName ?? 'tool').join(', ')
      console.log(`\n[paused for approval] ${calls}`)
      continue
    }
    if (event.type === 'tool.response' || event.type === 'sandbox.created') {
      console.log(`\n[${event.type}]`)
      continue
    }
    console.log(`\n[${event.type}]`)
  }
  console.log(
    `\ndone — open ${process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790'} -> Sessions -> ${session.data.id}`,
  )
}

async function main() {
  if (process.argv.includes('--schedule')) {
    await createSchedule()
    return
  }
  if (process.argv.includes('--sweep')) {
    // One command for the whole loop: ingest from Gmail, then triage what it staged. Without
    // this the agent gets no files and reports "uploads/ not found", which reads as a broken
    // sandbox rather than a step that was skipped.
    const { fetchManifest } = await import('./fetch.mjs')

    // A sandbox left stopped but still claimed by a session blocks the next run, and the
    // harness has no way to reap it. Clear them first so the sweep provisions a fresh one.
    console.log('clearing stale sandboxes...')
    try {
      const { cleanSandboxes } = await import('../scripts/clean-sandboxes.mjs')
      const { removed } = await cleanSandboxes({ quiet: true })
      console.log(removed > 0 ? `removed ${removed} stale sandbox(es)` : 'none to remove')
    } catch (error) {
      console.log(`skipped: ${error.message}`)
    }

    const query = process.env.GMAIL_QUERY
    console.log('ingesting from Gmail...')
    const manifest = await fetchManifest(query ? { query } : {})
    console.log(
      `staged ${manifest.attachments.length} attachment(s) from ` +
        `${manifest.messages.length} message(s) — triaging\n`,
    )
    console.log('note: a cold sandbox installs the analysis tools first; the first file takes minutes.\n')
  }
  await runOnce()
}

main().catch(error => {
  console.error(`run failed: ${error.message}`)
  process.exit(1)
})
