import { copyFile, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join, parse, posix } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type {
  Me12BatchConfig,
  Me12ExcelPreview,
  Me12PreviewRow
} from '../../shared/me12-types'

const STATUS_HEADER = 'ME12 Status'
const OLD_VALUE_HEADER = 'Old Supplier Lead Time'
const UPDATED_AT_HEADER = 'ME12 Updated At'

interface ParsedCell {
  column: number
  value: string
}

interface ParsedWorksheet {
  name: string
  path: string
  xml: string
  rows: Map<number, Map<number, string>>
  maxColumn: number
  maxRow: number
}

export interface Me12ExcelTask {
  infoRecord: string
  excelRows: number[]
}

export interface Me12WorkbookSession {
  archive: Record<string, Uint8Array>
  worksheetPath: string
  worksheetXml: string
  worksheetMaxColumn: number
  worksheetMaxRow: number
  tasks: Me12ExcelTask[]
  resultColumns: {
    status: number
    oldValue: number
    updatedAt: number
  }
  updates: Map<number, Map<number, string>>
  originalPath: string
  savePath: string
  backupPath: string
}

export class Me12ExcelService {
  async preview(config: Me12BatchConfig): Promise<Me12ExcelPreview> {
    await validateExcelFile(config.excelPath)
    const workbook = await readWorkbook(config.excelPath, config.sheetName)
    const effectiveConfig = detectColumnMapping(workbook.worksheet, config)
    return analyzeWorksheet(workbook.worksheet, effectiveConfig).preview
  }

  async prepareRun(config: Me12BatchConfig): Promise<Me12WorkbookSession> {
    await validateExcelFile(config.excelPath)
    const backupPath = createTimestampedPath(config.excelPath, 'backup')
    await copyFile(config.excelPath, backupPath)

    const workbook = await readWorkbook(config.excelPath, config.sheetName)
    const effectiveConfig = detectColumnMapping(workbook.worksheet, config)
    const analysis = analyzeWorksheet(workbook.worksheet, effectiveConfig)
    const resultColumns = findResultColumns(workbook.worksheet)
    const updates = new Map<number, Map<number, string>>()
    queueUpdate(updates, 1, resultColumns.status, STATUS_HEADER)
    queueUpdate(updates, 1, resultColumns.oldValue, OLD_VALUE_HEADER)
    queueUpdate(updates, 1, resultColumns.updatedAt, UPDATED_AT_HEADER)

    for (let row = effectiveConfig.dataStartRow; row <= workbook.worksheet.maxRow; row += 1) {
      const cells = workbook.worksheet.rows.get(row)
      const plant = (cells?.get(effectiveConfig.plantColumn) ?? '').trim().toUpperCase()
      const infoRecord = normalizeCode(
        cells?.get(effectiveConfig.infoRecordColumn) ?? '',
        effectiveConfig.infoRecordWidth
      )
      if (plant === effectiveConfig.targetPlant.toUpperCase() && !infoRecord) {
        queueResult(
          updates,
          resultColumns,
          [row],
          '',
          'Skipped: Info Record is empty'
        )
      }
    }

    return {
      archive: workbook.archive,
      worksheetPath: workbook.worksheet.path,
      worksheetXml: workbook.worksheet.xml,
      worksheetMaxColumn: workbook.worksheet.maxColumn,
      worksheetMaxRow: workbook.worksheet.maxRow,
      tasks: analysis.tasks,
      resultColumns,
      updates,
      originalPath: config.excelPath,
      savePath: config.excelPath,
      backupPath
    }
  }

  writeTaskResult(
    session: Me12WorkbookSession,
    task: Me12ExcelTask,
    oldValue: string,
    status: string
  ): void {
    queueResult(
      session.updates,
      session.resultColumns,
      task.excelRows,
      oldValue,
      status
    )
  }

  async saveCheckpoint(session: Me12WorkbookSession): Promise<string> {
    const source = parse(session.originalPath)
    const temporaryPath = join(
      dirname(session.savePath),
      `.${source.name}.me12-write-${Date.now()}${source.ext}`
    )
    const updatedWorksheet = applyUpdates(
      session.worksheetXml,
      session.updates,
      Math.max(
        session.worksheetMaxColumn,
        session.resultColumns.status,
        session.resultColumns.oldValue,
        session.resultColumns.updatedAt
      ),
      session.worksheetMaxRow,
      session.resultColumns
    )
    const archive = { ...session.archive, [session.worksheetPath]: strToU8(updatedWorksheet) }
    await writeFile(temporaryPath, zipSync(archive, { level: 6 }))

    try {
      await copyFile(temporaryPath, session.savePath)
      await unlink(temporaryPath).catch(() => undefined)
      return session.savePath
    } catch (error) {
      if (session.savePath !== session.originalPath || !isPermissionError(error)) {
        await unlink(temporaryPath).catch(() => undefined)
        throw error
      }

      const fallbackPath = createTimestampedPath(session.originalPath, 'ME12_result')
      await rename(temporaryPath, fallbackPath)
      session.savePath = fallbackPath
      return fallbackPath
    }
  }
}

