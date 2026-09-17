import { readFile, stat } from 'node:fs/promises'
import { extname, posix } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import type {
  RfqBatchConfig,
  RfqExcelPreview,
  RfqPreviewRow
} from '../../shared/rfq-batch-types'

interface ParsedWorksheet {
  name: string
  rows: Map<number, Map<number, string>>
  maxRow: number
}

const HEADER_ALIASES = {
  plant: ['plant', 'target plant'],
  project: ['mpp project no.', 'mpp project no', 'mpp project', 'project no.', 'project no', 'project'],
  material: ['material', 'material no.', 'material no', 'part number'],
  supplier: ['intended supplier', 'supplier parma', 'supplier parma no.', 'supplier parma no', 'parma', 'vendor1', 'vendor 1'],
  email: ['supplier email', 'supplier email1', 'supplier email 1', 'vendor1 email1', 'vendor 1 email 1'],
  dueDate: ['quotation due date', 'rfq due date', 'due date']
} as const

export class RfqExcelService {
  async preview(config: RfqBatchConfig): Promise<RfqExcelPreview> {
    await validateWorkbook(config.excelPath)
    const worksheet = await readRpaWorksheet(config.excelPath)
    const headers = worksheet.rows.get(1)
    if (!headers) {
      throw new Error('The RFQ workbook does not contain a header row.')
    }

    const columns = {
      plant: findHeaderColumn(headers, HEADER_ALIASES.plant),
      project: findHeaderColumn(headers, HEADER_ALIASES.project),
      material: findHeaderColumn(headers, HEADER_ALIASES.material),
      supplier: findHeaderColumn(headers, HEADER_ALIASES.supplier),
      email: findHeaderColumn(headers, HEADER_ALIASES.email),
      dueDate: findHeaderColumn(headers, HEADER_ALIASES.dueDate)
    }
    const missing = Object.entries(columns)
      .filter(([, column]) => column === 0)
      .map(([name]) => name)
    if (missing.length > 0) {
      throw new Error(`Missing required template column(s): ${missing.join(', ')}. Please download a fresh RFQ template.`)
    }

    const sample: RfqPreviewRow[] = []
    let validRows = 0
    let invalidRows = 0
    let skippedBlankRows = 0

    for (let excelRow = 2; excelRow <= worksheet.maxRow; excelRow += 1) {
      const cells = worksheet.rows.get(excelRow)
      const material = valueAt(cells, columns.material)
      if (!material) {
        skippedBlankRows += 1
        continue
      }
      const row = {
        excelRow,
        plant: valueAt(cells, columns.plant).toUpperCase(),
        project: valueAt(cells, columns.project),
        material,
        supplier: valueAt(cells, columns.supplier),
        quotationDueDate: displayExcelDate(valueAt(cells, columns.dueDate))
      }
      const email = valueAt(cells, columns.email)
      const errors: string[] = []
      if (!row.plant) errors.push('Plant is required')
      if (!row.project) errors.push('Project No. is required')
      if (!row.supplier) errors.push('Intended Supplier is required')
      if (!email) errors.push('Supplier Email is required')
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Supplier Email is invalid')
      if (!row.quotationDueDate) errors.push('Quotation Due Date is required')

      const previewRow: RfqPreviewRow = {
        ...row,
        valid: errors.length === 0,
        message: errors.join('; ')
      }
      if (previewRow.valid) validRows += 1
      else invalidRows += 1
      if (sample.length < 12) sample.push(previewRow)
    }

    return {
      sheetName: worksheet.name,
      totalRows: validRows + invalidRows,
      validRows,
      invalidRows,
      skippedBlankRows,
      sample
    }
  }
}

async function validateWorkbook(filePath: string): Promise<void> {
  const extension = extname(filePath).toLowerCase()
  if (extension !== '.xlsx' && extension !== '.xlsm') {
    throw new Error('Select an Excel workbook in .xlsx or .xlsm format.')
  }
  const file = await stat(filePath)
  if (!file.isFile()) throw new Error('The selected RFQ workbook was not found.')
  if (file.size > 20 * 1024 * 1024) throw new Error('The RFQ workbook must be 20 MB or smaller.')
}

async function readRpaWorksheet(filePath: string): Promise<ParsedWorksheet> {
  const archive = unzipSync(new Uint8Array(await readFile(filePath)))
  const workbookXml = archiveText(archive, 'xl/workbook.xml')
  const relationshipXml = archiveText(archive, 'xl/_rels/workbook.xml.rels')
  const sharedStrings = parseSharedStrings(archive['xl/sharedStrings.xml'])
  const sheets = [...workbookXml.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/gi)].map((match) => ({
    name: decodeXml(attribute(match[1], 'name')),
    relationshipId: attribute(match[1], 'r:id') || attribute(match[1], 'id')
  }))
  const selected = sheets.find((sheet) => sheet.name.toLowerCase() === 'rpa_input') ?? sheets[0]
  if (!selected?.relationshipId) throw new Error('The workbook has no readable worksheets.')

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
      const columnLetters = reference.match(/^([A-Z]+)\d+$/i)?.[1]
      if (!columnLetters) continue
      const type = attribute(cellMatch[1], 't')
      const body = cellMatch[2] ?? ''
      const raw = type === 'inlineStr'
        ? extractText(body)
        : body.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/i)?.[1] ?? ''
      const value = type === 's' ? sharedStrings[Number(raw)] ?? '' : decodeXml(raw)
      cells.set(columnNumber(columnLetters), value.trim())
    }
    rows.set(rowNumber, cells)
    maxRow = Math.max(maxRow, rowNumber)
  }
  return { name: selected.name, rows, maxRow }
}

function findHeaderColumn(headers: Map<number, string>, aliases: readonly string[]): number {
  for (const [column, value] of headers) {
    if (aliases.includes(normalizeHeader(value))) return column
  }
  return 0
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function valueAt(cells: Map<number, string> | undefined, column: number): string {
  return cells?.get(column)?.trim() ?? ''
}

function displayExcelDate(value: string): string {
  if (!value) return ''
  const serial = Number(value)
  if (Number.isFinite(serial) && serial > 20_000 && serial < 100_000) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000)
    return date.toISOString().slice(0, 10)
  }
  return value
}

function parseSharedStrings(content: Uint8Array | undefined): string[] {
  if (!content) return []
  return [...strFromU8(content).matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/gi)]
    .map((match) => extractText(match[1]))
}

function extractText(xml: string): string {
  return [...xml.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi)]
    .map((match) => decodeXml(match[1]))
    .join('')
}

function attribute(xml: string, name: string): string {
  const escaped = name.replace(':', '\\:')
  return xml.match(new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`, 'i'))?.[1] ?? ''
}

function archiveText(archive: Record<string, Uint8Array>, path: string): string {
  const content = archive[path]
  if (!content) throw new Error(`The Excel package is missing ${path}.`)
  return strFromU8(content)
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function columnNumber(letters: string): number {
  return letters.toUpperCase().split('').reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0)
}
