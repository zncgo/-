const PLATFORM_KEY_BY_LABEL = new Map([
    ['抖音', 'douyin'], ['小红书', 'xiaohongshu'], ['快手', 'kuaishou'], ['B站', 'bilibili'],
    ['微博', 'weibo'], ['知乎', 'zhihu'], ['今日头条', 'toutiao'], ['网易新闻', 'netease'],
    ['懂车帝', 'dongchedi'], ['一点资讯', 'yidian'], ['UC大鱼', 'ucdayu'], ['搜狐新闻', 'sohu_news'],
    ['腾讯新闻', 'tencent_news'], ['凤凰新闻', 'ifeng'], ['百度新闻', 'baijiahao'], ['汽车之家', 'autohome'],
    ['爱卡汽车', 'xcar'], ['汽车头条', 'qctt'], ['太平洋汽车', 'pcauto'], ['网上车市', 'cheshi'],
    ['易车', 'yiche'], ['爱奇艺', 'iqiyi'], ['优酷/土豆视频', 'youku'], ['腾讯视频', 'tencent_video'],
    ['美拍', 'meipai'], ['搜狐视频', 'sohu_video'], ['56视频', 'video56'], ['秒拍', 'miaopai'], ['西瓜视频', 'ixigua'],
]);

export function workbookPlatformKey(platformLabel) {
    return PLATFORM_KEY_BY_LABEL.get(String(platformLabel ?? '').trim()) ?? '';
}

export function workbookPlatformCapacity(platformLabel, cookieSnapshot = {}) {
    const key = workbookPlatformKey(platformLabel);
    const summary = (cookieSnapshot.platforms ?? []).find((item) => item.platform === key);
    if (!summary) return 1;
    const configured = Math.max(1, Number(summary.perCookieConcurrency) || 1);
    const usableMembers = (summary.members ?? []).filter((member) => ['healthy', 'pending'].includes(member.status)).length;
    return Math.max(1, Number(summary.totalCapacity) || usableMembers * configured || 1);
}

export function shortWorkbookError(value, fallback = '抓取失败') {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return (text || fallback).slice(0, 80);
}

export function isNoCollectableWorkbookMessage(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return /无可采集对象|(?:主页|用户|账号|内容).{0,18}(?:用户或内容)?不存在|(?:用户|账号).{0,12}已注销|内容.{0,12}已下线|(?:作者)?链接已失效|跳转到平台首页|主页当前没有作品|主页没有作品|主页没有返回公开作品数据|主页作品接口没有返回数据|主页没有找到作品链接|请使用用户主页链接/i.test(text);
}

