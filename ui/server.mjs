import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRoute, canonicalizeProfileUrl, extractBilibiliVideoId, extractDouyinVideoId, extractKuaishouProfileId, extractSohuVideoAuthorId, extractToutiaoUserToken, extractUrl, extractVideo56WorkLinks, extractXiaohongshuRedirectTarget, findDouyinAuthorSecUid, findDouyinAuthorSecUidFromLinkedData, findLatestItem, findVideo56AuthorProfileFromHtml, findXiaohongshuAuthorIdFromHtml, formatBeijingTime, isCookieUsable, isToutiaoWorkUrl, isXiaohongshuWorkUrl, needsRedirectResolution, normalizeBilibiliFeed, normalizeGenericFeed, normalizeIfengFeed, normalizeIqiyiFeed, normalizeKuaishouFeed, normalizeKuaishouNativeFeed, normalizeTencentNewsFeed, normalizeTencentVideoFeed, normalizeToutiaoFeed, normalizeXiaohongshuFeed, parseAutohomeProfileHtml, parseVideo56WorkHtml, parseYicheProfileHtml, retryDouyinAuthorFetch, retryDouyinFeedFetch } from './core.mjs';
import { COOKIE_PLATFORM_DEFINITIONS, COOKIE_PLATFORMS, CookiePool } from './cookie-pool.mjs';

const UI_PORT = Number.parseInt(process.env.PORT || '3000', 10);
const RSSHUB_BASE_URL = (process.env.RSSHUB_BASE_URL || 'http://rsshub:1200').replace(/\/$/, '');
const BROWSERLESS_HTTP_URL = (process.env.BROWSERLESS_HTTP_URL || 'http://browserless:3000').replace(/\/$/, '');
const DOUYIN_COOKIE_FILE = process.env.DOUYIN_COOKIE_FILE || '/cookies/douyin.json';
const XIAOHONGSHU_COOKIE_FILE = process.env.XIAOHONGSHU_COOKIE_FILE || '/cookies/xiaohongshu.json';
const KUAISHOU_COOKIE_FILE = process.env.KUAISHOU_COOKIE_FILE || '/cookies/kuaishou.json';
const TOUTIAO_COOKIE_FILE = process.env.TOUTIAO_COOKIE_FILE || '/cookies/toutiao.json';
const BILIBILI_COOKIE_FILE = process.env.BILIBILI_COOKIE_FILE || '/cookies/bilibili.json';
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.REQUEST_TIMEOUT_MS || '90000', 10);
const COOKIE_API_BODY_LIMIT = 5 * 1024 * 1024 + 64 * 1024;
// 可选的本机可见浏览器运行器：适合懂车帝、知乎等会拒绝 Docker 无头浏览器的站点。
// 它仅监听本机回环地址；Docker 使用 host.docker.internal 访问宿主机。
const VISIBLE_BROWSER_RUNNER_URL = String(process.env.VISIBLE_BROWSER_RUNNER_URL || '').trim().replace(/\/$/, '');
// 以下站点的部分作者页为公开页面；未导入 Cookie 时先尝试一次公开读取，避免在入口直接拒绝。
const PUBLIC_FALLBACK_PLATFORMS = new Set(['yidian', 'ucdayu', 'xcar']);
// 汽车头条作者作品走公开移动接口；不应仅因接口成功就伪造 Cookie 的健康状态。
const COOKIELESS_FETCH_PLATFORMS = new Set(['qctt']);
const KUAISHOU_PROFILE_QUERY = `
fragment photoContent on PhotoEntity {
  id
  caption
  timestamp
  profileUserTopPhoto
}
fragment recoPhotoContent on recoPhotoEntity {
  id
  caption
  timestamp
  profileUserTopPhoto
}
query visionProfilePhotoList($pcursor: String, $userId: String, $page: String, $webPageArea: String) {
  visionProfilePhotoList(pcursor: $pcursor, userId: $userId, page: $page, webPageArea: $webPageArea) {
    result
    hostName
    pcursor
    feeds {
      author { id name }
      photo {
        ...photoContent
        ...recoPhotoContent
      }
      status
    }
  }
}`;
const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = await readFile(join(CURRENT_DIR, 'index.html'));
const STATIC_ASSETS = new Map(await Promise.all([
    ['/core.mjs', 'core.mjs', 'text/javascript; charset=utf-8'],
    ['/workbook.mjs', 'workbook.mjs', 'text/javascript; charset=utf-8'],
    ['/workbook-runner.mjs', 'workbook-runner.mjs', 'text/javascript; charset=utf-8'],
    ['/workbook-ui.mjs', 'workbook-ui.mjs', 'text/javascript; charset=utf-8'],
    ['/vendor/jszip-3.10.1.min.js', 'vendor/jszip-3.10.1.min.js', 'text/javascript; charset=utf-8'],
].map(async ([urlPath, fileName, contentType]) => [urlPath, { body: await readFile(join(CURRENT_DIR, fileName)), contentType }])));

export function createAppServer({ cookiePool = null, platformAdapters = {} } = {}) {
    return createServer(async (request, response) => {
        try {
            const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

            if (request.method === 'GET' && requestUrl.pathname === '/') {
                response.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store',
                });
                response.end(INDEX_HTML);
                return;
            }

            if (request.method === 'GET' && STATIC_ASSETS.has(requestUrl.pathname)) {
                const asset = STATIC_ASSETS.get(requestUrl.pathname);
                response.writeHead(200, {
                    'Content-Type': asset.contentType,
                    'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff',
                });
                response.end(asset.body);
                return;
            }

            if (request.method === 'GET' && requestUrl.pathname === '/api/status') {
                const backend = await fetchWithTimeout(`${RSSHUB_BASE_URL}/healthz`, 6000);
                sendJson(response, backend.ok ? 200 : 503, {
                    ok: backend.ok,
                    backendStatus: backend.status,
                });
                return;
            }

            if (request.method === 'GET' && requestUrl.pathname === '/api/cookies') {
                if (!cookiePool) {
                    sendJson(response, 503, { ok: false, code: 'COOKIE_POOL_UNAVAILABLE', error: 'Cookie pool is unavailable' });
                    return;
                }
                sendJson(response, 200, {
                    ok: true,
                    platforms: COOKIE_PLATFORMS.map((platform) => ({
                        ...cookiePool.list(platform),
                        label: COOKIE_PLATFORM_DEFINITIONS[platform].label,
                        domain: COOKIE_PLATFORM_DEFINITIONS[platform].domain,
                        domains: COOKIE_PLATFORM_DEFINITIONS[platform].domains,
                        hosts: COOKIE_PLATFORM_DEFINITIONS[platform].hosts,
                        schedulingEnabled: true,
                    })),
                    trash: cookiePool.listTrash(),
                });
                return;
            }

            if (request.method === 'POST' && requestUrl.pathname === '/api/cookies/import') {
                if (!cookiePool) {
                    sendJson(response, 503, { ok: false, code: 'COOKIE_POOL_UNAVAILABLE', error: 'Cookie pool is unavailable' });
                    return;
                }
                try {
                    const body = await readJsonBody(request, COOKIE_API_BODY_LIMIT);
                    if (['path', 'url', 'filePath', 'serverPath'].some((key) => key in body)) {
                        throw Object.assign(new Error('Only pasted JSON or browser file content is accepted'), { code: 'UNSUPPORTED_IMPORT_SOURCE' });
                    }
                    const member = await cookiePool.import(body.platform, { content: body.content, label: body.label });
                    sendJson(response, 201, { ok: true, member });
                } catch (error) {
                    sendCookieApiError(response, error);
                }
                return;
            }

            if (request.method === 'PATCH' && requestUrl.pathname === '/api/cookies/concurrency') {
                if (!cookiePool) {
                    sendJson(response, 503, { ok: false, code: 'COOKIE_POOL_UNAVAILABLE', error: 'Cookie pool is unavailable' });
                    return;
                }
                try {
                    const body = await readJsonBody(request, 64 * 1024);
                    const platform = await cookiePool.setConcurrency(body.platform, body.perCookieConcurrency);
                    sendJson(response, 200, { ok: true, platform });
                } catch (error) {
                    sendCookieApiError(response, error);
                }
                return;
            }

            if (request.method === 'PATCH' && requestUrl.pathname === '/api/cookies/concurrency/all') {
                if (!cookiePool) {
                    sendJson(response, 503, { ok: false, code: 'COOKIE_POOL_UNAVAILABLE', error: 'Cookie pool is unavailable' });
                    return;
                }
                try {
                    const body = await readJsonBody(request, 64 * 1024);
                    const platforms = await cookiePool.setAllConcurrency(body.perCookieConcurrency);
                    sendJson(response, 200, {
                        ok: true,
                        platforms,
                        succeededPlatforms: platforms.map((entry) => entry.platform),
                        failedPlatforms: [],
                    });
                } catch (error) {
                    sendCookieApiError(response, error);
                }
                return;
            }

            const cookieMemberMatch = requestUrl.pathname.match(/^\/api\/cookies\/([a-z0-9_-]+)\/([a-f0-9]{24})(\/(?:restore|revalidate|purge))?$/);
            if (cookieMemberMatch && request.method === 'DELETE' && !cookieMemberMatch[3]) {
                if (!cookiePool) {
                    sendJson(response, 503, { ok: false, code: 'COOKIE_POOL_UNAVAILABLE', error: 'Cookie pool is unavailable' });
                    return;
                }
                try {
                    const [, platform, memberId] = cookieMemberMatch;
                    const member = await cookiePool.softDelete(platform, memberId);
                    sendJson(response, 200, { ok: true, member, platform: cookiePool.list(platform), trash: cookiePool.listTrash(platform) });
                } catch (error) {
                    sendCookieApiError(response, error);
                }
                return;
            }

            if (cookieMemberMatch && request.method === 'POST' && cookieMemberMatch[3] === '/restore') {
                if (!cookiePool) {
                    sendJson(response, 503, { ok: false, code: 'COOKIE_POOL_UNAVAILABLE', error: 'Cookie pool is unavailable' });
                    return;
                }
                try {
                    const [, platform, memberId] = cookieMemberMatch;
                    const member = await cookiePool.restore(platform, memberId);
                    sendJson(response, 200, { ok: true, member, platform: cookiePool.list(platform), trash: cookiePool.listTrash(platform) });
                } catch (error) {
                    sendCookieApiError(response, error);
                }
                return;
            }

            if (cookieMemberMatch && request.method === 'POST' && cookieMemberMatch[3] === '/revalidate') {
                try {
                    const [, platform, memberId] = cookieMemberMatch;
                    const member = await cookiePool.markPending(platform, memberId);
                    sendJson(response, 200, { ok: true, member });
                } catch (error) {
                    sendCookieApiError(response, error);
                }
                return;
            }

            if (cookieMemberMatch && request.method === 'DELETE' && cookieMemberMatch[3] === '/purge') {
                if (!cookiePool) {
                    sendJson(response, 503, { ok: false, code: 'COOKIE_POOL_UNAVAILABLE', error: 'Cookie pool is unavailable' });
                    return;
                }
                try {
                    const [, platform, memberId] = cookieMemberMatch;
                    const purged = await cookiePool.purge(platform, memberId);
                    sendJson(response, 200, { ok: true, purged, platform: cookiePool.list(platform), trash: cookiePool.listTrash(platform) });
                } catch (error) {
                    sendCookieApiError(response, error);
                }
                return;
            }

            if (requestUrl.pathname.startsWith('/api/cookies/')) {
                sendJson(response, 404, { ok: false, code: 'COOKIE_API_NOT_FOUND', error: 'Cookie API endpoint was not found' });
                return;
            }

            if (request.method === 'GET' && requestUrl.pathname === '/api/query') {
                await handleQuery(requestUrl, response, { cookiePool, platformAdapters });
                return;
            }

            if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
                sendJson(response, 200, { ok: true });
                return;
            }

            await proxyToRssHub(request, requestUrl, response);
        } catch (error) {
            sendJson(response, 500, {
                ok: false,
                error: cleanError(error),
            });
        }
    });
}

async function handleQuery(requestUrl, response, { cookiePool = null, platformAdapters = {} } = {}) {
    const originalInput = extractUrl(requestUrl.searchParams.get('url'));
    if (!originalInput) {
        sendJson(response, 400, { ok: false, error: '请输入用户主页链接' });
        return;
    }

    let resolvedUrl;
    let routeInfo;
    let feed;

    const inputPlatform = cookiePlatformForInput(originalInput);
    if (cookiePool && inputPlatform && !COOKIELESS_FETCH_PLATFORMS.has(inputPlatform) && !usesVisibleBrowserRunnerWithoutLease(inputPlatform, platformAdapters)) {
        let initialLease;
        try {
            initialLease = await cookiePool.acquire(inputPlatform, { allowPending: true });
            ({ resolvedUrl, routeInfo, feed } = await fetchPlatformQueryWithFailover({
                platform: inputPlatform,
                originalInput,
                cookiePool,
                initialLease,
                platformAdapters,
            }));
        } catch (error) {
            if (error?.code === 'NO_HEALTHY_COOKIE' && PUBLIC_FALLBACK_PLATFORMS.has(inputPlatform)) {
                // 继续进入无 Cookie 的公开主页解析；平台若需要登录会返回明确原因。
            } else {
                if (isNoCollectableTargetError(error)) {
                    sendNoCollectableTarget(response, { originalInput, resolvedUrl: error?.resolvedUrl, platform: inputPlatform, error });
                    return;
                }
                sendJson(response, error?.code === 'NO_HEALTHY_COOKIE' ? 503 : 502, {
                ok: false,
                status: 'error',
                code: error?.code || 'PLATFORM_QUERY_FAILED',
                inputUrl: originalInput,
                ...(error?.resolvedUrl ? { resolvedUrl: error.resolvedUrl } : {}),
                platform: COOKIE_PLATFORM_DEFINITIONS[inputPlatform].label,
                error: error?.code === 'NO_HEALTHY_COOKIE' ? `没有可用的${COOKIE_PLATFORM_DEFINITIONS[inputPlatform].label} Cookie` : cleanError(error),
                });
                return;
            }
        }
    }
    if (!resolvedUrl) {
        try {
            const resolveShort = platformAdapters.resolveShortLink || resolveShortLink;
            resolvedUrl = needsRedirectResolution(originalInput) ? await resolveShort(originalInput, {}) : originalInput;
        } catch (error) {
            if (isNoCollectableTargetError(error)) {
                sendNoCollectableTarget(response, { originalInput, resolvedUrl, platform: inputPlatform, error });
                return;
            }
            sendJson(response, 502, {
                ok: false,
                status: 'error',
                inputUrl: originalInput,
                error: cleanError(error),
            });
            return;
        }

        try {
            const resolveProfile = platformAdapters.resolveProfileUrl || resolveProfileUrl;
            // 即使该平台没有 Cookie，也要传入平台键：一点资讯等内容页需要按平台规则反查作者主页。
            resolvedUrl = await resolveProfile(resolvedUrl, { platform: inputPlatform });
            routeInfo = buildRoute(resolvedUrl);
        } catch (error) {
            if (isNoCollectableTargetError(error)) {
                sendNoCollectableTarget(response, { originalInput, resolvedUrl, platform: inputPlatform, error });
                return;
            }
            sendJson(response, 400, {
                ok: false,
                status: 'error',
                inputUrl: originalInput,
                resolvedUrl,
                error: cleanError(error),
            });
            return;
        }
    }

    try {
        const resolvedPlatform = cookiePlatformForRoute(routeInfo);
        if (!feed && resolvedPlatform) {
            feed = await fetchFeedForPlatform(resolvedPlatform, resolvedUrl, { platformAdapters });
        } else if (!feed) {
            const feedResponse = await fetchWithTimeout(`${RSSHUB_BASE_URL}${routeInfo.route}`, REQUEST_TIMEOUT_MS, {
                headers: { Accept: 'application/feed+json, application/json' },
            });
            const responseText = await feedResponse.text();
            try {
                feed = JSON.parse(responseText);
            } catch {
                throw new Error(`RSSHub 返回的不是 JSON（HTTP ${feedResponse.status}）`);
            }

            if (!feedResponse.ok) {
                throw new Error(toErrorMessage(feed?.message || feed?.error || `RSSHub 请求失败（HTTP ${feedResponse.status}）`));
            }
        }

        const items = Array.isArray(feed?.items) ? feed.items : [];
        const latest = findLatestItem(items);
        if (!latest) {
            if (!items.length) {
                sendNoCollectableTarget(response, {
                    originalInput,
                    resolvedUrl,
                    platform: routeInfo?.platform,
                    feedRoute: routeInfo?.route,
                    error: new Error('主页当前没有作品'),
                });
                return;
            }
            sendJson(response, 200, {
                ok: true,
                status: 'no_date',
                platform: routeInfo.platform,
                inputUrl: originalInput,
                resolvedUrl,
                feedRoute: routeInfo.route,
                feedTitle: feed?.title || '',
                itemCount: items.length,
                error: items.length ? '作品中没有可用的发布时间' : '没有获取到作品',
            });
            return;
        }

        sendJson(response, 200, {
            ok: true,
            status: 'success',
            platform: routeInfo.platform,
            inputUrl: originalInput,
            resolvedUrl,
            feedRoute: routeInfo.route,
            feedTitle: feed?.title || '',
            itemCount: items.length,
            datedItemCount: items.filter((item) => Number.isFinite(Date.parse(item?.date_published ?? item?.pubDate))).length,
            latestTime: latest.rawDate,
            latestTimeBeijing: formatBeijingTime(latest.timestamp),
            latestTitle: latest.title || '',
            latestUrl: latest.url || '',
        });
    } catch (error) {
        if (isNoCollectableTargetError(error)) {
            sendNoCollectableTarget(response, {
                originalInput,
                resolvedUrl: error?.resolvedUrl || resolvedUrl,
                platform: routeInfo?.platform || inputPlatform,
                feedRoute: routeInfo?.route,
                error,
            });
            return;
        }
        const status = error?.code === 'NO_HEALTHY_COOKIE' ? 503 : 502;
        sendJson(response, status, {
            ok: false,
            status: 'error',
            ...(error?.code ? { code: error.code } : {}),
            inputUrl: originalInput,
            resolvedUrl,
            platform: routeInfo?.platform || inputPlatform,
            error: cleanError(error),
        });
    }
}

