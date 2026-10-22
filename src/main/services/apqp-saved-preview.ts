import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { ApqpConfig, ApqpPreview, ApqpPreviewSelection } from '../../shared/apqp-types'
import { apqpPreviewForMode } from '../../shared/apqp-types'
import { ApqpTemplateError, apqpHeaderColumns, attribute, decode, readExcelTemplateWorkbook,
  selectApqpTemplateSheet, textNodes } from './excel-template-header'

export class ApqpLivePreviewRequired extends Error {}
type PreviewConfig = Pick<ApqpConfig, 'excelPath' | 'sheetName' | 'maxItems' | 'overwriteExisting'>

/** One saved-file snapshot; live Excel is ALWAYS read again before SAP starts. */
export class ApqpSavedPreview {
  private cached?: { signature: string; selection: string; preview: ApqpPreview }

  async read(config: PreviewConfig): Promise<ApqpPreview> {
    const started = performance.now()
    try {
      const before = await signature(config.excelPath)
      const selection = JSON.stringify([config.sheetName, config.maxItems])
      if (this.cached?.signature === before && this.cached.selection === selection) {
        return structuredClone(apqpPreviewForMode({ ...this.cached.preview, parseMs: performance.now() - started }, config.overwriteExisting))
      }
      const workbook = await readExcelTemplateWorkbook(config.excelPath)
      const sheet = selectApqpTemplateSheet(workbook.sheets, config.sheetName)
      const columns = apqpHeaderColumns(sheet.headers)!
      const modes = { keepExisting: empty(), refreshExisting: empty() }
      let lastRow = 0
      for (const row of sheet.xml.matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
        const index = Number(attribute(row[1], 'r'))
        if (!Number.isInteger(index) || index <= lastRow || index > 1_048_576) {
          throw new ApqpLivePreviewRequired('This worksheet needs live Excel row interpretation.')
        }
        lastRow = index
        if (index < 2) continue
        const values = new Map<number, string>()
        for (const cell of row[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
          const reference = /^([A-Z]{1,3})(\d+)$/.exec(attribute(cell[1], 'r'))
          if (!reference || Number(reference[2]) !== index) throw new ApqpLivePreviewRequired('Cell references need live Excel interpretation.')
          const column = [...reference[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0)
          if (!columns.includes(column)) continue
          if (values.has(column)) throw new ApqpTemplateError('Duplicate Excel cell references. Save and upload the workbook again.')
          values.set(column, cellValue(cell[2] ?? '', attribute(cell[1], 't'), workbook.strings, column === columns[2]))
        }
        const material = identifier(values.get(columns[0]) ?? '')
        const vendor = identifier(values.get(columns[1]) ?? '')
        const existing = values.get(columns[2]) ?? ''
        for (const [name, mode] of Object.entries(modes)) {
          if (config.maxItems > 0 && mode.selected >= config.maxItems) continue
          if (!material && !vendor) continue
          if (!material || !vendor) { mode.invalid++; continue }
          if (name === 'keepExisting' && existing) { mode.skipped++; continue }
          mode.selected++
          if (mode.sample.length < 12) mode.sample.push({ material, vendor, excelRow: index })
        }
        if (config.maxItems > 0 && Object.values(modes).every(mode => mode.selected >= config.maxItems)) break
      }
      if (await signature(config.excelPath) !== before) throw new Error('Excel changed during preview. Save and upload it again.')
      const preview: ApqpPreview = { sheetName: sheet.name, ...modes.keepExisting, modes, source: 'saved-file', parseMs: performance.now() - started }
      // Counts and 12 samples only; do not retain workbook contents or row arrays.
      this.cached = { signature: before, selection, preview }
      return structuredClone(apqpPreviewForMode(preview, config.overwriteExisting))
    } catch (error) {
      if (error instanceof ApqpLivePreviewRequired || error instanceof ApqpTemplateError) throw error
      throw new ApqpTemplateError(error instanceof Error ? error.message : 'Cannot read the Excel workbook.')
    }
  }
}

function empty(): ApqpPreviewSelection { return { selected: 0, skipped: 0, invalid: 0, sample: [] } }
function identifier(value: string): string { return /^\d+\.0$/.test(value.trim()) ? value.trim().slice(0, -2) : value.trim() }
async function signature(path: string): Promise<string> {
  const file = await stat(path, { bigint: true })
  return [resolve(path), file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join('|')
}
function cellValue(xml: string, type: string, strings: string[], existingDate: boolean): string {
  const text = (value: string): string => (existingDate ? value.replace(/\u00a0/g, ' ') : value).trim()
  if (/<(?:\w+:)?f\b/.test(xml) || type === 'e') throw new ApqpLivePreviewRequired('Formula/error cells require live Excel validation.')
  const raw = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(xml)?.[1] ?? ''
  if (type === 'inlineStr') return text(textNodes(xml))
  if (type === 's') {
    const index = Number(raw)
    if (!/^\d+$/.test(raw) || index >= strings.length) throw new ApqpTemplateError('The workbook contains invalid shared strings.')
    return text(strings[index])
  }
  if (type === 'str' || type === 'd' && existingDate) return text(decode(raw))
  if (type === 'b' && existingDate) return raw === '1' ? 'True' : ''
  if ((!type || type === 'n') && raw) {
    const number = Number(raw)
    if (existingDate && Number.isFinite(number)) return number ? String(number) : ''
    if (Number.isSafeInteger(number)) return String(number)
  }
  if (!raw && (!type || type === 'n')) return ''
  throw new ApqpLivePreviewRequired('This Excel cell type requires live validation.')
}
