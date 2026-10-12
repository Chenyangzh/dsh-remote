// Stress the SFTP path through the system-OpenSSH backend with a LARGE transfer.
// This is the case a "replenish as we receive" heuristic would stall on: an
// upload consumes the send window, and the server's replies are tiny status
// packets, so the window can hit zero with nothing left to top it up.
import { SystemOpenSshPool } from '../lib/openssh.js'
import { createHash } from 'node:crypto'

const HOST = process.argv[2] || '9.134.186.191'
const MB = Number(process.argv[3] || 8)
const pool = new SystemOpenSshPool({
  host: HOST, port: 0, username: '', privateKeyPath: '', password: '', passphrase: '',
  hostKeyMode: 'accept-new', connectTimeoutMs: 20000, commandTimeoutMs: 120000,
  maxOutputChars: 100000, backend: 'openssh', sshBinary: 'ssh',
})
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16)

try {
  const sftp = await pool.sftp()
  const bytes = Buffer.alloc(MB * 1024 * 1024)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff
  const want = sha(bytes)
  const remote = `/tmp/dsh-remote-big-${Date.now()}.bin`

  const t0 = Date.now()
  await sftp.writeFile(remote, bytes)
  const upMs = Date.now() - t0

  const t1 = Date.now()
  const back = await sftp.readFile(remote)
  const downMs = Date.now() - t1

  const st = await sftp.stat(remote)
  await sftp.unlink(remote)

  console.log(`upload   ${MB}MB in ${upMs}ms (${(MB / (upMs / 1000)).toFixed(1)} MB/s)`)
  console.log(`download ${MB}MB in ${downMs}ms (${(MB / (downMs / 1000)).toFixed(1)} MB/s)`)
  console.log(`size on remote: ${st.size} (expected ${bytes.length})`)
  console.log(`sha match: ${sha(back) === want ? 'PASS' : 'FAIL'} (${sha(back)} vs ${want})`)
  const ok = st.size === bytes.length && sha(back) === want
  console.log(ok ? '\nLARGE TRANSFER OK' : '\nLARGE TRANSFER FAILED')
  process.exit(ok ? 0 : 1)
} catch (err) {
  console.log('FAILED:', String((err && err.stack) || err))
  process.exit(1)
} finally {
  pool.close()
}
