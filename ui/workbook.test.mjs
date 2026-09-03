import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
    createWorkbookPlan,
    excelSerialFromInstant,
    getWorkbookCell,
    isRetryableWorkbookValue,
    inspectWorkbook,
    outputWorkbookName,
    setWorkbookZipEngine,
    validateWorkbookFile,
    verifyWorkbookOutput,
    writeWorkbookResults,
} from './workbook.mjs';
import { compareWorkbookFingerprints, fingerprintWorkbook } from './workbook-fidelity.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('./vendor/jszip-3.10.1.min.cjs');
setWorkbookZipEngine(JSZip);

const fixturePath = new URL('./fixtures/workbook-complex.xlsx', import.meta.url);
const fixtureBytes = new Uint8Array(await fs.readFile(fixturePath));

async function model() {
    return inspectWorkbook(fixtureBytes, { fileName: 'workbook-complex.xlsx' });
}

function defaultSelections(workbook) {
    return Object.fromEntries(workbook.sheets.filter((sheet) => sheet.defaultCandidate).map((sheet) => [sheet.name, sheet.defaultCandidate.columnIndex]));
}

function resultMap(plan, overrides = {}) {
    return Object.fromEntries(plan.tasks.map((task) => [task.key, overrides[task.platform] ?? {
        status: 'success',
        latestTime: task.platform === '抖音' ? '2026-08-20T04:00:00.000Z' : task.platform === 'B站' ? '2026-08-19T16:00:00.000Z' : '2026-08-18T01:30:00.000Z',
    }]));
}

async function xmlPart(bytes, partName) {
    const zip = await JSZip.loadAsync(bytes);
    return zip.file(partName)?.async('string') ?? '';
}

test('accepts a real xlsx envelope and ZIP package', async () => {
    const result = await validateWorkbookFile({ name: '复杂工作簿.xlsx', size: fixtureBytes.byteLength, bytes: fixtureBytes });
    assert.equal(result.ok, true);
});

test('rejects xls xlsm csv and disguised extensions', async () => {
    for (const name of ['旧版.xls', '宏文件.xlsm', '文本.csv', '伪装.xlsx.csv']) {
        await assert.rejects(() => validateWorkbookFile({ name, size: fixtureBytes.byteLength, bytes: fixtureBytes }), /只支持.*\.xlsx/);
    }
});

test('rejects files larger than twenty MiB', async () => {
    await assert.rejects(() => validateWorkbookFile({ name: '太大.xlsx', size: 20 * 1024 * 1024 + 1, bytes: fixtureBytes }), /20 MB/);
});

test('rejects a fake xlsx with an invalid ZIP signature', async () => {
    await assert.rejects(() => validateWorkbookFile({ name: '伪装.xlsx', size: 8, bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }), /不是有效的 XLSX/);
});

test('finds all worksheets and actual header rows', async () => {
    const workbook = await model();
    assert.deepEqual(workbook.sheets.map((sheet) => sheet.name), ['多表头', '已有时间', '歧义列', '不支持']);
    assert.equal(workbook.sheets[0].headerRow, 3);
    assert.equal(workbook.sheets[1].headerRow, 1);
    assert.equal(workbook.sheets[2].headerRow, 2);
});

test('prefers homepage link then link and excludes business link columns by default', async () => {
    const workbook = await model();
    const multiHeader = workbook.sheets.find((sheet) => sheet.name === '多表头');
    assert.equal(multiHeader.defaultCandidate.header, '主页链接');
    assert.equal(multiHeader.defaultCandidate.columnIndex, 2);
    assert.equal(multiHeader.defaultCandidate.hitCount, 2);
    assert.equal(multiHeader.candidates.find((candidate) => candidate.header === '案例展示').excludedFromDefault, true);

    const ambiguous = workbook.sheets.find((sheet) => sheet.name === '歧义列');
    assert.equal(ambiguous.defaultCandidate.header, '链接');
    for (const header of ['案例展示', '星图链接', '蒲公英链接', '互选链接']) {
        assert.equal(ambiguous.candidates.find((candidate) => candidate.header === header).excludedFromDefault, true);
    }
});