async function readWorkbook(
  filePath: string,
  requestedSheetName: string
): Promise<{ archive: Record<string, Uint8Array>; worksheet: ParsedWorksheet }> {
  const archive = unzipSync(new Uint8Array(await readFile(filePath)))
  const workbookXml = readArchiveText(archive, 'xl/workbook.xml')
  const relationshipsXml = readArchiveText(archive, 'xl/_rels/workbook.xml.rels')
  const sharedStrings = parseSharedStrings(archive['xl/sharedStrings.xml'])
  const sheets = parseSheets(workbookXml)
  const selected = requestedSheetName
    ? sheets.find((sheet) => sheet.name === requestedSheetName)
    : sheets[0]
  if (!selected) {
    throw new Error(
      requestedSheetName
        ? `Worksheet "${requestedSheetName}" was not found.`
        : 'The workbook has no worksheets.'
    )
  }

  const relationships = parseRelationships(relationshipsXml)
  const target = relationships.get(selected.relationshipId)
  if (!target) {
    throw new Error(`The worksheet relationship for "${selected.name}" is missing.`)
  }
  const worksheetPath = normalizeWorksheetPath(target)
  const worksheetXml = readArchiveText(archive, worksheetPath)
  return {
    archive,
    worksheet: parseWorksheet(selected.name, worksheetPath, worksheetXml, sharedStrings)
  }
}

function parseSheets(xml: string): Array<{ name: string; relationshipId: string }> {
  const sheets: Array<{ name: string; relationshipId: string }> = []
  for (const match of xml.matchAll(/<sheet\b([^>]*)\/?>/gi)) {
    const attributes = match[1]
    const name = attributeValue(attributes, 'name')
    const relationshipId =
      attributeValue(attributes, 'r:id') || attributeValue(attributes, 'id')
    if (name && relationshipId) {
      sheets.push({ name: decodeXml(name), relationshipId })
    }
  }
  return sheets
}

function parseRelationships(xml: string): Map<string, string> {
  const relationships = new Map<string, string>()
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>/gi)) {
    const id = attributeValue(match[1], 'Id')
    const target = attributeValue(match[1], 'Target')
    if (id && target) {
      relationships.set(id, decodeXml(target))
    }
  }
  return relationships
}

function normalizeWorksheetPath(target: string): string {
  const withoutRoot = target.replace(/^\/+/, '')
  return withoutRoot.startsWith('xl/')
    ? posix.normalize(withoutRoot)
    : posix.normalize(posix.join('xl', withoutRoot))
}

function parseSharedStrings(content: Uint8Array | undefined): string[] {
  if (!content) {
    return []
  }
  const xml = strFromU8(content)
  const strings: string[] = []
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
    strings.push(extractTextNodes(match[1]))
  }
  return strings
}

function parseWorksheet(
  name: string,
  path: string,
  xml: string,
  sharedStrings: string[]
): ParsedWorksheet {
  const rows = new Map<number, Map<number, string>>()
  let maxColumn = 0
  let maxRow = 0

  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gi)) {
    const rowNumber = Number(attributeValue(rowMatch[1], 'r'))
    if (!Number.isInteger(rowNumber) || rowNumber < 1) {
      continue
    }
    const rowCells = new Map<number, string>()
    for (const cell of parseCells(rowMatch[2], sharedStrings)) {
      rowCells.set(cell.column, cell.value)
      maxColumn = Math.max(maxColumn, cell.column)
    }
    rows.set(rowNumber, rowCells)
    maxRow = Math.max(maxRow, rowNumber)
  }

  return { name, path, xml, rows, maxColumn, maxRow }
}

function parseCells(rowXml: string, sharedStrings: string[]): ParsedCell[] {
  const cells: ParsedCell[] = []
  const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi
  for (const match of rowXml.matchAll(cellPattern)) {
    const reference = attributeValue(match[1], 'r')
    const referenceMatch = reference.match(/^([A-Z]+)\d+$/i)
    if (!referenceMatch) {
      continue
    }
    const type = attributeValue(match[1], 't')
    const body = match[2] ?? ''
    let value = ''
    if (type === 'inlineStr') {
      value = extractTextNodes(body)
    } else {
      const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? ''
      value = type === 's'
        ? sharedStrings[Number(raw)] ?? ''
        : decodeXml(raw)
    }
    cells.push({ column: columnNumber(referenceMatch[1]), value })
  }
  return cells
}

