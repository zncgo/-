const SUPPORTED_SHORT_HOSTS = new Set([
    'v.douyin.com',
    'xhslink.com',
    'www.xhslink.com',
    'xhslink.cn',
    'www.xhslink.cn',
    'v.kuaishou.com',
    'b23.tv',
    't.cn',
    '163.lu',
    'athm.cn',
    'dcd.zjbyte.cn',
    'v.ixigua.com',
]);

const SHORT_LINK_PLATFORM_BY_HOST = new Map([
    ['v.douyin.com', '抖音'],
    ['xhslink.com', '小红书'],
    ['www.xhslink.com', '小红书'],
    ['xhslink.cn', '小红书'],
    ['www.xhslink.cn', '小红书'],
    ['v.kuaishou.com', '快手'],
    ['b23.tv', 'B站'],
    ['t.cn', '微博'],
    ['163.lu', '网易新闻'],
    ['athm.cn', '汽车之家'],
    ['dcd.zjbyte.cn', '懂车帝'],
    ['v.ixigua.com', '西瓜视频'],
]);

const DIRECT_ROUTE_PREFIXES = [
    '/douyin/', '/xiaohongshu/', '/kuaishou/', '/bilibili/', '/weibo/', '/zhihu/', '/toutiao/', '/netease/', '/dongchedi/', '/yidian/', '/ucdayu/', '/sohu_news/', '/tencent_news/', '/ifeng/', '/baijiahao/', '/autohome/', '/xcar/', '/qctt/', '/pcauto/', '/cheshi/', '/yiche/', '/iqiyi/', '/youku/', '/tencent_video/', '/meipai/', '/sohu_video/', '/video56/', '/miaopai/', '/ixigua/',
];

function isDomain(host, domain) {
    return host === domain || host.endsWith(`.${domain}`);
}

function isDouyinDomain(host) {
    return isDomain(host, 'douyin.com') || isDomain(host, 'iesdouyin.com');
}

export function extractUrl(value) {
    const input = String(value ?? '').trim();
    const matched = input.match(/https?:\/\/[^\s<>"']+/i);
    const candidate = matched?.[0] ?? (input.startsWith('/') ? input : '');
    return candidate.replace(/[，。；、,)\]}]+$/u, '');
}

export function needsRedirectResolution(value) {
    try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase();
        return SUPPORTED_SHORT_HOSTS.has(host) || (isDomain(host, 'toutiao.com') && parsed.pathname.startsWith('/is/'));
    } catch {
        return false;
    }
}

export function shortLinkPlatform(value) {
    try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase();
        if (isDomain(host, 'toutiao.com') && parsed.pathname.startsWith('/is/')) return '今日头条';
        return SHORT_LINK_PLATFORM_BY_HOST.get(host) ?? '';
    } catch {
        return '';
    }
}

export function extractDouyinVideoId(value) {
    try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        if (!isDouyinDomain(host)) {
            return '';
        }
        return parsed.pathname.match(/\/video\/(\d+)/)?.[1] ?? parsed.searchParams.get('modal_id')?.match(/^\d+$/)?.[0] ?? '';
    } catch {
        return '';
    }
}

export function extractBilibiliVideoId(value) {
    try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        if (!isDomain(host, 'bilibili.com')) {
            return '';
        }
        return parsed.pathname.match(/\/video\/((?:BV)[A-Za-z0-9]+|av\d+)/i)?.[1] ?? '';
    } catch {
        return '';
    }
}

