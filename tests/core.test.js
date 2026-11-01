/**
 * core.test.js —— CyberFocus 纯逻辑层最小测试
 *
 * 运行：node tests/core.test.js
 * 零依赖，只用 node 内置 assert，不需要 jest / vitest / npm install。
 *
 * 覆盖目标：项目历史上最容易改错、且已经错过几次的三段逻辑。
 *   1. calcTaskProgress   —— 权重均分 / legacy 固化 / 封顶 / 脏数据
 *   2. normalizeTrendItems —— 四种字段命名 / 协议放行 / 脏元素
 *   3. getDeadlineStatus  —— 三档阈值边界
 *
 * 约定：所有涉及时间的用例一律注入 now，保证跨时区、跨机器结果一致。
 */
'use strict';

const assert = require('node:assert');
const core = require('../js/core.js');

// --- 极简 runner ---------------------------------------------------------
let passed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  \u2713 ' + name);
    } catch (err) {
        failures.push({ name, err });
        console.log('  \u2717 ' + name);
        console.log('      ' + err.message);
    }
}

function group(title) {
    console.log('\n' + title);
}

const T = (id, extra) => Object.assign({ id, text: 't' + id, done: false, parentId: null, contribution: null, legacyProgress: 0 }, extra);

// --- 1. calcTaskProgress -------------------------------------------------
group('[1] calcTaskProgress —— 进度树计算');

test('叶子任务未完成 → 0，且不展示进度条', () => {
    const r = core.calcTaskProgress(T('a'), [T('a')]);
    assert.deepStrictEqual(r, { progress: 0, hasProgress: false, childCount: 0 });
});

test('叶子任务已完成 → 100，且不展示进度条', () => {
    const r = core.calcTaskProgress(T('a', { done: true }), [T('a', { done: true })]);
    assert.deepStrictEqual(r, { progress: 100, hasProgress: false, childCount: 0 });
});

test('单子任务已完成、无显式权重 → 100', () => {
    const list = [T('p'), T('c', { parentId: 'p', done: true })];
    const r = core.calcTaskProgress(list[0], list);
    assert.strictEqual(r.progress, 100);
    assert.strictEqual(r.hasProgress, true);
    assert.strictEqual(r.childCount, 1);
});

test('两子任务，一个完成 → 均分 50', () => {
    const list = [T('p'), T('c1', { parentId: 'p', done: true }), T('c2', { parentId: 'p' })];
    assert.strictEqual(core.calcTaskProgress(list[0], list).progress, 50);
});

test('显式权重与未分配子任务混合 → 按权重计', () => {
    // legacy 0；c1 权重 30 已完成；c2 无权重未完成
    // assigned=30, unassigned=1, remaining=70, defaultShare=70
    // 已完成只累加 c1 的 30
    const list = [T('p'), T('c1', { parentId: 'p', done: true, contribution: 30 }), T('c2', { parentId: 'p' })];
    assert.strictEqual(core.calcTaskProgress(list[0], list).progress, 30);
});

test('legacy 50 + 两子任务各 25，完成一个 → 75', () => {
    const list = [
        T('p', { legacyProgress: 50 }),
        T('c1', { parentId: 'p', done: true, contribution: 25 }),
        T('c2', { parentId: 'p', contribution: 25 })
    ];
    assert.strictEqual(core.calcTaskProgress(list[0], list).progress, 75);
});

test('legacy 已满 100，再完成子任务 → 封顶 100（不溢出）', () => {
    const list = [T('p', { legacyProgress: 100 }), T('c1', { parentId: 'p', done: true, contribution: 10 })];
    assert.strictEqual(core.calcTaskProgress(list[0], list).progress, 100);
});

test('三个子任务均分且全部完成 → 100（浮点累加不产生 99）', () => {
    const list = [
        T('p'),
        T('c1', { parentId: 'p', done: true }),
        T('c2', { parentId: 'p', done: true }),
        T('c3', { parentId: 'p', done: true })
    ];
    assert.strictEqual(core.calcTaskProgress(list[0], list).progress, 100);
});

