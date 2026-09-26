# StegSentinel

Gmail attachment steganography triage agent running on [TrueForge](https://trueforge.dev).

It lists new Gmail attachments, dedupes them by SHA256, triages each one with steganalysis tools
inside the Daytona sandbox, and reports anything suspicious to Slack — stopping for human
approval before it touches a single message.

```
Gmail ──fetch_gmail.py──► data/staged ──► sandbox: steg-triage skill ──► verdict
                                 │
Gmail ──MCP (optional) ──────────┘       TrueForge harness ──► approvals,
                                        │  audit trail, sessions
                                        ├── failover router ──► OpenAI → Gemini
                                        └── Slack MCP ◄── plain-language report
```

## Quickstart

```bash
node -v                 # needs >= 22.14
npm install
cp .env.example .env    # add your keys
```

1. **Start the harness.** The outbound allowlist is what lets the harness call the local router:

   ```bash
   npm run trueforge     # http://localhost:8790 — chat UI on the same port
   ```

2. **Start the failover router** in a second terminal:

   ```bash
   npm run router        # http://127.0.0.1:8788/v1
   ```

3. **Register everything** (model providers, sandbox, skill, MCP servers, agent):

   ```bash
   npm run setup         # safe to re-run; it updates in place
   ```

4. **Seed demo attachments** and upload them to a test Gmail account:

   ```bash
   npm run seed          # fixtures/: 2 clean, 1 LSB-rigged, 1 with an appended archive
   ```

5. **Ingest and score** — runs on your machine, not in the sandbox. This is the Gmail step:

   ```bash
   npm run fetch                    # pull attachments, dedupe by hash, score each one
   npm run fetch -- --stage-only    # just pull the bytes
   ```

   It stages into `data/staged/` and writes `data/staged/manifest.json`.

6. **Run the agent** — chat UI (best for the live demo: Approve/Edit/Reject renders as a card) or:

   ```bash
   npm run run                # one session, streamed to your terminal
   npm run run -- --schedule  # hourly unattended sweep
   ```

### Why ingest and the agent are separate steps

`npm run fetch` holds the `gmail.readonly` credential and runs on your machine. The agent runs in
the Daytona sandbox, which has neither that credential nor your disk. So ingestion is an explicit
step you run, and the agent picks up whatever files it is given.

This is a deliberate split, not a workaround. The credential never enters the sandbox, and the
sandbox never gains read access to your mailbox. The agent still owns everything that matters for
governance: the verdict, the report, the approval gate, and the audit trail.

In the chat UI, name a staged file in your message to have the agent triage it, e.g.
`triage data/staged/d063a0252ad02f18-Screenshot_2026-09-24_at_9.40.11_PM.png`.

## Why a router for model fallback

TrueForge runs one model per agent (`provider/model`) and has no failover of its own, and AWS
Bedrock is not a built-in provider type. `src/router.mjs` is a ~90-line OpenAI-compatible proxy
that tries each configured provider in order before the first byte reaches the harness, and
rewrites the model id per provider. All three speak OpenAI chat-completions:

| Provider | Endpoint |
| --- | --- |
| OpenAI | `https://api.openai.com/v1` |
| Anthropic | `https://api.anthropic.com/v1` (OpenAI SDK compatibility) |
| Bedrock | `https://bedrock-runtime.<region>.amazonaws.com/openai/v1` + `AWS_BEARER_TOKEN_BEDROCK` |

Set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `AWS_BEARER_TOKEN_BEDROCK` and all three get used —
a provider that errors or is unreachable is skipped. Set only one and it uses just that one.
TrueForge only ever talks to `failover/steg-primary`.

`ROUTER_MODEL` (`steg-primary`) is the name the harness knows; `OPENAI_MODEL`, `ANTHROPIC_MODEL`,
and `BEDROCK_MODEL` are the real ids each hop uses.

## Verified

```bash
npm test    # 13 tests, no API keys required
```

| Test | Proves |
| --- | --- |
| `tests/router.test.mjs` | failover order, model-id rewrite, 502 when every provider is down |
| `tests/triage.test.mjs` | clean vs LSB-rigged vs appended-archive verdicts, missing tools degrade |
| `tests/trueforge.test.mjs` | live harness: provider, skill, agent approval gates, schedule API |
| `tests/session.test.mjs` | a real turn: agent → failover provider → router → upstream, streamed back |

The session test stands up stub upstreams, so the whole chain runs without spending a token.
Pointing the harness at a local provider is what `OUTBOUND_URL_ALLOWED_HOSTS` in `npm run trueforge`
is for — the harness blocks loopback by default.

## Before the demo

- **Push the skill.** Skills are git-backed: the sandbox sparse-clones `SKILL_REPO_URL` +
  `SKILL_REPO_PATH` + `SKILL_REPO_REF`, so `skills/steg-triage/` has to be on the branch you pin.
- **Daytona key** in `DAYTONA_API_KEY`. Without it `npm run setup` skips the sandbox and the agent
  has nowhere to run the skill.
- **Gmail** — one-time browser consent, then it just works:

  ```bash
  gcloud auth application-default login \
    --client-id-file=$HOME/Downloads/client_secret_<your-project>.json \
    --scopes=https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/cloud-platform
  ```

  Three things gcloud won't tell you unless you hit them:

  - **`--client-id-file` is required.** Google blocks *gcloud's own* OAuth client for
    `gmail.readonly` ("this app tried to access sensitive info"). Pass a Desktop client secret you
    created in Cloud Console → APIs & Services → Credentials, and the consent screen offers
    *Advanced → Go to (unsafe)* — safe, because it's your own client and it only reads mail.
  - **`cloud-platform` must be in the list.** gcloud rejects `gmail.readonly` alone.
  - **Use `$HOME`, not `~`.** gcloud does not expand a tilde in a flag value and reports
    "Cannot read file" even though the file is there.

  `gcloud auth application-default` will not widen scopes on an existing credential, so this step
  is required; it only has to happen once. `gmail.readonly` is deliberate: the fetcher physically
  cannot label, move, or delete mail, so quarantine stays behind the harness's approval gate.
- **Gmail via MCP (optional second reader)** — set `GMAIL_MCP_TOKEN` (OAuth access token) or
  `GMAIL_API_KEY` (Google API key). Google's MCP server publishes no `registration_endpoint`, so
  TrueForge's `auth.type=dcr` cannot be used with it; a static credential header is the working
  path. Token wins if both are set. Nothing in the demo depends on this one.
- **Slack** — set `SLACK_MCP_URL` and, for header auth, `SLACK_MCP_TOKEN`.
  Either server can be omitted; the agent wires whatever is registered.
- Add the `gmail.modify` scope only after you have seen the approval card block a label change.

## Non-goals

- No WhatsApp integration — no official API for personal accounts.
- No payload decoding or extraction — detection and flagging only.
- No unattended quarantine or delete — the human approval step is the point.

## Known ceilings

- Failover happens before the first byte; a stream that dies mid-body is not retried.
- TrueForge's minimum schedule interval is one hour, so `SWEEP_CRON` cannot go tighter.
- The `zsteg` / `steghide` / `binwalk` / `exiftool` / `pngcheck` signals only fire when those
  binaries exist in the sandbox; the pure-Python checks (trailing data, embedded signatures, LSB
  ASCII, PNG chunk CRCs) always run.
