import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const COOKIE_PLATFORM_DEFINITIONS = Object.freeze({
    douyin: Object.freeze({ label: '抖音', domain: 'douyin.com', domains: ['douyin.com', 'iesdouyin.com'], hosts: ['douyin.com', 'iesdouyin.com'] }),
    xiaohongshu: Object.freeze({ label: '小红书', domain: 'xiaohongshu.com', domains: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'], hosts: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'] }),
    kuaishou: Object.freeze({ label: '快手', domain: 'kuaishou.com', domains: ['kuaishou.com', 'chenzhongtech.com'], hosts: ['kuaishou.com', 'chenzhongtech.com'] }),
    bilibili: Object.freeze({ label: 'B站', domain: 'bilibili.com', domains: ['bilibili.com'], hosts: ['bilibili.com', 'b23.tv'] }),
    weibo: Object.freeze({ label: '微博', domain: 'weibo.com', domains: ['weibo.com', 'weibo.cn'], hosts: ['weibo.com', 'weibo.cn', 't.cn'] }),
    zhihu: Object.freeze({ label: '知乎', domain: 'zhihu.com', domains: ['zhihu.com'], hosts: ['zhihu.com'] }),
    toutiao: Object.freeze({ label: '今日头条', domain: 'toutiao.com', domains: ['toutiao.com'], hosts: ['toutiao.com'] }),
    netease: Object.freeze({ label: '网易新闻', domain: '163.com', domains: ['163.com'], hosts: ['163.com', '163.lu'] }),
    dongchedi: Object.freeze({ label: '懂车帝', domain: 'dongchedi.com', domains: ['dongchedi.com', 'dcdapp.com'], hosts: ['dongchedi.com', 'dcdapp.com', 'dcd.zjbyte.cn'] }),
    yidian: Object.freeze({ label: '一点资讯', domain: 'yidianzixun.com', domains: ['yidianzixun.com'], hosts: ['yidianzixun.com'] }),
    ucdayu: Object.freeze({ label: 'UC大鱼', domain: 'uc.cn', domains: ['uc.cn', 'dayu.com'], hosts: ['mp.uc.cn', 'dayu.com'] }),
    sohu_news: Object.freeze({ label: '搜狐新闻', domain: 'sohu.com', domains: ['sohu.com'], hosts: ['sohu.com'], legacyFile: 'sohu.json' }),
    tencent_news: Object.freeze({ label: '腾讯新闻', domain: 'qq.com', domains: ['qq.com'], hosts: ['view.inews.qq.com', 'inews.qq.com', 'news.qq.com', 'new.qq.com', 'om.qq.com'], legacyFile: 'qq.json' }),
    ifeng: Object.freeze({ label: '凤凰新闻', domain: 'ifeng.com', domains: ['ifeng.com'], hosts: ['ifeng.com'] }),
    baijiahao: Object.freeze({ label: '百度新闻', domain: 'baidu.com', domains: ['baidu.com'], hosts: ['baijiahao.baidu.com', 'mbd.baidu.com'], legacyFile: 'baijiahao.json' }),
    autohome: Object.freeze({ label: '汽车之家', domain: 'autohome.com.cn', domains: ['autohome.com.cn'], hosts: ['autohome.com.cn', 'athm.cn'] }),
    xcar: Object.freeze({ label: '爱卡汽车', domain: 'xcar.com.cn', domains: ['xcar.com.cn'], hosts: ['xcar.com.cn'] }),
    qctt: Object.freeze({ label: '汽车头条', domain: 'qctt.cn', domains: ['qctt.cn'], hosts: ['qctt.cn'] }),
    pcauto: Object.freeze({ label: '太平洋汽车', domain: 'pcauto.com.cn', domains: ['pcauto.com.cn'], hosts: ['pcauto.com.cn'] }),
    cheshi: Object.freeze({ label: '网上车市', domain: 'cheshi.com', domains: ['cheshi.com'], hosts: ['cheshi.com'] }),
    yiche: Object.freeze({ label: '易车', domain: 'yiche.com', domains: ['yiche.com'], hosts: ['yiche.com'] }),
    iqiyi: Object.freeze({ label: '爱奇艺', domain: 'iqiyi.com', domains: ['iqiyi.com'], hosts: ['iqiyi.com'] }),
    youku: Object.freeze({ label: '优酷/土豆视频', domain: 'youku.com', domains: ['youku.com', 'tudou.com'], hosts: ['youku.com', 'tudou.com'] }),
    tencent_video: Object.freeze({ label: '腾讯视频', domain: 'qq.com', domains: ['qq.com'], hosts: ['v.qq.com'], legacyFile: 'vqq.json' }),
    meipai: Object.freeze({ label: '美拍', domain: 'meipai.com', domains: ['meipai.com'], hosts: ['meipai.com'] }),
    sohu_video: Object.freeze({ label: '搜狐视频', domain: 'sohu.com', domains: ['sohu.com'], hosts: ['tv.sohu.com', 'my.tv.sohu.com'] }),
    video56: Object.freeze({ label: '56视频', domain: '56.com', domains: ['56.com'], hosts: ['56.com'] }),
    miaopai: Object.freeze({ label: '秒拍', domain: 'miaopai.com', domains: ['miaopai.com'], hosts: ['miaopai.com'] }),
    ixigua: Object.freeze({ label: '西瓜视频', domain: 'ixigua.com', domains: ['ixigua.com'], hosts: ['ixigua.com'] }),
});

