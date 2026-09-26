#!/usr/bin/env python3
"""Stage Gmail attachments to disk so the sandbox skill can triage them.

Read-only by construction: the credential carries gmail.readonly, so this script
cannot label, move, or delete anything. Quarantine stays behind TrueForge's
approval gate.

MIME descent follows clearbill/gmail.py's _walk; the googleapiclient import is
deferred so the staging logic is testable without the library or a network.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import sys

DEFAULT_QUERY = "has:attachment newer_than:7d"
UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def walk(part, found=None):
    """Collect (filename, mimeType, attachmentId) from a MIME part tree, depth first."""
    found = [] if found is None else found
    body = part.get("body") or {}
    if part.get("filename") and body.get("attachmentId"):
        found.append((part["filename"], part.get("mimeType", ""), body["attachmentId"]))
    for sub in part.get("parts") or []:
        walk(sub, found)
    return found


def safe_name(filename):
    cleaned = UNSAFE.sub("_", os.path.basename(filename)).strip("._") or "attachment"
    return cleaned[:64]


def stage(entries, fetch, dest):
    """Write each attachment under its content hash. Returns one manifest record per entry.

    Duplicate bytes are recorded but not rewritten, so a re-run over the same inbox
    is a no-op and the same payload sent twice triages once.
    """
    os.makedirs(dest, exist_ok=True)
    records, seen = [], {}
    for filename, mime, attachment_id in entries:
        blob = fetch(attachment_id)
        digest = hashlib.sha256(blob).hexdigest()
        record = {
            "filename": filename,
            "mimeType": mime,
            "size": len(blob),
            "sha256": digest,
        }
        if digest in seen:
            record["path"] = seen[digest]
            record["duplicate"] = True
        else:
            path = os.path.join(dest, f"{digest[:16]}-{safe_name(filename)}")
            with open(path, "wb") as handle:
                handle.write(blob)
            seen[digest] = path
            record["path"] = path
        records.append(record)
    return records


SCOPE_HELP = (
    "gmail scope missing. Google blocks gcloud's own OAuth client for gmail.readonly,\n"
    "so log in with your own Desktop client secret instead:\n"
    "  gcloud auth application-default login \\\n"
    "    --client-id-file=$HOME/Downloads/client_secret_<your-project>.json \\\n"
    "    --scopes=https://www.googleapis.com/auth/gmail.readonly,"
    "https://www.googleapis.com/auth/cloud-platform\n"
    "Use $HOME, not ~ — gcloud does not expand a tilde in a flag value.\n"
    "On the consent screen choose Advanced > Go to <project> (unsafe) — a Desktop\n"
    "client you created yourself is safe; it only reads your mail."
)


def fail(message):
    print(f"fetch_gmail: {message}", file=sys.stderr)
    raise SystemExit(1)


def service():
    from googleapiclient.discovery import build

    return build("gmail", "v1", cache_discovery=False)


def fetch_gmail(query, max_results, dest, user="me"):
    svc = service()
    listing = svc.users().messages().list(userId=user, q=query, maxResults=max_results).execute(num_retries=2)
    messages, attachments = [], []
    for stub in listing.get("messages", []):
        msg = svc.users().messages().get(userId=user, id=stub["id"], format="full").execute(num_retries=2)
        payload = msg.get("payload", {})
        headers = {h["name"].lower(): h["value"] for h in payload.get("headers", [])}
        entries = walk(payload)
        if not entries:
            continue
        def download(attachment_id, _id=msg["id"]):
            got = svc.users().messages().attachments().get(
                userId=user, messageId=_id, id=attachment_id
            ).execute(num_retries=2)
            return base64.urlsafe_b64decode(got["data"])

        records = stage(entries, download, dest)
        messages.append({
            "id": msg["id"],
            "sender": headers.get("from", ""),
            "subject": headers.get("subject", ""),
            "date": headers.get("date", ""),
            "attachments": records,
        })
        attachments.extend(records)
    return {"query": query, "stageDir": dest, "messages": messages, "attachments": attachments}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--query", default=os.environ.get("GMAIL_QUERY", DEFAULT_QUERY))
    parser.add_argument("--max", type=int, default=int(os.environ.get("GMAIL_MAX_RESULTS", "25")))
    parser.add_argument("--dest", default=os.environ.get("STAGE_DIR", "data/staged"))
    args = parser.parse_args(argv)

    try:
        manifest = fetch_gmail(args.query, args.max, args.dest)
    except ImportError:
        fail("google-api-python-client is not installed: pip install google-api-python-client")
    except Exception as error:
        # A scope or credential problem is the expected failure here, and the fix is a
        # one-time browser consent. Report it as such instead of a library traceback.
        text = str(error)
        if "insufficient" in text and "scope" in text.lower():
            fail(SCOPE_HELP)
        if "invalid_grant" in text or "token" in text.lower() and "expired" in text.lower():
            fail("gmail credential expired or revoked. Re-run the gcloud login above.")
        fail(f"gmail fetch failed: {text.splitlines()[0][:200]}")
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
