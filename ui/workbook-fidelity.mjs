import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const JSZip = require('./vendor/jszip-3.10.1.min.cjs');

const XML_PART_PATTERN = /(?:\.xml|\.rels)$/i;

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function decodeXml(value = '') {
    return String(value)
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&');
}

function parseAttributes(tag = '') {
    const attributes = {};
    const pattern = /([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (const match of tag.matchAll(pattern)) {
        attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? '');
    }
    return attributes;
}

function canonicalizeTag(tag) {
    if (/^<\/?(?:\?|!)/.test(tag) || /^<\//.test(tag)) return tag;
    const match = tag.match(/^<([^\s/>]+)([\s\S]*?)(\/?)>$/);
    if (!match) return tag;
    const [, name, body, slash] = match;
    const attributes = [...body.matchAll(/([^\s=<>]+)\s*=\s*("[^"]*"|'[^']*')/g)]
        .map((entry) => [entry[1], entry[2]])
        .sort(([left], [right]) => left.localeCompare(right));
    return `<${name}${attributes.length ? ` ${attributes.map(([key, value]) => `${key}=${value}`).join(' ')}` : ''}${slash}>`;
}

function canonicalizeXml(xml) {
    return String(xml)
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n')
        .replace(/<[^<>]+>/g, canonicalizeTag)
        .replace(/>\s+</g, '><')
        .trim();
}

function extractTags(xml, tagName) {
    const pattern = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${tagName}\\b[^>]*>`, 'g');
    return [...String(xml).matchAll(pattern)].map((match) => parseAttributes(match[0]));
}

function extractFirstTag(xml, tagName) {
    return extractTags(xml, tagName)[0] ?? null;
}

function normalizeRelationshipTarget(basePart, target) {
    if (!target || /^[a-z]+:/i.test(target)) return target;
    if (target.startsWith('/')) return target.replace(/^\/+/, '');
    return path.posix.normalize(path.posix.join(path.posix.dirname(basePart), target));
}

function relationshipPartFor(partName) {
    const directory = path.posix.dirname(partName);
    return path.posix.join(directory, '_rels', `${path.posix.basename(partName)}.rels`);
}

function summarizeRelationships(xml, ownerPart) {
    return extractTags(xml, 'Relationship')
        .map((attributes) => ({
            id: attributes.Id ?? '',
            type: attributes.Type ?? '',
            target: normalizeRelationshipTarget(ownerPart, attributes.Target ?? ''),
            targetMode: attributes.TargetMode ?? '',
        }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function summarizeWorksheet(xml) {
    const cells = [];
    const cellPattern = /<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>|<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*)\/>/g;
    for (const match of String(xml).matchAll(cellPattern)) {
        const attributes = parseAttributes(`<c ${match[1] ?? match[3] ?? ''}>`);
        const body = match[2] ?? '';
        const formula = body.match(/<(?:[A-Za-z_][\w.-]*:)?f\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?f>/)?.[1] ?? '';
        const value = body.match(/<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/)?.[1]
            ?? body.match(/<(?:[A-Za-z_][\w.-]*:)?is\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?is>/)?.[1]
            ?? '';
        cells.push({
            ref: attributes.r ?? '',
            type: attributes.t ?? '',
            style: attributes.s ?? '',
            formula: canonicalizeXml(formula),
            value: canonicalizeXml(value),
        });
    }

    return {
        cells,
        columns: extractTags(xml, 'col'),
        rows: extractTags(xml, 'row').map(({ r = '', ht = '', customHeight = '', hidden = '', outlineLevel = '', s = '', customFormat = '' }) => ({ r, ht, customHeight, hidden, outlineLevel, s, customFormat })),
        merges: extractTags(xml, 'mergeCell').map(({ ref = '' }) => ref),
        hyperlinks: extractTags(xml, 'hyperlink').map(({ ref = '', 'r:id': relationshipId = '', location = '', display = '', tooltip = '' }) => ({ ref, relationshipId, location, display, tooltip })),
        autoFilter: extractFirstTag(xml, 'autoFilter'),
        pane: extractFirstTag(xml, 'pane'),
        tableParts: extractTags(xml, 'tablePart').map(({ 'r:id': relationshipId = '' }) => relationshipId),
    };
}

function summarizeTable(xml) {
    const table = extractFirstTag(xml, 'table') ?? {};
    return {
        name: table.name ?? '',
        displayName: table.displayName ?? '',
        ref: table.ref ?? '',
        totalsRowCount: table.totalsRowCount ?? '',
        autoFilter: extractFirstTag(xml, 'autoFilter'),
        columns: extractTags(xml, 'tableColumn').map(({ id = '', name = '', totalsRowFunction = '', totalsRowLabel = '' }) => ({ id, name, totalsRowFunction, totalsRowLabel })),
    };
}

async function loadParts(bytes) {
    const archive = await JSZip.loadAsync(bytes);
    const names = Object.keys(archive.files).filter((name) => !archive.files[name].dir).sort();
    const parts = new Map();
    for (const name of names) {
        const entry = archive.files[name];
        if (XML_PART_PATTERN.test(name) || name === '[Content_Types].xml') {
            parts.set(name, await entry.async('string'));
        } else {
            parts.set(name, new Uint8Array(await entry.async('uint8array')));
        }
    }
    return parts;
}

export async function fingerprintWorkbook(bytes) {
    const parts = await loadParts(bytes);
    const workbookPart = 'xl/workbook.xml';
    const workbookXml = String(parts.get(workbookPart) ?? '');
    const workbookRelationshipsPart = relationshipPartFor(workbookPart);
    const workbookRelationships = summarizeRelationships(String(parts.get(workbookRelationshipsPart) ?? ''), workbookPart);
    const relationshipById = new Map(workbookRelationships.map((relationship) => [relationship.id, relationship]));
    const sheets = [];

    for (const attributes of extractTags(workbookXml, 'sheet')) {
        const relationship = relationshipById.get(attributes['r:id'] ?? '');
        const partName = relationship?.target ?? '';
        const sheetXml = String(parts.get(partName) ?? '');
        const sheetRelationshipsPart = relationshipPartFor(partName);
        const sheetRelationships = parts.has(sheetRelationshipsPart)
            ? summarizeRelationships(String(parts.get(sheetRelationshipsPart)), partName)
            : [];
        const sheetRelationshipById = new Map(sheetRelationships.map((entry) => [entry.id, entry]));
        const worksheet = summarizeWorksheet(sheetXml);
        const tables = worksheet.tableParts.map((relationshipId) => {
            const target = sheetRelationshipById.get(relationshipId)?.target ?? '';
            return { partName: target, summary: summarizeTable(String(parts.get(target) ?? '')) };
        });
        sheets.push({
            name: attributes.name ?? '',
            sheetId: attributes.sheetId ?? '',
            state: attributes.state ?? 'visible',
            partName,
            worksheet,
            tables,
            relationships: sheetRelationships,
        });
    }

    const relationships = [];
    for (const [name, value] of parts) {
        if (!name.endsWith('.rels')) continue;
        const ownerPart = name === '_rels/.rels'
            ? ''
            : path.posix.join(path.posix.dirname(path.posix.dirname(name)), path.posix.basename(name, '.rels'));
        relationships.push({ partName: name, entries: summarizeRelationships(String(value), ownerPart) });
    }

    const partDigests = [...parts.entries()].map(([name, value]) => ({
        name,
        digest: sha256(typeof value === 'string' ? canonicalizeXml(value) : value),
        size: typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength,
    }));

    return {
        packageHash: sha256(bytes),
        partNames: [...parts.keys()],
        partDigests,
        sheets,
        relationships: relationships.sort((left, right) => left.partName.localeCompare(right.partName)),
    };
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function compareWorkbookFingerprints(source, output) {
    const differences = [];
    const compare = (category, left, right) => {
        if (stableJson(left) !== stableJson(right)) differences.push(category);
    };

    compare('package part names', source.partNames, output.partNames);
    compare('sheet count/order and worksheet structures', source.sheets, output.sheets);
    compare('relationship resources', source.relationships, output.relationships);

    const sourceDigests = new Map(source.partDigests.map((entry) => [entry.name, entry.digest]));
    const outputDigests = new Map(output.partDigests.map((entry) => [entry.name, entry.digest]));
    const changedParts = [...new Set([...sourceDigests.keys(), ...outputDigests.keys()])]
        .filter((name) => sourceDigests.get(name) !== outputDigests.get(name))
        .sort();
    if (changedParts.length) differences.push('OpenXML part contents');

    return {
        ok: differences.length === 0,
        differences,
        changedParts,
        sourcePackageHash: source.packageHash,
        outputPackageHash: output.packageHash,
        sourceSheetCount: source.sheets.length,
        outputSheetCount: output.sheets.length,
        sourceTableCount: source.sheets.reduce((sum, sheet) => sum + sheet.tables.length, 0),
        outputTableCount: output.sheets.reduce((sum, sheet) => sum + sheet.tables.length, 0),
    };
}
