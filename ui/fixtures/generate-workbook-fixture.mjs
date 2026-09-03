import { createRequire } from 'node:module';
import fs from 'node:fs/promises';

const require = createRequire(import.meta.url);
const JSZip = require('../vendor/jszip-3.10.1.min.cjs');

const fixedDate = new Date('2026-01-01T00:00:00Z');
const zip = new JSZip();
const sharedStrings = [];
const sharedStringIndex = new Map();

function xml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function shared(value) {
    if (!sharedStringIndex.has(value)) {
        sharedStringIndex.set(value, sharedStrings.length);
        sharedStrings.push(value);
    }
    return sharedStringIndex.get(value);
}

function stringCell(ref, value, style = 0) {
    return `<c r="${ref}" s="${style}" t="s"><v>${shared(value)}</v></c>`;
}

function numberCell(ref, value, style = 0) {
    return `<c r="${ref}" s="${style}" t="n"><v>${value}</v></c>`;
}

function formulaCell(ref, formula, value = 0, style = 0) {
    return `<c r="${ref}" s="${style}"><f>${xml(formula)}</f><v>${value}</v></c>`;
}

zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet4.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);

zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);

zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Fixture</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created></cp:coreProperties>`);
zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Codex fixture</Application></Properties>`);

zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews><workbookView activeTab="0"/></bookViews>
  <sheets>
    <sheet name="多表头" sheetId="1" r:id="rId1"/>
    <sheet name="已有时间" sheetId="2" r:id="rId2"/>
    <sheet name="歧义列" sheetId="3" r:id="rId3"/>
    <sheet name="不支持" sheetId="4" r:id="rId4"/>
  </sheets>
  <definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'多表头'!$A$3:$E$5</definedName><definedName name="FixtureTotal">'多表头'!$D$4</definedName></definedNames>
  <calcPr calcId="191029" fullCalcOnLoad="1"/>
</workbook>`);

zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet4.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`);

const sheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:E5"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="B4" sqref="B4"/></sheetView></sheetViews>
  <cols><col min="1" max="1" width="12" customWidth="1"/><col min="2" max="3" width="30" customWidth="1"/><col min="4" max="5" width="14" customWidth="1"/></cols>
  <sheetData>
    <row r="1" ht="24" customHeight="1">${stringCell('A1', '合成夹具')}</row>
    <row r="2"/>
    <row r="3" ht="22" customHeight="1">${stringCell('A3', '账号', 1)}${stringCell('B3', '主页链接', 1)}${stringCell('C3', '案例展示', 1)}${stringCell('D3', '金额', 1)}${stringCell('E3', '备注', 1)}</row>
    <row r="4">${stringCell('A4', '账号甲')}${stringCell('B4', '抖音主页')}${stringCell('C4', '案例')}${formulaCell('D4', 'SUM(1,2)', 3)}${stringCell('E4', '内部跳转')}</row>
    <row r="5">${stringCell('A5', '账号甲重复')}${stringCell('B5', '抖音主页重复')}${stringCell('C5', '案例重复')}${formulaCell('D5', 'D4*2', 6)}${stringCell('E5', '普通文本')}</row>
  </sheetData>
  <mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>
  <autoFilter ref="A3:E5"/>
  <hyperlinks><hyperlink ref="B4" r:id="rId1"/><hyperlink ref="B5" r:id="rId1"/><hyperlink ref="C4" r:id="rId2"/><hyperlink ref="E4" location="'已有时间'!A1" display="跳转"/></hyperlinks>
  <tableParts count="1"><tablePart r:id="rId3"/></tableParts>
</worksheet>`;
zip.file('xl/worksheets/sheet1.xml', sheet1);
zip.file('xl/worksheets/_rels/sheet1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://v.douyin.com/fixture-account/" TargetMode="External"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.xingtu.cn/ad/creator/fixture" TargetMode="External"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/>
</Relationships>`);

const sheet2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:C3"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetData>
    <row r="1">${stringCell('A1', '链接', 1)}${stringCell('B1', '最新更新时间', 1)}${stringCell('C1', '后续公式', 1)}</row>
    <row r="2">${stringCell('A2', 'B站主页')}${numberCell('B2', '46234.5', 2)}${formulaCell('C2', 'B2+1', '46235.5', 2)}</row>
    <row r="3">${stringCell('A3', 'B站主页重复')}${stringCell('B3', '抓取失败')}${formulaCell('C3', 'IF(B3="",0,1)', 1)}</row>
  </sheetData>
  <hyperlinks><hyperlink ref="A2" r:id="rId1"/><hyperlink ref="A3" r:id="rId1"/></hyperlinks>
</worksheet>`;
zip.file('xl/worksheets/sheet2.xml', sheet2);
zip.file('xl/worksheets/_rels/sheet2.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://space.bilibili.com/2267573" TargetMode="External"/></Relationships>`);

const sheet3 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:E4"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetData>
    <row r="1">${stringCell('A1', '说明')}</row>
    <row r="2">${stringCell('A2', '案例展示', 1)}${stringCell('B2', '星图链接', 1)}${stringCell('C2', '蒲公英链接', 1)}${stringCell('D2', '互选链接', 1)}${stringCell('E2', '链接', 1)}</row>
    <row r="3">${stringCell('A3', '案例')}${stringCell('B3', '星图')}${stringCell('C3', '蒲公英')}${stringCell('D3', '互选')}${stringCell('E3', '小红书主页')}</row>
    <row r="4">${stringCell('E4', '不支持主页')}</row>
  </sheetData>
  <hyperlinks><hyperlink ref="A3" r:id="rId1"/><hyperlink ref="B3" r:id="rId2"/><hyperlink ref="C3" r:id="rId3"/><hyperlink ref="D3" r:id="rId4"/><hyperlink ref="E3" r:id="rId5"/><hyperlink ref="E4" r:id="rId6"/></hyperlinks>
</worksheet>`;
zip.file('xl/worksheets/sheet3.xml', sheet3);
zip.file('xl/worksheets/_rels/sheet3.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://v.douyin.com/excluded-case/" TargetMode="External"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.douyin.com/user/MS4wLjABAAAAexcludedstar" TargetMode="External"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.xiaohongshu.com/user/profile/excludedpgy" TargetMode="External"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://space.bilibili.com/123456" TargetMode="External"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.xiaohongshu.com/user/profile/fixturexhs" TargetMode="External"/>
  <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/profile/unsupported" TargetMode="External"/>
</Relationships>`);

zip.file('xl/worksheets/sheet4.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:A2"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData><row r="1">${stringCell('A1', '链接', 1)}</row><row r="2">${stringCell('A2', '不支持主页')}</row></sheetData><hyperlinks><hyperlink ref="A2" r:id="rId1"/></hyperlinks></worksheet>`);
zip.file('xl/worksheets/_rels/sheet4.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/profile/only-unsupported" TargetMode="External"/></Relationships>`);

zip.file('xl/tables/table1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="FixtureTable" displayName="FixtureTable" ref="A3:E5" totalsRowShown="0"><autoFilter ref="A3:E5"/><tableColumns count="5"><tableColumn id="1" name="账号"/><tableColumn id="2" name="主页链接"/><tableColumn id="3" name="案例展示"/><tableColumn id="4" name="金额"/><tableColumn id="5" name="备注"/></tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`);

zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);

zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sharedStrings.map((value) => `<si><t>${xml(value)}</t></si>`).join('')}</sst>`);

const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' });
await fs.writeFile(new URL('./workbook-complex.xlsx', import.meta.url), output);
console.log(JSON.stringify({ bytes: output.byteLength, sharedStrings: sharedStrings.length }));
