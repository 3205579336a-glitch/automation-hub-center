import { lstat, readdir, realpath, unlink, rmdir } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { ExecutionHistoryEntry } from '../../shared/execution-history-types'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const pathKey = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const inside = (root: string, target: string): boolean => {
  const path = relative(root, target)
  return Boolean(path) && path !== '..' && !path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(path)
}

/** Delete only identified app-owned diagnostics. Never follow links or delete Excel/results. */
export class RunDiagnosticCleanup {
  constructor(private readonly runsDirectory: string, private readonly interactionsDirectory: string) {}
  async remove(entry: ExecutionHistoryEntry, protectedPaths: string[] = []): Promise<string[]> {
    const warnings: string[] = []
    const protectedFiles = [entry.resultPath, entry.backupPath, ...protectedPaths].filter((p): p is string => Boolean(p)).map(p => resolve(p))
    const diagnosticCsv = new Set<string>()
    if (entry.logPath && uuid.test(entry.id) && entry.operation === 'create-rfq') {
      const run = join(resolve(this.runsDirectory), entry.id)
      if (inside(join(run, 'output'), resolve(entry.logPath)) && /\.csv$/i.test(entry.logPath)) {
        diagnosticCsv.add(pathKey(entry.logPath))
        // The native runner explicitly copies this very same diagnostic to logs.
        diagnosticCsv.add(pathKey(join(run, 'logs', basename(entry.logPath))))
      }
    }
    const removeTree = async (root: string, target: string): Promise<void> => {
      if (!inside(root, target) || protectedFiles.some(p => pathKey(p) === pathKey(target) || inside(target, p))) {
        warnings.push('A protected result or out-of-scope diagnostic was kept.'); return
      }
      try {
        const info = await lstat(target)
        if (info.isSymbolicLink() || !inside(root, await realpath(target))) { warnings.push('Linked diagnostic files were kept.'); return }
        if (info.isDirectory()) {
          for (const name of await readdir(target)) await removeTree(root, join(target, name))
          try { await rmdir(target) } catch { /* Retained protected files can leave a directory nonempty. */ }
        } else if (/\.(xlsx|xlsm|xls|csv)$/i.test(target) && !diagnosticCsv.has(pathKey(target))) {
          warnings.push('A workbook or business data file was kept.')
        } else await unlink(target)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) warnings.push('Some diagnostic files could not be removed; they were kept.')
      }
    }
    if (uuid.test(entry.id) && entry.operation === 'create-rfq') {
      const root = resolve(this.runsDirectory)
      const run = join(root, entry.id)
      try {
        // Validate the run itself and its resolved ancestry before any recursive deletion.
        const info = await lstat(run)
        if (info.isSymbolicLink() || (await realpath(run)).toLowerCase() !== run.toLowerCase()) throw new Error('Linked run')
        await removeTree(root, join(run, 'logs'))
        await removeTree(root, join(run, 'temp'))
        if (entry.logPath && inside(join(run, 'output'), resolve(entry.logPath)) && /\.csv$/i.test(entry.logPath)) {
          await removeTree(root, resolve(entry.logPath))
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) warnings.push('The diagnostic run directory could not be safely verified; it was kept.')
      }
    }
    if (entry.diagnosticRunId && uuid.test(entry.diagnosticRunId)) {
      const root = resolve(this.interactionsDirectory)
      try {
        if ((await realpath(root)).toLowerCase() !== root.toLowerCase()) throw new Error('Linked interaction root')
        await removeTree(root, join(root, entry.diagnosticRunId))
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) warnings.push('The interaction diagnostic was kept.')
      }
    }
    return [...new Set(warnings)]
  }
}
