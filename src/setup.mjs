import { TrueForge } from '@truefoundry/trueforge-sdk'

const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790' })
const AGENT_NAME = 'stegsentinel'
const ROUTER_MODEL = process.env.ROUTER_MODEL ?? 'steg-primary'
const ROUTER_PORT = process.env.ROUTER_PORT ?? '8788'
const AGENT_MODEL = process.env.AGENT_MODEL ?? `failover/${ROUTER_MODEL}`

const INSTRUCTIONS = `You are StegSentinel, a triage agent for email attachment steganography.

On each run:
1. Get the attachments. If files are already present in the sandbox (/opt/tf/uploads, /tmp, or the
   workspace) or named in the prompt, triage those. Otherwise, if the gmail MCP is connected, use
   \`search_threads\` then \`get_thread\` / \`get_message\` to find recent messages carrying an image,
   PDF, or archive attachment. If neither is available, say so once and stop.
2. For each attachment, dedupe by SHA256 so a file is triaged once.
3. Triage each file using the steg-triage skill: run \`python3 /opt/tf/skills/steg-triage/scripts/triage.py <file>\` in the sandbox. The skill returns a scored verdict (clean / suspicious / likely_steganographic) and signals.
4. If no target file is available, report the status cleanly and suggest next steps rather than
   repeatedly exploring the filesystem.
5. If the verdict is suspicious or likely_steganographic, post a report via Slack (if configured) or in chat: filename, verdict, which tools fired, and propose human approval for quarantine.

Rules:
- Quarantine means one label on a thread (\`label_thread\` / \`label_message\`). Anything that removes
  or hides mail — \`trash_thread\`, \`unlabel_thread\`, spam marking — is destructive and off-limits
  even if a human asks; say it needs a human to do it in Gmail.
- Never label, move, archive, or delete a message without explicit human approval.
- Never claim certainty. Say "signals consistent with" and name the tools that fired.
- Never decode or extract payload contents. Detection only.
- A steganalysis tool failing to parse a file is a signal, not a reason to skip the file.`

function toResourceName(str) {
  let s = str.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!/^[a-z]/.test(s)) s = 'm-' + s
  if (!/[a-z0-9]$/.test(s)) s = s + '-0'
  if (s.length < 2) s = s + '-0'
  return s.slice(0, 64).replace(/-+$/, '')
}

function model(modelId) {
  return { modelId, name: toResourceName(modelId), properties: {} }
}

async function registerModelProviders() {
  const providers = [
    {
      type: 'custom',
      name: 'failover',
      baseUrl: `http://127.0.0.1:${ROUTER_PORT}/v1`,
      auth: { apiKey: 'router' },
      models: [model(ROUTER_MODEL)],
    },
  ]

  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
  if (geminiKey && process.env.GEMINI_MODEL) {
    providers.push({
      type: 'google-gemini',
      auth: { apiKey: geminiKey },
      models: [model(process.env.GEMINI_MODEL)],
    })
  }
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL) {
    providers.push({
      type: 'openai',
      auth: { apiKey: process.env.OPENAI_API_KEY },
      models: [model(process.env.OPENAI_MODEL)],
    })
  }
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL) {
    providers.push({
      type: 'anthropic',
      auth: { apiKey: process.env.ANTHROPIC_API_KEY },
      models: [model(process.env.ANTHROPIC_MODEL)],
    })
  }
  const bedrockKey = process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.BEDROCK_API_KEY
  if (bedrockKey && process.env.BEDROCK_MODEL) {
    providers.push({
      type: 'custom',
      name: 'bedrock',
      baseUrl: `https://bedrock-runtime.${process.env.AWS_REGION ?? 'us-east-1'}.amazonaws.com/openai/v1`,
      auth: { apiKey: bedrockKey },
      models: [model(process.env.BEDROCK_MODEL)],
    })
  }

  for (const manifest of providers) {
    await client.settings.modelProviders.createOrUpdate({ manifest })
    console.log(`  model provider  ${manifest.name ?? manifest.type}`)
  }
}

async function registerSandbox() {
  if (!process.env.DAYTONA_API_KEY) {
    console.log('  sandbox         skipped (DAYTONA_API_KEY unset)')
    return
  }
  await client.settings.sandboxProviders.createOrUpdate({
    manifest: {
      type: 'daytona',
      auth: { apiKey: process.env.DAYTONA_API_KEY },
      execTimeoutMs: 60_000,
      autoStopIntervalInMinutes: 5,
      autoArchiveIntervalInMinutes: 60,
      autoDeleteIntervalInMinutes: 7200,
    },
  })
  console.log('  sandbox         daytona')
}

