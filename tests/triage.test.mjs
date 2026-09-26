import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { appendArchive, encodePng, MARKER, writeFixtures } from '../src/seed.mjs'
import { basename } from 'node:path'

const TRIAGE = 'skills/steg-triage/scripts/triage.py'
const dir = mkdtempSync(join(tmpdir(), 'steg-'))

// The Gmail fetcher is Python, so its pure staging logic is driven from a small
// inline harness rather than duplicated in JS. No network, no credentials.
function python(source, ...args) {
  return execFileSync('python3', ['-c', source, ...args], { encoding: 'utf8', cwd: process.cwd() })
}

function score(manifest) {
  return manifest.attachments.map(record =>
    JSON.parse(execFileSync('python3', [TRIAGE, record.path], { encoding: 'utf8' })),
  )
}

const HARNESS = [
  'import json, sys',
  "sys.path.insert(0, 'skills/steg-triage/scripts')",
  'from fetch_gmail import walk, stage',
  'spec = json.load(open(sys.argv[1]))',
  'blobs = {k: bytes.fromhex(v) for k, v in spec["blobs"].items()}',
  'found = walk(spec["parts"])',
  'print(json.dumps({"walked": found, "staged": stage(found, lambda a: blobs[a], spec["dest"])}))',
].join('\n')

function fetch(parts, blobs, dest) {
  const spec = join(mkdtempSync(join(tmpdir(), 'steg-spec-')), 'spec.json')
  writeFileSync(spec, JSON.stringify({ parts, blobs, dest }))
  return JSON.parse(python(HARNESS, spec))
}

const hex = bytes => Buffer.from(bytes).toString('hex')

const mixedTree = {
  mimeType: 'multipart/mixed',
  parts: [
    { mimeType: 'text/plain', body: { data: 'aGk=' } },
    {
      mimeType: 'multipart/related',
      parts: [
        { mimeType: 'text/plain', body: { data: 'aGk=' } },
        { filename: 'clean.png', mimeType: 'image/png', body: { attachmentId: 'a1' } },
        { filename: 'notes.txt', mimeType: 'text/plain', body: { attachmentId: 'a2' } },
      ],
    },
  ],
}

test('MIME walk finds attachments nested at any depth', () => {
  const result = fetch(mixedTree, { a1: '00ff', a2: '6869' }, join(dir, 'm1'))

  assert.deepEqual(result.walked, [
    ['clean.png', 'image/png', 'a1'],
    ['notes.txt', 'text/plain', 'a2'],
  ])
})

test('a body-only part is not mistaken for an attachment', () => {
  const result = fetch({ mimeType: 'text/plain', body: { data: 'aGk=' } }, {}, join(dir, 'm2'))

  assert.deepEqual(result.walked, [])
  assert.deepEqual(result.staged, [])
})

test('identical bytes sent twice stage once and are marked duplicate', () => {
  const same = hex(encodePng({ width: 32, height: 32 }))
  const tree = {
    parts: [
      { filename: 'first.png', mimeType: 'image/png', body: { attachmentId: 'a1' } },
      { filename: 'renamed.png', mimeType: 'image/png', body: { attachmentId: 'a2' } },
    ],
  }
  const result = fetch(tree, { a1: same, a2: same }, join(dir, 'm3'))

  assert.equal(readdirSync(join(dir, 'm3')).length, 1)
  assert.equal(result.staged[0].duplicate, undefined)
  assert.equal(result.staged[1].duplicate, true)
  assert.equal(result.staged[1].path, result.staged[0].path)
})

test('staged bytes are intact and named under their hash', () => {
  const rigged = appendArchive(encodePng({ width: 96, height: 64 }))
  const tree = { parts: [{ filename: '../rigged.png', mimeType: 'image/png', body: { attachmentId: 'a1' } }] }
  const result = fetch(tree, { a1: hex(rigged) }, join(dir, 'm4'))

  const record = result.staged[0]
  assert.equal(readFileSync(record.path).length, rigged.length)
  assert.match(basename(record.path), /^[0-9a-f]{16}-rigged\.png$/)
  assert.equal(dirname(dirname(record.path)), dir)
})

test('a rigged attachment still scores likely_steganographic after staging', () => {
  const rigged = appendArchive(encodePng({ width: 96, height: 64 }))
  const clean = encodePng({ width: 96, height: 64 })
  const tree = {
    parts: [
      { filename: 'invoice.png', mimeType: 'image/png', body: { attachmentId: 'a1' } },
      { filename: 'holiday.png', mimeType: 'image/png', body: { attachmentId: 'a2' } },
    ],
  }
  const manifest = fetch(tree, { a1: hex(clean), a2: hex(rigged) }, join(dir, 'm5'))

  assert.deepEqual(
    score({ attachments: manifest.staged }).map(report => report.verdict),
    ['clean', 'likely_steganographic'],
  )
})

test('a path traversal in a filename cannot escape the staging dir', () => {
  const result = python(
    "import sys; sys.path.insert(0,'skills/steg-triage/scripts'); " +
      "from fetch_gmail import safe_name; print(safe_name('../../etc/passwd'))",
  )

  assert.equal(result.trim(), 'passwd')
})

