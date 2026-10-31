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
