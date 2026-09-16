/* ============================================================
   打开的是不是最新版？（V40）

   起因：新版本发布后，用户手机上还是显示旧版本，看着就像「没部署成功」。
   真相不在服务器 —— GitHub Pages 给 HTML 加了强缓存（cache-control: max-age=600），
   发布那一刻正好打开过一次，浏览器就把旧的 index.html 连同旧 JS 一起缓存住了，
   之后十来分钟一直用旧的（iOS 存到主屏幕的那套缓存更黏）。

   所以不能指望「重新部署」解决，得让页面自己发现。

   做法：运行时绕过缓存去服务器要一份 index.html，抠出里面引用的入口 JS 文件名。
   Vite 每次构建的文件名都带内容哈希（index-8aLufsJC.js），只要构建变过，
   文件名就一定不同 —— 这就是「服务器上已经是新版」的铁证。
   确认不同 → 带一个新查询串重载一次。

   为什么重载要带查询串：查询串不同 = 缓存键不同，浏览器必然走网络拿最新 HTML，
   不带的话有可能又被还活着的旧缓存挡回来。

   只刷一次：sessionStorage 里记下「为这个版本已经硬刷过了」，
   万一（被中间层篡改、离线缓存等极端情况）刷完还是旧版，也不再反复刷新折腾用户。
   ============================================================ */

/** 会话内「已为某一版硬刷过」的标记前缀 */
const GUARD_PREFIX = 'teacher_force_update_';

/** Vite 入口产物：assets/index-<内容哈希>.js */
const ENTRY_RE = /assets\/index-[A-Za-z0-9_-]+\.js/;

/** 正在跑的是哪个入口 JS */
function runningEntry(): string | null {
  for (const s of Array.from(document.scripts)) {
    const m = s.src && s.src.match(ENTRY_RE);
    if (m) return m[0];
  }
  return null;
}

/** 服务器上现在挂着哪个入口 JS（强制绕过 HTTP 缓存） */
async function remoteEntry(): Promise<string | null> {
  const res = await fetch('./', { cache: 'no-store' });
  if (!res.ok) return null;
  const m = (await res.text()).match(ENTRY_RE);
  return m ? m[0] : null;
}

/**
 * 若不是最新版就自动换成最新版。任何异常都安静吞掉 ——
 * 检查更新失败绝不能连累正常使用。
 */
export async function checkForUpdate(): Promise<void> {
  try {
    // 双击打开的本地文件（file://）没有「服务器上的新版」这回事
    if (location.protocol === 'file:') return;
    const mine = runningEntry();
    if (!mine) return;

    const theirs = await remoteEntry();
    if (!theirs || theirs === mine) return; // 已经是最新

    const guard = GUARD_PREFIX + theirs;
    try {
      if (sessionStorage.getItem(guard)) return; // 这一版刷过一次了，不再折腾
      sessionStorage.setItem(guard, '1');
    } catch {
      /* 无痕模式下 sessionStorage 可能不可用 —— 那也照刷一次 */
    }

    location.replace(location.pathname + '?u=' + Date.now() + location.hash);
  } catch {
    /* 离线、被拦截等等，静默失败 */
  }
}
