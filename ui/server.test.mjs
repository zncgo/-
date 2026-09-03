import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Script } from 'node:vm';

import { COOKIE_PLATFORM_DEFINITIONS, COOKIE_PLATFORMS, CookiePool } from './cookie-pool.mjs';
import { createAppServer, parseRssHubXmlFeed } from './server.mjs';

test('parses RSSHub XML items for platform feeds without trusting document order', () => {
    const feed = parseRssHubXmlFeed(`<?xml version="1.0"?><rss><channel><title><![CDATA[示例主页]]></title>
        <item><title><![CDATA[旧作品]]></title><link>https://example.com/old</link><pubDate>Wed, 20 Aug 2025 01:00:00 GMT</pubDate></item>
        <item><title>新作品</title><link>https://example.com/new?x=1&amp;y=2</link><pubDate>Thu, 21 Aug 2025 02:00:00 GMT</pubDate></item>
    </channel></rss>`);
    assert.equal(feed.title, '示例主页');
    assert.equal(feed.items.length, 2);
    assert.equal(feed.items[1].url, 'https://example.com/new?x=1&y=2');
    assert.equal(feed.items[1].date_published, 'Thu, 21 Aug 2025 02:00:00 GMT');
});

test('serves the browser-local workbook modules and vendored ZIP engine', async () => {
    await withServer(async ({ baseUrl }) => {
        for (const [path, marker] of [
            ['/workbook-ui.mjs', 'startWorkbookRun'],
            ['/workbook.mjs', 'inspectWorkbook'],
            ['/workbook-runner.mjs', 'runWorkbookTasks'],
            ['/core.mjs', 'buildRoute'],
            ['/vendor/jszip-3.10.1.min.js', 'JSZip'],
        ]) {
            const response = await fetch(`${baseUrl}${path}`);
            assert.equal(response.status, 200, path);
            assert.match(response.headers.get('content-type'), /javascript/);
            assert.equal((await response.text()).includes(marker), true, path);
        }
    });
});

test('all embedded Browserless functions are syntactically valid', async () => {
    const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
    let offset = 0;
    let count = 0;
    while ((offset = source.indexOf('const code = `module.exports', offset)) >= 0) {
        const start = source.indexOf('`', offset);
        const end = source.indexOf('`;', start + 1);
        assert.ok(end > start, `Browserless template ${count} is not terminated`);
        const raw = source.slice(start + 1, end)
            .replace('${JSON.stringify(cookies)}', '[]')
            .replace('${findDouyinAuthorSecUid.toString()}', "()=>''")
            .replace('${findDouyinAuthorSecUidFromLinkedData.toString()}', "()=>''");
        const rendered = Function(`return \`${raw}\`;`)();
        assert.doesNotThrow(() => new Script(rendered), `Browserless template ${count}`);
        count += 1;
        offset = end + 2;
    }
    assert.equal(count, 9);
});

function makeCookieJson(domain = '.douyin.com') {
    return JSON.stringify([{
        domain,
        name: 'sessionid',
        value: randomUUID(),
        path: '/',
        expirationDate: Math.floor(Date.now() / 1000) + 3600,
    }]);
}

async function withServer(run, { platformAdapters = {} } = {}) {
    const rootDir = await mkdtemp(join(tmpdir(), 'rsshub-cookie-api-'));
    const pool = await new CookiePool({ rootDir }).init();
    const server = createAppServer({ cookiePool: pool, platformAdapters });
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
        await run({ baseUrl, pool, rootDir });
    } finally {
        await pool.flush();
        await new Promise((resolve) => server.close(resolve));
        await rm(rootDir, { recursive: true, force: true });
    }
}

