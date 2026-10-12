import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

const ownedId = /^(?:preview-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
interface Manifest { version: 1; id: string; operation: string; startedAt: string; finishedAt?: string }

/** Only manifest-owned generated files expire. Inputs outside these roots are never traversed. */
export class GeneratedArtifacts {
  constructor(readonly directory: string) {}
  async create(operation: string, id: string = randomUUID()): Promise<string> {
    if (!ownedId.test(id)) throw new Error('Invalid generated-file run ID.')
    const path = join(this.directory, id)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'artifacts.json'), JSON.stringify({ version: 1, id, operation, startedAt: new Date().toISOString() }), { flag: 'wx' })
    return path
  }
  async finish(path: string): Promise<void> {
    if (resolve(join(this.directory, basename(path))) !== resolve(path)) throw new Error('Invalid generated-file directory.')
    const file = join(path, 'artifacts.json')
    const record = JSON.parse(await readFile(file, 'utf8')) as Manifest
    const temp = file + '.' + randomUUID() + '.tmp'
    await writeFile(temp, JSON.stringify({ ...record, finishedAt: new Date().toISOString() }), 'utf8')
    await rename(temp, file)
  }
  async prune(before: number, protectedIds = new Set<string>()): Promise<string[]> {
    if (!Number.isFinite(before)) throw new Error('Invalid retention cutoff; no files were removed.')
    const warnings: string[] = []
    const root = resolve(this.directory)
    try {
      if ((await realpath(root)).toLowerCase() !== root.toLowerCase()) return ['Linked generated-file root was kept.']
      for (const id of await readdir(root)) {
        if (!ownedId.test(id) || protectedIds.has(id)) continue
        const run = join(root, id)
        try {
          const manifest = join(run, 'artifacts.json')
          for (const target of [run, manifest]) {
            const info = await lstat(target)
            if (info.isSymbolicLink() || (await realpath(target)).toLowerCase() !== target.toLowerCase()) throw new Error('Linked generated-file manifest')
            if (target === run ? !info.isDirectory() : !info.isFile()) throw new Error('Invalid generated-file manifest')
          }
          const record = JSON.parse(await readFile(manifest, 'utf8')) as Manifest
          if (record.version !== 1 || record.id !== id || !Number.isFinite(Date.parse(record.startedAt))
              || !record.finishedAt || !Number.isFinite(Date.parse(record.finishedAt)) || Date.parse(record.finishedAt) < Date.parse(record.startedAt)
              || Date.parse(record.finishedAt) >= before) continue
          // Recent and unfinished runs need no full-tree scan: avoid slowing normal startup.
          // Verify the entire tree before deleting any file. Junctions/links, unknown evidence and
          // external paths are not followed. No recursive rm against user directories.
          const files: string[] = [], directories: string[] = []
          const scan = async (path: string): Promise<void> => {
            const info = await lstat(path)
            if (info.isSymbolicLink() || (await realpath(path)).toLowerCase() !== path.toLowerCase()) throw new Error('Linked generated file')
            if (info.isDirectory()) { for (const name of await readdir(path)) await scan(join(path, name)); directories.push(path) }
            else if (info.isFile()) files.push(path)
            else throw new Error('Unsupported generated file')
          }
          await scan(run)
          for (const path of files.filter(path => path !== manifest)) await unlink(path)
          // Keep manifest on failure so locked/open files can be retried at the next idle cleanup.
          for (const path of directories.filter(path => path !== run)) await rmdir(path)
          await unlink(manifest); await rmdir(run)
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) warnings.push('Unfinished, unreadable, linked or locked generated files were kept.')
        }
      }
    } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) warnings.push('Generated-file cleanup was skipped safely.') }
    return [...new Set(warnings)]
  }
}
