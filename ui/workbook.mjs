import { buildRoute, canonicalizeProfileUrl, extractUrl, needsRedirectResolution, shortLinkPlatform } from './core.mjs';

export const MAX_XLSX_BYTES = 20 * 1024 * 1024;
export const LATEST_TIME_HEADER = '最新更新时间';

const EXCLUDED_AUTO_HEADERS = ['案例展示', '星图链接', '蒲公英链接', '互选链接'];
const EXPLICIT_ERROR_PATTERN = /失败|错误|异常|无法|未获取|未找到|未提取|没有提取|没有返回|不支持|已停止|失效|过期|登录|不存在|超时|风控|Cookie|HTTP|暂无作品|没有作品|没有可用/i;
const NO_COLLECTABLE_TARGET_PATTERN = /无可采集对象|(?:主页|用户|账号|内容).{0,18}(?:用户或内容)?不存在|(?:用户|账号).{0,12}已注销|内容.{0,12}已下线|(?:作者)?链接已失效|跳转到平台首页|主页当前没有作品|主页没有作品|主页没有返回公开作品数据|主页作品接口没有返回数据|主页没有找到作品链接|请使用用户主页链接/i;
const RELATIONSHIP_TYPE = {
    worksheet: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
    hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
    table: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/table',
};
const BUILTIN_NUMBER_FORMATS = new Map([
    [14, 'mm-dd-yy'], [15, 'd-mmm-yy'], [16, 'd-mmm'], [17, 'mmm-yy'], [18, 'h:mm AM/PM'],
    [19, 'h:mm:ss AM/PM'], [20, 'h:mm'], [21, 'h:mm:ss'], [22, 'm/d/yy h:mm'],
]);

let workbookZipEngine = globalThis.JSZip ?? null;

export function setWorkbookZipEngine(engine) {
    workbookZipEngine = engine;
}

function getZipEngine() {
    const engine = workbookZipEngine ?? globalThis.JSZip;
    if (!engine) throw new Error('Excel 组件未加载，请刷新页面后重试');
    return engine;
}

function asUint8Array(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    throw new Error('不是有效的 XLSX 文件数据');
}

function decodeXml(value = '') {
    return String(value)
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&');
}

