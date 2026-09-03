import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRoute, canonicalizeProfileUrl, extractBilibiliVideoId, extractDouyinVideoId, extractKuaishouProfileId, extractSecUidFromUrlText, extractSohuVideoAuthorId, extractToutiaoUserToken, extractUrl, extractVideo56WorkLinks, extractXiaohongshuRedirectTarget, findDouyinAuthorSecUid, findDouyinAuthorSecUidFromLinkedData, findLatestItem, findVideo56AuthorProfileFromHtml, findXiaohongshuAuthorIdFromHtml, formatBeijingTime, isCookieUsable, isToutiaoWorkUrl, isXiaohongshuWorkUrl, needsRedirectResolution, normalizeBilibiliFeed, normalizeGenericFeed, normalizeIfengFeed, normalizeIqiyiFeed, normalizeKuaishouFeed, normalizeKuaishouNativeFeed, normalizeTencentNewsFeed, normalizeTencentVideoFeed, normalizeToutiaoFeed, normalizeXiaohongshuFeed, parseAutohomeProfileHtml, parsePublicationDate, parseVideo56WorkHtml, parseYicheProfileHtml, retryDouyinAuthorFetch, retryDouyinFeedFetch } from './core.mjs';

test('extracts a URL from pasted text', () => {
    assert.equal(extractUrl('主页：https://v.douyin.com/abc/。'), 'https://v.douyin.com/abc/');
});

test('builds Douyin route from a full profile URL', () => {
    const result = buildRoute('https://www.douyin.com/user/MS4wLjABAAAAexample?from_tab_name=main');
    assert.equal(result.platform, '抖音');
    assert.equal(result.route, '/douyin/user/MS4wLjABAAAAexample?format=json');
});

test('detects a Douyin work short-link destination for author lookup', () => {
    assert.equal(extractDouyinVideoId('https://www.douyin.com/video/7496781168059092251?previous_page=web_code_link'), '7496781168059092251');
    assert.equal(extractDouyinVideoId('https://www.douyin.com/jingxuan?modal_id=7496781168059092251'), '7496781168059092251');
    assert.equal(extractDouyinVideoId('https://www.douyin.com/user/MS4wLjABAAAAexample'), '');
});

test('extracts sec_uid without relying on the URL global', () => {
    const uid = 'MS4wLjABAAAA53LDPF5puw7qke-yvbMT3msWIsDtMKgWJkWRRuC4wvzqUEcodJ6QZYilUag-xFx4';
    assert.equal(extractSecUidFromUrlText(`https://www.douyin.com/aweme/query?sec_uid=${uid}&aid=6383`), uid);
    assert.equal(extractSecUidFromUrlText(`https://www.douyin.com/user/${uid}?from=video`), uid);
    assert.equal(extractSecUidFromUrlText('https://www.douyin.com/video/7496781168059092251'), '');
});

test('accepts a Douyin author only when the detail belongs to the requested video', () => {
    const uid = 'MS4wLjABAAAA53LDPF5puw7qke-yvbMT3msWIsDtMKgWJkWRRuC4wvzqUEcodJ6QZYilUag-xFx4';
    const payload = { aweme_detail: { aweme_id: '7496781168059092251', author: { sec_uid: uid } } };
    assert.equal(findDouyinAuthorSecUid(payload, '7496781168059092251'), uid);
    assert.equal(findDouyinAuthorSecUid(payload, '7675619774319037747'), '');
});

test('extracts the author from JSON-LD only when it references the requested video', () => {
    const uid = 'MS4wLjABAAAA53LDPF5puw7qke-yvbMT3msWIsDtMKgWJkWRRuC4wvzqUEcodJ6QZYilUag-xFx4';
    const linkedData = JSON.stringify({
        '@type': 'BreadcrumbList',
        itemListElement: [
            { position: 1, item: 'https://www.douyin.com/' },
            { position: 2, item: `https://www.douyin.com/user/${uid}` },
            { position: 3, item: 'https://www.douyin.com/video/7496781168059092251' },
        ],
    });

    assert.equal(findDouyinAuthorSecUidFromLinkedData([linkedData], '7496781168059092251'), uid);
    assert.equal(findDouyinAuthorSecUidFromLinkedData([linkedData], '7675619774319037747'), '');
});

