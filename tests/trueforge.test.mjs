import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TrueForge } from '@truefoundry/trueforge-sdk'

const baseUrl = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790'
const client = new TrueForge({ baseUrl })

async function serverUp() {
  try {
    const res = await fetch(`${baseUrl}/healthz`)
    return res.ok
  } catch {
    return false
  }
}

const live = await serverUp()

test('harness registers the failover model provider', { skip: live ? false : 'trueforge not running' }, async () => {
  const page = await client.settings.modelProviders.list()
  const provider = page.data.find(entry => entry.name === 'failover')

  assert.ok(provider, 'failover provider missing — run `npm run setup`')
  assert.equal(provider.manifest.type, 'custom')
  assert.ok(provider.manifest.models.some(model => model.name === 'steg-primary'))
})

test('gmail auth prefers an OAuth token and falls back to an API key', async () => {
  const { gmailAuthHeaders } = await import('../src/setup.mjs')

  assert.deepEqual(gmailAuthHeaders({ GMAIL_MCP_TOKEN: 'tok', GMAIL_API_KEY: 'key' }), {
    Authorization: 'Bearer tok',
  })
  assert.deepEqual(gmailAuthHeaders({ GMAIL_API_KEY: 'key' }), { 'x-goog-api-key': 'key' })
  // an AIza… value pasted into the token var is an API key, not an OAuth bearer token
  assert.deepEqual(gmailAuthHeaders({ GMAIL_MCP_TOKEN: 'AIzaSyX', GMAIL_API_KEY: 'AIzaSyY' }), {
    'x-goog-api-key': 'AIzaSyX',
  })
  assert.equal(gmailAuthHeaders({}), undefined)
})

test('harness registers the steg-triage skill', { skip: live ? false : 'trueforge not running' }, async () => {
  const page = await client.settings.skills.list()
  const skill = page.data.find(entry => entry.name === 'steg-triage')

  assert.ok(skill, 'steg-triage skill missing — run `npm run setup`')
  assert.equal(skill.manifest.type, 'git')
  assert.equal(skill.manifest.path, 'skills/steg-triage')
})

test('agent is wired with model, skill, sandbox and approval gates', { skip: live ? false : 'trueforge not running' }, async () => {
  const page = await client.agents.list({ agentName: 'stegsentinel' })
  const agent = page.data.find(entry => entry.name === 'stegsentinel')

  assert.ok(agent, 'stegsentinel agent missing — run `npm run setup`')
  assert.match(agent.manifest.model.name, /^[a-z0-9-]+\/[a-z0-9][a-z0-9-]*$/)
  assert.equal(agent.manifest.config.sandbox.enabled, true)
  assert.equal(agent.manifest.config.iterationLimit, 25)
  assert.deepEqual(agent.manifest.skills.map(skill => skill.name), ['steg-triage'])

  const gmail = agent.manifest.mcpServers.find(server => server.name === 'gmail')
  if (gmail) {
    assert.ok(gmail.requireApprovalForTools.includes('@write'))
    assert.ok(gmail.requireApprovalForTools.includes('@destructive'))
    assert.ok(gmail.enableTools.includes('@read-only'))
    // @write / @destructive are approval-only tags; enable_tools rejects them.
    for (const selector of gmail.enableTools) {
      assert.ok(
        selector === '@all' || selector === '@read-only' || /^[a-z][a-zA-Z0-9_]*$/.test(selector),
        `invalid enable_tools selector: ${selector}`,
      )
    }
    // Every named tool must be one this server actually publishes.
    const named = gmail.enableTools.filter(selector => !selector.startsWith('@'))
    const remote = (await client.settings.mcpServers.list()).data.find(s => s.name === 'gmail')
    assert.equal(remote.manifest.type, 'remote')
    assert.ok(Object.keys(remote.manifest.auth.headers ?? {}).length > 0, 'gmail has no credential header')
  }
})

test('named gmail tools exist on the connected server', { skip: live ? false : 'trueforge not running' }, async () => {
  const remote = (await client.settings.mcpServers.list()).data.find(s => s.name === 'gmail')
  if (!remote) return
  const agent = (await client.agents.list({ agentName: 'stegsentinel' })).data[0]
  const gmail = agent.manifest.mcpServers.find(server => server.name === 'gmail')
  const named = gmail.enableTools.filter(selector => !selector.startsWith('@'))

  const res = await fetch(remote.manifest.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...remote.manifest.auth.headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  const body = await res.json()
  const available = new Set(body.result.tools.map(tool => tool.name))

  for (const name of named) {
    assert.ok(available.has(name), `${name} is not published by the gmail MCP server`)
  }
})


test('schedules accept the sweep definition used by `npm run run -- --schedule`', { skip: live ? false : 'trueforge not running' }, async () => {
  const name = 'stegsentinel-selftest-sweep'
  const manifest = { cron: '0 * * * *', task: 'Triage new Gmail attachments.', timezone: 'UTC' }
  const existing = (await client.schedules.list()).data.find(schedule => schedule.name === name)
  if (existing) {
    await client.schedules.delete(existing.id)
  }

  const created = await client.schedules.create({ name, agentName: 'stegsentinel', manifest })
  assert.equal(created.data.manifest.cron, '0 * * * *')

  const listed = (await client.schedules.list()).data.find(schedule => schedule.name === name)
  assert.ok(listed, 'created schedule not listed')
  assert.equal(listed.agentName, 'stegsentinel')

  await client.schedules.delete(listed.id)
  assert.equal(
    (await client.schedules.list()).data.some(schedule => schedule.name === name),
    false,
  )
})
