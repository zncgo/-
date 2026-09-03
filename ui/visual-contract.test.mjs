import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');

test('initializes and persists a complete light and dark token system before paint', () => {
    assert.match(html, /<script>\s*\(\(\) => \{/);
    assert.match(html, /rsshub-console-theme/);
    assert.match(html, /window\.matchMedia\('\(prefers-color-scheme: dark\)'\)/);
    assert.match(html, /document\.documentElement\.dataset\.theme = theme/);
    assert.match(html, /:root\[data-theme="dark"\]/);
    for (const token of ['app-bg', 'surface', 'surface-muted', 'border', 'text', 'text-muted', 'brand', 'success', 'warning', 'danger', 'focus-ring', 'shadow']) {
        assert.match(html, new RegExp(`--${token}:`));
    }
    assert.match(html, /localStorage\.setItem\(themeStorageKey, nextTheme\)/);
});

test('uses a 100dvh desktop application shell with an independently scrolling main region', () => {
    assert.match(html, /html, body \{ width: 100%; min-width: 1280px; height: 100%; overflow: hidden;/);
    assert.match(html, /\.shell \{ width: 100%; height: 100dvh;/);
    assert.match(html, /grid-template-columns: var\(--sidebar-width\) minmax\(0, 1fr\)/);
    assert.match(html, /\.app-main \{ grid-column: 2; grid-row: 2; min-width: 0; overflow: auto;/);
    assert.match(html, /\.topbar \{ grid-column: 2; grid-row: 1;/);
});

test('provides three SVG navigation entries and persistent accessible sidebar collapse', () => {
    for (const route of ['links', 'excel', 'cookies']) {
        assert.match(html, new RegExp(`data-route="${route}"[^>]*title="[^"]+"[^>]*aria-label="[^"]+"`));
    }
    assert.equal((html.match(/class="nav-icon"/g) || []).length, 3);
    assert.match(html, /--sidebar-width: 216px/);
    assert.match(html, /:root\[data-sidebar="collapsed"\] \{ --sidebar-width: 72px;/);
    assert.match(html, /rsshub-console-sidebar-collapsed/);
    assert.match(html, /localStorage\.setItem\(sidebarStorageKey, collapsed \? '1' : '0'\)/);
    assert.match(html, /id="sidebarToggle"[^>]*aria-label="收起侧栏"/);
});

test('exposes accessible theme controls and honors reduced motion', () => {
    assert.match(html, /id="themeToggle"[^>]*aria-label="切换到深色主题"/);
    assert.match(html, /id="themeToggleLabel"/);
    assert.match(html, /button:focus-visible, a:focus-visible/);
    assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(html, /transition-duration: \.01ms !important/);
});

test('keeps compact panel geometry and unified titles for every functional page', () => {
    assert.match(html, /\.card \{ border-color: var\(--border\); border-radius: 12px;/);
    assert.equal((html.match(/class="page-heading"/g) || []).length, 3);
    assert.match(html, /<h2>链接核对<\/h2>/);
    assert.match(html, /<h2>Excel 批量补齐<\/h2>/);
    assert.match(html, /<h2>Cookie 管理<\/h2>/);
    assert.match(html, /th \{ position: sticky;/);
});