test('contribution 为字符串 "0" → 视为未分配权重', () => {
    const list = [T('p'), T('c1', { parentId: 'p', done: true, contribution: '0' }), T('c2', { parentId: 'p' })];
    assert.strictEqual(core.calcTaskProgress(list[0], list).progress, 50);
});

test('contribution 为脏字符串 "abc" → 视为未分配权重，不产生 NaN', () => {
    const list = [T('p'), T('c1', { parentId: 'p', done: true, contribution: 'abc' }), T('c2', { parentId: 'p' })];
    const r = core.calcTaskProgress(list[0], list);
    assert.strictEqual(r.progress, 50);
    assert.ok(Number.isFinite(r.progress), 'progress 必须是有限数');
});

test('contribution 为空串 → 视为未分配权重', () => {
    const list = [T('p'), T('c1', { parentId: 'p', done: true, contribution: '' }), T('c2', { parentId: 'p' })];
    assert.strictEqual(core.calcTaskProgress(list[0], list).progress, 50);
});

test('legacyProgress 为字符串 "50" → 按 50 计算', () => {
    const list = [T('p', { legacyProgress: '50' }), T('c1', { parentId: 'p', done: true, contribution: 50 })];
    assert.strictEqual(core.calcTaskProgress(list[0], list).progress, 100);
});

test('legacyProgress 为字符串 "40" + 权重 50 已完成 → 90（行为变更锁定用例：旧实现拼接 "4050" 会显示 100%）', () => {
    // 旧实现: currentVal = "40"; currentVal += 50 → "4050" → min(100, round("4050")) = 100
    // 新实现: Number("40") + 50 = 90
    // 这条用例在旧实现下必然失败，用于锁死本次唯一有意的行为变更
    const list = [T('p', { legacyProgress: '40' }), T('c1', { parentId: 'p', done: true, contribution: 50 })];
    assert.strictEqual(core.calcTaskProgress(list[0], list).progress, 90);
});

test('legacyProgress 为脏字符串 "abc" → 归零，不产生 NaN%（本次收紧的边界）', () => {
    const list = [T('p', { legacyProgress: 'abc' })];
    const r = core.calcTaskProgress(list[0], list);
    assert.strictEqual(r.progress, 0);
    assert.strictEqual(r.hasProgress, false);
});

test('父子互相指向（脏数据）→ 不抛错、不死循环', () => {
    const list = [T('a', { parentId: 'b' }), T('b', { parentId: 'a', done: true })];
    const r = core.calcTaskProgress(list[0], list);
    assert.ok(Number.isFinite(r.progress));
});

test('allTasks 不是数组 → 按叶子任务处理，不抛错', () => {
    assert.strictEqual(core.calcTaskProgress(T('a', { done: true }), null).progress, 100);
    assert.strictEqual(core.calcTaskProgress(T('a'), undefined).progress, 0);
});

test('两层嵌套只统计直接子任务（不递归，避免重复计数）', () => {
    // p → c → g。c 已完成，g 也已完成。
    // 对 p 而言只有一个直接子任务 c，应得 100；若递归会把 g 也算进去。
    const list = [
        T('p'),
        T('c', { parentId: 'p', done: true }),
        T('g', { parentId: 'c', done: true })
    ];
    const r = core.calcTaskProgress(list[0], list);
    assert.strictEqual(r.childCount, 1);
    assert.strictEqual(r.progress, 100);
});

test('task 为 null → 不抛错', () => {
    assert.doesNotThrow(() => core.calcTaskProgress(null, []));
});

// --- 2. normalizeTrendItems ----------------------------------------------
group('[2] normalizeTrendItems —— 多源响应归一化');

const BASE = 'https://example.com/hot/';

