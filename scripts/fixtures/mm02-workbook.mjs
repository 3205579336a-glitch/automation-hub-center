import { strToU8, zipSync } from 'fflate'

export const workbookFixture = (rows, header = 'Sub-commodity') => zipSync({
  'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="MM02_Input" r:id="rId1"/></sheets></workbook>'),
  'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
  'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData><row r="1">${cell('A1', 'Material')}${cell('B1', header)}</row>${rows}</sheetData></worksheet>`)
})
export function cell(ref, value) { return `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>` }
export function row(index, a, b) { return `<row r="${index}">${cell(`A${index}`, a)}${cell(`B${index}`, b)}</row>` }