test('detects and reuses only an adjacent exact latest-time column', async () => {
    const workbook = await model();
    const existing = workbook.sheets.find((sheet) => sheet.name === '已有时间').defaultCandidate;
    assert.equal(existing.header, '链接');
    assert.equal(existing.timeColumnIndex, 2);
    assert.equal(existing.reusesTimeColumn, true);
    assert.equal(workbook.sheets.find((sheet) => sheet.name === '多表头').defaultCandidate.reusesTimeColumn, false);
});

test('deduplicates accounts across the workbook and retains all occurrences', async () => {
    const workbook = await model();
    const plan = createWorkbookPlan(workbook, { selections: defaultSelections(workbook), mode: 'refresh' });
    assert.equal(plan.occurrenceCount, 5);
    assert.equal(plan.tasks.length, 3);
    assert.deepEqual(plan.tasks.map((task) => task.occurrences.length).sort(), [1, 2, 2]);
    assert.equal(plan.skippedUnsupported.length, 2);
});

test('continue mode only schedules blanks and explicit error text', async () => {
    const workbook = await model();
    const refresh = createWorkbookPlan(workbook, { selections: defaultSelections(workbook), mode: 'refresh' });
    const continuation = createWorkbookPlan(workbook, { selections: defaultSelections(workbook), mode: 'continue' });
    assert.equal(refresh.occurrenceCount, 5);
    assert.equal(continuation.occurrenceCount, 4);
    const bilibili = continuation.tasks.find((task) => task.platform === 'B站');
    assert.equal(bilibili.occurrences.length, 1);
    assert.equal(bilibili.occurrences[0].row, 3);
});

test('continue mode recognizes parser and upstream failure messages written by the app', async () => {
    const workbook = await model();
    const selections = defaultSelections(workbook);
    const refresh = createWorkbookPlan(workbook, { selections, mode: 'refresh' });
    for (const error of [
        '百度新闻主页没有提取到明确作品发布时间',
        '爱奇艺主页作品接口请求失败（HTTP 503）',
        '上游服务异常，请稍后重试',
    ]) {
        const results = Object.fromEntries(refresh.tasks.map((task) => [task.key, { status: 'error', error }]));
        const output = await writeWorkbookResults(workbook, { plan: refresh, results });
        const reimported = await inspectWorkbook(output, { fileName: '失败结果.xlsx' });
        const continuation = createWorkbookPlan(reimported, { selections: defaultSelections(reimported), mode: 'continue' });
        assert.equal(continuation.uniqueTaskCount, refresh.uniqueTaskCount, error);
    }
});

test('continue mode skips records confirmed to have no collectable homepage works', async () => {
    for (const value of [
        '【无可采集对象】今日头条主页显示用户不存在',
        '【无可采集对象】网上车市作者链接已失效并跳转到平台首页',
        '【无可采集对象】腾讯新闻主页当前没有作品',
    ]) {
        assert.equal(isRetryableWorkbookValue(value), false, value);
    }
    assert.equal(isRetryableWorkbookValue('凤凰新闻作品列表请求失败（HTTP 503）'), true);
});

test('unsupported-only sheets remain unselected and gain no time column', async () => {
    const workbook = await model();
    const unsupported = workbook.sheets.find((sheet) => sheet.name === '不支持');
    assert.equal(unsupported.defaultCandidate, null);
    const plan = createWorkbookPlan(workbook, { selections: defaultSelections(workbook), mode: 'refresh' });
    const output = await writeWorkbookResults(workbook, { plan, results: resultMap(plan) });
    const outputWorkbook = await inspectWorkbook(output, { fileName: '结果.xlsx' });
    assert.equal(outputWorkbook.sheets.find((sheet) => sheet.name === '不支持').headers.includes('最新更新时间'), false);
});