export function classifyWorkbookFailure(value, { noDate = false } = {}) {
    const raw = shortWorkbookError(value, noDate ? '没有获取到作品时间' : '抓取失败');
    const rules = noDate ? [
        { category: '无作品时间', retryable: false, pattern: /./ },
    ] : [
        { category: '无可采集对象', retryable: false, noTarget: true, pattern: /无可采集对象|(?:主页|用户|账号|内容).{0,18}(?:用户或内容)?不存在|(?:用户|账号).{0,12}已注销|内容.{0,12}已下线|(?:作者)?链接已失效|跳转到平台首页|主页当前没有作品|主页没有作品|主页没有返回公开作品数据|主页作品接口没有返回数据|主页没有找到作品链接|请使用用户主页链接/i },
        // 验证码/人机验证需要真人在可见浏览器中完成；批量重试只会重复触发平台风控。
        { category: '人机验证', retryable: false, pattern: /人机验证|安全验证|完成验证|验证码/i },
        { category: '浏览器环境拦截', retryable: false, pattern: /Docker\s*浏览器环境|无头浏览器环境|环境未获平台接受/i },
        { category: '缺少可用Cookie', retryable: false, pattern: /没有(?:找到)?可用的?.{0,24}Cookie|无可用.{0,24}Cookie/i },
        { category: '用户不存在', retryable: false, pattern: /用户(?:或内容)?不存在|账号不存在|用户已注销|内容不存在/i },
        { category: '链接失效', retryable: false, pattern: /链接已失效|作者链接已失效|跳转到平台首页|页面已删除|文章不存在/i },
        { category: '页面不存在', retryable: false, pattern: /HTTP\s*404|\b404\b/i },
        { category: '访问受限', retryable: false, pattern: /HTTP\s*(?:401|403)|\b(?:401|403)\b|需要登录|登录墙/i },
        { category: '请求异常', retryable: false, pattern: /HTTP\s*400|\b400\b/i },
        { category: '请求超时', retryable: true, pattern: /HTTP\s*408|\b408\b|请求超时|连接超时|持续加载/i },
        { category: '临时风控', retryable: true, pattern: /HTTP\s*429|\b429\b|风控|请求频繁|访问频繁|稍后重试/i },
        { category: '未提取到时间', retryable: false, pattern: /没有提取到明确作品发布时间|未显示明确发布时间|没有找到.*发布时间/i },
        { category: '平台临时异常', retryable: true, pattern: /HTTP\s*5\d\d|\b5\d\d\b|Bad Gateway|Service Unavailable/i },
        { category: '连接异常', retryable: true, pattern: /连接异常|连接失败|网络异常|界面无法连接|socket|ECONN|fetch failed/i },
    ];
    const matched = rules.find((rule) => rule.pattern.test(raw)) ?? { category: '抓取失败', retryable: true };
    const prefix = `【${matched.category}】`;
    return {
        category: matched.category,
        retryable: matched.retryable,
        noTarget: matched.noTarget === true,
        error: shortWorkbookError(raw.startsWith(prefix) ? raw : `${prefix}${raw}`),
    };
}

export function createWorkbookRetryPlan(plan, states = []) {
    const failedKeys = new Set(states
        .filter((state) => state.status === 'error' && state.retryable !== false)
        .map((state) => state.key));
    const tasks = (plan?.tasks ?? []).filter((task) => failedKeys.has(task.key));
    return {
        ...plan,
        tasks,
        uniqueTaskCount: tasks.length,
        occurrenceCount: tasks.reduce((total, task) => total + Math.max(1, task.occurrences?.length ?? 0), 0),
    };
}

export function mergeWorkbookTaskStates(firstRoundStates = [], retryStates = [], attempt = 2) {
    const retryByKey = new Map(retryStates.map((state) => [state.key, { ...state, attempt }]));
    return firstRoundStates.map((state) => retryByKey.get(state.key) ?? { ...state, attempt: state.attempt ?? 1 });
}

function normalizedResult(payload) {
    if (payload?.ok && payload.status === 'success' && payload.latestTime) {
        return { status: 'success', latestTime: payload.latestTime };
    }
    if (payload?.ok && payload.status === 'no_date') {
        return { status: 'no_date', ...classifyWorkbookFailure(payload.error, { noDate: true }) };
    }
    if (payload?.status === 'no_target' || isNoCollectableWorkbookMessage(payload?.error)) {
        return { status: 'no_target', ...classifyWorkbookFailure(payload?.error) };
    }
    const failure = classifyWorkbookFailure(payload?.error);
    return { status: failure.noTarget ? 'no_target' : 'error', ...failure };
}

function storedResult(result) {
    return result.status === 'success'
        ? { status: 'success', latestTime: result.latestTime }
        : { status: result.status, error: result.error };
}