test('cookie list API returns all registered platform summaries without credentials', async () => {
    await withServer(async ({ baseUrl, pool, rootDir }) => {
        const content = makeCookieJson();
        const credentialValue = JSON.parse(content)[0].value;
        await writeFile(join(rootDir, 'douyin.json'), content, 'utf8');
        await pool.rescan();

        const response = await fetch(`${baseUrl}/api/cookies`);
        const payload = await response.json();
        assert.equal(response.status, 200);
        assert.equal(payload.platforms.length, 29);
        assert.deepEqual(payload.platforms.map((entry) => entry.platform), [...COOKIE_PLATFORMS]);
        assert.equal(payload.platforms.every((entry) => Array.isArray(entry.hosts) && entry.hosts.length > 0), true);
        assert.equal(payload.platforms.every((entry) => entry.schedulingEnabled), true);
        assert.equal(JSON.stringify(payload).includes(credentialValue), false);
    });
});

test('platform URL families use their cookie pool unless the official public interface needs no session', async () => {
    const cases = [
        ['douyin', 'https://www.douyin.com/user/MS4wLjABAAAAexample'],
        ['xiaohongshu', 'https://www.xiaohongshu.com/user/profile/593032945e87e77791e03696'],
        ['kuaishou', 'https://www.kuaishou.com/profile/3xuemaqzwetdhxk'],
        ['bilibili', 'https://space.bilibili.com/2267573'],
        ['weibo', 'https://weibo.com/u/123456'],
        ['zhihu', 'https://www.zhihu.com/people/example-user'],
        ['toutiao', 'https://www.toutiao.com/c/user/token/abc123/'],
        ['netease', 'https://www.163.com/dy/media/T123456789.html'],
        ['dongchedi', 'https://www.dongchedi.com/user/profile/1638816251446276'],
        ['yidian', 'https://www.yidianzixun.com/channel/m12345'],
        ['ucdayu', 'http://a.mp.uc.cn/media?mid=12345'],
        ['sohu_news', 'https://www.sohu.com/a/123?xpt=abc123'],
        ['tencent_news', 'https://view.inews.qq.com/media/7961850'],
        ['ifeng', 'https://ishare.ifeng.com/mediaShare/home/12345/media'],
        ['baijiahao', 'https://baijiahao.baidu.com/u?app_id=12345'],
        ['autohome', 'https://chejiahao.autohome.com.cn/Authors/12345'],
        ['xcar', 'https://my.xcar.com.cn/12345'],
        ['qctt', 'https://www.qctt.cn/user/12345'],
        ['pcauto', 'https://my.pcauto.com.cn/12345'],
        ['cheshi', 'https://space.cheshi.com/12345'],
        ['yiche', 'https://hao.yiche.com/12345'],
        ['iqiyi', 'https://www.iqiyi.com/u/12345'],
        ['youku', 'https://i.youku.com/i/UMTIzNDU='],
        ['tencent_video', 'https://v.qq.com/x/bu/h5_user_center?uid=12345'],
        ['meipai', 'https://www.meipai.com/user/12345'],
        ['sohu_video', 'https://tv.sohu.com/user/336238776'],
        ['video56', 'https://www.56.com/u/12345'],
        ['miaopai', 'https://www.miaopai.com/u/12345'],
        ['ixigua', 'https://www.ixigua.com/home/12345'],
    ];
    const leased = [];
    await withServer(async ({ baseUrl, pool }) => {
        for (const [platform] of cases) {
            await pool.import(platform, { content: makeCookieJson(`.${COOKIE_PLATFORM_DEFINITIONS[platform].domain}`) });
        }
        for (const [platform, url] of cases) {
            const response = await fetch(`${baseUrl}/api/query?url=${encodeURIComponent(url)}`);
            const payload = await response.json();
            assert.equal(response.status, 200, `${platform}: ${payload.error || ''}`);
            assert.equal(payload.status, 'success', platform);
        }
        assert.deepEqual(leased, cases.filter(([platform]) => platform !== 'qctt').map(([platform]) => platform));
    }, {
        platformAdapters: {
            fetchPlatformFeed: async ({ platform, cookieLease }) => {
                if (platform === 'qctt') {
                    assert.equal(cookieLease, null);
                } else {
                    leased.push(platform);
                    assert.equal(cookieLease.platform, platform);
                }
                return { title: platform, items: [{ title: '作品', date_published: '2026-08-20T00:00:00Z' }] };
            },
        },
    });
});