test('inserting a latest-time column moves formulas ranges merges tables and hyperlinks', async () => {
    const workbook = await model();
    const plan = createWorkbookPlan(workbook, { selections: defaultSelections(workbook), mode: 'refresh' });
    const output = await writeWorkbookResults(workbook, { plan, results: resultMap(plan) });
    const sheetXml = await xmlPart(output, 'xl/worksheets/sheet1.xml');
    const tableXml = await xmlPart(output, 'xl/tables/table1.xml');
    const workbookXml = await xmlPart(output, 'xl/workbook.xml');

    assert.match(sheetXml, /<mergeCell[^>]+ref="A1:D1"/);
    assert.match(sheetXml, /<autoFilter[^>]+ref="A3:F5"/);
    assert.match(sheetXml, /<hyperlink[^>]+ref="D4"[^>]+r:id="rId2"/);
    assert.match(sheetXml, /<hyperlink[^>]+ref="F4"[^>]+location="'已有时间'!A1"/);
    assert.match(sheetXml, /<c[^>]+r="E5"[^>]*><f>E4\*2<\/f>/);
    assert.match(tableXml, /ref="A3:F5"/);
    assert.match(tableXml, /<tableColumn[^>]+name="最新更新时间"/);
    assert.match(workbookXml, /'多表头'!\$A\$3:\$F\$5/);
    assert.match(workbookXml, /<definedName name="FixtureTotal">'多表头'!\$E\$4<\/definedName>/);
});

test('writes sortable Beijing Excel serial values displayed as year/month/day', async () => {
    assert.equal(excelSerialFromInstant('2026-08-20T04:00:00.000Z'), excelSerialFromInstant('2026-08-20T12:00:00+08:00'));
    const workbook = await model();
    const plan = createWorkbookPlan(workbook, { selections: defaultSelections(workbook), mode: 'refresh' });
    const output = await writeWorkbookResults(workbook, { plan, results: resultMap(plan) });
    const outputWorkbook = await inspectWorkbook(output, { fileName: '结果.xlsx' });
    const cell = getWorkbookCell(outputWorkbook, '多表头', 'C4');
    assert.equal(cell.type, 'n');
    assert.equal(typeof cell.value, 'number');
    assert.equal(cell.numberFormat, 'yyyy/mm/dd');
});

test('writes a short Chinese error without converting it to a date', async () => {
    const workbook = await model();
    const plan = createWorkbookPlan(workbook, { selections: defaultSelections(workbook), mode: 'refresh' });
    const results = resultMap(plan, { B站: { status: 'error', error: 'Cookie失效，请重新导入' } });
    const output = await writeWorkbookResults(workbook, { plan, results });
    const outputWorkbook = await inspectWorkbook(output, { fileName: '结果.xlsx' });
    const cell = getWorkbookCell(outputWorkbook, '已有时间', 'B2');
    assert.equal(cell.type, 'inlineStr');
    assert.equal(cell.value, 'Cookie失效，请重新导入');
});

test('changes only declared OpenXML parts and preserves every relationship resource', async () => {
    const workbook = await model();
    const plan = createWorkbookPlan(workbook, { selections: defaultSelections(workbook), mode: 'refresh' });
    const output = await writeWorkbookResults(workbook, { plan, results: resultMap(plan) });
    const sourceFingerprint = await fingerprintWorkbook(fixtureBytes);
    const outputFingerprint = await fingerprintWorkbook(output);
    const comparison = compareWorkbookFingerprints(sourceFingerprint, outputFingerprint);
    const allowed = new Set(['xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml', 'xl/tables/table1.xml']);
    assert.deepEqual(comparison.changedParts.filter((part) => !allowed.has(part)), []);
    assert.deepEqual(sourceFingerprint.relationships, outputFingerprint.relationships);
    assert.deepEqual(sourceFingerprint.partNames, outputFingerprint.partNames);
});

