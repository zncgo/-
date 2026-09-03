import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { COOKIE_PLATFORM_DEFINITIONS, COOKIE_PLATFORMS, CookiePool } from './cookie-pool.mjs';

const future = () => Math.floor(Date.now() / 1000) + 3600;
const makeCookieJson = ({ domain = '.douyin.com', name = 'sessionid', expirationDate = future() } = {}) => JSON.stringify([
    { domain, name, value: randomUUID(), path: '/', expirationDate },
]);

async function withCookieRoot(run) {
    const rootDir = await mkdtemp(join(tmpdir(), 'rsshub-cookie-pool-'));
    try {
        await run(rootDir);
    } finally {
        await rm(rootDir, { recursive: true, force: true });
    }
}

test('scans a legacy top-level platform cookie as the first pool member', async () => {
    await withCookieRoot(async (rootDir) => {
        await mkdir(rootDir, { recursive: true });
        await writeFile(join(rootDir, 'douyin.json'), makeCookieJson(), 'utf8');

        const pool = new CookiePool({ rootDir });
        await pool.init();

        const snapshot = pool.list('douyin');
        assert.equal(snapshot.members.length, 1);
        assert.equal(snapshot.members[0].filename, 'douyin.json');
        assert.equal(snapshot.members[0].cookieCount, 1);
        assert.equal(snapshot.members[0].status, 'pending');
        assert.equal(snapshot.perCookieConcurrency, 1);
    });
});

test('includes Bilibili as a first-class cookie-pool platform', async () => {
    await withCookieRoot(async (rootDir) => {
        await writeFile(join(rootDir, 'bilibili.json'), makeCookieJson({ domain: '.bilibili.com', name: 'SESSDATA' }), 'utf8');
        const pool = await new CookiePool({ rootDir }).init();
        const summary = pool.list('bilibili');
        assert.equal(summary.members.length, 1);
        assert.equal(summary.members[0].legacy, true);
        assert.equal(summary.perCookieConcurrency, 1);
    });
});

test('accepts alternate domains for multi-domain platform cookie exports', async () => {
    await withCookieRoot(async (rootDir) => {
        const pool = await new CookiePool({ rootDir }).init();
        const member = await pool.import('youku', {
            content: makeCookieJson({ domain: '.tudou.com', name: 'session' }),
        });
        assert.equal(member.cookieCount, 1);
        assert.equal(pool.list('youku').members.length, 1);
    });
});

test('normalizes Chromium cookie attributes for Browserless injection', async () => {
    await withCookieRoot(async (rootDir) => {
        const pool = await new CookiePool({ rootDir }).init();
        const member = await pool.import('zhihu', {
            content: JSON.stringify([{
                domain: '.zhihu.com',
                name: 'z_c0',
                value: randomUUID(),
                path: '/',
                secure: true,
                httpOnly: true,
                sameSite: 'no_restriction',
                expirationDate: future(),
            }]),
        });
        await pool.markHealthy('zhihu', member.id);
        const lease = await pool.acquire('zhihu');
        const [cookie] = lease.browserCookies();
        assert.equal(cookie.sameSite, 'None');
        assert.equal(typeof cookie.expires, 'number');
        assert.equal('expirationDate' in cookie, false);
        await lease.release();
    });
});

test('scans platform directory members after the unchanged legacy file', async () => {
    await withCookieRoot(async (rootDir) => {
        await writeFile(join(rootDir, 'douyin.json'), makeCookieJson(), 'utf8');
        await mkdir(join(rootDir, 'douyin'), { recursive: true });
        await writeFile(join(rootDir, 'douyin', 'second.json'), makeCookieJson({ name: 'sessionid_ss' }), 'utf8');

        const pool = await new CookiePool({ rootDir }).init();
        const snapshot = pool.list('douyin');

        assert.deepEqual(snapshot.members.map((member) => member.filename), ['douyin.json', 'second.json']);
    });
});

test('rejects an import when every matching cookie is expired', async () => {
    await withCookieRoot(async (rootDir) => {
        const pool = await new CookiePool({ rootDir }).init();

        await assert.rejects(
            pool.import('douyin', {
                label: 'expired export',
                content: makeCookieJson({ expirationDate: Math.floor(Date.now() / 1000) - 1 }),
            }),
            (error) => error?.code === 'INVALID_COOKIE',
        );
        assert.equal(pool.list('douyin').members.length, 0);
    });
});

