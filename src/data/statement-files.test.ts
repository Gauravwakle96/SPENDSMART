import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { detectStatementMapping, MAX_IMPORT_ROWS, parseStatementFiles } from './statement-files';

function file(name: string, content: BlobPart, type: string): File {
  return new File([content], name, { type });
}

function xlsxFile(): File {
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Transaction Date</t></is></c><c r="B1" t="inlineStr"><is><t>Narration</t></is></c><c r="C1" t="inlineStr"><is><t>Debit Amount</t></is></c><c r="D1" t="inlineStr"><is><t>Credit Amount</t></is></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>20/04/2026</t></is></c><c r="B2" t="inlineStr"><is><t>Grocery store</t></is></c><c r="C2"><v>123.45</v></c><c r="D2"/></row>
    </sheetData></worksheet>`;
  const archive = zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Statement" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  });
  return file('statement.xlsx', archive, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

describe('statement file parsing', () => {
  it('parses CSV headers after bank preamble rows and detects reordered columns', async () => {
    const csv = 'Account statement\nGenerated locally\nCredit Amount,Narration,Transaction Date,Debit Amount,Reference No\n,Grocery store,20/04/2026,123.45,ABC-1\n500.00,Salary,01/04/2026,,ABC-2\n';
    const [parsed] = await parseStatementFiles([file('statement.csv', csv, 'text/csv')]);
    expect(parsed.headerRowNumber).toBe(3);
    expect(parsed.mapping).toMatchObject({ credit: 0, description: 1, date: 2, debit: 3, reference: 4 });
    expect(parsed.rows).toHaveLength(2);
  });

  it('parses a valid XLSX statement in the browser-compatible path', async () => {
    const [parsed] = await parseStatementFiles([xlsxFile()]);
    expect(parsed.format).toBe('xlsx');
    expect(parsed.rows[0]).toEqual(['20/04/2026', 'Grocery store', '123.45', '']);
    expect(parsed.mapping.debit).toBe(2);
  });

  it('reports missing required mappings without silently guessing', () => {
    const result = detectStatementMapping(['Date', 'Narration', 'Balance']);
    expect(result.mapping.date).toBe(0);
    expect(result.mapping.description).toBe(1);
    expect(result.mapping.amount).toBeNull();
    expect(result.warnings.join(' ')).toContain('signed amount');
  });

  it('rejects empty, unsupported, MIME-mismatched, and malformed CSV files', async () => {
    await expect(parseStatementFiles([file('empty.csv', '', 'text/csv')])).rejects.toThrow(/empty/);
    await expect(parseStatementFiles([file('statement.pdf', 'x', 'application/pdf')])).rejects.toThrow(/CSV and XLSX/);
    await expect(parseStatementFiles([file('statement.csv', 'Date,Amount', 'application/pdf')])).rejects.toThrow(/does not match/);
    await expect(parseStatementFiles([file('statement.csv', 'Date,Narration,Amount\n"broken,food,10', 'text/csv')])).rejects.toThrow(/unclosed/);
  });

  it('accepts the documented row limit and rejects sessions above it', async () => {
    const header = 'Date,Narration,Debit Amount\n';
    const rows = Array.from({ length: MAX_IMPORT_ROWS }, (_, index) => `20/04/2026,Row ${index + 1},1.00`).join('\n');
    const parsed = await parseStatementFiles([file('limit.csv', header + rows, 'text/csv')]);
    expect(parsed[0].rows).toHaveLength(MAX_IMPORT_ROWS);
    await expect(parseStatementFiles([file('over.csv', `${header}${rows}\n20/04/2026,Extra,1.00`, 'text/csv')])).rejects.toThrow(String(MAX_IMPORT_ROWS));
  });
});
