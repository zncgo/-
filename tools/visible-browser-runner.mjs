import { createServer } from 'node:http';
import { access, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const PORT = Number.parseInt(process.env.VISIBLE_BROWSER_PORT || '17321', 10);
const PROFILE_DIR = resolve(process.env.VISIBLE_BROWSER_PROFILE_DIR || './.local-browser-profile');
// This is the same local directory mounted into the Docker Cookie pool. The
// runner deliberately reads only platform files below this root; it never
// reads the user's Chrome/Edge profile or prints cookie values.
const COOKIE_ROOT_DIR = resolve(process.env.VISIBLE_BROWSER_COOKIE_ROOT || '../更新频率表/cookies');
const DEFAULT_EXECUTABLES = process.platform === 'win32'
    ? [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ]
    : [];

function json(response, statusCode, body) {
    response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
}

async function findExecutable() {
    const candidates = [process.env.VISIBLE_BROWSER_EXECUTABLE, ...DEFAULT_EXECUTABLES].filter(Boolean);
    for (const executablePath of candidates) {
        try {
            await access(executablePath);
            return executablePath;
        } catch {}
    }
    throw new Error('没有找到本机 Chrome 或 Edge；请设置 VISIBLE_BROWSER_EXECUTABLE');
}

function dateTextPattern(platform) {
    return platform === 'dongchedi'
        ? /^(?:20\d{2}-\d{2}-\d{2}|\d{2}-\d{2})$/
        : /^20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}$/;
}