function analyzeWorksheet(
  worksheet: ParsedWorksheet,
  config: Me12BatchConfig
): { preview: Me12ExcelPreview; tasks: Me12ExcelTask[] } {
  const rowsByInfoRecord = new Map<string, number[]>()
  let matchedRows = 0
  let skippedOtherPlant = 0
  let skippedEmptyInfoRecord = 0

  for (let row = config.dataStartRow; row <= worksheet.maxRow; row += 1) {
    const cells = worksheet.rows.get(row)
    const plant = (cells?.get(config.plantColumn) ?? '').trim().toUpperCase()
    if (plant !== config.targetPlant.toUpperCase()) {
      skippedOtherPlant += 1
      continue
    }

    matchedRows += 1
    const infoRecord = normalizeCode(
      cells?.get(config.infoRecordColumn) ?? '',
      config.infoRecordWidth
    )
    if (!infoRecord) {
      skippedEmptyInfoRecord += 1
      continue
    }
    const rows = rowsByInfoRecord.get(infoRecord) ?? []
    rows.push(row)
    rowsByInfoRecord.set(infoRecord, rows)
  }

  const allTasks = [...rowsByInfoRecord.entries()].map(([infoRecord, excelRows]) => ({
    infoRecord,
    excelRows
  }))
  const tasks = config.maxItems > 0 ? allTasks.slice(0, config.maxItems) : allTasks
  const sample: Me12PreviewRow[] = tasks.slice(0, 10).map((task) => ({
    ...task,
    plant: config.targetPlant.toUpperCase()
  }))

  return {
    tasks,
    preview: {
      sheetName: worksheet.name,
      infoRecordColumn: config.infoRecordColumn,
      plantColumn: config.plantColumn,
      dataStartRow: config.dataStartRow,
      totalDataRows: Math.max(0, worksheet.maxRow - config.dataStartRow + 1),
      matchedRows,
      uniqueInfoRecords: allTasks.length,
      selectedInfoRecords: tasks.length,
      duplicateRows: Math.max(0, matchedRows - skippedEmptyInfoRecord - allTasks.length),
      skippedOtherPlant,
      skippedEmptyInfoRecord,
      limitedByMaxItems: config.maxItems > 0 && allTasks.length > tasks.length,
      sample
    }
  }
}

function detectColumnMapping(
  worksheet: ParsedWorksheet,
  config: Me12BatchConfig
): Me12BatchConfig {
  const headers = worksheet.rows.get(1)
  if (!headers) {
    return config
  }
  let infoRecordColumn: number | undefined
  let plantColumn: number | undefined
  for (const [column, value] of headers) {
    const header = value.trim().toLowerCase().replace(/\s+/g, ' ')
    if (
      header === 'purchasing info rec.' ||
      header === 'purchasing info record' ||
      header === 'info record'
    ) {
      infoRecordColumn = column
    }
    if (header === 'plant') {
      plantColumn = column
    }
  }
  if (infoRecordColumn === undefined && plantColumn === undefined) {
    return config
  }
  return {
    ...config,
    infoRecordColumn: infoRecordColumn ?? config.infoRecordColumn,
    plantColumn: plantColumn ?? config.plantColumn,
    dataStartRow: 2
  }
}

function findResultColumns(
  worksheet: ParsedWorksheet
): Me12WorkbookSession['resultColumns'] {
  const headerRow = worksheet.rows.get(1) ?? new Map<number, string>()
  const headers = new Map<string, number>()
  for (const [column, value] of headerRow) {
    if (value.trim()) {
      headers.set(value.trim(), column)
    }
  }
  let nextColumn = Math.max(worksheet.maxColumn, ...headers.values(), 0) + 1
  const findOrAppend = (header: string): number => {
    const existing = headers.get(header)
    if (existing) {
      return existing
    }
    const column = nextColumn
    nextColumn += 1
    headers.set(header, column)
    return column
  }
  return {
    status: findOrAppend(STATUS_HEADER),
    oldValue: findOrAppend(OLD_VALUE_HEADER),
    updatedAt: findOrAppend(UPDATED_AT_HEADER)
  }
}

function queueResult(
  updates: Map<number, Map<number, string>>,
  columns: Me12WorkbookSession['resultColumns'],
  rows: number[],
  oldValue: string,
  status: string
): void {
  const updatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19)
  for (const row of rows) {
    queueUpdate(updates, row, columns.oldValue, oldValue)
    queueUpdate(updates, row, columns.status, status)
    queueUpdate(updates, row, columns.updatedAt, updatedAt)
  }
}

function queueUpdate(
  updates: Map<number, Map<number, string>>,
  row: number,
  column: number,
  value: string
): void {
  const rowUpdates = updates.get(row) ?? new Map<number, string>()
  rowUpdates.set(column, value)
  updates.set(row, rowUpdates)
}