test('retries an empty Douyin feed using a fresh browser attempt', async () => {
    let calls = 0;
    const result = await retryDouyinFeedFetch(async () => {
        calls += 1;
        return calls === 1 ? { items: [], attempts: [{ status: 403 }] } : { items: [{ id: '7675619774319037747' }], attempts: [{ status: 200 }] };
    }, { maxAttempts: 2 });

    assert.equal(calls, 2);
    assert.equal(result.payload.items.length, 1);
    assert.equal(result.attemptsUsed, 2);
});

test('does not retry a successful Douyin feed', async () => {
    let calls = 0;
    const result = await retryDouyinFeedFetch(async () => {
        calls += 1;
        return { items: [{ id: '1' }] };
    }, { maxAttempts: 2 });

    assert.equal(calls, 1);
    assert.equal(result.attemptsUsed, 1);
});

test('retries an empty Douyin author result using a fresh browser attempt', async () => {
    let calls = 0;
    const uid = 'MS4wLjABAAAA53LDPF5puw7qke-yvbMT3msWIsDtMKgWJkWRRuC4wvzqUEcodJ6QZYilUag-xFx4';
    const result = await retryDouyinAuthorFetch(async () => {
        calls += 1;
        return calls === 1 ? '' : uid;
    }, { maxAttempts: 2 });

    assert.equal(calls, 2);
    assert.equal(result.value, uid);
    assert.equal(result.attemptsUsed, 2);
});

test('builds routes for supported profile URLs', () => {
    assert.equal(buildRoute('https://www.xiaohongshu.com/user/profile/593032945e87e77791e03696').route, '/xiaohongshu/user/593032945e87e77791e03696/notes?format=json');
    assert.equal(buildRoute('https://space.bilibili.com/2267573').route, '/bilibili/user/video-all/2267573?format=json');
    assert.equal(buildRoute('https://www.toutiao.com/c/user/token/abc123/').route, '/toutiao/user/token/abc123?format=json');
});

test('recognizes all requested platform profile URL families', () => {
    const cases = [
        ['https://www.douyin.com/user/MS4wLjABAAAAexample', '抖音'],
        ['https://www.xiaohongshu.com/user/profile/593032945e87e77791e03696', '小红书'],
        ['https://www.kuaishou.com/profile/3xuemaqzwetdhxk', '快手'],
        ['https://space.bilibili.com/2267573', 'B站'],
        ['https://weibo.com/u/123456', '微博'],
        ['https://weibo.com/gzwcjs', '微博'],
        ['https://www.zhihu.com/people/example-user', '知乎'],
        ['https://www.toutiao.com/c/user/token/abc123/', '今日头条'],
        ['https://www.163.com/dy/media/T123456789.html', '网易新闻'],
        ['https://www.dongchedi.com/user/profile/1638816251446276', '懂车帝'],
        ['https://www.yidianzixun.com/channel/m12345', '一点资讯'],
        ['http://a.mp.uc.cn/media?mid=12345', 'UC大鱼'],
        ['https://www.sohu.com/a/123?xpt=abc123', '搜狐新闻'],
        ['https://view.inews.qq.com/media/7961850', '腾讯新闻'],
        ['https://ishare.ifeng.com/mediaShare/home/12345/media', '凤凰新闻'],
        ['https://baijiahao.baidu.com/u?app_id=12345', '百度新闻'],
        ['https://chejiahao.autohome.com.cn/Authors/12345', '汽车之家'],
        ['https://my.xcar.com.cn/12345', '爱卡汽车'],
        ['https://www.qctt.cn/user/12345', '汽车头条'],
        ['https://my.pcauto.com.cn/12345', '太平洋汽车'],
        ['https://space.cheshi.com/12345', '网上车市'],
        ['https://hao.yiche.com/12345', '易车'],
        ['https://www.iqiyi.com/u/12345', '爱奇艺'],
        ['https://i.youku.com/i/UMTIzNDU=', '优酷/土豆视频'],
        ['https://v.qq.com/x/bu/h5_user_center?uid=12345', '腾讯视频'],
        ['https://www.meipai.com/user/12345', '美拍'],
        ['https://tv.sohu.com/user/336238776', '搜狐视频'],
        ['https://www.56.com/u/12345', '56视频'],
        ['https://www.miaopai.com/u/12345', '秒拍'],
        ['https://www.ixigua.com/home/12345', '西瓜视频'],
    ];
    assert.equal(cases.length, 30);
    for (const [url, platform] of cases) assert.equal(buildRoute(url).platform, platform, url);
});