// A full Gmail-shaped message tree, stubbed at the API boundary. This is the one place
// fetch, dedupe, and scoring meet, so it is the one worth exercising together.
const GMAIL_STUB = [
  'import base64, json, sys, zlib, struct',
  "sys.path.insert(0, 'skills/steg-triage/scripts')",
  'import fetch_gmail',
  'def png():',
  '    w = h = 64',
  '    raw = b""',
  '    for y in range(h):',
  '        row = bytearray()',
  '        for x in range(w):',
  '            row += bytes([(x * 4) % 256, (y * 4) % 256, 128])',
  '        raw += b"\\x00" + bytes(row)',
  '    def ch(t, d):',
  '        c = t + d',
  '        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c))',
  '    return (b"\\x89PNG\\r\\n\\x1a\\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))',
  '            + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b""))',
  'blobs = {"a1": png(), "a2": png() + b"PK\\x03\\x04" + b"\\x00" * 200}',
  'msgs = [',
  '    {"id": "msg1", "payload": {"headers": [',
  '        {"name": "From", "value": "sender@example.com"},',
  '        {"name": "Subject", "value": "quarterly report"}],',
  '     "mimeType": "multipart/mixed", "parts": [',
  '        {"mimeType": "text/plain", "body": {"data": "aGk="}},',
  '        {"filename": "invoice.png", "mimeType": "image/png", "body": {"attachmentId": "a1"}},',
  '        {"filename": "holiday.png", "mimeType": "image/png", "body": {"attachmentId": "a2"}}]}},',
  '    {"id": "msg2", "payload": {"headers": [',
  '        {"name": "From", "value": "other@example.com"},',
  '        {"name": "Subject", "value": "resend"}],',
  '     "parts": [',
  '        {"filename": "holiday.png", "mimeType": "image/png", "body": {"attachmentId": "a2"}}]}},',
  ']',
  'class Req:',
  '    def __init__(self, d): self.d = d',
  '    def execute(self, num_retries=None): return self.d',
  'class Attachments:',
  '    def get(self, userId=None, messageId=None, id=None):',
  '        return Req({"data": base64.urlsafe_b64encode(blobs[id]).decode()})',
  'class Messages:',
  '    def attachments(self): return Attachments()',
  '    def list(self, userId=None, q=None, maxResults=None):',
  '        return Req({"messages": [{"id": m["id"]} for m in msgs]})',
  '    def get(self, userId=None, id=None, format=None):',
  '        return Req(next(m for m in msgs if m["id"] == id))',
  'class Users:',
  '    def messages(self): return Messages()',
  'class Svc:',
  '    def users(self): return Users()',
  'fetch_gmail.service = lambda: Svc()',
  'print(json.dumps(fetch_gmail.fetch_gmail("stub", 25, sys.argv[1])))',
].join('\n')

test('a stubbed inbox stages, dedupes and scores end to end', () => {
  const dest = join(dir, 'gmail')
  const manifest = JSON.parse(python(GMAIL_STUB, dest))

  assert.deepEqual(manifest.messages.map(m => m.subject), ['quarterly report', 'resend'])
  assert.equal(manifest.messages[0].sender, 'sender@example.com')

  // The same bytes in two messages must resolve to one file on disk.
  assert.equal(manifest.messages[0].attachments[1].path, manifest.messages[1].attachments[0].path)
  assert.equal(readdirSync(dest).length, 2)

  // The manifest is flat across messages, so the same bytes appear twice; triage is
  // once per unique hash, which is what src/fetch.mjs does before scoring.
  const unique = new Map(manifest.attachments.map(a => [a.sha256, a]))
  assert.equal(unique.size, 2)

  const verdicts = score({ attachments: [...unique.values()] }).map(r => r.verdict)
  assert.deepEqual(verdicts, ['clean', 'likely_steganographic'])
})

// An empty tool dir plus a bare PATH is how the sandbox-with-no-tools case is reproduced,
// regardless of what happens to be installed on the developer's machine.
const emptyTools = mkdtempSync(join(tmpdir(), 'steg-notools-'))
const pythonBin = dirname(execFileSync('which', ['python3'], { encoding: 'utf8' }).trim())

function triage(name, bytes, { bare = false } = {}) {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  const out = execFileSync('python3', [TRIAGE, path], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: bare ? pythonBin : process.env.PATH,
      STEG_TOOL_DIRS: bare ? emptyTools : process.env.STEG_TOOL_DIRS,
      // A bare PATH is how the sandbox-with-no-tools case is reproduced; without this the
      // scorer would try to install the tools, which the test is specifically avoiding.
      STEG_NO_BOOTSTRAP: bare ? '1' : process.env.STEG_NO_BOOTSTRAP,
    },
  })
  return JSON.parse(out)
}

function signals(report) {
  return report.signals.map(signal => signal.name)
}

const looksBase64 = text => {
  const out = execFileSync(
    'python3',
    ['-c', "import sys; sys.path.insert(0,'skills/steg-triage/scripts'); from triage import looks_base64; print(looks_base64(sys.argv[1]))", text],
    { encoding: 'utf8' },
  )
  return out.trim() === 'True'
}

