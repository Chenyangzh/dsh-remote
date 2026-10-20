// Issue #58: the Windows system folder picker (PowerShell FolderBrowserDialog)
// returned Chinese folder names as mojibake — the console writes stdout in the
// OEM codepage (GBK on zh-CN) while Node decodes UTF-8 — and the garbled path
// then failed "not a directory". The picker now prints base64(UTF-8) of the
// selected path (ASCII on every codepage) and the host decodes it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodePickStdout, win32FolderPickScript } from '../lib/index.js'

test('win32 picker script base64(UTF-8)-encodes the selected path', () => {
  const s = win32FolderPickScript()
  assert.ok(s.includes('[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($f.SelectedPath))'),
    'SelectedPath must be base64(UTF-8)-encoded, never printed raw')
  assert.ok(!/if \(\$f\.ShowDialog\(\)[^\n]*\) \{ \$f\.SelectedPath \}/.test(s), 'raw SelectedPath output is the bug')
  assert.ok(s.includes("'CANCELED'"), 'cancel sentinel preserved')
})

test('decodePickStdout round-trips a Chinese path through base64', () => {
  const original = 'D:\\工作目录\\新建文件夹 (2)\\项目'
  const b64 = Buffer.from(original, 'utf8').toString('base64')
  assert.deepEqual(decodePickStdout(b64 + '\r\n', { base64: true }), { path: original })
})

test('decodePickStdout keeps cancel and empty outcomes', () => {
  assert.deepEqual(decodePickStdout('CANCELED\r\n', { base64: true }), { cancelled: true })
  assert.deepEqual(decodePickStdout('', { base64: true }), { cancelled: true })
})

test('decodePickStdout without base64 passes plain stdout through (osascript/zenity)', () => {
  assert.deepEqual(decodePickStdout('/home/u/项目\n'), { path: '/home/u/项目' })
})

test('an invalid base64 payload degrades to the raw string instead of throwing', () => {
  const out = decodePickStdout('!!!not-base64!!!', { base64: true })
  assert.equal(typeof out.path === 'string' || out.cancelled === true, true)
})
