import { createRequire } from 'node:module'

// Electron patches node:fs so apps can read inside .asar archives: each archive then looks like a
// folder whose made-up stats carry a new inode on every call. A disk analyzer has to see the archive
// file actually on disk, so filesystem work here goes through Electron's unpatched original-fs.
// Plain Node (tests, scripts) has no asar layer.
const require = createRequire(import.meta.url)
const realFs: typeof import('node:fs') = process.versions.electron ? require('original-fs') : require('node:fs')

export const fs = realFs.promises
export const { createReadStream } = realFs