test('外层容器 list / items / data 三种写法都能读取', () => {
    assert.strictEqual(core.normalizeTrendItems({ list: [{ title: 'A' }] }, BASE).length, 1);
    assert.strictEqual(core.normalizeTrendItems({ items: [{ title: 'A' }] }, BASE).length, 1);
    assert.strictEqual(core.normalizeTrendItems({ data: [{ title: 'A' }] }, BASE).length, 1);
});

test('容器不是数组 → 返回空数组', () => {
    assert.deepStrictEqual(core.normalizeTrendItems({ list: 'oops' }, BASE), []);
    assert.deepStrictEqual(core.normalizeTrendItems(null, BASE), []);
    assert.deepStrictEqual(core.normalizeTrendItems(undefined, BASE), []);
});

test('纯字符串元素 → 只保留标题', () => {
    assert.deepStrictEqual(
        core.normalizeTrendItems({ list: ['纯字符串热搜'] }, BASE),
        [{ title: '纯字符串热搜', url: '', hotValue: '' }]
    );
});

test('标题字段兼容 title / name / word', () => {
    const out = core.normalizeTrendItems({
        list: [{ title: 'T' }, { name: 'N' }, { word: 'W' }]
    }, BASE);
    assert.deepStrictEqual(out.map(i => i.title), ['T', 'N', 'W']);
});

test('标题首尾空格被 trim，空白标题被过滤', () => {
    const out = core.normalizeTrendItems({ list: [{ title: '  有空格  ' }, { title: '   ' }, {}] }, BASE);
    assert.deepStrictEqual(out.map(i => i.title), ['有空格']);
});

test('相对路径按 baseHref 补全为绝对地址', () => {
    const out = core.normalizeTrendItems({ list: [{ title: 'A', url: '/s?q=1' }] }, BASE);
    assert.strictEqual(out[0].url, 'https://example.com/s?q=1');
});

test('javascript: 等非 http(s) 协议一律丢弃（防点击执行脚本）', () => {
    const out = core.normalizeTrendItems({ list: [{ title: 'A', url: 'javascript:alert(1)' }] }, BASE);
    assert.strictEqual(out[0].url, '');
});

test('url 字段兼容 url / link / href', () => {
    const out = core.normalizeTrendItems({
        list: [
            { title: 'A', url: 'https://a.com' },
            { title: 'B', link: 'https://b.com' },
            { title: 'C', href: 'https://c.com' }
        ]
    }, BASE);
    assert.deepStrictEqual(out.map(i => i.url), ['https://a.com/', 'https://b.com/', 'https://c.com/']);
});

test('热度字段兼容 hot_value / hotValue / hot / extra.hot', () => {
    const out = core.normalizeTrendItems({
        list: [
            { title: 'A', hot_value: 1 },
            { title: 'B', hotValue: 2 },
            { title: 'C', hot: 3 },
            { title: 'D', extra: { hot: 4 } }
        ]
    }, BASE);
    assert.deepStrictEqual(out.map(i => i.hotValue), ['1', '2', '3', '4']);
});

test('热度值为 0 → 被 || 链吞成空串（原实现如此，测试锁定防止无意改动）', () => {
    // 注：原实现对 0 会被 || 链吞成 ''，此处记录实际行为，与 index.html 完全一致
    const out = core.normalizeTrendItems({ list: [{ title: 'A', hot_value: 0 }] }, BASE);
    assert.strictEqual(out[0].hotValue, '');
});

test('元素为 null / undefined → 不抛错，作为空标题被过滤', () => {
    const out = core.normalizeTrendItems({ list: [null, undefined, { title: 'A' }] }, BASE);
    assert.deepStrictEqual(out.map(i => i.title), ['A']);
});

// --- 3. getDeadlineStatus -----------------------------------------------
group('[3] getDeadlineStatus —— 三档阈值');

const NOW = new Date('2026-10-31T12:00:00').getTime();
const at = h => new Date(NOW + h * 3600 * 1000).toISOString();

