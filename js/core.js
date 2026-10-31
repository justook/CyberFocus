/**
 * core.js —— CyberFocus 纯逻辑层
 *
 * 设计约束（重要，勿改）：
 * 1. 零依赖、零构建。浏览器用 <script src="js/core.js"> 直接引入，挂到 window.CyberCore；
 *    Node 用 require('./js/core.js') 直接跑测试。两条路径共用同一份代码。
 * 2. 本文件内**不允许**出现 DOM 查询、localStorage、fetch、定时器。
 *    环境信息（location.href、当前时间）一律参数优先——调用方（index.html 的包装层）
 *    恒传参；函数内仅保留「参数缺省时的合理回退」，便于 core.js 被单独 require 时也能工作。
 * 3. 导出函数的对外契约（入参形状 / 返回形状）与 index.html 重构前完全一致。
 *
 * 抽出目的：把项目里最复杂、最容易出错、历史上修过多次的三段逻辑集中到可测单元，
 * 为后续拆分文件（阶段五第 22 项）留出第一个落点。
 * 对应分析报告：第 9.6 节「可测试性」。
 *
 * ── 与 index.html 原实现的全部行为差异（差分测试确认）──────────────────────
 * 随机任务树差分对比（两组独立验证：5154 组 + 20000 组），legacyProgress 为数值时
 * progress / hasProgress **零差异**。全部差异集中在「脏数据容错」路径上，
 * 应用内正常代码路径不会触发（legacyProgress 只会由代码写成数字）：
 *   ① legacyProgress 为字符串 "40"（只会因手改 localStorage 出现）：
 *      原实现 `currentVal = legacy` 后 `currentVal += share` 触发字符串拼接，
 *      "40" + 50 → "4050" → Math.min 后父任务永远显示 100%；
 *      本实现 Number() 归一化后为 40 + 50 = 90（正确值）。
 *   ② legacyProgress 为 "abc"：原实现算出 NaN 并把 "NaN%" 打进 DOM；
 *      本实现归零按 0 处理。
 *   ③ task 传 null / allTasks 传非数组：原实现直接抛 TypeError；
 *      本实现容错返回（应用内不可达，纯防御）。
 * 以上均为有意的边界修复，不是重构副作用。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
        // 纯 Node 环境：走 CJS 供单测 require。
        // 额外要求 window 不存在：防止 Electron(nodeIntegration) 等注入了 module
        // 的浏览器宿主误入此分支，导致 window.CyberCore 永远挂不上。
        module.exports = factory();
    } else {
        root.CyberCore = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /**
     * 计算单个任务的进度。
     *
     * 规则（与 index.html 原实现逐行等价）：
     *   progress = legacyProgress + Σ(已完成子任务的贡献)
     *   子任务贡献 = 显式 contribution（parseInt 后 > 0）
     *              ? contribution
     *              : (100 - legacyProgress - 已分配总和) / 未分配子任务数
     *
     * 只统计**直接子任务**，不递归——父任务进度由子任务各自算好后再汇总，递归会重复计数。
     *
     * @param {object} task      目标任务
     * @param {Array}  allTasks  全量任务数组（扁平结构 + parentId 组树）
     * @returns {{ progress: number, hasProgress: boolean, childCount: number }}
     *   - progress:    0–100 的整数
     *   - hasProgress: 是否展示进度条。有子任务或有过保留进度才展示，
     *                  否则一个孤立的已完成任务会显示「100%」而不是一个勾
     *   - childCount:  直接子任务数量（调用方按需取用）
     */
    function calcTaskProgress(task, allTasks) {
        task = task || {};
        const list = Array.isArray(allTasks) ? allTasks : [];
        const children = list.filter(t => t && t.parentId === task.id);

        // 原实现是 `item.legacyProgress || 0`，此处收紧为数值：
        // 手改过 localStorage 存成 "abc" 时，原代码会算出 NaN 并把 "NaN%" 打进 DOM。
        const legacy = Number(task.legacyProgress) || 0;
        const childCount = children.length;
        const hasProgress = childCount > 0 || legacy > 0;

        // 无子任务、无保留进度：纯叶子任务，进度就是「完成 / 未完成」两态
        if (!hasProgress) {
            return { progress: task.done ? 100 : 0, hasProgress: false, childCount: 0 };
        }

        let assignedPercent = 0;
        let unassignedCount = 0;

        children.forEach(c => {
            if (c.contribution && parseInt(c.contribution) > 0) {
                assignedPercent += parseInt(c.contribution);
            } else {
                unassignedCount++;
            }
        });

        // 剩余可分配空间。显式权重加起来超过 100 时钳到 0，不产生负权重
        const remainingPercent = Math.max(0, 100 - legacy - assignedPercent);
        const defaultShare = unassignedCount > 0 ? (remainingPercent / unassignedCount) : 0;

        let currentVal = legacy;
        children.forEach(c => {
            if (c.done) {
                const share = (c.contribution && parseInt(c.contribution) > 0)
                    ? parseInt(c.contribution)
                    : defaultShare;
                currentVal += share;
            }
        });

        return {
            progress: Math.min(100, Math.round(currentVal)),
            hasProgress: true,
            childCount
        };
    }

    /**
     * 把任意来源的热榜条目 URL 归一化成可直接 href 的绝对地址。
     * 只放行 http/https —— javascript: 之类的协议一律丢弃，避免点了热搜执行脚本。
     *
     * @param {*}      value     原始 url / link / href 字段
     * @param {string} [baseHref] 解析相对路径用的基准地址（浏览器传 location.href）
     * @returns {string} 合法的绝对 URL，或空串
     */
    function normalizeTrendUrl(value, baseHref) {
        if (!value) return '';
        try {
            const base = baseHref
                || (typeof location !== 'undefined' ? location.href : 'http://localhost/');
            const url = new URL(value, base);
            return /^https?:$/.test(url.protocol) ? url.href : '';
        } catch (e) {
            return '';
        }
    }

    /**
     * 把各热榜源五花八门的响应结构压成统一形状：[{ title, url, hotValue }]。
     *
     * 兼容点：
     *   - 外层容器可能是 data.list / data.items / data.data
     *   - 元素可能是纯字符串（知乎类接口只给标题）
     *   - 标题字段可能是 title / name / word
     *   - 热度字段可能是 hot_value / hotValue / hot / extra.hot
     *   - 无标题的条目直接丢弃（渲染出来是空白行）
     *
     * @param {*}      data
     * @param {string} [baseHref] 透传给 normalizeTrendUrl
     * @returns {Array<{title: string, url: string, hotValue: string}>}
     */
    function normalizeTrendItems(data, baseHref) {
        data = data || {};
        const rawList = Array.isArray(data.list)
            ? data.list
            : Array.isArray(data.items)
                ? data.items
                : Array.isArray(data.data)
                    ? data.data
                    : [];

        return rawList.map(item => {
            if (typeof item === 'string') {
                return { title: item, url: '', hotValue: '' };
            }

            item = item || {};
            const title = String(item.title || item.name || item.word || '').trim();
            const url = normalizeTrendUrl(item.url || item.link || item.href, baseHref);
            const hotValue = item.hot_value
                || item.hotValue
                || item.hot
                || (item.extra && item.extra.hot)
                || '';

            return {
                title,
                url,
                hotValue: hotValue === null || hotValue === undefined ? '' : String(hotValue)
            };
        }).filter(item => item.title);
    }

    /**
     * 截止时间的展示状态。三档阈值：已逾期 / < 24h 按小时 / < 72h 按天 / 其余显示日期。
     *
     * @param {string} deadlineStr datetime-local 的字符串，如 "2026-10-31T23:59"
     * @param {boolean} isDone     已完成的任务不再提示倒计时
     * @param {number} [now]       注入当前时间戳（毫秒），测试用；不传则取 Date.now()
     * @returns {{ class: 'urgent'|'warning'|'normal', text: string }}
     *
     * 已知缺陷（保持原样，不在本次抽离中修改行为）：
     *   deadlineStr 为空时 `new Date('')` 得到 Invalid Date，会落到最后一档并显示 "Invalid Date"。
     *   修它会改变现有 UI 文案，留待后续单独评估。
     */
    function getDeadlineStatus(deadlineStr, isDone, now) {
        if (isDone) return { class: 'normal', text: '已完成' };

        const nowMs = typeof now === 'number' ? now : Date.now();
        const due = new Date(deadlineStr);
        const diffHours = (due - nowMs) / (1000 * 60 * 60);

        if (diffHours < 0) return { class: 'urgent', text: '已逾期' };
        if (diffHours < 24) return { class: 'urgent', text: '剩余 ' + Math.ceil(diffHours) + ' 小时' };
        if (diffHours < 72) return { class: 'warning', text: '剩余 ' + Math.ceil(diffHours / 24) + ' 天' };

        return { class: 'normal', text: due.toLocaleDateString() };
    }

    return {
        calcTaskProgress: calcTaskProgress,
        normalizeTrendUrl: normalizeTrendUrl,
        normalizeTrendItems: normalizeTrendItems,
        getDeadlineStatus: getDeadlineStatus
    };
});
