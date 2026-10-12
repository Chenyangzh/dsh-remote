// Issue #50 — demonstrate, rather than assert, WHERE ~/.ssh/config is honoured.
//
// The probe alias has:
//     Host dsh-p50-proxyprobe
//         HostName dsh-p50-does-not-resolve.invalid   ← cannot be dialled directly
//         ProxyCommand ssh … -W 127.0.0.1:36000 9.134.186.191
//
// So whether ProxyCommand is honoured is OBSERVABLE:
//   • honouring it → the connection succeeds (the proxy reaches the real host);
//   • ignoring it  → ssh dials the bogus HostName and DNS fails.
//
// The native backend resolves HostName itself and cannot run ProxyCommand at
// all; the system-OpenSSH backend hands the alias to ssh, which honours it.
import { SystemOpenSshPool, sshBinaryAvailable } from '../lib/openssh.js'
import { SshPool } from '../lib/pool.js'
import { resolveSshAlias } from '../lib/sshconfig.js'

const ALIAS = 'dsh-p50-proxyprobe'
const resolved = resolveSshAlias(ALIAS)
console.log(`alias "${ALIAS}" resolves to:`, {
  hostName: resolved.hostName,
  user: resolved.user,
  port: resolved.port,
  proxyCommand: resolved.proxyCommand || '(none)',
})

if (!resolved.matched) {
  console.log(`SKIP — add the ${ALIAS} block to ~/.ssh/config to run this probe`)
  process.exit(0)
}

const common = {
  host: ALIAS,
  password: '',
  privateKeyPath: '',
  passphrase: '',
  hostKeyMode: 'off', // the probe HostName is unresolvable, so prove auth not host-key
  connectTimeoutMs: 20000,
  commandTimeoutMs: 30000,
  maxOutputChars: 100000,
}

const attempt = async (label, pool) => {
  try {
    await pool.connect()
    const r = await pool.exec('echo honour-ok; uname -s')
    const ok = r.code === 0 && /honour-ok/.test(r.stdout)
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(String(r.stdout || r.stderr).trim().slice(0, 120))}`)
    return ok
  } catch (err) {
    console.log(`FAIL  ${label}: ${String((err && err.message) || err).slice(0, 160)}`)
    return false
  } finally {
    try { pool.close() } catch {}
  }
}

console.log('\n-- native backend (resolves HostName itself; ProxyCommand unsupported) --')
const nativeOk = await attempt('native', new SshPool({
  ...common,
  // The native path needs concrete values; mimic what withSshConfig() produces.
  host: resolved.hostName || ALIAS,
  port: resolved.port || 22,
  username: resolved.user || 'root',
  // The native path CAN use IdentityFile; only ProxyCommand is out of reach.
  privateKeyPath: resolved.identityFile || '',
  backend: 'native',
}))

console.log('\n-- system-OpenSSH backend (hands the alias to ssh) --')
const opensshOk = await attempt('openssh', new SystemOpenSshPool({
  ...common,
  host: ALIAS,
  port: 0,
  username: '',
  backend: 'openssh',
  sshBinary: 'ssh',
}))

console.log('')
console.log(`native honoured ProxyCommand: ${nativeOk}`)
console.log(`openssh honoured ProxyCommand: ${opensshOk}`)
const discriminating = !nativeOk && opensshOk
console.log(discriminating
  ? '\nDISCRIMINATING RESULTS — the backend choice, not luck, decided whether ~/.ssh/config was honoured.'
  : '\nNOTE: results are not discriminating here (check the alias block is set up as documented).')
process.exit(discriminating ? 0 : 1)
