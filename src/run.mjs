import { TrueForge } from '@truefoundry/trueforge-sdk'

const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790' })
const AGENT_NAME = 'stegsentinel'

const TASK = `Triage new Gmail attachments. List messages with image, PDF, or archive attachments,
dedupe by SHA256, run the steg-triage skill in the sandbox on each new file, and report any
suspicious or likely_steganographic result. Propose the next step and wait for my approval.`

const SWEEP_CRON = process.env.SWEEP_CRON ?? '0 * * * *'

async function createSchedule() {
  const name = 'stegsentinel-sweep'
  const page = await client.schedules.list()
  const existing = page.data.find(schedule => schedule.name === name)
  const manifest = {
    cron: SWEEP_CRON,
    task: TASK,
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
    input: [{ type: 'user.message', content: TASK }],
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
  await runOnce()
}

main().catch(error => {
  console.error(`run failed: ${error.message}`)
  process.exit(1)
})