test('rejects a normalized duplicate without adding another member', async () => {
    await withCookieRoot(async (rootDir) => {
        const content = makeCookieJson();
        await writeFile(join(rootDir, 'douyin.json'), content, 'utf8');
        const pool = await new CookiePool({ rootDir }).init();

        await assert.rejects(
            pool.import('douyin', { label: 'duplicate', content }),
            (error) => error?.code === 'DUPLICATE_COOKIE',
        );
        assert.equal(pool.list('douyin').members.length, 1);
    });
});

test('scales capacity by healthy members while keeping fair per-cookie limits', async () => {
    await withCookieRoot(async (rootDir) => {
        const platformDir = join(rootDir, 'douyin');
        await mkdir(platformDir, { recursive: true });
        for (let index = 0; index < 3; index += 1) {
            await writeFile(join(platformDir, `member-${index}.json`), makeCookieJson(), 'utf8');
        }
        const pool = await new CookiePool({ rootDir }).init();
        for (const member of pool.list('douyin').members) await pool.markHealthy('douyin', member.id);
        await pool.setConcurrency('douyin', 2);

        assert.equal(pool.list('douyin').totalCapacity, 6);
        const firstWave = await Promise.all(Array.from({ length: 6 }, () => pool.acquire('douyin')));
        const occupied = pool.list('douyin').members.map((member) => member.occupied);
        assert.deepEqual(occupied, [2, 2, 2]);

        const secondWavePromises = Array.from({ length: 6 }, () => pool.acquire('douyin'));
        await Promise.all(firstWave.map((lease) => lease.release()));
        const secondWave = await Promise.all(secondWavePromises);
        const assignments = [...firstWave, ...secondWave].reduce((counts, lease) => counts.set(lease.memberId, (counts.get(lease.memberId) || 0) + 1), new Map());
        await Promise.all(secondWave.map((lease) => lease.release()));

        const totals = [...assignments.values()];
        assert.equal(Math.max(...totals) - Math.min(...totals) <= 1, true);
        assert.deepEqual(pool.list('douyin').members.map((member) => member.occupied), [0, 0, 0]);
    });
});

test('lowering concurrency does not cancel in-flight leases and pauses dispatch', async () => {
    await withCookieRoot(async (rootDir) => {
        await mkdir(join(rootDir, 'douyin'), { recursive: true });
        await writeFile(join(rootDir, 'douyin', 'only.json'), makeCookieJson(), 'utf8');
        const pool = await new CookiePool({ rootDir }).init();
        const [member] = pool.list('douyin').members;
        await pool.markHealthy('douyin', member.id);
        await pool.setConcurrency('douyin', 2);
        const first = await pool.acquire('douyin');
        const second = await pool.acquire('douyin');

        await pool.setConcurrency('douyin', 1);
        let thirdResolved = false;
        const thirdPromise = pool.acquire('douyin').then((lease) => {
            thirdResolved = true;
            return lease;
        });
        await first.release();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(thirdResolved, false);
        assert.equal(pool.list('douyin').members[0].occupied, 1);

        await second.release();
        const third = await thirdPromise;
        assert.equal(pool.list('douyin').members[0].occupied, 1);
        await third.release();
    });
});

test('raising concurrency immediately dispatches queued work', async () => {
    await withCookieRoot(async (rootDir) => {
        await mkdir(join(rootDir, 'douyin'), { recursive: true });
        await writeFile(join(rootDir, 'douyin', 'only.json'), makeCookieJson(), 'utf8');
        const pool = await new CookiePool({ rootDir }).init();
        const [member] = pool.list('douyin').members;
        await pool.markHealthy('douyin', member.id);
        const first = await pool.acquire('douyin');
        const secondPromise = pool.acquire('douyin');

        await pool.setConcurrency('douyin', 2);
        const second = await secondPromise;
        assert.equal(pool.list('douyin').members[0].occupied, 2);
        await first.release();
        await second.release();
    });
});

test('HTTP 429 releases the lease and cools that member for ten minutes', async () => {
    await withCookieRoot(async (rootDir) => {
        let now = Date.now();
        await mkdir(join(rootDir, 'douyin'), { recursive: true });
        await writeFile(join(rootDir, 'douyin', 'a.json'), makeCookieJson(), 'utf8');
        await writeFile(join(rootDir, 'douyin', 'b.json'), makeCookieJson(), 'utf8');
        const pool = await new CookiePool({ rootDir, now: () => now }).init();
        for (const member of pool.list('douyin').members) await pool.markHealthy('douyin', member.id);

        const first = await pool.acquire('douyin');
        await first.reportFailure({ httpStatus: 429, message: 'rate limited' });
        const cooled = pool.list('douyin').members.find((member) => member.id === first.memberId);
        assert.equal(cooled.status, 'cooling');
        assert.equal(Date.parse(cooled.cooldownUntil), now + 10 * 60 * 1000);
        assert.equal(cooled.occupied, 0);

        const second = await pool.acquire('douyin');
        assert.notEqual(second.memberId, first.memberId);
        await second.release();
        now += 10 * 60 * 1000 + 1;
        assert.equal(pool.list('douyin').members.find((member) => member.id === first.memberId).status, 'healthy');
    });
});

