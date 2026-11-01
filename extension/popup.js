// CyberFocus 导航收藏 popup
// 主通道 B2：把 {title,url} 编进 #add=<base64url>，投递到导航页标签页（页面端弹出预填确认框，用户选分组/图标后保存）
// 兜底 B1：投递失败（常见于 file:// 未开"允许访问文件网址"）→ 复制 JSON 到剪贴板，
//          用户在导航页「管理面板 → 从剪贴板导入 / 手动粘贴」完成收集。

const $ = id => document.getElementById(id);
let currentTab = null;

function setStatus(msg, type) {
  const el = $('status');
  el.textContent = msg;
  el.className = type || '';
}

function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function payloadOf(tab) {
  // 标题截断到 120 个 UTF-16 码元：防止超长标题撑爆 URL（可能切出半个代理对，概率极低可接受）
  return { title: String(tab.title || '').slice(0, 120), url: tab.url };
}

function normalizeBase(raw) {
  let s = String(raw || '').trim().replace(/#.*$/, '');
  if (!s) return '';
  // 用户直接粘贴 Windows 路径（D:\...\index.html）：转成 file:// URL 而不是误补 https://
  if (/^[a-z]:[\\/]/i.test(s)) s = 'file:///' + s.replace(/\\/g, '/');
  if (!/^https?:\/\//i.test(s) && !/^file:\/\//i.test(s)) {
    if (/^[a-z]+:/i.test(s)) return '';   // 其他协议（chrome:// 等）不是合法导航页地址
    s = 'https://' + s;
  }
  return s;
}

// 投递后等标签页落地：pendingUrl/url 变成目标 scheme 才算成功。
// 无文件访问权限时 Chrome 常常不报错、只给 chrome-error 空页——不验证就会把失败伪装成成功。
async function tabLandedOk(tabId) {
  for (let i = 0; i < 8; i++) {
    let t;
    try { t = await chrome.tabs.get(tabId); } catch (e) { return false; }
    const u = String(t.pendingUrl || t.url || '');
    if (/^(file|https?):/i.test(u)) return true;
    if (/^(chrome-error|about:|chrome:\/\/|edge:\/\/)/i.test(u)) return false;
    await new Promise(r => setTimeout(r, 150));
  }
  return false;   // 一直拿不到稳定地址：按失败处理，宁可多降级也不能静默丢收藏
}

// B2：投递到导航页。已有导航页标签 → 原地换 hash（hashchange 接收）；没有 → 新开标签
async function deliverViaTabs(base, target) {
  let allTabs = [];
  try {
    // 不用 url match pattern：模式语法对中文/空格路径不可靠（本项目路径就含中文），
    // 且 file:// 匹配需要"允许访问文件网址"权限。全量拉取后用 JS 精确比对。
    allTabs = await chrome.tabs.query({});
  } catch (e) { allTabs = []; }

  const existing = allTabs.find(t => t.url && t.url.split('#')[0] === base);
  if (existing) {
    if (existing.url === target) {
      // 同一地址重复投递：hash 没变化不会触发 hashchange，强制重载
      await chrome.tabs.reload(existing.id);
    } else {
      // active: true——页面端现在是"人工确认弹窗"，标签不带到前台用户就永远看不到待确认的弹窗
      await chrome.tabs.update(existing.id, { url: target, active: true });
    }
    if (!(await tabLandedOk(existing.id))) throw new Error('landing-failed');
    return '已在导航页打开确认框，请切换过去保存';
  }

  const created = await chrome.tabs.create({ url: target });
  if (!(await tabLandedOk(created.id))) throw new Error('landing-failed');
  return '已打开导航页，请在确认框中选择分组后保存';
}

async function addToNav() {
  if (!currentTab) return;
  const base = normalizeBase($('page').value);
  if (!base) {
    setStatus('请先填写导航页地址（file:///…/index.html 或 https://…）', 'err');
    $('page').focus();
    return;
  }
  await chrome.storage.local.set({ navPageUrl: base });

  const target = base + '#add=' + b64url(JSON.stringify(payloadOf(currentTab)));
  try {
    const msg = await deliverViaTabs(base, target);
    setStatus(msg, 'ok');
    setTimeout(() => window.close(), 900);
  } catch (err) {
    await copyFallback('直接投递失败（' + (err && err.message ? err.message : '未知') + '）');
  }
}

// B1 兜底：复制 JSON，用户去导航页管理面板粘贴
async function copyFallback(prefix) {
  try {
    await navigator.clipboard.writeText(JSON.stringify(payloadOf(currentTab)));
    setStatus((prefix ? prefix + '。' : '') + '数据已复制，请打开导航页 → 管理面板 → 从剪贴板导入（或手动粘贴）', 'warn');
  } catch (err) {
    setStatus('复制失败：' + (err && err.message ? err.message : err), 'err');
  }
}

$('add').addEventListener('click', addToNav);
$('copy').addEventListener('click', () => {
  if (!currentTab) return;
  copyFallback('');
});

init().catch(err => setStatus('初始化失败：' + (err && err.message ? err.message : err), 'err'));

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    setStatus('无法读取当前页面地址', 'err');
    return;
  }
  currentTab = tab;
  $('pageTitle').textContent = tab.title || '(无标题)';
  $('pageUrl').textContent = tab.url;

  if (!/^https?:/i.test(tab.url)) {
    setStatus('仅支持收藏 http/https 页面（本地文件、浏览器内部页除外）', 'err');
    return;
  }

  const { navPageUrl } = await chrome.storage.local.get('navPageUrl');
  if (navPageUrl) $('page').value = navPageUrl;
  $('add').disabled = false;
}
