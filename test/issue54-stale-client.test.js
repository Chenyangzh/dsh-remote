// Issue #54 — a stale pooled SSH client must not take the host process down.
//
// The measured crash (dsh-remote 0.8.44 → fixed in 0.8.45, ssh2 1.16):
//
//   dsh: fatal uncaught exception: Error: Not connected
//       at Client.forwardOut (ssh2/lib/client.js:1400:13)
//       at WebAttach._pipe (lib/web-attach.js:404)
//       at Server.<anonymous> (lib/web-attach.js:376)
//       at TCP.onconnection (node:net:2310:8)
//
// Two defects compounded:
//
//   1. `forwardOut` does not report a dead connection through its CALLBACK. ssh2
//      throws `new Error('Not connected')` SYNCHRONOUSLY and the callback is
//      never reached, so `if (err) { socket.destroy(); return }` guarded
//      nothing. The throw then travelled net.Server → TCP.onconnection and out
//      of the process. Every page refresh after the pooled connection dropped
//      killed the whole host (all sessions, every browser tab), and left an
//      ORPHANED remote `dsh web` nobody could reap.
//
//   2. `WebAttach` borrowed a pooled connection and never watched it. The pool
//      cleared its OWN reference and `end()`ed the client; the session kept its
//      dead handle forever. `ForwardManager` (lib/forwards.js) registers
//      `client.on('close', …)` for exactly this reason — the omission, not the
//      design, was the bug.
//
// These tests pin the fix in both directions: the throw must be caught AND the
// session must learn about the loss BEFORE the next request arrives. The
// no-crash property is checked by driving a listener that throws synchronously
// and asserting the test process simply continues — the original failure mode
// was a fatal uncaught exception, so "nothing is raised" IS the assertion.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WebAttach, TAIL_MARKER } from '../lib/web-attach.js'

const READY = (port = 43129, token = 'tok123') =>
  `__DSH_PID__=999\n dsh web: http://127.0.0.1:${port}/?token=${token}\n${TAIL_MARKER}\n`

/**
 * The default exec double: answer the LAUNCH with a ready startup line (so
 * `open()` succeeds) and everything else with empty output. Tests that care
 * about the re-resolve path pass their own `exec`.
 */
const defaultExec = (cmd) => (/nohup/.test(cmd)
  ? { code: 0, stdout: READY(), stderr: '' }
  : { code: 0, stdout: '', stderr: '' })

/** A pool double whose connect() hands back a scripted client. */
function poolWith(client, { exec } = {}) {
  return {
    client,
    execCalls: [],
    async connect() { return this.client },
    async exec(cmd, opts) {
      this.execCalls.push({ cmd, opts })
      return exec ? exec(cmd, opts) : defaultExec(cmd)
    },
  }
}

/**
 * A client that models the ssh2 behaviour this issue is about: it is an
 * EventEmitter (so `close` can be observed) and its `forwardOut` THROWS when
 * the connection is dead instead of calling back.
 */
class ScriptedClient extends EventEmitter {
  constructor({ dead = false, onForwardOut } = {}) {
    super()
    this.dead = dead
    this.forwardOutCalls = 0
    this.onForwardOut = onForwardOut
  }

  forwardOut(_srcHost, _srcPort, _dstHost, _dstPort, cb) {
    this.forwardOutCalls++
    if (this.onForwardOut) return this.onForwardOut(cb)
    if (this.dead) throw new Error('Not connected')
    const channel = new EventEmitter()
    channel.close = () => {}
    channel.pipe = () => channel
    setImmediate(() => cb(null, channel))
  }
}

/** A minimal socket double. */
function fakeSocket() {
  const s = new EventEmitter()
  s.destroyed = false
  s.destroy = () => { s.destroyed = true }
  s.pipe = () => s
  return s
}

/** A net.Server double whose connection handler can be driven by the test. */
function fakeNet() {
  return {
    servers: [],
    createServer(onConnection) {
      const server = new EventEmitter()
      server.connections = []
      // Replay what the OS would do: the listen callback fires once bound, and
      // the connection handler is called with each incoming socket.
      server.listen = (port, host, cb) => {
        server.port = port
        server.host = host
        setImmediate(() => { server.emit('listening'); if (cb) cb() })
      }
      server.close = (cb) => { server.closed = true; setImmediate(() => cb && cb()) }
      server.accept = (socket) => { server.connections.push(socket); onConnection(socket) }
      this.servers.push(server)
      return server
    },
  }
}

