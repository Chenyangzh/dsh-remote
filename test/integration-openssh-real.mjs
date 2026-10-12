// Real-host end-to-end for issue #51 — drives SystemOpenSshPool against the
// actual build machine (9.134.186.191:36000, reached via the ~/.ssh/config alias
// we also exercise). This is the only check that proves the backend works, as
// opposed to merely looking right: it runs the real `ssh`, the real SFTP stream
// and the real ssh2 SFTP engine over stdio.
//
// Run: node test/integration-openssh-real.mjs [hostAlias]
import { SystemOpenSshPool } from '../lib/openssh.js'

const HOST = process.argv[2] || '9.134.186.191'
const config = {
  host: HOST,
  port: 0,          // 0 → no -p, so ~/.ssh/config supplies the port
  username: '',     // '' → no -l, so ~/.ssh/config supplies the user
  password: '',
  privateKeyPath: '',
  passphrase: '',
  workspace: '',
  useAgent: false,
  keyboardInteractive: false,
  hostKeyMode: 'accept-new',
  connectTimeoutMs: 20000,
  commandTimeoutMs: 30000,
  maxOutputChars: 200000,
  backend: 'openssh',
  sshBinary: 'ssh',
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const pool = new SystemOpenSshPool(config)
try {
  // 1) connect() — proves the alias reaches ssh and the target answers.
  const t0 = Date.now()
  await pool.connect()
  check('connect() through the system ssh', true, `${Date.now() - t0}ms`)

  // 2) exec — the whole point of the backend.
  const hello = await pool.exec('echo openssh-backend-ok; uname -s')
  check('exec() runs a remote command', hello.code === 0 && /openssh-backend-ok/.test(hello.stdout),
    JSON.stringify({ code: hello.code, out: hello.stdout.trim() }))

  // 3) exit code + stderr propagation (callers rely on both).
  const bad = await pool.exec('echo to-stderr 1>&2; exit 7')
  check('exec() reports the remote exit code and stderr', bad.code === 7 && /to-stderr/.test(bad.stderr),
    JSON.stringify({ code: bad.code, err: bad.stderr.trim() }))

  // 4) detect() must classify the POSIX remote correctly.
  await pool.detect()
  check('detect() sees a posix remote', pool.platform === 'posix', `platform=${pool.platform}`)

  // 5) SFTP over the raw `ssh -s ... sftp` stream, driven by ssh2's engine.
  const sftp = await pool.sftp()
  const entries = await sftp.readdir('/home/jimmycppliu')
  check('sftp().readdir() lists a real directory', Array.isArray(entries) && entries.length > 0,
    `${entries.length} entries`)

  const st = await sftp.stat('/home/jimmycppliu')
  check('sftp().stat() reports a directory', st.isDirectory() === true, `mode=${st.mode.toString(8)}`)

  // 6) A real file read (content-level proof the protocol engine is wired right).
  const readme = await sftp.readFile('/home/jimmycppliu/QQMail/BUILD').catch((e) => null)
  check('sftp().readFile() reads real content', !!readme && readme.length > 0,
    readme ? `${readme.length} bytes` : 'not found')

  // 7) The SFTP session is PERSISTENT: a second operation must not re-handshake.
  const t1 = Date.now()
  await sftp.readdir('/home/jimmycppliu')
  check('sftp() reuses the session (no re-handshake)', Date.now() - t1 < 1500, `${Date.now() - t1}ms`)

  // 8) write + read back + cleanup, using the real filesystem.
  const tmp = `/tmp/dsh-remote-openssh-probe-${Date.now()}.txt`
  await sftp.writeFile(tmp, Buffer.from('backend-roundtrip'))
  const back = await sftp.readFile(tmp)
  await sftp.unlink(tmp)
  check('sftp() write/read/unlink round-trips', back.toString() === 'backend-roundtrip',
    JSON.stringify(back.toString()))

  // 9) readPartial must bound the transfer (oversized previews depend on it).
  const part = await sftp.readPartial('/home/jimmycppliu/QQMail/BUILD', 0, 16).catch(() => Buffer.alloc(0))
  check('sftp().readPartial() returns only the requested range', part.length === 16,
    `${part.length} bytes`)

  // 10) forwardOut over `ssh -W`: carry a local socket to the remote sshd.
  const conn = await pool.connect()
  const banner = await new Promise((resolve) => {
    conn.forwardOut('127.0.0.1', 0, '127.0.0.1', 36000, (err, channel) => {
      if (err) return resolve('ERR:' + err.message)
      let out = ''
      channel.on('data', (d) => { out += d })
      setTimeout(() => { try { channel.close() } catch {} ; resolve(out) }, 2500)
    })
  })
  check('forwardOut() tunnels through `ssh -W`', /^SSH-2\.0-/.test(banner), JSON.stringify(banner.slice(0, 40)))

  // 11) A failure must surface as an error, never a hang (a bad port).
  const refused = await new Promise((resolve) => {
    conn.forwardOut('127.0.0.1', 0, '127.0.0.1', 1, (err, channel) => {
      if (err) return resolve('ERR:' + err.message)
      channel.on('close', () => resolve('CLOSED'))
      setTimeout(() => resolve('TIMEOUT-hang'), 6000)
    })
  })
  check('forwardOut() surfaces a refusal instead of hanging', refused !== 'TIMEOUT-hang', refused.slice(0, 80))

  // 12) A bad host must fail fast with the ssh diagnostic, not a generic timeout.
  const badPool = new SystemOpenSshPool({ ...config, host: 'no-such-host-dsh-remote.invalid' })
  const t2 = Date.now()
  let badErr = ''
  try { await badPool.connect() } catch (e) { badErr = String(e.message || e) }
  badPool.close()
  check('an unresolvable host fails with the ssh message', /ssh failed|Could not resolve|nodename/i.test(badErr),
    `${Date.now() - t2}ms ${badErr.slice(0, 90)}`)

  // 13) A command timeout must be reported (callers branch on signal=TIMEOUT).
  const slow = await pool.exec('sleep 20', { timeoutMs: 1500 })
  check('exec() enforces its timeout', slow.signal === 'TIMEOUT', `signal=${slow.signal}`)

  // 14) Cancellation (issue #44) reaches the remote process.
  const ac = new AbortController()
  const cancelled = pool.exec('sleep 20', { timeoutMs: 30000, signal: ac.signal })
  setTimeout(() => ac.abort(), 400)
  const cRes = await cancelled
  check('exec() honours AbortSignal', cRes.signal === 'ABORTED', `signal=${cRes.signal}`)
} catch (err) {
  check('unexpected failure', false, String((err && err.stack) || err))
} finally {
  pool.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