function encodeXml(value = '') {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function parseAttributes(tag = '') {
    const attributes = {};
    const pattern = /([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (const match of String(tag).matchAll(pattern)) {
        attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? '');
    }
    return attributes;
}

function replaceAttribute(tag, name, value) {
    const encoded = encodeXml(value);
    const pattern = new RegExp(`(${name.replace(':', '\\:')}\\s*=\\s*)(?:"[^"]*"|'[^']*')`);
    if (pattern.test(tag)) return tag.replace(pattern, `$1"${encoded}"`);
    return tag.replace(/\s*\/?>$/, (ending) => ` ${name}="${encoded}"${ending}`);
}

function removeAttribute(tag, name) {
    const pattern = new RegExp(`\\s+${name.replace(':', '\\:')}\\s*=\\s*(?:"[^"]*"|'[^']*')`, 'g');
    return tag.replace(pattern, '');
}

function tagPattern(tagName, flags = 'g') {
    return new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${tagName}\\b[^>]*>`, flags);
}

function extractTags(xml, tagName) {
    return [...String(xml).matchAll(tagPattern(tagName))].map((match) => ({ tag: match[0], attributes: parseAttributes(match[0]) }));
}

function resolvePartTarget(ownerPart, target) {
    if (!target || /^[a-z]+:/i.test(target)) return target;
    if (target.startsWith('/')) return target.replace(/^\/+/, '');
    const directory = ownerPart.includes('/') ? ownerPart.slice(0, ownerPart.lastIndexOf('/')) : '';
    const segments = `${directory}/${target}`.split('/');
    const normalized = [];
    for (const segment of segments) {
        if (!segment || segment === '.') continue;
        if (segment === '..') normalized.pop();
        else normalized.push(segment);
    }
    return normalized.join('/');
}

function relationshipPartFor(partName) {
    const slash = partName.lastIndexOf('/');
    const directory = slash >= 0 ? partName.slice(0, slash) : '';
    const base = slash >= 0 ? partName.slice(slash + 1) : partName;
    return `${directory ? `${directory}/` : ''}_rels/${base}.rels`;
}

function parseRelationships(xml, ownerPart) {
    return extractTags(xml, 'Relationship').map(({ attributes }) => ({
        id: attributes.Id ?? '',
        type: attributes.Type ?? '',
        target: resolvePartTarget(ownerPart, attributes.Target ?? ''),
        rawTarget: attributes.Target ?? '',
        targetMode: attributes.TargetMode ?? '',
    }));
}

function columnNumber(letters) {
    let number = 0;
    for (const letter of String(letters).toUpperCase()) number = number * 26 + letter.charCodeAt(0) - 64;
    return number;
}

function columnLetters(number) {
    let value = Number(number);
    let output = '';
    while (value > 0) {
        value -= 1;
        output = String.fromCharCode(65 + (value % 26)) + output;
        value = Math.floor(value / 26);
    }
    return output;
}

function parseCellReference(reference) {
    const match = String(reference).match(/^(\$?)([A-Z]{1,3})(\$?)(\d+)$/i);
    if (!match) return null;
    return {
        absoluteColumn: match[1],
        column: columnNumber(match[2]),
        absoluteRow: match[3],
        row: Number(match[4]),
    };
}

function formatCellReference(parsed) {
    return `${parsed.absoluteColumn}${columnLetters(parsed.column)}${parsed.absoluteRow}${parsed.row}`;
}

function shiftSingleReference(reference, insertColumn) {
    const parsed = parseCellReference(reference);
    if (!parsed) return reference;
    if (parsed.column >= insertColumn) parsed.column += 1;
    return formatCellReference(parsed);
}

function shiftRangeReference(reference, insertColumn) {
    return String(reference).split(/\s+/).filter(Boolean).map((area) => {
        const [startText, endText] = area.split(':');
        const start = parseCellReference(startText);
        const end = parseCellReference(endText ?? startText);
        if (!start || !end) return area;
        if (insertColumn <= start.column) {
            start.column += 1;
            end.column += 1;
        } else if (insertColumn <= end.column) {
            end.column += 1;
        }
        const shifted = formatCellReference(start);
        return endText ? `${shifted}:${formatCellReference(end)}` : shifted;
    }).join(' ');
}

function normalizeSheetName(value) {
    const text = String(value ?? '');
    return text.startsWith("'") && text.endsWith("'") ? text.slice(1, -1).replaceAll("''", "'") : text;
}

function shiftFormulaReferences(formula, insertColumn, sheetName, shiftUnqualified = true) {
    const pattern = /((?:'(?:(?:'')|[^'])+'|[A-Za-z_][A-Za-z0-9_. ]*)!)?(\$?)([A-Z]{1,3})(\$?)(\d+)/g;
    return String(formula).replace(pattern, (whole, qualifier, absoluteColumn, letters, absoluteRow, row) => {
        if (qualifier) {
            const qualifiedSheet = normalizeSheetName(qualifier.slice(0, -1));
            if (qualifiedSheet !== sheetName) return whole;
        } else if (!shiftUnqualified) {
            return whole;
        }
        const column = columnNumber(letters);
        return `${qualifier ?? ''}${absoluteColumn}${columnLetters(column >= insertColumn ? column + 1 : column)}${absoluteRow}${row}`;
    });
}

function shiftDefinedNameFormula(formula, insertColumn, sheetName) {
    const quoted = `'${sheetName.replaceAll("'", "''")}'`;
    const candidates = [quoted, sheetName].sort((left, right) => right.length - left.length).map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(`(${candidates.join('|')})!(\\$?[A-Z]{1,3}\\$?\\d+)(?::(\\$?[A-Z]{1,3}\\$?\\d+))?`, 'g');
    return String(formula).replace(pattern, (whole, qualifier, start, end) => {
        const shifted = shiftRangeReference(end ? `${start}:${end}` : start, insertColumn);
        return `${qualifier}!${shifted}`;
    });
}

function textFromXml(fragment) {
    return [...String(fragment).matchAll(/<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/g)]
        .map((match) => decodeXml(match[1]))
        .join('');
}

function parseSharedStrings(xml) {
    const items = [];
    const pattern = /<(?:[A-Za-z_][\w.-]*:)?si\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?si>/g;
    for (const match of String(xml).matchAll(pattern)) items.push(textFromXml(match[1]));
    return items;
}

function parseStyles(xml) {
    const customFormats = new Map();
    for (const { attributes } of extractTags(xml, 'numFmt')) {
        customFormats.set(Number(attributes.numFmtId), attributes.formatCode ?? '');
    }
    const cellXfsBody = String(xml).match(/<(?:[A-Za-z_][\w.-]*:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?cellXfs>/)?.[1] ?? '';
    const xfs = extractTags(cellXfsBody, 'xf').map(({ attributes }) => {
        const numFmtId = Number(attributes.numFmtId ?? 0);
        return { attributes, numFmtId, numberFormat: customFormats.get(numFmtId) ?? BUILTIN_NUMBER_FORMATS.get(numFmtId) ?? 'General' };
    });
    return { customFormats, xfs };
}

function parseWorksheetCells(xml, sharedStrings, styles) {
    const cells = new Map();
    const pattern = /<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>|<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*)\/>/g;
    for (const match of String(xml).matchAll(pattern)) {
        const attributes = parseAttributes(`<c ${match[1] ?? match[3] ?? ''}>`);
        const ref = attributes.r ?? '';
        const parsedRef = parseCellReference(ref);
        if (!parsedRef) continue;
        const body = match[2] ?? '';
        const type = attributes.t ?? 'n';
        const styleIndex = Number(attributes.s ?? 0);
        const formula = decodeXml(body.match(/<(?:[A-Za-z_][\w.-]*:)?f\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?f>/)?.[1] ?? '');
        const raw = decodeXml(body.match(/<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/)?.[1] ?? '');
        let value = raw;
        if (type === 's') value = sharedStrings[Number(raw)] ?? '';
        else if (type === 'inlineStr') value = textFromXml(body);
        else if (type === 'n' || (!attributes.t && raw !== '')) value = Number(raw);
        else if (type === 'b') value = raw === '1';
        cells.set(ref.toUpperCase(), {
            ref: ref.toUpperCase(),
            row: parsedRef.row,
            column: parsedRef.column,
            type,
            value,
            rawValue: raw,
            formula,
            styleIndex,
            numberFormat: styles.xfs[styleIndex]?.numberFormat ?? 'General',
        });
    }
    return cells;
}

function parseWorksheetLinks(xml, relationships, cells) {
    const relationshipById = new Map(relationships.map((relationship) => [relationship.id, relationship]));
    const links = new Map();
    for (const { attributes } of extractTags(xml, 'hyperlink')) {
        const ref = String(attributes.ref ?? '').toUpperCase();
        if (!ref || ref.includes(':')) continue;
        const relationship = relationshipById.get(attributes['r:id'] ?? '');
        const value = relationship?.type === RELATIONSHIP_TYPE.hyperlink ? relationship.rawTarget : attributes.location ?? '';
        if (value) links.set(ref, value);
    }
    for (const [ref, cell] of cells) {
        if (links.has(ref)) continue;
        const value = extractUrl(typeof cell.value === 'string' ? cell.value : '');
        if (value) links.set(ref, value);
    }
    return links;
}

function supportedUrl(value) {
    try {
        const url = extractUrl(value);
        if (!url) return null;
        if (needsRedirectResolution(url)) {
            const platform = shortLinkPlatform(url);
            if (!platform) return null;
            return {
                url,
                route: { platform, sourceUrl: url, route: '' },
                key: `${platform}|${url}`,
            };
        }
        const route = buildRoute(url);
        const canonical = extractUrl(canonicalizeProfileUrl(url)) || url;
        return { url, route, key: `${route.platform}|${canonical}` };
    } catch {
        return null;
    }
}

function detectHeaderRow(cells, links) {
    const linkRows = [...links.keys()].map((ref) => parseCellReference(ref)?.row).filter(Number.isFinite);
    const maximum = Math.min(30, linkRows.length ? Math.max(1, Math.min(...linkRows)) : 30);
    let winner = { row: 1, score: -1 };
    for (let row = 1; row <= maximum; row += 1) {
        const values = [...cells.values()].filter((cell) => cell.row === row && String(cell.value ?? '').trim());
        if (!values.length) continue;
        let score = values.length;
        for (const cell of values) {
            const header = String(cell.value ?? '').trim();
            if (header === '主页链接') score += 20;
            else if (header === '链接') score += 16;
            else if (header.includes('链接')) score += 8;
            if (EXCLUDED_AUTO_HEADERS.some((excluded) => header.includes(excluded))) score += 4;
        }
        if (score > winner.score || (score === winner.score && row > winner.row)) winner = { row, score };
    }
    return winner.row;
}

function candidatePriority(header) {
    const value = String(header ?? '').trim();
    if (value === '主页链接') return 0;
    if (value === '链接') return 1;
    if (value.includes('主页链接')) return 2;
    if (value.includes('链接')) return 3;
    return 4;
}

function inspectSheetCandidates(sheet) {
    const headerRow = detectHeaderRow(sheet.cells, sheet.links);
    const headerCells = [...sheet.cells.values()].filter((cell) => cell.row === headerRow);
    const headerByColumn = new Map(headerCells.map((cell) => [cell.column, String(cell.value ?? '').trim()]));
    const headers = [...headerCells].sort((left, right) => left.column - right.column).map((cell) => String(cell.value ?? '').trim());
    const linkEntriesByColumn = new Map();
    for (const [ref, link] of sheet.links) {
        const parsed = parseCellReference(ref);
        if (!parsed || parsed.row <= headerRow) continue;
        if (!linkEntriesByColumn.has(parsed.column)) linkEntriesByColumn.set(parsed.column, []);
        linkEntriesByColumn.get(parsed.column).push({ ref, row: parsed.row, url: link });
    }

    const candidates = [...linkEntriesByColumn.entries()].map(([columnIndex, entries]) => {
        const header = headerByColumn.get(columnIndex) ?? columnLetters(columnIndex);
        const supported = entries.map((entry) => ({ ...entry, task: supportedUrl(entry.url) })).filter((entry) => entry.task);
        const unsupported = entries.filter((entry) => !supportedUrl(entry.url));
        const adjacentHeader = headerByColumn.get(columnIndex + 1) ?? '';
        const excludedFromDefault = EXCLUDED_AUTO_HEADERS.some((excluded) => header.includes(excluded));
        return {
            id: `${sheet.index}:${headerRow}:${columnIndex}`,
            sheetName: sheet.name,
            header,
            headerRow,
            columnIndex,
            columnLetter: columnLetters(columnIndex),
            hitCount: supported.length,
            unsupportedCount: unsupported.length,
            excludedFromDefault,
            priority: candidatePriority(header),
            reusesTimeColumn: adjacentHeader === LATEST_TIME_HEADER,
            timeColumnIndex: columnIndex + 1,
            entries,
        };
    }).sort((left, right) => left.columnIndex - right.columnIndex);

    const defaultCandidate = candidates
        .filter((candidate) => candidate.hitCount > 0 && !candidate.excludedFromDefault)
        .sort((left, right) => left.priority - right.priority || right.hitCount - left.hitCount || left.columnIndex - right.columnIndex)[0] ?? null;

    return { headerRow, headers, candidates, defaultCandidate };
}

async function archiveText(archive, partName, required = false) {
    const entry = archive.file(partName);
    if (!entry) {
        if (required) throw new Error(`XLSX 缺少必要部件：${partName}`);
        return '';
    }
    return entry.async('string');
}

async function loadValidatedArchive({ name, size, bytes }) {
    if (!/\.xlsx$/i.test(String(name ?? '')) || /\.(?:xls|xlsm|csv)\.xlsx$/i.test(String(name ?? ''))) {
        throw new Error('只支持扩展名为 .xlsx 的工作簿');
    }
    if (Number(size) > MAX_XLSX_BYTES) throw new Error('Excel 文件不能超过 20 MB');
    const data = asUint8Array(bytes);
    if (data.byteLength < 4 || data[0] !== 0x50 || data[1] !== 0x4b || ![[0x03, 0x04], [0x05, 0x06], [0x07, 0x08]].some(([third, fourth]) => data[2] === third && data[3] === fourth)) {
        throw new Error('不是有效的 XLSX ZIP 文件');
    }
    let archive;
    try {
        archive = await getZipEngine().loadAsync(data);
    } catch {
        throw new Error('不是有效的 XLSX ZIP 文件');
    }
    const contentTypes = await archiveText(archive, '[Content_Types].xml', true);
    if (/macroEnabled|vnd\.ms-excel\.sheet\.macroEnabled/i.test(contentTypes)) throw new Error('只支持不含宏的 .xlsx 工作簿');
    if (!/spreadsheetml\.sheet\.main\+xml/i.test(contentTypes) || !archive.file('xl/workbook.xml')) {
        throw new Error('不是有效的 XLSX 工作簿');
    }
    return { archive, data };
}

export async function validateWorkbookFile({ name, size, bytes }) {
    await loadValidatedArchive({ name, size, bytes });
    return { ok: true, size: Number(size), name: String(name) };
}

export async function inspectWorkbook(bytes, { fileName = '工作簿.xlsx' } = {}) {
    const data = asUint8Array(bytes);
    const { archive } = await loadValidatedArchive({ name: fileName, size: data.byteLength, bytes: data });
    const workbookPart = 'xl/workbook.xml';
    const workbookXml = await archiveText(archive, workbookPart, true);
    const workbookRelationshipsPart = relationshipPartFor(workbookPart);
    const workbookRelationshipsXml = await archiveText(archive, workbookRelationshipsPart, true);
    const workbookRelationships = parseRelationships(workbookRelationshipsXml, workbookPart);
    const relationshipById = new Map(workbookRelationships.map((relationship) => [relationship.id, relationship]));
    const sharedStringsRelationship = workbookRelationships.find((relationship) => /\/sharedStrings$/.test(relationship.type));
    const stylesRelationship = workbookRelationships.find((relationship) => /\/styles$/.test(relationship.type));
    const sharedStringsXml = sharedStringsRelationship ? await archiveText(archive, sharedStringsRelationship.target) : '';
    const stylesXml = stylesRelationship ? await archiveText(archive, stylesRelationship.target, true) : '';
    const sharedStrings = parseSharedStrings(sharedStringsXml);
    const styles = parseStyles(stylesXml);
    const sheets = [];

    for (const [index, { attributes }] of extractTags(workbookXml, 'sheet').entries()) {
        const relationship = relationshipById.get(attributes['r:id'] ?? '');
        if (!relationship || relationship.type !== RELATIONSHIP_TYPE.worksheet) throw new Error(`工作表 ${attributes.name ?? index + 1} 缺少关系资源`);
        const partName = relationship.target;
        const xml = await archiveText(archive, partName, true);
        const relationshipsPart = relationshipPartFor(partName);
        const relationshipsXml = await archiveText(archive, relationshipsPart);
        const relationships = parseRelationships(relationshipsXml, partName);
        const cells = parseWorksheetCells(xml, sharedStrings, styles);
        const links = parseWorksheetLinks(xml, relationships, cells);
        const sheet = {
            index,
            name: attributes.name ?? `Sheet${index + 1}`,
            state: attributes.state ?? 'visible',
            partName,
            relationshipsPart,
            xml,
            relationshipsXml,
            relationships,
            cells,
            links,
        };
        Object.assign(sheet, inspectSheetCandidates(sheet));
        sheets.push(sheet);
    }

    return {
        fileName,
        sourceBytes: new Uint8Array(data),
        archive,
        workbookPart,
        workbookXml,
        workbookRelationshipsPart,
        workbookRelationshipsXml,
        workbookRelationships,
        stylesPart: stylesRelationship?.target ?? 'xl/styles.xml',
        stylesXml,
        styles,
        sharedStrings,
        sheets,
    };
}

export function isRetryableWorkbookValue(value) {
    if (value === null || value === undefined || String(value).trim() === '') return true;
    return typeof value === 'string' && !NO_COLLECTABLE_TARGET_PATTERN.test(value) && EXPLICIT_ERROR_PATTERN.test(value);
}

function selectedCandidate(sheet, selections) {
    const selectedColumn = selections?.[sheet.name];
    if (selectedColumn === undefined || selectedColumn === null || selectedColumn === '') return null;
    return sheet.candidates.find((candidate) => candidate.columnIndex === Number(selectedColumn)) ?? null;
}

export function createWorkbookPlan(workbook, { selections = {}, mode = 'refresh' } = {}) {
    if (!['refresh', 'continue'].includes(mode)) throw new Error('刷新模式无效');
    const taskByKey = new Map();
    const skippedUnsupported = [];
    const selectedSheets = [];

    for (const sheet of workbook.sheets) {
        const candidate = selectedCandidate(sheet, selections);
        if (!candidate) {
            if (!sheet.defaultCandidate) {
                for (const unsupportedCandidate of sheet.candidates.filter((item) => item.hitCount === 0)) {
                    for (const entry of unsupportedCandidate.entries) skippedUnsupported.push({ sheetName: sheet.name, row: entry.row, column: unsupportedCandidate.columnIndex, url: entry.url, reason: '不支持的平台' });
                }
            }
            continue;
        }
        selectedSheets.push({
            sheetName: sheet.name,
            sheetIndex: sheet.index,
            partName: sheet.partName,
            headerRow: candidate.headerRow,
            linkColumnIndex: candidate.columnIndex,
            timeColumnIndex: candidate.timeColumnIndex,
            insertTimeColumn: !candidate.reusesTimeColumn,
            candidate,
        });
        for (const entry of candidate.entries) {
            const task = supportedUrl(entry.url);
            if (!task) {
                skippedUnsupported.push({ sheetName: sheet.name, row: entry.row, column: candidate.columnIndex, url: entry.url, reason: '不支持的平台' });
                continue;
            }
            const timeCell = candidate.reusesTimeColumn ? sheet.cells.get(`${columnLetters(candidate.timeColumnIndex)}${entry.row}`) : null;
            if (mode === 'continue' && candidate.reusesTimeColumn && !isRetryableWorkbookValue(timeCell?.value)) continue;
            const occurrence = {
                sheetName: sheet.name,
                sheetIndex: sheet.index,
                partName: sheet.partName,
                row: entry.row,
                linkColumnIndex: candidate.columnIndex,
                timeColumnIndex: candidate.timeColumnIndex,
                url: task.url,
            };
            if (!taskByKey.has(task.key)) taskByKey.set(task.key, { key: task.key, platform: task.route.platform, url: task.url, normalizedUrl: task.key.slice(task.key.indexOf('|') + 1), occurrences: [] });
            taskByKey.get(task.key).occurrences.push(occurrence);
        }
    }

    const tasks = [...taskByKey.values()];
    return {
        mode,
        tasks,
        uniqueTaskCount: tasks.length,
        occurrenceCount: tasks.reduce((sum, task) => sum + task.occurrences.length, 0),
        skippedUnsupported,
        selectedSheets,
    };
}

function patchCellReferencesAndFormulas(xml, insertColumn, sheetName) {
    const cellPattern = /<(?:[A-Za-z_][\w.-]*:)?c\b[^>]*(?:\/>|>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?c>)/g;
    return String(xml).replace(cellPattern, (cellXml) => {
        const openTag = cellXml.match(/^<[^>]+>/)?.[0] ?? cellXml;
        const attributes = parseAttributes(openTag);
        const ref = attributes.r;
        let output = cellXml;
        if (ref) output = output.replace(openTag, replaceAttribute(openTag, 'r', shiftSingleReference(ref, insertColumn)));
        return output.replace(/(<(?:[A-Za-z_][\w.-]*:)?f\b[^>]*>)([\s\S]*?)(<\/(?:[A-Za-z_][\w.-]*:)?f>)/g, (whole, start, formula, end) => `${start}${encodeXml(shiftFormulaReferences(decodeXml(formula), insertColumn, sheetName, true))}${end}`);
    });
}

function patchReferenceTags(xml, insertColumn, sheetName) {
    const rules = {
        dimension: ['ref'], mergeCell: ['ref'], autoFilter: ['ref'], hyperlink: ['ref'],
        dataValidation: ['sqref'], conditionalFormatting: ['sqref'], selection: ['activeCell', 'sqref'], pane: ['topLeftCell'],
    };
    let output = String(xml);
    for (const [tagName, attributes] of Object.entries(rules)) {
        output = output.replace(tagPattern(tagName), (tag) => {
            let patched = tag;
            const parsed = parseAttributes(tag);
            for (const attribute of attributes) {
                if (!parsed[attribute]) continue;
                patched = replaceAttribute(patched, attribute, shiftRangeReference(parsed[attribute], insertColumn));
            }
            if (tagName === 'hyperlink' && parsed.location) {
                patched = replaceAttribute(patched, 'location', shiftDefinedNameFormula(parsed.location, insertColumn, sheetName));
            }
            return patched;
        });
    }
    return output;
}

function patchWorksheetColumns(xml, insertColumn, sourceColumn) {
    const section = String(xml).match(/<(?:[A-Za-z_][\w.-]*:)?cols\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?cols>/);
    if (!section) return xml;
    const columnTags = extractTags(section[1], 'col').map(({ tag, attributes }) => ({ tag, attributes, min: Number(attributes.min), max: Number(attributes.max) }));
    const source = columnTags.find((column) => column.min <= sourceColumn && column.max >= sourceColumn) ?? null;
    const patched = [];
    let insertionCovered = false;
    for (const column of columnTags) {
        let { min, max } = column;
        if (max < insertColumn) {
            patched.push(column.tag);
        } else if (min >= insertColumn) {
            min += 1;
            max += 1;
            patched.push(replaceAttribute(replaceAttribute(column.tag, 'min', min), 'max', max));
        } else {
            max += 1;
            insertionCovered = true;
            patched.push(replaceAttribute(column.tag, 'max', max));
        }
    }
    if (!insertionCovered) {
        let newColumn = source?.tag ?? `<col min="${insertColumn}" max="${insertColumn}" width="12" customWidth="1"/>`;
        newColumn = replaceAttribute(replaceAttribute(newColumn, 'min', insertColumn), 'max', insertColumn);
        patched.push(newColumn);
    }
    patched.sort((left, right) => Number(parseAttributes(left).min) - Number(parseAttributes(right).min));
    return String(xml).replace(section[0], section[0].replace(section[1], patched.join('')));
}

function insertWorksheetColumn(xml, insertColumn, sourceColumn, sheetName) {
    let output = patchCellReferencesAndFormulas(xml, insertColumn, sheetName);
    output = patchReferenceTags(output, insertColumn, sheetName);
    output = patchWorksheetColumns(output, insertColumn, sourceColumn);
    return output;
}

function patchTableXml(xml, insertColumn) {
    const tableTag = String(xml).match(tagPattern('table', ''))?.[0];
    if (!tableTag) return xml;
    const tableAttributes = parseAttributes(tableTag);
    const originalRange = tableAttributes.ref ?? '';
    const [startText, endText] = originalRange.split(':');
    const start = parseCellReference(startText);
    const end = parseCellReference(endText ?? startText);
    if (!start || !end || insertColumn < start.column || insertColumn > end.column) return xml;
    let output = String(xml).replace(tableTag, replaceAttribute(tableTag, 'ref', shiftRangeReference(originalRange, insertColumn)));
    output = output.replace(tagPattern('autoFilter'), (tag) => {
        const ref = parseAttributes(tag).ref;
        return ref ? replaceAttribute(tag, 'ref', shiftRangeReference(ref, insertColumn)) : tag;
    });
    const columnsSection = output.match(/<(?:[A-Za-z_][\w.-]*:)?tableColumns\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?tableColumns>/);
    if (!columnsSection) return output;
    const columns = extractTags(columnsSection[1], 'tableColumn').map(({ tag }) => tag);
    const position = insertColumn - start.column;
    columns.splice(position, 0, `<tableColumn id="0" name="${LATEST_TIME_HEADER}"/>`);
    const renumbered = columns.map((tag, index) => replaceAttribute(tag, 'id', index + 1));
    const openTag = columnsSection[0].match(/^<[^>]+>/)?.[0] ?? '';
    const patchedOpenTag = replaceAttribute(openTag, 'count', renumbered.length);
    const rebuilt = `${patchedOpenTag}${renumbered.join('')}</${openTag.match(/^<(?:[A-Za-z_][\w.-]*:)?([^\s>]+)/)?.[1] ?? 'tableColumns'}>`;
    return output.replace(columnsSection[0], rebuilt);
}

function patchWorkbookDefinedNames(xml, insertions) {
    return String(xml).replace(/(<(?:[A-Za-z_][\w.-]*:)?definedName\b[^>]*>)([\s\S]*?)(<\/(?:[A-Za-z_][\w.-]*:)?definedName>)/g, (whole, start, formula, end) => {
        let shifted = decodeXml(formula);
        for (const insertion of insertions) shifted = shiftDefinedNameFormula(shifted, insertion.insertColumn, insertion.sheetName);
        return `${start}${encodeXml(shifted)}${end}`;
    });
}

function normalizeFormatCode(value) {
    return String(value ?? '').replaceAll('\\', '').replaceAll('"', '').toLowerCase();
}

function ensureDateStyle(stylesXml) {
    const parsed = parseStyles(stylesXml);
    const existingIndex = parsed.xfs.findIndex((xf) => normalizeFormatCode(xf.numberFormat) === 'yyyy/mm/dd');
    if (existingIndex >= 0) return { xml: stylesXml, styleIndex: existingIndex, changed: false };

    const usedIds = [...parsed.customFormats.keys()];
    const numFmtId = Math.max(164, ...(usedIds.length ? usedIds : [163])) + 1;
    let output = String(stylesXml);
    const numFmts = output.match(/<(?:[A-Za-z_][\w.-]*:)?numFmts\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?numFmts>/);
    const formatTag = `<numFmt numFmtId="${numFmtId}" formatCode="yyyy/mm/dd"/>`;
    if (numFmts) {
        const openTag = numFmts[0].match(/^<[^>]+>/)?.[0] ?? '<numFmts>';
        const count = Number(parseAttributes(openTag).count ?? extractTags(numFmts[1], 'numFmt').length) + 1;
        const patched = `${replaceAttribute(openTag, 'count', count)}${numFmts[1]}${formatTag}</${openTag.match(/^<(?:[A-Za-z_][\w.-]*:)?([^\s>]+)/)?.[1] ?? 'numFmts'}>`;
        output = output.replace(numFmts[0], patched);
    } else {
        output = output.replace(/(<(?:[A-Za-z_][\w.-]*:)?styleSheet\b[^>]*>)/, `$1<numFmts count="1">${formatTag}</numFmts>`);
    }
    const cellXfs = output.match(/<(?:[A-Za-z_][\w.-]*:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?cellXfs>/);
    if (!cellXfs) throw new Error('样式表缺少 cellXfs，无法写入真实日期');
    const existingXfs = extractTags(cellXfs[1], 'xf').map(({ tag }) => tag);
    let newXf = existingXfs[0] ?? '<xf fontId="0" fillId="0" borderId="0" xfId="0"/>';
    newXf = replaceAttribute(replaceAttribute(newXf, 'numFmtId', numFmtId), 'applyNumberFormat', '1');
    const openTag = cellXfs[0].match(/^<[^>]+>/)?.[0] ?? '<cellXfs>';
    const patched = `${replaceAttribute(openTag, 'count', existingXfs.length + 1)}${cellXfs[1]}${newXf}</${openTag.match(/^<(?:[A-Za-z_][\w.-]*:)?([^\s>]+)/)?.[1] ?? 'cellXfs'}>`;
    output = output.replace(cellXfs[0], patched);
    return { xml: output, styleIndex: existingXfs.length, changed: true };
}

function cellXml(ref, result, styleIndex) {
    if (result?.status === 'success' && result.latestTime) {
        const serial = excelSerialFromInstant(result.latestTime);
        if (!Number.isFinite(serial)) throw new Error('抓取结果缺少有效发布时间');
        return `<c r="${ref}" s="${styleIndex}" t="n"><v>${serial}</v></c>`;
    }
    const fallback = result?.status === 'no_target'
        ? '【无可采集对象】未找到可采集的主页作品'
        : result?.status === 'no_date' ? '没有获取到作品时间' : '抓取失败';
    const rawMessage = String(result?.error || fallback).replace(/\s+/g, ' ').trim();
    const message = (result?.status === 'no_target' && !rawMessage.startsWith('【无可采集对象】')
        ? `【无可采集对象】${rawMessage}`
        : rawMessage).slice(0, 80);
    return `<c r="${ref}" s="${styleIndex}" t="inlineStr"><is><t xml:space="preserve">${encodeXml(message)}</t></is></c>`;
}

function upsertCell(xml, rowNumber, cellReference, replacement) {
    const rowPattern = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?row\\b[^>]*\\br=(?:"${rowNumber}"|'${rowNumber}')[^>]*>[\\s\\S]*?<\\/(?:[A-Za-z_][\\w.-]*:)?row>`);
    const row = String(xml).match(rowPattern)?.[0];
    if (!row) {
        return String(xml).replace(/<\/(?:[A-Za-z_][\w.-]*:)?sheetData>/, `<row r="${rowNumber}">${replacement}</row>$&`);
    }
    const escapedRef = cellReference.replace(/[$]/g, '\\$&');
    const existingPattern = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?c\\b[^>]*\\br=(?:"${escapedRef}"|'${escapedRef}')[^>]*(?:\\/>|>[\\s\\S]*?<\\/(?:[A-Za-z_][\\w.-]*:)?c>)`);
    const patchedRow = existingPattern.test(row)
        ? row.replace(existingPattern, replacement)
        : row.replace(/<\/(?:[A-Za-z_][\w.-]*:)?row>/, `${replacement}$&`);
    return String(xml).replace(row, patchedRow);
}

function styleForCell(sheet, column, row, fallback = 0) {
    return sheet.cells.get(`${columnLetters(column)}${row}`)?.styleIndex ?? fallback;
}

async function tableTargetsForSheet(archive, sheet) {
    const relationshipById = new Map(sheet.relationships.map((relationship) => [relationship.id, relationship]));
    const tableIds = extractTags(sheet.xml, 'tablePart').map(({ attributes }) => attributes['r:id']).filter(Boolean);
    return tableIds.map((id) => relationshipById.get(id)).filter((relationship) => relationship?.type === RELATIONSHIP_TYPE.table).map((relationship) => relationship.target);
}

export async function writeWorkbookResults(workbook, { plan, results = {} }) {
    const ZipEngine = getZipEngine();
    const archive = await ZipEngine.loadAsync(workbook.sourceBytes);
    const styleResult = ensureDateStyle(await archiveText(archive, workbook.stylesPart, true));
    if (styleResult.changed) archive.file(workbook.stylesPart, styleResult.xml);
    const insertions = [];
    const taskResult = results instanceof Map ? Object.fromEntries(results) : results;

    for (const selected of plan.selectedSheets) {
        const sourceSheet = workbook.sheets.find((sheet) => sheet.name === selected.sheetName);
        if (!sourceSheet) throw new Error(`找不到工作表：${selected.sheetName}`);
        let xml = await archiveText(archive, sourceSheet.partName, true);
        if (selected.insertTimeColumn) {
            xml = insertWorksheetColumn(xml, selected.timeColumnIndex, selected.linkColumnIndex, selected.sheetName);
            insertions.push({ sheetName: selected.sheetName, insertColumn: selected.timeColumnIndex });
            const headerStyle = styleForCell(sourceSheet, selected.linkColumnIndex, selected.headerRow, 0);
            const headerRef = `${columnLetters(selected.timeColumnIndex)}${selected.headerRow}`;
            xml = upsertCell(xml, selected.headerRow, headerRef, `<c r="${headerRef}" s="${headerStyle}" t="inlineStr"><is><t>${LATEST_TIME_HEADER}</t></is></c>`);
            for (const tablePart of await tableTargetsForSheet(archive, sourceSheet)) {
                archive.file(tablePart, patchTableXml(await archiveText(archive, tablePart, true), selected.timeColumnIndex));
            }
        }

        for (const task of plan.tasks) {
            const result = taskResult[task.key];
            if (!result) continue;
            for (const occurrence of task.occurrences.filter((item) => item.sheetName === selected.sheetName)) {
                const ref = `${columnLetters(selected.timeColumnIndex)}${occurrence.row}`;
                xml = upsertCell(xml, occurrence.row, ref, cellXml(ref, result, styleResult.styleIndex));
            }
        }
        archive.file(sourceSheet.partName, xml);
    }

    if (insertions.length) {
        archive.file(workbook.workbookPart, patchWorkbookDefinedNames(await archiveText(archive, workbook.workbookPart, true), insertions));
    }
    return new Uint8Array(await archive.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' }));
}

export function excelSerialFromInstant(value) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return Number.NaN;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(timestamp)).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) / 86400000 + 25569;
}