test('recognizes every supported short-link host and Toutiao share paths', () => {
    assert.equal(needsRedirectResolution('https://v.douyin.com/wwQhRrMO5mk/'), true);
    assert.equal(needsRedirectResolution('https://xhslink.com/abc123'), true);
    assert.equal(needsRedirectResolution('https://xhslink.cn/abc123'), true);
    assert.equal(needsRedirectResolution('https://v.kuaishou.com/PO5Q2j'), true);
    assert.equal(needsRedirectResolution('https://b23.tv/BV1hzqrBtEMP'), true);
    assert.equal(needsRedirectResolution('https://t.cn/A6example'), true);
    assert.equal(needsRedirectResolution('https://163.lu/example'), true);
    assert.equal(needsRedirectResolution('https://athm.cn/example'), true);
    assert.equal(needsRedirectResolution('https://dcd.zjbyte.cn/example'), true);
    assert.equal(needsRedirectResolution('https://v.ixigua.com/example'), true);
    assert.equal(needsRedirectResolution('https://m.toutiao.com/is/abc123/'), true);
});

test('accepts the Kuaishou profile destination returned by short links', () => {
    assert.equal(
        buildRoute('https://c.kuaishou.com/fw/user/3xuemaqzwetdhxk?cc=share_copylink').route,
        '/kuaishou/profile/3xuemaqzwetdhxk?format=json',
    );
});

test('extracts author lookup identifiers from work-link destinations', () => {
    assert.equal(extractBilibiliVideoId('https://www.bilibili.com/video/BV1hzqrBtEMP/'), 'BV1hzqrBtEMP');
    assert.equal(
        extractKuaishouProfileId('https://example.m.chenzhongtech.com/fw/photo/abc?photoId=abc&userId=3xqyrifragrg9r4'),
        '3xqyrifragrg9r4',
    );
    assert.equal(isXiaohongshuWorkUrl('https://www.xiaohongshu.com/discovery/item/6a3d564f000000000602275c'), true);
    assert.equal(isToutiaoWorkUrl('https://m.toutiao.com/video/7675903031293199106/'), true);
    assert.equal(extractToutiaoUserToken('/c/user/token/MS4wLjABAAAAexample/?source=tuwen_detail'), 'MS4wLjABAAAAexample');
});

test('recovers the intended Xiaohongshu page from its redirect error URL', () => {
    const target = 'https://www.xiaohongshu.com/discovery/item/6a3d564f000000000602275c?xsec_source=app_share';
    const errorUrl = `https://www.xiaohongshu.com/404?redirectPath=${encodeURIComponent(target)}&error_code=300031`;
    assert.equal(extractXiaohongshuRedirectTarget(errorUrl), target);
});

test('extracts the Xiaohongshu author from the note initial state', () => {
    const state = {
        note: {
            firstNoteId: '6a6cbbec0000000022012542',
            noteDetailMap: {
                '6a6cbbec0000000022012542': { note: { user: { userId: '5d24e90d0000000010038975' } } },
            },
        },
    };
    const html = `<script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>`;
    assert.equal(findXiaohongshuAuthorIdFromHtml(html), '5d24e90d0000000010038975');
});

test('removes share tracking parameters from resolved profile URLs', () => {
    assert.equal(
        canonicalizeProfileUrl('https://www.iesdouyin.com/share/user/MS4wLjABAAAAlegacy?sec_uid=MS4wLjABAAAAlegacy&from_ssr=1'),
        'https://www.douyin.com/user/MS4wLjABAAAAlegacy',
    );
    assert.equal(
        canonicalizeProfileUrl('https://www.xiaohongshu.com/user/profile/666142dc00000000070059bf?xsec_token=secret&xsec_source=app_share'),
        'https://www.xiaohongshu.com/user/profile/666142dc00000000070059bf',
    );
    assert.equal(
        canonicalizeProfileUrl('https://live.kuaishou.com/profile/3xuemaqzwetdhxk?shareToken=secret'),
        'https://www.kuaishou.com/profile/3xuemaqzwetdhxk',
    );
    assert.equal(
        canonicalizeProfileUrl('https://www.dcdapp.com/user/profile/1638816251446276?gid=123'),
        'https://www.dongchedi.com/user/1638816251446276',
    );
});

