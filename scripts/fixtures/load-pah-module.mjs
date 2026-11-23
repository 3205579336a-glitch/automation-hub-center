import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../', import.meta.url))
const modules = new Map()

/** Load the Hub's main-process modules with a windowless Electron stub. */
export function loadPahModule(path) {
  const file = resolve(root, path)
  if (modules.has(file)) return modules.get(file).exports
  const module = { exports: {} }
  modules.set(file, module)
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Function('require', 'module', 'exports', code)(name => {
    if (name === 'electron') return { BrowserWindow: { getAllWindows: () => [] } }
    return name.startsWith('.') ? loadPahModule(resolve(dirname(file), name + '.ts')) : require(name)
  }, module, module.exports)
  return module.exports
}
