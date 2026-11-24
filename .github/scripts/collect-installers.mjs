// Collects built installers from release/ into installers/ alongside .sha256 files.
// Runs under Node instead of bash so Windows self-hosted runners do not depend on
// Git Bash vs. WSL bash.exe ordering on PATH or fail on persistent directories.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const RELEASE_DIR = 'release'
const INSTALLERS_DIR = 'installers'
const INSTALLER_EXTS = ['.exe', '.dmg', '.AppImage', '.deb']

async function sha256File(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

async function main() {
  const entries = await readdir(RELEASE_DIR, { withFileTypes: true }).catch((error) => {
    if (error && error.code === 'ENOENT') return []
    throw error
  })
  const files = entries
    .filter((entry) => entry.isFile() && INSTALLER_EXTS.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => entry.name)
    .sort()

  if (files.length === 0) {
    console.log(`::error::No installers found in ${RELEASE_DIR}/`)
    process.exitCode = 1
    return
  }

  await rm(INSTALLERS_DIR, { recursive: true, force: true })
  await mkdir(INSTALLERS_DIR, { recursive: true })

  for (const name of files) {
    const source = join(RELEASE_DIR, name)
    const dest = join(INSTALLERS_DIR, name)
    await copyFile(source, dest)
    const digest = await sha256File(dest)
    await writeFile(`${dest}.sha256`, `${digest}  ${name}\n`, 'utf8')
  }
}

await main()
