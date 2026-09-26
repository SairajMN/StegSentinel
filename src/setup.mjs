import { TrueForge } from '@truefoundry/trueforge-sdk'

const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790' })
const AGENT_NAME = 'stegsentinel'
const ROUTER_MODEL = process.env.ROUTER_MODEL ?? 'steg-primary'
const ROUTER_PORT = process.env.ROUTER_PORT ?? '8788'

const INSTRUCTIONS = `You are StegSentinel, a triage agent for email attachment steganography.

On each run:
1. List new Gmail messages carrying image, PDF, or archive attachments using the gmail MCP tools.
2. For each attachment, dedupe by SHA256 so a file is triaged once.
3. Triage each new attachment with the steg-triage skill in the sandbox. The skill returns a
   scored verdict (clean / suspicious / likely_steganographic) and which tools fired.
4. If the verdict is suspicious or likely_steganographic, post a plain-language report with the
   slack MCP tool: filename, sender, verdict, which tools fired, and a proposed next step.

Rules:
- Never label, move, archive, or delete a Gmail message without explicit human approval. Propose
  the action and stop; the approval card is the human's decision.
- Never claim certainty. Say "signals consistent with" and name the tools that fired.
- Never decode or extract payload contents. Detection only.
- A steganalysis tool failing to parse a file is a signal, not a reason to skip the file.`

function model(name) {
  return { modelId: name, name, properties: {} }
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
  const bedrockKey = process.env.AWS_BEARER_TOKEN_BEDROCK ?? process.env.BEDROCK_API_KEY
  if (bedrockKey) {
    const region = process.env.AWS_REGION ?? 'us-east-1'
    const modelId = process.env.BEDROCK_MODEL ?? 'anthropic.claude-3-5-sonnet-20241022-v2:0'
    providers.push({
      type: 'custom',
      name: 'bedrock',
      baseUrl: `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`,
      auth: { apiKey: bedrockKey },
      models: [model(modelId)],
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

async function registerMcpServers() {
  const registered = []

  if (process.env.GMAIL_MCP_URL) {
    await client.settings.mcpServers.createOrUpdate({
      manifest: {
        type: 'remote',
        name: 'gmail',
        url: process.env.GMAIL_MCP_URL,
        description: 'Read Gmail messages and download attachments.',
        auth: { type: 'dcr' },
      },
    })
    registered.push({
      name: 'gmail',
      enableTools: ['@read-only', 'list_messages', 'get_attachment'],
      requireApprovalForTools: ['@write', '@destructive', 'modify_labels', 'trash_message'],
    })
    console.log('  mcp server      gmail')
  } else {
    console.log('  mcp server      gmail skipped (GMAIL_MCP_URL unset)')
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
    model: { name: `failover/${ROUTER_MODEL}`, params: { maxTokens: 4096, temperature: 0.3 } },
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

main().catch(error => {
  console.error(`setup failed: ${error.message}`)
  process.exit(1)
})