function isNoCollectableTargetError(error) {
    if (error?.noTarget === true) return true;
    const message = cleanError(error);
    return /(?:主页|用户|账号|内容).{0,18}(?:用户或内容)?不存在|(?:用户|账号).{0,12}已注销|内容.{0,12}已下线|(?:作者)?链接已失效|跳转到平台首页|主页当前没有作品|主页没有作品|主页没有返回公开作品数据|主页作品接口没有返回数据|主页没有找到作品链接|请使用用户主页链接/i.test(message);
}

function sendNoCollectableTarget(response, {
    originalInput,
    resolvedUrl,
    platform,
    feedRoute,
    error,
} = {}) {
    sendJson(response, 200, {
        ok: true,
        status: 'no_target',
        inputUrl: originalInput,
        ...(resolvedUrl ? { resolvedUrl } : {}),
        ...(platform ? { platform: COOKIE_PLATFORM_DEFINITIONS[platform]?.label || platform } : {}),
        ...(feedRoute ? { feedRoute } : {}),
        error: cleanError(error) || '未找到可采集的主页作品',
    });
}

async function fetchPlatformQueryWithFailover({ platform, originalInput, cookiePool, initialLease, platformAdapters }) {
    let lease = initialLease;
    const excludedIds = [];

    for (let attempt = 1; attempt <= 2; attempt += 1) {
        let resolvedUrl = originalInput;
        try {
            const resolveShort = platformAdapters.resolveShortLink || resolveShortLink;
            resolvedUrl = needsRedirectResolution(originalInput) ? await resolveShort(originalInput, { cookieLease: lease }) : originalInput;
            const resolveProfile = platformAdapters.resolveProfileUrl || resolveProfileUrl;
            resolvedUrl = await resolveProfile(resolvedUrl, { cookieLease: lease, platform });
            const routeInfo = buildRoute(resolvedUrl);
            const resolvedPlatform = cookiePlatformForRoute(routeInfo);
            if (resolvedPlatform !== platform) {
                throw new Error(`${COOKIE_PLATFORM_DEFINITIONS[platform].label}链接没有解析到对应作者主页`);
            }
            const feed = await fetchFeedForPlatform(platform, resolvedUrl, { cookieLease: lease, platformAdapters });
            if (!Array.isArray(feed?.items) || feed.items.length === 0) {
                throw Object.assign(new Error(`${COOKIE_PLATFORM_DEFINITIONS[platform].label}主页作品接口没有返回数据`), { empty: true });
            }
            await lease.reportSuccess();
            return { resolvedUrl, routeInfo, feed };
        } catch (error) {
            if (error?.credentialVerified === true) {
                await lease.reportSuccess();
                error.resolvedUrl ||= resolvedUrl;
                throw error;
            }
            const failure = classifyCookieFailure(error);
            await lease.reportFailure(failure);
            excludedIds.push(lease.memberId);
            if (!failure.failover) {
                error.resolvedUrl ||= resolvedUrl;
                throw error;
            }
            if (attempt >= 2) {
                error.code = 'COOKIE_FAILOVER_EXHAUSTED';
                error.resolvedUrl ||= resolvedUrl;
                throw error;
            }
            try {
                lease = await cookiePool.acquire(platform, { excludeIds: excludedIds, allowPending: true });
            } catch (acquireError) {
                if (acquireError?.code !== 'NO_HEALTHY_COOKIE') throw acquireError;
                error.code = 'COOKIE_FAILOVER_EXHAUSTED';
                error.resolvedUrl ||= resolvedUrl;
                throw error;
            }
        }
    }
    throw Object.assign(new Error(`${COOKIE_PLATFORM_DEFINITIONS[platform].label} Cookie 故障转移失败`), { code: 'COOKIE_FAILOVER_EXHAUSTED' });
}