test('已完成 → 已完成，不提示倒计时', () => {
    assert.deepStrictEqual(core.getDeadlineStatus(at(-100), true, NOW), { class: 'normal', text: '已完成' });
});

test('已逾期 → urgent / 已逾期', () => {
    assert.deepStrictEqual(core.getDeadlineStatus(at(-1), false, NOW), { class: 'urgent', text: '已逾期' });
});

test('剩余 1 小时 → urgent / 剩余 1 小时', () => {
    assert.deepStrictEqual(core.getDeadlineStatus(at(1), false, NOW), { class: 'urgent', text: '剩余 1 小时' });
});

test('剩余 23.5 小时 → 仍按小时计（向上取整 24）', () => {
    const r = core.getDeadlineStatus(at(23.5), false, NOW);
    assert.strictEqual(r.class, 'urgent');
    assert.strictEqual(r.text, '剩余 24 小时');
});

test('剩余 30 小时 → warning / 剩余 2 天', () => {
    assert.deepStrictEqual(core.getDeadlineStatus(at(30), false, NOW), { class: 'warning', text: '剩余 2 天' });
});

test('剩余 100 小时 → normal，显示日期而非倒计时', () => {
    const r = core.getDeadlineStatus(at(100), false, NOW);
    assert.strictEqual(r.class, 'normal');
    assert.ok(typeof r.text === 'string' && r.text.length > 0);
    assert.ok(!r.text.includes('剩余'), '超过 72 小时不应再显示倒计时');
});

test('deadlineStr 为空 → 落到 normal 并显示 Invalid Date（已知缺陷，行为保持一致）', () => {
    const r = core.getDeadlineStatus('', false, NOW);
    assert.strictEqual(r.class, 'normal');
    // 显式断言输出，不用 new Date('') 自证；Node 12+ 与主流浏览器对 Invalid Date 的
    // toLocaleDateString 均返回字符串 "Invalid Date"
    assert.strictEqual(r.text, 'Invalid Date');
});

// --- 4. parseQuickEntry --------------------------------------------------
// 一句话记账是记账入口的主路径，解析错了会让钱账整月歪掉，规则必须钉死。
group('[4] parseQuickEntry —— 一句话记账');

test('「午饭 25 微信」→ 支出/25/餐饮/微信/备注午饭', () => {
    assert.deepStrictEqual(core.parseQuickEntry('午饭 25 微信'), {
        ok: true, type: 'expense', amount: 25, category: '餐饮',
        account: '微信', note: '午饭', guessedCategory: false
    });
});

test('没写账户 → 默认微信', () => {
    const r = core.parseQuickEntry('奶茶 15');
    assert.strictEqual(r.account, '微信');
    assert.strictEqual(r.category, '餐饮');
});

test('「2 杯」不是金额，取后面那个', () => {
    const r = core.parseQuickEntry('奶茶 2杯 30');
    assert.strictEqual(r.amount, 30);
});

test('「5月1日 聚餐 200」跳过日期数字', () => {
    const r = core.parseQuickEntry('5月1日 聚餐 200');
    assert.strictEqual(r.amount, 200);
    assert.strictEqual(r.category, '社交');
});

test('带「元」的小数金额', () => {
    const r = core.parseQuickEntry('打印 0.5 元 校园卡');
    assert.strictEqual(r.amount, 0.5);
    assert.strictEqual(r.account, '校园卡');
    assert.strictEqual(r.category, '学习');
});

test('「收红包」是收入，但「发红包」是社交支出', () => {
    assert.strictEqual(core.parseQuickEntry('收红包 200').type, 'income');
    const out = core.parseQuickEntry('发红包 50');
    assert.strictEqual(out.type, 'expense');
    assert.strictEqual(out.category, '社交');
});

test('「生活 费 1500 银行卡」手输空格也能认出收入', () => {
    const r = core.parseQuickEntry('生活 费 1500 银行卡');
    assert.strictEqual(r.type, 'income');
    assert.strictEqual(r.category, '生活费');
});