export const COOKIE_PLATFORMS = Object.freeze(Object.keys(COOKIE_PLATFORM_DEFINITIONS));
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export class CookiePool {
    constructor({ rootDir, now = () => Date.now() } = {}) {
        if (!rootDir) throw new Error('CookiePool requires rootDir');
        this.rootDir = rootDir;
        this.now = now;
        this.stateDir = join(rootDir, '.state');
        this.statePath = join(this.stateDir, 'cookie-pool.json');
        this.trashDir = join(rootDir, '.trash');
        this.members = new Map(COOKIE_PLATFORMS.map((platform) => [platform, []]));
        this.concurrency = new Map(COOKIE_PLATFORMS.map((platform) => [platform, 1]));
        this.waiters = [];
        this.savedState = { version: 1, concurrency: {}, members: {}, trash: [] };
        this.trashRecords = [];
        this.stateWritePromise = Promise.resolve();
    }

    async init() {
        await mkdir(this.stateDir, { recursive: true });
        await mkdir(this.trashDir, { recursive: true });
        try {
            const parsed = JSON.parse(await readFile(this.statePath, 'utf8'));
            if (parsed && typeof parsed === 'object') this.savedState = { ...this.savedState, ...parsed };
        } catch (error) {
            if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        this.trashRecords = Array.isArray(this.savedState.trash) ? this.savedState.trash.map((record) => ({ ...record })) : [];
        const trashPruned = await this.#cleanupExpiredTrash();
        for (const platform of COOKIE_PLATFORMS) {
            const savedConcurrency = Number(this.savedState?.concurrency?.[platform]);
            if ([1, 2, 3].includes(savedConcurrency)) this.concurrency.set(platform, savedConcurrency);
        }
        await this.#scanFiles({ preserveExisting: false });
        if (trashPruned) {
            this.#scheduleStateSave();
            await this.flush();
        }
        return this;
    }

    async rescan() {
        await this.flush();
        await this.#cleanupExpiredTrash();
        await this.#scanFiles({ preserveExisting: true });
        this.#scheduleStateSave();
        await this.flush();
        this.#dispatchWaiters();
        return this;
    }

    list(platform) {
        assertPlatform(platform);
        this.#refreshCooling(platform);
        const perCookieConcurrency = this.concurrency.get(platform);
        const members = this.members.get(platform).map((member) => toPublicMember(member));
        const healthyCount = members.filter((member) => member.status === 'healthy').length;
        return {
            platform,
            perCookieConcurrency,
            healthyCount,
            totalCapacity: healthyCount * perCookieConcurrency,
            members,
        };
    }

    async import(platform, { content, label = '' } = {}) {
        assertPlatform(platform);
        if (typeof content !== 'string') {
            throw createPoolError('INVALID_JSON', 'Cookie import must be JSON text');
        }
        if (Buffer.byteLength(content, 'utf8') > MAX_IMPORT_BYTES) {
            throw createPoolError('IMPORT_TOO_LARGE', 'Cookie import exceeds 5 MiB');
        }

        let source;
        try {
            source = JSON.parse(content);
        } catch {
            throw createPoolError('INVALID_JSON', 'Cookie import is not valid JSON');
        }
        const cookies = normalizeCookies(source, COOKIE_PLATFORM_DEFINITIONS[platform].domains || [COOKIE_PLATFORM_DEFINITIONS[platform].domain], this.now());
        if (!cookies.length) {
            throw createPoolError('INVALID_COOKIE', 'Cookie import has no unexpired cookie for this platform');
        }
        const fingerprint = fingerprintCookies(cookies);
        if (this.members.get(platform).some((member) => member.fingerprint === fingerprint)) {
            throw createPoolError('DUPLICATE_COOKIE', 'This Cookie export is already in the pool');
        }

        const platformDir = join(this.rootDir, platform);
        await mkdir(platformDir, { recursive: true });
        const filename = `${new Date(this.now()).toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID()}.json`;
        const filePath = join(platformDir, filename);
        const tempPath = `${filePath}.${randomUUID()}.tmp`;
        try {
            await writeFile(tempPath, JSON.stringify(cookies), { encoding: 'utf8', flag: 'wx' });
            await rename(tempPath, filePath);
        } catch (error) {
            await rm(tempPath, { force: true }).catch(() => {});
            throw error;
        }

        const member = await this.#readMember(platform, filePath, false);
        member.label = normalizeLabel(label) || filename.replace(/\.json$/i, '');
        this.members.get(platform).push(member);
        this.#scheduleStateSave();
        await this.flush();
        return toPublicMember(member);
    }

    async markHealthy(platform, memberId) {
        const member = this.#findMember(platform, memberId);
        member.status = 'healthy';
        member.cooldownUntil = null;
        member.lastError = '';
        member.lastErrorAt = null;
        this.#scheduleStateSave();
        await this.flush();
        this.#dispatchWaiters();
        return toPublicMember(member);
    }

    async setConcurrency(platform, value) {
        assertPlatform(platform);
        const normalized = Number(value);
        if (![1, 2, 3].includes(normalized)) {
            throw createPoolError('INVALID_CONCURRENCY', 'Per-cookie concurrency must be 1, 2, or 3');
        }
        this.concurrency.set(platform, normalized);
        this.#scheduleStateSave();
        await this.flush();
        this.#dispatchWaiters();
        return this.list(platform);
    }

    async setAllConcurrency(value) {
        const normalized = Number(value);
        if (![1, 2, 3].includes(normalized)) {
            throw createPoolError('INVALID_CONCURRENCY', 'Per-cookie concurrency must be 1, 2, or 3');
        }
        await this.flush();
        const previous = new Map(this.concurrency);
        for (const platform of COOKIE_PLATFORMS) this.concurrency.set(platform, normalized);
        try {
            await this.#writeState();
        } catch (error) {
            this.concurrency = previous;
            throw error;
        }
        this.#dispatchWaiters();
        return COOKIE_PLATFORMS.map((platform) => this.list(platform));
    }

    acquire(platform, { excludeIds = [], allowPending = false } = {}) {
        assertPlatform(platform);
        const excluded = new Set(excludeIds);
        return new Promise((resolve, reject) => {
            const request = { platform, excluded, allowPending, resolve, reject };
            const outcome = this.#tryAcquire(request);
            if (outcome === 'waiting') this.waiters.push(request);
        });
    }

    async softDelete(platform, memberId) {
        const member = this.#findMember(platform, memberId);
        member.status = 'disabled';
        member.deleteRequested = true;
        member.lastError = '';
        member.lastErrorAt = null;
        this.#scheduleStateSave();
        await this.flush();
        if (member.occupied === 0) await this.#finalizeDelete(member);
        return member.occupied > 0 ? toPublicMember(member) : null;
    }

    listTrash(platform) {
        if (platform) assertPlatform(platform);
        return this.trashRecords
            .filter((record) => !platform || record.platform === platform)
            .map((record) => toPublicTrash(record));
    }

    async restore(platform, memberId) {
        assertPlatform(platform);
        const index = this.trashRecords.findIndex((record) => record.platform === platform && record.id === memberId);
        if (index < 0) throw createPoolError('COOKIE_NOT_FOUND', 'Trashed Cookie member was not found');
        const record = this.trashRecords[index];
        const sourcePath = this.#resolveTrashRecordPath(record);
        const targetPath = resolveInside(this.rootDir, record.originalRelativePath);
        try {
            await stat(targetPath);
            throw createPoolError('RESTORE_CONFLICT', 'The original Cookie filename is already in use');
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
        await mkdir(dirname(targetPath), { recursive: true });
        await rename(sourcePath, targetPath);
        const member = await this.#readMember(platform, targetPath, record.legacy === true);
        member.status = 'pending';
        member.label = record.label;
        member.deleteRequested = false;
        this.members.get(platform).push(member);
        this.members.get(platform).sort((left, right) => Number(right.legacy) - Number(left.legacy) || left.filename.localeCompare(right.filename));
        this.trashRecords.splice(index, 1);
        this.#scheduleStateSave();
        await this.flush();
        return toPublicMember(member);
    }

    async purge(platform, memberId) {
        assertPlatform(platform);
        const index = this.trashRecords.findIndex((record) => record.platform === platform && record.id === memberId);
        if (index < 0) throw createPoolError('COOKIE_NOT_FOUND', 'Trashed Cookie member was not found');
        const record = this.trashRecords[index];
        const sourcePath = this.#resolveTrashRecordPath(record);
        const purgeDir = join(this.trashDir, '.purging');
        const purgePath = resolveInside(this.rootDir, relative(this.rootDir, join(purgeDir, `${record.id}.${randomUUID()}.purge`)));
        await mkdir(purgeDir, { recursive: true });
        await rename(sourcePath, purgePath);
        this.trashRecords.splice(index, 1);
        try {
            await this.#writeState();
        } catch (error) {
            this.trashRecords.splice(index, 0, record);
            await rename(purgePath, sourcePath).catch(() => {});
            throw error;
        }
        await rm(purgePath, { force: true });
        return toPublicTrash(record);
    }

    async markPending(platform, memberId) {
        const member = this.#findMember(platform, memberId);
        if (member.occupied > 0) {
            throw createPoolError('COOKIE_IN_USE', 'Cookie member is currently in use');
        }
        member.status = 'pending';
        member.cooldownUntil = null;
        member.lastError = '';
        member.lastErrorAt = null;
        member.deleteRequested = false;
        this.#scheduleStateSave();
        await this.flush();
        this.#dispatchWaiters();
        return toPublicMember(member);
    }

    #tryAcquire(request) {
        this.#refreshCooling(request.platform);
        const limit = this.concurrency.get(request.platform);
        const eligible = this.members.get(request.platform)
            .filter((member) => (member.status === 'healthy' || (request.allowPending && member.status === 'pending')) && !request.excluded.has(member.id));
        if (!eligible.length) {
            request.reject(createPoolError('NO_HEALTHY_COOKIE', 'No healthy Cookie is available'));
            return 'rejected';
        }
        const available = eligible
            .filter((member) => member.occupied < (member.status === 'pending' ? 1 : limit))
            .sort((left, right) => left.assignments - right.assignments || left.filename.localeCompare(right.filename));
        if (!available.length) return 'waiting';

        const member = available[0];
        member.occupied += 1;
        member.assignments += 1;
        this.#scheduleStateSave();
        let released = false;
        const releaseMember = async () => {
            if (released) return;
            released = true;
            member.occupied = Math.max(0, member.occupied - 1);
            if (member.deleteRequested && member.occupied === 0) {
                await this.#finalizeDelete(member);
                return;
            }
            this.#scheduleStateSave();
            await this.flush();
            this.#dispatchWaiters();
        };
        const lease = {
            platform: member.platform,
            memberId: member.id,
            cookieHeader: () => member.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
            browserCookies: () => member.cookies.map((cookie) => ({ ...cookie })),
            reportSuccess: async () => {
                member.status = 'healthy';
                member.cooldownUntil = null;
                member.lastError = '';
                member.lastErrorAt = null;
                this.#scheduleStateSave();
                await releaseMember();
            },
            reportFailure: async (failure = {}) => {
                const httpStatus = Number(failure.httpStatus);
                if (failure.credentialFailure === true) {
                    member.status = 'invalid';
                    member.cooldownUntil = null;
                    member.lastError = failure.loginRedirect === true ? '平台已明确拒绝当前登录凭据' : (Number.isFinite(httpStatus) ? `平台已明确拒绝当前登录凭据（HTTP ${httpStatus}）` : '平台已明确拒绝当前登录凭据');
                } else if (httpStatus === 429) {
                    member.status = 'cooling';
                    member.cooldownUntil = new Date(this.now() + 10 * 60 * 1000).toISOString();
                    member.lastError = '请求过于频繁（HTTP 429）';
                } else {
                    member.lastError = failure.loginRedirect === true
                        ? '跳转到登录页，但无法确认 Cookie 是否失效'
                        : [401, 403].includes(httpStatus)
                            ? `HTTP ${httpStatus}，可能为反爬或风控`
                            : failure.timeout === true
                                ? '请求超时'
                                : failure.empty === true
                                    ? '页面或接口未返回作品数据'
                                    : '临时请求失败';
                }
                member.lastErrorAt = new Date(this.now()).toISOString();
                this.#scheduleStateSave();
                await releaseMember();
            },
            release: releaseMember,
        };
        this.flush().then(() => request.resolve(lease), (error) => {
            member.occupied = Math.max(0, member.occupied - 1);
            request.reject(error);
        });
        return 'acquired';
    }

    #dispatchWaiters() {
        if (!this.waiters.length) return;
        const pending = this.waiters;
        this.waiters = [];
        for (const request of pending) {
            const outcome = this.#tryAcquire(request);
            if (outcome === 'waiting') this.waiters.push(request);
        }
    }

    #findMember(platform, memberId) {
        assertPlatform(platform);
        const member = this.members.get(platform).find((candidate) => candidate.id === memberId);
        if (!member) throw createPoolError('COOKIE_NOT_FOUND', 'Cookie member was not found');
        return member;
    }

    #resolveTrashRecordPath(record) {
        if (!record || !COOKIE_PLATFORMS.includes(record.platform)) {
            throw createPoolError('INVALID_STATE_PATH', 'Cookie trash record is invalid');
        }
        const trashPath = resolveInside(this.rootDir, record.trashRelativePath);
        const platformTrashDir = resolve(this.trashDir, record.platform);
        const check = relative(platformTrashDir, trashPath);
        if (!check || check.startsWith('..') || isAbsolute(check)) {
            throw createPoolError('INVALID_STATE_PATH', 'Cookie trash path escapes its platform directory');
        }
        return trashPath;
    }

    flush() {
        return this.stateWritePromise;
    }

    #scheduleStateSave() {
        this.stateWritePromise = this.stateWritePromise
            .catch(() => {})
            .then(() => this.#writeState());
    }

    async #writeState() {
        await mkdir(this.stateDir, { recursive: true });
        const members = {};
        for (const platform of COOKIE_PLATFORMS) {
            for (const member of this.members.get(platform)) {
                members[member.fingerprint] = {
                    platform,
                    filename: member.filename,
                    label: member.label,
                    status: member.status,
                    occupied: member.occupied,
                    assignments: member.assignments,
                    cooldownUntil: member.cooldownUntil,
                    lastError: member.lastError,
                    lastErrorAt: member.lastErrorAt,
                    legacy: member.legacy,
                    deleteRequested: member.deleteRequested === true,
                };
            }
        }
        const payload = JSON.stringify({
            version: 1,
            concurrency: Object.fromEntries(this.concurrency),
            members,
            trash: this.trashRecords.map((record) => ({ ...record })),
        });
        const tempPath = `${this.statePath}.${randomUUID()}.tmp`;
        try {
            await writeFile(tempPath, payload, { encoding: 'utf8', flag: 'wx' });
            await rename(tempPath, this.statePath);
        } catch (error) {
            await rm(tempPath, { force: true }).catch(() => {});
            throw error;
        }
        this.savedState = JSON.parse(payload);
    }

    async #scanFiles({ preserveExisting }) {
        const previousByPath = new Map();
        if (preserveExisting) {
            for (const platform of COOKIE_PLATFORMS) {
                for (const member of this.members.get(platform)) previousByPath.set(member.filePath, member);
            }
        }
        const nextMembers = new Map(COOKIE_PLATFORMS.map((platform) => [platform, []]));

        for (const platform of COOKIE_PLATFORMS) {
            const legacyFilename = COOKIE_PLATFORM_DEFINITIONS[platform].legacyFile || `${platform}.json`;
            const candidates = [{ filePath: join(this.rootDir, legacyFilename), legacy: true }];
            const platformDir = join(this.rootDir, platform);
            try {
                const filenames = (await readdir(platformDir, { withFileTypes: true }))
                    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
                    .map((entry) => entry.name)
                    .sort((left, right) => left.localeCompare(right));
                candidates.push(...filenames.map((filename) => ({ filePath: join(platformDir, filename), legacy: false })));
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }

            const seenFingerprints = new Set();
            for (const candidate of candidates) {
                let member;
                try {
                    member = await this.#readMember(platform, candidate.filePath, candidate.legacy);
                } catch (error) {
                    if (error?.code === 'ENOENT') continue;
                    continue;
                }
                if (seenFingerprints.has(member.fingerprint)) continue;
                seenFingerprints.add(member.fingerprint);

                const previous = previousByPath.get(candidate.filePath);
                if (previous?.fingerprint === member.fingerprint) {
                    member = previous;
                } else if (previous) {
                    member.status = 'pending';
                    member.cooldownUntil = null;
                    member.lastError = '';
                    member.lastErrorAt = null;
                    member.assignments = 0;
                    member.deleteRequested = false;
                }
                nextMembers.get(platform).push(member);
            }

            if (preserveExisting) {
                for (const previous of this.members.get(platform)) {
                    if (previous.occupied > 0 && !nextMembers.get(platform).includes(previous)) {
                        previous.status = 'disabled';
                        nextMembers.get(platform).push(previous);
                    }
                }
            }
        }
        this.members = nextMembers;

        const pendingDeletes = COOKIE_PLATFORMS.flatMap((platform) => this.members.get(platform).filter((member) => member.deleteRequested && member.occupied === 0));
        for (const member of pendingDeletes) await this.#finalizeDelete(member);
    }

    async #finalizeDelete(member) {
        if (!member.deleteRequested || member.occupied > 0) return;
        const trashPlatformDir = join(this.trashDir, member.platform);
        await mkdir(trashPlatformDir, { recursive: true });
        const deletedAt = new Date(this.now()).toISOString();
        const trashFilename = `${member.filename}.${this.now()}.${randomUUID()}.json`;
        const trashPath = join(trashPlatformDir, trashFilename);
        await rename(member.filePath, trashPath);
        const record = {
            id: member.id,
            fingerprint: member.fingerprint,
            platform: member.platform,
            filename: member.filename,
            label: member.label,
            cookieCount: member.cookieCount,
            importedAt: member.importedAt,
            deletedAt,
            legacy: member.legacy,
            originalRelativePath: relative(this.rootDir, member.filePath),
            trashRelativePath: relative(this.rootDir, trashPath),
        };
        const members = this.members.get(member.platform);
        members.splice(members.indexOf(member), 1);
        this.trashRecords.push(record);
        this.#scheduleStateSave();
        await this.flush();
        this.#dispatchWaiters();
    }

    async #cleanupExpiredTrash() {
        const cutoff = this.now() - 30 * 24 * 60 * 60 * 1000;
        const kept = [];
        let changed = false;
        for (const record of this.trashRecords) {
            if (Number.isFinite(Date.parse(record.deletedAt)) && Date.parse(record.deletedAt) <= cutoff) {
                const trashPath = this.#resolveTrashRecordPath(record);
                await rm(trashPath, { force: true });
                changed = true;
            } else {
                kept.push(record);
            }
        }
        this.trashRecords = kept;
        return changed;
    }

    #refreshCooling(platform) {
        const now = this.now();
        for (const member of this.members.get(platform)) {
            if (member.status === 'cooling' && Date.parse(member.cooldownUntil) <= now) {
                member.status = 'healthy';
                member.cooldownUntil = null;
            }
        }
    }

    async #readMember(platform, filePath, legacy) {
        const source = JSON.parse(await readFile(filePath, 'utf8'));
        const cookies = normalizeCookies(source, COOKIE_PLATFORM_DEFINITIONS[platform].domains || [COOKIE_PLATFORM_DEFINITIONS[platform].domain], this.now());
        if (!cookies.length) {
            throw new Error(`No usable ${platform} cookies`);
        }
        const fingerprint = fingerprintCookies(cookies);
        const fileStat = await stat(filePath);
        const saved = this.savedState?.members?.[fingerprint] || {};
        const savedStatus = ['pending', 'healthy', 'cooling', 'invalid', 'disabled'].includes(saved.status) ? saved.status : 'pending';
        return {
            id: fingerprint.slice(0, 24),
            fingerprint,
            platform,
            filePath,
            filename: basename(filePath),
            label: normalizeLabel(saved.label) || basename(filePath, '.json'),
            cookieCount: cookies.length,
            cookies,
            legacy,
            importedAt: fileStat.mtime.toISOString(),
            status: savedStatus,
            occupied: 0,
            cooldownUntil: saved.cooldownUntil || null,
            lastError: saved.lastError || '',
            lastErrorAt: saved.lastErrorAt || null,
            assignments: Number.isFinite(Number(saved.assignments)) ? Number(saved.assignments) : 0,
            deleteRequested: saved.deleteRequested === true,
        };
    }
}