export function filterVisibleBrowserCandidates(platform, candidates = []) {
    const pattern = dateTextPattern(platform);
    const seen = new Set();
    return candidates.filter((candidate) => {
        const date = String(candidate?.date || '').trim();
        const url = String(candidate?.url || '').trim();
        if (!pattern.test(date) || !url) return false;
        const key = `${date}\0${url}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 100).map((candidate) => ({
        date: String(candidate.date).trim(),
        title: String(candidate.title || '').trim().slice(0, 300),
        url: String(candidate.url).trim(),
    }));
}

function browserSameSite(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (['none', 'no_restriction', 'no restriction'].includes(normalized)) return 'None';
    if (normalized === 'lax') return 'Lax';
    if (normalized === 'strict') return 'Strict';
    return undefined;
}

export function normalizeVisibleBrowserCookies(source, domains, nowMs = Date.now()) {
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
            const sameSite = browserSameSite(cookie.sameSite);
            return {
                name: String(cookie.name),
                value: cookie.value,
                domain: String(cookie.domain || ''),
                path: String(cookie.path || '/'),
                secure: Boolean(cookie.secure),
                httpOnly: Boolean(cookie.httpOnly),
                ...(sameSite ? { sameSite } : {}),
                ...(Number.isFinite(expires) && expires > 0 ? { expires } : {}),
            };
        })
        .sort((left, right) => `${left.domain}\0${left.path}\0${left.name}`.localeCompare(`${right.domain}\0${right.path}\0${right.name}`));
}

const COOKIE_PLATFORM_CONFIG = {
    dongchedi: { domains: ['dongchedi.com'], legacyFile: 'dongchedi.json' },
    zhihu: { domains: ['zhihu.com'], legacyFile: 'zhihu.json' },
};

async function newestCookieFile(platform) {
    const config = COOKIE_PLATFORM_CONFIG[platform];
    if (!config) return null;
    const folder = resolve(COOKIE_ROOT_DIR, platform);
    const legacyFile = resolve(COOKIE_ROOT_DIR, config.legacyFile);
    const candidates = [];
    for (const directory of [folder]) {
        try {
            const entries = await readdir(directory, { withFileTypes: true });
            candidates.push(...entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => resolve(directory, entry.name)));
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
    try {
        await access(legacyFile);
        candidates.push(legacyFile);
    } catch {}
    const dated = await Promise.all(candidates.map(async (file) => ({ file, mtimeMs: (await stat(file)).mtimeMs })));
    return dated.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.file || null;
}

async function loadPlatformCookies(platform) {
    const config = COOKIE_PLATFORM_CONFIG[platform];
    const file = await newestCookieFile(platform);
    if (!config || !file) return [];
    const source = JSON.parse(await readFile(file, 'utf8'));
    return normalizeVisibleBrowserCookies(source, config.domains);
}

async function collectCandidates(page, platform) {
    const raw = await page.evaluate((activePlatform) => {
        const datePattern = activePlatform === 'dongchedi'
            ? /^(?:20\d{2}-\d{2}-\d{2}|\d{2}-\d{2})$/
            : /^20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}$/;
        const workPattern = activePlatform === 'dongchedi'
            ? /\/(?:article|video)\//
            : /\/question\/\d+\/answer\/\d+|\/zvideo\/\d+|\/p\/\d+/;
        const rows = [];
        const nodes = [...document.querySelectorAll('time,span,p,div')];
        for (const node of nodes) {
            const date = String(node.textContent || '').trim();
            if (!datePattern.test(date)) continue;
            let owner = node;
            let anchor = null;
            for (let level = 0; level < 8 && owner; level += 1, owner = owner.parentElement) {
                anchor = [...owner.querySelectorAll?.('a[href]') || []].find((entry) => workPattern.test(entry.getAttribute('href') || '')) || null;
                if (anchor) break;
            }
            if (!anchor) continue;
            rows.push({
                date,
                title: String(anchor.textContent || anchor.getAttribute('title') || '').trim(),
                url: anchor.href || '',
            });
        }
        return { title: document.title || '', candidates: rows };
    }, platform);
    return { title: raw.title, candidates: filterVisibleBrowserCandidates(platform, raw.candidates) };
}

let contextPromise;
async function getContext() {
    if (!contextPromise) {
        contextPromise = (async () => {
            await mkdir(dirname(PROFILE_DIR), { recursive: true });
            const executablePath = await findExecutable();
            const context = await chromium.launchPersistentContext(PROFILE_DIR, {
                executablePath,
                headless: false,
                viewport: { width: 1365, height: 900 },
                locale: 'zh-CN',
            });
            console.log(`[visible-browser] started ${executablePath} with profile ${PROFILE_DIR}`);
            return context;
        })();
    }
    return contextPromise;
}

async function queryProfile({ platform, url }) {
    if (!['dongchedi', 'zhihu'].includes(platform)) throw new Error('可见浏览器运行器当前只支持懂车帝和知乎');
    const context = await getContext();
    const cookies = await loadPlatformCookies(platform);
    if (cookies.length) {
        await context.addCookies(cookies);
    }
    const page = await context.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(platform === 'dongchedi' ? 2500 : 3000);
        if (platform === 'dongchedi') {
            await page.getByText('全部', { exact: true }).first().click({ timeout: 3000 }).catch(() => {});
        }
        for (let index = 0; index < 4; index += 1) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(700);
        }
        const result = await collectCandidates(page, platform);
        if (!result.candidates.length) {
            throw new Error(`${platform === 'dongchedi' ? '懂车帝' : '知乎'}主页未显示作品时间；已加载本地 Cookie，但平台可能要求人机验证或该主页没有公开作品时间`);
        }
        return result;
    } finally {
        await page.close().catch(() => {});
    }
}

async function readBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 64 * 1024) throw new Error('请求体过大');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = createServer(async (request, response) => {
    try {
        if (request.method === 'GET' && request.url === '/healthz') {
            json(response, 200, { ok: true, profileDir: PROFILE_DIR });
            return;
        }
        if (request.method === 'POST' && request.url === '/query') {
            const body = await readBody(request);
            const url = new URL(String(body.url || ''));
            if (!['www.dongchedi.com', 'dongchedi.com', 'www.zhihu.com', 'zhihu.com'].includes(url.hostname)) {
                throw new Error('仅允许懂车帝或知乎主页链接');
            }
            const result = await queryProfile({ platform: String(body.platform || ''), url: url.href });
            json(response, 200, { ok: true, ...result });
            return;
        }
        json(response, 404, { ok: false, error: 'not found' });
    } catch (error) {
        json(response, 502, { ok: false, error: error?.message || String(error) });
    }
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`[visible-browser] listening on http://127.0.0.1:${PORT}`);
    });
}

export { queryProfile, server };