// ── the crash itself ────────────────────────────────────────────────────────

test('a synchronous forwardOut throw is caught: the tunnel drops, the process lives', async () => {
  const client = new ScriptedClient({ dead: true })
  const attach = new WebAttach({ net: fakeNet(), trackPool: false })
  await attach.open({ pool: poolWith(client), machineId: 'm-1' })

  const socket = fakeSocket()
  // Before the fix this call propagated 'Not connected' out of the process.
  assert.doesNotThrow(() => attach._pipe(socket), 'a dead connection must not be fatal')
  assert.equal(client.forwardOutCalls, 1)
  assert.equal(socket.destroyed, true, 'the socket must be dropped, not leaked')
  assert.equal(attach.client, null, 'the dead handle must not be kept')
  assert.match(attach.lastError, /Not connected/, 'the reason must reach describe()')

  // describe() is what the UI renders: it must say "disconnected", not throw.
  const d = attach.describe()
  assert.equal(d.active, true, 'the listener is still up; reconnecting can reuse it')
  assert.match(d.error, /Not connected/)
})

test('the crash is survivable while a real listener is mid-request', async () => {
  // The original stack was  Server.<anonymous> → TCP.onconnection, i.e. the
  // throw escaped from inside a real net.Server connection callback. Drive the
  // double's own connection callback (which is exactly that code path) rather
  // than asserting on a direct _pipe() call, so the throw has to cross the same
  // boundary. A real port is deliberately NOT bound: the server double emits
  // 'listening' without opening a handle, so this test cannot keep the process
  // alive after it finishes.
  const client = new ScriptedClient({ dead: true })
  const netDouble = fakeNet()
  const attach = new WebAttach({ net: netDouble, trackPool: false })
  await attach.open({ pool: poolWith(client) })
  const server = netDouble.servers[netDouble.servers.length - 1]
  const socket = fakeSocket()
  assert.doesNotThrow(() => server.accept(socket), 'the throw must not cross net.Server')
  assert.equal(socket.destroyed, true)
  assert.equal(attach.client, null)
})

test('a dead-before-pipe client is dropped without ever calling forwardOut', async () => {
  const client = new ScriptedClient()
  const attach = new WebAttach({ net: fakeNet(), trackPool: false })
  await attach.open({ pool: poolWith(client), machineId: 'm-1' })
  // Simulate the close listener having already fired.
  client.emit('close')
  assert.equal(attach.client, null)
  const socket = fakeSocket()
  assert.doesNotThrow(() => attach._pipe(socket))
  assert.equal(client.forwardOutCalls, 0, 'the guard must be reached before ssh2 is called')
  assert.equal(socket.destroyed, true)
})

// ── defect 2: the session must learn about the loss ──────────────────────────

test('a client close is noticed immediately, before the next request', async () => {
  const client = new ScriptedClient()
  const attach = new WebAttach({ net: fakeNet(), trackPool: false })
  await attach.open({ pool: poolWith(client), machineId: 'm-1' })
  assert.equal(attach.client, client, 'the borrowed connection is held while alive')

  client.emit('close')

  assert.equal(attach.client, null, 'the stale reference must be dropped on close')
  assert.match(attach.lastError, /closed/)
  // The regression this guards: `_pipe` used to find a non-null (dead) client
  // and hand it to ssh2, which threw.
  const socket = fakeSocket()
  assert.doesNotThrow(() => attach._pipe(socket))
  assert.equal(client.forwardOutCalls, 0)
})

test('the close listener is removed on close(), so it cannot fire after teardown', async () => {
  const client = new ScriptedClient()
  const attach = new WebAttach({ net: fakeNet(), trackPool: false })
  await attach.open({ pool: poolWith(client), machineId: 'm-1' })
  const installed = attach.onClientClose
  assert.equal(typeof installed, 'function')
  assert.equal(client.listenerCount('close'), 1, 'exactly one listener, no accumulation')

  await attach.close()
  assert.equal(client.listenerCount('close'), 0, 'a closed session must stop listening')
  assert.equal(attach.client, null)
})

