'use strict'
/**
 * Regenerates payload/ and manifest.json for patch-asar.cjs.
 *
 * Three inputs are required because a local build never reproduces the official
 * bundle byte for byte: the CSS module class prefix is a content hash that
 * depends on the build environment. Building the same sources twice locally and
 * once on the release machine yields three different prefixes for the same
 * classes, so the patch bundle is aligned to the shipped bundle by remapping the
 * local prefix onto the shipped one, token by token, in first-appearance order.
 *
 *   --stock     app.asar of the installed release (the archive being patched)
 *   --baseline  directory holding the unpatched client.js of each bundle
 *   --patched   directory holding the patched client.js of each bundle
 *
 * Both directories name the files after their payload entry (ui-chat.client.js,
 * ui-conversation.client.js).
 *
 * Usage:
 *   node build-payload.cjs --stock <app.asar> --baseline <dir> --patched <dir>
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex')

const BLOCK_SIZE = 4 * 1024 * 1024
const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** Pairs the archive entry with its built counterpart and payload file name. */
const BUNDLES = [
  {
    entry: '/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js',
    descriptorPath: 'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js',
    payload: 'ui-chat.client.js',
  },
  {
    entry: '/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
    descriptorPath: 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
    payload: 'ui-conversation.client.js',
  },
]

// A CSS module class is emitted as "<hash>_<local>"; the hash is the unstable part.
const CSS_CLASS = /([A-Za-z0-9_-]{5,9})_([A-Za-z][A-Za-z0-9_-]*)/g

function log(message) { process.stdout.write(message + '\n') }
function fail(message) { process.stderr.write('error: ' + message + '\n'); process.exit(1) }

function parseArgs(argv) {
  const args = { stock: null, baseline: null, patched: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--stock') { args.stock = argv[i + 1]; i += 1 }
    else if (arg === '--baseline') { args.baseline = argv[i + 1]; i += 1 }
    else if (arg === '--patched') { args.patched = argv[i + 1]; i += 1 }
    else fail('unknown argument: ' + arg)
  }
  for (const key of ['stock', 'baseline', 'patched']) {
    if (!args[key]) fail('missing --' + key)
  }
  return args
}

/** Reads one entry out of an asar archive without unpacking it. */
function readArchiveEntry(file, target) {
  const buf = fs.readFileSync(file)
  const headerStringBytes = buf.readUInt32LE(12)
  const dataBase = 8 + buf.readUInt32LE(4)
  const header = JSON.parse(buf.subarray(16, 16 + headerStringBytes).toString('utf8'))
  let node = header
  for (const part of target.split('/').filter(Boolean)) {
    node = node.files?.[part]
    if (!node) fail('archive is missing ' + target)
  }
  const offset = dataBase + parseInt(node.offset, 10)
  return buf.subarray(offset, offset + node.size)
}

function readArchiveVersion(file) {
  return JSON.parse(readArchiveEntry(file, '/package.json').toString('utf8')).version
}

/**
 * Lists "<hash>_<local>" tokens in first-appearance order, requiring both sides
 * to name the same locals in the same order so the mapping is unambiguous.
 */
function classTokens(source) {
  const tokens = []
  for (const match of source.matchAll(CSS_CLASS)) tokens.push({ hash: match[1], local: match[2] })
  return tokens
}

/** Builds the local-hash to shipped-hash mapping by aligning the two token lists. */
function hashMapping(baseline, shipped) {
  const local = classTokens(baseline)
  const theirs = classTokens(shipped)
  if (local.length !== theirs.length) {
    fail('token count differs: baseline=' + local.length + ' shipped=' + theirs.length)
  }
  const mapping = new Map()
  for (let i = 0; i < local.length; i += 1) {
    if (local[i].local !== theirs[i].local) {
      fail('token ' + i + ' names different classes: ' + local[i].local + ' vs ' + theirs[i].local)
    }
    const previous = mapping.get(local[i].hash)
    if (previous !== undefined && previous !== theirs[i].hash) {
      fail('local hash ' + local[i].hash + ' maps to both ' + previous + ' and ' + theirs[i].hash)
    }
    mapping.set(local[i].hash, theirs[i].hash)
  }
  return mapping
}

function remap(source, mapping) {
  let replaced = 0
  const text = source.replace(CSS_CLASS, (whole, hash, local) => {
    const shipped = mapping.get(hash)
    if (shipped === undefined) return whole
    replaced += 1
    return shipped + '_' + local
  })
  return { text, replaced }
}

/** Rewrites the alignment check so a wrong mapping fails loudly instead of silently. */
function normalized(source) {
  return source.replace(CSS_CLASS, (whole, hash, local) => '*' + '_' + local)
}

function integrityOf(data) {
  const blocks = []
  for (let at = 0; at < data.length; at += BLOCK_SIZE) {
    blocks.push(sha256(data.subarray(at, Math.min(at + BLOCK_SIZE, data.length))))
  }
  if (blocks.length === 0) blocks.push(SHA256_EMPTY)
  return { algorithm: 'SHA256', hash: sha256(data), blockSize: BLOCK_SIZE, blocks }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const stock = path.resolve(args.stock)
  const release = readArchiveVersion(stock)
  log('release    : ' + release)

  const payloadDir = path.join(__dirname, 'payload')
  fs.mkdirSync(payloadDir, { recursive: true })

  const targets = []
  for (const bundle of BUNDLES) {
    const name = bundle.payload
    const shipped = readArchiveEntry(stock, bundle.entry).toString('utf8')
    const baseline = fs.readFileSync(path.join(path.resolve(args.baseline), name), 'utf8')
    const patched = fs.readFileSync(path.join(path.resolve(args.patched), name), 'utf8')

    // The baseline build must differ from the shipped bundle only in CSS hashes.
    if (normalized(baseline) !== normalized(shipped)) {
      fail(name + ': baseline build differs from the shipped bundle beyond CSS hashes')
    }
    const mapping = hashMapping(baseline, shipped)
    const aligned = remap(patched, mapping)
    log('aligned    : ' + name + ' (' + mapping.size + ' hashes, ' + aligned.replaced + ' uses)')

    const data = Buffer.from(aligned.text, 'utf8')
    const file = path.join(payloadDir, bundle.payload)
    fs.writeFileSync(file, data)

    targets.push({
      entry: bundle.entry,
      descriptorPath: bundle.descriptorPath,
      payload: bundle.payload,
      baselineSha: sha256(Buffer.from(shipped, 'utf8')),
      patchedSha: sha256(data),
    })
    log('payload    : ' + bundle.payload + ' (' + data.length + ' bytes, ' + sha256(data).slice(0, 16) + ')')
  }

  const manifest = {
    release,
    generatedFrom: 'dsh-v' + release + ' sources plus the patch commits',
    targets,
  }
  fs.writeFileSync(path.join(__dirname, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  log('manifest   : manifest.json')
}

main()