test('「存钱 100」归储蓄分类', () => {
    assert.strictEqual(core.parseQuickEntry('存钱 100 银行卡').category, '储蓄');
});

test('没有金额 → ok:false，不瞎猜金额', () => {
    const r = core.parseQuickEntry('午饭');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no-amount');
});

test('空串 → ok:false / empty', () => {
    assert.deepStrictEqual(core.parseQuickEntry('   '), { ok: false, reason: 'empty' });
});

test('完全不认识的词 → 归购物并标记 guessedCategory', () => {
    const r = core.parseQuickEntry('xxxx 12');
    assert.strictEqual(r.category, '购物');
    assert.strictEqual(r.guessedCategory, true);
});

// --- 5. calcBudgetSummary ------------------------------------------------
group('[5] calcBudgetSummary —— 月度预算口径');

const budgetFixture = () => ({
    tx: [
        { type: 'expense', amount: 600, cat: '餐饮', date: '2026-11-03' },
        { type: 'expense', amount: 100, cat: '储蓄', date: '2026-11-02' },
        { type: 'expense', amount: 20, cat: '交通', date: '2026-10-31' }, // 上月，不计
        { type: 'income', amount: 2000, date: '2026-11-01' }
    ],
    budget: { total: 1500, cats: { 餐饮: 500, 储蓄: 200 } },
    monthKey: '2026-11',
    todayKey: '2026-11-15'
});

test('本月剩余 = 总预算 − 本月支出（含储蓄）', () => {
    const r = core.calcBudgetSummary(budgetFixture());
    assert.strictEqual(r.spent, 700);
    assert.strictEqual(r.remaining, 800);
    assert.strictEqual(r.income, 2000);
});

test('上月流水不混进本月', () => {
    const r = core.calcBudgetSummary(budgetFixture());
    assert.strictEqual(r.spentByCat['交通'], 0);
});

test('今日可花 = (剩余 − 未存完的储蓄预算) / 剩余天数', () => {
    const r = core.calcBudgetSummary(budgetFixture());
    // 剩余 800，储蓄预算 200 已存 100 → 预留 100；11 月 15 日还剩 16 天
    assert.strictEqual(r.savingReserve, 100);
    assert.strictEqual(r.daysLeft, 16);
    assert.strictEqual(r.spendable, 43.75);
});

test('超支分类只列真正超了的，且不含储蓄', () => {
    const r = core.calcBudgetSummary(budgetFixture());
    assert.deepStrictEqual(r.overspent.map(o => o.cat), ['餐饮']);
    assert.strictEqual(r.overspent[0].over, 100);
});

test('没设预算 → hasBudget false，可花为 0（不出现负零花）', () => {
    const r = core.calcBudgetSummary({ tx: [], budget: {}, monthKey: '2026-11', todayKey: '2026-11-01' });
    assert.strictEqual(r.hasBudget, false);
    assert.strictEqual(r.spendable, 0);
});

test('脏数据（amount 非数字 / null 条目）不参与计算也不抛错', () => {
    const r = core.calcBudgetSummary({
        tx: [null, { type: 'expense', amount: 'abc', date: '2026-11-03' }, { type: 'expense', amount: 10, cat: '餐饮', date: '2026-11-03' }],
        budget: { total: 100, cats: {} }, monthKey: '2026-11', todayKey: '2026-11-03'
    });
    assert.strictEqual(r.spent, 10);
    assert.strictEqual(r.count, 1);
});

// --- 6. 番茄币 ------------------------------------------------------------
group('[6] calcCoinState / nextSaveReward —— 注意力货币');

test('余额由流水累加，不单独存字段', () => {
    const r = core.calcCoinState([
        { delta: 1, date: '2026-11-01' }, { delta: 1, date: '2026-11-01' },
        { delta: -30, date: '2026-11-02' }, { delta: 1, date: '2026-11-02' }
    ], '2026-11-01', 20);
    assert.strictEqual(r.balance, 0); // 强制不出现负余额
    assert.strictEqual(r.earnedTotal, 3);
    assert.strictEqual(r.spentTotal, 30);
});