test('rejects lookalike platform domains', () => {
    assert.throws(() => buildRoute('https://notdouyin.com/user/MS4wLjABAAAAexample'), /暂不支持该平台/);
});

test('does not collect commercial-platform profile links', () => {
    assert.throws(
        () => buildRoute('https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/593032945e87e77791e03696'),
        /请使用用户主页链接/,
    );
    assert.throws(() => buildRoute('https://www.xingtu.cn/ad/creator/example'), /暂不支持该平台/);
});

test('builds the existing Phoenix author feed route from an ishare profile', () => {
    const route = buildRoute('https://ishare.ifeng.com/mediaShare/home/1503934/media');
    assert.equal(route.route, '/ifeng/feng/1503934/doc?format=json');
});

test('extracts a 56.com author profile and work details without trusting unrelated DOM dates', () => {
    const workHtml = `
        <script>var video_info = {"save_time":1585036051,"user_id":"shunm_56113303140"};</script>
        <script type="application/ld+json">{"@type":"VideoObject","name":"测试作品","uploadDate":"2020-03-24T15:47:31+08:00","embedUrl":"https://www.56.com/u71/v_MTYzNTQ2MTI0.html"}</script>
        <a href="//i.56.com/u/shunm_56113303140/">作者主页</a>`;
    assert.equal(findVideo56AuthorProfileFromHtml(workHtml), 'https://i.56.com/u/shunm_56113303140/');
    assert.deepEqual(parseVideo56WorkHtml(workHtml, 'https://www.56.com/u71/v_MTYzNTQ2MTI0.html'), {
        title: '测试作品',
        url: 'https://www.56.com/u71/v_MTYzNTQ2MTI0.html',
        date_published: '2020-03-24T07:47:31.000Z',
    });

    const profileHtml = `
        <a href="https://www.56.com/u90/v_MTc2MjM0Njg3.html">第一条</a>
        <a href="https://www.56.com/u90/v_MTc2MjM0Njg3.html">重复链接</a>
        <a href="/u71/v_MTYzNTQ2MTI0.html">第二条</a>`;
    assert.deepEqual(extractVideo56WorkLinks(profileHtml), [
        'https://www.56.com/u90/v_MTc2MjM0Njg3.html',
        'https://www.56.com/u71/v_MTYzNTQ2MTI0.html',
    ]);
});

test('decodes the Sohu Video author id from legacy work URLs', () => {
    assert.equal(
        extractSohuVideoAuthorId('https://tv.sohu.com/v/dXMvMzU3ODgxNTczLzE4NTY0MTAzOC5zaHRtbA==.html'),
        '357881573',
    );
    assert.equal(extractSohuVideoAuthorId('https://tv.sohu.com/user/336238776'), '336238776');
});

test('finds the maximum date instead of trusting the first item', () => {
    const latest = findLatestItem([
        { title: '置顶旧作品', date_published: '2024-01-01T00:00:00Z' },
        { title: '真正最新作品', date_published: '2026-08-25T01:02:03Z' },
        { title: '无日期作品' },
    ]);
    assert.equal(latest.title, '真正最新作品');
});

test('normalizes absolute and Beijing-relative publication dates', () => {
    const now = Date.parse('2026-09-01T04:00:00Z');
    assert.equal(parsePublicationDate('3天前', { now }), now - 3 * 86_400_000);
    assert.equal(parsePublicationDate('昨天 21:30', { now }), Date.parse('2026-08-31T13:30:00Z'));
    assert.equal(parsePublicationDate('2026-08-20 12:00:00', { now }), Date.parse('2026-08-20T04:00:00Z'));
    assert.equal(parsePublicationDate('2026-08-20T12:00:00Z', { now }), Date.parse('2026-08-20T12:00:00Z'));
});

