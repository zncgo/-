import {
    createWorkbookPlan,
    inspectWorkbook,
    outputWorkbookName,
    setWorkbookZipEngine,
    validateWorkbookFile,
    verifyWorkbookOutput,
    writeWorkbookResults,
} from './workbook.mjs';
import { runWorkbookTasksWithRetry } from './workbook-runner.mjs';

setWorkbookZipEngine(globalThis.JSZip);

const ids = [
    'excelDropzone', 'excelFile', 'excelFileMeta', 'excelModeRefresh', 'excelModeContinue',
    'excelStartBtn', 'excelStopBtn', 'excelDownloadBtn', 'excelResetBtn', 'excelMessage',
    'excelSummary', 'excelPreview', 'excelProgressText', 'excelFidelityText', 'excelProgressBar',
];
const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const stateLabels = { waiting: '等待', running: '处理中', success: '成功', no_date: '无时间', no_target: '无可采集对象', error: '失败', stopped: '已停止' };
const state = {
    file: null,
    workbook: null,
    selections: {},
    plan: null,
    taskStates: [],
    results: {},
    outputBytes: null,
    verification: null,
    partial: false,
    controller: null,
    retrying: false,
    retryTotal: 0,
    retryRound: 0,
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);

function mode() {
    return elements.excelModeContinue.checked ? 'continue' : 'refresh';
}

function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function setMessage(message, type = '') {
    elements.excelMessage.textContent = message;
    elements.excelMessage.className = `excel-message ${type}`.trim();
}

function invalidateOutput() {
    state.outputBytes = null;
    state.verification = null;
    state.partial = false;
    elements.excelDownloadBtn.disabled = true;
    elements.excelFidelityText.textContent = '尚未生成输出';
}

function defaultSelections(workbook) {
    return Object.fromEntries(workbook.sheets
        .filter((sheet) => sheet.defaultCandidate)
        .map((sheet) => [sheet.name, sheet.defaultCandidate.columnIndex]));
}

function rebuildPlan() {
    if (!state.workbook) return;
    state.plan = createWorkbookPlan(state.workbook, { selections: state.selections, mode: mode() });
    state.taskStates = [];
    state.results = {};
    state.retrying = false;
    state.retryTotal = 0;
    state.retryRound = 0;
    invalidateOutput();
    renderWorkbook();
    setMessage(`${mode() === 'continue' ? '续跑模式' : '全部刷新'}：${state.plan.occurrenceCount} 条待查询链接，去重后 ${state.plan.uniqueTaskCount} 个账号。`, 'success');
}