function applyUpdates(
  worksheetXml: string,
  updates: Map<number, Map<number, string>>,
  maxColumn: number,
  maxRow: number,
  resultColumns: Me12WorkbookSession['resultColumns']
): string {
  let xml = worksheetXml.replace(
    /<dimension\b[^>]*\bref="[^"]*"[^>]*\/>/i,
    `<dimension ref="A1:${columnLetters(maxColumn)}${maxRow}"/>`
  )
  xml = applyColumnWidths(xml, [
    [resultColumns.status, 58],
    [resultColumns.oldValue, 24],
    [resultColumns.updatedAt, 22]
  ])
  const pendingRows = new Set(updates.keys())
  xml = xml.replace(
    /<row\b([^>]*)>([\s\S]*?)<\/row>/gi,
    (rowXml: string, attributes: string): string => {
      const rowNumber = Number(attributeValue(attributes, 'r'))
      const rowUpdates = updates.get(rowNumber)
      if (!rowUpdates) {
        return rowXml
      }
      pendingRows.delete(rowNumber)
      let updatedRow = rowXml
      for (const [column, value] of [...rowUpdates.entries()].sort((a, b) => a[0] - b[0])) {
        const reference = `${columnLetters(column)}${rowNumber}`
        const cellXml = inlineStringCell(reference, value)
        const existingCell = new RegExp(
          `<c(?=[^>]*\\br="${escapeRegExp(reference)}")[^>]*(?:\\/>|>[\\s\\S]*?<\\/c>)`,
          'i'
        )
        updatedRow = existingCell.test(updatedRow)
          ? updatedRow.replace(existingCell, cellXml)
          : updatedRow.replace('</row>', `${cellXml}</row>`)
      }
      return updatedRow
    }
  )

  if (pendingRows.size > 0) {
    throw new Error(`Unable to write result rows: ${[...pendingRows].join(', ')}`)
  }
  return xml
}

function applyColumnWidths(xml: string, widths: Array<[number, number]>): string {
  const definitions = widths
    .map(
      ([column, width]) =>
        `<col min="${column}" max="${column}" width="${width}" customWidth="1"/>`
    )
    .join('')
  if (/<cols\b[^>]*>[\s\S]*?<\/cols>/i.test(xml)) {
    return xml.replace(/<\/cols>/i, `${definitions}</cols>`)
  }
  if (/<sheetFormatPr\b[^>]*\/>/i.test(xml)) {
    return xml.replace(
      /(<sheetFormatPr\b[^>]*\/>)/i,
      `$1<cols>${definitions}</cols>`
    )
  }
  return xml.replace(/<sheetData\b/i, `<cols>${definitions}</cols><sheetData`)
}

function inlineStringCell(reference: string, value: string): string {
  const preserveSpace = /^\s|\s$/.test(value) ? ' xml:space="preserve"' : ''
  return `<c r="${reference}" t="inlineStr"><is><t${preserveSpace}>${encodeXml(value)}</t></is></c>`
}

function normalizeCode(value: string, width: number): string {
  const text = value.trim().replace(/\.0$/, '')
  return width > 0 && /^\d+$/.test(text) ? text.padStart(width, '0') : text
}

function readArchiveText(archive: Record<string, Uint8Array>, path: string): string {
  const content = archive[path]
  if (!content) {
    throw new Error(`The workbook entry "${path}" is missing.`)
  }
  return strFromU8(content)
}

function extractTextNodes(xml: string): string {
  return [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
    .map((match) => decodeXml(match[1]))
    .join('')
}

function attributeValue(attributes: string, name: string): string {
  const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(name)}="([^"]*)"`, 'i')
  return attributes.match(pattern)?.[1] ?? ''
}

function columnNumber(letters: string): number {
  let result = 0
  for (const character of letters.toUpperCase()) {
    result = result * 26 + character.charCodeAt(0) - 64
  }
  return result
}

function columnLetters(column: number): string {
  let value = column
  let result = ''
  while (value > 0) {
    value -= 1
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

function encodeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

async function validateExcelFile(path: string): Promise<void> {
  if (!path.trim()) {
    throw new Error('Select an Excel workbook.')
  }
  const extension = extname(path).toLowerCase()
  if (extension !== '.xlsx' && extension !== '.xlsm') {
    throw new Error('The ME12 batch supports .xlsx and .xlsm files.')
  }
  const file = await stat(path)
  if (!file.isFile()) {
    throw new Error('The selected Excel path is not a file.')
  }
}

function createTimestampedPath(path: string, suffix: string): string {
  const parts = parse(path)
  const timestamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  return join(parts.dir, `${parts.name}_${suffix}_${timestamp}${parts.ext}`)
}

function isPermissionError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'EACCES' || error.code === 'EPERM')
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
