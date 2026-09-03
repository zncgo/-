import assert from 'node:assert/strict';
import test from 'node:test';

import {
    classifyWorkbookFailure,
    createWorkbookRetryPlan,
    runWorkbookTasks,
    runWorkbookTasksWithRetry,
    shortWorkbookError,
    workbookPlatformCapacity,
    workbookPlatformKey,
} from './workbook-runner.mjs';

function plan(tasks) {
    return { tasks: tasks.map((task, index) => ({ key: `k${index}`, url: `https://example.test/${index}`, ...task })) };
}

test('maps every workbook platform label used by the query service', () => {
    assert.equal(workbookPlatformKey('抖音'), 'douyin');
    assert.equal(workbookPlatformKey('B站'), 'bilibili');
    assert.equal(workbookPlatformKey('西瓜视频'), 'ixigua');
    assert.equal(workbookPlatformKey('未知'), '');
});

test('derives concurrency from healthy and pending cookie members', () => {
    const snapshot = { platforms: [{ platform: 'douyin', perCookieConcurrency: 2, totalCapacity: 0, members: [{ status: 'pending' }, { status: 'invalid' }] }] };
    assert.equal(workbookPlatformCapacity('抖音', snapshot), 2);
    assert.equal(workbookPlatformCapacity('知乎', snapshot), 1);
});

test('queries every deduplicated task once and obeys per-platform capacity', async () => {
    const calls = new Map();
    const active = new Map();
    const maximum = new Map();
    const input = plan([
        { platform: '抖音' }, { platform: '抖音' }, { platform: '抖音' },
        { platform: 'B站' }, { platform: 'B站' },
    ]);
    const result = await runWorkbookTasks(input, {
        globalLimit: 8,
        getCookieSnapshot: async () => ({ platforms: [
            { platform: 'douyin', totalCapacity: 2, members: [] },
            { platform: 'bilibili', totalCapacity: 1, members: [] },
        ] }),
        query: async (task) => {
            calls.set(task.key, (calls.get(task.key) ?? 0) + 1);
            active.set(task.platform, (active.get(task.platform) ?? 0) + 1);
            maximum.set(task.platform, Math.max(maximum.get(task.platform) ?? 0, active.get(task.platform)));
            await Promise.resolve();
            active.set(task.platform, active.get(task.platform) - 1);
            return { ok: true, status: 'success', latestTime: '2026-08-20T00:00:00Z' };
        },
    });
    assert.equal(result.states.every((state) => state.status === 'success'), true);
    assert.equal([...calls.values()].every((count) => count === 1), true);
    assert.equal(maximum.get('抖音'), 2);
    assert.equal(maximum.get('B站'), 1);
});

test('keeps no workbook result for work stopped by abort', async () => {
    const controller = new AbortController();
    const input = plan([{ platform: '抖音' }, { platform: '抖音' }]);
    const result = await runWorkbookTasks(input, {
        signal: controller.signal,
        getCookieSnapshot: async () => ({ platforms: [{ platform: 'douyin', totalCapacity: 1, members: [] }] }),
        query: async (_task, { signal }) => {
            controller.abort();
            throw Object.assign(new Error('aborted'), { name: signal.aborted ? 'AbortError' : 'Error' });
        },
    });
    assert.equal(result.stopped, true);
    assert.deepEqual(result.results, {});
    assert.equal(result.states.every((state) => state.status === 'stopped'), true);
});

test('normalizes service failures to short single-line Chinese workbook text', async () => {
    assert.equal(shortWorkbookError('  Cookie  \n  失效  '), 'Cookie 失效');
    const input = plan([{ platform: '抖音' }]);
    const result = await runWorkbookTasks(input, { query: async () => ({ ok: false, error: '风控失败' }) });
    assert.deepEqual(result.results.k0, { status: 'error', error: '【临时风控】风控失败' });
});

test('classifies Excel failure causes and retryability conservatively', () => {
    const cases = [
        ['没有可用的一点资讯 Cookie', '缺少可用Cookie', false],
        ['主页显示用户或内容不存在', '无可采集对象', false],
        ['作者链接已失效并跳转到平台首页', '无可采集对象', false],
        ['懂车帝触发人机验证；当前 Cookie 在 Docker 浏览器环境未获平台接受', '人机验证', false],
        ['知乎页面被平台拦截（HTTP 403）；当前 Cookie 在 Docker 浏览器环境未获平台接受', '浏览器环境拦截', false],
        ['作品列表请求失败（HTTP 404）', '页面不存在', false],
        ['作品列表请求失败（HTTP 403）', '访问受限', false],
        ['主页读取失败（浏览器 HTTP 400）', '请求异常', false],
        ['主页读取失败（浏览器 HTTP 408）', '请求超时', true],
        ['请求频繁（HTTP 429）', '临时风控', true],
        ['作品列表请求失败（HTTP 503）', '平台临时异常', true],
        ['fetch failed', '连接异常', true],
        ['主页没有提取到明确作品发布时间', '未提取到时间', false],
    ];
    for (const [message, category, retryable] of cases) {
        const classified = classifyWorkbookFailure(message);
        assert.equal(classified.category, category, message);
        assert.equal(classified.retryable, retryable, message);
        assert.match(classified.error, new RegExp(`^【${category}】`), message);
    }
});

test('does not retry a deterministic browser-empty fallback after a native 503', async () => {
    const input = plan([{ platform: '腾讯新闻' }]);
    let calls = 0;
    const result = await runWorkbookTasksWithRetry(input, {
        query: async () => {
            calls += 1;
            return {
                ok: false,
                error: '腾讯新闻作品列表请求失败（HTTP 503）；浏览器回退也失败：腾讯新闻主页没有提取到明确作品发布时间',
            };
        },
    });

    assert.equal(calls, 1);
    assert.equal(result.retryRoundCount, 0);
    assert.equal(result.retryAttemptCount, 0);
    assert.equal(result.states[0].retryable, false);
    assert.match(result.results.k0.error, /^【未提取到时间】/);
});