async function fetchFeedForPlatform(platform, resolvedUrl, { cookieLease = null, platformAdapters = {} } = {}) {
    if (platformAdapters.fetchPlatformFeed) {
        return platformAdapters.fetchPlatformFeed({ platform, resolvedUrl, cookieLease });
    }
    // 知乎网页 API 可直接复用导入 Cookie，避免 Docker/可见浏览器的环境验证。
    if (platform === 'zhihu') {
        const memberId = resolvedUrl.match(/\/people\/([^/?#]+)/)?.[1];
        if (!memberId) throw new Error('知乎主页中没有找到用户 ID');
        return fetchZhihuUserFeed(memberId, { cookieLease });
    }
    // 懂车帝作者页的初始化 JSON 已包含首屏作品及 Unix 发布时间；优先直接解析，
    // 避开自动化浏览器环境验证。
    if (platform === 'dongchedi') {
        if (typeof platformAdapters.fetchVisibleBrowserFeed === 'function') {
            const visibleBrowserFeed = await fetchVisibleBrowserFeed(platform, resolvedUrl, { platformAdapters });
            if (visibleBrowserFeed) return visibleBrowserFeed;
        }
        const userId = resolvedUrl.match(/\/user\/(\d+)/)?.[1];
        if (!userId) throw new Error('懂车帝主页中没有找到用户 ID');
        return fetchDongchediUserFeed(userId, { cookieLease });
    }
    const visibleBrowserFeed = await fetchVisibleBrowserFeed(platform, resolvedUrl, { platformAdapters });
    if (visibleBrowserFeed) return visibleBrowserFeed;
    if (platform === 'douyin') {
        const secUid = resolvedUrl.match(/\/user\/(MS4wLjABAAAA[^/?#]+)/)?.[1] ?? new URL(resolvedUrl).searchParams.get('sec_uid');
        if (!secUid) throw new Error('抖音主页中没有找到用户 sec_uid');
        const fetchFeed = platformAdapters.fetchDouyinUserFeed || fetchDouyinUserFeed;
        return fetchFeed(secUid, { cookieLease });
    }
    if (platform === 'kuaishou') {
        const principalId = extractKuaishouProfileId(resolvedUrl);
        if (!principalId) throw new Error('快手主页中没有找到用户 ID');
        const fetchFeed = platformAdapters.fetchKuaishouUserFeed || fetchKuaishouUserFeed;
        return fetchFeed(principalId, { cookieLease });
    }
    if (platform === 'xiaohongshu') {
        const userId = resolvedUrl.match(/\/user\/profile\/([A-Za-z0-9]+)/)?.[1];
        if (!userId) throw new Error('小红书主页中没有找到用户 ID');
        const fetchFeed = platformAdapters.fetchXiaohongshuUserFeed || fetchXiaohongshuUserFeed;
        return fetchFeed(userId, { cookieLease });
    }
    if (platform === 'toutiao') {
        const token = extractToutiaoUserToken(resolvedUrl);
        if (!token) throw new Error('今日头条主页中没有找到用户 token');
        const fetchFeed = platformAdapters.fetchToutiaoUserFeed || fetchToutiaoUserFeed;
        return fetchFeed(token, { cookieLease });
    }
    if (platform === 'bilibili') {
        const uid = resolvedUrl.match(/^https?:\/\/space\.bilibili\.com\/(\d+)/i)?.[1];
        if (!uid) throw new Error('B站主页中没有找到用户 UID');
        const fetchFeed = platformAdapters.fetchBilibiliUserFeed || fetchBilibiliUserFeed;
        return fetchFeed(uid, { cookieLease });
    }
    if (platform === 'tencent_news') {
        return fetchTencentNewsUserFeed(resolvedUrl, { cookieLease });
    }
    // 桌面作者页会被 403，但移动端提供公开的作者作品接口。
    if (platform === 'qctt') {
        return fetchQcttUserFeed(resolvedUrl);
    }
    if (platform === 'baijiahao') {
        return fetchBaiduNewsUserFeed(resolvedUrl, { cookieLease });
    }
    const routeInfo = buildRoute(resolvedUrl);
    if (platform === 'ifeng' && routeInfo.route) {
        return fetchIfengAuthorFeed(routeInfo.route);
    }
    if (platform === 'video56') {
        return fetchVideo56UserFeed(resolvedUrl, { cookieLease });
    }
    if (platform === 'iqiyi') {
        const uid = resolvedUrl.match(/\/u\/(\d+)/)?.[1];
        if (!uid) throw new Error('爱奇艺主页中没有找到用户 UID');
        return fetchIqiyiUserFeed(uid, { cookieLease });
    }
    if (platform === 'yiche') {
        return fetchYicheUserFeed(resolvedUrl, { cookieLease });
    }
    if (platform === 'autohome') {
        return fetchAutohomeUserFeed(resolvedUrl, { cookieLease });
    }
    if (platform === 'tencent_video') {
        return fetchTencentVideoUserFeed(resolvedUrl, { cookieLease });
    }
    if (!cookieLease && PUBLIC_FALLBACK_PLATFORMS.has(platform)) {
        return fetchGenericBrowserFeed(platform, resolvedUrl, { cookieLease });
    }
    if (routeInfo.route) {
        await validateCookieSessionWithHttp(platform, resolvedUrl, cookieLease);
        try {
            return await fetchRssHubXmlFeed(routeInfo.route, COOKIE_PLATFORM_DEFINITIONS[platform].label);
        } catch (routeError) {
            console.warn('[native-route-fallback]', JSON.stringify({ platform, route: routeInfo.route, error: cleanError(routeError) }));
            try {
                return await fetchGenericBrowserFeed(platform, resolvedUrl, { cookieLease });
            } catch (browserError) {
                browserError.message = `${cleanError(routeError)}；浏览器回退也失败：${cleanError(browserError)}`;
                throw browserError;
            }
        }
    }
    return fetchGenericBrowserFeed(platform, resolvedUrl, { cookieLease });
}

function usesVisibleBrowserRunner(platform, platformAdapters = {}) {
    return ['dongchedi', 'zhihu'].includes(platform)
        && (Boolean(VISIBLE_BROWSER_RUNNER_URL) || typeof platformAdapters.fetchVisibleBrowserFeed === 'function');
}

// 懂车帝运行器自行从宿主机 Cookie 目录读取会话；知乎优先使用原生 API，
// 仍需正常从 Cookie 池租用一个当前会话。
function usesVisibleBrowserRunnerWithoutLease(platform, platformAdapters = {}) {
    // 仅测试/显式适配器场景由可见浏览器独立提供数据；常规懂车帝查询会先走
    // 原生主页数据，因此仍需要从 Cookie 池租用会话。
    return platform === 'dongchedi' && typeof platformAdapters.fetchVisibleBrowserFeed === 'function';
}

async function fetchVisibleBrowserFeed(platform, resolvedUrl, { platformAdapters = {} } = {}) {
    if (!usesVisibleBrowserRunner(platform, platformAdapters)) return null;
    let payload;
    if (typeof platformAdapters.fetchVisibleBrowserFeed === 'function') {
        payload = await platformAdapters.fetchVisibleBrowserFeed({ platform, resolvedUrl });
    } else {
        let runner;
        try {
            runner = new URL(VISIBLE_BROWSER_RUNNER_URL);
        } catch {
            throw new Error('本机可见浏览器运行器地址格式无效');
        }
        if (!['127.0.0.1', 'localhost', 'host.docker.internal'].includes(runner.hostname.toLowerCase())) {
            throw new Error('本机可见浏览器运行器仅允许 localhost、127.0.0.1 或 host.docker.internal');
        }
        const response = await fetchWithTimeout(new URL('/query', runner).href, 70000, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform, url: resolvedUrl }),
        });
        payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) {
            throw Object.assign(new Error(payload?.error || `${COOKIE_PLATFORM_DEFINITIONS[platform].label}本机可见浏览器运行器请求失败（HTTP ${response.status}）`), {
                empty: response.status === 422,
            });
        }
    }
    const feed = normalizeGenericFeed({
        title: payload?.title || `${COOKIE_PLATFORM_DEFINITIONS[platform].label}用户`,
        responseCandidates: payload?.candidates,
    }, {
        platform: COOKIE_PLATFORM_DEFINITIONS[platform].label,
        profileUrl: resolvedUrl,
    });
    if (!feed.items.length) {
        throw Object.assign(new Error(`${COOKIE_PLATFORM_DEFINITIONS[platform].label}本机可见浏览器未显示明确作品时间；请完成登录或平台验证后重试`), {
            empty: true,
        });
    }
    return feed;
}

function classifyCookieFailure(error) {
    const httpStatus = Number(error?.httpStatus);
    const loginRedirect = error?.loginRedirect === true;
    const credentialFailure = error?.credentialFailure === true;
    return {
        ...(Number.isFinite(httpStatus) ? { httpStatus } : {}),
        loginRedirect,
        credentialFailure,
        timeout: error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.timeout === true,
        empty: error?.empty === true,
        failover: [401, 403, 429].includes(httpStatus) || loginRedirect,
    };
}

function douyinHttpError(message, response) {
    const error = new Error(message);
    if ([401, 403, 429].includes(response?.status)) error.httpStatus = response.status;
    if (isDouyinLoginUrl(response?.url)) error.loginRedirect = true;
    return error;
}

function isDouyinLoginUrl(value) {
    try {
        const parsed = new URL(value);
        return parsed.hostname === 'passport.douyin.com' || /\/(?:login|passport)(?:\/|$)/i.test(parsed.pathname);
    } catch {
        return false;
    }
}

function isDouyinUrl(value) {
    try {
        const host = new URL(value).hostname.toLowerCase();
        return host === 'v.douyin.com' || host === 'douyin.com' || host.endsWith('.douyin.com') || host === 'iesdouyin.com' || host.endsWith('.iesdouyin.com');
    } catch {
        return false;
    }
}

const ROUTE_PLATFORM_KEYS = Object.freeze(Object.fromEntries(COOKIE_PLATFORMS.map((platform) => [COOKIE_PLATFORM_DEFINITIONS[platform].label, platform])));

function cookiePlatformForRoute(routeInfo) {
    if (ROUTE_PLATFORM_KEYS[routeInfo?.platform]) return ROUTE_PLATFORM_KEYS[routeInfo.platform];
    const route = String(routeInfo?.route || '');
    return COOKIE_PLATFORMS.find((platform) => route.startsWith(`/${platform}/`)) || '';
}

function cookiePlatformForInput(value) {
    const text = String(value || '').trim();
    if (text.startsWith('/')) {
        return COOKIE_PLATFORMS.find((platform) => text.startsWith(`/${platform}/`)) || '';
    }
    try {
        const host = new URL(text).hostname.toLowerCase().replace(/^www\./, '');
        let best = null;
        for (const platform of COOKIE_PLATFORMS) {
            for (const candidate of COOKIE_PLATFORM_DEFINITIONS[platform].hosts || []) {
                if (host !== candidate && !host.endsWith(`.${candidate}`)) continue;
                if (!best || candidate.length > best.host.length) best = { platform, host: candidate };
            }
        }
        return best?.platform || '';
    } catch {}
    return '';
}

async function resolveShortLink(value, { cookieLease = null } = {}) {
    let directError = null;
    try {
        // Some short-link services (notably b23.tv) reject a spoofed browser UA
        // while accepting Node's normal redirect request.
        const response = await fetchWithTimeout(value, 20000, { redirect: 'follow' });
        const recoveredXiaohongshuUrl = extractXiaohongshuRedirectTarget(response.url);
        const directUrl = recoveredXiaohongshuUrl || response.url;
        if (!needsRedirectResolution(directUrl)) {
            return directUrl;
        }
        if (!response.ok) {
            directError = new Error(`短链接解析失败（HTTP ${response.status}）`);
        }
    } catch (error) {
        directError = error;
    }

    try {
        const browserUrl = await resolveShortLinkWithBrowser(value, { cookieLease });
        const recoveredXiaohongshuUrl = extractXiaohongshuRedirectTarget(browserUrl);
        const resolvedUrl = recoveredXiaohongshuUrl || browserUrl;
        if (!resolvedUrl || needsRedirectResolution(resolvedUrl)) {
            throw new Error('短链接没有跳转到可识别的长链接；链接可能已过期');
        }
        return resolvedUrl;
    } catch (browserError) {
        if (directError) {
            throw directError;
        }
        throw browserError;
    }
}

async function resolveProfileUrl(value, { cookieLease = null, platform = '' } = {}) {
    value = canonicalizeProfileUrl(value);
    const kuaishouProfileId = extractKuaishouProfileId(value);
    if (kuaishouProfileId) {
        return `https://www.kuaishou.com/profile/${kuaishouProfileId}`;
    }

    const videoId = extractDouyinVideoId(value);
    if (videoId) {
        const secUid = await resolveDouyinVideoAuthor(videoId, { cookieLease });
        if (!secUid) {
            throw new Error('已解析为抖音作品，但没有找到作品作者主页');
        }
        return `https://www.douyin.com/user/${secUid}`;
    }

    const bilibiliVideoId = extractBilibiliVideoId(value);
    if (bilibiliVideoId) {
        return resolveBilibiliVideoAuthor(bilibiliVideoId, { cookieLease });
    }

    if (isXiaohongshuWorkUrl(value)) {
        return resolveXiaohongshuWorkAuthor(value, { cookieLease });
    }

    if (isToutiaoWorkUrl(value)) {
        return resolveToutiaoWorkAuthor(value, { cookieLease });
    }

    if (platform === 'tencent_news' && /\/media\//i.test(new URL(value).pathname)) {
        const response = await fetchWithTimeout(value, 25000, {
            redirect: 'follow',
            headers: {
                ...(cookieLease?.cookieHeader?.() ? { Cookie: cookieLease.cookieHeader() } : {}),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
            },
        });
        if ([401, 403, 429].includes(response.status)) {
            throw Object.assign(new Error(`腾讯新闻主页跳转解析失败（HTTP ${response.status}）`), { httpStatus: response.status });
        }
        if (response.url && /\/u\/[^/?#]+/i.test(new URL(response.url).pathname)) return response.url;
    }

    if (platform === 'video56' && GENERIC_WORK_PROFILE_RULES.video56.workPattern.test(new URL(value).pathname)) {
        const cookie = cookieLease?.cookieHeader?.() || '';
        const response = await fetchWithTimeout(value, 25000, {
            redirect: 'follow',
            headers: {
                ...(cookie ? { Cookie: cookie } : {}),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
            },
        });
        if ([401, 403, 429].includes(response.status)) {
            throw Object.assign(new Error(`56视频作者主页解析失败（HTTP ${response.status}）`), { httpStatus: response.status });
        }
        const html = await response.text();
        const profileUrl = findVideo56AuthorProfileFromHtml(html);
        if (profileUrl) return profileUrl;
    }

    if (platform === 'sohu_video') {
        const authorId = extractSohuVideoAuthorId(value);
        if (authorId) return `http://tv.sohu.com/s/follow/authorHome.html?uid=${authorId}#/AuthWorks`;
    }

    const genericRule = GENERIC_WORK_PROFILE_RULES[platform];
    if (genericRule?.workPattern.test(new URL(value).pathname)) {
        return resolveWorkAuthorWithBrowser({
            value,
            cookieFile: '',
            cookieDomain: COOKIE_PLATFORM_DEFINITIONS[platform].domain,
            cookieLease,
            selector: genericRule.selector,
            platform: COOKIE_PLATFORM_DEFINITIONS[platform].label,
        });
    }

    return value;
}

const GENERIC_WORK_PROFILE_RULES = Object.freeze({
    weibo: { workPattern: /^\/(?!u\/|profile\/|\d+\/)(?:status\/|[A-Za-z0-9_-]+\/)[A-Za-z0-9_-]+/, selector: 'a[href*="/u/"], a[href*="/profile/"]' },
    netease: { workPattern: /^(?!\/dy\/media\/)(?:.*\/article\/.*|.*\/\w+\.html)$/i, selector: 'a[href*="/dy/media/"]' },
    dongchedi: { workPattern: /^\/(?:article|video)\//, selector: 'a[href*="/user/"]' },
    yidian: { workPattern: /^\/article\//, selector: 'a[href*="/channel/"], a[href*="/home/"], a[href*="/user/"], a[href*="/media/"]' },
    autohome: { workPattern: /^\/info\//, selector: 'a[href*="/Authors/"]' },
    meipai: { workPattern: /^\/media\//, selector: 'a[href*="/user/"]' },
    video56: { workPattern: /\/v_[^/]+\.html$/i, selector: 'a[href*="/user/"], a[href*="/u/"]' },
    miaopai: { workPattern: /^\/(?:show|media)\//, selector: 'a[href*="/user/"], a[href*="/u/"]' },
    ixigua: { workPattern: /^\/(?:video\/)?\d+/, selector: 'a[href*="/home/"]' },
});

async function resolveShortLinkWithBrowser(value, { cookieLease = null } = {}) {
    const { filePath, domain } = cookieConfigForUrl(value);
    const cookies = cookieLease ? cookieLease.browserCookies() : filePath ? await loadBrowserCookies(filePath, domain) : [];
    const code = `module.exports = async ({ page, context }) => {
        const cookies = ${JSON.stringify(cookies)};
        if (cookies.length) await page.setCookie(...cookies);
        await page.goto(context.url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const candidates = await page.evaluate(() => [
            location.href,
            document.querySelector('link[rel="canonical"]')?.href || '',
            document.querySelector('meta[property="og:url"]')?.content || '',
        ].filter(Boolean));
        return { data: JSON.stringify({ candidates }), type: 'application/json' };
    }`;
    const browserResponse = await fetchWithTimeout(`${BROWSERLESS_HTTP_URL}/function`, 35000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, context: { url: value } }),
    });
    if (!browserResponse.ok) {
        throw new Error(`短链接浏览器解析失败（HTTP ${browserResponse.status}）`);
    }
    const payload = await parseBrowserlessJson(browserResponse);
    return (Array.isArray(payload?.candidates) ? payload.candidates : []).find((candidate) => !needsRedirectResolution(candidate)) || '';
}

function cookieConfigForUrl(value) {
    try {
        const host = new URL(value).hostname.toLowerCase();
        if (host.includes('xiaohongshu') || host.includes('xhslink')) return { filePath: XIAOHONGSHU_COOKIE_FILE, domain: 'xiaohongshu.com' };
        if (host.includes('kuaishou')) return { filePath: KUAISHOU_COOKIE_FILE, domain: 'kuaishou.com' };
        if (host.includes('toutiao')) return { filePath: TOUTIAO_COOKIE_FILE, domain: 'toutiao.com' };
        if (host.includes('douyin')) return { filePath: DOUYIN_COOKIE_FILE, domain: 'douyin.com' };
        if (host.includes('bilibili') || host === 'b23.tv') return { filePath: BILIBILI_COOKIE_FILE, domain: 'bilibili.com' };
    } catch {}
    return { filePath: '', domain: '' };
}

async function resolveBilibiliVideoAuthor(videoId, { cookieLease = null } = {}) {
    const query = videoId.toLowerCase().startsWith('av')
        ? `aid=${encodeURIComponent(videoId.slice(2))}`
        : `bvid=${encodeURIComponent(videoId)}`;
    const cookie = cookieLease ? cookieLease.cookieHeader() : await loadCookieHeader(BILIBILI_COOKIE_FILE, 'bilibili.com');
    const response = await fetchWithTimeout(`https://api.bilibili.com/x/web-interface/view?${query}`, 20000, {
        headers: { Referer: 'https://www.bilibili.com/', ...(cookie ? { Cookie: cookie } : {}) },
    });
    const payload = await response.json().catch(() => null);
    const ownerId = payload?.code === 0 ? payload?.data?.owner?.mid : '';
    if (!response.ok || !ownerId) {
        throw new Error(`B站作品作者解析失败${payload?.message ? `：${payload.message}` : `（HTTP ${response.status}）`}`);
    }
    return `https://space.bilibili.com/${ownerId}`;
}

async function resolveXiaohongshuWorkAuthor(value, { cookieLease = null } = {}) {
    const cookie = cookieLease ? cookieLease.cookieHeader() : await loadCookieHeader(XIAOHONGSHU_COOKIE_FILE, 'xiaohongshu.com');
    const response = await fetchWithTimeout(value, 25000, {
        redirect: 'follow',
        headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9',
        },
    });
    const html = await response.text();
    const initialStateUserId = findXiaohongshuAuthorIdFromHtml(html);
    if (initialStateUserId) {
        return `https://www.xiaohongshu.com/user/profile/${initialStateUserId}`;
    }

    const profileUrl = await resolveWorkAuthorWithBrowser({
        value,
        cookieFile: XIAOHONGSHU_COOKIE_FILE,
        cookieDomain: 'xiaohongshu.com',
        cookieLease,
        selector: '#noteContainer .author-wrapper a[href*="/user/profile/"], #noteContainer a[href*="/user/profile/"]',
        platform: '小红书',
    });
    const userId = profileUrl.match(/\/user\/profile\/([A-Za-z0-9]+)/)?.[1];
    if (!userId) {
        throw new Error('小红书作品页中没有找到作者主页');
    }
    return `https://www.xiaohongshu.com/user/profile/${userId}`;
}

async function resolveToutiaoWorkAuthor(value, { cookieLease = null } = {}) {
    const profileUrl = await resolveWorkAuthorWithBrowser({
        value,
        cookieFile: TOUTIAO_COOKIE_FILE,
        cookieDomain: 'toutiao.com',
        cookieLease,
        selector: 'a[href*="/c/user/token/MS4wLjABAAAA"]',
        platform: '今日头条',
    });
    const token = extractToutiaoUserToken(profileUrl);
    if (!token) {
        throw new Error('今日头条作品页中没有找到作者主页');
    }
    return `https://www.toutiao.com/c/user/token/${token}/`;
}

async function resolveWorkAuthorWithBrowser({ value, cookieFile, cookieDomain, cookieLease = null, selector, platform }) {
    const cookies = cookieLease ? cookieLease.browserCookies() : await loadBrowserCookies(cookieFile, cookieDomain);
    const code = `module.exports = async ({ page, context }) => {
        const cookies = ${JSON.stringify(cookies)};
        if (cookies.length) await page.setCookie(...cookies);
        await page.goto(context.url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        await page.waitForSelector(context.selector, { timeout: 15000 }).catch(() => {});
        const href = await page.$eval(context.selector, (node) => node.href || node.getAttribute('href') || '').catch(() => '');
        const bodyText = await page.$eval('body', (body) => (body.innerText || '').slice(0, 1800)).catch(() => '');
        const missing = /内容不存在|文章没有找到|页面不存在|已删除|已下线/.test(bodyText);
        return { data: JSON.stringify({ href, missing }), type: 'application/json' };
    }`;
    const browserResponse = await fetchWithTimeout(`${BROWSERLESS_HTTP_URL}/function`, 45000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, context: { url: value, selector } }),
    });
    if (!browserResponse.ok) {
        throw new Error(`${platform}作者主页解析失败（浏览器 HTTP ${browserResponse.status}）`);
    }
    const payload = await parseBrowserlessJson(browserResponse);
    if (!payload?.href) {
        if (payload?.missing) {
            throw Object.assign(new Error(`${platform}作品页显示内容不存在或已下线`), { empty: true, credentialVerified: true });
        }
        if (!cookies.length) {
            throw new Error(`${platform}公开作品页没有展示作者主页；请改用作者主页链接，或导入 Cookie 后重试`);
        }
        throw new Error(`${platform}作品页没有展示作者主页；可能触发反爬或页面结构变更`);
    }
    return payload.href;
}

async function parseBrowserlessJson(response) {
    let payload = await response.json();
    if (typeof payload === 'string') {
        payload = JSON.parse(payload);
    }
    return payload;
}

async function resolveDouyinVideoAuthor(videoId, { cookieLease = null } = {}) {
    let directError = null;
    try {
        const directSecUid = await resolveDouyinVideoAuthorDirect(videoId, { cookieLease });
        if (directSecUid) {
            return directSecUid;
        }
    } catch (error) {
        directError = error;
        console.warn('[douyin-author-direct-fallback]', JSON.stringify({ videoId, error: cleanError(error) }));
    }

    const result = await retryDouyinAuthorFetch(
        () => resolveDouyinVideoAuthorAttempt(videoId, { cookieLease }),
        {
            maxAttempts: 3,
            onRetry: async ({ attempt, error }) => {
                console.warn('[douyin-author-retry]', JSON.stringify({ videoId, attempt, error: error ? cleanError(error) : '' }));
                await new Promise((resolve) => setTimeout(resolve, 750));
            },
        },
    );
    if (result.error) {
        throw result.error;
    }
    if (directError && classifyCookieFailure(directError).failover) throw directError;
    return result.value;
}

async function resolveDouyinVideoAuthorDirect(videoId, { cookieLease = null } = {}) {
    const cookie = cookieLease ? cookieLease.cookieHeader() : await loadCookieHeader(DOUYIN_COOKIE_FILE, 'douyin.com');
    if (!cookie) {
        return '';
    }
    const response = await fetchWithTimeout(`https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${encodeURIComponent(videoId)}&aid=6383&device_platform=webapp`, 20000, {
        headers: {
            Cookie: cookie,
            Referer: `https://www.douyin.com/video/${videoId}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
        },
    });
    const payload = await response.json().catch(() => null);
    if (isDouyinLoginUrl(response.url) || !response.ok || payload?.status_code !== 0) {
        throw douyinHttpError(`抖音作品接口请求失败（HTTP ${response.status}）`, response);
    }
    return findDouyinAuthorSecUid(payload, videoId);
}

async function resolveDouyinVideoAuthorAttempt(videoId, { cookieLease = null } = {}) {
    const cookies = cookieLease ? cookieLease.browserCookies() : await loadBrowserCookies(DOUYIN_COOKIE_FILE, 'douyin.com');
    const code = `module.exports = async ({ page, context }) => {
        const findAuthorSecUid = ${findDouyinAuthorSecUid.toString()};
        const findAuthorFromLinkedData = ${findDouyinAuthorSecUidFromLinkedData.toString()};
        const cookies = ${JSON.stringify(cookies)};
        if (cookies.length) await page.setCookie(...cookies);
        let resolveUid;
        let settled = false;
        let httpStatus = 0;
        const uidPromise = new Promise((resolve) => { resolveUid = resolve; });
        const acceptUid = (value) => {
            if (!settled && typeof value === 'string' && value.startsWith('MS4wLjABAAAA')) {
                settled = true;
                resolveUid(value);
            }
        };
        page.on('response', async (response) => {
            if (!response.url().includes('/aweme/v1/web/aweme/detail/')) return;
            try {
                if ([401, 403, 429].includes(response.status())) {
                    httpStatus = response.status();
                    return;
                }
                const data = await response.json();
                acceptUid(findAuthorSecUid(data, context.videoId));
            } catch {}
        });
        await page.goto(context.url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        const loginRedirect = /passport\\.douyin\\.com|\\/(?:login|passport)(?:\\/|$)/i.test(page.url());
        let secUid = await Promise.race([uidPromise, new Promise((resolve) => setTimeout(() => resolve(''), 8000))]);
        if (!secUid) {
            const linkedData = await page.$$eval('script[type="application/ld+json"]', (nodes) => nodes.map((node) => node.textContent || '')).catch(() => []);
            secUid = findAuthorFromLinkedData(linkedData, context.videoId);
        }
        return { data: JSON.stringify({ secUid, httpStatus, loginRedirect }), type: 'application/json' };
    }`;

    const browserResponse = await fetchWithTimeout(`${BROWSERLESS_HTTP_URL}/function`, 40000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            code,
            context: { url: `https://www.douyin.com/video/${videoId}`, videoId },
        }),
    });
    if (!browserResponse.ok) {
        throw new Error(`抖音作者主页解析失败（浏览器 HTTP ${browserResponse.status}）`);
    }

    let payload = await browserResponse.json();
    if (typeof payload === 'string') {
        payload = JSON.parse(payload);
    }
    if (payload?.loginRedirect) {
        throw Object.assign(new Error('抖音作品页跳转到登录页'), { loginRedirect: true });
    }
    if ([401, 403, 429].includes(Number(payload?.httpStatus))) {
        throw Object.assign(new Error(`抖音作品接口请求失败（HTTP ${payload.httpStatus}）`), { httpStatus: Number(payload.httpStatus) });
    }
    return payload?.secUid || '';
}

async function fetchKuaishouUserFeed(principalId, { cookieLease = null } = {}) {
    const cookie = cookieLease ? cookieLease.cookieHeader() : await loadCookieHeader(KUAISHOU_COOKIE_FILE, 'kuaishou.com');
    if (!cookie) {
        throw new Error('没有找到可用的快手 Cookie；请重新导出登录后的快手 Cookie');
    }

    const requestBody = JSON.stringify({
        operationName: 'visionProfilePhotoList',
        variables: {
            page: 'profile',
            pcursor: '',
            userId: principalId,
            webPageArea: 'profile',
        },
        query: KUAISHOU_PROFILE_QUERY,
    });
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const response = await fetchWithTimeout('https://www.kuaishou.com/graphql', 25000, {
                method: 'POST',
                headers: {
                    Cookie: cookie,
                    Referer: `https://www.kuaishou.com/profile/${principalId}`,
                    Origin: 'https://www.kuaishou.com',
                    Accept: '*/*',
                    'Accept-Language': 'zh-CN,zh;q=0.9',
                    'Content-Type': 'application/json;charset=UTF-8',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
                    'Sec-Fetch-Dest': 'empty',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'same-origin',
                },
                body: requestBody,
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok) {
                const error = new Error(`快手作品接口请求失败（HTTP ${response.status}）`);
                if ([401, 403, 429].includes(response.status)) error.httpStatus = response.status;
                throw error;
            }
            if (payload?.errors?.length) {
                throw new Error(`快手作品接口返回错误：${toErrorMessage(payload.errors[0]?.message || payload.errors[0])}`);
            }

            const feed = normalizeKuaishouFeed(payload);
            if (Number(feed.result) !== 1) {
                if (Number(feed.result) === 50) {
                    throw Object.assign(new Error('快手 Cookie 的安全令牌已过期或账号触发风控；请重新导出当前登录会话的 Cookie'), { loginRedirect: true });
                }
                throw new Error(`快手作品接口返回异常（result=${feed.result ?? '空'}）`);
            }
            return feed;
        } catch (error) {
            lastError = error;
            if (/Cookie|result=|返回错误/.test(String(error?.message || ''))) {
                break;
            }
            if (attempt < 3) {
                await new Promise((resolve) => setTimeout(resolve, attempt * 700));
            }
        }
    }

    console.warn('[kuaishou-feed-browser-fallback]', JSON.stringify({
        principalId,
        error: cleanError(lastError || new Error('快手作品接口没有返回数据')),
    }));
    return fetchKuaishouUserFeedWithBrowser(principalId, { cookieLease });
}

async function fetchKuaishouUserFeedWithBrowser(principalId, { cookieLease = null } = {}) {
    const cookies = cookieLease ? cookieLease.browserCookies() : await loadBrowserCookies(KUAISHOU_COOKIE_FILE, 'kuaishou.com');
    if (!cookies.length) throw new Error('没有找到可用的快手 Cookie；请重新导出登录后的快手 Cookie');
    const code = `module.exports = async ({ page, context }) => {
        const cookies = ${JSON.stringify(cookies)};
        if (cookies.length) await page.setCookie(...cookies);
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9' });
        await page.evaluateOnNewDocument(() => {
            try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
        });
        const naturalPayloads = [];
        const naturalPending = [];
        page.on('response', (networkResponse) => {
            const url = String(networkResponse.url() || '');
            if (!/(?:live_api\\/profile\\/public|rest\\/v\\/profile\\/feed)/i.test(url)) return;
            const task = (async () => {
                try {
                    const text = await networkResponse.text();
                    if (text && text.length <= 500000) naturalPayloads.push({ url: url.split(/[?#]/, 1)[0], status: networkResponse.status(), text });
                } catch {}
            })();
            naturalPending.push(task);
        });
        const profileUrl = 'https://www.kuaishou.com/profile/' + encodeURIComponent(context.principalId);
        const response = await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
        // 只取主页自然触发的 feed：手工补发 GraphQL 会被快手判为参数异常，且不能代表真实浏览器页面。
        await new Promise((resolve) => setTimeout(resolve, 6000));
        for (let index = 0; index < 4; index += 1) {
            await page.evaluate(() => window.scrollBy(0, 1000)).catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 600));
        }
        await new Promise((resolve) => setTimeout(resolve, 800));
        await Promise.allSettled(naturalPending);
        const bodyText = await page.$eval('body', (body) => (body.innerText || '').slice(0, 3000)).catch(() => '');
        return { data: JSON.stringify({
            pageStatus: response ? response.status() : 0,
            currentUrl: page.url(),
            bodyLength: bodyText.length,
            missing: /用户(?:信息)?不存在|账号不存在|内容不存在|页面不存在|已注销/.test(bodyText),
            naturalPayloads,
        }), type: 'application/json' };
    }`;
    const browserResponse = await fetchWithTimeout(`${BROWSERLESS_HTTP_URL}/function`, 65000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, context: { principalId } }),
    });
    if (!browserResponse.ok) throw new Error(`快手主页读取失败（浏览器 HTTP ${browserResponse.status}）`);
    const payload = await parseBrowserlessJson(browserResponse);
    const httpStatus = Number(payload?.pageStatus);
    if ([401, 403, 429].includes(httpStatus)) {
        throw Object.assign(new Error(`快手作品接口请求失败（HTTP ${httpStatus}）`), { httpStatus });
    }
    if (isLoginLikeUrl(payload?.currentUrl)) {
        throw Object.assign(new Error('快手主页跳转到登录页；当前浏览器环境无法确认 Cookie 是否失效'), { loginRedirect: true });
    }
    if (payload?.missing) {
        throw Object.assign(new Error('快手主页显示用户或内容不存在'), { empty: true, credentialVerified: true });
    }
    let sawVerification = false;
    let sawInvalidProfileId = false;
    for (const entry of Array.isArray(payload?.naturalPayloads) ? payload.naturalPayloads : []) {
        let nativePayload = null;
        try { nativePayload = JSON.parse(entry?.text || ''); } catch {}
        if (!nativePayload) continue;
        const nativeResult = Number(nativePayload?.data?.result ?? nativePayload?.result);
        if (nativeResult === 400002) sawVerification = true;
        if (nativeResult === 21) sawInvalidProfileId = true;
        const nativeFeed = normalizeKuaishouNativeFeed(nativePayload);
        if (nativeFeed.items.some((item) => item?.date_published)) return nativeFeed;
    }
    if (sawVerification) {
        throw new Error('快手页面触发安全验证；当前 Cookie 在 Docker 浏览器环境不能直接使用，请在同一环境重新登录后再试');
    }
    if (sawInvalidProfileId) {
        throw Object.assign(new Error('快手短链接未解析到可用的作者主 ID；该账号主页接口返回参数格式错误'), { empty: true, credentialVerified: true });
    }
    throw new Error('快手主页没有捕获到自然作品 feed；当前 Cookie 在内置浏览器环境未获平台接受，并非直接判定为失效');
}