test('clean images score clean', () => {
  const report = triage('clean.png', encodePng({ width: 96, height: 64 }))

  assert.equal(report.verdict, 'clean')
  assert.deepEqual(signals(report), [])
})

test('LSB payload is flagged as a suspicious signal', () => {
  const report = triage('lsb.png', encodePng({ width: 96, height: 64, lsbText: MARKER }))

  assert.ok(signals(report).includes('lsb_ascii'), report.summary)
  assert.notEqual(report.verdict, 'clean')
})

test('embedded archive reaches likely_steganographic', () => {
  const report = triage('appended.png', appendArchive(encodePng({ width: 96, height: 64 })))

  assert.equal(report.verdict, 'likely_steganographic')
  assert.ok(signals(report).includes('embedded_signature'))
  assert.ok(signals(report).includes('trailing_data'))
})

test('seeded fixture set covers clean and rigged cases', () => {
  const names = writeFixtures(join(dir, 'fixtures'))
  assert.deepEqual(names, ['clean-invoice.png', 'clean-photo.png', 'lsb-rigged.png', 'appended-archive.png'])
})

test('missing tools degrade instead of failing', () => {
  const report = triage('clean2.png', encodePng({ width: 96, height: 64, offset: 12 }), { bare: true })

  assert.equal(report.verdict, 'clean')
  // Every tool that can read a PNG is simply absent; steghide is JPEG/BMP/WAV only, so it is
  // reported as not applicable rather than missing.
  for (const [name, output] of Object.entries(report.tools)) {
    const expected = name === 'steghide' ? 'not applicable to this format' : 'not installed'
    assert.equal(output, expected, name)
  }
  assert.equal(report.note, 'detection only — payload contents were not decoded')
  // The report has to name what it could not check, so a bare sandbox cannot silently pass
  // off a fallback-only analysis as a full one.
  assert.ok(report.unavailable_tools.includes('exiftool'))
  assert.ok(report.unavailable_tools.includes('zsteg'))
})

test('a tool that cannot read this format is not reported as missing', () => {
  const report = triage('invite.ics', Buffer.from('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'))

  assert.equal(report.kind, 'unknown')
  // pngcheck on a calendar file reports "not a PNG"; that is a type mismatch, not evidence,
  // and calling it a structural anomaly flagged every .ics in the inbox as suspicious.
  assert.equal(report.tools.pngcheck, 'not applicable to this format')
  assert.equal(report.tools.zsteg, 'not applicable to this format')
  assert.equal(report.verdict, 'clean')
  assert.deepEqual(report.signals, [])
})

test('a JPEG gets steghide but not pngcheck', () => {
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(64),
    Buffer.from([0xff, 0xd9]),
  ])
  const report = triage('photo.jpg', jpeg)

  assert.equal(report.kind, 'jpeg')
  assert.equal(report.tools.steghide, 'not installed')
  assert.equal(report.tools.pngcheck, 'not applicable to this format')
})

// Every case below was a false positive against a real Gmail inbox, where a quarter of
// the attachments were calendar invites, docx reports and PDF tickets.
const zipMembers = [
  Buffer.from('PK\x03\x04', 'latin1'),
  Buffer.alloc(200, 0x41),
  Buffer.from([0xff, 0xd9, 0xff, 0xd8]),
].join('')

test('a docx is a zip by construction, not a hidden payload', () => {
  const report = triage('report.docx', Buffer.from(zipMembers, 'latin1'))

  assert.equal(report.kind, 'archive')
  assert.equal(report.verdict, 'clean')
  assert.deepEqual(report.signals, [])
})

test('whitespace padding after %%EOF is not a PDF payload', () => {
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'latin1'),
    Buffer.alloc(64, 0x20),
  ])
  const report = triage('ticket.pdf', pdf)

  assert.equal(report.kind, 'pdf')
  assert.equal(report.verdict, 'clean')
})

test('a calendar Description with meeting URLs is not a metadata blob', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'DESCRIPTION:Topic: Build With AI: Basics - Live Build Session.Join Joe Holmes for a',
    ' live start to finish build session at https://meet.google.com/abc-defg-hij for details',
    'END:VCALENDAR',
  ].join('\r\n')
  const report = triage('invite.ics', Buffer.from(ics))

  assert.equal(report.kind, 'unknown')
  assert.equal(report.verdict, 'clean')
  assert.deepEqual(report.signals, [])
})

test('a real base64 blob in a PNG comment is still caught', () => {
  const blob = Buffer.from('aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldCBwYXlsb2Fk').toString('base64')
  assert.equal(looksBase64(blob), true)
  assert.equal(looksBase64('Topic: Build With AI: Basics - Live Build Session at a meeting'), false)
  assert.equal(looksBase64('short'), false)
})

test('a rigged file is still caught with no external tools installed', () => {
  const report = triage('rigged-bare.png', encodePng({ width: 96, height: 64, lsbText: MARKER }), { bare: true })

  assert.ok(signals(report).includes('lsb_ascii'), report.summary)
})
