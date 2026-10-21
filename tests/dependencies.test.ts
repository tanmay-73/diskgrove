import { promises as fs } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

const SRC = path.resolve('src')
const UI = path.join(SRC, 'renderer', 'src', 'components', 'ui')

async function sources(): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const name of await fs.readdir(SRC, { recursive: true })) {
    if (/\.tsx?$/.test(name)) files.set(path.join(SRC, name), await fs.readFile(path.join(SRC, name), 'utf8'))
  }
  return files
}

// Unused UI code still costs an install, an audit entry and, once imported by mistake, bundle size.
it('imports every Radix package listed in package.json', async () => {
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'))
  const code = [...(await sources()).values()].join('\n')
  const radix = Object.keys(pkg.devDependencies).filter((name) => name.startsWith('@radix-ui/'))
  expect(radix.length).toBeGreaterThan(0)
  expect(radix.filter((name) => !code.includes(`'${name}'`))).toEqual([])
})

it('uses every UI component', async () => {
  const files = await sources()
  const code = [...files.values()].join('\n')
  const components = [...files.keys()].filter((file) => path.dirname(file) === UI).map((file) => path.parse(file).name)
  expect(components.length).toBeGreaterThan(0)
  expect(components.filter((name) => !code.includes(`'@/components/ui/${name}'`))).toEqual([])
})