function assertPlatform(platform) {
    if (!COOKIE_PLATFORMS.includes(platform)) {
        throw new Error('Unsupported cookie platform');
    }
}

function createPoolError(code, message) {
    return Object.assign(new Error(message), { code });
}

function normalizeLabel(value) {
    return String(value || '').trim().replace(/[\r\n\t]/g, ' ').slice(0, 80);
}

function resolveInside(rootDir, relativePath) {
    if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath)) {
        throw createPoolError('INVALID_STATE_PATH', 'Cookie state contains an invalid path');
    }
    const root = resolve(rootDir);
    const target = resolve(root, relativePath);
    const check = relative(root, target);
    if (!check || check.startsWith('..') || isAbsolute(check)) {
        throw createPoolError('INVALID_STATE_PATH', 'Cookie state path escapes the Cookie root');
    }
    return target;
}

function normalizeSameSite(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (['none', 'no_restriction', 'no restriction'].includes(normalized)) return 'None';
    if (normalized === 'lax') return 'Lax';
    if (normalized === 'strict') return 'Strict';
    // Chromium exports may use "unspecified". Omitting the field lets the
    // browser apply its own default rather than passing an invalid CDP enum.
    return undefined;
}

function normalizeCookies(source, domains, nowMs) {
    const entries = Array.isArray(source) ? source : Array.isArray(source?.cookies) ? source.cookies : [];
    const nowSeconds = nowMs / 1000;
    return entries
        .filter((cookie) => cookie?.name && typeof cookie?.value === 'string')
        .filter((cookie) => {
            const cookieDomain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
            return domains.some((domain) => cookieDomain === domain || cookieDomain.endsWith(`.${domain}`));
        })
        .filter((cookie) => {
            const expires = Number(cookie.expirationDate ?? cookie.expires);
            return !Number.isFinite(expires) || expires <= 0 || expires > nowSeconds;
        })
        .map((cookie) => {
            const expires = Number(cookie.expirationDate ?? cookie.expires);
            const sameSite = normalizeSameSite(cookie.sameSite);
            return {
                name: String(cookie.name),
                value: cookie.value,
                domain: String(cookie.domain || ''),
                path: String(cookie.path || '/'),
                secure: Boolean(cookie.secure),
                httpOnly: Boolean(cookie.httpOnly),
                ...(sameSite ? { sameSite } : {}),
                // Puppeteer/CDP expects `expires`; `expirationDate` is the
                // Chrome-extension export spelling. Preserve session cookies
                // by omitting either field when no expiry is present.
                ...(Number.isFinite(expires) ? { expires } : {}),
            };
        })
        .sort((left, right) => `${left.domain}\0${left.path}\0${left.name}`.localeCompare(`${right.domain}\0${right.path}\0${right.name}`));
}

function fingerprintCookies(cookies) {
    return createHash('sha256').update(JSON.stringify(cookies)).digest('hex');
}

function toPublicMember(member) {
    return {
        id: member.id,
        platform: member.platform,
        filename: member.filename,
        label: member.label,
        cookieCount: member.cookieCount,
        importedAt: member.importedAt,
        accountSummary: `账号 #${member.fingerprint.slice(0, 8)}`,
        status: member.status,
        occupied: member.occupied,
        cooldownUntil: member.cooldownUntil,
        lastError: member.lastError,
        lastErrorAt: member.lastErrorAt,
        legacy: member.legacy,
    };
}

function toPublicTrash(record) {
    return {
        id: record.id,
        platform: record.platform,
        filename: record.filename,
        label: record.label,
        cookieCount: record.cookieCount,
        importedAt: record.importedAt,
        accountSummary: `账号 #${record.fingerprint.slice(0, 8)}`,
        status: 'trashed',
        occupied: 0,
        cooldownUntil: null,
        deletedAt: record.deletedAt,
        legacy: record.legacy,
    };
}
