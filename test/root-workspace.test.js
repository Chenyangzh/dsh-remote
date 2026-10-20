// Issue #60: a filesystem root (POSIX `/`, Windows `D:\`) is a legal remote
// workspace. The old guard `!p || p === '/'` claimed to reject blank input but
// actually rejected the ROOT (normalizeRemotePath('') already returns '/', so
// `!p` could never fire) — and `/` is unambiguously "an absolute directory".
//
// The fix is two-part, and the tests below pin both halves:
//   1. Guards (`rw_pick_workspace`, /workspace, /mirror) reject only BLANK raw
//      input; a root now reaches the real directory probe.
//   2. ROOT_IGNORE — merged only when the workspace IS the root — keeps sync /
//      push / search out of the synthetic trees (/proc /sys /dev /run /boot
//      /var/lib/docker). A non-root workspace is byte-identical to before.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { compileIgnore, ignorePatternsFor, isFilesystemRoot, ROOT_IGNORE } from '../lib/ignore.js'
import { syncTree } from '../lib/sync.js'
import { searchTree } from '../lib/search.js'
import { MemFs, makeSftp, seed } from './helpers.js'

// ── pure ignore-layer behaviour ─────────────────────────────────────────────

test('isFilesystemRoot: POSIX root, drive roots, UNC roots; not ordinary dirs', () => {
  for (const p of ['/', 'D:\\', 'D:', 'c:\\', '\\\\nas\\share']) {
    assert.equal(isFilesystemRoot(p), true, `${p} should be a root`)
  }
  for (const p of ['/root', '/home/u', 'D:\\code', '\\\\nas\\share\\dir', '', '/proc']) {
    assert.equal(isFilesystemRoot(p), false, `${p} should NOT be a root`)
  }
})

test('ignorePatternsFor: ROOT_IGNORE merges only for a root workspace', () => {
  const rootPats = ignorePatternsFor('/')
  for (const p of ROOT_IGNORE) assert.ok(rootPats.includes(p), `root gets ${p}`)
  const homePats = ignorePatternsFor('/home/u')
  for (const p of ROOT_IGNORE) assert.ok(!homePats.includes(p), `non-root must not get ${p}`)
  // user rules always stack, root or not
  assert.ok(ignorePatternsFor('/', { fromFile: ['*.tmp2'] }).includes('*.tmp2'))
  assert.ok(ignorePatternsFor('/x', { fromFile: ['*.tmp2'] }).includes('*.tmp2'))
  // search variant starts from the wider search defaults
  const searchPats = ignorePatternsFor('/', { search: true })
  assert.ok(searchPats.includes('.npm/'), 'search set keeps its cache excludes')
  assert.ok(searchPats.includes('/proc/'), 'search from root also skips synthetic trees')
})

test('anchored /proc/ matches only the workspace TOP level', () => {
  const m = compileIgnore(ROOT_IGNORE)
  assert.equal(m('proc', true), true)
  assert.equal(m('proc/1/mem', false), true)
  assert.equal(m('sys/kernel', false), true)
  assert.equal(m('var/lib/docker', true), true)
  assert.equal(m('var/lib/docker/overlay2/x', false), true)
  // a directory NAMED proc somewhere deeper is ordinary content
  assert.equal(m('home/u/proc', true), false)
  assert.equal(m('root/dev', true), false)
})

// ── sync / search from a root workspace ─────────────────────────────────────

function rootTreeFs() {
  const fs = new MemFs()
  seed(fs, {
    'bin/sh': 'x',
    'etc/passwd': 'root:x:0:0:',
    'home/u/a.c': 'int main(){}',
    'proc/1/mem': 'not-real-memory',
    'proc/2/status': 'not-real-status',
    'sys/kernel/uevent': 'synthetic',
    'dev/null': 'char-device',
    'run/lock': 'tmpfs',
    'boot/vmlinuz': 'kernel',
    'var/lib/docker/overlay2/biglayer': 'image-bytes',
  })
  return fs
}

test('syncTree from / skips synthetic trees but mirrors real content', async () => {
  const fs = rootTreeFs()
  const sftp = makeSftp(fs)
  const local = mkdtempSync(path.join(tmpdir(), 'dsh-root-sync-'))
  try {
    const isIgnored = compileIgnore(ignorePatternsFor('/'))
    const { stats } = await syncTree(sftp, '/', local, { isIgnored, maxDepth: 6 })
    assert.ok(existsSync(path.join(local, 'bin', 'sh')), '/bin/sh mirrored')
    assert.ok(existsSync(path.join(local, 'etc', 'passwd')), '/etc/passwd mirrored')
    assert.ok(existsSync(path.join(local, 'home', 'u', 'a.c')), '/home/u/a.c mirrored')
    for (const gone of ['proc', 'sys', 'dev', 'run', 'boot']) {
      assert.equal(existsSync(path.join(local, gone)), false, `/${gone} must not be mirrored`)
    }
    assert.equal(existsSync(path.join(local, 'var', 'lib', 'docker')), false, '/var/lib/docker must not be mirrored')
    assert.ok(stats.files >= 3)
  } finally {
    rmSync(local, { recursive: true, force: true })
  }
})

