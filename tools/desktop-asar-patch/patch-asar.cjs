'use strict'
/**
 * Injects prebuilt client bundles into an installed DeepSeek Harness desktop
 * app by rewriting entries inside resources/app.asar.
 *
 * Targets come from manifest.json beside this script, so re-targeting a new
 * release is a data change rather than a code change.
 *
 * Usage (target machine):
 *   node patch-asar.cjs [--app <install dir>] [--dry-run] [--force] [--restore]
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// The script runs under the app's own Electron binary, whose patched fs treats
// any *.asar path as an archive and refuses to read it as a plain file.
process.noAsar = true

const BLOCK_SIZE = 4 * 1024 * 1024
const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const DESCRIPTOR_ENTRY = '/dsh/desktop-runtime.json'

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex')

function log(message) { process.stdout.write(message + '\n') }
function fail(message) { process.stderr.write('error: ' + message + '\n'); process.exit(1) }

/** Reads and validates the target list this build patches. */
function loadManifest() {
  const file = path.join(__dirname, 'manifest.json')
  if (!fs.existsSync(file)) fail('missing manifest.json beside ' + __filename)
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (typeof manifest.release !== 'string' || !Array.isArray(manifest.targets) || manifest.targets.length === 0) {
    fail('manifest.json needs a release string and a non-empty targets array')
  }
  for (const target of manifest.targets) {
    for (const key of ['entry', 'descriptorPath', 'payload', 'baselineSha', 'patchedSha']) {
      if (typeof target[key] !== 'string') fail('manifest target is missing ' + key)
    }
  }
  if (!fs.existsSync(path.join(__dirname, 'payload'))) {
    fail('missing payload/; run build-payload.cjs to generate it for this release')
  }
  return manifest
}

function parseArgs(argv) {
  const args = { app: null, dryRun: false, force: false, restore: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--app') { args.app = argv[i + 1]; i += 1 }
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--force') args.force = true
    else if (arg === '--restore') args.restore = true
    else fail('unknown argument: ' + arg)
  }
  return args
}

/** Locates an installed desktop app by looking for resources/app.asar. */
function locateApp(explicit) {
  const candidates = []
  if (explicit) candidates.push(path.resolve(explicit))
  else {
    candidates.push('D:/deepseek-harness', 'C:/Program Files/DeepSeek Harness',
      path.join(process.env.LOCALAPPDATA || '', 'Programs/DeepSeek Harness'))
  }
  for (const dir of candidates) {
    const asar = path.join(dir, 'resources', 'app.asar')
    if (fs.existsSync(asar)) return { root: dir, asar }
  }
  return fail('could not find an installed app; pass --app <install dir>')
}

/** Reads the archive header and returns its parsed tree plus byte layout. */
function readArchive(file) {
  const buf = fs.readFileSync(file)
  const headerStringBytes = buf.readUInt32LE(12)
  const headerPickleBytes = buf.readUInt32LE(4)
  const dataBase = 8 + headerPickleBytes
  const header = JSON.parse(buf.subarray(16, 16 + headerStringBytes).toString('utf8'))
  return { buf, header, dataBase }
}

/** Walks the archive tree into a flat list of { path, node } in data order. */
function flatten(header) {
  const out = []
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files)) {
      const full = prefix + '/' + name
      if (child.files) walk(child, full)
      else out.push({ path: full, node: child })
    }
  }
  walk(header, '')
  return out
}

function findEntry(entries, target) {
  return entries.find(entry => entry.path === target) || null
}

function readEntry(buf, dataBase, node) {
  const offset = dataBase + parseInt(node.offset, 10)
  return buf.subarray(offset, offset + node.size)
}

/** Recomputes the integrity descriptor the archive records for one file. */
function integrityOf(data) {
  const blocks = []
  for (let at = 0; at < data.length; at += BLOCK_SIZE) {
    blocks.push(sha256(data.subarray(at, Math.min(at + BLOCK_SIZE, data.length))))
  }
  if (blocks.length === 0) blocks.push(SHA256_EMPTY)
  return { algorithm: 'SHA256', hash: sha256(data), blockSize: BLOCK_SIZE, blocks }
}

/** Serializes the header tree into the archive's size-prefixed pickle form. */
function encodeHeader(header) {
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const payloadSize = Math.ceil((4 + json.length) / 4) * 4
  const pickle = Buffer.alloc(4 + payloadSize)
  pickle.writeUInt32LE(payloadSize, 0)
  pickle.writeUInt32LE(json.length, 4)
  json.copy(pickle, 8)
  const prefix = Buffer.alloc(8)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(pickle.length, 4)
  return { prefix, pickle }
}

/**
 * Overwrites the archive in place. A running app holds the file open, so a
 * rename cannot replace it; writing through the same handle works.
 */
function writeInPlace(file, data) {
  const fd = fs.openSync(file, 'r+')
  try {
    fs.writeSync(fd, data, 0, data.length, 0)
    fs.ftruncateSync(fd, data.length)
  } finally { fs.closeSync(fd) }
}

