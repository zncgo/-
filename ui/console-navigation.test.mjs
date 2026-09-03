import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./index.html', import.meta.url), 'utf8');

test('console exposes exactly three hash-routed pages and defaults unknown hashes to links', () => {
    for (const route of ['links', 'excel', 'cookies']) {
        assert.match(source, new RegExp(`data-route="${route}" href="#${route}"`));
        assert.match(source, new RegExp(`data-page="${route}"`));
    }
    assert.match(source, /const routes = \['links', 'excel', 'cookies'\]/);
    assert.match(source, /const route = routes\.includes\(requested\) \? requested : 'links'/);
    assert.match(source, /history\.replaceState\(null, '', `#\$\{route\}`\)/);
});

test('hash routing preserves page DOM and supports browser history navigation', () => {
    const routeFunction = source.match(/function applyRoute\(\) \{([\s\S]*?)\n        \}/)?.[1] || '';
    assert.match(routeFunction, /page\.hidden = page\.dataset\.page !== route/);
    assert.equal(routeFunction.includes('innerHTML'), false);
    assert.match(source, /window\.addEventListener\('hashchange', applyRoute\)/);
});

test('desktop sidebar becomes a compact top navigation below 980 pixels', () => {
    assert.match(source, /\.app-layout \{ display: grid; grid-template-columns: 210px minmax\(0, 1fr\)/);
    assert.match(source, /@media \(max-width: 980px\)[\s\S]*?\.sidebar \{ position: static; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
});

test('per-platform and all-platform concurrency controls live only on the Cookie page', () => {
    assert.match(source, /id="cookieConcurrency"/);
    assert.match(source, /id="allCookieConcurrency"/);
    assert.match(source, /id="applyAllConcurrencyBtn"/);
    assert.equal(source.includes('id="concurrency"'), false);
    assert.match(source, /\/api\/cookies\/concurrency\/all/);
    assert.match(source, /各平台不同/);
});

test('permanent deletion is confirmed in a dialog whose default action is cancel', () => {
    assert.match(source, /data-cookie-action="purge"/);
    assert.match(source, /\/purge/);
    assert.match(source, /此操作不可恢复/);
    assert.match(source, /id="confirmDialogCancel"[^>]*autofocus/);
    assert.equal(source.includes('RSSHUB · LOCAL CONSOLE'), false);
});