function candidateOption(candidate, selected) {
    const warning = candidate.excludedFromDefault ? ' · 业务链接列' : '';
    const reuse = candidate.reusesTimeColumn ? ' · 复用右侧时间列' : ' · 新增时间列';
    const label = `${candidate.columnLetter} · ${candidate.header} · ${candidate.hitCount}条支持/${candidate.unsupportedCount}条不支持${reuse}${warning}`;
    return `<option value="${candidate.columnIndex}"${selected === candidate.columnIndex ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

function renderWorkbook() {
    if (!state.workbook || !state.plan) {
        elements.excelSummary.innerHTML = ['工作表', '链接记录', '去重账号', '跳过/不支持']
            .map((label) => `<div class="excel-stat"><strong>0</strong><span>${label}</span></div>`).join('');
        elements.excelPreview.innerHTML = '<div class="cookie-empty">导入工作簿后在这里选择每张表使用的链接列。</div>';
        return;
    }

    const stats = [
        [state.workbook.sheets.length, '工作表'],
        [state.plan.occurrenceCount, '链接记录'],
        [state.plan.uniqueTaskCount, '去重账号'],
        [state.plan.skippedUnsupported.length, '跳过/不支持'],
    ];
    elements.excelSummary.innerHTML = stats.map(([value, label]) => `<div class="excel-stat"><strong>${value}</strong><span>${label}</span></div>`).join('');
    elements.excelPreview.innerHTML = `<table><thead><tr><th>工作表</th><th>表头行</th><th>用于查询的链接列</th><th>回写方式</th></tr></thead><tbody>${state.workbook.sheets.map((sheet, index) => {
        const selected = Number(state.selections[sheet.name]);
        const selectedCandidate = sheet.candidates.find((candidate) => candidate.columnIndex === selected);
        const options = ['<option value="">不处理这张表</option>', ...sheet.candidates.map((candidate) => candidateOption(candidate, selected))].join('');
        const action = selectedCandidate
            ? (selectedCandidate.reusesTimeColumn ? '复用相邻“最新更新时间”' : '在链接列右侧新增')
            : '不修改';
        return `<tr><td class="excel-sheet-name">${escapeHtml(sheet.name)}<span class="excel-cell-note">${sheet.candidates.length}个候选列</span></td><td>${sheet.headerRow}</td><td><select data-excel-sheet-index="${index}" ${state.controller ? 'disabled' : ''}>${options}</select></td><td>${escapeHtml(action)}</td></tr>`;
    }).join('')}</tbody></table>`;
    elements.excelStartBtn.disabled = Boolean(state.controller) || state.plan.selectedSheets.length === 0;
}

function renderProgress() {
    const total = state.taskStates.length || state.plan?.uniqueTaskCount || 0;
    const completed = state.taskStates.filter((task) => ['success', 'no_date', 'no_target', 'error', 'stopped'].includes(task.status)).length;
    const success = state.taskStates.filter((task) => task.status === 'success').length;
    const noDate = state.taskStates.filter((task) => task.status === 'no_date').length;
    const noTarget = state.taskStates.filter((task) => task.status === 'no_target').length;
    const failed = state.taskStates.filter((task) => task.status === 'error').length;
    if (state.retrying) {
        const retryStates = state.taskStates.filter((task) => task.attempt === state.retryRound + 1);
        const retryCompleted = retryStates.filter((task) => ['success', 'no_date', 'no_target', 'error', 'stopped'].includes(task.status)).length;
        elements.excelProgressText.textContent = `第${state.retryRound}/3轮重试 · ${retryCompleted}/${state.retryTotal}完成 · 当前 ${success}成功 · ${failed}失败 · ${noDate}无时间 · ${noTarget}无可采集对象`;
        elements.excelProgressBar.style.width = state.retryTotal ? `${retryCompleted / state.retryTotal * 100}%` : '0%';
        return;
    }
    elements.excelProgressText.textContent = total
        ? `${completed}/${total}已完成 · ${success}成功 · ${failed}失败 · ${noDate}无时间 · ${noTarget}无可采集对象`
        : (state.workbook ? '已完成分析，等待开始' : '等待导入');
    elements.excelProgressBar.style.width = total ? `${completed / total * 100}%` : '0%';
}

async function loadWorkbook(file) {
    if (!file) return;
    if (state.controller) return;
    setMessage('正在本地解析工作簿…');
    elements.excelStartBtn.disabled = true;
    elements.excelResetBtn.disabled = true;
    invalidateOutput();
    try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await validateWorkbookFile({ name: file.name, size: file.size, bytes });
        const workbook = await inspectWorkbook(bytes, { fileName: file.name });
        state.file = file;
        state.workbook = workbook;
        state.selections = defaultSelections(workbook);
        state.taskStates = [];
        state.results = {};
        state.plan = createWorkbookPlan(workbook, { selections: state.selections, mode: mode() });
        elements.excelFileMeta.innerHTML = `<strong>${escapeHtml(file.name)}</strong>${formatBytes(file.size)} · ${workbook.sheets.length}张工作表 · 已在浏览器本地读取`;
        elements.excelResetBtn.disabled = false;
        setMessage(`识别到 ${state.plan.occurrenceCount} 条待查询链接，去重后 ${state.plan.uniqueTaskCount} 个账号。`, 'success');
        renderWorkbook();
        renderProgress();
    } catch (error) {
        resetWorkbook({ preserveMessage: true });
        setMessage(`导入失败：${error.message}`, 'error');
    } finally {
        elements.excelFile.value = '';
    }
}

async function cookieSnapshot() {
    const response = await fetch('/api/cookies');
    if (!response.ok) return { platforms: [] };
    return response.json();
}

async function startWorkbookRun() {
    if (!state.workbook || state.controller) return;
    state.plan = createWorkbookPlan(state.workbook, { selections: state.selections, mode: mode() });
    if (!state.plan.selectedSheets.length) {
        setMessage('请至少选择一张工作表的链接列。', 'error');
        return;
    }

    invalidateOutput();
    state.results = {};
    state.taskStates = [];
    state.retrying = false;
    state.retryTotal = 0;
    state.retryRound = 0;
    const controller = new AbortController();
    state.controller = controller;
    elements.excelStartBtn.disabled = true;
    elements.excelStopBtn.disabled = false;
    elements.excelResetBtn.disabled = true;
    renderWorkbook();
    setMessage('正在执行第一轮；全部结束后仅对超时、限流、5xx等临时失败最多自动重试三轮。');

    let cachedCookies = null;
    let cachedAt = 0;
    const getCookieSnapshot = async () => {
        if (cachedCookies && Date.now() - cachedAt < 1500) return cachedCookies;
        cachedCookies = await cookieSnapshot();
        cachedAt = Date.now();
        return cachedCookies;
    };

    try {
        const run = await runWorkbookTasksWithRetry(state.plan, {
            signal: controller.signal,
            getCookieSnapshot,
            query: async (task, { signal }) => {
                const response = await fetch(`/api/query?url=${encodeURIComponent(task.url)}`, { signal });
                return response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
            },
            onUpdate: ({ states, results }) => {
                state.taskStates = states;
                state.results = results;
                renderProgress();
            },
            onRetryStart: ({ retryRound, maxRetryRounds, retryCount }) => {
                state.retrying = true;
                state.retryTotal = retryCount;
                state.retryRound = retryRound;
                setMessage(`正在执行第 ${retryRound}/${maxRetryRounds} 轮自动重试：${retryCount} 个临时失败账号；无可采集对象、永久错误、成功和无时间项不重复请求。`);
                renderProgress();
            },
        });
        state.taskStates = run.states;
        state.results = run.results;
        state.retrying = false;
        state.partial = run.stopped;
        elements.excelFidelityText.textContent = '正在校验工作簿保真性…';
        const outputBytes = await writeWorkbookResults(state.workbook, { plan: state.plan, results: state.results });
        const verification = await verifyWorkbookOutput(state.workbook, { plan: state.plan, results: state.results, outputBytes });
        state.verification = verification;
        if (!verification.ok) {
            state.outputBytes = null;
            elements.excelDownloadBtn.disabled = true;
            elements.excelFidelityText.textContent = '保真校验失败';
            setMessage(`已阻止下载：${verification.errors.slice(0, 3).join('；')}`, 'error');
            return;
        }
        state.outputBytes = outputBytes;
        elements.excelDownloadBtn.disabled = false;
        elements.excelFidelityText.textContent = `保真校验通过 · ${verification.changedParts.length}个声明部件`;
        const retryText = run.retriedTaskCount
            ? `；${run.retriedTaskCount} 个失败账号共执行 ${run.retryRoundCount} 轮自动重试、累计 ${run.retryAttemptCount} 次请求`
            : '';
        setMessage(run.stopped ? '已停止；可下载已完成的部分结果，以后重新导入续跑。' : `全部任务已完成${retryText}，且输出已通过保真校验。`, 'success');
    } catch (error) {
        state.retrying = false;
        state.outputBytes = null;
        elements.excelDownloadBtn.disabled = true;
        elements.excelFidelityText.textContent = '未生成可下载文件';
        setMessage(`批量处理失败：${error.message}`, 'error');
    } finally {
        if (state.controller === controller) state.controller = null;
        elements.excelStopBtn.disabled = true;
        elements.excelResetBtn.disabled = false;
        elements.excelStartBtn.disabled = state.plan.selectedSheets.length === 0;
        renderWorkbook();
        renderProgress();
    }
}

function stopWorkbookRun() {
    if (!state.controller) return;
    elements.excelStopBtn.disabled = true;
    setMessage('正在停止，已完成的结果会被保留…');
    state.controller.abort();
}

function downloadWorkbook() {
    if (!state.outputBytes || !state.verification?.ok || !state.file) return;
    const blob = new Blob([state.outputBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = outputWorkbookName(state.file.name, { partial: state.partial });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
}

function resetWorkbook({ preserveMessage = false } = {}) {
    state.controller?.abort();
    state.file = null;
    state.workbook = null;
    state.selections = {};
    state.plan = null;
    state.taskStates = [];
    state.results = {};
    state.outputBytes = null;
    state.verification = null;
    state.partial = false;
    state.controller = null;
    state.retrying = false;
    state.retryTotal = 0;
    state.retryRound = 0;
    elements.excelFile.value = '';
    elements.excelFileMeta.textContent = '尚未选择工作簿';
    elements.excelStartBtn.disabled = true;
    elements.excelStopBtn.disabled = true;
    elements.excelDownloadBtn.disabled = true;
    elements.excelResetBtn.disabled = true;
    elements.excelFidelityText.textContent = '尚未生成输出';
    if (!preserveMessage) setMessage('选择文件后会自动识别工作表、表头和主页链接列。');
    renderWorkbook();
    renderProgress();
}

elements.excelDropzone.addEventListener('click', () => elements.excelFile.click());
elements.excelDropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        elements.excelFile.click();
    }
});
elements.excelFile.addEventListener('change', () => loadWorkbook(elements.excelFile.files[0]));
for (const eventName of ['dragenter', 'dragover']) {
    elements.excelDropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        elements.excelDropzone.classList.add('dragover');
    });
}
for (const eventName of ['dragleave', 'drop']) {
    elements.excelDropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        elements.excelDropzone.classList.remove('dragover');
    });
}
elements.excelDropzone.addEventListener('drop', (event) => loadWorkbook(event.dataTransfer?.files?.[0]));
elements.excelPreview.addEventListener('change', (event) => {
    const select = event.target.closest('[data-excel-sheet-index]');
    if (!select || !state.workbook || state.controller) return;
    const sheet = state.workbook.sheets[Number(select.dataset.excelSheetIndex)];
    if (!sheet) return;
    if (select.value) state.selections[sheet.name] = Number(select.value);
    else delete state.selections[sheet.name];
    rebuildPlan();
});
elements.excelModeRefresh.addEventListener('change', rebuildPlan);
elements.excelModeContinue.addEventListener('change', rebuildPlan);
elements.excelStartBtn.addEventListener('click', startWorkbookRun);
elements.excelStopBtn.addEventListener('click', stopWorkbookRun);
elements.excelDownloadBtn.addEventListener('click', downloadWorkbook);
elements.excelResetBtn.addEventListener('click', () => resetWorkbook());

resetWorkbook();
