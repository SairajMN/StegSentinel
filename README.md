# StegSentinel

Gmail attachment steganography triage agent running on [TrueForge](https://trueforge.dev).

It reads new Gmail attachments, dedupes them by SHA-256, scores each one for hidden data with
steganography tools inside a Daytona sandbox, and reports anything suspicious — stopping for human
approval before it touches a single message. The submission summary is in
[SubMISSION.md](SubMISSION.md).

```
Gmail ──fetch_gmail.py──► data/staged ──► sandbox: steg-triage skill ──► verdict
  gmail.readonly         SHA-256          exiftool, binwalk, zsteg, pngcheck
                                │         + pure-Python fallbacks
                                │
                    TrueForge agent ──► report (Slack MCP, optional)
                    approval gate ◄── one label, human-approved
                    Sessions ◄── built-in audit trail
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

4. **Run the whole loop in one command** — pull Gmail, stage, triage in the sandbox, report:

   ```bash
   npm run run -- --sweep
   ```

   Or drive it in pieces:

   ```bash
   npm run fetch                    # ingest + score locally, no sandbox
   npm run run                      # one session on whatever is staged
   npm run run -- --schedule        # hourly unattended sweep
   ```

   The chat UI at `http://localhost:8790` renders the Approve/Edit/Reject card, which is the best
   way to show the approval gate. Name a file in your message to have the agent triage it.

5. **Optional: fixtures.** `npm run seed` writes clean and rigged images to `fixtures/` if you want
   known-answer material to upload to a test inbox.

## What the agent reaches, and where it stops

| Reaches | Stops at |
| --- | --- |
| Reads mail (`messages.list` / `get` / `attachments.get`) | Labelling a thread — needs an approved action |
| Downloads attachments to a staging dir | Anything destructive, always |
| Runs 4 steganalysis tools + fallbacks in an isolated sandbox | Decoding a payload — no such code path exists |
| Writes a manifest and a plain-language report | Repeating a verdict for a file it already triaged |

The Gmail credential is scoped `gmail.readonly`, so the fetcher *cannot* label, move, or delete mail
even if it were asked to. That is the point: the safety property lives in the token, not in prompt
discipline. Quarantine is one label on a thread, behind TrueForge's approval gate, and the agent's
instructions name `trash_thread` and `unlabel_thread` as off-limits even if a human requests them.

Ingestion runs on your machine and triage runs in the sandbox. That split is deliberate: the
`gmail.readonly` credential and your disk never enter the sandbox, and the sandbox never gains
mailbox access. `npm run run -- --sweep` runs both in sequence.

## Why a router for model fallback

TrueForge runs one model per agent (`provider/model`) and has no failover of its own, and AWS
Bedrock is not a built-in provider type. `src/router.mjs` is a ~110-line OpenAI-compatible proxy
that tries each configured provider in order before the first byte reaches the harness, and rewrites
the model id per provider. All of them speak OpenAI chat-completions:

| Provider | Endpoint | Status here |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | works; `gpt-5.1`, since 5.5 returns empty content |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | plain turns only — Gemini 3.x cannot complete a tool loop over this path |
| Anthropic | `https://api.anthropic.com/v1` | supported, not configured |
| AWS Bedrock | `https://bedrock-runtime.<region>.amazonaws.com/openai/v1` | supported, **not usable on this account** — see below |

Set a provider's key and it joins the chain; a provider that errors or is unreachable is skipped.
Set none and the router refuses to start rather than silently running on nothing. TrueForge only
ever talks to `failover/steg-primary`.

`ROUTER_MODEL` (`steg-primary`) is the name the harness knows; `OPENAI_MODEL`, `GEMINI_MODEL`, and
`ANTHROPIC_MODEL` are the real ids each hop uses.

> **Bedrock caveat, stated plainly.** The key in `.env.example` authenticates (`inference-profiles`
> returns 200) but every reachable model returns `400 Operation not allowed` — the account has no
> enabled model, and Anthropic on Bedrock is inference-profile-only. It needs a model enabled in the
> Bedrock console; that is a console step, not a code change.

## Verified

```bash
npm test    # 32 tests
```

| Test | Proves |
| --- | --- |
| `tests/router.test.mjs` | failover order, model-id rewrite, 502 when every provider is down |
| `tests/triage.test.mjs` | clean vs LSB-rigged vs appended-archive verdicts, format routing, false-positive regressions, Gmail staging end to end |
| `tests/trueforge.test.mjs` | live harness: provider, skill, agent approval gates, sandbox TTL, schedule API |
| `tests/session.test.mjs` | a real turn: agent → failover provider → router → upstream, streamed back |

`tests/triage.test.mjs` and `tests/session.test.mjs` run without API keys or a network. The session
test stands up stub upstreams, so the whole chain runs without spending a token. Pointing the
harness at a local provider is what `OUTBOUND_URL_ALLOWED_HOSTS` in `npm run trueforge` is for — the
harness blocks loopback by default.

The last live run: **36 attachments from 20 messages, 10 images triaged, every report carrying
`"unavailable_tools": []`** (all five tools present), 4 clean / 3 suspicious / 3 likely_steganographic.

## Before the demo

- **Push the skill.** Skills are git-backed: the sandbox sparse-clones `SKILL_REPO_URL` +
  `SKILL_REPO_PATH` + `SKILL_REPO_REF`, so `skills/steg-triage/` has to be on the branch you pin.
- **Daytona key** in `DAYTONA_API_KEY`. Without it `npm run setup` skips the sandbox and the agent
  has nowhere to run the skill.
- **Daytona disk.** One sandbox is provisioned per session, and each holds a venv plus the
  analysis tools, so they add up. `npm run setup` sets `autoDeleteIntervalInMinutes` to 30
  (`SANDBOX_TTL_MINUTES`) — raise it and you will hit *"sandbox has reached its total disk
  limit"*. To clear a full account now: `npm run clean-sandboxes` (add `--dry-run` first).
  The harness has no delete route, so this talks to Daytona's API directly.
- **The first triage of a cold sandbox is slow.** The skill installs `exiftool`, `binwalk`,
  `pngcheck` and Ruby+`zsteg` on demand, which takes a few minutes. `SANDBOX_EXEC_TIMEOUT_MS`
  is 300s for that reason; at 60s the install is killed partway and every tool then reports
  "not installed", which looks like a missing tool rather than a slow one. Run once before you
  present. A fresh sandbox is identifiable in the report by `"unavailable_tools": []` — an
  empty list means all five tools ran.
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

## Real vs. stubbed

| Real | Stubbed / not wired |
| --- | --- |
| Gmail ingestion against a live mailbox, real OAuth | — |
| Real analysis tools in a real Daytona sandbox | — |
| TrueForge agent, sandbox provisioning, approval gate, Sessions audit trail | — |
| Model calls against the configured OpenAI key | Bedrock (no enabled model on this account) |
| Scorer, verdicts, dedupe, format routing | Slack — MCP is registered, `SLACK_MCP_URL` unset, so reports go to the chat/terminal |
| 32 tests. 25 run with no API keys and no network; the other 7 need TrueForge running locally (still no keys) | Test corpus is synthetic (`npm run seed`, `steg_test_pngs/`) |

## Non-goals

- No WhatsApp integration — no official API for personal accounts.
- No payload decoding or extraction — detection and flagging only. There is no decode path in the
  code to enable.
- No unattended quarantine or delete — the human approval step is the point.

## Known ceilings

These are real, and worth stating before someone finds them.

- **`steghide` does not install.** It needs mcrypt, which is absent from Debian's default index, and
  there is no current Homebrew formula. **JPEG, BMP and WAV therefore run without it** — the PNG
  path (zsteg, binwalk, pngcheck, fallbacks) is complete, but do not claim JPEG coverage. It is
  listed in `unavailable_tools` when missing, so a report never implies coverage it did not have.
- **A cold sandbox is slow.** First triage installs the tools, a few minutes. Pre-warm before a demo.
- **Detection is statistical.** High-entropy noise images stay clean, but a strong LSB embedder in a
  noisy file can still slip past the fallback. `binwalk` catches the naive appended-payload case; a
  deliberate spread-spectrum embedder beats this.
- **Failover happens before the first byte**; a stream that dies mid-body is not retried.
- **TrueForge's minimum schedule interval is one hour**, so `SWEEP_CRON` cannot go tighter.
- **Only PNG bit planes 1–2 are scanned** by the pure-Python fallback; deeper planes are unexplored.
- **Synthetic test data only.** Real-world false-positive rates are unmeasured, and synthetic
  fixtures flatter the detector. Measuring that against a real corpus is the next step.

## License

MIT. See [LICENSE](LICENSE).
