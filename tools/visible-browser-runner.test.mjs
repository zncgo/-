import assert from 'node:assert/strict';
import test from 'node:test';

import { filterVisibleBrowserCandidates, normalizeVisibleBrowserCookies } from './visible-browser-runner.mjs';

test('keeps only explicit Dongchedi work dates and deduplicates cards', () => {
    const items = filterVisibleBrowserCandidates('dongchedi', [
        { date: '05-14', title: '最新视频', url: 'https://www.dongchedi.com/video/1' },
        { date: '05-14', title: '重复视频', url: 'https://www.dongchedi.com/video/1' },
        { date: '3天前', title: '相对时间', url: 'https://www.dongchedi.com/video/2' },
    ]);
    assert.deepEqual(items, [{ date: '05-14', title: '最新视频', url: 'https://www.dongchedi.com/video/1' }]);
});

test('keeps Zhihu activity timestamps but not page generation dates', () => {
    const items = filterVisibleBrowserCandidates('zhihu', [
        { date: '2016-07-31 00:38', title: '回答', url: 'https://www.zhihu.com/question/1/answer/2' },
        { date: '2026-09-03', title: '页面日期', url: 'https://www.zhihu.com/question/3/answer/4' },
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0].date, '2016-07-31 00:38');
});

test('normalizes Chrome exports before injecting visible-browser cookies', () => {
    const cookies = normalizeVisibleBrowserCookies([
        { name: 'session', value: 'secret', domain: '.dongchedi.com', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: 2_000_000_000 },
        { name: 'session', value: 'expired', domain: '.dongchedi.com', expirationDate: 1 },
        { name: 'other', value: 'secret', domain: '.zhihu.com' },
    ], ['dongchedi.com'], 1_000_000_000_000);
    assert.deepEqual(cookies, [{
        name: 'session', value: 'secret', domain: '.dongchedi.com', path: '/', secure: true, httpOnly: true, sameSite: 'None', expires: 2_000_000_000,
    }]);
});