test('public fallback platforms can start a query without an imported cookie', async () => {
    const cases = [
        ['yidian', 'https://www.yidianzixun.com/channel/m12345'],
        ['ucdayu', 'https://a.mp.uc.cn/media?mid=12345'],
        ['xcar', 'https://my.xcar.com.cn/12345'],
    ];
    const seen = [];
    const resolvedPlatforms = [];
    await withServer(async ({ baseUrl }) => {
        for (const [platform, url] of cases) {
            const response = await fetch(`${baseUrl}/api/query?url=${encodeURIComponent(url)}`);
            const payload = await response.json();
            assert.equal(response.status, 200, `${platform}: ${payload.error || ''}`);
            assert.equal(payload.status, 'success', platform);
        }
        assert.deepEqual(seen, cases.map(([platform]) => platform));
    }, {
        platformAdapters: {
            resolveProfileUrl: async (url, { platform }) => {
                resolvedPlatforms.push(platform);
                return url;
            },
            fetchPlatformFeed: async ({ platform, cookieLease }) => {
                seen.push(platform);
                assert.equal(cookieLease, null);
                return { title: platform, items: [{ title: '公开作品', date_published: '2026-08-20T00:00:00Z' }] };
            },
        },
    });
    assert.deepEqual(resolvedPlatforms, cases.map(([platform]) => platform));
});

test('cookie import API adds a pending member without returning its value', async () => {
    await withServer(async ({ baseUrl }) => {
        const content = makeCookieJson();
        const credentialValue = JSON.parse(content)[0].value;
        const response = await fetch(`${baseUrl}/api/cookies/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform: 'douyin', label: 'browser export', content }),
        });
        const payload = await response.json();

        assert.equal(response.status, 201);
        assert.equal(payload.member.status, 'pending');
        assert.equal(JSON.stringify(payload).includes(credentialValue), false);
        const listed = await (await fetch(`${baseUrl}/api/cookies`)).json();
        assert.equal(listed.platforms.find((entry) => entry.platform === 'douyin').members.length, 1);
    });
});

test('cookie import API rejects server paths and network URLs', async () => {
    await withServer(async ({ baseUrl, rootDir }) => {
        for (const forbidden of [
            { path: '../../outside.json' },
            { url: 'https://example.invalid/cookies.json' },
        ]) {
            const response = await fetch(`${baseUrl}/api/cookies/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ platform: 'douyin', content: makeCookieJson(), ...forbidden }),
            });
            const payload = await response.json();
            assert.equal(response.status, 400);
            assert.equal(payload.code, 'UNSUPPORTED_IMPORT_SOURCE');
        }
        await assert.rejects(readFile(join(rootDir, '..', 'outside.json'), 'utf8'), (error) => error?.code === 'ENOENT');
    });
});

test('cookie concurrency API updates the per-cookie limit', async () => {
    await withServer(async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/cookies/concurrency`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform: 'douyin', perCookieConcurrency: 3 }),
        });
        const payload = await response.json();
        assert.equal(response.status, 200);
        assert.equal(payload.platform.perCookieConcurrency, 3);

        const rejected = await fetch(`${baseUrl}/api/cookies/concurrency`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform: 'douyin', perCookieConcurrency: 9 }),
        });
        assert.equal(rejected.status, 400);
        assert.equal((await rejected.json()).code, 'INVALID_CONCURRENCY');
    });
});

test('cookie concurrency API applies one selected limit to every registered platform', async () => {
    await withServer(async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/cookies/concurrency/all`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ perCookieConcurrency: 2 }),
        });
        const payload = await response.json();
        assert.equal(response.status, 200);
        assert.deepEqual(payload.failedPlatforms, []);
        assert.equal(payload.succeededPlatforms.length, COOKIE_PLATFORMS.length);
        assert.equal(payload.platforms.every((entry) => entry.perCookieConcurrency === 2), true);
    });
});

