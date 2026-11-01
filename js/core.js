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
 * 记账模块（第 4-9 节）沿用同一约束：预算口径、番茄币上限、存钱奖励、周报结论
 * 全部是纯函数，时间/数据一律参数注入 —— 这些规则改一个数字就会让钱账和币账对不上。
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

    /* =====================================================================
     * 记账 / 番茄币 / 攒钱 / 周报 —— 领域纯函数
     *
     * 全模块共用的口径（UI 文案必须与此一致，改口径先改这里 + 改测试）：
     *   本月剩余 = 总预算 − 本月全部支出（「储蓄」也算支出，它确实离开了生活费）
     *   今日可花 = (本月剩余 − 尚未存完的储蓄预算) ÷ 本月剩余天数
     *              —— 先把要存的钱扣出来，避免每天的「可花」把攒钱目标吃掉
     *   每周配额 = 分类预算 × 7 ÷ 当月天数（周报判「本周超支」用，月初月末不失真）
     *   番茄币   = 只由「自然走完的番茄钟」产生，有每日上限；币不是钱，不能换钱
     * ===================================================================== */

    // 固定的学生口径分类。改这里等于改数据字典：老数据里不认识的分类一律归「购物」。
    const LEDGER_EXPENSE_CATS = ['餐饮', '交通', '学习', '社交', '娱乐', '订阅', '购物', '医疗', '应急', '储蓄'];
    const LEDGER_INCOME_CATS = ['生活费', '兼职', '奖学金', '红包', '其他'];
    const LEDGER_ACCOUNTS = ['微信', '支付宝', '银行卡', '现金', '校园卡'];

    // 账户别名按「长别名优先」排列：先匹配校园卡/一卡通，否则会被「银行卡」的「卡」截胡
    const ACCOUNT_ALIASES = [
        ['校园卡', ['校园卡', '一卡通', '饭卡']],
        ['支付宝', ['支付宝', 'alipay']],
        ['微信', ['微信', 'wechat', 'weixin', 'wx']],
        ['银行卡', ['银行卡', '储蓄卡', '信用卡', '银行']],
        ['现金', ['现金', '现钞']]
    ];

    // 一句话记账的分类关键词。顺序即优先级：先命中先归。
    const CATEGORY_KEYWORDS = [
        ['餐饮', ['饭', '早餐', '早饭', '午餐', '午饭', '晚餐', '晚饭', '夜宵', '食堂', '外卖', '奶茶', '咖啡', '饮料', '水果', '零食', '烧烤', '火锅', '面', '粉', '包子', '饺子', '鸡', '汉堡', '探店']],
        ['交通', ['地铁', '公交', '打车', '出租', '滴滴', '高铁', '火车', '机票', '单车', '骑行', '油费', '停车', '车费', '路费', '船票']],
        ['学习', ['书', '教材', '打印', '复印', '网课', '课程', '学费', '考试', '报名', '文具', '笔记本', '论文', '资料', '四六级', '考研', '证书', '讲座']],
        ['社交', ['聚餐', '请客', '礼物', '生日', '约会', '团建', '随礼', '份子', 'AA', '红包']],
        ['娱乐', ['电影', '游戏', 'KTV', '唱歌', '演唱会', '门票', '剧本杀', '桌游', '视频会员', '演出', '展会', 'livehouse']],
        ['订阅', ['订阅', '会员', '月租', '话费', '流量', '云盘', 'icloud', 'netflix', 'spotify', 'wps', '续费', '套餐']],
        ['购物', ['衣服', '鞋', '裤', '外套', '日用品', '纸巾', '洗发', '护肤', '化妆', '数码', '耳机', '手机壳', '淘宝', '京东', '拼多多', '超市', '快递']],
        ['医疗', ['药', '医院', '挂号', '看病', '体检', '牙', '门诊', '口罩', '感冒', '创可贴']],
        ['应急', ['应急', '维修', '修理', '丢失', '赔偿', '突发', '罚']],
        ['储蓄', ['存钱', '储蓄', '攒钱', '存款', '存入']]
    ];

    // 收方向的词。红包有歧义：「发红包」是社交支出，「收红包」才是收入，单独判。
    const INCOME_HINTS = ['生活费', '工资', '兼职', '打工', '奖学金', '红包', '报销', '退款', '收入', '进账', '中奖', '补贴'];

    // 数字后面跟这些量词时它多半不是金额（「2 杯」「5 月 1 日」「3 人」）
    const NOT_AMOUNT_UNITS = ['月', '日', '号', '点', '杯', '个', '次', '份', '人', '瓶', '张', '天', '周', '岁', '楼', '页', '节', '章', '折', '斤', '克', '公里', '千米', '小时', '分钟', '秒'];

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    // 本地时区的 YYYY-MM-DD。与 index.html 的 todayKey 同口径（不能用 toISOString，UTC 会差一天）
    function toDateKey(dateObj) {
        const d = dateObj || new Date();
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }

    function parseDateKey(key) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || '').slice(0, 10));
        if (!m) return null;
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        return isNaN(d.getTime()) ? null : d;
    }

    function daysInMonth(monthKey) {
        const m = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ''));
        if (!m) return 30;
        // 下个月第 0 天 = 本月最后一天
        return new Date(Number(m[1]), Number(m[2]), 0).getDate();
    }

    // 本月还剩几天（含今天）。非本月：未来月份按整月，过去月份按 0，避免算出荒唐的「可花」
    function daysLeftInMonth(monthKey, todayKeyStr) {
        const dim = daysInMonth(monthKey);
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(todayKeyStr || ''));
        if (!m) return dim;
        const curMonth = `${m[1]}-${m[2]}`;
        if (String(monthKey) !== curMonth) return String(monthKey) > curMonth ? dim : 0;
        return Math.max(0, dim - Number(m[3]) + 1);
    }

    /**
     * 一句话记账解析：「午饭 25 微信」→ 支出 / 25 / 餐饮 / 微信 / 备注「午饭」。
     *
     * 判定顺序：账户 → 金额 → 方向 → 分类。账户先摘掉，因为它既不含金额也不该进备注。
     * 解析不出来不猜金额（返回 ok:false），由 UI 提示用户；分类猜不出才退回「购物」。
     *
     * @param {string} text
     * @returns {{ok: true, type: 'expense'|'income', amount: number, category: string,
     *            account: string, note: string, guessedCategory: boolean}
     *          | {ok: false, reason: 'empty'|'no-amount', category?: string, account?: string}}
     */
    function parseQuickEntry(text) {
        const raw = String(text == null ? '' : text).trim();
        if (!raw) return { ok: false, reason: 'empty' };

        let work = ` ${raw} `;
        let account = '';

        for (const pair of ACCOUNT_ALIASES) {
            const name = pair[0];
            const hit = pair[1].find(a => work.toLowerCase().includes(a.toLowerCase()));
            if (hit) {
                account = name;
                const at = work.toLowerCase().indexOf(hit.toLowerCase());
                work = work.slice(0, at) + ' ' + work.slice(at + hit.length);
                break;
            }
        }

        // 金额：优先带「元/块/¥」的，否则取最后一个未被量词否定的数字
        const re = /(\d+(?:\.\d{1,2})?)/g;
        let m;
        const cands = [];
        while ((m = re.exec(work)) !== null) {
            const rest = work.slice(m.index + m[0].length);
            const marked = /^\s*(元|块钱|块|rmb|¥|￥)/i.exec(rest);
            if (!marked && NOT_AMOUNT_UNITS.some(u => rest.startsWith(u))) continue;
            cands.push({
                value: parseFloat(m[0]),
                start: m.index,
                end: m.index + m[0].length + (marked ? marked[0].length : 0),
                marked: !!marked
            });
        }
        const chosen = cands.find(c => c.marked) || cands[cands.length - 1];
        if (!chosen || !(chosen.value > 0)) {
            return { ok: false, reason: 'no-amount', account, category: guessCategory(raw) };
        }
        work = work.slice(0, chosen.start) + ' ' + work.slice(chosen.end);

        // 备注：把金额和账户摘掉后剩下的部分，清掉首尾标点
        const note = work.replace(/\s+/g, ' ').trim().replace(/^[-+、,，:：]+/, '').replace(/[-+、,，:：]+$/, '').trim();

        // 判方向/分类用「去掉所有空格」的形态：「生活 费」这种手输空格也能认出来
        const probe = (note || raw).replace(/\s+/g, '');
        const isIncome = looksLikeIncome(probe);
        let category;
        if (isIncome) {
            category = /生活费/.test(probe) ? '生活费'
                : /(工资|兼职|打工|实习)/.test(probe) ? '兼职'
                    : /奖学金|助学金/.test(probe) ? '奖学金'
                        : /红包/.test(probe) ? '红包'
                            : '其他';
        } else {
            category = guessCategory(probe) || '购物';
        }

        return {
            ok: true,
            type: isIncome ? 'income' : 'expense',
            amount: Math.round(chosen.value * 100) / 100,
            category: category,
            account: account || '微信',
            note: note || category,
            guessedCategory: !isIncome && !guessCategory(probe)
        };
    }

    function guessCategory(text) {
        const s = String(text || '').replace(/\s+/g, '');
        for (const pair of CATEGORY_KEYWORDS) {
            if (pair[1].some(w => s.includes(w))) return pair[0];
        }
        return '';
    }

    function looksLikeIncome(text) {
        const s = String(text || '').replace(/\s+/g, '');
        // 「给/发/送…红包」是支出，先否掉再判收入
        if (/[发给送].{0,3}红包|红包.{0,3}[发给送]/.test(s)) return false;
        return INCOME_HINTS.some(w => s.includes(w));
    }

    /**
     * 月度预算结算。首页三个数全从这里出，别再在 UI 里另算一遍。
     *
     * @param {{tx: Array, budget: object, monthKey: string, todayKey: string}} input
     * @returns {{total:number, spent:number, income:number, net:number, remaining:number,
     *            daysLeft:number, savingReserve:number, spendable:number,
     *            spentByCat:object, budgetCats:object, overspent:Array, hasBudget:boolean, count:number}}
     */
    function calcBudgetSummary(input) {
        input = input || {};
        const tx = Array.isArray(input.tx) ? input.tx : [];
        const budget = input.budget || {};
        const monthKey = String(input.monthKey || '');
        const todayStr = String(input.todayKey || input.monthKey || '');
        const budgetCats = (budget.cats && typeof budget.cats === 'object') ? budget.cats : {};

        const spentByCat = {};
        LEDGER_EXPENSE_CATS.forEach(c => { spentByCat[c] = 0; });

        let spent = 0;
        let income = 0;
        let count = 0;

        tx.forEach(t => {
            if (!t || typeof t !== 'object') return;
            if (String(t.date || '').slice(0, 7) !== monthKey) return;
            const amt = Number(t.amount);
            if (!isFinite(amt) || amt <= 0) return;
            count++;
            if (t.type === 'income') { income += amt; return; }
            spent += amt;
            const cat = LEDGER_EXPENSE_CATS.indexOf(t.cat) >= 0 ? t.cat : '购物';
            spentByCat[cat] += amt;
        });

        const total = Number(budget.total) > 0 ? Number(budget.total) : 0;
        const savingBudget = Number(budgetCats['储蓄']) > 0 ? Number(budgetCats['储蓄']) : 0;
        const savingReserve = Math.max(0, savingBudget - spentByCat['储蓄']);
        const round2 = n => Math.round(n * 100) / 100;
        const remaining = round2(total - spent);
        const daysLeft = daysLeftInMonth(monthKey, todayStr);
        const flexible = Math.max(0, total - spent - savingReserve);
        const spendable = total > 0 && daysLeft > 0 ? round2(flexible / daysLeft) : 0;

        const overspent = LEDGER_EXPENSE_CATS
            // 「储蓄」不进超支榜：存得比计划多不是超支，它归攒钱账去说
            .filter(c => c !== '储蓄' && Number(budgetCats[c]) > 0 && spentByCat[c] > Number(budgetCats[c]))
            .map(c => ({
                cat: c,
                budget: Number(budgetCats[c]),
                spent: round2(spentByCat[c]),
                over: round2(spentByCat[c] - Number(budgetCats[c]))
            }))
            .sort((a, b) => b.over - a.over);

        return {
            monthKey, total, spent: round2(spent), income: round2(income), net: round2(income - spent),
            remaining, daysLeft, savingReserve: round2(savingReserve), spendable,
            spentByCat, budgetCats, overspent, hasBudget: total > 0, count
        };
    }

    /**
     * 番茄币账户。余额一律由流水累加得出，不单独存字段 —— 少一个能对不上的数字。
     *
     * @param {Array}  coinTx      流水 [{delta, date, kind, minutes, taskText, reason}]
     * @param {string} todayKeyStr
     * @param {number} [dailyCap]  每日获得上限，默认 20
     */
    function calcCoinState(coinTx, todayKeyStr, dailyCap) {
        const list = Array.isArray(coinTx) ? coinTx : [];
        const cap = isFinite(Number(dailyCap)) && Number(dailyCap) >= 0 ? Number(dailyCap) : 20;

        let balance = 0;
        let earnedTotal = 0;
        let spentTotal = 0;
        let earnedToday = 0;

        list.forEach(t => {
            if (!t || typeof t !== 'object') return;
            const d = Number(t.delta);
            if (!isFinite(d) || d === 0) return;
            balance += d;
            if (d > 0) {
                earnedTotal += d;
                if (String(t.date) === String(todayKeyStr)) earnedToday += d;
            } else {
                spentTotal += -d;
            }
        });

        return {
            balance: Math.max(0, balance),
            earnedTotal: Math.round(earnedTotal * 100) / 100,
            spentTotal: Math.round(spentTotal * 100) / 100,
            earnedToday: Math.round(earnedToday * 100) / 100,
            cap,
            remainingToday: Math.max(0, cap - earnedToday)
        };
    }

    /** 本周范围（周一 → 周日），返回起止 key 与可读标签 */
    function weekRange(dateKey) {
        const d = parseDateKey(dateKey) || new Date();
        const offset = (d.getDay() + 6) % 7; // 周一=0
        const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset);
        const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
        return {
            start: toDateKey(start),
            end: toDateKey(end),
            label: `${start.getMonth() + 1}月${start.getDate()}日 - ${end.getMonth() + 1}月${end.getDate()}日`
        };
    }

    /**
     * 单个攒钱目标的进度与新进度。
     * weeklySuggest = 剩余金额 ÷ 剩余周数（向上取整），用于「每周建议存额」。
     * expectedPct 是按时间线性推算的应达进度，用来判「落后计划」。
     */
    function calcGoalProgress(goal, todayKeyStr) {
        goal = goal || {};
        const target = Number(goal.target) > 0 ? Number(goal.target) : 0;
        const saved = Number(goal.saved) > 0 ? Number(goal.saved) : 0;
        const pct = target > 0 ? Math.min(100, Math.round(saved / target * 100)) : 0;
        const remaining = Math.max(0, target - saved);

        const today = parseDateKey(todayKeyStr);
        const due = parseDateKey(String(goal.deadline || '').slice(0, 10));
        let daysLeft = null;
        let weeksLeft = 0;
        let overdue = false;

        if (due && today) {
            daysLeft = Math.round((due - today) / 86400000);
            overdue = daysLeft < 0;
            weeksLeft = overdue ? 0 : Math.max(1, Math.ceil(daysLeft / 7));
        }

        let expectedPct = null;
        const created = parseDateKey(String(goal.createdAt || '').slice(0, 10));
        if (created && due && today) {
            const span = Math.max(1, (due - created) / 86400000);
            const used = Math.min(span, Math.max(0, (today - created) / 86400000));
            expectedPct = Math.round(used / span * 100);
        }

        return {
            pct, saved, target, remaining,
            daysLeft, weeksLeft, overdue, expectedPct,
            weeklySuggest: remaining > 0 && weeksLeft > 0 ? Math.ceil(remaining / weeksLeft) : 0,
            done: target > 0 && saved >= target
        };
    }

    /**
     * 存钱奖励币：「每存 50 元奖励 5 币」。
     * 按「本周已存金额跨过了第几个 50」发，已发过的里程碑记在 awarded 里，重复进入不会重复发。
     */
    function nextSaveReward(input) {
        input = input || {};
        const weekSaved = Math.max(0, Number(input.weekSaved) || 0);
        const step = Number(input.step) > 0 ? Number(input.step) : 50;
        const coins = Number(input.coins) > 0 ? Number(input.coins) : 5;
        const awarded = Math.max(0, Math.floor(Number(input.awarded) || 0));

        const milestone = Math.floor(weekSaved / step);
        const times = Math.max(0, milestone - awarded);

        return {
            step, coins,
            milestone,
            times,
            award: times * coins,
            nextAt: (milestone + 1) * step,
            awarded: Math.max(awarded, milestone)
        };
    }

    /**
     * 周报：自动生成的「三账复盘」。
     *
     * 钱账 / 时间账 / 币账 / 计划账 / 攒钱账 各出一组结论，最后拼一句话总结 + 下周建议。
     * 空数据不许崩，也不许编：没有番茄就说 0 个，没有预算就不出现「超支」。
     *
     * @param {object} input {tx, coinTx, budget, goals, tasks, weekStart, weekEnd, todayKey, dailyCap}
     */
    function buildWeeklyReport(input) {
        input = input || {};
        const weekStart = String(input.weekStart || '');
        const weekEnd = String(input.weekEnd || '');
        const todayKeyStr = String(input.todayKey || weekEnd);
        const inWeek = key => {
            const k = String(key || '').slice(0, 10);
            return !!k && k >= weekStart && k <= weekEnd;
        };
        const round2 = n => Math.round(n * 100) / 100;

        const tx = (Array.isArray(input.tx) ? input.tx : []).filter(t => t && inWeek(t.date));
        const coinTx = (Array.isArray(input.coinTx) ? input.coinTx : []).filter(t => t && inWeek(t.date));
        const budgetCats = (input.budget && input.budget.cats) || {};
        const dim = daysInMonth(weekStart.slice(0, 7));

        // ---- 钱账 ----
        const spentByCat = {};
        LEDGER_EXPENSE_CATS.forEach(c => { spentByCat[c] = 0; });
        let income = 0;
        let expense = 0;
        tx.forEach(t => {
            const amt = Number(t.amount) || 0;
            if (t.type === 'income') { income += amt; return; }
            expense += amt;
            const cat = LEDGER_EXPENSE_CATS.indexOf(t.cat) >= 0 ? t.cat : '购物';
            spentByCat[cat] += amt;
        });

        // 超支判定用「按天折算的周配额」，否则月初一周就撞满整月预算，周周都超支
        const overspentTop = LEDGER_EXPENSE_CATS
            .filter(c => c !== '储蓄') // 存得比计划多不是超支，归攒钱账
            .map(c => {
                const budget = Number(budgetCats[c]) > 0 ? Number(budgetCats[c]) : 0;
                const quota = budget > 0 ? budget * 7 / dim : 0;
                const spent = spentByCat[c];
                return {
                    cat: c,
                    quota: Math.round(quota),
                    spent: round2(spent),
                    over: quota > 0 && spent > quota ? round2(spent - quota) : 0
                };
            })
            .filter(x => x.over > 0)
            .sort((a, b) => b.over - a.over)
            .slice(0, 3);

        // ---- 时间账 + 币账 ----
        let earned = 0;
        let coinSpent = 0;
        let pomodoros = 0;
        let minutes = 0;
        const taskMap = {};

        coinTx.forEach(t => {
            const d = Number(t.delta) || 0;
            if (d > 0) earned += d;
            else coinSpent += -d;

            if (t.kind === 'pomodoro') {
                pomodoros++;
                const mins = Number(t.minutes) || 0;
                minutes += mins;
                const name = String(t.taskText || '').trim() || '自由专注';
                if (!taskMap[name]) taskMap[name] = { name, minutes: 0, pomodoros: 0 };
                taskMap[name].minutes += mins;
                taskMap[name].pomodoros++;
            }
        });

        const byTask = Object.values(taskMap)
            .sort((a, b) => b.minutes - a.minutes)
            .map(x => ({ ...x, pct: minutes > 0 ? Math.round(x.minutes / minutes * 100) : 0 }))
            .slice(0, 5);
        const days = new Set(coinTx.filter(t => t.kind === 'pomodoro').map(t => t.date)).size;
        const coinBalance = calcCoinState(input.coinTx, todayKeyStr, input.dailyCap).balance;

        // ---- 计划账 ----
        const tasks = Array.isArray(input.tasks) ? input.tasks.filter(t => t && typeof t === 'object') : [];
        let planTasks = tasks.filter(t => t.type === 'week');
        let scope = 'week';
        if (!planTasks.length) {
            planTasks = tasks.filter(t => t.type === 'day' && inWeek(t.date));
            scope = 'day';
        }
        const planDone = planTasks.filter(t => t.done).length;
        const plan = {
            scope,
            total: planTasks.length,
            done: planDone,
            rate: planTasks.length ? Math.round(planDone / planTasks.length * 100) : 0,
            studySpend: round2(spentByCat['学习'] || 0)
        };

        // ---- 攒钱账 ----
        const goals = (Array.isArray(input.goals) ? input.goals : []).filter(g => g && typeof g === 'object');
        const progressList = goals.map(g => ({ goal: g, p: calcGoalProgress(g, todayKeyStr) }));
        const active = progressList.filter(x => !x.p.done);
        const primary = (active[0] || progressList[0] || null);
        const weekSaved = round2(spentByCat['储蓄'] || 0);
        const saving = {
            goalName: primary ? String(primary.goal.name || '目标') : '',
            pct: primary ? primary.p.pct : 0,
            saved: primary ? primary.p.saved : 0,
            target: primary ? primary.p.target : 0,
            remaining: primary ? primary.p.remaining : 0,
            weeklySuggest: primary ? primary.p.weeklySuggest : 0,
            expectedPct: primary ? primary.p.expectedPct : null,
            weekSaved,
            goalCount: goals.length
        };

        // ---- 一句话总结 ----
        const money = {
            income: round2(income),
            expense: round2(expense),
            net: round2(income - expense),
            spentByCat,
            overspentTop
        };
        const time = { pomodoros, minutes, days, byTask };
        const coin = { earned: round2(earned), spent: round2(coinSpent), balance: coinBalance };

        const parts = [];
        if (pomodoros > 0) {
            let s = `本周完成 ${pomodoros} 个番茄，获得 ${coin.earned} 币`;
            if (coin.spent > 0) s += `，兑换消耗 ${coin.spent} 币`;
            s += `，币余额 ${coin.balance}`;
            parts.push(s);
        } else if (coin.earned > 0) {
            parts.push(`本周没有完成番茄，靠存钱奖励获得 ${coin.earned} 币，兑换消耗 ${coin.spent} 币，币余额 ${coin.balance}`);
        } else {
            parts.push(`本周没有完成番茄，币余额 ${coin.balance}`);
        }
        if (overspentTop.length) {
            const top = overspentTop[0];
            let s = `${top.cat}超支 ${Math.round(top.over)} 元`;
            if (overspentTop.length > 1) s += `（另有 ${overspentTop.length - 1} 个分类超支）`;
            parts.push(s);
        }
        if (plan.studySpend > 0) parts.push(`学习投入 ${Math.round(plan.studySpend)} 元`);
        if (primary && primary.p.target > 0) parts.push(`攒钱目标“${saving.goalName}”进度 ${saving.pct}%`);
        if (!tx.length) parts.push('本周一笔账都没记');

        // ---- 下周建议 ----
        const advice = [];
        overspentTop.slice(0, 2).forEach(o => {
            // 向上取整到 10：给的是「上限」，不能比实际配额还低
            const cap = Math.max(10, Math.ceil((o.quota || o.spent) / 10) * 10);
            advice.push(`${o.cat}下周预算控制在 ${cap} 元内（本周花了 ${Math.round(o.spent)} 元）`);
        });
        if (pomodoros === 0) {
            advice.push('本周 0 个番茄，下周先定 5 个的小目标，完成就能换币');
        } else if (coin.earned < 10) {
            advice.push(`本周只拿到 ${coin.earned} 币，下周多完成 5 个番茄就能兑一次娱乐时间`);
        }
        if (primary && !primary.p.done && primary.p.expectedPct !== null
            && saving.pct + 5 < primary.p.expectedPct && primary.p.weeklySuggest > 0) {
            advice.push(`“${saving.goalName}”落后计划 ${primary.p.expectedPct - saving.pct}%，下周建议存 ${primary.p.weeklySuggest} 元`);
        }
        if (!tx.length) {
            advice.push('本周没有支出记录，先从「午饭 25 微信」这样的一句话记账开始');
        }
        if (!advice.length) {
            advice.push('收支和番茄都在节奏上，下周保持「每天记一笔 + 每天一个番茄」即可');
        }

        return {
            weekStart, weekEnd,
            money, time, coin, plan, saving,
            summary: parts.join('。') + '。',
            advice: advice.slice(0, 3)
        };
    }

    // 兑换商店默认项：只兑特权与娱乐额度，不兑现金。
    // spend 存在 = 这条兑换对应真实消费，兑换时要同时记一笔支出，避免账实不符。
    const DEFAULT_SHOP = [
        { id: 'ent1h', emoji: '🎮', name: '1 小时娱乐时间', cost: 30 },
        { id: 'milktea', emoji: '🧋', name: '一杯奶茶额度', cost: 50, spend: { cat: '餐饮', amount: 15, account: '微信' } },
        { id: 'sleepin', emoji: '😴', name: '周末睡懒觉特权', cost: 80 },
        { id: 'wishlist', emoji: '🎁', name: '解锁一个愿望清单购买资格', cost: 100 }
    ];

    // 兑换项清洗：用户可自定义（名称 / 图标 / 价格 / 是否真实消费），
    // 坏数据直接丢弃而不是整商店带崩；undefined/null → 默认四项，空数组 → 保留（允许清空商店）。
    function normalizeShopItems(raw) {
        if (!Array.isArray(raw)) return DEFAULT_SHOP.map(it => cloneShopItem(it));
        const seen = {};
        const out = [];
        raw.forEach(it => {
            if (!it || typeof it !== 'object') return;
            const name = String(it.name || '').trim().slice(0, 20);
            const cost = Math.round(Number(it.cost));
            if (!name || !Number.isFinite(cost) || cost < 1 || cost > 100000) return;

            let id = String(it.id || '').replace(/[^\w-]/g, '').slice(0, 24);
            if (!id || seen[id]) id = 'shop' + (out.length + 1) + '-' + (seen.__seq = (seen.__seq || 0) + 1);
            seen[id] = true;

            const item = {
                id: id,
                emoji: String(it.emoji || '🎁').slice(0, 4),
                name: name,
                cost: cost
            };
            if (it.spend && typeof it.spend === 'object') {
                const amount = Math.round((Number(it.spend.amount) || 0) * 100) / 100;
                if (amount > 0) {
                    item.spend = {
                        cat: LEDGER_EXPENSE_CATS.indexOf(it.spend.cat) >= 0 ? it.spend.cat : '购物',
                        amount: amount,
                        account: LEDGER_ACCOUNTS.indexOf(it.spend.account) >= 0 ? it.spend.account : '微信'
                    };
                }
            }
            out.push(item);
        });
        return out;
    }

    function cloneShopItem(it) {
        const c = { id: it.id, emoji: it.emoji, name: it.name, cost: it.cost };
        if (it.spend) c.spend = { cat: it.spend.cat, amount: it.spend.amount, account: it.spend.account };
        return c;
    }


    return {
        calcTaskProgress: calcTaskProgress,
        normalizeTrendUrl: normalizeTrendUrl,
        normalizeTrendItems: normalizeTrendItems,
        getDeadlineStatus: getDeadlineStatus,
        // 记账领域
        LEDGER_TAXONOMY: {
            expense: LEDGER_EXPENSE_CATS,
            income: LEDGER_INCOME_CATS,
            accounts: LEDGER_ACCOUNTS
        },
        parseQuickEntry: parseQuickEntry,
        guessCategory: guessCategory,
        calcBudgetSummary: calcBudgetSummary,
        calcCoinState: calcCoinState,
        calcGoalProgress: calcGoalProgress,
        nextSaveReward: nextSaveReward,
        buildWeeklyReport: buildWeeklyReport,
        DEFAULT_SHOP: DEFAULT_SHOP,
        normalizeShopItems: normalizeShopItems,
        weekRange: weekRange,
        daysInMonth: daysInMonth,
        daysLeftInMonth: daysLeftInMonth,
        toDateKey: toDateKey
    };
});