test('generic platform feeds sort by time and reject config or future timestamps', () => {
    const now = Date.parse('2026-09-01T04:00:00Z');
    const feed = normalizeGenericFeed({
        title: '示例作者',
        responseCandidates: [
            { title: '置顶旧作品', url: '/old', date: '2025-01-01 10:00:00' },
            { title: '真正最新作品', url: '/latest', date: '3天前' },
            { title: '配置项', url: '/config', date: '1999-01-01' },
            { title: '未来错误', url: '/future', date: '2027-01-01' },
        ],
    }, { platform: '示例平台', profileUrl: 'https://example.com/user/1', now });
    assert.equal(feed.items.length, 2);
    assert.equal(feed.items[0].title, '真正最新作品');
    assert.equal(feed.items[0].url, 'https://example.com/latest');
});

test('normalizes Tencent News homepage API article and video timestamps', () => {
    const feed = normalizeTencentNewsFeed({
        ret: 0,
        userinfo: { nick: '腾讯作者', suid: 'author-suid', pubnum: 2 },
    }, [{
        ret: 0,
        newslist: [
            { id: 'old', title: '置顶旧文章', pub_time: 1_700_000_000, url: 'https://news.qq.com/rain/a/old' },
            { id: 'new', title: '最新视频', time: 1_770_000_000, share_url: 'https://view.inews.qq.com/a/new' },
        ],
    }]);
    assert.equal(feed.title, '腾讯作者');
    assert.equal(feed.items.length, 2);
    assert.equal(findLatestItem(feed.items).title, '最新视频');
    assert.equal(findLatestItem(feed.items).date_published, new Date(1_770_000_000_000).toISOString());
});

test('normalizes Tencent Video personal-page complex JSON timestamps', () => {
    const encode = (value) => Buffer.from(value, 'utf8').toString('base64');
    const complex = {
        base: { time: '1627279347' },
        user: { base: { name: encode('腾讯视频作者') } },
        videos: [{
            videoBase: { vid: encode('r3263argryu') },
            videoAttr: { title: encode('最新腾讯作品') },
        }],
    };
    const feed = normalizeTencentVideoFeed({
        data: {
            module_list_datas: [{
                module_datas: [{
                    item_data_lists: { item_datas: [{ complex_json: JSON.stringify(complex) }] },
                }],
            }],
        },
    });
    assert.equal(feed.title, '腾讯视频作者');
    assert.equal(feed.items.length, 1);
    assert.equal(feed.items[0].title, '最新腾讯作品');
    assert.equal(feed.items[0].url, 'https://v.qq.com/x/page/r3263argryu.html');
    assert.equal(feed.items[0].date_published, new Date(1_627_279_347_000).toISOString());
});

test('parses Yiche percent-encoded server diagnostics containing the profile work list', () => {
    const response = {
        status: '1',
        data: { list: [
            { id: 'old', title: '旧作品', publishTimestamp: 1_700_000_000_000, link: 'https://hao.yiche.com/wenzhang/old/' },
            { id: 'new', title: '新作品', publishTime: '2026-08-20 12:34:56', link: 'https://hao.yiche.com/wenzhang/new/' },
        ] },
    };
    const diagnostic = [{ errCode: 0, logMsg: `reqUrl="profile";resData="${JSON.stringify(response)}";` }];
    const html = `<title>易车作者的全部</title><div data-log="${encodeURIComponent(JSON.stringify(diagnostic))}"></div>`;
    const feed = parseYicheProfileHtml(html, 'https://i.yiche.com/u123/!all/', { now: Date.parse('2026-09-01T00:00:00Z') });
    assert.equal(feed.title, '易车作者的全部');
    assert.equal(feed.items.length, 2);
    assert.equal(findLatestItem(feed.items).title, '新作品');
});