test('cookie revalidate API resets an invalid or disabled member without moving its file', async () => {
    await withServer(async ({ baseUrl, pool }) => {
        const member = await pool.import('douyin', { label: 'retry me', content: makeCookieJson() });
        const lease = await pool.acquire('douyin', { allowPending: true });
        await lease.reportFailure({ credentialFailure: true, httpStatus: 401 });
        assert.equal(pool.list('douyin').members[0].status, 'invalid');

        const response = await fetch(`${baseUrl}/api/cookies/douyin/${member.id}/revalidate`, { method: 'POST' });
        const payload = await response.json();
        assert.equal(response.status, 200);
        assert.equal(payload.member.status, 'pending');
        assert.equal(pool.list('douyin').members[0].lastError, '');
    });
});

test('cookie delete and restore APIs operate only on generated member IDs', async () => {
    await withServer(async ({ baseUrl, pool }) => {
        const member = await pool.import('douyin', { label: 'recoverable', content: makeCookieJson() });
        const deletedResponse = await fetch(`${baseUrl}/api/cookies/douyin/${member.id}`, { method: 'DELETE' });
        const deleted = await deletedResponse.json();
        assert.equal(deletedResponse.status, 200);
        assert.equal(deleted.trash.length, 1);
        assert.equal(pool.list('douyin').members.length, 0);

        const restoredResponse = await fetch(`${baseUrl}/api/cookies/douyin/${member.id}/restore`, { method: 'POST' });
        const restored = await restoredResponse.json();
        assert.equal(restoredResponse.status, 200);
        assert.equal(restored.member.status, 'pending');
        assert.equal(pool.listTrash('douyin').length, 0);
    });
});

test('cookie purge API permanently removes only an existing trashed member', async () => {
    await withServer(async ({ baseUrl, pool }) => {
        const member = await pool.import('douyin', { label: 'purge me', content: makeCookieJson() });
        await fetch(`${baseUrl}/api/cookies/douyin/${member.id}`, { method: 'DELETE' });

        const response = await fetch(`${baseUrl}/api/cookies/douyin/${member.id}/purge`, { method: 'DELETE' });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).trash.length, 0);

        const rejected = await fetch(`${baseUrl}/api/cookies/douyin/${member.id}/purge`, { method: 'DELETE' });
        assert.equal(rejected.status, 404);
    });
});

test('Douyin retries HTTP 403 with a different cookie without invalidating an unverified session', async () => {
    const calls = [];
    const platformAdapters = {
        fetchDouyinUserFeed: async (_secUid, { cookieLease }) => {
            calls.push(cookieLease?.memberId || 'missing');
            if (calls.length === 1) throw Object.assign(new Error('forbidden'), { httpStatus: 403 });
            return {
                title: 'local fixture',
                items: [{ title: 'latest', url: 'http://127.0.0.1/work', date_published: '2026-08-31T00:00:00.000Z' }],
            };
        },
    };

    await withServer(async ({ baseUrl, pool }) => {
        const first = await pool.import('douyin', { content: makeCookieJson() });
        const second = await pool.import('douyin', { content: makeCookieJson() });
        await pool.markHealthy('douyin', first.id);
        await pool.markHealthy('douyin', second.id);

        const response = await fetch(`${baseUrl}/api/query?url=${encodeURIComponent('https://www.douyin.com/user/MS4wLjABAAAAexample')}`);
        const payload = await response.json();
        assert.equal(response.status, 200);
        assert.equal(payload.status, 'success');
        assert.equal(calls.length, 2);
        assert.notEqual(calls[0], calls[1]);
        assert.equal(pool.list('douyin').members.find((member) => member.id === calls[0]).status, 'healthy');
        assert.equal(pool.list('douyin').members.find((member) => member.id === calls[1]).status, 'healthy');
    }, { platformAdapters });
});

