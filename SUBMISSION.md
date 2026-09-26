# StegSentinel — solution writeup

## The problem

Anyone can hide data in an image. Email re-encodes nothing, so a payload survives intact: the file is
a valid PNG the whole way and your antivirus sees nothing. A hidden payload is also *inert*, so
unlike malware there is no behavioural signal to observe. Nobody ships a detector for this.

## What the agent reaches, and where it stops

It reads mail, downloads attachments, and scores each for hidden data inside an isolated Daytona
sandbox. It stops at the first action that would change your mailbox. The Gmail credential is scoped
`gmail.readonly`, so the fetcher *cannot* label, move or delete mail even if instructed to — the
safety property lives in the token, not in prompt discipline. Quarantine is one thread label behind
TrueForge's approval gate, and the agent's instructions name `trash_thread` as off-limits even if a
human asks. It never decodes a payload; no such code path exists.

## Architecture

`fetch_gmail.py` (local, read-only) writes attachments content-addressed under SHA-256, so a file
re-sent twice triages once. `--sweep` hands those bytes to the agent as attachments. The git-backed
`steg-triage` skill loads on demand in the sandbox and runs `exiftool`, `binwalk`, `zsteg`,
`pngcheck` plus pure-Python fallbacks. Verdict is `clean` / `suspicious` /
`likely_steganographic`, the last needing two independent signals or an embedded-file hit. Missing
tools are named in `unavailable_tools`, so a degraded analysis never reads as a full one.

## How TrueForge was used

TrueForge supplies what is not worth rebuilding: isolated per-session sandboxes, git-backed skills,
MCP for Gmail, an approval gate rendering as an Approve/Edit/Reject card, schedules, and a Sessions
audit trail. Two gaps I had to fill: the harness runs one model per agent with no failover, so
`src/router.mjs` is a ~110-line OpenAI-compatible failover proxy; and it routes `image/*` as inline
vision input, so attachments go out as `application/octet-stream` to land real bytes on disk — a
vision round-trip would re-encode the exact bits under inspection.

## Real versus stubbed

Real: Gmail ingestion with live OAuth, real tools in a real sandbox, the harness primitives, the
scorer. Not wired: Slack (`SLACK_MCP_URL` unset). Bedrock authenticates but has no enabled model.
Test corpus is synthetic.

## Known limits

`steghide` cannot install (mcrypt is absent from Debian's index), so JPEG/BMP/WAV run without it. A
cold sandbox spends minutes installing tools. Only PNG bit planes 1–2 are scanned. Detection is
statistical — a deliberate spread-spectrum embedder beats it — and real-world false-positive rates
are unmeasured. 32 tests; 25 need no keys and no network.

MIT.