test('persists health and concurrency without writing credential values to state', async () => {
    await withCookieRoot(async (rootDir) => {
        const content = makeCookieJson();
        const credentialValue = JSON.parse(content)[0].value;
        await writeFile(join(rootDir, 'douyin.json'), content, 'utf8');
        const pool = await new CookiePool({ rootDir }).init();
        const [member] = pool.list('douyin').members;
        await pool.markHealthy('douyin', member.id);
        await pool.setConcurrency('douyin', 3);
        const lease = await pool.acquire('douyin');
        await pool.flush();

        const stateText = await readFile(join(rootDir, '.state', 'cookie-pool.json'), 'utf8');
        assert.equal(stateText.includes(credentialValue), false);
        assert.match(stateText, /"occupied":1/);

        const reloaded = await new CookiePool({ rootDir }).init();
        const snapshot = reloaded.list('douyin');
        assert.equal(snapshot.perCookieConcurrency, 3);
        assert.equal(snapshot.members[0].status, 'healthy');
        assert.equal(snapshot.members[0].occupied, 0);
        await lease.release();
    });
});

test('updates every registered platform concurrency atomically and persists it', async () => {
    await withCookieRoot(async (rootDir) => {
        const pool = await new CookiePool({ rootDir }).init();
        const updated = await pool.setAllConcurrency(3);
        assert.equal(updated.length, COOKIE_PLATFORMS.length);
        assert.equal(updated.every((entry) => entry.perCookieConcurrency === 3), true);

        const reloaded = await new CookiePool({ rootDir }).init();
        assert.equal(COOKIE_PLATFORMS.every((platform) => reloaded.list(platform).perCookieConcurrency === 3), true);
    });
});

test('unverified HTTP 403 keeps a member available because it may be anti-bot', async () => {
    await withCookieRoot(async (rootDir) => {
        await writeFile(join(rootDir, 'douyin.json'), makeCookieJson(), 'utf8');
        const pool = await new CookiePool({ rootDir }).init();
        const [member] = pool.list('douyin').members;
        await pool.markHealthy('douyin', member.id);
        const lease = await pool.acquire('douyin');

        await lease.reportFailure({ httpStatus: 403 });
        assert.equal(pool.list('douyin').members[0].status, 'healthy');
        assert.match(pool.list('douyin').members[0].lastError, /反爬或风控/);
        await (await pool.acquire('douyin')).release();
    });
});

test('an explicit credential rejection marks a member invalid', async () => {
    await withCookieRoot(async (rootDir) => {
        await writeFile(join(rootDir, 'douyin.json'), makeCookieJson(), 'utf8');
        const pool = await new CookiePool({ rootDir }).init();
        const [member] = pool.list('douyin').members;
        await pool.markHealthy('douyin', member.id);
        const lease = await pool.acquire('douyin');

        await lease.reportFailure({ httpStatus: 401, credentialFailure: true });
        assert.equal(pool.list('douyin').members[0].status, 'invalid');
        await assert.rejects(pool.acquire('douyin'), (error) => error?.code === 'NO_HEALTHY_COOKIE');
    });
});

test('anti-bot HTTP 403 and login redirects stay non-invalid for every platform', async () => {
    await withCookieRoot(async (rootDir) => {
        const pool = await new CookiePool({ rootDir }).init();
        for (const platform of COOKIE_PLATFORMS) {
            const domain = COOKIE_PLATFORM_DEFINITIONS[platform].domain;
            const member = await pool.import(platform, { content: makeCookieJson({ domain: `.${domain}` }) });
            const lease = await pool.acquire(platform, { allowPending: true });
            await lease.reportFailure({ httpStatus: 403, loginRedirect: true });
            const snapshot = pool.list(platform).members.find((entry) => entry.id === member.id);
            assert.notEqual(snapshot.status, 'invalid', platform);
        }
    });
});

