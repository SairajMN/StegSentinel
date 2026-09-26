import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { appendArchive, encodePng, MARKER, writeFixtures } from '../src/seed.mjs'

const TRIAGE = 'skills/steg-triage/scripts/triage.py'
const dir = mkdtempSync(join(tmpdir(), 'steg-'))

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
    },
  })
  return JSON.parse(out)
}

function signals(report) {
  return report.signals.map(signal => signal.name)
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
  for (const output of Object.values(report.tools)) {
    assert.equal(output, 'not installed')
  }
  assert.equal(report.note, 'detection only — payload contents were not decoded')
})

test('a rigged file is still caught with no external tools installed', () => {
  const report = triage('rigged-bare.png', encodePng({ width: 96, height: 64, lsbText: MARKER }), { bare: true })

  assert.ok(signals(report).includes('lsb_ascii'), report.summary)
})
