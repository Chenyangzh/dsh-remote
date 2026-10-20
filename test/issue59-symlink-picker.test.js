// Issue #59: the remote workspace picker could not enter a symlink that points
// at a directory. listDirStructured() must resolve the link's TARGET with stat
// (follows links) — lstat only describes the link itself, so a symlink-to-dir
// was misclassified 'file' and double-clicking it did nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listDirStructured } from '../lib/remote-fs.js'

/** Fake sftp surface: /proj holds one symlink entry; stat/lstat disagree on it. */
function sftpWithSymlink(targetStat, { lstatThrows = false, statThrows = false } = {}) {
  const calls = { stat: 0, lstat: 0 }
  return {
    calls,
    readdir: async (dir) => [
      { filename: 'link', attrs: { size: 0, mtime: 1, isDirectory: () => false, isSymbolicLink: () => true } },
      { filename: 'real', attrs: { size: 0, mtime: 1, isDirectory: () => true, isSymbolicLink: () => false } },
    ],
    stat: async (p) => {
      calls.stat++
      if (statThrows) throw new Error('dangling link')
      return targetStat
    },
    lstat: async (p) => {
      calls.lstat++
      if (lstatThrows) throw new Error('lstat must not be used for target resolution')
      return { isDirectory: () => false } // the LINK itself is never a directory
    },
  }
}

test('a symlink pointing at a directory lists as dir (enterable in the picker)', async () => {
  const sftp = sftpWithSymlink({ isDirectory: () => true })
  const out = await listDirStructured(sftp, '/proj')
  const link = out.items.find((it) => it.name === 'link')
  assert.equal(link.type, 'dir')
  assert.equal(link.link, true)
  assert.equal(sftp.calls.stat, 1, 'target type must come from stat (follows links)')
  assert.equal(sftp.calls.lstat, 0, 'lstat describes the link itself and must not be consulted')
  assert.equal(out.items.find((it) => it.name === 'real').type, 'dir')
})

test('a symlink pointing at a file stays file', async () => {
  const sftp = sftpWithSymlink({ isDirectory: () => false })
  const out = await listDirStructured(sftp, '/proj')
  assert.equal(out.items.find((it) => it.name === 'link').type, 'file')
})

test('a dangling symlink degrades to file instead of breaking the listing', async () => {
  const sftp = sftpWithSymlink(null, { statThrows: true })
  const out = await listDirStructured(sftp, '/proj')
  assert.equal(out.items.find((it) => it.name === 'link').type, 'file')
})