test('normalizes Phoenix official author list JSONP payloads', () => {
    const feed = normalizeIfengFeed([
        'getListData({"code":0,"data":[{"title":"旧文章","newsTime":"2025-01-01 10:00:00","url":"//news.ifeng.com/c/old"}]})',
        'getListData({"code":0,"data":[{"title":"新视频","newsTime":"2026-08-20 08:00:00","url":"//v.ifeng.com/c/new"}]})',
    ], { authorId: '123', now: Date.parse('2026-09-01T00:00:00Z') });
    assert.equal(feed.items.length, 2);
    assert.equal(findLatestItem(feed.items).title, '新视频');
    assert.equal(findLatestItem(feed.items).url, 'https://v.ifeng.com/c/new');
});

test('parses AutoHome profile cards without mistaking the server footer for a work date', () => {
    const html = `<title>车家号作者</title>
        <section class="module-card" data-info-id="2"><div class="cont"><p>最新作品</p><b class="publishDate">2026-08-20</b></div></section>
        <section class="module-card" data-info-id="1"><div class="cont"><p>旧作品</p><b class="publishDate">2025-12-02</b></div></section>
        <!--2026-09-02 14:15:13-->`;
    const feed = parseAutohomeProfileHtml(html, 'https://chejiahao.m.autohome.com.cn/Authors/123', { now: Date.parse('2026-09-01T00:00:00Z') });
    assert.equal(feed.items.length, 2);
    assert.equal(findLatestItem(feed.items).title, '最新作品');
});

test('parses AutoHome legacy author rows with their visible publication time', () => {
    const html = `<title>车家号旧版作者</title>
        <div pageId="1787146468000,26290590" data-rowindex="1" data-infoid="26290590" class="author-vr identclass box videoV">
            <a href="/info/26290590"><div class="title">最新视频</div></a>
            <div class="author-info"><div class="info fn-right"><span>2026-08-19 05:34</span></div></div>
        </div>
        <div pageId="1764109403000,24541690" data-rowindex="2" data-infoid="24541690" class="author-vr identclass box videoV">
            <a href="/info/24541690"><div class="title">旧视频</div></a>
            <div class="author-info"><div class="info fn-right"><span>2025-11-25 22:23</span></div></div>
        </div>`;
    const feed = parseAutohomeProfileHtml(html, 'http://chejiahao.autohome.com.cn/Authors/300553750', { now: Date.parse('2026-09-01T00:00:00Z') });
    assert.equal(feed.items.length, 2);
    assert.equal(findLatestItem(feed.items).title, '最新视频');
    assert.equal(findLatestItem(feed.items).url, 'https://chejiahao.autohome.com.cn/info/26290590');
});

test('normalizes Kuaishou GraphQL feeds with millisecond timestamps', () => {
    const feed = normalizeKuaishouFeed({
        data: {
            visionProfilePhotoList: {
                result: 1,
                hostName: '测试作者',
                feeds: [
                    { author: { name: '测试作者' }, photo: { id: 'old-pinned', caption: '置顶旧作品', timestamp: 1_704_067_200_000, profileUserTopPhoto: true } },
                    { author: { name: '测试作者' }, photo: { id: 'latest', caption: '真正最新作品', timestamp: 1_788_221_400_000 } },
                ],
            },
        },
    });

    assert.equal(feed.result, 1);
    assert.equal(feed.title, '测试作者');
    assert.equal(feed.items.length, 2);
    assert.equal(feed.items[1].url, 'https://www.kuaishou.com/short-video/latest');
    assert.equal(feed.items[1].date_published, '2026-09-01T00:10:00.000Z');
    assert.equal(findLatestItem(feed.items).title, '真正最新作品');
});

test('normalizes second timestamps and drops invalid Kuaishou dates', () => {
    const feed = normalizeKuaishouFeed({
        data: {
            visionProfilePhotoList: {
                result: 1,
                feeds: [
                    { author: { name: '作者' }, photo: { id: 'seconds', timestamp: 1_788_221_400 } },
                    { author: { name: '作者' }, photo: { id: 'invalid', timestamp: 'not-a-date' } },
                ],
            },
        },
    });

    assert.equal(feed.items[0].date_published, '2026-09-01T00:10:00.000Z');
    assert.equal(feed.items[1].date_published, undefined);
});