test('re-attaching to the same client does not stack listeners', async () => {
  const client = new ScriptedClient()
  const attach = new WebAttach({ net: fakeNet(), trackPool: false })
  await attach.open({ pool: poolWith(client), machineId: 'm-1' })
  attach._attach(client)
  attach._attach(client)
  assert.equal(client.listenerCount('close'), 1, 'attach must be idempotent per client')
})

test('a NEW client from the pool replaces the old one and its listener', async () => {
  const first = new ScriptedClient()
  const second = new ScriptedClient()
  const attach = new WebAttach({ net: fakeNet(), trackPool: false })
  const pool = poolWith(first)
  await attach.open({ pool, machineId: 'm-1' })

  pool.client = second
  attach._attach(second)

  assert.equal(attach.client, second)
  assert.equal(first.listenerCount('close'), 0, 'the superseded client must be released')
  assert.equal(second.listenerCount('close'), 1)
  // The old client closing now must NOT drop the live one.
  first.emit('close')
  assert.equal(attach.client, second, 'a stale client close must not kill the new tunnel')
})

// ── defect 1 + 2 together: the pool lifecycle ───────────────────────────────

test('the session follows the pool: onCloseHook drops the client, onReady re-arms it', async () => {
  const first = new ScriptedClient()
  const attach = new WebAttach({ net: fakeNet() })
  const pool = poolWith(first)
  await attach.open({ pool, machineId: 'm-1' })
  assert.equal(typeof pool.onCloseHook, 'function', 'the session must subscribe to the pool')
  assert.equal(typeof pool.onReady, 'function')

  // The pool dies (its own invalidate() on a channel-open failure).
  pool.onCloseHook()
  assert.equal(attach.client, null)

  // …and reconnects.
  const second = new ScriptedClient()
  pool.client = second
  pool.onReady(second)
  assert.equal(attach.client, second, 'the tunnel must follow the pool onto the new connection')
})

test('close() restores the hooks the pool had, chaining rather than clobbering', async () => {
  const forwardsReady = () => {}
  const forwardsClose = () => {}
  const attach = new WebAttach({ net: fakeNet() })
  const pool = poolWith(new ScriptedClient())
  pool.onReady = forwardsReady
  pool.onCloseHook = forwardsClose

  await attach.open({ pool, machineId: 'm-1' })
  assert.notEqual(pool.onReady, forwardsReady, 'the session adds its own behaviour')
  assert.notEqual(pool.onCloseHook, forwardsClose)

  // The forwarded-to hook must still run: chaining, not replacement.
  let forwarded = 0
  pool.onReady = forwardsReady
  await attach.close()
  assert.equal(pool.onReady, forwardsReady, 'the displaced hook must be restored, not dropped')
  assert.equal(pool.onCloseHook, forwardsClose)
  assert.equal(forwarded, 0)
})

test('a pool with no hooks is left with none after close()', async () => {
  const attach = new WebAttach({ net: fakeNet() })
  const pool = poolWith(new ScriptedClient())
  assert.equal(pool.onReady, undefined)
  await attach.open({ pool, machineId: 'm-1' })
  await attach.close()
  assert.equal(pool.onReady, null, 'no hook was displaced, so none is restored')
  assert.equal(pool.onCloseHook, null)
})

test('close() does not hand back a hook another owner has since installed', async () => {
  const attach = new WebAttach({ net: fakeNet() })
  const pool = poolWith(new ScriptedClient())
  await attach.open({ pool, machineId: 'm-1' })
  const successor = () => {}
  pool.onReady = successor
  await attach.close()
  assert.equal(pool.onReady, successor, 'never silently disconnect a newer owner')
})

// ── the remote keeps working across a reconnect ─────────────────────────────