test('今日获得与上限', () => {
    const tx = [];
    for (let i = 0; i < 22; i++) tx.push({ delta: 1, date: '2026-11-01' });
    const r = core.calcCoinState(tx, '2026-11-01', 20);
    assert.strictEqual(r.earnedToday, 22); // 上限由发币侧拦截，这里只如实统计
    assert.strictEqual(r.remainingToday, 0);
});

test('每存 50 元奖 5 币：跨两个台阶一次补 10 币', () => {
    const r = core.nextSaveReward({ weekSaved: 120, step: 50, coins: 5, awarded: 0 });
    assert.strictEqual(r.milestone, 2);
    assert.strictEqual(r.award, 10);
});

test('已发过的台阶不重复发', () => {
    const r = core.nextSaveReward({ weekSaved: 120, step: 50, coins: 5, awarded: 2 });
    assert.strictEqual(r.award, 0);
    assert.strictEqual(r.nextAt, 150);
});

// --- 7. calcGoalProgress -------------------------------------------------
group('[7] calcGoalProgress —— 攒钱目标');

test('进度、剩余、每周建议存额', () => {
    const r = core.calcGoalProgress(
        { name: '相机', target: 1000, saved: 350, deadline: '2027-02-01', createdAt: '2026-10-01' },
        '2026-11-01'
    );
    assert.strictEqual(r.pct, 35);
    assert.strictEqual(r.remaining, 650);
    assert.strictEqual(r.weeksLeft, 14);
    assert.strictEqual(r.weeklySuggest, 47); // ceil(650/14)
    assert.strictEqual(r.expectedPct, 25);
    assert.strictEqual(r.done, false);
});

test('目标金额为 0 不产生 NaN / Infinity', () => {
    const r = core.calcGoalProgress({ name: 'x', target: 0, saved: 0 }, '2026-11-01');
    assert.strictEqual(r.pct, 0);
    assert.strictEqual(r.weeklySuggest, 0);
});

test('超额存入封顶 100%', () => {
    const r = core.calcGoalProgress({ target: 100, saved: 150 }, '2026-11-01');
    assert.strictEqual(r.pct, 100);
    assert.strictEqual(r.done, true);
});

// --- 8. buildWeeklyReport ------------------------------------------------
group('[8] buildWeeklyReport —— 三账复盘');

const reportInput = () => ({
    tx: [
        { type: 'expense', amount: 600, cat: '餐饮', date: '2026-10-28' },
        { type: 'expense', amount: 60, cat: '学习', date: '2026-10-29' },
        { type: 'expense', amount: 200, cat: '储蓄', date: '2026-10-30' },
        { type: 'income', amount: 1500, date: '2026-10-26' }
    ],
    coinTx: [
        { delta: 1, kind: 'pomodoro', date: '2026-10-28', minutes: 25, taskText: '写论文' },
        { delta: 1, kind: 'pomodoro', date: '2026-10-29', minutes: 25, taskText: '写论文' },
        { delta: 1, kind: 'pomodoro', date: '2026-10-30', minutes: 10, taskText: '背单词' },
        { delta: 5, kind: 'save', date: '2026-10-30' },
        { delta: -30, kind: 'redeem', date: '2026-10-31' }
    ],
    budget: { total: 2000, cats: { 餐饮: 800, 学习: 200, 储蓄: 400 } }, // 11 月 30 天
    goals: [{ name: '相机', target: 1000, saved: 350, deadline: '2027-02-01', createdAt: '2026-10-01' }],
    tasks: [{ type: 'week', done: true }, { type: 'week', done: false }],
    weekStart: '2026-10-26', weekEnd: '2026-11-01', todayKey: '2026-11-01', dailyCap: 20
});

