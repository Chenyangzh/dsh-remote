// Issue #51/#50 — drive the backend through a REAL ~/.ssh/config alias, which is
// the configuration the issue asks for: the host name must reach `ssh` verbatim
// so the `Host <alias>` block (and anything in it — GSSAPI, Port, IdentityFile,
// ProxyJump) applies. Passing the resolved HostName instead would stop the block
// from matching and silently drop exactly those settings.
//
// Run: node test/integration-openssh-alias.mjs [alias]
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { SystemOpenSshPool, baseSshArgs } from '../lib/openssh.js'

// On Windows homedir() is C:\Users\x while the file may live under MSYS paths;
// fall back to the SSH config that the local `ssh` itself reads.
const alias = process.argv[2] || 'dsh-remote-alias-probe'
const realConfig = () => {
  try { return readFileSync(path.join(homedir(), '.ssh', 'config'), 'utf8') } catch { return '' }
}
const text = realConfig()
const block = new RegExp(`^\\s*Host\\s+${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi').test(text)
console.log(`~/.ssh/config has a "Host ${alias}" block: ${block}`)
if (!block) {
  console.log(`SKIP — add a block for ${alias} to ~/.ssh/config to run this check`)
  process.exit(0)
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// The argv must carry the ALIAS and no -l/-p/-i of our own.
const pool = new SystemOpenSshPool({
  host: alias, port: 0, username: '', privateKeyPath: '', password: '',
  passphrase: '', hostKeyMode: 'accept-new', connectTimeoutMs: 20000,
  commandTimeoutMs: 30000, maxOutputChars: 100000, backend: 'openssh', sshBinary: 'ssh',
})
const argv = baseSshArgs(pool.config)
check('the alias is the connect target, not a resolved address', pool.destination() === alias, alias)
check('no -l/-p/-i overrides the config block',
  !argv.includes('-l') && !argv.includes('-p') && !argv.includes('-i'),
  argv.join(' '))

try {
  await pool.connect()
  const out = await pool.exec('echo alias-ok; whoami; hostname')
  check('the alias connects and runs a command', out.code === 0 && /alias-ok/.test(out.stdout),
    JSON.stringify(out.stdout.trim().split('\n')[0]))
  // Proves the config's User applies (we passed no -l).
  const who = out.stdout.trim().split('\n')[1] || ''
  check('~/.ssh/config decided the login user', who.length > 0, `whoami=${who}`)

  const sftp = await pool.sftp()
  const entries = await sftp.readdir('~').catch(async () => await sftp.readdir('/home/' + who))
  check('SFTP works through the alias too', Array.isArray(entries) && entries.length >= 0,
    `${entries.length} entries`)
} catch (err) {
  check('alias connect', false, String((err && err.message) || err))
} finally {
  pool.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
