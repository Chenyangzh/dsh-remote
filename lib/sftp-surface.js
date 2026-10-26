// dsh-remote — the promisified SFTP surface every backend presents.
//
// Both SSH transports (the native ssh2 pool in lib/pool.js and the
// system-OpenSSH pool in lib/openssh.js) must expose the SAME object to
// callers: lib/sync.js, lib/search.js, lib/routes-fs.js, lib/remote-fs.js and
// the rw_* tools all consume this exact shape. Keeping one implementation
// matters more than it looks: the timeout, dead-channel and range-read rules
// below encode failures that were expensive to find (issue #44), and a second
// hand-copied version would drift away from the fixed one.
//
// The rules that are easy to get wrong:
//   • A dead channel must fail FAST. ssh2's own EOF handling only rejects the
//     requests pending at that moment; every later request is registered and
//     never answered, so each waits out the full commandTimeoutMs. Over a tree
//     walk that is N × 2 × timeout — days on a large directory.
//   • A TIMED-OUT request is worse than a dead one and needs the same treatment
//     (issue #65). ssh2 has no per-request cancel: the reply may arrive later,
//     and the request slot stays occupied. If the channel is left in place, the
//     pool keeps handing it out and every later call pays the full timeout
//     again — with a cached session (openssh) or a shared connection (native)
//     that repeats forever, across sessions, until the pool is torn down. So a
//     timeout marks the surface dead AND reports it to the owner via
//     `onTimeout`, which must drop the channel/session.
//   • `readPartial` exists so an oversized preview never downloads the whole
//     file to show its head.
import { toSftpPath } from './paths.js'

/**
 * Wrap a live SFTP channel (ssh2's SFTP instance) in the promisified surface
 * the plugin's callers expect.
 *
 * @param {object} sftp - an ssh2 SFTP channel (already negotiated/ready).
 * @param {object} opts
 * @param {number} opts.commandTimeoutMs - per-operation timeout.
 * @param {Function} [opts.onTimeout] - called once, when an operation times out,
 *   so the owner can drop the channel/session (see the header, issue #65).
 * @returns {object} promisified sftp surface.
 */
export function buildSftpSurface(sftp, { commandTimeoutMs, onTimeout }) {
  // A dead channel must fail fast (see the header). ssh2's SFTP instance and the
  // system-OpenSSH engine both emit these, so one hook covers both backends.
  let dead = false
  const markDead = () => { dead = true }
  if (typeof sftp.on === 'function') {
    sftp.on('end', markDead)
    sftp.on('close', markDead)
    sftp.on('error', markDead)
  }
  const withTimeout = (fn) => (...args) =>
    new Promise((resolve, reject) => {
      if (dead) return reject(new Error('sftp channel closed'))
      const timer = setTimeout(() => {
        // Poisoned, not just slow: see the header. Dead first, so a caller that
        // retries on the same surface fails fast instead of queueing behind the
        // request nobody will ever answer; the owner then drops the transport.
        markDead()
        try { if (onTimeout) onTimeout() } catch { /* teardown must not mask the timeout */ }
        reject(new Error('sftp operation timed out'))
      }, commandTimeoutMs)
      const finish = (err, value) => {
        clearTimeout(timer)
        err ? reject(err) : resolve(value)
      }
      try { fn(...args, finish) } catch (err) { clearTimeout(timer); reject(err) }
    })
  const P = (p) => toSftpPath(p)
  return {
    readdir: (dir) => withTimeout((d, cb) => sftp.readdir(d, cb))(P(dir)),
    stat: (p) => withTimeout((d, cb) => sftp.stat(d, cb))(P(p)),
    lstat: (p) => withTimeout((d, cb) => sftp.lstat(d, cb))(P(p)),
    mkdir: (dir) => withTimeout((d, cb) => sftp.mkdir(d, cb))(P(dir)),
    rmdir: (dir) => withTimeout((d, cb) => sftp.rmdir(d, cb))(P(dir)),
    unlink: (p) => withTimeout((d, cb) => sftp.unlink(d, cb))(P(p)),
    rename: (p, d) => withTimeout((a, b, cb) => sftp.rename(a, b, cb))(P(p), P(d)),
    realpath: (p) => withTimeout((d, cb) => sftp.realpath(d, cb))(P(p)),
    readFile: (p) => withTimeout((d, cb) => sftp.readFile(d, cb))(P(p)),
    writeFile: (p, data) => withTimeout((d, data2, cb) => sftp.writeFile(d, data2, cb))(P(p), data),
    fastGet: (p, lp) => withTimeout((d, l, cb) => sftp.fastGet(d, l, cb))(P(p), lp),
    fastPut: (lp, p) => withTimeout((l, d, cb) => sftp.fastPut(l, d, cb))(lp, P(p)),
    // Range read for oversized previews: never downloads the whole file.
    readPartial: (p, offset, length) => withTimeout((d, off, len, cb) => {
      sftp.open(d, 'r', (e, handle) => {
        if (e) return cb(e)
        const buf = Buffer.alloc(len)
        sftp.read(handle, buf, 0, len, off, (e2, bytesRead, data) => {
          sftp.close(handle, () => {})
          if (e2) return cb(e2)
          cb(null, Buffer.isBuffer(data) ? data.subarray(0, bytesRead) : buf.subarray(0, bytesRead))
        })
      })
    })(P(p), offset, length),
  }
}