test('syncTree of a NON-root workspace still mirrors its own proc/ directory', async () => {
  const fs = new MemFs()
  seed(fs, { 'home/u/proc/notes.txt': 'mine', 'home/u/code/a.c': 'x' })
  const sftp = makeSftp(fs)
  const local = mkdtempSync(path.join(tmpdir(), 'dsh-nonroot-sync-'))
  try {
    const isIgnored = compileIgnore(ignorePatternsFor('/home/u'))
    await syncTree(sftp, '/home/u', local, { isIgnored, maxDepth: 6 })
    assert.ok(existsSync(path.join(local, 'proc', 'notes.txt')), '/home/u/proc is ordinary content')
    assert.ok(existsSync(path.join(local, 'code', 'a.c')))
  } finally {
    rmSync(local, { recursive: true, force: true })
  }
})

test('searchTree from / never descends into synthetic trees (root-anchored rules are live in search)', async () => {
  const fs = rootTreeFs()
  const sftp = makeSftp(fs)
  const readDirs = []
  const origReaddir = sftp.readdir
  sftp.readdir = (d) => { readDirs.push(d); return origReaddir(d) }
  const isIgnored = compileIgnore(ignorePatternsFor('/', { search: true }))
  await searchTree(sftp, '/', { regex: /./, isIgnored, maxFiles: 500 })
  for (const gone of ['/proc', '/sys', '/dev', '/run', '/boot', '/var/lib/docker']) {
    assert.equal(readDirs.includes(gone), false, `search must not readdir ${gone}`)
  }
  assert.ok(readDirs.includes('/home') || readDirs.includes('/home/u'), 'real content still searched')
})

// ── the three guards: blank rejected, root reaches the probe ────────────────

function makeCtx() {
  const routes = new Map()
  const tools = new Map()
  const ctx = {
    effect: () => {},
    inject(names, callback) { if (names.every((name) => this.get(name))) callback(this) },
    get: (k) => (k === 'webServer' ? { register: (r) => { routes.set(r.path, r); return () => {} } } : undefined),
    tools: { register: (t) => tools.set(t.name, t) },
    systemPrompt: { section: () => {} },
  }
  return { ctx, routes, tools }
}

const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 1500, connectTimeoutMs: 1200,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

async function loadPlugin() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-rootws-'))
  mkdirSync(path.join(home, 'remote-workspaces'), { recursive: true })
  process.env.DSH_HOME = home
  const mod = await import(`../lib/index.js?rootws=${Math.random()}`)
  const { ctx, routes, tools } = makeCtx()
  await mod.apply(ctx, { ...CONFIG })
  return { routes, tools, home }
}

function fakeReq(body) {
  const req = Readable.from([JSON.stringify(body)])
  req.method = 'POST'
  req.url = '/x'
  return req
}

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    setHeader() {},
    writeHead(code) { this.statusCode = code },
    end(b) { this.body = String(b || '') },
  }
}

test('rw_pick_workspace: "/" passes the guard and fails at the (no-host) probe; "" is still rejected', async () => {
  const { tools, home } = await loadPlugin()
  try {
    const pick = tools.get('rw_pick_workspace')
    await assert.rejects(
      () => pick.execute({ path: '' }, {}),
      /path must be an absolute directory/,
      'blank stays rejected at the guard',
    )
    await assert.rejects(
      () => pick.execute({ path: '/' }, {}),
      /no remote host — call rw_connect first/,
      'root must pass the guard and fail later, at the probe stage',
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('POST /workspace and /mirror: "/" reaches the probe, "" still 400s at the guard', async () => {
  const { routes, home } = await loadPlugin()
  try {
    for (const routePath of ['/dsh-remote/workspace', '/dsh-remote/mirror']) {
      const route = routes.get(routePath)
      assert.ok(route, `${routePath} registered`)
      const resBlank = fakeRes()
      await route.handler(fakeReq({ path: '' }), resBlank)
      assert.equal(resBlank.statusCode, 400)
      assert.match(resBlank.body, /path must be an absolute directory/, `${routePath}: blank rejected`)
      const resRoot = fakeRes()
      await route.handler(fakeReq({ path: '/' }), resRoot)
      assert.doesNotMatch(
        resRoot.body,
        /path must be an absolute directory/,
        `${routePath}: root must not die at the path guard — it fails at the probe instead`,
      )
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