test('钱账：收入 / 支出 / 结余', () => {
    const r = core.buildWeeklyReport(reportInput());
    assert.strictEqual(r.money.income, 1500);
    assert.strictEqual(r.money.expense, 860);
    assert.strictEqual(r.money.net, 640);
});

test('超支按「周配额」判，储蓄不进超支榜', () => {
    const r = core.buildWeeklyReport(reportInput());
    // 这一周从 10-26 起算 → 按 10 月 31 天折算：800×7/31 ≈ 180.6 → 181；本周 600 → 超支
    assert.strictEqual(r.money.overspentTop[0].cat, '餐饮');
    assert.strictEqual(r.money.overspentTop[0].quota, 181);
    assert.ok(!r.money.overspentTop.some(o => o.cat === '储蓄'));
});

test('时间账：番茄数 / 分钟 / 按计划的分布', () => {
    const r = core.buildWeeklyReport(reportInput());
    assert.strictEqual(r.time.pomodoros, 3);
    assert.strictEqual(r.time.minutes, 60);
    assert.strictEqual(r.time.byTask[0].name, '写论文');
    assert.strictEqual(r.time.byTask[0].pct, 83);
});

test('币账：获得含存钱奖励，消耗与余额分列', () => {
    const r = core.buildWeeklyReport(reportInput());
    assert.strictEqual(r.coin.earned, 8); // 3 番茄 + 5 存钱奖励
    assert.strictEqual(r.coin.spent, 30);
});

test('计划账：本周目标完成度 + 学习投入', () => {
    const r = core.buildWeeklyReport(reportInput());
    assert.strictEqual(r.plan.rate, 50);
    assert.strictEqual(r.plan.studySpend, 60);
});

test('攒钱账：本周存入与目标进度', () => {
    const r = core.buildWeeklyReport(reportInput());
    assert.strictEqual(r.saving.weekSaved, 200);
    assert.strictEqual(r.saving.goalName, '相机');
    assert.strictEqual(r.saving.pct, 35);
});

test('一句话总结包含币账与超支结论', () => {
    const r = core.buildWeeklyReport(reportInput());
    assert.ok(r.summary.includes('本周完成 3 个番茄'));
    assert.ok(r.summary.includes('超支'));
    assert.ok(r.summary.endsWith('。'));
});

test('空数据不崩、不编造，给出可执行建议', () => {
    const r = core.buildWeeklyReport({
        tx: [], coinTx: [], budget: {}, goals: [], tasks: [],
        weekStart: '2026-10-26', weekEnd: '2026-11-01', todayKey: '2026-11-01'
    });
    assert.strictEqual(r.money.expense, 0);
    assert.strictEqual(r.time.pomodoros, 0);
    assert.ok(r.summary.includes('没有完成番茄'));
    assert.ok(r.advice.length >= 1 && r.advice.length <= 3);
});

// --- 9. 日期工具 ---------------------------------------------------------
group('[9] weekRange / daysInMonth —— 周与月边界');

test('周一为一周的第一天', () => {
    const r = core.weekRange('2026-11-01'); // 周日
    assert.strictEqual(r.start, '2026-10-26');
    assert.strictEqual(r.end, '2026-11-01');
});

test('2026 年 11 月 30 天、2 月闰年 29 天', () => {
    assert.strictEqual(core.daysInMonth('2026-11'), 30);
    assert.strictEqual(core.daysInMonth('2028-02'), 29);
    assert.strictEqual(core.daysInMonth('2026-02'), 28);
});

// --- 汇总 ---------------------------------------------------------------
const total = passed + failures.length;
console.log('\n' + '-'.repeat(52));
console.log(`  通过 ${passed} / ${total}`);
if (failures.length) {
    console.log(`  失败 ${failures.length}`);
    failures.forEach(f => console.log('   - ' + f.name + ': ' + f.err.message));
    process.exit(1);
}
console.log('  全部通过');
process.exit(0);