async function fetchXiaohongshuUserFeed(userId, { cookieLease = null } = {}) {
    const cookies = cookieLease ? cookieLease.browserCookies() : await loadBrowserCookies(XIAOHONGSHU_COOKIE_FILE, 'xiaohongshu.com');
    if (!cookies.length) throw new Error('没有找到可用的小红书 Cookie');
    const code = `module.exports = async ({ page, context }) => {
        const cookies = ${JSON.stringify(cookies)};
        if (cookies.length) await page.setCookie(...cookies);
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9' });
        await page.evaluateOnNewDocument(() => {
            try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
        });
        let httpStatus = 0;
        page.on('response', (response) => {
            if (!response.url().includes('xiaohongshu.com/api/sns/web/')) return;
            if ([401, 403, 429].includes(response.status())) httpStatus = response.status();
        });
        await page.goto(context.url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        let profile = { nickname: '', items: [] };
        for (let index = 0; index < 6; index += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1200));
            await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
            profile = await page.evaluate(() => {
                const unwrap = (value) => value?._rawValue ?? value?.value ?? value;
                const state = window.__INITIAL_STATE__ || {};
                const rawNotes = unwrap(unwrap(state.user)?.notes);
                const roots = Array.isArray(rawNotes) ? rawNotes : [rawNotes];
                const seen = new Set();
                const byId = new Map();
                const walk = (value, depth = 0) => {
                    if (!value || typeof value !== 'object' || depth > 12 || seen.has(value)) return;
                    seen.add(value);
                    if (Array.isArray(value)) { for (const entry of value) walk(entry, depth + 1); return; }
                    const card = value.noteCard || value.note_card || value;
                    const id = String(value.id || card.noteId || card.note_id || card.id || '');
                    const timestamp = card.time ?? card.createTime ?? card.create_time ?? value.time ?? value.createTime ?? value.create_time;
                    if (id && Number.isFinite(Number(timestamp))) {
                        byId.set(id, { id, title: card.displayTitle || card.title || card.desc || value.title || '', timestamp: Number(timestamp) });
                    }
                    for (const entry of Object.values(value)) walk(entry, depth + 1);
                };
                for (const root of roots) walk(root);
                const pageData = unwrap(unwrap(state.user)?.userPageData) || {};
                const basicInfo = unwrap(pageData.basicInfo) || {};
                return { nickname: basicInfo.nickname || '', items: [...byId.values()] };
            }).catch(() => ({ nickname: '', items: [] }));
            if (profile.items.length) break;
        }
        const bodyText = await page.$eval('body', (body) => body.innerText || '').catch(() => '');
        const loginRedirect = page.url().includes('passport') || page.url().includes('/login') || /扫码登录|手机号登录|登录后查看/.test(bodyText);
        const hrefs = await page.$$eval('a[href*="/explore/"], a[href*="/discovery/item/"]', (nodes) => nodes.map((node) => node.href || node.getAttribute('href') || '').filter(Boolean)).catch(() => []);
        const items = [...profile.items];
        const seen = new Set(items.map((entry) => entry.id));
        for (const href of hrefs) {
            let parts = [];
            try { parts = new URL(href).pathname.split('/').filter(Boolean); } catch {}
            const id = parts[0] === 'explore' ? parts[1] : (parts[0] === 'discovery' && parts[1] === 'item' ? parts[2] : '');
            if (!id || seen.has(id)) continue;
            seen.add(id);
            items.push({ id, title: '', timestamp: null });
        }
        return { data: JSON.stringify({ nickname: profile.nickname, items, httpStatus, loginRedirect }), type: 'application/json' };
    }`;
    const browserResponse = await fetchWithTimeout(`${BROWSERLESS_HTTP_URL}/function`, 70000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, context: { url: `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(userId)}` } }),
    });
    if (!browserResponse.ok) throw new Error(`小红书主页读取失败（浏览器 HTTP ${browserResponse.status}）`);
    const payload = await parseBrowserlessJson(browserResponse);
    assertPlatformBrowserResult(payload, '小红书');
    return normalizeXiaohongshuFeed(payload);
}