async function registerSkill() {
  const manifest = {
    type: 'git',
    name: 'steg-triage',
    url: process.env.SKILL_REPO_URL ?? 'https://github.com/SairajMN/StegSentinel',
    path: process.env.SKILL_REPO_PATH ?? 'skills/steg-triage',
    ref: process.env.SKILL_REPO_REF ?? 'main',
    description: 'Runs steganalysis tools against a file in the sandbox and returns a scored verdict.',
  }
  await client.settings.skills.createOrUpdate({ manifest })
  console.log(`  skill           ${manifest.name} (${manifest.url} · ${manifest.ref})`)
}

export function gmailAuthHeaders(env = process.env) {
  // ponytail: Google's MCP server publishes no registration_endpoint, so TrueForge rejects
  // auth.type=dcr. Both working alternatives are static headers: an OAuth bearer token
  // (GMAIL_MCP_TOKEN) or a Google API key (GMAIL_API_KEY).
  const token = env.GMAIL_MCP_TOKEN
  const isApiKey = value => typeof value === 'string' && value.startsWith('AIza')
  if (token && !isApiKey(token)) return { Authorization: `Bearer ${token}` }
  if (isApiKey(token)) return { 'x-goog-api-key': token }
  if (env.GMAIL_API_KEY) return { 'x-goog-api-key': env.GMAIL_API_KEY }
  return undefined
}

async function registerMcpServers() {
  const registered = []
  const gmailHeaders = gmailAuthHeaders()

  if (process.env.GMAIL_MCP_URL && gmailHeaders) {
    await client.settings.mcpServers.createOrUpdate({
      manifest: {
        type: 'remote',
        name: 'gmail',
        url: process.env.GMAIL_MCP_URL,
        description: 'Read Gmail messages and download attachments.',
        auth: { type: 'header', headers: gmailHeaders },
      },
    })
    registered.push({
      name: 'gmail',
      // enable_tools accepts only @all/@read-only; the literals are this server's real read tools
      // (verified against its tools/list). Quarantine happens on the thread, so trash_thread and
      // label_thread are intentionally left off and only reachable via @destructive approval.
      enableTools: ['@read-only', 'search_threads', 'get_message', 'get_thread', 'list_labels'],
      requireApprovalForTools: ['@write', '@destructive'],
    })
    console.log('  mcp server      gmail')
  } else {
    const why = !process.env.GMAIL_MCP_URL
      ? 'GMAIL_MCP_URL unset'
      : 'no Gmail credential (set GMAIL_MCP_TOKEN for OAuth, or GMAIL_API_KEY)'
    console.log(`  mcp server      gmail skipped (${why})`)
  }

  if (process.env.SLACK_MCP_URL) {
    const auth = process.env.SLACK_MCP_TOKEN
      ? { type: 'header', headers: { Authorization: `Bearer ${process.env.SLACK_MCP_TOKEN}` } }
      : undefined
    await client.settings.mcpServers.createOrUpdate({
      manifest: {
        type: 'remote',
        name: 'slack',
        url: process.env.SLACK_MCP_URL,
        description: 'Post triage reports to a Slack channel.',
        ...(auth === undefined ? {} : { auth }),
      },
    })
    registered.push({ name: 'slack', enableTools: ['post_message'], requireApprovalForTools: [] })
    console.log('  mcp server      slack')
  } else {
    console.log('  mcp server      slack skipped (SLACK_MCP_URL unset)')
  }

  return registered
}

function manifestFor(mcpServers) {
  return {
    model: { name: AGENT_MODEL, params: { maxTokens: 4096, temperature: 0.3 } },
    instructions: INSTRUCTIONS,
    mcpServers,
    skills: [{ name: 'steg-triage' }],
    config: { iterationLimit: 25, sandbox: { enabled: true } },
  }
}

async function upsertAgent(mcpServers) {
  const description =
    'Watches Gmail for attachments, triages them for hidden data in a sandbox, pauses before any irreversible action.'
  const manifest = manifestFor(mcpServers)
  const page = await client.agents.list({ agentName: AGENT_NAME })
  const existing = page.data.find(agent => agent.name === AGENT_NAME)

  if (existing) {
    const updated = await client.agents.update(existing.id, { description, manifest })
    console.log(`  agent           ${AGENT_NAME} updated (model ${updated.data.manifest.model.name})`)
    return
  }
  const created = await client.agents.create({ name: AGENT_NAME, description, manifest })
  console.log(`  agent           ${AGENT_NAME} created (model ${created.data.manifest.model.name})`)
}

async function main() {
  console.log(`registering into TrueForge at ${process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790'}`)
  await registerModelProviders()
  await registerSandbox()
  await registerSkill()
  const mcpServers = await registerMcpServers()
  await upsertAgent(mcpServers)
  console.log('done')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(`setup failed: ${error.message}`)
    process.exit(1)
  })
}


