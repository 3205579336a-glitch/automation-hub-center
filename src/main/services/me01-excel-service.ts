import { readFile, stat } from 'node:fs/promises'
import { extname, posix } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import type { Me01ExcelPreview, Me01PreviewRow } from '../../shared/me01-types'

interface ParsedWorksheet {
  name: string
  rows: Map<number, Map<number, string>>
  maxRow: number
}

const MATERIAL_HEADERS = ['material no.', 'material no', 'material', 'part number']
const PARMA_HEADERS = ['parma', 'parma no.', 'parma no', 'supplier', 'supplier code', 'intended supplier']

export class Me01ExcelService {
  async preview(filePath: string): Promise<Me01ExcelPreview> {
    await validateWorkbook(filePath)
    const worksheet = await readWorksheet(filePath)
    const headers = worksheet.rows.get(1)
    if (!headers) throw new Error('The ME01 workbook does not contain a header row.')
    const materialColumn = findHeaderColumn(headers, MATERIAL_HEADERS)
    const parmaColumn = findHeaderColumn(headers, PARMA_HEADERS)
    if (!materialColumn || !parmaColumn) {
      throw new Error('Missing required column(s) "Material No." or "Parma". Please download a fresh ME01 template.')
    }

    const assignments = new Map<string, { material: string; parma: string; excelRows: number[] }>()
    const supplierByMaterial = new Map<string, string>()
    let lastInputRow = 1
    for (let excelRow = 2; excelRow <= worksheet.maxRow; excelRow += 1) {
      const material = worksheet.rows.get(excelRow)?.get(materialColumn)?.trim() ?? ''
      const parma = worksheet.rows.get(excelRow)?.get(parmaColumn)?.trim() ?? ''
      if (!material && !parma) {
        continue
      }
      lastInputRow = excelRow
      if (!material || !parma) {
        throw new Error(`Excel row ${excelRow} must contain both Material No. and Parma.`)
      }
      const existingParma = supplierByMaterial.get(material)
      if (existingParma && normalizeIdentifier(existingParma) !== normalizeIdentifier(parma)) {
        throw new Error(`Material ${material} has more than one Parma in the workbook. Keep only the supplier that should be fixed.`)
      }
      supplierByMaterial.set(material, parma)
      const key = `${normalizeIdentifier(material)}\u0000${normalizeIdentifier(parma)}`
      const assignment = assignments.get(key) ?? { material, parma, excelRows: [] }
      assignment.excelRows.push(excelRow)
      assignments.set(key, assignment)
    }
    if (!assignments.size) throw new Error('No Material No. and Parma values were found in the uploaded workbook.')
    let skippedBlankRows = 0
    for (let excelRow = 2; excelRow <= lastInputRow; excelRow += 1) {
      const cells = worksheet.rows.get(excelRow)
      if (!(cells?.get(materialColumn)?.trim() ?? '') && !(cells?.get(parmaColumn)?.trim() ?? '')) {
        skippedBlankRows += 1
      }
    }

    const sample: Me01PreviewRow[] = [...assignments.values()]
      .slice(0, 12)
      .map(({ material, parma, excelRows }) => ({ material, parma, excelRows }))
    const totalDataRows = [...assignments.values()].reduce((sum, assignment) => sum + assignment.excelRows.length, 0)
    return {
      sheetName: worksheet.name,
      totalDataRows,
      uniqueMaterials: assignments.size,
      duplicateRows: totalDataRows - assignments.size,
      skippedBlankRows,
      sample
    }
  }
}

function normalizeIdentifier(value: string): string {
  const trimmed = value.trim()
  return /^\d+$/.test(trimmed) ? trimmed.replace(/^0+(?=\d)/, '') : trimmed.toUpperCase()
}

async function validateWorkbook(filePath: string): Promise<void> {
  const extension = extname(filePath).toLowerCase()
  if (extension !== '.xlsx' && extension !== '.xlsm') {
    throw new Error('Select an Excel workbook in .xlsx or .xlsm format.')
  }
  const file = await stat(filePath)
  if (!file.isFile()) throw new Error('The selected ME01 workbook was not found.')
  if (file.size > 20 * 1024 * 1024) throw new Error('The ME01 workbook must be 20 MB or smaller.')
}

async function readWorksheet(filePath: string): Promise<ParsedWorksheet> {
  const archive = unzipSync(new Uint8Array(await readFile(filePath)))
  const workbookXml = archiveText(archive, 'xl/workbook.xml')
  const relationshipXml = archiveText(archive, 'xl/_rels/workbook.xml.rels')
  const sharedStrings = parseSharedStrings(archive['xl/sharedStrings.xml'])
  const sheets = [...workbookXml.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/gi)].map((match) => ({
    name: decodeXml(attribute(match[1], 'name')),
    relationshipId: attribute(match[1], 'r:id') || attribute(match[1], 'id')
  }))
  const selected = sheets.find((sheet) => sheet.name.toLowerCase() === 'me01_input') ?? sheets[0]
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
      const letters = reference.match(/^([A-Z]+)\d+$/i)?.[1]
      if (!letters) continue
      const type = attribute(cellMatch[1], 't')
      const body = cellMatch[2] ?? ''
      const raw = type === 'inlineStr'
        ? extractText(body)
        : body.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/i)?.[1] ?? ''
      const value = type === 's' ? sharedStrings[Number(raw)] ?? '' : decodeXml(raw)
      cells.set(columnNumber(letters), value.trim())
    }
    rows.set(rowNumber, cells)
    maxRow = Math.max(maxRow, rowNumber)
  }
  return { name: selected.name, rows, maxRow }
}

function findHeaderColumn(headers: Map<number, string>, aliases: string[]): number {
  for (const [column, value] of headers) {
    if (aliases.includes(value.trim().toLowerCase().replace(/\s+/g, ' '))) return column
  }
  return 0
}

function parseSharedStrings(content: Uint8Array | undefined): string[] {
  if (!content) return []
  return [...strFromU8(content).matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/gi)]
    .map((match) => extractText(match[1]))
}

function extractText(xml: string): string {
  return [...xml.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi)]
    .map((match) => decodeXml(match[1])).join('')
}

function attribute(xml: string, name: string): string {
  return xml.match(new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}="([^"]*)"`, 'i'))?.[1] ?? ''
}

function archiveText(archive: Record<string, Uint8Array>, path: string): string {
  const content = archive[path]
  if (!content) throw new Error(`The Excel package is missing ${path}.`)
  return strFromU8(content)
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function columnNumber(letters: string): number {
  return letters.toUpperCase().split('').reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0)
}