async function fetchToutiaoUserFeed(token, { cookieLease = null } = {}) {
    const cookies = cookieLease ? cookieLease.browserCookies() : await loadBrowserCookies(TOUTIAO_COOKIE_FILE, 'toutiao.com');
    if (!cookies.length) throw new Error('没有找到可用的今日头条 Cookie');
    const code = `module.exports = async ({ page, context }) => {
        const cookies = ${JSON.stringify(cookies)};
        if (cookies.length) await page.setCookie(...cookies);
        let httpStatus = 0;
        let feedEndpointSeen = false;
        const feedItems = [];
        const pending = [];
        page.on('response', async (response) => {
            if (response.url().includes('toutiao.com/api/') && [401, 403, 429].includes(response.status())) httpStatus = response.status();
            if (!response.url().includes('/api/pc/list/feed')) return;
            feedEndpointSeen = true;
            pending.push((async () => {
                try {
                    const data = await response.json();
                    if (Array.isArray(data?.data)) feedItems.push(...data.data);
                } catch {}
            })());
        });
        await page.goto(context.url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        for (let index = 0; index < 3; index += 1) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 1200));
        }
        await Promise.allSettled(pending);
        const loginRedirect = page.url().includes('passport') || page.url().includes('/login');
        const bodyText = await page.$eval('body', (body) => body.innerText || '').catch(() => '');
        const userMissing = bodyText.includes('用户不存在') || bodyText.includes('你访问的用户不存在');
        const domCandidates = await page.evaluate(() => {
            const rows = [];
            for (const node of document.querySelectorAll('time,[datetime],[data-time],[data-publish-time],[class*="time"],[class*="date"]')) {
                const date = String(node.getAttribute('datetime') || node.getAttribute('data-time') || node.getAttribute('data-publish-time') || node.textContent || '').trim();
                if (!date || date.length > 80) continue;
                const card = node.closest('article,li,[class*="item"],[class*="card"],[class*="feed"]') || node.parentElement;
                const anchor = card?.querySelector('a[href]') || node.closest('a[href]');
                const titleNode = card?.querySelector('[title],h1,h2,h3,h4,[class*="title"],[class*="desc"]');
                rows.push({ date, title: String(titleNode?.getAttribute('title') || titleNode?.textContent || '').trim(), url: anchor?.href || '' });
            }
            return rows;
        }).catch(() => []);
        const title = await page.title().catch(() => '');
        return { data: JSON.stringify({ httpStatus, loginRedirect, userMissing, feedEndpointSeen, feedItems, domCandidates, title }), type: 'application/json' };
    }`;
    const browserResponse = await fetchWithTimeout(`${BROWSERLESS_HTTP_URL}/function`, 60000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, context: { url: `https://www.toutiao.com/c/user/token/${encodeURIComponent(token)}/` } }),
    });
    if (!browserResponse.ok) throw new Error(`今日头条主页读取失败（浏览器 HTTP ${browserResponse.status}）`);
    const payload = await parseBrowserlessJson(browserResponse);
    assertPlatformBrowserResult(payload, '今日头条');
    if (payload?.userMissing) throw Object.assign(new Error('今日头条主页显示用户不存在'), { empty: true });
    if (Array.isArray(payload?.feedItems) && payload.feedItems.length) {
        const feed = normalizeToutiaoFeed({ data: payload.feedItems });
        if (feed.items.some((item) => item?.date_published)) return feed;
    }
    const domFeed = normalizeGenericFeed({ title: payload?.title, domCandidates: payload?.domCandidates }, {
        platform: '今日头条',
        profileUrl: `https://www.toutiao.com/c/user/token/${encodeURIComponent(token)}/`,
    });
    if (domFeed.items.length) return domFeed;
    if (payload?.feedEndpointSeen) {
        throw Object.assign(new Error('今日头条主页当前没有作品'), { empty: true, credentialVerified: true });
    }
    return fetchRssHubXmlFeed(`/toutiao/user/token/${encodeURIComponent(token)}`, '今日头条');
}

async function fetchBilibiliUserFeed(uid, { cookieLease = null } = {}) {
    const cookie = cookieLease ? cookieLease.cookieHeader() : await loadCookieHeader(BILIBILI_COOKIE_FILE, 'bilibili.com');
    if (!cookie) throw new Error('没有找到可用的B站 Cookie');
    const response = await fetchWithTimeout(`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${encodeURIComponent(uid)}`, 25000, {
        headers: {
            Cookie: cookie,
            Referer: `https://space.bilibili.com/${uid}/`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
        },
    });
    if ([401, 403, 429].includes(response.status)) {
        throw Object.assign(new Error(`B站作品接口请求失败（HTTP ${response.status}）`), { httpStatus: response.status });
    }
    if (!response.ok) throw new Error(`B站作品接口请求失败（HTTP ${response.status}）`);
    const payload = await response.json().catch(() => null);
    if (Number(payload?.code) === -101) {
        throw Object.assign(new Error('B站 Cookie 登录状态已失效'), { loginRedirect: true, credentialFailure: true });
    }
    if (Number(payload?.code) !== 0) throw new Error(`B站作品接口返回异常：${payload?.message || payload?.code || '未知错误'}`);
    const dynamicItems = Array.isArray(payload?.data?.items) ? payload.data.items : [];
    const vlist = dynamicItems
        .filter((item) => item?.type === 'DYNAMIC_TYPE_AV')
        .map((item) => {
            const archive = item?.modules?.module_dynamic?.major?.archive || {};
            return {
                bvid: archive.bvid,
                aid: archive.aid,
                title: archive.title,
                created: Number(item?.modules?.module_author?.pub_ts),
                author: item?.modules?.module_author?.name || '',
            };
        })
        .filter((item) => item.bvid && Number.isFinite(item.created));
    return normalizeBilibiliFeed({ data: { list: { vlist } } });
}

async function fetchDongchediUserFeed(userId, { cookieLease = null } = {}) {
    const cookie = cookieLease?.cookieHeader?.() || '';
    if (!cookie) throw new Error('没有找到可用的懂车帝 Cookie');
    const profileUrl = `https://www.dongchedi.com/user/${encodeURIComponent(userId)}`;
    const response = await fetchWithTimeout(profileUrl, 25000, {
        headers: {
            Cookie: cookie,
            Referer: 'https://www.dongchedi.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9',
        },
    });
    if ([401, 403, 429].includes(response.status)) {
        throw Object.assign(new Error(`懂车帝主页请求失败（HTTP ${response.status}）`), { httpStatus: response.status });
    }
    if (response.status === 404) throw Object.assign(new Error('懂车帝主页显示用户或内容不存在'), { empty: true, credentialVerified: true });
    if (!response.ok) throw new Error(`懂车帝主页请求失败（HTTP ${response.status}）`);
    const html = await response.text();
    const block = [...html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)]
        .map((match) => match[1])
        .find((value) => value.includes('contentData'));
    let pageData = null;
    try {
        pageData = block ? JSON.parse(block)?.props?.pageProps : null;
    } catch {}
    const rawItems = Array.isArray(pageData?.contentData?.data) ? pageData.contentData.data : [];
    if (!rawItems.length) {
        const blocked = /人机验证|安全验证|异常访问|访问过于频繁|验证码/.test(html);
        if (blocked) {
            throw Object.assign(new Error('懂车帝要求人机验证；当前会话未被平台接受'), { httpStatus: 403, credentialVerified: true });
        }
        throw Object.assign(new Error('懂车帝主页没有返回公开作品数据'), { empty: true, credentialVerified: true });
    }
    const items = rawItems.map((entry) => {
        const timestamp = Number(entry?.display_time ?? entry?.create_time ?? entry?.behot_time);
        const id = String(entry?.gid_str || entry?.gid || '');
        const type = Number(entry?.type);
        return {
            title: String(entry?.title || entry?.thread_title || '懂车帝作品').trim(),
            url: id ? `https://www.dongchedi.com/${type === 0 && entry?.has_video ? 'video' : 'article'}/${id}` : profileUrl,
            date_published: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : '',
        };
    }).filter((item) => item.date_published);
    return { title: String(pageData?.headData?.info?.nick_name || '懂车帝用户'), items };
}

async function fetchZhihuUserFeed(memberId, { cookieLease = null } = {}) {
    const cookie = cookieLease?.cookieHeader?.() || '';
    if (!cookie) throw new Error('没有找到可用的知乎 Cookie');
    const headers = {
        Cookie: cookie,
        Referer: `https://www.zhihu.com/people/${encodeURIComponent(memberId)}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
    };
    const sources = [
        { type: 'answer', path: `/api/v4/members/${encodeURIComponent(memberId)}/answers?limit=20&offset=0&sort_by=created` },
        { type: 'article', path: `/api/v4/members/${encodeURIComponent(memberId)}/articles?limit=20&offset=0&sort_by=created` },
        { type: 'zvideo', path: `/api/v4/members/${encodeURIComponent(memberId)}/zvideos?limit=20&offset=0` },
        { type: 'pin', path: `/api/v4/members/${encodeURIComponent(memberId)}/pins?limit=20&offset=0` },
    ];
    const responses = await Promise.all(sources.map(async (source) => {
        const response = await fetchWithTimeout(`https://www.zhihu.com${source.path}`, 25000, { headers });
        if ([401, 403, 429].includes(response.status)) {
            throw Object.assign(new Error(`知乎作品接口请求失败（HTTP ${response.status}）`), { httpStatus: response.status });
        }
        if (!response.ok) throw new Error(`知乎作品接口请求失败（HTTP ${response.status}）`);
        const payload = await response.json().catch(() => null);
        return { ...source, entries: Array.isArray(payload?.data) ? payload.data : [] };
    }));
    const items = responses.flatMap(({ type, entries }) => entries.map((entry) => {
        const timestamp = Number(entry?.created_time ?? entry?.created ?? entry?.updated_time);
        const id = String(entry?.id || '');
        const question = entry?.question || {};
        const urls = {
            answer: question.id && id ? `https://www.zhihu.com/question/${question.id}/answer/${id}` : '',
            article: id ? `https://zhuanlan.zhihu.com/p/${id}` : '',
            zvideo: id ? `https://www.zhihu.com/zvideo/${id}` : '',
            pin: id ? `https://www.zhihu.com/pin/${id}` : '',
        };
        return {
            title: String(question.title || entry?.title || entry?.content || `${memberId} 的知乎作品`).replace(/<[^>]*>/g, ' ').trim().slice(0, 300),
            url: urls[type] || entry?.url || `https://www.zhihu.com/people/${encodeURIComponent(memberId)}`,
            date_published: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : '',
        };
    }).filter((item) => item.date_published));
    return { title: `${memberId} 的知乎作品`, items };
}

function assertPlatformBrowserResult(payload, platform) {
    if (payload?.loginRedirect) throw Object.assign(new Error(`${platform}主页跳转到登录页`), { loginRedirect: true });
    const httpStatus = Number(payload?.httpStatus);
    if ([401, 403, 429].includes(httpStatus)) {
        throw Object.assign(new Error(`${platform}作品接口请求失败（HTTP ${httpStatus}）`), { httpStatus });
    }
}

async function validateCookieSessionWithHttp(platform, resolvedUrl, cookieLease) {
    const cookies = cookieLease?.browserCookies?.() || [];
    if (!cookies.length) throw new Error(`没有找到可用的${COOKIE_PLATFORM_DEFINITIONS[platform].label} Cookie`);
    const code = `module.exports = async ({ page, context }) => {
        const cookies = ${JSON.stringify(cookies)};
        if (cookies.length) await page.setCookie(...cookies);
        const response = await page.goto(context.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const bodyText = await page.$eval('body', (body) => (body.innerText || '').slice(0, 3000)).catch(() => '');
        return { data: JSON.stringify({
            httpStatus: response ? response.status() : 0,
            currentUrl: page.url(),
            missing: /用户(?:信息)?不存在|账号不存在|内容不存在|页面不存在|已注销/.test(bodyText),
        }), type: 'application/json' };
    }`;
    const browserResponse = await fetchWithTimeout(`${BROWSERLESS_HTTP_URL}/function`, 50000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, context: { url: resolvedUrl } }),
    });
    if (!browserResponse.ok) throw new Error(`${COOKIE_PLATFORM_DEFINITIONS[platform].label}主页校验失败（浏览器 HTTP ${browserResponse.status}）`);
    const payload = await parseBrowserlessJson(browserResponse);
    const httpStatus = Number(payload?.httpStatus);
    if ([401, 403, 429].includes(httpStatus)) {
        throw Object.assign(new Error(`${COOKIE_PLATFORM_DEFINITIONS[platform].label}主页请求失败（HTTP ${httpStatus}）`), { httpStatus });
    }
    if (isLoginLikeUrl(payload?.currentUrl)) {
        throw Object.assign(new Error(`${COOKIE_PLATFORM_DEFINITIONS[platform].label}主页跳转到登录页`), { loginRedirect: true });
    }
    if (payload?.missing) throw Object.assign(new Error(`${COOKIE_PLATFORM_DEFINITIONS[platform].label}主页显示用户或内容不存在`), { empty: true, credentialVerified: true });
    if (httpStatus === 404) {
        throw Object.assign(new Error(`${COOKIE_PLATFORM_DEFINITIONS[platform].label}主页返回 HTTP 404；账号或内容链接已失效`), {
            empty: true,
            credentialVerified: true,
        });
    }
    if (httpStatus >= 400) throw new Error(`${COOKIE_PLATFORM_DEFINITIONS[platform].label}主页请求失败（HTTP ${httpStatus}）`);
}