export function extractKuaishouProfileId(value) {
    try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        if (!isDomain(host, 'kuaishou.com') && !isDomain(host, 'chenzhongtech.com')) {
            return '';
        }
        const pathId = parsed.pathname.match(/\/(?:profile|fw\/user)\/([^/?#]+)/)?.[1];
        const queryId = parsed.pathname.includes('/fw/photo/') ? parsed.searchParams.get('userId') : '';
        const candidate = pathId || queryId || '';
        return /^[A-Za-z0-9_-]+$/.test(candidate) ? candidate : '';
    } catch {
        return '';
    }
}

export function extractSohuVideoAuthorId(value) {
    try {
        const parsed = new URL(value);
        const direct = parsed.pathname.match(/^\/user\/(\d+)/)?.[1] || parsed.searchParams.get('uid');
        if (direct && /^\d+$/.test(direct)) return direct;
        const encoded = parsed.pathname.match(/^\/v\/([^/]+)\.html$/i)?.[1];
        if (!encoded) return '';
        const decoded = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
        return decoded.match(/(?:^|\/)us\/(\d+)\//i)?.[1] || '';
    } catch {
        return '';
    }
}

export function isXiaohongshuWorkUrl(value) {
    try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        return isDomain(host, 'xiaohongshu.com') && /^\/(?:explore|discovery\/item)\/[A-Za-z0-9]+/.test(parsed.pathname);
    } catch {
        return false;
    }
}

export function isToutiaoWorkUrl(value) {
    try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        return isDomain(host, 'toutiao.com') && /\/(?:article|video|w)\/\d+|\/a\d+/.test(parsed.pathname);
    } catch {
        return false;
    }
}

export function extractToutiaoUserToken(value) {
    return String(value ?? '').match(/\/c\/user\/token\/([^/?#"'\\]+)/)?.[1] ?? '';
}

export function extractXiaohongshuRedirectTarget(value) {
    try {
        const parsed = new URL(value);
        if (!isDomain(parsed.hostname.toLowerCase(), 'xiaohongshu.com')) {
            return '';
        }
        const redirectPath = parsed.searchParams.get('redirectPath');
        if (!redirectPath) {
            return '';
        }
        const target = new URL(redirectPath);
        return isDomain(target.hostname.toLowerCase(), 'xiaohongshu.com') ? target.href : '';
    } catch {
        return '';
    }
}

export function findXiaohongshuAuthorIdFromHtml(html) {
    const text = String(html ?? '');
    const marker = 'window.__INITIAL_STATE__=';
    const start = text.indexOf(marker);
    if (start < 0) {
        return '';
    }
    const scriptStart = start + marker.length;
    const scriptEnd = text.indexOf('</script>', scriptStart);
    if (scriptEnd < 0) {
        return '';
    }
    const source = text.slice(scriptStart, scriptEnd).replace(/;\s*$/, '').replaceAll('undefined', 'null');
    try {
        const state = JSON.parse(source);
        const noteId = state?.note?.firstNoteId;
        const user = state?.note?.noteDetailMap?.[noteId]?.note?.user;
        const userId = user?.userId || user?.user_id || user?.id || '';
        return /^[A-Za-z0-9]+$/.test(userId) ? userId : '';
    } catch {
        return '';
    }
}

export function canonicalizeProfileUrl(value) {
    try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        const path = parsed.pathname;
        if (isDouyinDomain(host)) {
            const uid = path.match(/\/(?:share\/)?user\/(MS4wLjABAAAA[^/?#]+)/)?.[1] || parsed.searchParams.get('sec_uid');
            if (uid) return `https://www.douyin.com/user/${uid}`;
        }
        if (isDomain(host, 'xiaohongshu.com')) {
            const userId = path.match(/\/user\/profile\/([A-Za-z0-9]+)/)?.[1];
            if (userId) return `https://www.xiaohongshu.com/user/profile/${userId}`;
        }
        if (isDomain(host, 'toutiao.com')) {
            const token = extractToutiaoUserToken(path);
            if (token) return `https://www.toutiao.com/c/user/token/${token}/`;
        }
        if (host === 'space.bilibili.com') {
            const uid = path.match(/^\/(\d+)/)?.[1];
            if (uid) return `https://space.bilibili.com/${uid}`;
        }
        if (isDomain(host, 'dongchedi.com') || isDomain(host, 'dcdapp.com')) {
            const userId = path.match(/^\/user\/(?:profile\/)?(\d+)/)?.[1];
            if (userId) return `https://www.dongchedi.com/user/${userId}`;
        }
        const kuaishouId = extractKuaishouProfileId(value);
        if (kuaishouId) return `https://www.kuaishou.com/profile/${kuaishouId}`;
    } catch {}
    return value;
}

export function extractSecUidFromUrlText(value) {
    const text = String(value ?? '');
    const marker = 'MS4wLjABAAAA';
    const start = text.indexOf(marker);
    if (start < 0) {
        return '';
    }

    let end = start;
    while (end < text.length && /[A-Za-z0-9_-]/.test(text[end])) {
        end += 1;
    }
    return text.slice(start, end);
}

export function findDouyinAuthorSecUid(payload, videoId) {
    const detail = payload?.aweme_detail;
    if (String(detail?.aweme_id ?? '') !== String(videoId ?? '')) {
        return '';
    }

    const secUid = detail?.author?.sec_uid;
    return typeof secUid === 'string' && secUid.startsWith('MS4wLjABAAAA') ? secUid : '';
}

export function findDouyinAuthorSecUidFromLinkedData(scriptTexts, videoId) {
    const targetPath = `/video/${String(videoId ?? '')}`;
    const extractSecUid = (value) => {
        const text = String(value ?? '');
        const marker = 'MS4wLjABAAAA';
        const start = text.indexOf(marker);
        if (start < 0) return '';
        let end = start;
        while (end < text.length && /[A-Za-z0-9_-]/.test(text[end])) end += 1;
        return text.slice(start, end);
    };
    const linkFrom = (value) => {
        if (typeof value === 'string') return value;
        if (!value || typeof value !== 'object') return '';
        return value.url || value['@id'] || value.item || '';
    };

    for (const scriptText of Array.isArray(scriptTexts) ? scriptTexts : []) {
        let parsed;
        try {
            parsed = JSON.parse(scriptText);
        } catch {
            continue;
        }

        for (const document of Array.isArray(parsed) ? parsed : [parsed]) {
            if (!document || !JSON.stringify(document).includes(targetPath)) continue;
            const preferredAuthors = [document.author, document.creator, document.mainEntity?.author];
            for (const author of preferredAuthors) {
                const uid = extractSecUid(linkFrom(author));
                if (uid) return uid;
            }
            for (const entry of Array.isArray(document.itemListElement) ? document.itemListElement : []) {
                const uid = extractSecUid(linkFrom(entry?.item ?? entry));
                if (uid) return uid;
            }
        }
    }
    return '';
}

export async function retryDouyinFeedFetch(fetchAttempt, { maxAttempts = 2, onRetry = async () => {} } = {}) {
    const totalAttempts = Math.max(1, Number.parseInt(maxAttempts, 10) || 1);
    let payload = { items: [], attempts: [] };
    let error = null;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        try {
            payload = await fetchAttempt(attempt);
            error = null;
            if (payload?.items?.length) {
                return { payload, error, attemptsUsed: attempt };
            }
        } catch (caught) {
            error = caught;
        }

        if (attempt < totalAttempts) {
            await onRetry({ attempt, payload, error });
        }
    }

    return { payload, error, attemptsUsed: totalAttempts };
}

export async function retryDouyinAuthorFetch(resolveAttempt, { maxAttempts = 2, onRetry = async () => {} } = {}) {
    const totalAttempts = Math.max(1, Number.parseInt(maxAttempts, 10) || 1);
    let value = '';
    let error = null;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        try {
            value = await resolveAttempt(attempt);
            error = null;
            if (typeof value === 'string' && value.startsWith('MS4wLjABAAAA')) {
                return { value, error, attemptsUsed: attempt };
            }
        } catch (caught) {
            error = caught;
        }

        if (attempt < totalAttempts) {
            await onRetry({ attempt, value, error });
        }
    }

    return { value: '', error, attemptsUsed: totalAttempts };
}

export function buildRoute(value) {
    const extracted = extractUrl(value);
    if (!extracted) {
        throw new Error('没有识别到有效链接');
    }

    if (extracted.startsWith('/')) {
        if (!DIRECT_ROUTE_PREFIXES.some((prefix) => extracted.startsWith(prefix))) {
            throw new Error('不支持这个 RSSHub 路由');
        }
        return {
            platform: 'RSSHub 路由',
            sourceUrl: extracted,
            route: withJsonFormat(extracted),
        };
    }

    const parsed = new URL(extracted);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname;

    if (host === 'localhost' || host === '127.0.0.1') {
        if (!DIRECT_ROUTE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
            throw new Error('本机链接不是支持的 RSSHub 平台路由');
        }
        return {
            platform: 'RSSHub 路由',
            sourceUrl: extracted,
            route: withJsonFormat(`${path}${parsed.search}`),
        };
    }

    if (isDomain(host, 'douyin.com')) {
        const uid = path.match(/\/user\/(MS4wLjABAAAA[^/?#]+)/)?.[1] ?? parsed.searchParams.get('sec_uid')?.match(/^MS4wLjABAAAA[^/?#]+$/)?.[0];
        if (!uid) {
            throw new Error('抖音链接中没有找到用户 sec_uid；请使用用户主页链接');
        }
        return {
            platform: '抖音',
            sourceUrl: extracted,
            route: `/douyin/user/${encodeURIComponent(uid)}?format=json`,
        };
    }

    if (isDomain(host, 'xiaohongshu.com')) {
        const userId = path.match(/\/user\/profile\/([a-zA-Z0-9]+)/)?.[1];
        if (!userId) {
            throw new Error('小红书链接中没有找到用户 ID；请使用用户主页链接');
        }
        return {
            platform: '小红书',
            sourceUrl: extracted,
            route: `/xiaohongshu/user/${encodeURIComponent(userId)}/notes?format=json`,
        };
    }

    if (isDomain(host, 'toutiao.com')) {
        const token = path.match(/\/c\/user\/token\/([^/?#]+)/)?.[1];
        if (!token) {
            throw new Error('今日头条链接中没有找到用户 token');
        }
        return {
            platform: '今日头条',
            sourceUrl: extracted,
            route: `/toutiao/user/token/${encodeURIComponent(token)}?format=json`,
        };
    }

    if (host === 'space.bilibili.com') {
        const uid = path.match(/^\/(\d+)/)?.[1];
        if (!uid) {
            throw new Error('B站链接中没有找到用户 UID');
        }
        return {
            platform: 'B站',
            sourceUrl: extracted,
            route: `/bilibili/user/video-all/${uid}?format=json`,
        };
    }

    if (isDomain(host, 'kuaishou.com')) {
        const principalId = path.match(/\/(?:profile|fw\/user)\/([^/?#]+)/)?.[1];
        if (!principalId) {
            throw new Error('快手链接中没有找到用户 ID；请使用用户主页链接');
        }
        return {
            platform: '快手',
            sourceUrl: extracted,
            route: `/kuaishou/profile/${encodeURIComponent(principalId)}?format=json`,
        };
    }

    if (isDomain(host, 'weibo.com') || isDomain(host, 'weibo.cn')) {
        const uid = path.match(/\/(?:u|profile)\/(\d+)/)?.[1] || path.match(/^\/(\d+)/)?.[1];
        if (uid) return platformRoute('微博', extracted, `/weibo/user/${encodeURIComponent(uid)}`);
        // 微博同时支持数字 UID 与昵称短名主页，例如 weibo.com/gzwcjs。
        // 短名没有稳定的公开 UID 映射，交由已登录浏览器读取作品页，不能在入口直接拒绝。
        const slug = path.match(/^\/([A-Za-z][A-Za-z0-9_-]{1,63})\/?$/)?.[1] || '';
        const reserved = new Set(['ajax', 'login', 'logout', 'signup', 'settings', 'hot', 'tv', 'video', 'search', 'u', 'profile']);
        if (slug && !reserved.has(slug.toLowerCase())) return platformRoute('微博', extracted);
        throw new Error('微博链接中没有找到用户 UID 或昵称主页');
    }

    if (isDomain(host, 'zhihu.com')) {
        const id = path.match(/^\/people\/([^/?#]+)/)?.[1];
        if (!id) throw new Error('知乎链接中没有找到用户 ID');
        return platformRoute('知乎', extracted, `/zhihu/people/activities/${encodeURIComponent(id)}`);
    }

    if (isDomain(host, '163.com')) {
        const id = path.match(/\/dy\/media\/([^/.]+)\.html/i)?.[1];
        if (!id) throw new Error('网易新闻链接中没有找到网易号 ID');
        return platformRoute('网易新闻', extracted, `/163/dy2/${encodeURIComponent(id)}`);
    }

    if (isDomain(host, 'dongchedi.com') || isDomain(host, 'dcdapp.com')) return platformRoute('懂车帝', extracted);
    if (isDomain(host, 'yidianzixun.com')) return platformRoute('一点资讯', extracted);
    if (isDomain(host, 'uc.cn') || isDomain(host, 'dayu.com')) return platformRoute('UC大鱼', extracted);

    if (isDomain(host, 'sohu.com') && !host.startsWith('tv.') && !host.startsWith('my.tv.')) {
        const xpt = parsed.searchParams.get('xpt');
        return platformRoute('搜狐新闻', extracted, xpt ? `/sohu/mp/${encodeURIComponent(xpt)}` : '');
    }

    if (host === 'view.inews.qq.com' || host.endsWith('.inews.qq.com') || host === 'news.qq.com' || host === 'new.qq.com' || host === 'om.qq.com') {
        const uid = path.match(/\/(?:media|author|u)\/([^/?#]+)/)?.[1] || path.match(/\/omn\/author\/([^/?#]+)/)?.[1];
        return platformRoute('腾讯新闻', extracted, uid ? `/qq/news/${encodeURIComponent(uid)}` : '');
    }

    if (isDomain(host, 'ifeng.com')) {
        const authorId = path.match(/\/mediaShare\/home\/(\d+)\/media/i)?.[1] || path.match(/\/author\/(\d+)/i)?.[1];
        return platformRoute('凤凰新闻', extracted, authorId ? `/ifeng/feng/${authorId}/doc` : '');
    }
    if (host === 'baijiahao.baidu.com' || host === 'mbd.baidu.com') return platformRoute('百度新闻', extracted);
    if (isDomain(host, 'autohome.com.cn')) return platformRoute('汽车之家', extracted);
    if (isDomain(host, 'xcar.com.cn')) return platformRoute('爱卡汽车', extracted);
    if (isDomain(host, 'qctt.cn')) return platformRoute('汽车头条', extracted);
    if (isDomain(host, 'pcauto.com.cn')) return platformRoute('太平洋汽车', extracted);
    if (isDomain(host, 'cheshi.com')) return platformRoute('网上车市', extracted);
    if (isDomain(host, 'yiche.com')) return platformRoute('易车', extracted);

    if (isDomain(host, 'iqiyi.com')) {
        const uid = path.match(/^\/u\/(\d+)/)?.[1];
        if (!uid) throw new Error('爱奇艺链接中没有找到用户 UID');
        return platformRoute('爱奇艺', extracted, `/iqiyi/user/video/${uid}`);
    }

    if (isDomain(host, 'youku.com') || isDomain(host, 'tudou.com')) {
        const channelId = path.match(/^\/i\/([^/?#]+)/)?.[1];
        if (!channelId) throw new Error('优酷/土豆链接中没有找到频道 ID');
        return platformRoute('优酷/土豆视频', extracted, `/youku/channel/${encodeURIComponent(channelId)}`);
    }

    if (host === 'v.qq.com') return platformRoute('腾讯视频', extracted);

    if (isDomain(host, 'meipai.com')) {
        const uid = path.match(/^\/user\/(\d+)/)?.[1];
        return platformRoute('美拍', extracted, uid ? `/meipai/user/${uid}` : '');
    }

    if (host === 'tv.sohu.com' || host === 'my.tv.sohu.com') return platformRoute('搜狐视频', extracted);
    if (isDomain(host, '56.com')) return platformRoute('56视频', extracted);
    if (isDomain(host, 'miaopai.com')) return platformRoute('秒拍', extracted);

    if (isDomain(host, 'ixigua.com')) {
        const uid = path.match(/^\/home\/(\d+)/)?.[1];
        if (!uid) throw new Error('西瓜视频链接中没有找到用户 UID');
        return platformRoute('西瓜视频', extracted, `/ixigua/user/video/${uid}`);
    }

    throw new Error(`暂不支持该平台：${parsed.hostname}`);
}

function platformRoute(platform, sourceUrl, route = '') {
    return { platform, sourceUrl, route: route ? withJsonFormat(route) : '' };
}

function withJsonFormat(route) {
    const parsed = new URL(route, 'http://rsshub.local');
    parsed.searchParams.set('format', 'json');
    return `${parsed.pathname}${parsed.search}`;
}

export function findLatestItem(items) {
    const dated = (Array.isArray(items) ? items : [])
        .map((item) => {
            const rawDate = item?.date_published ?? item?.pubDate;
            const timestamp = Date.parse(rawDate);
            return Number.isFinite(timestamp) ? { ...item, rawDate, timestamp } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.timestamp - a.timestamp);

    return dated[0] ?? null;
}

export function parsePublicationDate(value, { now = Date.now() } = {}) {
    if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? value.getTime() : Number.NaN;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        const timestamp = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
        return Number.isFinite(new Date(timestamp).getTime()) ? timestamp : Number.NaN;
    }

    const text = String(value ?? '').trim();
    if (!text) return Number.NaN;
    if (/^\d{10}(?:\.\d+)?$/.test(text)) return Number(text) * 1000;
    if (/^\d{13}$/.test(text)) return Number(text);
    if (/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) || /(?:GMT|UTC)/i.test(text)) {
        const zoned = Date.parse(text);
        if (Number.isFinite(zoned)) return zoned;
    }

    const nowMs = Number(now);
    const relative = text.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*(秒钟?|分钟?|小时|天|周|个月|月|年)前(?:\s|$)/u);
    if (relative && Number.isFinite(nowMs)) {
        const unitMs = {
            秒: 1000,
            秒钟: 1000,
            分: 60_000,
            分钟: 60_000,
            小时: 3_600_000,
            天: 86_400_000,
            周: 7 * 86_400_000,
            个月: 30 * 86_400_000,
            月: 30 * 86_400_000,
            年: 365 * 86_400_000,
        };
        return nowMs - Number(relative[1]) * unitMs[relative[2]];
    }

    const beijing = beijingDateParts(nowMs);
    const clockMatch = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    const hour = Number(clockMatch?.[1] || 0);
    const minute = Number(clockMatch?.[2] || 0);
    const second = Number(clockMatch?.[3] || 0);
    if (Number.isFinite(nowMs) && /刚刚|片刻前/u.test(text)) return nowMs;
    if (Number.isFinite(nowMs) && /今天/u.test(text)) {
        return beijingWallClockToUtc(beijing.year, beijing.month, beijing.day, hour, minute, second);
    }
    if (Number.isFinite(nowMs) && /昨天/u.test(text)) {
        return beijingWallClockToUtc(beijing.year, beijing.month, beijing.day - 1, hour, minute, second);
    }

    const chineseAbsolute = text.match(/(20\d{2})\s*[年/.\-]\s*(\d{1,2})\s*[月/.\-]\s*(\d{1,2})(?:\s*[日号])?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/u);
    if (chineseAbsolute) {
        return beijingWallClockToUtc(
            Number(chineseAbsolute[1]),
            Number(chineseAbsolute[2]),
            Number(chineseAbsolute[3]),
            Number(chineseAbsolute[4] || 0),
            Number(chineseAbsolute[5] || 0),
            Number(chineseAbsolute[6] || 0),
        );
    }

    const shortAbsolute = Number.isFinite(nowMs) ? text.match(/(?:^|\s)(\d{1,2})\s*[月/.\-]\s*(\d{1,2})(?:\s*[日号])?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\s|$)/u) : null;
    if (shortAbsolute) {
        let timestamp = beijingWallClockToUtc(
            beijing.year,
            Number(shortAbsolute[1]),
            Number(shortAbsolute[2]),
            Number(shortAbsolute[3] || 0),
            Number(shortAbsolute[4] || 0),
            Number(shortAbsolute[5] || 0),
        );
        if (timestamp > nowMs + 7 * 86_400_000) {
            timestamp = beijingWallClockToUtc(
                beijing.year - 1,
                Number(shortAbsolute[1]),
                Number(shortAbsolute[2]),
                Number(shortAbsolute[3] || 0),
                Number(shortAbsolute[4] || 0),
                Number(shortAbsolute[5] || 0),
            );
        }
        return timestamp;
    }

    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function normalizeGenericFeed(payload, { platform = '平台', profileUrl = '', now = Date.now() } = {}) {
    const nowMs = Number(now);
    const earliest = Date.UTC(2000, 0, 1);
    const latest = nowMs + 10 * 60_000;
    const source = [
        ...(Array.isArray(payload?.responseCandidates) ? payload.responseCandidates : []),
        ...(Array.isArray(payload?.domCandidates) ? payload.domCandidates : []),
        ...(Array.isArray(payload?.items) ? payload.items : []),
    ];
    const seen = new Set();
    const items = [];

    for (const candidate of source) {
        const rawDate = candidate?.date ?? candidate?.datePublished ?? candidate?.uploadDate ?? candidate?.timestamp ?? candidate?.time;
        const timestamp = parsePublicationDate(rawDate, { now: nowMs });
        if (!Number.isFinite(timestamp) || timestamp < earliest || timestamp > latest) continue;
        const title = String(candidate?.title ?? candidate?.name ?? candidate?.desc ?? candidate?.description ?? '').trim().slice(0, 300);
        let url = String(candidate?.url ?? candidate?.link ?? candidate?.href ?? '').trim();
        try {
            if (url) url = new URL(url, profileUrl || undefined).href;
        } catch {
            url = '';
        }
        if (!title && !url) continue;
        const key = `${url}\u0000${timestamp}\u0000${title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
            title: title || `${platform}作品`,
            ...(url ? { url } : {}),
            date_published: new Date(timestamp).toISOString(),
        });
        if (items.length >= 200) break;
    }

    return {
        title: String(payload?.title || `${platform}用户`).trim(),
        items: items.sort((a, b) => Date.parse(b.date_published) - Date.parse(a.date_published)),
    };
}

export function normalizeTencentNewsFeed(profilePayload, listPayloads = [], { now = Date.now() } = {}) {
    const user = profilePayload?.userinfo || profilePayload?.data?.userinfo || {};
    const profileUrl = user?.suid ? `https://view.inews.qq.com/u/${encodeURIComponent(user.suid)}` : 'https://view.inews.qq.com/';
    const candidates = [];
    const payloads = Array.isArray(listPayloads) ? listPayloads : [listPayloads];
    for (const payload of payloads) {
        const rows = payload?.newslist || payload?.data?.newslist || payload?.res?.newsList || payload?.newsList || [];
        for (const item of Array.isArray(rows) ? rows : []) {
            const id = String(item?.id || item?.article_id || item?.articleId || '').trim();
            const url = item?.url || item?.share_url || item?.shareUrl || item?.article_url || item?.articleUrl || item?.link || (id ? `https://view.inews.qq.com/a/${id}` : '');
            candidates.push({
                date: item?.pub_time ?? item?.pubTime ?? item?.time ?? item?.timestamp ?? item?.create_time ?? item?.createTime,
                title: item?.title || item?.article_title || item?.articleTitle || item?.desc || item?.abstract || item?.summary || '',
                url,
            });
        }
    }
    return normalizeGenericFeed({
        title: user?.nick || user?.nickname || '腾讯新闻用户',
        responseCandidates: candidates,
    }, { platform: '腾讯新闻', profileUrl, now });
}

export function normalizeTencentVideoFeed(payload, { profileUrl = 'https://v.qq.com/' } = {}) {
    const moduleLists = Array.isArray(payload?.data?.module_list_datas)
        ? payload.data.module_list_datas
        : Array.isArray(payload?.module_list_datas)
            ? payload.module_list_datas
            : [];
    const items = [];
    let author = '';

    for (const moduleList of moduleLists) {
        for (const moduleData of Array.isArray(moduleList?.module_datas) ? moduleList.module_datas : []) {
            const itemDatas = Array.isArray(moduleData?.item_data_lists?.item_datas) ? moduleData.item_data_lists.item_datas : [];
            for (const item of itemDatas) {
                let detail;
                try {
                    detail = typeof item?.complex_json === 'string' ? JSON.parse(item.complex_json) : item?.complex_json;
                } catch {
                    continue;
                }
                if (!detail || typeof detail !== 'object') continue;
                const rawTime = detail?.base?.time;
                const date = timestampToIso(rawTime);
                if (!date) continue;
                const video = Array.isArray(detail?.videos) ? detail.videos[0] : null;
                const vid = decodeBase64Utf8(video?.videoBase?.vid);
                const title = decodeBase64Utf8(video?.videoAttr?.title)
                    || decodeBase64Utf8(detail?.content?.content)
                    || '腾讯视频作品';
                author ||= decodeBase64Utf8(detail?.user?.base?.name);
                items.push({
                    title,
                    ...(vid ? { url: `https://v.qq.com/x/page/${encodeURIComponent(vid)}.html` } : { url: profileUrl }),
                    date_published: date,
                });
            }
        }
    }

    return {
        title: author || '腾讯视频用户',
        items: items.sort((a, b) => Date.parse(b.date_published) - Date.parse(a.date_published)),
    };
}

function decodeBase64Utf8(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    try {
        const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        return new TextDecoder().decode(bytes).trim();
    } catch {
        return '';
    }
}

export function normalizeIfengFeed(payloads, { authorId = '', now = Date.now() } = {}) {
    const candidates = [];
    for (const payload of Array.isArray(payloads) ? payloads : [payloads]) {
        let parsed = payload;
        if (typeof payload === 'string') {
            const source = payload.trim();
            const jsonText = source.match(/^[^(]*\(([\s\S]*)\)\s*;?$/)?.[1] || source;
            try {
                parsed = JSON.parse(jsonText);
            } catch {
                continue;
            }
        }
        const rows = parsed?.data || parsed?.result?.data || [];
        for (const item of Array.isArray(rows) ? rows : []) {
            const rawUrl = String(item?.url || item?.link || '').trim();
            candidates.push({
                date: item?.newsTime ?? item?.publishTime ?? item?.createTime ?? item?.timestamp,
                title: item?.title || item?.name || item?.summary || '',
                url: rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl,
            });
        }
    }
    return normalizeGenericFeed({
        title: authorId ? `凤凰新闻作者 ${authorId}` : '凤凰新闻作者',
        responseCandidates: candidates,
    }, {
        platform: '凤凰新闻',
        profileUrl: authorId ? `https://ishare.ifeng.com/mediaShare/home/${encodeURIComponent(authorId)}/media` : 'https://ishare.ifeng.com/',
        now,
    });
}

export function parseYicheProfileHtml(html, profileUrl = '', { now = Date.now() } = {}) {
    const source = String(html || '');
    const candidates = [];
    const encodedBlocks = source.match(/(?:%[0-9A-Fa-f]{2}|[A-Za-z0-9_.~!*'();/?:@&=+$,#-]){300,}/g) || [];
    for (const encoded of encodedBlocks) {
        if (!/%(?:22|5C%22)(?:publishTime|publishTimestamp)/i.test(encoded) && !encoded.includes('publishTime')) continue;
        let diagnostic;
        try {
            diagnostic = JSON.parse(decodeURIComponent(encoded));
        } catch {
            continue;
        }
        for (const entry of Array.isArray(diagnostic) ? diagnostic : [diagnostic]) {
            const log = String(entry?.logMsg || '');
            const start = log.indexOf('resData="');
            const end = log.lastIndexOf('";');
            if (start < 0 || end <= start + 9) continue;
            let response;
            try {
                response = JSON.parse(log.slice(start + 9, end));
            } catch {
                continue;
            }
            const rows = response?.data?.list || response?.data?.items || [];
            for (const item of Array.isArray(rows) ? rows : []) {
                candidates.push({
                    date: item?.publishTimestamp ?? item?.publishTime ?? item?.createTime ?? item?.createtime,
                    title: item?.title || item?.content?.title || item?.summary || '',
                    url: item?.link || item?.linkUrl || item?.url || item?.content?.link || '',
                });
            }
        }
    }
    const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
        ?.replace(/<[^>]+>/g, '')
        .replaceAll('&amp;', '&')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .trim() || '易车用户';
    return normalizeGenericFeed({ title, responseCandidates: candidates }, {
        platform: '易车',
        profileUrl,
        now,
    });
}

export function parseAutohomeProfileHtml(html, profileUrl = '', { now = Date.now() } = {}) {
    const source = String(html || '');
    const candidates = [];
    for (const match of source.matchAll(/<section\b([^>]*)class=["'][^"']*\bmodule-card\b[^"']*["'][^>]*>([\s\S]*?)<\/section>/gi)) {
        const attributes = match[1] || '';
        const card = match[2] || '';
        const date = card.match(/class=["'][^"']*\bpublishDate\b[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1]?.replace(/<[^>]+>/g, '').trim();
        if (!date) continue;
        const title = card.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1]
            ?.replace(/<[^>]+>/g, '')
            .replaceAll('&amp;', '&')
            .replaceAll('&lt;', '<')
            .replaceAll('&gt;', '>')
            .replaceAll('&quot;', '"')
            .trim() || '';
        const id = attributes.match(/data-info-id=["']?(\d+)/i)?.[1] || card.match(/data-infoid=["']?(\d+)/i)?.[1] || '';
        candidates.push({
            date,
            title,
            url: id ? `https://chejiahao.autohome.com.cn/info/${id}` : '',
        });
    }
    const legacyCards = [...source.matchAll(/<div\b(?=[^>]*\bdata-infoid=["']?\d+)(?=[^>]*\bclass=["'][^"']*\bauthor-vr\b)[^>]*>/gi)];
    for (let index = 0; index < legacyCards.length; index += 1) {
        const marker = legacyCards[index];
        const attributes = marker[0];
        const segment = source.slice(marker.index, legacyCards[index + 1]?.index ?? source.length);
        const date = segment.match(/<div\b[^>]*class=["'][^"']*\binfo\b[^"']*["'][^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/i)?.[1]
            ?.replace(/<[^>]+>/g, '')
            .trim();
        if (!date) continue;
        const title = segment.match(/<div\b[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
            ?.replace(/<[^>]+>/g, '')
            .replaceAll('&amp;', '&')
            .replaceAll('&lt;', '<')
            .replaceAll('&gt;', '>')
            .replaceAll('&quot;', '"')
            .trim() || '';
        const id = attributes.match(/data-infoid=["']?(\d+)/i)?.[1] || '';
        candidates.push({
            date,
            title,
            url: id ? `https://chejiahao.autohome.com.cn/info/${id}` : '',
        });
    }
    const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, '').trim() || '汽车之家用户';
    return normalizeGenericFeed({ title, responseCandidates: candidates }, {
        platform: '汽车之家',
        profileUrl,
        now,
    });
}

export function findVideo56AuthorProfileFromHtml(html) {
    const source = String(html || '').replaceAll('\\/', '/');
    const href = source.match(/(?:https?:)?\/\/i\.56\.com\/u\/([A-Za-z0-9_-]+)\/?/i)?.[1];
    const userId = href || source.match(/["']user_id["']\s*:\s*["']([A-Za-z0-9_-]+)["']/i)?.[1];
    return userId ? `https://i.56.com/u/${userId}/` : '';
}

export function extractVideo56WorkLinks(html, limit = 12) {
    const source = String(html || '').replaceAll('&amp;', '&');
    const links = [];
    const seen = new Set();
    const pattern = /(?:https?:\/\/www\.56\.com)?(\/u\d+\/v_[A-Za-z0-9_]+\.html)/gi;
    for (const match of source.matchAll(pattern)) {
        const url = `https://www.56.com${match[1]}`;
        if (seen.has(url)) continue;
        seen.add(url);
        links.push(url);
        if (links.length >= limit) break;
    }
    return links;
}

export function parseVideo56WorkHtml(html, fallbackUrl = '') {
    const source = String(html || '');
    for (const match of source.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        try {
            const data = JSON.parse(match[1].trim());
            const entries = Array.isArray(data) ? data : [data];
            const video = entries.find((entry) => entry?.['@type'] === 'VideoObject' && entry?.uploadDate);
            if (!video) continue;
            const timestamp = Date.parse(video.uploadDate);
            if (!Number.isFinite(timestamp)) continue;
            return {
                title: String(video.name || '56视频作品').trim(),
                url: String(video.embedUrl || video.url || fallbackUrl).trim(),
                date_published: new Date(timestamp).toISOString(),
            };
        } catch {}
    }

    const seconds = Number(source.match(/["']save_time["']\s*:\s*(\d{9,13})/i)?.[1]);
    const milliseconds = seconds < 1_000_000_000_000 ? seconds * 1000 : seconds;
    if (!Number.isFinite(milliseconds)) return null;
    return {
        title: '56视频作品',
        url: fallbackUrl,
        date_published: new Date(milliseconds).toISOString(),
    };
}

export function normalizeIqiyiFeed(worksPayload, detailPayload) {
    const flows = Array.isArray(worksPayload?.data?.sort?.flows) ? worksPayload.data.sort.flows : [];
    const detailMap = detailPayload?.data && typeof detailPayload.data === 'object' ? detailPayload.data : {};
    const ids = flows.map((flow) => String(flow?.qipuId ?? '')).filter(Boolean);
    const entries = ids.length
        ? ids.map((id) => detailMap[id]).filter(Boolean)
        : Object.values(detailMap);
    const items = entries.map((entry) => {
        const rawTime = entry?.publishTime ?? entry?.timeCreate;
        const numeric = Number(rawTime);
        const timestamp = Number.isFinite(numeric)
            ? (numeric < 1_000_000_000_000 ? numeric * 1000 : numeric)
            : Date.parse(String(rawTime || ''));
        return {
            title: String(entry?.title || entry?.producingTitle || '爱奇艺作品').trim(),
            ...(entry?.pageUrl ? { url: String(entry.pageUrl) } : {}),
            ...(Number.isFinite(timestamp) ? { date_published: new Date(timestamp).toISOString() } : {}),
        };
    });
    const first = entries.find((entry) => entry?.nickname);
    return {
        title: String(first?.nickname || '爱奇艺用户'),
        items,
    };
}

function beijingDateParts(timestamp) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function beijingWallClockToUtc(year, month, day, hour, minute, second) {
    return Date.UTC(year, month - 1, day, hour - 8, minute, second);
}

export function isCookieUsable(cookie, nowEpochSeconds = Date.now() / 1000) {
    if (!cookie?.name || typeof cookie?.value !== 'string') {
        return false;
    }
    const expiration = Number(cookie.expirationDate);
    return !Number.isFinite(expiration) || expiration > nowEpochSeconds;
}

export function normalizeKuaishouFeed(payload) {
    const data = payload?.data?.visionProfilePhotoList ?? payload?.visionProfilePhotoList ?? {};
    const feeds = Array.isArray(data?.feeds) ? data.feeds : [];
    const firstAuthor = feeds.find((feed) => feed?.author?.name)?.author?.name || '';
    const items = feeds.map((feed) => {
        const photo = feed?.photo ?? {};
        const id = String(photo?.id ?? '').trim();
        const timestampValue = Number(photo?.timestamp);
        const timestamp = Number.isFinite(timestampValue)
            ? (timestampValue < 1_000_000_000_000 ? timestampValue * 1000 : timestampValue)
            : Number.NaN;
        const date = Number.isFinite(timestamp) ? new Date(timestamp) : null;
        const validDate = date && Number.isFinite(date.getTime());

        return {
            title: photo?.caption || `${firstAuthor || '快手用户'}的作品`,
            ...(id ? { url: `https://www.kuaishou.com/short-video/${encodeURIComponent(id)}` } : {}),
            ...(validDate ? { date_published: date.toISOString() } : {}),
        };
    });

    return {
        result: data?.result,
        title: data?.hostName || firstAuthor || '快手用户',
        items,
        pcursor: data?.pcursor || '',
    };
}

// Browser-rendered Kuaishou endpoints do not share GraphQL's envelope. Only
// accept explicit numeric publication fields; media URLs are not publication dates.
export function normalizeKuaishouNativeFeed(payload) {
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : (payload || {});
    const feeds = Array.isArray(data?.list)
        ? data.list
        : Array.isArray(data?.feeds)
            ? data.feeds
            : [];
    const author = feeds.find((feed) => feed?.author?.name || feed?.user?.name);
    const authorName = author?.author?.name || author?.user?.name || '';
    const items = feeds.map((feed) => {
        const photo = feed?.photo && typeof feed.photo === 'object' ? feed.photo : feed;
        const id = String(photo?.id ?? photo?.photoId ?? photo?.photo_id ?? feed?.id ?? '').trim();
        const timestamp = timestampToIso(
            photo?.timestamp
            ?? photo?.publishTime
            ?? photo?.publish_time
            ?? photo?.publishTimestamp
            ?? photo?.publish_timestamp
            ?? photo?.createTime
            ?? photo?.create_time
            ?? feed?.timestamp
            ?? feed?.publishTime
            ?? feed?.publish_time
            ?? feed?.createTime
            ?? feed?.create_time,
        );
        return {
            title: photo?.caption || photo?.title || feed?.caption || `${authorName || '快手用户'}的作品`,
            ...(id ? { url: `https://www.kuaishou.com/short-video/${encodeURIComponent(id)}` } : {}),
            ...(timestamp ? { date_published: timestamp } : {}),
        };
    });
    return {
        result: data?.result ?? payload?.result,
        title: data?.hostName || data?.author?.name || authorName || '快手用户',
        items,
    };
}

function timestampToIso(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    const milliseconds = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

export function normalizeXiaohongshuFeed(payload) {
    const items = (Array.isArray(payload?.items) ? payload.items : []).map((item) => {
        const id = String(item?.id || '').trim();
        const date = timestampToIso(item?.timestamp);
        return {
            title: item?.title || '小红书作品',
            ...(id ? { url: `https://www.xiaohongshu.com/explore/${encodeURIComponent(id)}` } : {}),
            ...(date ? { date_published: date } : {}),
        };
    });
    return { title: payload?.nickname || '小红书用户', items };
}

export function normalizeToutiaoFeed(payload) {
    const source = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.items) ? payload.items : [];
    const items = source.map((item) => {
        const id = String(item?.id || item?.group_id || '').trim();
        const cellType = Number(item?.cell_type);
        const author = item?.user?.info?.name || item?.user?.name || item?.user_info?.name || item?.source || '';
        const title = item?.title || String(item?.content || '').split('\n', 1)[0] || '今日头条作品';
        const date = timestampToIso(item?.publish_time);
        const kind = [0, 49].includes(cellType) ? 'video' : cellType === 32 ? 'w' : 'article';
        return {
            title,
            author,
            ...(id ? { url: `https://www.toutiao.com/${kind}/${encodeURIComponent(id)}/` } : {}),
            ...(date ? { date_published: date } : {}),
        };
    });
    const title = items.find((item) => item.author)?.author || payload?.name || '今日头条用户';
    return { title, items };
}

export function normalizeBilibiliFeed(payload) {
    const source = payload?.data?.list?.vlist ?? payload?.vlist ?? payload?.items ?? [];
    const items = (Array.isArray(source) ? source : []).map((item) => {
        const bvid = String(item?.bvid || '').trim();
        const aid = String(item?.aid || '').trim();
        const date = timestampToIso(item?.created ?? item?.pubdate);
        return {
            title: item?.title || 'B站作品',
            author: item?.author || '',
            ...(bvid || aid ? { url: `https://www.bilibili.com/video/${bvid || `av${aid}`}` } : {}),
            ...(date ? { date_published: date } : {}),
        };
    });
    return { title: items.find((item) => item.author)?.author || payload?.name || 'B站用户', items };
}

export function formatBeijingTime(value) {
    const timestamp = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(timestamp)) {
        return '';
    }
    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(new Date(timestamp));
    const data = Object.fromEntries(parts.map(({ type, value: partValue }) => [type, partValue]));
    return `${data.year}-${data.month}-${data.day} ${data.hour}:${data.minute}:${data.second}`;
}
