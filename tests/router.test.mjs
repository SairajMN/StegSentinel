import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRouter } from '../src/router.mjs'

function start(handler) {
  const server = createServer(handler)
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function listen(router) {
  return new Promise(resolve => router.listen(0, '127.0.0.1', () => resolve(router.address().port)))
}

function post(port, body) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('falls over to the next provider and rewrites the model id', async () => {
  let brokenHits = 0
  const broken = await start((_req, res) => {
    brokenHits += 1
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end('{"error":"upstream exploded"}')
  })
  const healthy = await start((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ model: process.env.STUB_MODEL ?? 'claude-stub', choices: [] }))
  })

  const router = createRouter({
    chain: [
      { name: 'openai', baseUrl: `http://127.0.0.1:${broken.port}/v1`, apiKey: 'k', model: 'gpt-stub' },
      { name: 'anthropic', baseUrl: `http://127.0.0.1:${healthy.port}/v1`, apiKey: 'k', model: 'claude-stub' },
    ],
    log: () => {},
  })
  const port = await listen(router)

  const res = await post(port, { model: 'steg-primary', messages: [{ role: 'user', content: 'hi' }] })
  const body = await res.json()

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-router-provider'), 'anthropic')
  assert.equal(body.model, 'claude-stub')
  assert.equal(brokenHits, 1)

  router.close()
  broken.server.close()
  healthy.server.close()
})

test('reports every provider failure instead of hanging', async () => {
  const dead = await start((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end('{"error":"bad key"}')
  })
  const router = createRouter({
    chain: [{ name: 'openai', baseUrl: `http://127.0.0.1:${dead.port}/v1`, apiKey: 'k', model: 'gpt-stub' }],
    log: () => {},
  })
  const port = await listen(router)

  const res = await post(port, { model: 'steg-primary', messages: [] })
  const body = await res.json()

  assert.equal(res.status, 502)
  assert.match(body.error.message, /openai 401/)

  router.close()
  dead.server.close()
})

test('unreachable provider falls through to a healthy one', async () => {
  const healthy = await start((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"model":"bedrock-stub","choices":[]}')
  })
  const router = createRouter({
    chain: [
      { name: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'gpt-stub' },
      { name: 'bedrock', baseUrl: `http://127.0.0.1:${healthy.port}/v1`, apiKey: 'k', model: 'bedrock-stub' },
    ],
    log: () => {},
  })
  const port = await listen(router)

  const res = await post(port, { model: 'steg-primary', messages: [] })

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-router-provider'), 'bedrock')

  router.close()
  healthy.server.close()
})