async function fetchGenericBrowserFeed(platform, resolvedUrl, { cookieLease = null } = {}) {
    const cookies = cookieLease?.browserCookies?.() || [];
    if (!cookies.length && !PUBLIC_FALLBACK_PLATFORMS.has(platform)) {
        throw new Error(`没有找到可用的${COOKIE_PLATFORM_DEFINITIONS[platform].label} Cookie`);
    }
    const code = `module.exports = async ({ page, context }) => {
        const cookies = ${JSON.stringify(cookies)};
        if (cookies.length) await page.setCookie(...cookies);
        if (context.platform === 'dongchedi' || context.platform === 'zhihu' || context.platform === 'qctt') {
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9' });
            await page.evaluateOnNewDocument(() => {
                try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
            });
        }
        const responseCandidates = [];
        const responseLog = [];
        const pending = [];
        let httpStatus = 0;
        let knownEndpointEmpty = false;
        // 懂车帝先访问首页时会产生大量与作者无关的车型接口响应，不能混入作品候选。
        let captureResponses = context.platform !== 'dongchedi';
        const dateKeys = new Set(['datepublished','uploaddate','pubdate','publishtime','publish_time','publishtimestamp','publish_timestamp','publishedat','published_at','pubtime','pub_time','createtime','create_time','createdat','created_at','ctime','releasetime','release_time','release_time_format','formattime','format_time','newstime','news_time','updatetime','update_time','lastupdate','last_update','onlinetime','online_time','timestamp']);
        const titleKeys = ['title','title_new','video_name','name','desc','description','content','summary'];
        const urlKeys = ['url','link','href','share_url','shareurl','article_url','articleurl','play_url','playurl','pcplayurl','pc_play_url','url_html5'];
        const pick = (object, keys) => {
            for (const key of keys) {
                if (object && object[key] !== undefined && object[key] !== null && object[key] !== '') return object[key];
            }
            return '';
        };
        const walk = (value, depth = 0) => {
            if (!value || depth > 9 || responseCandidates.length >= 1000) return;
            if (Array.isArray(value)) {
                for (const entry of value.slice(0, 500)) walk(entry, depth + 1);
                return;
            }
            if (typeof value !== 'object') return;
            let date = '';
            for (const [key, entry] of Object.entries(value)) {
                if (dateKeys.has(String(key).toLowerCase()) && (typeof entry === 'string' || typeof entry === 'number')) {
                    date = entry;
                    break;
                }
            }
            if (date !== '') {
                const title = pick(value, titleKeys);
                const url = pick(value, urlKeys);
                if (title || url) responseCandidates.push({ date, title: typeof title === 'string' ? title : '', url: typeof url === 'string' ? url : '' });
            }
            for (const entry of Object.values(value)) walk(entry, depth + 1);
        };
        page.on('response', (response) => {
            const task = (async () => {
                if (!captureResponses) return;
                if (responseLog.length < 100) {
                    const rawUrl = String(response.url() || '');
                    const safeUrl = rawUrl.startsWith('data:') ? 'data:' : rawUrl.split(/[?#]/, 1)[0];
                    responseLog.push({ status: response.status(), url: safeUrl.slice(0, 500), type: String(response.headers()['content-type'] || '').slice(0, 120) });
                }
                let sameSite = false;
                try {
                    const targetHost = new URL(context.url).hostname.split('.').slice(-2).join('.');
                    sameSite = new URL(response.url()).hostname.endsWith(targetHost);
                } catch {}
                if (sameSite && [401, 403, 429].includes(response.status())) httpStatus = response.status();
                const contentType = response.headers()['content-type'] || '';
                const responseUrl = String(response.url() || '');
                const knownDataEndpoint = /\\/get_works\\.action|\\/episode_info\\.action|\\/pVideoTab|\\/home\\/list/i.test(responseUrl);
                if (knownDataEndpoint && response.status() === 204) knownEndpointEmpty = true;
                if ((!contentType.includes('json') && !knownDataEndpoint) || responseCandidates.length >= 1000) return;
                try {
                    // 部分作者主页会保持长连接；不能因某一条未结束的响应阻塞已渲染的作品日期。
                    const text = await Promise.race([
                        response.text(),
                        new Promise((resolve) => setTimeout(() => resolve(''), 5000)),
                    ]);
                    if (!text) return;
                    const data = JSON.parse(text);
                    walk(data);
                    if (/\\/get_works\\.action/i.test(responseUrl)) {
                        const flows = data?.data?.sort?.flows;
                        const total = Number(data?.data?.totalNum ?? data?.data?.sort?.totalNum ?? 0);
                        if (data?.code === 'A00000' && Array.isArray(flows) && flows.length === 0 && total <= 0) knownEndpointEmpty = true;
                    }
                } catch {}
            })();
            pending.push(task);
        });
        if (context.platform === 'dongchedi') captureResponses = true;
        // 懂车帝首页预热在无头环境经常阻塞且不会提高作者页成功率；直接读取作者页并快速分类。
        const navigationTimeout = context.platform === 'dongchedi' ? 8000 : 30000;
        const mainResponse = await page.goto(context.url, { waitUntil: 'domcontentloaded', timeout: navigationTimeout }).catch(() => null);
        if (mainResponse && [401, 403, 429].includes(mainResponse.status())) httpStatus = mainResponse.status();
        if (context.platform === 'dongchedi') {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            await page.evaluate(() => {
                const nodes = [...document.querySelectorAll('a,button,[role="tab"],[class*="tab"]')];
                const tab = nodes.find((node) => String(node.textContent || '').trim().includes('全部文章视频'));
                tab?.click();
            }).catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 1200));
        }
        if (context.platform === 'zhihu') {
            // 知乎个人页默认页可能只有个人资料；进入“动态”后才会加载作者最新内容与时间。
            await new Promise((resolve) => setTimeout(resolve, 1800));
            await page.evaluate(() => {
                const nodes = [...document.querySelectorAll('a,button,[role="tab"],[class*="tab"]')];
                const tab = nodes.find((node) => String(node.textContent || '').trim() === '动态');
                tab?.click();
            }).catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 2200));
        }
        if (context.platform === 'tencent_video' || context.platform === 'sohu_video') {
            await new Promise((resolve) => setTimeout(resolve, 1800));
            await page.evaluate((platform) => {
                const labels = platform === 'tencent_video' ? ['作品', '短视频'] : ['作品', '视频'];
                const nodes = [...document.querySelectorAll('a,button,[role="tab"],[class*="tab"]')];
                const target = nodes.find((node) => labels.includes(String(node.textContent || '').trim()));
                target?.click();
            }, context.platform).catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 2200));
        }
        if (context.platform === 'sohu_video') {
            const authorId = (context.url.match(/[?&]uid=([^&#]+)/) || [])[1] || '';
            const moduleUrl = await page.evaluate(() => performance.getEntriesByType('resource')
                .map((entry) => entry.name)
                .find((name) => /\\/uservideo-[^/]+\\.js/.test(name)) || '').catch(() => '');
            if (authorId && moduleUrl) {
                await page.evaluate(({ authorId, moduleUrl }) => {
                    window.__rsshubSohuVideo = { pending: true };
                    const script = document.createElement('script');
                    const quote = String.fromCharCode(34);
                    script.type = 'module';
                    script.textContent = 'import {u} from ' + quote + moduleUrl + quote
                        + ';u.getTaVideo({userId:' + quote + authorId + quote + ',opusType:0,num:20,uploadFrom:8})'
                        + '.then(r=>window.__rsshubSohuVideo={payload:r&&r.data})'
                        + '.catch(e=>window.__rsshubSohuVideo={error:String(e)});';
                    document.head.appendChild(script);
                }, { authorId, moduleUrl }).catch(() => {});
                await page.waitForFunction(() => window.__rsshubSohuVideo && !window.__rsshubSohuVideo.pending, { timeout: 15000 }).catch(() => {});
                const forcedPayload = await page.evaluate(() => window.__rsshubSohuVideo?.payload || null).catch(() => null);
                if (forcedPayload) {
                    walk(forcedPayload);
                    const feeds = forcedPayload?.data?.feeds;
                    if (forcedPayload?.status === 200 && Array.isArray(feeds) && feeds.length === 0) knownEndpointEmpty = true;
                }
            }
        }
        const scrollCount = context.platform === 'dongchedi' ? 5 : context.platform === 'zhihu' ? 6 : 3;
        for (let index = 0; index < scrollCount; index += 1) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, context.platform === 'dongchedi' ? 500 : 1200));
        }
        if (context.platform === 'dongchedi') {
            // 作者页常会保留统计请求；等它们结束会使单条无限延长。DOM 已渲染后最多再等一秒收集作品接口。
            await Promise.race([
                Promise.allSettled(pending),
                new Promise((resolve) => setTimeout(resolve, 1000)),
            ]);
        } else {
            await Promise.allSettled(pending);
        }
        const dom = await page.evaluate(() => {
            const candidates = [];
            const add = (date, node) => {
                const value = String(date || '').trim();
                if (!value || candidates.length >= 500) return;
                const card = node.closest('article,li,[class*="item"],[class*="card"],[class*="feed"],[class*="video"]') || node.parentElement;
                const anchor = card?.querySelector('a[href]') || node.closest('a[href]');
                const titleNode = card?.querySelector('[title],h1,h2,h3,h4,[class*="title"],[class*="desc"]');
                candidates.push({
                    date: value,
                    title: String(titleNode?.getAttribute('title') || titleNode?.textContent || anchor?.getAttribute('title') || '').trim(),
                    url: anchor?.href || '',
                });
            };
            for (const node of document.querySelectorAll('time,[datetime],[data-time],[data-timestamp],[data-publish-time],[class*="time"],[class*="date"]')) {
                add(node.getAttribute('datetime') || node.getAttribute('data-time') || node.getAttribute('data-timestamp') || node.getAttribute('data-publish-time') || node.textContent, node);
            }
            const dateTextPattern = new RegExp('(?:20[0-9]{2}[年/.-][0-9]{1,2}[月/.-][0-9]{1,2}|(?:今天|昨天) *[0-9]{1,2}:[0-9]{2}|[0-9]+(?:分钟|小时|天|周|个月|月|年)前)');
            for (const node of document.querySelectorAll('span,p')) {
                const text = String(node.textContent || '').trim();
                if (text.length <= 80 && dateTextPattern.test(text)) add(text, node);
            }
            for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
                try {
                    const roots = JSON.parse(script.textContent || 'null');
                    const queue = Array.isArray(roots) ? [...roots] : [roots];
                    while (queue.length && candidates.length < 500) {
                        const entry = queue.shift();
                        if (!entry || typeof entry !== 'object') continue;
                        const date = entry.datePublished || entry.uploadDate || entry.dateCreated;
                        if (date) candidates.push({ date, title: entry.headline || entry.name || '', url: entry.url || entry.mainEntityOfPage || '' });
                        for (const child of Object.values(entry)) if (child && typeof child === 'object') queue.push(...(Array.isArray(child) ? child : [child]));
                    }
                } catch {}
            }
            return { title: document.title || '', candidates };
        }).catch(() => ({ title: '', candidates: [] }));
        const currentUrl = page.url();
        const loginRedirect = /passport|login|signin|sso/i.test(currentUrl);
        const bodyText = await page.$eval('body', (body) => (body.innerText || '').slice(0, 3000)).catch(() => '');
        const verificationRequired = await page.evaluate(() => Boolean(
            window.runtime?.foe?.is_need_foe
            || window.__INITIAL_STATE__?.foe?.is_need_foe
            || window.__NEXT_DATA__?.props?.pageProps?.foe?.is_need_foe
        )).catch(() => false)
            || /安全验证|人机验证|完成验证|异常访问|访问过于频繁|验证码/.test([bodyText, dom.title].join(' '));
        const missing = /用户(?:信息)?不存在|账号不存在|内容不存在|页面不存在|已注销|那条视频不见了|该视频已下线/.test([bodyText, dom.title].join(' '));
        return { data: JSON.stringify({ title: dom.title, responseCandidates, domCandidates: dom.candidates, responseLog, httpStatus, loginRedirect, verificationRequired, knownEndpointEmpty, missing, currentUrl, bodyLength: bodyText.length }), type: 'application/json' };
    }`;
    // 懂车帝的页面加载可能长期悬挂；批量任务应在一个可控窗口内返回明确状态，
    // 不能让单条记录拖到调用方的总超时。
    const browserTimeout = platform === 'dongchedi' ? 23000 : 75000;
    const browserlessUrl = platform === 'dongchedi'
        ? `${BROWSERLESS_HTTP_URL}/function?timeout=18000`
        : `${BROWSERLESS_HTTP_URL}/function`;
    const browserResponse = await fetchWithTimeout(browserlessUrl, browserTimeout, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, context: { url: resolvedUrl, platform } }),
    });
    if (!browserResponse.ok) throw new Error(`${COOKIE_PLATFORM_DEFINITIONS[platform].label}主页读取失败（浏览器 HTTP ${browserResponse.status}）`);
    const payload = await parseBrowserlessJson(browserResponse);
    if (payload?.verificationRequired) {
        throw Object.assign(new Error(`${COOKIE_PLATFORM_DEFINITIONS[platform].label}触发人机验证；当前 Cookie 在 Docker 浏览器环境未获平台接受，并非直接判定为失效`), {
            httpStatus: 403,
            // 懂车帝会在页面加载后触发独立验证；换同一池里的 Cookie 只会重复等待，
            // 先保留 Cookie 状态并把环境拦截原样返回。
            ...(platform === 'dongchedi' ? { credentialVerified: true } : {}),
        });
    }
    if (platform === 'zhihu' && Number(payload?.httpStatus) === 403) {
        throw Object.assign(new Error('知乎页面被平台拦截（HTTP 403）；当前 Cookie 在 Docker 浏览器环境未获平台接受，并非直接判定为失效'), {
            httpStatus: 403,
            // 知乎会按无头浏览器环境直接返回 403，即使刚导出的登录
            // 会话仍有效。不要把这种环境拦截写成 Cookie 失效。
            credentialVerified: true,
        });
    }
    if (platform === 'qctt' && Number(payload?.httpStatus) === 403) {
        // 全车头条会拒绝当前 Browserless 指纹；这不是凭 403 就能判定的 Cookie 失效，
        // 也不应把同一平台的所有 Cookie 逐个标为失败。
        throw Object.assign(new Error('汽车头条页面被平台拦截（HTTP 403）；当前 Cookie 在 Docker 浏览器环境未获平台接受，并非直接判定为失效'), {
            httpStatus: 403,
            credentialVerified: true,
        });
    }
    if (platform === 'dongchedi' && payload?.loginRedirect) {
        throw Object.assign(new Error('懂车帝作者页跳转到登录页；当前 Cookie 在 Docker 浏览器环境未获平台接受，并非直接判定为失效'), {
            loginRedirect: true,
            credentialVerified: true,
        });
    }
    assertPlatformBrowserResult(payload, COOKIE_PLATFORM_DEFINITIONS[platform].label);
    if (payload?.missing) throw Object.assign(new Error(`${COOKIE_PLATFORM_DEFINITIONS[platform].label}主页显示用户或内容不存在`), { empty: true, credentialVerified: true });
    if (payload?.knownEndpointEmpty && !payload?.responseCandidates?.length && !payload?.domCandidates?.length) {
        throw Object.assign(new Error(`${COOKIE_PLATFORM_DEFINITIONS[platform].label}主页当前没有作品`), { empty: true, credentialVerified: true });
    }
    if (platform === 'cheshi') {
        try {
            const requestedPath = new URL(resolvedUrl).pathname;
            const currentPath = new URL(payload?.currentUrl || resolvedUrl).pathname;
            if (/^\/author\//i.test(requestedPath) && currentPath === '/') {
                throw Object.assign(new Error('网上车市作者链接已失效并跳转到平台首页'), { empty: true, credentialVerified: true });
            }
        } catch (error) {
            if (error?.empty) throw error;
        }
    }
    const feed = normalizeGenericFeed(payload, {
        platform: COOKIE_PLATFORM_DEFINITIONS[platform].label,
        profileUrl: resolvedUrl,
    });
    if (!feed.items.length) {
        console.warn('[generic-feed-empty]', JSON.stringify({
            platform,
            currentUrl: payload?.currentUrl || '',
            title: payload?.title || '',
            responseCandidates: payload?.responseCandidates?.length || 0,
            domCandidates: payload?.domCandidates?.length || 0,
            responseLog: payload?.responseLog || [],
            bodyLength: payload?.bodyLength || 0,
        }));
        throw Object.assign(new Error(`${COOKIE_PLATFORM_DEFINITIONS[platform].label}主页没有提取到明确作品发布时间`), {
            empty: true,
            credentialVerified: Number(payload?.bodyLength) > 100 && Boolean(payload?.title),
        });
    }
    return feed;
}

function isLoginLikeUrl(value) {
    try {
        const parsed = new URL(value);
        return /passport|account|login|signin|sso/i.test(parsed.hostname) || /\/(?:login(?:-required)?|signin|passport|sso)(?:\/|$)/i.test(parsed.pathname);
    } catch {
        return false;
    }
}

async function fetchRssHubXmlFeed(route, platform) {
    const parsedRoute = new URL(route, RSSHUB_BASE_URL);
    parsedRoute.searchParams.delete('format');
    const response = await fetchWithTimeout(parsedRoute.href, REQUEST_TIMEOUT_MS, {
        headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
    });
    const xml = await response.text();
    if (!response.ok) {
        if (response.status === 404) {
            throw Object.assign(new Error(`${platform}作品列表返回 HTTP 404；账号或内容链接已失效`), {
                empty: true,
                credentialVerified: true,
            });
        }
        throw new Error(`${platform}作品列表请求失败（HTTP ${response.status}）`);
    }
    return parseRssHubXmlFeed(xml);
}