test('after a reconnect the remote port is re-resolved from the remote evidence', async () => {
  const first = new ScriptedClient()
  const pool = poolWith(first, {
    exec: async (cmd) => {
      if (/nohup/.test(cmd)) return { code: 0, stdout: READY(), stderr: '' }
      if (/cat "\$HOME\//.test(cmd)) {
        // The remote DIED with the connection and was restarted: the log holds
        // BOTH startup lines, and only the second process is listening.
        return { code: 0, stdout: 'dsh web: http://127.0.0.1:40001/?token=OLD\ndsh web: http://127.0.0.1:40002/?token=NEW\n', stderr: '' }
      }
      if (/\[ -d \/proc\/999 \]/.test(cmd)) return { code: 0, stdout: 'ALIVE\n', stderr: '' }
      if (/ls -l \/proc\/999\/fd/.test(cmd)) return { code: 0, stdout: '123456\n', stderr: '' }
      if (/\/proc\/net\/tcp/.test(cmd)) {
        // Local 127.0.0.1:9C42 (= 40002), LISTEN, inode 123456.
        return { code: 0, stdout: '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
          + '   0: 0100007F:9C42 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  const attach = new WebAttach({ net: fakeNet() })
  await attach.open({ pool, machineId: 'm-1' })
  assert.equal(attach.remotePort, 43129, 'the initial launch port')

  pool.onCloseHook()
  const second = new ScriptedClient()
  pool.client = second
  pool.onReady(second)
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(attach.remotePort, 40002, 'the LISTENING port wins over the stale log line')
  assert.equal(attach.token, 'NEW', 'and the matching token comes with it')
  assert.equal(attach.lastError, '', 'a healed tunnel is no longer "disconnected"')
  assert.equal(attach.connectionLost, false)
})

test('a remote that died and left nothing readable is restarted', async () => {
  const launched = []
  let launches = 0
  const pool = poolWith(new ScriptedClient(), {
    exec: async (cmd) => {
      if (/\[ -d \/proc\/777 \]/.test(cmd)) return { code: 0, stdout: 'GONE\n', stderr: '' }
      if (/nohup/.test(cmd)) {
        launched.push(cmd)
        launches++
        const pid = launches === 1 ? 999 : 888
        const port = launches === 1 ? 43129 : 41000
        const token = launches === 1 ? 'FIRST' : 'FRESH'
        return { code: 0, stdout: `__DSH_PID__=${pid}\ndsh web: http://127.0.0.1:${port}/?token=${token}\n${TAIL_MARKER}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  const attach = new WebAttach({ net: fakeNet() })
  await attach.open({ pool, machineId: 'm-1' })
  assert.equal(launched.length, 1, 'the initial open() launches once')
  attach.remotePid = 777 // as if the original launch had reported this pid

  pool.onCloseHook()
  pool.client = new ScriptedClient()
  pool.onReady(pool.client)
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(launched.length, 2, 'exactly one relaunch, no loop')
  assert.equal(attach.remotePort, 41000)
  assert.equal(attach.token, 'FRESH')
  assert.equal(attach.remotePid, 888, 'the restart reports a new pid to manage')
})

test('a session that started nothing is never restarted (attach onto a foreign DSH)', async () => {
  const pool = poolWith(new ScriptedClient(), {
    exec: async () => { throw new Error('must not exec') },
  })
  const attach = new WebAttach({ net: fakeNet() })
  await attach.open({ pool, machineId: 'm-1', existingUrl: 'http://127.0.0.1:42080/?token=preset' })
  assert.equal(attach.remotePid, 0)

  pool.onCloseHook()
  pool.client = new ScriptedClient()
  pool.onReady(pool.client)
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(pool.execCalls.length, 0, 'a DSH we did not start must be left alone')
  assert.equal(attach.remotePort, 42080, 'and its port is unchanged')
})

test('a re-resolve failure is reported, never thrown into the pool', async () => {
  let launches = 0
  const pool = poolWith(new ScriptedClient(), {
    exec: async (cmd) => {
      if (/nohup/.test(cmd)) {
        launches++
        return launches === 1
          ? { code: 0, stdout: READY(), stderr: '' }
          : { code: 0, stdout: `__DSH_REMOTE_DIED__\n${TAIL_MARKER}\nboom\n`, stderr: '' }
      }
      if (/\[ -d \/proc\/999 \]/.test(cmd)) return { code: 0, stdout: 'GONE\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  const attach = new WebAttach({ net: fakeNet() })
  await attach.open({ pool, machineId: 'm-1' })

  pool.onCloseHook()
  pool.client = new ScriptedClient()
  // Must not throw: the pool calls this synchronously from its 'ready' handler.
  assert.doesNotThrow(() => pool.onReady(pool.client))
  await new Promise((r) => setTimeout(r, 30))

  assert.match(attach.lastError, /could not be restarted/)
})

test('a hook whose exec blows up does not escape into the pool', async () => {
  const attach = new WebAttach({ net: fakeNet() })
  const pool = poolWith(new ScriptedClient())
  await attach.open({ pool, machineId: 'm-1' })
  // A pool whose exec throws SYNCHRONOUSLY must still not make our hook throw.
  pool.exec = () => { throw new Error('boom') }
  pool.onCloseHook()
  assert.doesNotThrow(() => pool.onReady(new ScriptedClient()))
  await new Promise((r) => setTimeout(r, 30))
})

test('nothing is re-armed after close()', async () => {
  const pool = poolWith(new ScriptedClient())
  const attach = new WebAttach({ net: fakeNet() })
  await attach.open({ pool, machineId: 'm-1' })
  await attach.close()
  assert.equal(pool.onReady, null, 'the hook is gone, so a reconnect cannot re-arm us')
  assert.equal(attach.closed, true)
  const before = pool.execCalls.length
  // Even a direct call must be inert.
  await attach._refreshRemotePort()
  assert.equal(pool.execCalls.length, before, 'a closed session must not touch the remote')
})

// ── the same client surface on the system-OpenSSH backend ───────────────────

test('the OpenSshConnection throw path is covered by the same guard', async () => {
  // lib/openssh.js reports a spawn failure through the CALLBACK (setImmediate),
  // but its `spawnSsh()` throws SYNCHRONOUSLY when the connection is already
  // closed — the same hazard class as ssh2's 'Not connected', on the backend
  // issue #51 added. Both must be survivable.
  const client = new ScriptedClient({
    onForwardOut: () => { throw new Error('ssh connection closed') },
  })
  const attach = new WebAttach({ net: fakeNet(), trackPool: false })
  await attach.open({ pool: poolWith(client), machineId: 'm-1' })
  const socket = fakeSocket()
  assert.doesNotThrow(() => attach._pipe(socket))
  assert.equal(socket.destroyed, true)
  assert.match(attach.lastError, /ssh connection closed/)
})

test('a channel-level error mid-transfer tears the pair down, not the process', async () => {
  let channel = null
  const client = new ScriptedClient({
    onForwardOut: (cb) => {
      channel = new EventEmitter()
      channel.close = () => {}
      channel.pipe = () => channel
      setImmediate(() => cb(null, channel))
    },
  })
  const attach = new WebAttach({ net: fakeNet(), trackPool: false })
  await attach.open({ pool: poolWith(client), machineId: 'm-1' })
  const socket = fakeSocket()
  attach._pipe(socket)
  await new Promise((r) => setImmediate(r))

  assert.equal(attach.sockets.has(socket), true)
  assert.doesNotThrow(() => channel.emit('error', new Error('channel died')))
  assert.equal(socket.destroyed, true)
  assert.equal(attach.sockets.has(socket), false, 'a dead pair must not be tracked any more')
})

// ── /proc parsing (the evidence path used after a reconnect) ────────────────

test('the listening-port probe matches the socket INODE, not just the port', async () => {
  const exec = async (cmd) => {
    if (/\[ -d \/proc\/999 \]/.test(cmd)) return { code: 0, stdout: 'ALIVE\n' }
    if (/ls -l \/proc\/999\/fd/.test(cmd)) return { code: 0, stdout: '55 77\n' }
    if (/cat \/proc\/net\/tcp 2>/.test(cmd)) {
      return { code: 0, stdout: 'header line\n'
        // Listed on 0.0.0.0 (not loopback) with OUR inode: must not match.
        + '   0: 00000000:9C42 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 55 1\n'
        // Loopback with someone ELSE's inode: must not match.
        + '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 99 1\n'
        // Loopback, our inode: the answer.
        + '   0: 0100007F:9C43 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 77 1\n', stderr: '' }
    }
    if (/cat \/proc\/net\/tcp6/.test(cmd)) return { code: 0, stdout: '', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const attach = new WebAttach({ net: fakeNet(), trackPool: false })
  attach.remotePid = 999
  assert.equal(await attach._listeningRemotePort(exec), 0x9C43)
})

test('a host with no /proc is treated as alive, so nothing is restarted blindly', async () => {
  const exec = async (cmd) => {
    if (/if \[ -d \/proc \]/.test(cmd)) return { code: 0, stdout: 'ALIVE\n' }
    if (/cat "\$HOME\//.test(cmd)) return { code: 0, stdout: 'dsh web: http://127.0.0.1:4444/?token=T\n' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const attach = new WebAttach({ net: fakeNet(), trackPool: false })
  attach.remotePid = 1234
  assert.equal(await attach._remoteProcessAlive(exec), true)
})

test('trackPool:false leaves the pool completely untouched (test doubles)', async () => {
  const pool = poolWith(new ScriptedClient())
  const attach = new WebAttach({ net: fakeNet(), trackPool: false })
  await attach.open({ pool, machineId: 'm-1' })
  assert.equal(pool.onReady, undefined)
  assert.equal(pool.onCloseHook, undefined)
  assert.equal(attach.hookedPool, null)
})

// ── the SAME defect at the other two forwardOut call sites ──────────────────
//
// `grep -n forwardOut lib/*.js` finds three callers of ssh2's forwardOut, and
// the synchronous throw is a property of the LIBRARY, not of WebAttach. Both of
// the others were reachable the same way and are fixed in the same change:
//
//   • lib/forwards.js `_startLocal` — a user-defined local port forward. Its
//     `net.Server` connection handler is the identical fatal path (the
//     `close -> stopAll()` listener `attach()` registers only helps if the
//     close event wins the race against the incoming request).
//   • lib/pool.js proxy-jump — a bare throw inside a `new Promise` executor
//     becomes an unhandled REJECTION instead of a rejected promise, which is
//     just as fatal and even harder to attribute.

test('a dead connection on a user-defined local forward cannot crash the host', async () => {
  const { ForwardManager } = await import('../lib/forwards.js')
  const client = new ScriptedClient({ dead: true })
  const netDouble = fakeNet()
  const mgr = new ForwardManager({ connect: async () => client }, { net: netDouble })
  const def = mgr.define({ direction: 'local', listenPort: 7000, targetHost: '127.0.0.1', targetPort: 9999 })

  await mgr.start(def)
  const server = netDouble.servers[netDouble.servers.length - 1]
  const socket = fakeSocket()
  // Before the fix this is the SAME fatal path as issue #54's WebAttach stack:
  // the throw crossed net.Server's connection handler.
  assert.doesNotThrow(() => server.accept(socket))
  // The drop happens on the rejection, so let the microtask queue drain.
  await new Promise((r) => setImmediate(r))
  assert.equal(socket.destroyed, true, 'the socket must be dropped, not leaked')
  assert.equal(client.forwardOutCalls, 1)
})

test('a local forward that dies by callback still drops its socket', async () => {
  const { ForwardManager } = await import('../lib/forwards.js')
  // The callback form is the one ssh2 uses for a REFUSED target (the
  // connection is alive, the far side is not) — it must keep working.
  const client = new ScriptedClient({ onForwardOut: (cb) => cb(new Error('connect failed')) })
  const netDouble = fakeNet()
  const mgr = new ForwardManager({ connect: async () => client }, { net: netDouble })
  const def = mgr.define({ direction: 'local', listenPort: 7001, targetHost: '127.0.0.1', targetPort: 9999 })
  await mgr.start(def)
  const server = netDouble.servers[netDouble.servers.length - 1]
  const socket = fakeSocket()
  assert.doesNotThrow(() => server.accept(socket))
  await new Promise((r) => setImmediate(r))
  assert.equal(socket.destroyed, true)
})

test('the proxy-jump forwardOut throw becomes a normal connection failure', async () => {
  // A bare `throw` inside `new Promise(executor)` rejects nothing: it surfaces as
  // an unhandled rejection and leaves the connect() promise pending forever.
  // This matters on a proxy-jump machine whose bastion connection died — the
  // user would otherwise see the connect hang rather than fail.
  const { forwardOutChannel } = await import('../lib/pool.js')
  const deadBastion = new ScriptedClient({ dead: true })
  await assert.rejects(
    forwardOutChannel(deadBastion, { dstHost: '10.0.0.1', dstPort: 22 }),
    /Not connected/,
    'the synchronous throw must arrive as a rejection',
  )
  // A refused target (connection alive, far side not) still arrives normally.
  const refused = new ScriptedClient({ onForwardOut: (cb) => cb(new Error('connect failed')) })
  await assert.rejects(forwardOutChannel(refused, { dstHost: 'x', dstPort: 1 }), /connect failed/)
  // And a live one resolves with the channel.
  const live = new ScriptedClient()
  const channel = await forwardOutChannel(live, { dstHost: 'x', dstPort: 1 })
  assert.equal(typeof channel.pipe, 'function')
})