/** Re-reads the archive and checks every entry against its recorded integrity. */
function verify(file, manifest) {
  const { buf, header, dataBase } = readArchive(file)
  const entries = flatten(header)
  let bad = 0
  for (const entry of entries) {
    if (entry.node.unpacked) continue
    const data = readEntry(buf, dataBase, entry.node)
    if (integrityOf(data).hash !== entry.node.integrity.hash) bad += 1
  }
  const end = entries.reduce((max, entry) => entry.node.unpacked ? max : Math.max(max, dataBase + parseInt(entry.node.offset, 10) + entry.node.size), 0)
  log('verify     : entries ' + entries.length + ', integrity failures ' + bad + ', aligned ' + (end === buf.length))
  if (bad !== 0 || end !== buf.length) fail('verification failed')
  for (const target of manifest.targets) {
    const found = findEntry(entries, target.entry)
    log('patch mark : ' + path.basename(path.dirname(path.dirname(target.entry))) + ' ' + sha256(readEntry(buf, dataBase, found.node)).slice(0, 16))
  }
}

function main() {
  const manifest = loadManifest()
  const args = parseArgs(process.argv.slice(2))
  const app = locateApp(args.app)
  const backup = app.asar + '.pre-patch'
  log('app        : ' + app.root)
  log('app.asar   : ' + app.asar)

  if (args.restore) {
    if (!fs.existsSync(backup)) fail('no backup at ' + backup)
    writeInPlace(app.asar, fs.readFileSync(backup))
    log('restored from ' + backup)
    return
  }

  const { buf, header, dataBase } = readArchive(app.asar)
  const entries = flatten(header)

  const rootPkg = findEntry(entries, '/package.json')
  const rootVersion = JSON.parse(readEntry(buf, dataBase, rootPkg.node).toString('utf8')).version
  log('release    : ' + rootVersion + ' (patch targets ' + manifest.release + ')')
  if (rootVersion !== manifest.release && !args.force) {
    fail('this patch targets ' + manifest.release + ', found ' + rootVersion + ' (pass --force to override)')
  }

  // Classify each target so a re-run is a no-op rather than a double patch.
  const replacements = new Map()
  let alreadyPatched = 0
  for (const target of manifest.targets) {
    const found = findEntry(entries, target.entry)
    if (!found) fail('archive is missing ' + target.entry)
    const current = sha256(readEntry(buf, dataBase, found.node))
    const payload = fs.readFileSync(path.join(__dirname, 'payload', target.payload))
    if (sha256(payload) !== target.patchedSha) fail('payload checksum mismatch: ' + target.payload)
    if (current === target.patchedSha) { alreadyPatched += 1; log('already patched: ' + target.payload); continue }
    if (current !== target.baselineSha && !args.force) {
      fail('unexpected bundle content in ' + target.entry + ' (sha256 ' + current + '); this is not a stock ' + manifest.release + ' build. Pass --force to override.')
    }
    replacements.set(target.entry, payload)
    log('to patch   : ' + target.payload + ' (' + found.node.size + ' -> ' + payload.length + ' bytes)')
  }
  if (replacements.size === 0) { log('nothing to do: already patched'); return }

  // Rebuild the data region, keeping unpacked entries out of it.
  const packed = entries.filter(entry => !entry.node.unpacked)
  const chunks = []
  let offset = 0
  for (const entry of packed) {
    const data = replacements.get(entry.path) || readEntry(buf, dataBase, entry.node)
    entry.node.size = data.length
    entry.node.offset = String(offset)
    entry.node.integrity = integrityOf(data)
    chunks.push(data)
    offset += data.length
  }

  // Keep the runtime manifest honest about what the archive now contains.
  const descriptorEntry = findEntry(entries, DESCRIPTOR_ENTRY)
  if (descriptorEntry && !descriptorEntry.node.unpacked) {
    const index = packed.indexOf(descriptorEntry)
    const descriptor = JSON.parse(chunks[index].toString('utf8'))
    let touched = 0
    for (const target of manifest.targets) {
      const data = replacements.get(target.entry)
      if (!data) continue
      const record = descriptor.files.find(file => file.path === target.descriptorPath)
      if (!record) continue
      record.bytes = data.length
      record.sha256 = sha256(data)
      touched += 1
    }
    if (touched > 0) {
      chunks[index] = Buffer.from(JSON.stringify(descriptor, null, 2) + '\n', 'utf8')
      descriptorEntry.node.size = chunks[index].length
      descriptorEntry.node.integrity = integrityOf(chunks[index])
      // The descriptor may sit before later entries, so re-lay offsets after resizing it.
      let shifted = 0
      for (const entry of packed) {
        entry.node.offset = String(shifted)
        shifted += entry.node.size
      }
      log('descriptor : updated ' + touched + ' record(s)')
    }
  }

  const { prefix, pickle } = encodeHeader(header)
  const output = Buffer.concat([prefix, pickle, Buffer.alloc((4 - (pickle.length % 4)) % 4), ...chunks])

  if (args.dryRun) { log('dry run    : would write ' + output.length + ' bytes'); return }

  if (!fs.existsSync(backup)) {
    fs.copyFileSync(app.asar, backup)
    log('backup     : ' + backup)
  } else log('backup     : keeping existing ' + backup)
  writeInPlace(app.asar, output)
  log('written    : ' + app.asar + ' (' + output.length + ' bytes)')

  verify(app.asar, manifest)
}

main()
