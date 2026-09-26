---
name: steg-triage
description: Runs steganalysis tools against a file in the sandbox and returns a scored verdict.
---

# Steganography Triage

Score one file for hidden data. Report findings in plain language. Detection
only — never decode or extract payload contents.

## How to run

```bash
python3 /opt/tfy/skills/steg-triage/scripts/triage.py <file>
```

It prints one JSON object: `verdict`, `signals[]`, `tools{}`, `summary`.
Run it from the skill directory if the path differs. Give it 30-60s — every
tool inside gets a 15s timeout of its own.

## What it checks

| Tool | Looks for |
| --- | --- |
| `exiftool` | oversized or nonstandard metadata fields, base64-looking blobs |
| `binwalk` | embedded file signatures (a ZIP inside a JPEG, a second image) |
| `zsteg` (PNG/BMP) | LSB / bit-plane payloads |
| `steghide info -p ''` (JPEG/BMP/WAV) | recognized embedded structure |
| `pngcheck -v` (PNG) | structural / CRC validity |
| fallbacks | trailing data after EOF, embedded archive signature, LSB ASCII run, PNG chunk CRCs |

A tool failing to parse a file is itself a signal, not a fatal error. A tool
that is missing from the sandbox is reported as `not installed` and the
fallback checks still run.

## Verdicts

- `likely_steganographic` — an embedded-file hit alone, or 2+ independent signals.
- `suspicious` — exactly one signal.
- `clean` — no signals.

## Report like this

State the verdict, then which tools fired and why, one line each. Say "signals
consistent with" — never claim certainty, and never say a payload was found or
what it contains. For `suspicious` or `likely_steganographic`, propose a
human-approved next step (label, quarantine, ask the sender) and wait. Never
label, move, or delete a message yourself.