test('timeouts and empty responses are temporary failures, not invalid credentials', async () => {
    await withCookieRoot(async (rootDir) => {
        await writeFile(join(rootDir, 'douyin.json'), makeCookieJson(), 'utf8');
        const pool = await new CookiePool({ rootDir }).init();
        const [member] = pool.list('douyin').members;
        await pool.markHealthy('douyin', member.id);
        const timeoutLease = await pool.acquire('douyin');
        await timeoutLease.reportFailure({ timeout: true });
        assert.equal(pool.list('douyin').members[0].status, 'healthy');
        assert.equal(pool.list('douyin').members[0].lastError, '请求超时');

        const emptyLease = await pool.acquire('douyin');
        await emptyLease.reportFailure({ empty: true });
        assert.equal(pool.list('douyin').members[0].status, 'healthy');
        assert.equal(pool.list('douyin').members[0].lastError, '页面或接口未返回作品数据');
    });
});

test('returns a stable error code when no healthy member exists', async () => {
    await withCookieRoot(async (rootDir) => {
        await writeFile(join(rootDir, 'douyin.json'), makeCookieJson(), 'utf8');
        const pool = await new CookiePool({ rootDir }).init();
        await assert.rejects(pool.acquire('douyin'), (error) => error?.code === 'NO_HEALTHY_COOKIE');
    });
});

test('soft-deleting an in-use member disables allocation and trashes it after release', async () => {
    await withCookieRoot(async (rootDir) => {
        const platformDir = join(rootDir, 'douyin');
        const firstPath = join(platformDir, 'a.json');
        await mkdir(platformDir, { recursive: true });
        await writeFile(firstPath, makeCookieJson(), 'utf8');
        await writeFile(join(platformDir, 'b.json'), makeCookieJson(), 'utf8');
        const pool = await new CookiePool({ rootDir }).init();
        for (const member of pool.list('douyin').members) await pool.markHealthy('douyin', member.id);
        const firstLease = await pool.acquire('douyin');

        await pool.softDelete('douyin', firstLease.memberId);
        const deleting = pool.list('douyin').members.find((member) => member.id === firstLease.memberId);
        assert.equal(deleting.status, 'disabled');
        assert.equal(deleting.occupied, 1);
        assert.equal(typeof await readFile(firstPath, 'utf8'), 'string');

        const otherLease = await pool.acquire('douyin');
        assert.notEqual(otherLease.memberId, firstLease.memberId);
        await otherLease.release();
        await firstLease.release();
        await assert.rejects(readFile(firstPath, 'utf8'), (error) => error?.code === 'ENOENT');
        assert.equal(pool.listTrash('douyin').length, 1);
        assert.equal(pool.list('douyin').members.length, 1);
    });
});

test('restores a trashed legacy member to its original path as pending', async () => {
    await withCookieRoot(async (rootDir) => {
        const legacyPath = join(rootDir, 'douyin.json');
        await writeFile(legacyPath, makeCookieJson(), 'utf8');
        const pool = await new CookiePool({ rootDir }).init();
        const [member] = pool.list('douyin').members;

        await pool.softDelete('douyin', member.id);
        assert.equal(pool.list('douyin').members.length, 0);
        assert.equal(pool.listTrash('douyin').length, 1);
        await assert.rejects(readFile(legacyPath, 'utf8'), (error) => error?.code === 'ENOENT');

        const restored = await pool.restore('douyin', member.id);
        assert.equal(restored.status, 'pending');
        assert.equal(restored.filename, 'douyin.json');
        assert.equal(typeof await readFile(legacyPath, 'utf8'), 'string');
        assert.equal(pool.listTrash('douyin').length, 0);
    });
});

test('purges only a trashed Cookie through the temporary purge area', async () => {
    await withCookieRoot(async (rootDir) => {
        const pool = await new CookiePool({ rootDir }).init();
        const member = await pool.import('douyin', { content: makeCookieJson() });
        await pool.softDelete('douyin', member.id);
        assert.equal(pool.listTrash('douyin').length, 1);

        await pool.purge('douyin', member.id);
        assert.equal(pool.listTrash('douyin').length, 0);
        assert.deepEqual(await readdir(join(rootDir, '.trash', 'douyin')), []);
    });
});

test('refuses a purge when the persisted trash path escapes its platform directory', async () => {
    await withCookieRoot(async (rootDir) => {
        const pool = await new CookiePool({ rootDir }).init();
        const member = await pool.import('douyin', { content: makeCookieJson() });
        await pool.softDelete('douyin', member.id);
        pool.trashRecords[0].trashRelativePath = '../outside.json';

        await assert.rejects(pool.purge('douyin', member.id), (error) => error?.code === 'INVALID_STATE_PATH');
        assert.equal(pool.listTrash('douyin').length, 1);
    });
});