test('normalizes browser-native Kuaishou works only from explicit timestamps', () => {
    const feed = normalizeKuaishouNativeFeed({
        data: {
            result: 1,
            hostName: '原生作者',
            list: [
                { id: 'old', caption: '旧作品', createTime: 1_788_221_400 },
                { id: 'new', caption: '新作品', publish_timestamp: 1_788_307_800_000 },
                { id: 'no-date', caption: '没有明确时间', photoUrls: ['https://cdn.example/2026-09-02/image.jpg'] },
            ],
        },
    });
    assert.equal(feed.result, 1);
    assert.equal(feed.title, '原生作者');
    assert.equal(feed.items[0].date_published, '2026-09-01T00:10:00.000Z');
    assert.equal(feed.items[1].date_published, '2026-09-02T00:10:00.000Z');
    assert.equal(feed.items[2].date_published, undefined);
    assert.equal(findLatestItem(feed.items).title, '新作品');
});

test('normalizes Xiaohongshu note detail timestamps in milliseconds', () => {
    const feed = normalizeXiaohongshuFeed({
        nickname: '小红书作者',
        items: [
            { id: 'note-old', title: '旧置顶', timestamp: 1_700_000_000_000 },
            { id: 'note-new', title: '新作品', timestamp: 1_800_000_000_000 },
        ],
    });
    assert.equal(feed.title, '小红书作者');
    assert.equal(feed.items[1].url, 'https://www.xiaohongshu.com/explore/note-new');
    assert.equal(feed.items[1].date_published, new Date(1_800_000_000_000).toISOString());
    assert.equal(findLatestItem(feed.items).title, '新作品');
});

test('normalizes Toutiao profile feed second timestamps', () => {
    const feed = normalizeToutiaoFeed({ data: [
        { id: '100', title: '文章', publish_time: 1_800_000_000, cell_type: 60, user_info: { name: '头条作者' } },
        { id: '101', content: '微头条正文\n第二行', publish_time: 1_700_000_000, cell_type: 32, user: { name: '头条作者' } },
    ] });
    assert.equal(feed.title, '头条作者');
    assert.equal(feed.items[0].url, 'https://www.toutiao.com/article/100/');
    assert.equal(feed.items[0].date_published, new Date(1_800_000_000_000).toISOString());
    assert.equal(feed.items[1].title, '微头条正文');
});

test('normalizes Bilibili WBI archive responses', () => {
    const feed = normalizeBilibiliFeed({
        code: 0,
        data: { list: { vlist: [
            { bvid: 'BV1fixture', aid: 1, title: 'B站作品', created: 1_800_000_000, author: 'UP主' },
        ] } },
    });
    assert.equal(feed.title, 'UP主');
    assert.equal(feed.items[0].url, 'https://www.bilibili.com/video/BV1fixture');
    assert.equal(feed.items[0].date_published, new Date(1_800_000_000_000).toISOString());
});

test('normalizes iQiyi creator API details and ignores unrelated page weather dates', () => {
    const feed = normalizeIqiyiFeed({ data: { sort: { flows: [{ qipuId: 'old' }, { qipuId: 'new' }] } } }, {
        data: {
            old: { qipuId: 'old', title: '置顶旧作品', timeCreate: 1_700_000_000_000, pageUrl: 'https://www.iqiyi.com/v_old.html', nickname: '爱奇艺作者' },
            new: { qipuId: 'new', title: '真正最新作品', timeCreate: 1_800_000_000_000, pageUrl: 'https://www.iqiyi.com/v_new.html', nickname: '爱奇艺作者' },
        },
    });
    assert.equal(feed.items.length, 2);
    assert.equal(feed.items[1].date_published, new Date(1_800_000_000_000).toISOString());
    assert.equal(findLatestItem(feed.items).title, '真正最新作品');
});

test('rejects expired cookies before sending them to a platform', () => {
    assert.equal(isCookieUsable({ name: 'valid', value: '1', expirationDate: 2_000 }, 1_000), true);
    assert.equal(isCookieUsable({ name: 'expired', value: '1', expirationDate: 999 }, 1_000), false);
    assert.equal(isCookieUsable({ name: 'session', value: '1' }, 1_000), true);
});

test('formats time in Asia/Shanghai', () => {
    assert.equal(formatBeijingTime('2026-08-25T01:02:03Z'), '2026-08-25 09:02:03');
});