test('builds one retry round from errors only and keeps deduplicated task occurrences', () => {
    const input = plan([
        { platform: '抖音', occurrences: [{ sheetName: 'A', row: 2 }, { sheetName: 'B', row: 8 }] },
        { platform: '快手' },
        { platform: 'B站' },
    ]);
    const retry = createWorkbookRetryPlan(input, [
        { key: 'k0', status: 'error' },
        { key: 'k1', status: 'no_date' },
        { key: 'k2', status: 'no_target' },
    ]);
    assert.deepEqual(retry.tasks.map((task) => task.key), ['k0']);
    assert.equal(retry.tasks[0].occurrences.length, 2);
    assert.equal(retry.uniqueTaskCount, 1);
});

test('retries failed workbook tasks once after the first round and merges recovered results', async () => {
    const input = plan([{ platform: '抖音' }, { platform: '快手' }, { platform: 'B站' }]);
    const calls = new Map();
    const retryStarts = [];
    const result = await runWorkbookTasksWithRetry(input, {
        query: async (task) => {
            const attempt = (calls.get(task.key) ?? 0) + 1;
            calls.set(task.key, attempt);
            if (task.key === 'k0' && attempt === 1) return { ok: false, error: '临时风控' };
            if (task.key === 'k1') return { ok: true, status: 'no_date', error: '没有作品时间' };
            return { ok: true, status: 'success', latestTime: `2026-08-2${attempt}T00:00:00Z` };
        },
        onRetryStart: (details) => retryStarts.push(details.retryCount),
    });
    assert.deepEqual(Object.fromEntries(calls), { k0: 2, k1: 1, k2: 1 });
    assert.deepEqual(retryStarts, [1]);
    assert.equal(result.retriedTaskCount, 1);
    assert.equal(result.results.k0.status, 'success');
    assert.equal(result.results.k1.status, 'no_date');
    assert.equal(result.states.find((state) => state.key === 'k0').attempt, 2);
    assert.equal(result.states.find((state) => state.key === 'k2').attempt, 1);
});

test('runs at most three retry rounds and only carries forward accounts that still fail', async () => {
    const input = plan([{ platform: '抖音' }, { platform: '快手' }]);
    const calls = new Map();
    const retryRounds = [];
    const result = await runWorkbookTasksWithRetry(input, {
        query: async (task) => {
            const attempt = (calls.get(task.key) ?? 0) + 1;
            calls.set(task.key, attempt);
            if (task.key === 'k0') return { ok: false, error: `持续失败${attempt}` };
            if (attempt < 3) return { ok: false, error: `临时失败${attempt}` };
            return { ok: true, status: 'success', latestTime: '2026-08-28T00:00:00Z' };
        },
        onRetryStart: ({ retryRound, retryCount }) => retryRounds.push([retryRound, retryCount]),
    });
    assert.deepEqual(Object.fromEntries(calls), { k0: 4, k1: 3 });
    assert.deepEqual(retryRounds, [[1, 2], [2, 2], [3, 1]]);
    assert.equal(result.retryRoundCount, 3);
    assert.equal(result.retryAttemptCount, 5);
    assert.equal(result.results.k0.status, 'error');
    assert.equal(result.results.k1.status, 'success');
    assert.equal(result.states.find((state) => state.key === 'k0').attempt, 4);
    assert.equal(result.states.find((state) => state.key === 'k1').attempt, 3);
});

test('does not retry permanent Excel failures but still retries transient platform errors', async () => {
    const input = plan([
        { platform: '一点资讯' },
        { platform: '今日头条' },
        { platform: '腾讯新闻' },
        { platform: '网上车市' },
        { platform: '西瓜视频' },
        { platform: '凤凰新闻' },
    ]);
    const calls = new Map();
    const errors = [
        '没有可用的一点资讯 Cookie',
        '今日头条作品列表请求失败（HTTP 404）',
        '腾讯新闻主页显示用户或内容不存在',
        '网上车市作者链接已失效并跳转到平台首页',
    ];
    const result = await runWorkbookTasksWithRetry(input, {
        query: async (task) => {
            const attempt = (calls.get(task.key) ?? 0) + 1;
            calls.set(task.key, attempt);
            if (Number(task.key.slice(1)) < errors.length) return { ok: false, error: errors[Number(task.key.slice(1))] };
            if (task.key === 'k4') return { ok: true, status: 'no_date', error: '没有作品时间' };
            if (attempt === 1) return { ok: false, error: '凤凰新闻作品列表请求失败（HTTP 503）' };
            return { ok: true, status: 'success', latestTime: '2026-08-28T00:00:00Z' };
        },
    });
    assert.deepEqual(Object.fromEntries(calls), { k0: 1, k1: 1, k2: 1, k3: 1, k4: 1, k5: 2 });
    assert.equal(result.results.k5.status, 'success');
    assert.equal(result.retryAttemptCount, 1);
    assert.match(result.results.k0.error, /^【缺少可用Cookie】/);
    assert.match(result.results.k1.error, /^【页面不存在】/);
    assert.equal(result.results.k2.status, 'no_target');
    assert.match(result.results.k2.error, /^【无可采集对象】/);
    assert.equal(result.results.k3.status, 'no_target');
    assert.match(result.results.k3.error, /^【无可采集对象】/);
    assert.match(result.results.k4.error, /^【无作品时间】/);
});