test('restores the trash record when the purge state write fails', async () => {
    await withCookieRoot(async (rootDir) => {
        const pool = await new CookiePool({ rootDir }).init();
        const member = await pool.import('douyin', { content: makeCookieJson() });
        await pool.softDelete('douyin', member.id);
        await writeFile(join(rootDir, 'state-blocker'), 'x', 'utf8');
        pool.stateDir = join(rootDir, 'state-blocker');
        pool.statePath = join(pool.stateDir, 'cookie-pool.json');

        await assert.rejects(pool.purge('douyin', member.id));
        assert.equal(pool.listTrash('douyin').length, 1);
        assert.equal((await readdir(join(rootDir, '.trash', 'douyin'))).length, 1);
    });
});

test('cleans trash records and files after thirty days', async () => {
    await withCookieRoot(async (rootDir) => {
        let now = Date.now();
        await writeFile(join(rootDir, 'douyin.json'), makeCookieJson(), 'utf8');
        const pool = await new CookiePool({ rootDir, now: () => now }).init();
        const [member] = pool.list('douyin').members;
        await pool.softDelete('douyin', member.id);
        assert.equal(pool.listTrash('douyin').length, 1);

        now += 31 * 24 * 60 * 60 * 1000;
        const reloaded = await new CookiePool({ rootDir, now: () => now }).init();
        assert.equal(reloaded.listTrash('douyin').length, 0);
        assert.deepEqual(await readdir(join(rootDir, '.trash', 'douyin')), []);
    });
});

test('periodic rescans clean expired trash without restarting the service', async () => {
    await withCookieRoot(async (rootDir) => {
        let now = Date.now();
        await writeFile(join(rootDir, 'douyin.json'), makeCookieJson(), 'utf8');
        const pool = await new CookiePool({ rootDir, now: () => now }).init();
        const [member] = pool.list('douyin').members;
        await pool.softDelete('douyin', member.id);
        assert.equal(pool.listTrash('douyin').length, 1);

        now += 31 * 24 * 60 * 60 * 1000;
        await pool.rescan();
        assert.equal(pool.listTrash('douyin').length, 0);
        assert.deepEqual(await readdir(join(rootDir, '.trash', 'douyin')), []);
    });
});

test('resets a changed cookie file to pending on rescan', async () => {
    await withCookieRoot(async (rootDir) => {
        const legacyPath = join(rootDir, 'douyin.json');
        await writeFile(legacyPath, makeCookieJson(), 'utf8');
        const pool = await new CookiePool({ rootDir }).init();
        const original = pool.list('douyin').members[0];
        await pool.markHealthy('douyin', original.id);

        await writeFile(legacyPath, makeCookieJson(), 'utf8');
        await pool.rescan();
        const changed = pool.list('douyin').members[0];
        assert.notEqual(changed.id, original.id);
        assert.equal(changed.status, 'pending');
    });
});

test('rejects a cookie export from the wrong platform domain', async () => {
    await withCookieRoot(async (rootDir) => {
        const pool = await new CookiePool({ rootDir }).init();
        await assert.rejects(
            pool.import('douyin', { content: makeCookieJson({ domain: '.example.invalid' }) }),
            (error) => error?.code === 'INVALID_COOKIE',
        );
    });
});

test('enforces the five MiB import limit before parsing JSON', async () => {
    await withCookieRoot(async (rootDir) => {
        const pool = await new CookiePool({ rootDir }).init();
        await assert.rejects(
            pool.import('douyin', { content: ' '.repeat(5 * 1024 * 1024 + 1) }),
            (error) => error?.code === 'IMPORT_TOO_LARGE',
        );
    });
});

test('returns only generated filenames and masked metadata after import', async () => {
    await withCookieRoot(async (rootDir) => {
        const content = makeCookieJson();
        const credentialValue = JSON.parse(content)[0].value;
        const pool = await new CookiePool({ rootDir }).init();
        const imported = await pool.import('douyin', { label: '../../display label', content });

        assert.equal(imported.filename.includes('/') || imported.filename.includes('\\'), false);
        assert.match(imported.accountSummary, /^账号 #[a-f0-9]{8}$/);
        assert.equal(JSON.stringify(imported).includes(credentialValue), false);
        assert.equal(JSON.stringify(pool.list('douyin')).includes(credentialValue), false);
        assert.deepEqual((await readdir(join(rootDir, 'douyin'))).filter((name) => name.endsWith('.json')), [imported.filename]);
    });
});
