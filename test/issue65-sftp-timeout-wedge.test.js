// Issue #65 — a single timed-out SFTP operation must not wedge the pool.
//
// Observed on a real machine: one `rw_edit` hit commandTimeoutMs, and from then
// on EVERY SFTP call on that host (list_dir / read_file / download) paid the
// full 20 s and failed, while `rw_exec` stayed fast on the same connection, and
// a brand-new session failed on its very first listing. Reconnecting was the
// only cure, because the bad state lived in the plugin's process-wide pool.
//
// Two rules are pinned here:
//   • a timed-out surface is poisoned: it reports `onTimeout` once and every
//     later request on it fails fast (no second timeout);
//   • both backends drop the transport on that callback (native: client
//     invalidated; openssh: cached child killed + cache cleared), so the next
//     call re-handshakes instead of reusing the wedged channel.
//
// An ordinary error (ENOENT etc.) is NOT a timeout and must leave the surface
// usable — over-firing this callback would turn one missing file into a
// reconnect storm.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { buildSftpSurface } from '../lib/sftp-surface.js'
import { SshPool } from '../lib/pool.js'
import { SystemOpenSshPool } from '../lib/openssh.js'

const TIMEOUT = 40

const baseConfig = (over = {}) => ({
  host: 'example.internal',
  port: 22,
  username: 'root',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  workspace: '',
  useAgent: false,
  keyboardInteractive: false,
  hostKeyMode: 'accept-new',
  connectTimeoutMs: 15000,
  commandTimeoutMs: TIMEOUT,
  maxOutputChars: 200000,
  backend: 'native',
  ...over,
})

/** A channel whose requests are simply never answered (the wedged peer). */
const silentChannel = () => {
  const ch = new EventEmitter()
  ch.stat = () => {}
  ch.readdir = () => {}
  ch.readFile = () => {}
  ch.end = () => { ch.ended = true }
  return ch
}

const elapsed = async (p) => {
  const t0 = Date.now()
  await p
  return Date.now() - t0
}

// ── the surface ─────────────────────────────────────────────────────────────

test('#65: a timed-out surface reports once, then fails fast', async () => {
  const ch = silentChannel()
  let dropped = 0
  const surface = buildSftpSurface(ch, { commandTimeoutMs: TIMEOUT, onTimeout: () => { dropped++ } })

  await assert.rejects(() => surface.stat('/x'), /sftp operation timed out/)
  assert.equal(dropped, 1, 'owner must be told to drop the channel')

  // Same surface: the transport is gone, so nothing may queue behind the
  // request nobody will answer. Fast-fail, and do not report twice.
  const ms = await elapsed(assert.rejects(() => surface.stat('/x'), /sftp channel closed/))
  assert.ok(ms < TIMEOUT, `expected a fast failure, took ${ms}ms`)
  assert.equal(dropped, 1)
})

test('#65: a throwing onTimeout still surfaces the timeout', async () => {
  const ch = silentChannel()
  const surface = buildSftpSurface(ch, {
    commandTimeoutMs: TIMEOUT,
    onTimeout: () => { throw new Error('teardown boom') },
  })
  await assert.rejects(() => surface.stat('/x'), /sftp operation timed out/)
  await assert.rejects(() => surface.stat('/x'), /sftp channel closed/)
})

test('#65: an ordinary error does not poison the surface', async () => {
  const ch = new EventEmitter()
  let calls = 0
  ch.stat = (p, cb) => {
    if (++calls === 1) return cb(new Error('No such file'))
    cb(null, { size: 1, isDirectory: () => false, isSymbolicLink: () => false })
  }
  let dropped = 0
  const surface = buildSftpSurface(ch, { commandTimeoutMs: TIMEOUT, onTimeout: () => { dropped++ } })

  await assert.rejects(() => surface.stat('/missing'), /No such file/)
  assert.equal(dropped, 0, 'a failed lookup is not a wedged channel')
  const st = await surface.stat('/present')
  assert.equal(st.size, 1)
})

// ── the backends ────────────────────────────────────────────────────────────

test('#65: native pool drops the client after a timeout', async () => {
  const pool = new SshPool(baseConfig(), {})
  const ch = silentChannel()
  let clientEnded = 0
  const client = {
    sftp: (cb) => cb(null, ch),
    end: () => { clientEnded++ },
  }
  pool.connect = () => {
    pool.client = client
    return Promise.resolve(client)
  }

  const surface = await pool.sftp()
  await assert.rejects(() => surface.stat('/x'), /sftp operation timed out/)

  assert.equal(ch.ended, true, 'the wedged subchannel must be closed')
  assert.equal(clientEnded, 1, 'the pooled connection must be dropped')
  assert.equal(pool.client, null)
})

test('#65: openssh pool drops the cached session after a timeout', async () => {
  const pool = new SystemOpenSshPool(baseConfig({ backend: 'openssh' }), {})
  const ch = silentChannel()
  const child = new EventEmitter()
  let killed = 0
  child.kill = () => { killed++ }
  pool._openSftpChannel = async () => ({ child, sftp: ch })

  const surface = await pool.sftp()
  assert.ok(pool._sftpSession, 'the session is cached for the picker/explorer')
  await assert.rejects(() => surface.stat('/x'), /sftp operation timed out/)

  assert.equal(killed, 1, 'the wedged `ssh -s sftp` child must be killed')
  assert.equal(pool._sftpSession, null, 'the next call must re-handshake')
  assert.equal(pool._sftpChild, null)
})