export async function runWorkbookTasks(plan, {
    query,
    getCookieSnapshot = async () => ({ platforms: [] }),
    signal,
    onUpdate = () => {},
    globalLimit = 16,
} = {}) {
    if (typeof query !== 'function') throw new Error('缺少 Excel 查询函数');
    const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    const states = tasks.map((task) => ({ key: task.key, platform: task.platform, url: task.url, status: 'waiting', error: '', retryable: false, attempt: 1 }));
    const results = {};
    const active = new Map();
    const activeByPlatform = new Map();
    const limit = Math.max(1, Number(globalLimit) || 1);

    const emit = () => onUpdate({ states: states.map((state) => ({ ...state })), results: { ...results } });
    emit();

    const startTask = (index) => {
        const task = tasks[index];
        const lane = task.platform;
        states[index].status = 'running';
        activeByPlatform.set(lane, (activeByPlatform.get(lane) ?? 0) + 1);
        const execution = Promise.resolve()
            .then(() => query(task, { signal }))
            .then((payload) => {
                const result = normalizedResult(payload);
                results[task.key] = storedResult(result);
                states[index].status = result.status;
                states[index].error = result.error ?? '';
                states[index].retryable = Boolean(result.retryable);
            })
            .catch((error) => {
                if (signal?.aborted || error?.name === 'AbortError') {
                    states[index].status = 'stopped';
                    states[index].error = '已停止';
                    return;
                }
                const result = { status: 'error', ...classifyWorkbookFailure(error?.message) };
                results[task.key] = storedResult(result);
                states[index].status = 'error';
                states[index].error = result.error;
                states[index].retryable = result.retryable;
            })
            .finally(() => {
                active.delete(index);
                activeByPlatform.set(lane, Math.max(0, (activeByPlatform.get(lane) ?? 1) - 1));
                emit();
            });
        active.set(index, execution);
        emit();
    };

    while (states.some((state) => state.status === 'waiting') || active.size) {
        if (signal?.aborted) break;
        const snapshot = await getCookieSnapshot();
        let scheduled = false;
        while (active.size < limit) {
            const index = states.findIndex((state, candidateIndex) => state.status === 'waiting'
                && (activeByPlatform.get(tasks[candidateIndex].platform) ?? 0) < workbookPlatformCapacity(tasks[candidateIndex].platform, snapshot));
            if (index < 0) break;
            startTask(index);
            scheduled = true;
        }
        if (!active.size) break;
        if (!scheduled || active.size >= limit) await Promise.race(active.values());
    }

    if (signal?.aborted) {
        for (const state of states) {
            if (state.status === 'waiting') {
                state.status = 'stopped';
                state.error = '已停止';
            }
        }
        await Promise.allSettled(active.values());
        emit();
    }

    return { states, results, stopped: Boolean(signal?.aborted) };
}

export async function runWorkbookTasksWithRetry(plan, options = {}) {
    const {
        onUpdate = () => {},
        onRetryStart = () => {},
        maxRetryRounds = 3,
        ...runnerOptions
    } = options;
    const firstRound = await runWorkbookTasks(plan, { ...runnerOptions, onUpdate });
    let current = firstRound;
    let retryRoundCount = 0;
    let retryAttemptCount = 0;
    const retriedTaskKeys = new Set();
    const retryLimit = Math.max(0, Math.floor(Number(maxRetryRounds) || 0));

    while (!current.stopped && retryRoundCount < retryLimit) {
        const retryPlan = createWorkbookRetryPlan(plan, current.states);
        if (!retryPlan.tasks.length) break;
        retryRoundCount += 1;
        retryAttemptCount += retryPlan.tasks.length;
        for (const task of retryPlan.tasks) retriedTaskKeys.add(task.key);
        onRetryStart({
            retryRound: retryRoundCount,
            maxRetryRounds: retryLimit,
            retryCount: retryPlan.tasks.length,
            retryPlan,
        });
        const previous = current;
        const retryRun = await runWorkbookTasks(retryPlan, {
            ...runnerOptions,
            onUpdate: ({ states, results }) => onUpdate({
                states: mergeWorkbookTaskStates(previous.states, states, retryRoundCount + 1),
                results: { ...previous.results, ...results },
            }),
        });
        current = {
            states: mergeWorkbookTaskStates(previous.states, retryRun.states, retryRoundCount + 1),
            results: { ...previous.results, ...retryRun.results },
            stopped: retryRun.stopped,
        };
    }

    return {
        ...current,
        retriedTaskCount: retriedTaskKeys.size,
        retryRoundCount,
        retryAttemptCount,
    };
}