test('Douyin failover is capped at one retry even when a third cookie exists', async () => {
    const calls = [];
    const platformAdapters = {
        fetchDouyinUserFeed: async (_secUid, { cookieLease }) => {
            calls.push(cookieLease.memberId);
            throw Object.assign(new Error('forbidden'), { httpStatus: 403 });
        },
    };

    await withServer(async ({ baseUrl, pool }) => {
        const members = [];
        for (let index = 0; index < 3; index += 1) {
            const member = await pool.import('douyin', { content: makeCookieJson() });
            await pool.markHealthy('douyin', member.id);
            members.push(member.id);
        }

        const response = await fetch(`${baseUrl}/api/query?url=${encodeURIComponent('https://www.douyin.com/user/MS4wLjABAAAAexample')}`);
        const payload = await response.json();
        assert.equal(response.status, 502);
        assert.equal(payload.code, 'COOKIE_FAILOVER_EXHAUSTED');
        assert.equal(payload.error, 'forbidden');
        assert.equal(calls.length, 2);
        assert.equal(new Set(calls).size, 2);
        assert.equal(calls.includes(members[2]), false);
        assert.equal(pool.list('douyin').members.filter((member) => member.status === 'invalid').length, 0);
    }, { platformAdapters });
});

test('Douyin returns stable HTTP 503 when no cookie member is available', async () => {
    await withServer(async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/query?url=${encodeURIComponent('https://www.douyin.com/user/MS4wLjABAAAAexample')}`);
        const payload = await response.json();
        assert.equal(response.status, 503);
        assert.equal(payload.code, 'NO_HEALTHY_COOKIE');
    });
});

test('a pending Douyin cookie becomes healthy after its first successful query', async () => {
    const platformAdapters = {
        fetchDouyinUserFeed: async () => ({
            title: 'local fixture',
            items: [{ title: 'latest', date_published: '2026-08-31T00:00:00.000Z' }],
        }),
    };

    await withServer(async ({ baseUrl, pool }) => {
        const member = await pool.import('douyin', { content: makeCookieJson() });
        assert.equal(pool.list('douyin').members[0].status, 'pending');

        const response = await fetch(`${baseUrl}/api/query?url=${encodeURIComponent('https://www.douyin.com/user/MS4wLjABAAAAexample')}`);
        assert.equal(response.status, 200);
        assert.equal(pool.list('douyin').members.find((entry) => entry.id === member.id).status, 'healthy');
    }, { platformAdapters });
});

test('a reachable profile with no works verifies the cookie without inventing a publication time', async () => {
    const platformAdapters = {
        fetchPlatformFeed: async () => {
            throw Object.assign(new Error('主页显示用户或内容不存在'), { empty: true, credentialVerified: true });
        },
    };

    await withServer(async ({ baseUrl, pool }) => {
        const member = await pool.import('sohu_video', { content: makeCookieJson('.sohu.com') });
        const response = await fetch(`${baseUrl}/api/query?url=${encodeURIComponent('https://tv.sohu.com/user/336238776')}`);
        const payload = await response.json();
        assert.equal(response.status, 200);
        assert.equal(payload.ok, true);
        assert.equal(payload.status, 'no_target');
        assert.equal(pool.list('sohu_video').members.find((entry) => entry.id === member.id).status, 'healthy');
    }, { platformAdapters });
});

test('one Douyin query keeps the same cookie through redirect author and feed stages', async () => {
    const stages = [];
    const platformAdapters = {
        resolveShortLink: async (_url, { cookieLease }) => {
            stages.push(['short', cookieLease.memberId]);
            return 'https://www.douyin.com/video/7675192792376741172';
        },
        resolveProfileUrl: async (_url, { cookieLease }) => {
            stages.push(['profile', cookieLease.memberId]);
            return 'https://www.douyin.com/user/MS4wLjABAAAAexample';
        },
        fetchDouyinUserFeed: async (_secUid, { cookieLease }) => {
            stages.push(['feed', cookieLease.memberId]);
            return { items: [{ date_published: '2026-08-31T00:00:00.000Z' }] };
        },
    };

    await withServer(async ({ baseUrl, pool }) => {
        const member = await pool.import('douyin', { content: makeCookieJson() });
        await pool.markHealthy('douyin', member.id);

        const response = await fetch(`${baseUrl}/api/query?url=${encodeURIComponent('https://v.douyin.com/local-fixture/')}`);
        assert.equal(response.status, 200);
        assert.deepEqual(stages, [['short', member.id], ['profile', member.id], ['feed', member.id]]);
    }, { platformAdapters });
});

test('Douyin credential failure during link resolution retries the whole flow once', async () => {
    const stages = [];
    let firstMemberId = '';
    const platformAdapters = {
        resolveShortLink: async (_url, { cookieLease }) => {
            stages.push(['short', cookieLease.memberId]);
            if (!firstMemberId) firstMemberId = cookieLease.memberId;
            if (cookieLease.memberId === firstMemberId) {
                throw Object.assign(new Error('HTTP 403'), { httpStatus: 403 });
            }
            return 'https://www.douyin.com/user/MS4wLjABAAAAexample';
        },
        resolveProfileUrl: async (url, { cookieLease }) => {
            stages.push(['profile', cookieLease.memberId]);
            return url;
        },
        fetchDouyinUserFeed: async (_secUid, { cookieLease }) => {
            stages.push(['feed', cookieLease.memberId]);
            return { items: [{ date_published: '2026-08-31T00:00:00.000Z' }] };
        },
    };

    await withServer(async ({ baseUrl, pool }) => {
        for (let index = 0; index < 2; index += 1) {
            const member = await pool.import('douyin', { content: makeCookieJson() });
            await pool.markHealthy('douyin', member.id);
        }

        const response = await fetch(`${baseUrl}/api/query?url=${encodeURIComponent('https://v.douyin.com/local-fixture/')}`);
        assert.equal(response.status, 200);
        assert.equal(stages[0][0], 'short');
        assert.equal(stages[1][0], 'short');
        assert.notEqual(stages[0][1], stages[1][1]);
        assert.deepEqual(stages.slice(1).map(([stage]) => stage), ['short', 'profile', 'feed']);
        assert.equal(pool.list('douyin').members.find((member) => member.id === firstMemberId).status, 'healthy');
    }, { platformAdapters });
});

test('Douyin login redirect is an explicit credential failure and uses one replacement', async () => {
    const calls = [];
    const platformAdapters = {
        fetchDouyinUserFeed: async (_secUid, { cookieLease }) => {
            calls.push(cookieLease.memberId);
            if (calls.length === 1) throw Object.assign(new Error('login required'), { loginRedirect: true, credentialFailure: true });
            return { items: [{ date_published: '2026-08-31T00:00:00.000Z' }] };
        },
    };

    await withServer(async ({ baseUrl, pool }) => {
        for (let index = 0; index < 2; index += 1) {
            const member = await pool.import('douyin', { content: makeCookieJson() });
            await pool.markHealthy('douyin', member.id);
        }
        const response = await fetch(`${baseUrl}/api/query?url=${encodeURIComponent('https://www.douyin.com/user/MS4wLjABAAAAexample')}`);
        assert.equal(response.status, 200);
        assert.equal(calls.length, 2);
        assert.notEqual(calls[0], calls[1]);
        assert.equal(pool.list('douyin').members.find((member) => member.id === calls[0]).status, 'invalid');
    }, { platformAdapters });
});

test('a Browserless transport error mentioning HTTP 403 does not invalidate a Douyin cookie', async () => {
    let calls = 0;
    const platformAdapters = {
        fetchDouyinUserFeed: async () => {
            calls += 1;
            throw new Error('抖音主页读取失败（浏览器 HTTP 403）');
        },
    };

    await withServer(async ({ baseUrl, pool }) => {
        const member = await pool.import('douyin', { content: makeCookieJson() });
        await pool.markHealthy('douyin', member.id);
        const response = await fetch(`${baseUrl}/api/query?url=${encodeURIComponent('https://www.douyin.com/user/MS4wLjABAAAAexample')}`);
        const payload = await response.json();
        assert.equal(response.status, 502);
        assert.equal(payload.code, 'PLATFORM_QUERY_FAILED');
        assert.equal(calls, 1);
        const listed = pool.list('douyin').members.find((entry) => entry.id === member.id);
        assert.equal(listed.status, 'healthy');
        assert.equal(listed.lastError, '临时请求失败');
    }, { platformAdapters });
});

test('Dongchedi environment verification stops without cycling imported cookies', async () => {
    const calls = [];
    const platformAdapters = {
        fetchPlatformFeed: async ({ cookieLease }) => {
            calls.push(cookieLease.memberId);
            throw Object.assign(new Error('懂车帝触发人机验证；当前 Cookie 在 Docker 浏览器环境未获平台接受'), {
                httpStatus: 403,
                credentialVerified: true,
            });
        },
    };

    await withServer(async ({ baseUrl, pool }) => {
        const first = await pool.import('dongchedi', { content: makeCookieJson('.dongchedi.com') });
        const second = await pool.import('dongchedi', { content: makeCookieJson('.dongchedi.com') });
        await pool.markHealthy('dongchedi', first.id);
        await pool.markHealthy('dongchedi', second.id);

        const response = await fetch(`${baseUrl}/api/query?url=${encodeURIComponent('https://www.dongchedi.com/user/870446320585407')}`);
        const payload = await response.json();
        assert.equal(response.status, 502);
        assert.equal(payload.code, 'PLATFORM_QUERY_FAILED');
        assert.equal(calls.length, 1);
        assert.equal(pool.list('dongchedi').members.every((member) => member.status === 'healthy'), true);
    }, { platformAdapters });
});

test('visible-browser runner fetches Dongchedi without leasing Docker cookies', async () => {
    const calls = [];
    await withServer(async ({ baseUrl, pool }) => {
        const member = await pool.import('dongchedi', { content: makeCookieJson('.dongchedi.com') });
        const response = await fetch(`${baseUrl}/api/query?url=${encodeURIComponent('https://www.dongchedi.com/user/870446320585407')}`);
        const payload = await response.json();
        assert.equal(response.status, 200);
        assert.equal(payload.status, 'success');
        assert.equal(payload.latestTimeBeijing, '2026-05-14 00:00:00');
        assert.deepEqual(calls, [{ platform: 'dongchedi', resolvedUrl: 'https://www.dongchedi.com/user/870446320585407' }]);
        assert.equal(pool.list('dongchedi').members.find((entry) => entry.id === member.id).status, 'pending');
    }, {
        platformAdapters: {
            fetchVisibleBrowserFeed: async ({ platform, resolvedUrl }) => {
                calls.push({ platform, resolvedUrl });
                return { title: '懂车帝样本', candidates: [{ date: '05-14', title: '最新视频', url: 'https://www.dongchedi.com/video/1' }] };
            },
        },
    });
});

test('Zhihu environment HTTP 403 preserves an imported cookie instead of marking it invalid', async () => {
    const platformAdapters = {
        fetchPlatformFeed: async () => {
            throw Object.assign(new Error('知乎页面被平台拦截（HTTP 403）'), {
                httpStatus: 403,
                credentialVerified: true,
            });
        },
    };

    await withServer(async ({ baseUrl, pool }) => {
        const member = await pool.import('zhihu', { content: makeCookieJson('.zhihu.com') });
        const response = await fetch(`${baseUrl}/api/query?url=${encodeURIComponent('https://www.zhihu.com/people/example-user')}`);
        const payload = await response.json();
        assert.equal(response.status, 502);
        assert.equal(payload.code, 'PLATFORM_QUERY_FAILED');
        assert.equal(pool.list('zhihu').members.find((entry) => entry.id === member.id).status, 'healthy');
    }, { platformAdapters });
});

test('Xiaohongshu Kuaishou Toutiao and Bilibili all lease their own cookie pool', async () => {
    const cases = [
        { platform: 'xiaohongshu', domain: '.xiaohongshu.com', url: 'https://www.xiaohongshu.com/user/profile/abc123' },
        { platform: 'kuaishou', domain: '.kuaishou.com', url: 'https://www.kuaishou.com/profile/user_123' },
        { platform: 'toutiao', domain: '.toutiao.com', url: 'https://www.toutiao.com/c/user/token/MS4wLjABAAAAfixture/' },
        { platform: 'bilibili', domain: '.bilibili.com', url: 'https://space.bilibili.com/2267573' },
    ];

    for (const fixture of cases) {
        const calls = [];
        const platformAdapters = {
            fetchPlatformFeed: async ({ platform, cookieLease }) => {
                calls.push({ platform, memberId: cookieLease.memberId });
                return { items: [{ date_published: '2026-08-31T00:00:00.000Z' }] };
            },
        };
        await withServer(async ({ baseUrl, pool }) => {
            const member = await pool.import(fixture.platform, { content: makeCookieJson(fixture.domain) });
            await pool.markHealthy(fixture.platform, member.id);
            const response = await fetch(`${baseUrl}/api/query?url=${encodeURIComponent(fixture.url)}`);
            const payload = await response.json();
            assert.equal(response.status, 200, `${fixture.platform}: ${payload.error || ''}`);
            assert.deepEqual(calls, [{ platform: fixture.platform, memberId: member.id }]);
            assert.equal(pool.list(fixture.platform).members[0].status, 'healthy');
        }, { platformAdapters });
    }
});

test('Xiaohongshu HTTP 403 retries once without invalidating an unverified session', async () => {
    const calls = [];
    const platformAdapters = {
        fetchPlatformFeed: async ({ cookieLease }) => {
            calls.push(cookieLease.memberId);
            if (calls.length === 1) throw Object.assign(new Error('forbidden'), { httpStatus: 403 });
            return { items: [{ date_published: '2026-08-31T00:00:00.000Z' }] };
        },
    };

    await withServer(async ({ baseUrl, pool }) => {
        for (let index = 0; index < 2; index += 1) {
            const member = await pool.import('xiaohongshu', { content: makeCookieJson('.xiaohongshu.com') });
            await pool.markHealthy('xiaohongshu', member.id);
        }
        const response = await fetch(`${baseUrl}/api/query?url=${encodeURIComponent('https://www.xiaohongshu.com/user/profile/abc123')}`);
        assert.equal(response.status, 200);
        assert.equal(calls.length, 2);
        assert.notEqual(calls[0], calls[1]);
        assert.equal(pool.list('xiaohongshu').members.find((member) => member.id === calls[0]).status, 'healthy');
    }, { platformAdapters });
});

test('Bilibili returns stable HTTP 503 when its cookie pool is empty', async () => {
    await withServer(async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/query?url=${encodeURIComponent('https://space.bilibili.com/2267573')}`);
        const payload = await response.json();
        assert.equal(response.status, 503);
        assert.equal(payload.code, 'NO_HEALTHY_COOKIE');
        assert.equal(payload.platform, 'B站');
    });
});
