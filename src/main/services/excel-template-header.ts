import { readFile, stat } from 'node:fs/promises'
import { extname, posix } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'

const material = ['part no.', 'part no', 'material', 'material no.']
const vendor = ['vendor', 'supplier', 'parma']
const date = ['apqp plan closure date']
const normalize = (value: string): string => value.trim().toLowerCase()

export class ApqpTemplateError extends Error {}

export interface ExcelTemplateSheet { name: string; headers: string[]; xml: string }
export interface ExcelTemplateWorkbook { sheets: ExcelTemplateSheet[]; strings: string[] }

/** Saved-file header inspection only; does not start Python, Excel or SAP. */
export async function readExcelTemplateHeaders(filePath: string): Promise<{ name: string; headers: string[] }[]> {
  return (await readExcelTemplateWorkbook(filePath)).sheets.map(({ name, headers }) => ({ name, headers }))
}

/** Shared bounded XLSX reader for saved-file previews; never opens Excel. */
export async function readExcelTemplateWorkbook(filePath: string): Promise<ExcelTemplateWorkbook> {
    if (!['.xlsx', '.xlsm'].includes(extname(filePath).toLowerCase())) throw new Error('Select an .xlsx or .xlsm file.')
    const file = await stat(filePath)
    if (!file.isFile() || file.size > 100 * 1024 * 1024) throw new Error('Select a workbook smaller than 100 MB.')
    const bytes = new Uint8Array(await readFile(filePath))
    // Ignore images, embedded objects, styles and all other unused ZIP parts.
    let expanded = 0
    const archive = unzipSync(bytes, { filter: entry => {
      if (!['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml'].includes(entry.name) &&
        !/^xl\/worksheets\/[^/]+\.xml$/.test(entry.name)) return false
      expanded += entry.originalSize
      if (expanded > 256 * 1024 * 1024) throw new Error('The workbook is too large to check safely.')
      return true
    } })
    const xml = (path: string): string => {
      if (!archive[path]) throw new Error('The Excel workbook is incomplete or damaged.')
      return strFromU8(archive[path])
    }
    const sheets = [...xml('xl/workbook.xml').matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/g)].map(match => ({
      name: attribute(match[1], 'name'), id: attribute(match[1], 'r:id') || attribute(match[1], 'id')
    }))
    const links = new Map<string, string>()
    for (const match of xml('xl/_rels/workbook.xml.rels').matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)) {
      if (attribute(match[1], 'TargetMode').toLowerCase() === 'external') continue
      const target = attribute(match[1], 'Target')
      const path = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join('xl', target))
      if (/^xl\/worksheets\/[^/]+\.xml$/.test(path)) links.set(attribute(match[1], 'Id'), path)
    }
    const strings = archive['xl/sharedStrings.xml'] ? [...strFromU8(archive['xl/sharedStrings.xml'])
      .matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map(match => textNodes(match[1])) : []
    return { strings, sheets: sheets.map(sheet => {
      const path = links.get(sheet.id)
      if (!path) return { name: sheet.name, headers: [], xml: '' }
      const sheetXml = xml(path)
      const rowPattern = /<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g
      // Stop after the first row: do not enumerate thousands of data rows just to check headers.
      const row = rowPattern.exec(sheetXml)
      if (!row || attribute(row[1], 'r') !== '1') return { name: sheet.name, headers: [], xml: sheetXml }
      const headers: string[] = []
      for (const cell of row[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const ref = attribute(cell[1], 'r')
        if (!/^[A-Z]{1,3}1$/.test(ref)) continue
        const column = [...ref.slice(0, -1)].reduce((column, letter) => column * 26 + letter.charCodeAt(0) - 64, 0) - 1
        const contents = cell[2] ?? ''
        const value = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(contents)?.[1] ?? ''
        const type = attribute(cell[1], 't')
        headers[column] = type === 's' ? strings[Number(value)] ?? '' : type === 'inlineStr' ? textNodes(contents) : decode(value)
      }
      return { name: sheet.name, headers, xml: sheetXml }
    }) }
}

export function apqpHeaderColumns(headers: string[]): [number, number, number] | null {
  const names = Array.from({ length: 5 }, (_, i) => normalize(headers[i] ?? ''))
  if (material.includes(names[0]) && ['ver', 'version'].includes(names[1]) &&
      names[2] === 'description' && vendor.includes(names[3]) && date.includes(names[4])) return [1, 4, 5]
  if (material.includes(names[0]) && vendor.includes(names[1]) && date.includes(names[2]) &&
      !names.slice(3).some(header => [...material, ...vendor, ...date, 'ver', 'version', 'description'].includes(header))) return [1, 2, 3]
  return null
}

export function selectApqpTemplateSheet<T extends { name: string; headers: string[] }>(sheets: T[], sheetName = ''): T {
  const requested = sheets.find(sheet => sheet.name === sheetName)
  if (sheetName && requested && apqpHeaderColumns(requested.headers)) return requested
  if (!sheetName) {
    const preferred = sheets.find(sheet => sheet.name === 'APQP_Input')
    if (preferred && apqpHeaderColumns(preferred.headers)) return preferred
    const matches = sheets.filter(sheet => apqpHeaderColumns(sheet.headers))
    if (matches.length === 1) return matches[0]
  }
  throw new ApqpTemplateError('APQP headers do not match. Expected A: Part No., B: Vendor, C: APQP plan closure date. Download the template; keep the header row and save before uploading. The previous five-column template is also supported.')
}

/** Early gate only. The engine still validates the live Excel data before SAP. */
export async function checkApqpTemplateHeaders(filePath: string, sheetName = ''): Promise<void> {
  try {
    const sheets = await readExcelTemplateHeaders(filePath)
    selectApqpTemplateSheet(sheets, sheetName)
  } catch (error) {
    throw new ApqpTemplateError(error instanceof Error ? error.message : 'Cannot read the Excel template.')
  }
}

export async function checkRfqTemplateHeaders(filePath: string): Promise<void> {
  const sheets = await readExcelTemplateHeaders(filePath)
  // Mirror only the engine's four mandatory logical headers, not its business/data rules.
  const required = [
    ['plant', 'target plant'],
    ['mpp project no.', 'mpp project no', 'mpp project', 'project no.', 'project no', 'project'],
    ['material', 'material no.', 'material no', 'part number'],
    ['vendor1', 'vendor 1', 'supplier1', 'supplier 1', 'intended supplier', 'supplier parma', 'supplier parma no.', 'supplier parma no', 'parma']
  ]
  const matches = (sheet: { headers: string[] }): boolean => {
    const headers = sheet.headers.map(value => normalize(value).replace(/\s+/g, ' '))
    return required.every(aliases => aliases.some(alias => headers.includes(alias)))
  }
  // The native engine prefers RPA_Input, otherwise the first compatible sheet.
  const preferred = sheets.find(sheet => sheet.name === 'RPA_Input')
  if (preferred ? matches(preferred) : sheets.some(matches)) return
  throw new Error('RFQ 表头不匹配，请下载模板并保留第 1 行表头：Plant、Project No、Material No.、Supplier Parma。RFQ headers do not match. Download the template and keep its first-row headers; save before uploading.')
}

export function attribute(xml: string, name: string): string {
  return decode(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`).exec(xml)?.[1] ?? '')
}
export function textNodes(xml: string): string {
  return [...xml.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(match => decode(match[1])).join('')
}
export function decode(xml: string): string {
  return xml.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      return code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()]
  })
}
