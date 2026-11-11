import { createHash } from 'node:crypto'
import type { Mm02Preview, Mm02Task } from '../../shared/mm02-types'
import { attribute, decode, readExcelTemplateWorkbook, textNodes } from './excel-template-header'

const MAX_MATERIALS = 5_000
const MAX_INPUT_ROWS = 20_000
const HEADER_ERROR = 'MM02 requires A1 = Material and B1 = Sub-commodity. Download the template and keep the two headers. / 请使用 MM02 模板，保留 A1 = Material、B1 = Sub-commodity。'
const ID = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$/
const normalize = (value = ''): string => value.trim().toLowerCase().replace(/[‐‑–—]/g, '-')

export async function readMm02Input(filePath: string): Promise<{ preview: Mm02Preview; tasks: Mm02Task[] }> {
  const { sheets, strings } = await readExcelTemplateWorkbook(filePath)
  const compatible = ({ headers }: { headers: string[] }): boolean =>
    normalize(headers[0]) === 'material' && normalize(headers[1]) === 'sub-commodity' &&
    !headers.slice(2).some(value => value?.trim())
  const preferred = sheets.find(sheet => sheet.name.toLowerCase() === 'mm02_input')
  const candidates = sheets.filter(compatible)
  const sheet = preferred ? (compatible(preferred) ? preferred : null) : candidates.length === 1 ? candidates[0] : null
  if (!sheet) throw new Error(HEADER_ERROR)

  const unique = new Map<string, Mm02Task>()
  let rows = 0
  for (const row of sheet.xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const excelRow = Number(attribute(row[1], 'r'))
    if (!Number.isInteger(excelRow) || excelRow < 2 || excelRow > 1_048_576 || !row[2]) continue
    const inputs = new Map<string, string>()
    for (const cell of row[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const ref = attribute(cell[1], 'r')
      if (ref !== `A${excelRow}` && ref !== `B${excelRow}`) continue
      if (inputs.has(ref)) throw new Error(`Excel row ${excelRow}: duplicate cell ${ref}.`)
      const body = cell[2] ?? ''
      const type = attribute(cell[1], 't')
      const raw = decode(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1] ?? '')
      const value = (type === 'inlineStr' ? textNodes(body) : type === 's' ? (/^\d+$/.test(raw) ? strings[Number(raw)] ?? '' : '') : raw).trim()
      if (/<(?:\w+:)?f\b/.test(body) || (value && !['', 'n', 's', 'inlineStr', 'str'].includes(type))) {
        throw new Error(`Excel row ${excelRow}: ${ref[0] === 'A' ? 'Material' : 'Sub-commodity'} must be a plain value, not a formula, date or error. / 请填写原始编号，不要使用公式或日期。`)
      }
      if (value && ['', 'n'].includes(type) && !/^\d{1,15}$/.test(value)) {
        throw new Error(`Excel row ${excelRow}: enter ${ref[0] === 'A' ? 'Material' : 'Sub-commodity'} as text to preserve the exact code. / 请使用文本格式填写编号。`)
      }
      inputs.set(ref, value)
    }
    const material = inputs.get(`A${excelRow}`) ?? ''
    const subCommodity = inputs.get(`B${excelRow}`) ?? ''
    if (!material && !subCommodity) continue
    if (!ID.test(material)) throw new Error(`Excel row ${excelRow}: enter a valid Material. / 第 ${excelRow} 行：请填写有效物料号。`)
    if (!/^\d{6}$/.test(subCommodity)) throw new Error(`Excel row ${excelRow}: Sub-commodity must contain exactly 6 digits. Keep any leading zeros. / 第 ${excelRow} 行：Sub-commodity 必须是 6 位数字，保留前导零。`)
    rows++
    if (rows > MAX_INPUT_ROWS) throw new Error(`Use at most ${MAX_INPUT_ROWS} filled rows per upload. / 请拆分 Excel 后上传。`)
    const key = /^\d+$/.test(material) ? material.replace(/^0+(?=\d)/, '') : material.toUpperCase()
    const previous = unique.get(key)
    if (previous) {
      if (previous.subCommodity !== subCommodity) throw new Error(`Excel rows ${previous.excelRows[0]} and ${excelRow}: Material ${material} has conflicting Sub-commodity values. / 同一物料的目标值冲突。`)
      previous.excelRows.push(excelRow)
    } else unique.set(key, { material, subCommodity, excelRows: [excelRow] })
    if (unique.size > MAX_MATERIALS) throw new Error(`Use at most ${MAX_MATERIALS} materials per upload. / 请拆分 Excel 后上传。`)
  }
  const tasks = [...unique.values()]
  if (!tasks.length) throw new Error('Fill at least one Material and Sub-commodity row, then save Excel and upload again. / 至少填写一行物料和 Sub-commodity，保存后重新上传。')
  const token = createHash('sha256').update(JSON.stringify([sheet.name, tasks])).digest('hex')
  return { tasks, preview: { sheetName: sheet.name, uniqueMaterials: tasks.length, duplicateRows: rows - tasks.length, sample: tasks.slice(0, 12), token } }
}