export function getWorkbookCell(workbook, sheetName, reference) {
    return workbook.sheets.find((sheet) => sheet.name === sheetName)?.cells.get(String(reference).toUpperCase()) ?? null;
}

export function outputWorkbookName(fileName, { partial = false } = {}) {
    const base = String(fileName || '工作簿.xlsx').replace(/\.xlsx$/i, '');
    return `${base}_${partial ? '部分结果' : '已更新'}.xlsx`;
}

async function archivePartNames(archive) {
    return Object.keys(archive.files).filter((name) => !archive.files[name].dir).sort();
}

async function archivePartBytes(archive, name) {
    const entry = archive.file(name);
    return entry ? new Uint8Array(await entry.async('uint8array')) : null;
}

function equalBytes(left, right) {
    if (!left || !right || left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    return true;
}

export async function verifyWorkbookOutput(workbook, { plan, results = {}, outputBytes } = {}) {
    const ZipEngine = getZipEngine();
    const errors = [];
    let sourceArchive;
    let outputArchive;
    let expectedArchive;
    try {
        sourceArchive = await ZipEngine.loadAsync(workbook.sourceBytes);
        outputArchive = await ZipEngine.loadAsync(asUint8Array(outputBytes));
        expectedArchive = await ZipEngine.loadAsync(await writeWorkbookResults(workbook, { plan, results }));
    } catch (error) {
        return { ok: false, errors: [`输出文件无法作为 XLSX 重新打开：${error.message}`], changedParts: [] };
    }

    const sourceParts = await archivePartNames(sourceArchive);
    const outputParts = await archivePartNames(outputArchive);
    const expectedParts = await archivePartNames(expectedArchive);
    if (sourceParts.join('\n') !== outputParts.join('\n')) errors.push('OpenXML 部件清单发生变化');
    if (expectedParts.join('\n') !== outputParts.join('\n')) errors.push('输出部件清单与期望结果不一致');

    const allowed = new Set(plan.selectedSheets.map((selected) => selected.partName));
    const insertions = plan.selectedSheets.filter((selected) => selected.insertTimeColumn);
    const styleResult = ensureDateStyle(await archiveText(sourceArchive, workbook.stylesPart, true));
    if (styleResult.changed) allowed.add(workbook.stylesPart);
    if (insertions.length) allowed.add(workbook.workbookPart);
    for (const selected of insertions) {
        const sheet = workbook.sheets.find((item) => item.name === selected.sheetName);
        if (!sheet) continue;
        for (const tablePart of await tableTargetsForSheet(sourceArchive, sheet)) allowed.add(tablePart);
    }

    const changedParts = [];
    for (const name of new Set([...sourceParts, ...outputParts])) {
        const [source, output] = await Promise.all([archivePartBytes(sourceArchive, name), archivePartBytes(outputArchive, name)]);
        if (!equalBytes(source, output)) changedParts.push(name);
        if (!allowed.has(name) && !equalBytes(source, output)) errors.push(`未声明的部件发生变化：${name}`);
    }

    for (const name of new Set([...expectedParts, ...outputParts])) {
        const [expected, output] = await Promise.all([archivePartBytes(expectedArchive, name), archivePartBytes(outputArchive, name)]);
        if (!equalBytes(expected, output)) errors.push(`输出部件校验失败：${name}`);
    }

    try {
        const inspected = await inspectWorkbook(asUint8Array(outputBytes), { fileName: outputWorkbookName(workbook.fileName) });
        if (inspected.sheets.map((sheet) => sheet.name).join('\n') !== workbook.sheets.map((sheet) => sheet.name).join('\n')) {
            errors.push('工作表顺序或名称发生变化');
        }
        for (const selected of plan.selectedSheets) {
            const sheet = inspected.sheets.find((item) => item.name === selected.sheetName);
            const headerRef = `${columnLetters(selected.timeColumnIndex)}${selected.headerRow}`;
            if (sheet?.cells.get(headerRef)?.value !== LATEST_TIME_HEADER) errors.push(`${selected.sheetName}：缺少“${LATEST_TIME_HEADER}”列头`);
        }
    } catch (error) {
        errors.push(`输出工作簿重新解析失败：${error.message}`);
    }

    return { ok: errors.length === 0, errors: [...new Set(errors)], changedParts: changedParts.sort(), allowedParts: [...allowed].sort() };
}
