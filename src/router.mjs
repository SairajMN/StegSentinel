import { createServer } from 'node:http'
import { Readable } from 'node:stream'

const PROVIDER_TIMEOUT_MS = Number(process.env.ROUTER_TIMEOUT_MS ?? 300_000)

export function envChain() {
  const region = process.env.AWS_REGION ?? 'us-east-1'
  const bedrockKey = process.env.AWS_BEARER_TOKEN_BEDROCK ?? process.env.BEDROCK_API_KEY
  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
  return [
    {
      name: 'gemini',
      baseUrl: process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: geminiKey,
      model: process.env.GEMINI_MODEL ?? 'gemini-3.8-flash',
    },
    {
      name: 'openai',
      baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL,
    },
    {
      name: 'anthropic',
      baseUrl: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1',
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL,
    },
    {
      name: 'bedrock',
      baseUrl: process.env.BEDROCK_BASE_URL ?? `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`,
      apiKey: bedrockKey,
      model: process.env.BEDROCK_MODEL,
    },
  ].filter(provider => provider.apiKey && provider.model)
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function createRouter({ chain = envChain(), log = line => console.error(line) } = {}) {
  return createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { providers: chain.map(provider => provider.name) })
    }
    if (req.method !== 'POST' || !(req.url ?? '').startsWith('/v1/chat/completions')) {
      return sendJson(res, 404, { error: { message: 'only /v1/chat/completions is proxied' } })
    }

    let request
    try {
      request = JSON.parse(await readBody(req))
    } catch {
      return sendJson(res, 400, { error: { message: 'invalid JSON body' } })
    }

    let lastError = 'no provider configured'
    for (const provider of chain) {
      try {
        const upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
          body: JSON.stringify({ ...request, model: provider.model }),
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        })

        if (!upstream.ok) {
          lastError = `${provider.name} ${upstream.status}: ${(await upstream.text()).slice(0, 200)}`
          log(`[router] ${lastError}`)
          continue
        }

        log(`[router] ${provider.name} answered`)
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
          'x-router-provider': provider.name,
          'cache-control': 'no-cache',
        })
        if (upstream.body === null) {
          res.end(await upstream.text())
        } else {
          Readable.fromWeb(upstream.body).pipe(res)
        }
        return
      } catch (error) {
        lastError = `${provider.name} ${error.message}`
        log(`[router] ${lastError}`)
      }
    }

    // ponytail: failover happens before the first byte — a stream that dies mid-body is not retried.
    sendJson(res, 502, { error: { message: `all providers failed: ${lastError}` } })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const chain = envChain()
  if (chain.length === 0) {
    console.error('no provider keys set — fill .env (see .env.example)')
    process.exit(1)
  }
  const port = Number(process.env.ROUTER_PORT ?? 8788)
  createRouter({ chain }).listen(port, '127.0.0.1', () => {
    console.error(`[router] ${chain.map(provider => provider.name).join(' -> ')} on http://127.0.0.1:${port}/v1`)
  })
}