async function fetchBaiduNewsUserFeed(resolvedUrl, { cookieLease = null } = {}) {
    const parsed = new URL(resolvedUrl);
    const appId = parsed.searchParams.get('app_id')
        || parsed.pathname.match(/^\/home\/(\d+)/i)?.[1]
        || '';
    let uk = parsed.searchParams.get('uk') || '';
    const cookie = cookieLease?.cookieHeader?.() || '';
    const headers = {
        ...(cookie ? { Cookie: cookie } : {}),
        Accept: 'text/html,application/xhtml+xml,application/json',
        Referer: resolvedUrl,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
    };

    if (!uk) {
        const profileResponse = await fetchWithTimeout(resolvedUrl, 30000, { redirect: 'follow', headers });
        if ([401, 403, 429].includes(profileResponse.status)) {
            throw Object.assign(new Error(`百度新闻主页请求失败（HTTP ${profileResponse.status}）；请更换 Cookie 后重试`), { httpStatus: profileResponse.status });
        }
        const profileHtml = await profileResponse.text();
        uk = profileHtml.match(/["']uk["']\s*:\s*["']([^"']+)["']/i)?.[1] || '';
    }
    if (!uk) {
        throw Object.assign(new Error('百度新闻主页没有找到用户 UK；链接可能已失效'), { empty: true, credentialVerified: true });
    }

    const metadataUrl = `https://mbd.baidu.com/webpage?${new URLSearchParams({
        type: 'homepage',
        action: 'home',
        format: 'json',
        uk,
    })}`;
    const metadataResponse = await fetchWithTimeout(metadataUrl, 30000, {
        headers: { ...headers, Accept: 'application/json, text/plain, */*' },
    });
    if ([401, 403, 429].includes(metadataResponse.status)) {
        throw Object.assign(new Error(`百度新闻用户接口请求失败（HTTP ${metadataResponse.status}）；请更换 Cookie 后重试`), { httpStatus: metadataResponse.status });
    }
    if (!metadataResponse.ok) throw new Error(`百度新闻用户接口请求失败（HTTP ${metadataResponse.status}）`);
    const metadata = await metadataResponse.json().catch(() => null);
    const user = metadata?.data?.user;
    if (Number(metadata?.errno) !== 0 || !user) {
        throw Object.assign(new Error(`百度新闻用户不存在或主页已失效：${metadata?.errmsg || metadata?.errno || '空响应'}`), {
            empty: true,
            credentialVerified: true,
        });
    }

    const contentCount = Number(user?.content_num ?? user?.contentNum?.count ?? 0);
    if (contentCount <= 0) {
        throw Object.assign(new Error('百度新闻主页当前没有作品'), { empty: true, credentialVerified: true });
    }

    const canonicalUrl = String(user?.home_url || (appId ? `https://author.baidu.com/home/${appId}` : resolvedUrl));
    try {
        return await fetchGenericBrowserFeed('baijiahao', canonicalUrl, { cookieLease });
    } catch (error) {
        if (error?.httpStatus === 403 || error?.loginRedirect) {
            error.message = `百度新闻官方元数据确认主页有 ${contentCount} 条作品，但作品列表触发人机验证或 Cookie 风控；请更换 Cookie 后重试`;
            throw error;
        }
        throw Object.assign(new Error(`百度新闻官方元数据确认主页有 ${contentCount} 条作品，但作品列表未加载，属于百度人机验证或 Cookie 风控；请更换 Cookie 后重试`), {
            httpStatus: 403,
            loginRedirect: true,
        });
    }
}

async function fetchTencentNewsUserFeed(resolvedUrl, { cookieLease = null } = {}) {
    const cookie = cookieLease?.cookieHeader?.() || '';
    const headers = {
        ...(cookie ? { Cookie: cookie } : {}),
        Referer: resolvedUrl,
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
    };
    let effectiveUrl = resolvedUrl;
    let suid = new URL(effectiveUrl).pathname.match(/^\/u\/([^/?#]+)/i)?.[1] || '';
    if (!suid && /^\/media\/[^/?#]+/i.test(new URL(effectiveUrl).pathname)) {
        const redirectResponse = await fetchWithTimeout(effectiveUrl, 30000, { redirect: 'follow', headers });
        if (!redirectResponse.ok) throw new Error(`腾讯新闻旧主页跳转失败（HTTP ${redirectResponse.status}）`);
        effectiveUrl = redirectResponse.url || effectiveUrl;
        suid = new URL(effectiveUrl).pathname.match(/^\/u\/([^/?#]+)/i)?.[1] || '';
    }
    if (!suid) throw Object.assign(new Error('腾讯新闻主页没有找到用户 SUID；旧链接可能已失效'), { empty: true, credentialVerified: true });
    headers.Referer = effectiveUrl;
    const common = {
        guestSuid: decodeURIComponent(suid),
        appver: '15.6_qqnews_7.7.70',
        from_scene: '100',
    };
    const profileResponse = await fetchWithTimeout(`https://r.inews.qq.com/i/getUserHomepageInfo?${new URLSearchParams(common)}`, 25000, { headers });
    if ([401, 403, 429].includes(profileResponse.status)) {
        throw Object.assign(new Error(`腾讯新闻主页接口请求失败（HTTP ${profileResponse.status}）`), { httpStatus: profileResponse.status });
    }
    if (!profileResponse.ok) throw new Error(`腾讯新闻主页接口请求失败（HTTP ${profileResponse.status}）`);
    const profilePayload = await profileResponse.json().catch(() => null);
    if (Number(profilePayload?.ret) !== 0 || !profilePayload?.userinfo) {
        throw new Error(`腾讯新闻主页接口返回异常：${profilePayload?.errmsg || profilePayload?.info || profilePayload?.ret || '空响应'}`);
    }

    const user = profilePayload.userinfo;
    const configuredTabs = Array.isArray(user?.channel_config?.channel_list)
        ? user.channel_config.channel_list.map((entry) => entry?.channel_id).filter((id) => /^share_page_(?:index|article|video)$/.test(id))
        : [];
    const tabs = configuredTabs.length ? [...new Set(configuredTabs)] : ['share_page_index', 'share_page_article', 'share_page_video'];
    // pubnum 在旧主页和视频主页上经常为 0，但作品接口仍可能返回数据。
    // 同时某个分类页失败不能让其他分类页的可用作品一起丢失。
    const settledPayloads = await Promise.allSettled(tabs.map(async (tabId) => {
        const query = new URLSearchParams({ ...common, tabId, offset_info: '', caller: '1' });
        const response = await fetchWithTimeout(`https://r.inews.qq.com/share/getSubNewsMixedList?${query}`, 25000, { headers });
        if ([401, 403, 429].includes(response.status)) {
            throw Object.assign(new Error(`腾讯新闻作品接口请求失败（HTTP ${response.status}）`), { httpStatus: response.status });
        }
        if (!response.ok) throw new Error(`腾讯新闻作品接口请求失败（HTTP ${response.status}）`);
        return response.json().catch(() => null);
    }));
    const listPayloads = settledPayloads
        .filter((entry) => entry.status === 'fulfilled')
        .map((entry) => entry.value);
    const feed = normalizeTencentNewsFeed(profilePayload, listPayloads);
    if (!feed.items.length) {
        try {
            // 官方作品接口在部分历史账号上返回空数组；再从已登录的主页 DOM 读取一次。
            return await fetchGenericBrowserFeed('tencent_news', effectiveUrl, { cookieLease });
        } catch (browserError) {
            const profileHint = Number(user?.pubnum ?? 0) > 0 ? '主页有作品' : '主页未返回作品计数';
            browserError.message = `腾讯新闻${profileHint}，官方接口未返回可识别发布时间；浏览器回退也失败：${cleanError(browserError)}`;
            browserError.credentialVerified = true;
            throw browserError;
        }
    }
    return feed;
}

async function fetchQcttUserFeed(resolvedUrl) {
    const authorId = new URL(resolvedUrl).pathname.match(/^\/author\/(\d+)/i)?.[1] || '';
    if (!authorId) {
        throw Object.assign(new Error('汽车头条主页没有找到作者 ID；链接可能已失效'), { empty: true, credentialVerified: true });
    }
    const mobileProfileUrl = `https://m.qctt.cn/author/${encodeURIComponent(authorId)}/1`;
    const headers = {
        Referer: mobileProfileUrl,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept-Language': 'zh-CN,zh;q=0.9',
    };
    const responses = await Promise.allSettled(['1', '2', '3'].map(async (type) => {
        const query = new URLSearchParams({ type, page: '1', author_id: authorId });
        const response = await fetchWithTimeout(`https://m.qctt.cn/getAuthorNewsList?${query}`, 25000, { headers });
        if ([401, 403, 429].includes(response.status)) {
            throw Object.assign(new Error(`汽车头条移动作品接口请求失败（HTTP ${response.status}）`), { httpStatus: response.status });
        }
        if (!response.ok) throw new Error(`汽车头条移动作品接口请求失败（HTTP ${response.status}）`);
        const payload = await response.json().catch(() => null);
        if (Number(payload?.code) !== 400 || !Array.isArray(payload?.data)) {
            throw new Error(`汽车头条移动作品接口返回异常：${payload?.message || payload?.code || '空响应'}`);
        }
        return payload.data;
    }));
    const rows = responses
        .filter((entry) => entry.status === 'fulfilled')
        .flatMap((entry) => entry.value);
    const feed = normalizeGenericFeed({
        title: '汽车头条作者',
        responseCandidates: rows.map((item) => ({
            date: item?.publishTime ?? item?.publish_time,
            title: item?.title || item?.origin || '',
            url: item?.url || item?.sourceId ? `https://m.qctt.cn${item?.url || `/news/${item.sourceId}`}` : '',
        })),
    }, { platform: '汽车头条', profileUrl: mobileProfileUrl });
    if (feed.items.length) return feed;
    const rejected = responses.find((entry) => entry.status === 'rejected');
    if (rejected) throw rejected.reason;
    throw Object.assign(new Error('汽车头条主页当前没有作品'), { empty: true, credentialVerified: true });
}

async function fetchTencentVideoUserFeed(resolvedUrl, { cookieLease = null } = {}) {
    const parsed = new URL(resolvedUrl);
    const profileMatch = parsed.pathname.match(/^\/s\/videoplus\/([^/?#]+)(?:\/(2))?\/?$/i);
    if (!profileMatch) {
        return fetchGenericBrowserFeed('tencent_video', resolvedUrl, { cookieLease });
    }

    const profileId = profileMatch[1];
    const scene = profileMatch[2] === '2' ? '2' : '1';
    const headers = {
        Referer: resolvedUrl,
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
    };
    const requestJson = async (url, body, label) => {
        const response = await fetchWithTimeout(url, 30000, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        if ([401, 403, 429].includes(response.status)) {
            throw Object.assign(new Error(`腾讯视频${label}请求失败（HTTP ${response.status}）`), { httpStatus: response.status });
        }
        if (!response.ok) throw new Error(`腾讯视频${label}请求失败（HTTP ${response.status}）`);
        const payload = await response.json().catch(() => null);
        if (!payload || Number(payload.ret) !== 0 || Number(payload?.data?.error_code || 0) !== 0) {
            throw new Error(`腾讯视频${label}返回异常：${payload?.msg || payload?.data?.error_code || payload?.ret || '空响应'}`);
        }
        return payload;
    };

    const navUrl = 'https://pbaccess.video.qq.com/com.tencent.qqlive.protocol.pb.NavOperateService/getNavOperate?video_appid=1000005&vplatform=3&vversion_name=8.11.50.0';
    const navPayload = await requestJson(navUrl, {
        page_params: {
            page_type: 'new_community_pp_nav',
            ...(scene === '2' ? { vcuid: profileId } : { vuid: profileId }),
            scene,
            http_request: 'true',
        },
    }, '主页导航接口');
    const tabs = Array.isArray(navPayload?.data?.tab_module_list?.tab_modules)
        ? navPayload.data.tab_module_list.tab_modules
        : [];
    const tab = tabs.find((entry) => entry?.tab_id === 'works_new')
        || tabs.find((entry) => entry?.tab_id === 'personal_update');
    if (!tab?.page_params || Number(tab?.number_info || 0) <= 0) {
        throw Object.assign(new Error('腾讯视频主页当前没有作品'), { empty: true, credentialVerified: true });
    }

    const dataUrl = 'https://pbaccess.video.qq.com/trpc.universal_backend_service.page_server_rpc.PageServer/GetPageData?video_appid=1000005&vplatform=3&vversion_name=8.11.50.0&video_omgid=';
    const dataPayload = await requestJson(dataUrl, {
        page_context: {},
        page_params: tab.page_params,
        has_cache: 0,
    }, '作品接口');
    const feed = normalizeTencentVideoFeed(dataPayload, { profileUrl: resolvedUrl });
    if (!feed.items.length) {
        throw Object.assign(new Error('腾讯视频主页有作品，但官方接口没有返回可识别的发布时间'), { empty: true, credentialVerified: true });
    }
    return feed;
}

async function fetchIfengAuthorFeed(docRoute) {
    const authorId = String(docRoute || '').match(/^\/ifeng\/feng\/([^/?#]+)/)?.[1];
    if (!authorId) throw new Error('凤凰新闻主页中没有找到作者 ID');
    const responses = await Promise.all(['doc', 'video'].map(async (type) => {
        const url = `https://shankapi.ifeng.com/season/ishare/getShareListData/${encodeURIComponent(authorId)}/${type}/1/ifengnewsh5/getListData`;
        const response = await fetchWithTimeout(url, 25000, {
            headers: {
                Referer: `https://feng.ifeng.com/author/${encodeURIComponent(authorId)}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
            },
        });
        if (!response.ok) throw new Error(`凤凰新闻作品接口请求失败（HTTP ${response.status}）`);
        return response.text();
    }));
    const feed = normalizeIfengFeed(responses, { authorId });
    if (!feed.items.length) {
        throw Object.assign(new Error('凤凰新闻主页当前没有作品'), { empty: true, credentialVerified: true });
    }
    return feed;
}

async function fetchYicheUserFeed(resolvedUrl, { cookieLease = null } = {}) {
    const cookie = cookieLease?.cookieHeader?.() || '';
    const response = await fetchWithTimeout(resolvedUrl, 35000, {
        redirect: 'follow',
        headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
        },
    });
    if ([401, 403, 429].includes(response.status)) {
        throw Object.assign(new Error(`易车主页请求失败（HTTP ${response.status}）`), { httpStatus: response.status });
    }
    if (!response.ok) throw new Error(`易车主页请求失败（HTTP ${response.status}）`);
    const html = await response.text();
    const feed = parseYicheProfileHtml(html, response.url || resolvedUrl);
    if (!feed.items.length) {
        throw Object.assign(new Error('易车主页没有提取到明确作品发布时间'), {
            empty: true,
            credentialVerified: html.length > 1000,
        });
    }
    return feed;
}

async function fetchAutohomeUserFeed(resolvedUrl, { cookieLease = null } = {}) {
    const target = new URL(resolvedUrl);
    if (target.hostname.toLowerCase() === 'chejiahao.m.autohome.com.cn') target.protocol = 'http:';
    const cookie = cookieLease?.cookieHeader?.() || '';
    const response = await fetchWithTimeout(target.href, 35000, {
        redirect: 'follow',
        headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
        },
    });
    if ([401, 403, 429].includes(response.status)) {
        throw Object.assign(new Error(`汽车之家主页请求失败（HTTP ${response.status}）`), { httpStatus: response.status });
    }
    if (!response.ok) throw new Error(`汽车之家主页请求失败（HTTP ${response.status}）`);
    const html = await response.text();
    const feed = parseAutohomeProfileHtml(html, response.url || target.href);
    if (!feed.items.length) {
        throw Object.assign(new Error('汽车之家主页没有提取到明确作品发布时间'), {
            empty: true,
            credentialVerified: html.length > 1000,
        });
    }
    return feed;
}

async function fetchVideo56UserFeed(profileUrl, { cookieLease = null } = {}) {
    const cookie = cookieLease?.cookieHeader?.() || '';
    const headers = {
        ...(cookie ? { Cookie: cookie } : {}),
        Referer: profileUrl,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
    };
    const response = await fetchWithTimeout(profileUrl, 30000, { redirect: 'follow', headers });
    if ([401, 403, 429].includes(response.status)) {
        throw Object.assign(new Error(`56视频主页请求失败（HTTP ${response.status}）`), { httpStatus: response.status });
    }
    if (!response.ok) throw new Error(`56视频主页请求失败（HTTP ${response.status}）`);
    if (isLoginLikeUrl(response.url)) throw Object.assign(new Error('56视频主页跳转到登录页'), { loginRedirect: true });
    const html = await response.text();
    const workLinks = extractVideo56WorkLinks(html, 12);
    if (!workLinks.length) throw Object.assign(new Error('56视频主页没有找到作品链接'), { empty: true });

    const items = [];
    for (let offset = 0; offset < workLinks.length; offset += 4) {
        const batch = await Promise.allSettled(workLinks.slice(offset, offset + 4).map(async (url) => {
            const detailResponse = await fetchWithTimeout(url, 25000, { redirect: 'follow', headers });
            if (!detailResponse.ok) return null;
            return parseVideo56WorkHtml(await detailResponse.text(), detailResponse.url || url);
        }));
        for (const result of batch) {
            if (result.status === 'fulfilled' && result.value) items.push(result.value);
        }
    }
    if (!items.length) throw Object.assign(new Error('56视频作品页没有提取到明确发布时间'), { empty: true });
    const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, '').trim() || '56视频用户';
    return { title, items };
}

async function fetchIqiyiUserFeed(uid, { cookieLease = null } = {}) {
    const cookies = cookieLease?.browserCookies?.() || [];
    const cookieMap = Object.fromEntries(cookies.map((cookie) => [cookie.name, cookie.value]));
    if (!cookieMap.QC006) {
        throw Object.assign(new Error('爱奇艺 Cookie 缺少 QC006 设备标识；请重新导出完整 Cookie'), { loginRedirect: true, credentialFailure: true });
    }
    const cookieHeader = cookieLease?.cookieHeader?.() || '';
    const request = async (path, extra) => {
        const params = {
            authcookie: cookieMap.P00001 || '',
            agenttype: 118,
            agentversion: '10.7.5',
            timestamp: Date.now(),
            m_device_id: cookieMap.QC006,
            ...(cookieMap.dfp ? { dfp: cookieMap.dfp } : {}),
            ...extra,
        };
        const signingUrl = `iqiyihao.iqiyi.com${path}`;
        const canonical = Object.keys(params)
            .filter((key) => params[key] !== undefined && params[key] !== null)
            .sort()
            .map((key) => `${key}=${params[key]}`)
            .join('&');
        params.sign = createHash('md5').update(`GET${signingUrl}?${canonical}NZrFGv72GYppTUxO`).digest('hex');
        const response = await fetchWithTimeout(`https://iqiyihao.iqiyi.com${path}?${new URLSearchParams(params)}`, 30000, {
            headers: {
                Cookie: cookieHeader,
                Referer: `https://www.iqiyi.com/u/${uid}/videos`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
            },
        });
        if ([401, 403, 429].includes(response.status)) {
            throw Object.assign(new Error(`爱奇艺作品接口请求失败（HTTP ${response.status}）`), { httpStatus: response.status });
        }
        if (!response.ok) throw new Error(`爱奇艺作品接口请求失败（HTTP ${response.status}）`);
        const payload = await response.json().catch(() => null);
        if (payload?.code === 'A00102') {
            throw Object.assign(new Error('爱奇艺 Cookie 设备标识无效；请重新导出完整 Cookie'), { loginRedirect: true, credentialFailure: true });
        }
        if (payload?.code !== 'A00000') throw new Error(`爱奇艺作品接口返回异常：${payload?.msg || payload?.code || '未知错误'}`);
        return payload;
    };
    const browserFallback = async (reason) => {
        const profileUrl = `https://www.iqiyi.com/u/${encodeURIComponent(uid)}/videos`;
        try {
            return await fetchGenericBrowserFeed('iqiyi', profileUrl, { cookieLease });
        } catch (error) {
            error.message = `${reason}；浏览器回退也失败：${cleanError(error)}`;
            throw error;
        }
    };

    const works = await request('/iqiyihao/entity/get_works.action', { fuid: uid, page: 1, size: 28 });
    const flows = Array.isArray(works?.data?.sort?.flows) ? [...works.data.sort.flows] : [];
    const representative = works?.data?.sort?.reprentativeWork;
    if (representative?.qipuId && !flows.some((flow) => String(flow?.qipuId) === String(representative.qipuId))) flows.unshift(representative);
    const ids = flows.map((flow) => String(flow?.qipuId ?? '')).filter(Boolean);
    if (!ids.length) return browserFallback('爱奇艺官方接口没有返回作品');
    const detail = await request('/iqiyihao/episode_info.action', { qipuIds: ids.join(',') });
    const feed = normalizeIqiyiFeed({ data: { sort: { flows } } }, detail);
    if (!feed.items.some((item) => item.date_published)) {
        return browserFallback('爱奇艺作品接口没有返回明确发布时间');
    }
    return feed;
}

export function parseRssHubXmlFeed(xml) {
    const channelTitle = readXmlTag(xml.slice(0, xml.indexOf('<item>') >= 0 ? xml.indexOf('<item>') : xml.length), 'title');
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => ({
        title: readXmlTag(match[1], 'title'),
        url: readXmlTag(match[1], 'link') || readXmlTag(match[1], 'guid'),
        date_published: readXmlTag(match[1], 'pubDate'),
    }));
    return { title: channelTitle, items };
}

function readXmlTag(xml, tag) {
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(xml || '').match(new RegExp(`<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`, 'i'));
    if (!match) return '';
    return match[1]
        .replace(/^<!\[CDATA\[|\]\]>$/g, '')
        .replaceAll('&amp;', '&')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .trim();
}

async function fetchDouyinUserFeed(secUid, { cookieLease = null } = {}) {
    let directError = null;
    try {
        const directPayload = await fetchDouyinUserFeedDirect(secUid, { cookieLease });
        if (directPayload?.items?.length) {
            return formatDouyinFeed(directPayload);
        }
    } catch (error) {
        directError = error;
        console.warn('[douyin-feed-direct-fallback]', JSON.stringify({ secUid, error: cleanError(error) }));
    }

    const failedAttempts = [];
    const result = await retryDouyinFeedFetch(
        () => fetchDouyinUserFeedAttempt(secUid, { cookieLease }),
        {
            maxAttempts: 2,
            onRetry: async ({ attempt, payload, error }) => {
                const diagnostic = {
                    attempt,
                    responses: payload?.attempts || [],
                    error: error ? cleanError(error) : '',
                };
                failedAttempts.push(diagnostic);
                console.warn('[douyin-feed-retry]', JSON.stringify({ secUid, ...diagnostic }));
                await new Promise((resolve) => setTimeout(resolve, 750));
            },
        },
    );

    const payload = result.payload;
    if (!payload?.items?.length) {
        console.error('[douyin-feed-empty]', JSON.stringify({ secUid, attemptsUsed: result.attemptsUsed, failedAttempts, finalResponses: payload?.attempts || [] }));
        if (result.error) {
            throw result.error;
        }
        if (directError && classifyCookieFailure(directError).failover) throw directError;
        throw new Error('抖音主页作品接口连续两次没有返回数据；可能触发临时风控，请稍后重试');
    }

    return formatDouyinFeed(payload);
}

function formatDouyinFeed(payload) {
    return {
        title: payload.nickname || '抖音用户',
        items: payload.items.map((item) => ({
            title: item.title,
            url: `https://www.douyin.com/video/${item.id}`,
            date_published: new Date(Number(item.timestamp) * 1000).toISOString(),
        })),
    };
}

async function fetchDouyinUserFeedDirect(secUid, { cookieLease = null } = {}) {
    const cookie = cookieLease ? cookieLease.cookieHeader() : await loadCookieHeader(DOUYIN_COOKIE_FILE, 'douyin.com');
    if (!cookie) {
        throw new Error('没有找到可用的抖音 Cookie');
    }
    const query = new URLSearchParams({
        sec_user_id: secUid,
        count: '18',
        max_cursor: '0',
        aid: '6383',
        device_platform: 'webapp',
    });
    const response = await fetchWithTimeout(`https://www.douyin.com/aweme/v1/web/aweme/post/?${query}`, 25000, {
        headers: {
            Cookie: cookie,
            Referer: `https://www.douyin.com/user/${secUid}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
        },
    });
    const payload = await response.json().catch(() => null);
    if (isDouyinLoginUrl(response.url) || !response.ok || payload?.status_code !== 0) {
        throw douyinHttpError(`抖音主页作品接口请求失败（HTTP ${response.status}）`, response);
    }
    return {
        nickname: payload?.aweme_list?.[0]?.author?.nickname || '',
        items: (Array.isArray(payload?.aweme_list) ? payload.aweme_list : []).map((item) => ({
            id: item.aweme_id,
            title: item.desc || '',
            timestamp: item.create_time,
        })),
        attempts: [{ status: response.status, length: Array.isArray(payload?.aweme_list) ? payload.aweme_list.length : 0 }],
    };
}

async function fetchDouyinUserFeedAttempt(secUid, { cookieLease = null } = {}) {
    const cookies = cookieLease ? cookieLease.browserCookies() : await loadBrowserCookies(DOUYIN_COOKIE_FILE, 'douyin.com');
    if (!cookies.length) {
        throw new Error('没有找到可用的抖音 Cookie');
    }

    const code = `module.exports = async ({ page, context }) => {
        const cookies = ${JSON.stringify(cookies)};
        if (cookies.length) await page.setCookie(...cookies);
        let resolveItems;
        const attempts = [];
        const itemPromise = new Promise((resolve) => { resolveItems = resolve; });
        page.on('response', async (response) => {
            if (!response.url().includes('/web/aweme/post')) return;
            try {
                const text = await response.text();
                attempts.push({ status: response.status(), length: text.length });
                if (!text) return;
                if ([401, 403, 429].includes(response.status())) {
                    resolveItems({ items: [], attempts, httpStatus: response.status() });
                    return;
                }
                const data = JSON.parse(text);
                if (data?.aweme_list?.length) {
                    resolveItems({
                        nickname: data.aweme_list[0]?.author?.nickname || '',
                        items: data.aweme_list.map((item) => ({
                            id: item.aweme_id,
                            title: item.desc || '',
                            timestamp: item.create_time,
                        })),
                        attempts,
                    });
                }
            } catch (error) {
                attempts.push({ error: String(error) });
            }
        });
        await page.goto(context.url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        const loginRedirect = /passport\\.douyin\\.com|\\/(?:login|passport)(?:\\/|$)/i.test(page.url());
        const injected = await page.evaluate(async (secUid) => {
            const query = new URLSearchParams({
                sec_user_id: secUid,
                count: '18',
                max_cursor: '0',
                aid: '6383',
                device_platform: 'webapp',
                cookie_enabled: 'true',
            });
            const request = fetch('/aweme/v1/web/aweme/post/?' + query, {
                credentials: 'include',
                headers: { Accept: 'application/json, text/plain, */*' },
            }).then(async (response) => ({ status: response.status, text: await response.text() }));
            return Promise.race([
                request,
                new Promise((resolve) => setTimeout(() => resolve({ status: 0, text: '' }), 15000)),
            ]);
        }, context.secUid).catch(() => ({ status: 0, text: '' }));
        if (injected.status || injected.text) attempts.push({ status: injected.status, length: injected.text.length, source: 'injected' });
        if ([401, 403, 429].includes(injected.status)) {
            return { data: JSON.stringify({ items: [], attempts, httpStatus: injected.status, loginRedirect }), type: 'application/json' };
        }
        if (injected.text) {
            try {
                const data = JSON.parse(injected.text);
                if (data?.aweme_list?.length) {
                    return { data: JSON.stringify({
                        nickname: data.aweme_list[0]?.author?.nickname || '',
                        items: data.aweme_list.map((item) => ({
                            id: item.aweme_id,
                            title: item.desc || '',
                            timestamp: item.create_time,
                        })),
                        attempts,
                        loginRedirect,
                    }), type: 'application/json' };
                }
                if (data?.status_code === 0 && Array.isArray(data?.aweme_list)) {
                    return { data: JSON.stringify({ items: [], attempts, loginRedirect, emptyFeed: true }), type: 'application/json' };
                }
            } catch {}
        }
        const result = await Promise.race([
            itemPromise,
            new Promise((resolve) => setTimeout(() => resolve({ items: [], attempts }), 25000)),
        ]);
        return { data: JSON.stringify({ ...result, loginRedirect }), type: 'application/json' };
    }`;

    const browserResponse = await fetchWithTimeout(`${BROWSERLESS_HTTP_URL}/function`, 50000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            code,
            context: { url: `https://www.douyin.com/user/${secUid}`, secUid },
        }),
    });
    if (!browserResponse.ok) {
        throw new Error(`抖音主页读取失败（浏览器 HTTP ${browserResponse.status}）`);
    }

    let payload = await browserResponse.json();
    if (typeof payload === 'string') {
        payload = JSON.parse(payload);
    }
    if (payload?.loginRedirect) {
        throw Object.assign(new Error('抖音主页跳转到登录页'), { loginRedirect: true });
    }
    if ([401, 403, 429].includes(Number(payload?.httpStatus))) {
        throw Object.assign(new Error(`抖音主页作品接口请求失败（HTTP ${payload.httpStatus}）`), { httpStatus: Number(payload.httpStatus) });
    }
    return payload;
}

async function loadBrowserCookies(filePath, domain) {
    let source;
    try {
        source = JSON.parse(await readFile(filePath, 'utf8'));
    } catch {
        return [];
    }
    const sameSiteMap = { lax: 'Lax', strict: 'Strict', no_restriction: 'None' };
    return (Array.isArray(source) ? source : [])
        .filter((cookie) => String(cookie?.domain || '').includes(domain) && isCookieUsable(cookie))
        .map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path || '/',
            httpOnly: Boolean(cookie.httpOnly),
            secure: Boolean(cookie.secure),
            ...(cookie.expirationDate ? { expires: Math.floor(cookie.expirationDate) } : {}),
            ...(sameSiteMap[cookie.sameSite] ? { sameSite: sameSiteMap[cookie.sameSite] } : {}),
        }));
}

async function loadCookieHeader(filePath, domain) {
    let source;
    try {
        source = JSON.parse(await readFile(filePath, 'utf8'));
    } catch {
        return '';
    }
    return (Array.isArray(source) ? source : [])
        .filter((cookie) => String(cookie?.domain || '').includes(domain) && isCookieUsable(cookie))
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join('; ');
}

async function proxyToRssHub(request, requestUrl, response) {
    if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
        sendJson(response, 405, { ok: false, error: '只支持 GET 和 HEAD 请求' });
        return;
    }
    const target = `${RSSHUB_BASE_URL}${requestUrl.pathname}${requestUrl.search}`;
    const backend = await fetchWithTimeout(target, REQUEST_TIMEOUT_MS, {
        method: request.method,
        headers: {
            Accept: request.headers.accept || '*/*',
            'User-Agent': request.headers['user-agent'] || 'RSSHub-Visual-Console/1.0',
        },
    });
    const headers = {};
    for (const name of ['content-type', 'cache-control', 'etag', 'last-modified']) {
        const value = backend.headers.get(name);
        if (value) headers[name] = value;
    }
    response.writeHead(backend.status, headers);
    if (request.method === 'HEAD') {
        response.end();
        return;
    }
    response.end(Buffer.from(await backend.arrayBuffer()));
}

async function fetchWithTimeout(url, timeout, options = {}) {
    const signal = AbortSignal.timeout(timeout);
    return fetch(url, { ...options, signal });
}

function cleanError(error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        return '请求超时，平台可能触发风控或浏览器仍在加载';
    }
    return toErrorMessage(error?.message || error || '未知错误').replace(/<[^>]*>/g, '').slice(0, 500);
}

function toErrorMessage(value) {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function sendJson(response, status, payload) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(payload));
}

async function readJsonBody(request, maxBytes) {
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        throw Object.assign(new Error('Content-Type must be application/json'), { code: 'UNSUPPORTED_MEDIA_TYPE' });
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBytes) {
            throw Object.assign(new Error('Request body is too large'), { code: 'IMPORT_TOO_LARGE' });
        }
        chunks.push(chunk);
    }
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid object');
        return parsed;
    } catch {
        throw Object.assign(new Error('Request body is not valid JSON'), { code: 'INVALID_JSON' });
    }
}

function sendCookieApiError(response, error) {
    const statusByCode = {
        COOKIE_NOT_FOUND: 404,
        DUPLICATE_COOKIE: 409,
        RESTORE_CONFLICT: 409,
        IMPORT_TOO_LARGE: 413,
        UNSUPPORTED_MEDIA_TYPE: 415,
    };
    const status = statusByCode[error?.code] || 400;
    sendJson(response, status, {
        ok: false,
        code: error?.code || 'COOKIE_API_ERROR',
        error: cleanError(error),
    });
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
    const cookieRootDir = process.env.COOKIE_ROOT_DIR || dirname(DOUYIN_COOKIE_FILE);
    const cookiePool = await new CookiePool({ rootDir: cookieRootDir }).init();
    const rescanTimer = setInterval(() => cookiePool.rescan().catch(() => {}), 5000);
    rescanTimer.unref();
    const server = createAppServer({ cookiePool });
    server.listen(UI_PORT, '0.0.0.0', () => {
        console.log(`RSSHub Visual Console listening on ${UI_PORT}`);
    });
}
