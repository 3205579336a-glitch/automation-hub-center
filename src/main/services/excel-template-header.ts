import { readFile, stat } from 'node:fs/promises'
import { extname, posix } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'

const material = ['part no.', 'part no', 'material', 'material no.']
const vendor = ['vendor', 'supplier', 'parma']
const date = ['apqp plan closure date']
const normalize = (value: string): string => value.trim().toLowerCase()

export class ApqpTemplateError extends Error {}

/** Saved-file header inspection only; does not start Python, Excel or SAP. */
export async function readExcelTemplateHeaders(filePath: string): Promise<{ name: string; headers: string[] }[]> {
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
    return sheets.map(sheet => {
      const path = links.get(sheet.id)
      if (!path) return { name: sheet.name, headers: [] }
      const rowPattern = /<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g
      // Stop after the first row: do not enumerate thousands of data rows just to check headers.
      const row = rowPattern.exec(xml(path))
      if (!row || attribute(row[1], 'r') !== '1') return { name: sheet.name, headers: [] }
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
      return { name: sheet.name, headers }
    })
}

/** Early gate only. The engine still validates the live Excel data before SAP. */
export async function checkApqpTemplateHeaders(filePath: string, sheetName = ''): Promise<void> {
  try {
    const sheets = await readExcelTemplateHeaders(filePath)
    const matches = (sheet: { headers: string[] }): boolean => {
      const headers = Array.from({ length: 5 }, (_, i) => normalize(sheet.headers[i] ?? ''))
      const legacy = material.includes(headers[0]) && ['ver', 'version'].includes(headers[1]) &&
        headers[2] === 'description' && vendor.includes(headers[3]) && date.includes(headers[4])
      const compact = material.includes(headers[0]) && vendor.includes(headers[1]) && date.includes(headers[2]) &&
        !headers.slice(3).some(header => [...material, ...vendor, ...date, 'ver', 'version', 'description'].includes(header))
      return legacy || compact
    }
    if (sheetName) {
      const sheet = sheets.find(sheet => sheet.name === sheetName)
      if (sheet && matches(sheet)) return
    } else {
      const preferred = sheets.find(sheet => sheet.name === 'APQP_Input')
      if (preferred && matches(preferred)) return
      if (sheets.filter(matches).length === 1) return
    }
    throw new Error('APQP headers do not match. Expected A: Part No., B: Vendor, C: APQP plan closure date. Download the template; keep the header row and save before uploading. The previous five-column template is also supported.')
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

function attribute(xml: string, name: string): string {
  return decode(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`).exec(xml)?.[1] ?? '')
}
function textNodes(xml: string): string {
  return [...xml.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(match => decode(match[1])).join('')
}
function decode(xml: string): string {
  return xml.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      return code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()]
  })
}