test('a missing hyperlink relationship or broken table range is detected', async () => {
    const workbook = await model();
    const plan = createWorkbookPlan(workbook, { selections: defaultSelections(workbook), mode: 'refresh' });
    const correct = await writeWorkbookResults(workbook, { plan, results: resultMap(plan) });
    const corruptZip = await JSZip.loadAsync(correct);
    corruptZip.file('xl/worksheets/_rels/sheet1.xml.rels', (await corruptZip.file('xl/worksheets/_rels/sheet1.xml.rels').async('string')).replace(/<Relationship[^>]+Id="rId1"[^>]*\/>/, ''));
    corruptZip.file('xl/tables/table1.xml', (await corruptZip.file('xl/tables/table1.xml').async('string')).replaceAll('A3:F5', 'A3:E5'));
    const corrupt = new Uint8Array(await corruptZip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
    const comparison = compareWorkbookFingerprints(await fingerprintWorkbook(correct), await fingerprintWorkbook(corrupt));
    assert.equal(comparison.ok, false);
    assert.ok(comparison.changedParts.includes('xl/worksheets/_rels/sheet1.xml.rels'));
    assert.ok(comparison.changedParts.includes('xl/tables/table1.xml'));
});

test('download fidelity gate accepts the generated output and rejects a corrupted table', async () => {
    const workbook = await model();
    const plan = createWorkbookPlan(workbook, { selections: defaultSelections(workbook), mode: 'refresh' });
    const results = resultMap(plan);
    const correct = await writeWorkbookResults(workbook, { plan, results });
    assert.equal((await verifyWorkbookOutput(workbook, { plan, results, outputBytes: correct })).ok, true);

    const corruptZip = await JSZip.loadAsync(correct);
    const tableXml = await corruptZip.file('xl/tables/table1.xml').async('string');
    corruptZip.file('xl/tables/table1.xml', tableXml.replaceAll('A3:F5', 'A3:E5'));
    const corrupt = new Uint8Array(await corruptZip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
    const verification = await verifyWorkbookOutput(workbook, { plan, results, outputBytes: corrupt });
    assert.equal(verification.ok, false);
    assert.equal(verification.errors.some((error) => error.includes('xl/tables/table1.xml')), true);
});

test('partial export can be reimported and continued without repeating completed accounts', async () => {
    const workbook = await model();
    const plan = createWorkbookPlan(workbook, { selections: defaultSelections(workbook), mode: 'refresh' });
    const douyin = plan.tasks.find((task) => task.platform === '抖音');
    const partial = await writeWorkbookResults(workbook, {
        plan,
        results: { [douyin.key]: { status: 'success', latestTime: '2026-08-20T04:00:00.000Z' } },
    });
    const reimported = await inspectWorkbook(partial, { fileName: '部分结果.xlsx' });
    const continuation = createWorkbookPlan(reimported, { selections: defaultSelections(reimported), mode: 'continue' });
    assert.equal(continuation.tasks.some((task) => task.platform === '抖音'), false);
    assert.equal(continuation.tasks.some((task) => task.platform === 'B站'), true);
    assert.equal(continuation.tasks.some((task) => task.platform === '小红书'), true);
});

test('export naming distinguishes final and partial files', () => {
    assert.equal(outputWorkbookName('样例.xlsx', { partial: false }), '样例_已更新.xlsx');
    assert.equal(outputWorkbookName('样例.xlsx', { partial: true }), '样例_部分结果.xlsx');
});

test('writing output never changes the source bytes', async () => {
    const before = createHash('sha256').update(fixtureBytes).digest('hex');
    const workbook = await model();
    const plan = createWorkbookPlan(workbook, { selections: defaultSelections(workbook), mode: 'refresh' });
    await writeWorkbookResults(workbook, { plan, results: resultMap(plan) });
    const after = createHash('sha256').update(fixtureBytes).digest('hex');
    assert.equal(after, before);
});
