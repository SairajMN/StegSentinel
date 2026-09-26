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
  assert.equal(agent.manifest.model.name, 'failover/steg-primary')
  assert.equal(agent.manifest.config.sandbox.enabled, true)
  assert.equal(agent.manifest.config.iterationLimit, 25)
  assert.deepEqual(agent.manifest.skills.map(skill => skill.name), ['steg-triage'])

  const gmail = agent.manifest.mcpServers.find(server => server.name === 'gmail')
  if (gmail) {
    assert.ok(gmail.requireApprovalForTools.includes('@write'))
    assert.ok(gmail.requireApprovalForTools.includes('@destructive'))
    assert.ok(gmail.enableTools.includes('@read-only'))
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
