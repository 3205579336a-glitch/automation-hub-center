import { readFile, stat } from 'node:fs/promises'
import { extname, posix } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import type { Me52nBatchConfig, Me52nExcelPreview } from '../../shared/me52n-types'

interface ParsedWorksheet {
  name: string
  rows: Map<number, Map<number, string>>
  maxRow: number
}

export class Me52nExcelService {
  async preview(config: Me52nBatchConfig): Promise<Me52nExcelPreview> {
    await validateWorkbook(config.excelPath)
    const worksheet = await readWorksheet(config.excelPath, config.sheetName)
    const startRow = config.batchStartRow > 0 ? config.batchStartRow : config.dataStartRow
    const endRow = config.batchSize > 0
      ? Math.min(worksheet.maxRow, startRow + config.batchSize - 1)
      : worksheet.maxRow
    const prs = new Map<string, number[]>()
    let blankRows = 0
    let invalidRows = 0

    for (let row = startRow; row <= endRow; row += 1) {
      const raw = worksheet.rows.get(row)?.get(config.prColumn)?.trim() ?? ''
      if (!raw) { blankRows += 1; continue }
      const pr = normalizeIdentifier(raw)
      if (!/^\d{5,20}$/.test(pr)) { invalidRows += 1; continue }
      const rows = prs.get(pr) ?? []
      rows.push(row)
      prs.set(pr, rows)
    }
    if (!prs.size) throw new Error('No valid purchase requisition numbers were found in the selected batch.')
    const sample = [...prs].slice(0, 12).map(([pr, excelRows]) => ({ pr, excelRows }))
    const validRows = [...prs.values()].reduce((sum, rows) => sum + rows.length, 0)
    return {
      sheetName: worksheet.name,
      startRow,
      endRow,
      scannedRows: Math.max(0, endRow - startRow + 1),
      uniquePrs: prs.size,
      duplicateRows: validRows - prs.size,
      blankRows,
      invalidRows,
      sample
    }
  }
}

function normalizeIdentifier(value: string): string {
  const trimmed = value.trim()
  return /^\d+\.0$/.test(trimmed) ? trimmed.slice(0, -2) : trimmed
}

async function validateWorkbook(filePath: string): Promise<void> {
  const extension = extname(filePath).toLowerCase()
  if (!['.xlsx', '.xlsm'].includes(extension)) throw new Error('Select an Excel workbook in .xlsx or .xlsm format.')
  const file = await stat(filePath)
  if (!file.isFile()) throw new Error('The selected ME52N workbook was not found.')
  if (file.size > 50 * 1024 * 1024) throw new Error('The ME52N workbook must be 50 MB or smaller.')
}

async function readWorksheet(filePath: string, requestedName: string): Promise<ParsedWorksheet> {
  const archive = unzipSync(new Uint8Array(await readFile(filePath)))
  const workbookXml = archiveText(archive, 'xl/workbook.xml')
  const relationshipXml = archiveText(archive, 'xl/_rels/workbook.xml.rels')
  const sharedStrings = parseSharedStrings(archive['xl/sharedStrings.xml'])
  const sheets = [...workbookXml.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/gi)].map((match) => ({
    name: decodeXml(attribute(match[1], 'name')),
    relationshipId: attribute(match[1], 'r:id') || attribute(match[1], 'id')
  }))
  const selected = requestedName.trim()
    ? sheets.find((sheet) => sheet.name.toLowerCase() === requestedName.trim().toLowerCase())
    : sheets[0]
  if (!selected?.relationshipId) {
    throw new Error(requestedName.trim() ? `Worksheet "${requestedName}" was not found.` : 'The workbook has no readable worksheets.')
  }
  const relationships = new Map<string, string>()
  for (const match of relationshipXml.matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/gi)) {
    relationships.set(attribute(match[1], 'Id'), decodeXml(attribute(match[1], 'Target')))
  }
  const target = relationships.get(selected.relationshipId)
  if (!target) throw new Error(`Worksheet "${selected.name}" is missing from the workbook package.`)
  const worksheetPath = target.replace(/^\/+/, '').startsWith('xl/')
    ? posix.normalize(target.replace(/^\/+/, ''))
    : posix.normalize(posix.join('xl', target))
  const xml = archiveText(archive, worksheetPath)
  const rows = new Map<number, Map<number, string>>()
  let maxRow = 1
  for (const rowMatch of xml.matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/gi)) {
    const rowNumber = Number(attribute(rowMatch[1], 'r'))
    if (!Number.isInteger(rowNumber) || rowNumber < 1) continue
    const cells = new Map<number, string>()
    for (const cellMatch of rowMatch[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/gi)) {
      const reference = attribute(cellMatch[1], 'r')
      const letters = reference.match(/^([A-Z]+)\d+$/i)?.[1]
      if (!letters) continue
      const type = attribute(cellMatch[1], 't')
      const body = cellMatch[2] ?? ''
      const raw = type === 'inlineStr' ? extractText(body) : body.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/i)?.[1] ?? ''
      const value = type === 's' ? sharedStrings[Number(raw)] ?? '' : decodeXml(raw)
      cells.set(columnNumber(letters), value.trim())
    }
    rows.set(rowNumber, cells)
    maxRow = Math.max(maxRow, rowNumber)
  }
  return { name: selected.name, rows, maxRow }
}

function parseSharedStrings(content: Uint8Array | undefined): string[] {
  if (!content) return []
  return [...strFromU8(content).matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/gi)].map((match) => extractText(match[1]))
}
function extractText(xml: string): string { return [...xml.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi)].map((match) => decodeXml(match[1])).join('') }
function attribute(xml: string, name: string): string { return xml.match(new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}="([^"]*)"`, 'i'))?.[1] ?? '' }
function archiveText(archive: Record<string, Uint8Array>, path: string): string { const content = archive[path]; if (!content) throw new Error(`The Excel package is missing ${path}.`); return strFromU8(content) }
function decodeXml(value: string): string { return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&') }
function columnNumber(letters: string): number { return letters.toUpperCase().split('').reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) }
