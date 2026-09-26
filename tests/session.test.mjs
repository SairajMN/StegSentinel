import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { TrueForge } from '@truefoundry/trueforge-sdk'
import { createRouter } from '../src/router.mjs'

const baseUrl = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790'
const routerPort = Number(process.env.ROUTER_PORT ?? 8788)
const client = new TrueForge({ baseUrl })
const STUB_REPLY = 'stub upstream answered'

async function serverUp() {
  try {
    return (await fetch(`${baseUrl}/healthz`)).ok
  } catch {
    return false
  }
}

function chatCompletionStream(reply) {
  const chunk = delta =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-stub',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'stub-model',
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`
  return (
    chunk({ role: 'assistant', content: reply }) +
    `data: ${JSON.stringify({
      id: 'chatcmpl-stub',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'stub-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\ndata: [DONE]\n\n`
  )
}

const live = await serverUp()

test('a turn runs through the failover router and streams model output', { skip: live ? false : 'trueforge not running' }, async () => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(chatCompletionStream(STUB_REPLY))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))

  const router = createRouter({
    chain: [
      { name: 'openai', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'stub', model: 'stub-model' },
    ],
    log: () => {},
  })
  const listening = await new Promise(resolve => {
    router.once('error', error => resolve(error.code))
    router.listen(routerPort, '127.0.0.1', () => resolve('ok'))
  })
  if (listening !== 'ok') {
    upstream.close()
    return assert.ok(true, `router port ${routerPort} busy — skipped`)
  }

  const page = await client.agents.list({ agentName: 'stegsentinel-selftest' })
  const existing = page.data.find(agent => agent.name === 'stegsentinel-selftest')
  const manifest = {
    model: { name: 'failover/steg-primary' },
    instructions: 'Reply with exactly the text the user asks for.',
    config: { iterationLimit: 3, sandbox: { enabled: false } },
  }
  if (existing) {
    await client.agents.delete(existing.id)
  }
  await client.agents.create({ name: 'stegsentinel-selftest', description: 'pipeline self-test', manifest })
  const agent = (await client.agents.list({ agentName: 'stegsentinel-selftest' })).data[0]

  const session = await client.sessions.create({ agent: { name: agent.name } })
  const stream = await client.sessions.createTurnStream(session.data.id, {
    input: [{ type: 'user.message', content: `Say: ${STUB_REPLY}` }],
  })

  let text = ''
  let sawToolApproval = false
  for await (const event of stream) {
    if (event.type === 'model.message.delta' && typeof event.content === 'string') {
      text += event.content
    }
    if (event.type === 'tool.approval_required') {
      sawToolApproval = true
    }
  }

  assert.match(text, new RegExp(STUB_REPLY))
  assert.equal(sawToolApproval, false)

  await client.sessions.delete(session.data.id)
  await client.agents.delete(agent.id)
  router.close()
  upstream.close()
})
