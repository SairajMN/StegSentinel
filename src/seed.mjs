import './load-env.mjs'
import { crc32, deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([length, body, checksum])
}

function pixels(width, height, offset) {
  const rgb = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3
      rgb[i] = (x + offset) % 256
      rgb[i + 1] = (y * 3 + offset) % 256
      rgb[i + 2] = (x + y + offset) % 256
    }
  }
  return rgb
}

function scanlines(width, height, rgb) {
  const rowBytes = width * 3
  const raw = Buffer.alloc(height * (rowBytes + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (rowBytes + 1)] = 0
    rgb.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes)
  }
  return raw
}

export function encodePng({ width, height, offset = 0, lsbText }) {
  let raw = scanlines(width, height, pixels(width, height, offset))
  if (lsbText !== undefined) {
    raw = embedLsb(raw, lsbText)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export function embedLsb(raw, text) {
  const out = Buffer.from(raw)
  const bits = [...Buffer.from(text, 'utf8')].flatMap(byte =>
    [7, 6, 5, 4, 3, 2, 1, 0].map(shift => (byte >> shift) & 1),
  )
  bits.forEach((bit, index) => {
    out[index] = (out[index] & 0xfe) | bit
  })
  return out
}

export function appendArchive(png) {
  const localHeader = Buffer.concat([
    Buffer.from('PK\x03\x04', 'binary'),
    Buffer.from([20, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from('payload.txt', 'utf8'),
  ])
  const endOfCentralDirectory = Buffer.concat([Buffer.from('PK\x05\x06', 'binary'), Buffer.alloc(18)])
  return Buffer.concat([png, localHeader, endOfCentralDirectory])
}

export const MARKER = 'STEGSENTINEL-TEST-PAYLOAD-7f3a'

export function writeFixtures(dir) {
  mkdirSync(dir, { recursive: true })
  const clean = encodePng({ width: 96, height: 64 })
  const fixtures = {
    'clean-invoice.png': clean,
    'clean-photo.png': encodePng({ width: 96, height: 64, offset: 40 }),
    'lsb-rigged.png': encodePng({ width: 96, height: 64, lsbText: MARKER }),
    'appended-archive.png': appendArchive(encodePng({ width: 96, height: 64, offset: 80 })),
  }
  for (const [name, bytes] of Object.entries(fixtures)) {
    writeFileSync(join(dir, name), bytes)
  }
  return Object.keys(fixtures)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? 'fixtures'
  const names = writeFixtures(dir)
  console.log(`wrote ${names.length} fixtures to ${dir}/`)
  for (const name of names) {
    console.log(`  ${name}`)
  }
}
