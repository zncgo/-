import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');

test('auth gate is present before the application shell', () => {
    assert.ok(html.indexOf('id="authGate"') < html.indexOf('<main class="shell">'));
});

test('login form uses browser password autocomplete', () => {
    assert.match(html, /id="authPassword"[^>]+autocomplete="current-password"/);
});

test('username field is bounded', () => {
    assert.match(html, /id="authUsername"[^>]+maxlength="50"/);
});

test('activation form is separate from password login', () => {
    assert.match(html, /id="activateForm" class="hidden"/);
    assert.match(html, /id="authCode"/);
});

test('browser boot calls the public session recovery endpoint', () => {
    assert.match(html, /fetch\('\/api\/auth\/session'/);
});

test('browser sends credentials only to the login endpoint', () => {
    assert.match(html, /submitAuth\('\/api\/auth\/login'/);
    assert.doesNotMatch(html, /localStorage\.(setItem|getItem)\([^)]*password/i);
});

test('browser sends card codes only to activation endpoint', () => {
    assert.match(html, /submitAuth\('\/api\/auth\/activate'/);
});

test('browser schedules server-directed heartbeats', () => {
    assert.match(html, /fetch\('\/api\/auth\/heartbeat'/);
    assert.match(html, /heartbeatIntervalS/);
});

test('all nine authorization states have UI copy', () => {
    for (const state of ['signedOut', 'signedInUnlicensed', 'active', 'expired', 'deviceLimit', 'upgradeRequired', 'appDisabled', 'networkError', 'forcedOut']) {
        assert.match(html, new RegExp(state));
    }
});

test('network error copy describes the thirty minute grace period', () => {
    assert.match(html, /30 分钟/);
});

test('network error does not clear the active task in the browser', () => {
    assert.match(html, /当前任务不会被卸载/);
    assert.match(html, /activeRun\?\.controller\.abort\(\)/);
});

test('expired and forced states stop dispatch while retaining completed results', () => {
    assert.match(html, /已停止派发新任务，当前已完成结果保留/);
});

test('new work requires a valid authorization state', () => {
    assert.match(html, /!\['active','networkError'\]\.includes\(authState\)/);
});

test('protected API failures trigger session re-evaluation', () => {
    assert.match(html, /response\.status === 401 \|\| response\.status === 403/);
    assert.match(html, /loadAuthSession\(\)/);
});

test('application shell stays hidden during recovery', () => {
    assert.match(html, /document\.querySelector\('\.shell'\)\.style\.display = 'none'/);
});

test('only active state unlocks the original UI', () => {
    assert.match(html, /authState === 'active' && !appUnlocked/);
});

test('login and activation buttons are ordinary forms with no registration path', () => {
    assert.match(html, /id="loginForm"/);
    assert.match(html, /id="activateForm"/);
    assert.doesNotMatch(html, /\/api\/auth\/register/);
});
