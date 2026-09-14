/* ============================================================
   个人设置 · 数据存放方式 / 云端同步面板
   ------------------------------------------------------------
   【默认折叠、默认不启用】
   没做任何配置时，这个面板只是一段折叠起来的说明，
   现有的一切本地功能照常，不填也能完整使用。

   三种存放方式（用户自选）：
     ① 只在这台设备      —— 现状，数据留在本机浏览器里，离线可用
     ② 自己电脑做服务器  —— 电脑上跑个小服务，手机连同一个 Wi-Fi 打开，
                            数据集中存在那台电脑上；换手机扫码就能找回
     ③ 公网服务器        —— 填一台有公网地址的服务器（域名 + HTTPS）

   ② 和 ③ 在技术上走同一套 «上传 / 拉取» 流程，区别只在地址类型和限制说明。
   ============================================================ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getCloudServer, setCloudServer, isCloudConfigured, isCloudLoggedIn, getCloudUser,
  getCloudMeta, clearCloudSession, forgetCloud, normalizeServerUrl, isLanAddress,
  probeSameOrigin, cloudPing, cloudRegister, cloudLogin, cloudLogout, cloudStatus,
  cloudUpload, cloudDownload, formatBytes, CloudError, bestShareUrl,
} from './cloud';
import type { CloudUser, CloudBlobMeta, CloudLocalMeta, SameOriginInfo } from './cloud';
import { summarize, applyBackup, dataSizeKB } from './backup';
import { getData } from './storage';

interface Props {
  toast: (msg: string) => void;
  /** 打开二维码弹窗（用来把本机地址分享到手机） */
  openQr?: (url: string) => void;
  /** 供冒烟测试指定初始页签 */
  initialStore?: Store;
  /** 供冒烟测试强制展开（生产环境不传，走默认折叠逻辑） */
  defaultOpen?: boolean;
}

type Mode = 'login' | 'register';
type Store = 'local' | 'lan' | 'remote';

const STORE_TABS: { key: Store; label: string }[] = [
  { key: 'local', label: '📱 只在这台设备' },
  { key: 'lan', label: '💻 自己电脑做服务器' },
  { key: 'remote', label: '🌐 公网服务器' },
];

export function CloudPanel({ toast, openQr, initialStore, defaultOpen }: Props) {
  /**
   * 已配置过的老用户默认展开，没配过的默认收起来、不打扰。
   * 也考虑「有登录态但地址丢了」这种边界 —— 否则面板折叠着，
   * 用户根本找不到地方把地址补回来。
   */
  const [open, setOpen] = useState(() =>
    defaultOpen ?? (isCloudConfigured() || isCloudLoggedIn()));

  const [store, setStore] = useState<Store>(() => {
    if (initialStore) return initialStore;
    const s = getCloudServer();
    if (!s) return 'local';
    return isLanAddress(s) ? 'lan' : 'remote';
  });

  const [server, setServer] = useState(getCloudServer);
  const [draftServer, setDraftServer] = useState(getCloudServer);
  const [serverOk, setServerOk] = useState<null | { version: string; registrationOpen: boolean }>(null);

  const [logged, setLogged] = useState(isCloudLoggedIn);
  const [user, setUser] = useState<CloudUser | null>(getCloudUser);
  const [blob, setBlob] = useState<CloudBlobMeta | null>(null);
  const [meta, setMeta] = useState<CloudLocalMeta>(getCloudMeta);

  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');

  const [pullMode, setPullMode] = useState<'merge' | 'replace'>('merge');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  /** 当前页面是否由一台教师助手服务器托管（自己电脑当服务器时就是这种情况） */
  const [sameOrigin, setSameOrigin] = useState<SameOriginInfo | null>(null);
  const [probing, setProbing] = useState(false);

  /**
   * 本机数据概览。
   * 注意：summarize(getData()) 要解析整份 localStorage（几 MB 时要花几毫秒），
   * 不能放在渲染路径上直接算 —— 否则在设置页里每敲一个字都会重新解析一遍。
   * 所以只在面板展开时算，并且由 dataTick 显式驱动刷新。
   */
  const [dataTick, setDataTick] = useState(0);
  const localInfo = useMemo(() => {
    if (!open) return { kb: 0, summary: '' };
    return { kb: dataSizeKB(), summary: summarize(getData()) };
  }, [open, dataTick]);

  /** 统一的「执行 → 忙碌 → 报错」包装 */
  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof CloudError ? e.message : (e as Error)?.message || '操作失败');
    } finally {
      setBusy('');
    }
  }, []);

  /** 已配置且已登录时，拉一次服务器侧的概览 */
  const refreshStatus = useCallback(async () => {
    if (!isCloudConfigured() || !isCloudLoggedIn()) return;
    try {
      const s = await cloudStatus();
      setUser(s.user);
      setBlob(s.blob);
      setLogged(true);
    } catch (e) {
      const ce = e as CloudError;
      if (ce?.status === 401) {
        clearCloudSession();
        setLogged(false);
        setUser(null);
        setBlob(null);
      } else {
        setErr(ce?.message || '无法连接云端');
      }
    }
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus, server]);

  /** 展开时探测一次同源服务器 */
  const doProbe = useCallback(async () => {
    setProbing(true);
    const info = await probeSameOrigin();
    setSameOrigin(info);
    setProbing(false);
    return info;
  }, []);

  /**
   * 探测同源服务器。**面板折叠着也要探一次**。
   *
   * 原因：老师在手机上打开局域网地址时，这个面板默认是收起来的。
   * 不自动展开的话，他得先猜到这个折叠标题要点开，再找到「登录 / 拉取」，
   * 大多数人到这一步就以为「没连上」而放弃了。所以一旦确认
   * 「页面由局域网服务器托管 + 还没配置过」，就直接展开。
   *
   * 只探一次（挂载时），不跟着 open 反复跑；「重新检测」按钮另走 doProbe。
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      setProbing(true);
      const info = await probeSameOrigin();
      setProbing(false);
      if (!alive) return;
      setSameOrigin(info);
      if (!info) return;
      // 还没配置过、而当前页面正好由一台服务器托管 —— 直接把页签切过去
      if (!getCloudServer()) setStore(info.lan ? 'lan' : 'remote');
      // 局域网服务器 + 尚未配置 + 尚未登录 → 自动展开，别让老师在手机上抓瞎
      if (info.lan && !getCloudServer() && !isCloudLoggedIn()) setOpen(true);
    })();
    return () => { alive = false; };
  }, []);

  const localKB = localInfo.kb;
  const localSummary = localInfo.summary;

  /**
   * 生成「发给手机扫」的地址。
   * 老师在电脑上多半是用 http://127.0.0.1:8787 打开的，直接把这个做成二维码，
   * 手机扫到的是它自己，永远打不开 —— 所以回环地址一律换成局域网地址。
   */
  const shareUrlFor = useCallback((target: string) => {
    if (/^https?:\/\/(127\.|localhost|\[::1\])/i.test(target) && sameOrigin?.urls?.length) {
      return bestShareUrl(sameOrigin);
    }
    return target;
  }, [sameOrigin]);

  /* ------------------------- 连接服务器 ------------------------- */

  const connectServer = () => run('ping', async () => {
    const url = normalizeServerUrl(draftServer);
    if (!url) { setErr('请填写服务器地址。'); return; }
    const info = await cloudPing(url);
    setServer(url);
    setCloudServer(url);
    setServerOk(info);
    setStore(isLanAddress(url) ? 'lan' : 'remote');
    toast(`✅ 已连接服务器 v${info.version}`);
    await refreshStatus();
  });

  /** 一键使用「当前页面所在的这台服务器」（自己电脑当服务器时的主路径） */
  const useSameOrigin = () => run('ping', async () => {
    const info = sameOrigin || await doProbe();
    if (!info) { setErr('没有检测到本机服务器。请确认启动脚本的窗口还开着，然后点「重新检测」。'); return; }
    const r = await cloudPing(info.origin);
    setDraftServer(info.origin);
    setServer(info.origin);
    setCloudServer(info.origin);
    setServerOk(r);
    setStore(info.lan ? 'lan' : 'remote');
    toast(`✅ 已使用这台服务器 v${r.version}`);
    await refreshStatus();
  });

  const changeServer = () => {
    forgetCloud();
    setServer('');
    setDraftServer('');
    setServerOk(null);
    setLogged(false);
    setUser(null);
    setBlob(null);
    setErr('');
    setStore('local');
    toast('已断开，现在只在本机保存数据');
  };

  /* --------------------------- 登录 --------------------------- */

  const doAuth = () => run('auth', async () => {
    if (!username.trim()) { setErr('请输入账号。'); return; }
    if (!password) { setErr('请输入密码。'); return; }
    const u = mode === 'register'
      ? await cloudRegister(username.trim(), password, invite.trim())
      : await cloudLogin(username.trim(), password);
    setLogged(true);
    setUser(u);
    setPassword('');
    setInvite('');
    toast(mode === 'register' ? `✅ 注册成功：${u.username}` : `✅ 已登录：${u.username}`);
    await refreshStatus();
  });

  const doLogout = () => run('logout', async () => {
    await cloudLogout();
    setLogged(false);
    setUser(null);
    setBlob(null);
    toast('已退出账号');
  });

  /* ------------------------ 上传 / 拉取 ------------------------ */

  const doUpload = () => run('upload', async () => {
    const r = await cloudUpload();
    setMeta(getCloudMeta());
    setBlob(r);
    setDataTick(t => t + 1);
    toast(`☁️ 已上传（${formatBytes(r.bytes)}）`);
  });

  const doDownload = () => run('download', async () => {
    if (pullMode === 'replace' && !confirm('覆盖：本机数据会被云端那份完全替换，且无法撤销。确定继续？')) return;
    const r = await cloudDownload();
    setMeta(getCloudMeta());
    applyBackup(r.file.data, pullMode);
    toast('✅ 已拉取，正在刷新…');
    setTimeout(() => window.location.reload(), 900);
  });

  /* --------------------------- 渲染 --------------------------- */

  return (
    <div className="settings-section">
      <div className={`section-header ${open ? '' : 'collapsed'}`} onClick={() => setOpen(!open)}>
        <span>🔌 数据存放方式 {logged ? '· 已连接' : isCloudConfigured() ? '· 未登录' : '· 本机'}</span>
        <span>{open ? '▼' : '▶'}</span>
      </div>

      {open && (
        <div className="section-body">
          {err && <div className="cloud-err">⚠️ {err}</div>}

          {/* ---------------- 三选一 ---------------- */}
          {!server && (
            <>
              <div className="rc-seg cloud-seg">
                {STORE_TABS.map(t => (
                  <div
                    key={t.key}
                    className={`rc-seg-item ${store === t.key ? 'active' : ''}`}
                    style={{ flex: 1, textAlign: 'center', fontSize: 11.5 }}
                    onClick={() => { setStore(t.key); setErr(''); }}
                  >{t.label}</div>
                ))}
              </div>

              {/* ---- ① 只在这台设备 ---- */}
              {store === 'local' && (
                <div className="info-box">
                  <div><b>✅ 现在就是这种方式，什么都不用设置 —— 大多数情况这样最省事。</b></div>
                  <div className="hint" style={{ marginTop: 6 }}>
                    数据全部保存在这台设备的浏览器里（约 {localKB} KB），断网也能用，不上传任何东西。
                    <br />
                    <b>手机和电脑之间怎么搬？不用连服务器：</b>在上面「💾 数据备份与恢复」里点
                    「📤 分享备份」，发到微信的「文件传输助手」，再到另一台设备上「导入」，一次就搬完了。
                    <br />
                    这里只有一件事要记：<b>定期导出备份</b>。换手机、清缓存、卸载浏览器都会让本机数据全丢，
                    而备份文件能把它救回来。
                    <br />
                    只有当你想要「两台设备自动同步、不必每次手动搬」时，才需要切到「💻 自己电脑做服务器」。
                  </div>
                </div>
              )}

              {/* ---- ② 自己电脑做服务器 ---- */}
              {store === 'lan' && (
                <>
                  <div className="info-box">
                    <div><b>在自己电脑上跑一个小服务，数据集中存在那台电脑上。</b></div>
                    <div className="hint" style={{ marginTop: 6 }}>
                      手机连上<b>同一个 Wi-Fi</b> 就能打开同一个应用，换手机只要重新扫码 + 登录，
                      数据就回来了。适合你一个人多设备用，也适合几位老师共用一台电脑。
                      <br />
                      ⚠️ 这条路要多做几件事：电脑上要开着服务、手机得连同一个 Wi-Fi。
                      <b>如果只是偶尔把手机数据搬到电脑，用「只在这台设备 + 📤 分享备份」就够了</b>，
                      不必走这里。
                    </div>
                  </div>

                  {sameOrigin ? (
                    <div className="cloud-found">
                      <div>
                        <b>🎯 检测到本机服务器</b>
                        <span className="cloud-found-sub">
                          {sameOrigin.origin} · v{sameOrigin.version}
                          {sameOrigin.lan ? ' · 局域网已开启' : ''}
                        </span>
                      </div>
                      {sameOrigin.lan && sameOrigin.urls?.length > 0 && (
                        <div className="cloud-found-sub" style={{ marginTop: 4 }}>
                          手机请用这个地址：<b>{bestShareUrl(sameOrigin)}</b>
                        </div>
                      )}
                      <div className="btn-row" style={{ marginTop: 8 }}>
                        <button className="btn btn-primary btn-small" disabled={busy === 'ping'} onClick={useSameOrigin}>
                          {busy === 'ping' ? '连接中…' : '✅ 就用这台服务器'}
                        </button>
                        <button className="btn btn-outline btn-small"
                          onClick={() => openQr?.(bestShareUrl(sameOrigin))}>
                          📱 手机扫码打开
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="cloud-notfound">
                      {probing ? '正在检测本机服务器…' : '没有检测到本机服务器。'}
                      {!probing && (
                        <>
                          <div className="hint" style={{ marginTop: 4 }}>
                            如果还没启动，先双击「教师助手_自己电脑做服务器」文件夹里的启动脚本；
                            已经启动了的话点下面重新检测。
                          </div>
                          <button className="btn btn-secondary btn-small" style={{ marginTop: 8 }}
                            disabled={probing} onClick={() => void doProbe()}>🔍 重新检测</button>
                        </>
                      )}
                    </div>
                  )}

                  <div className="cloud-steps">
                    <div className="cloud-steps-title">电脑这边（第一次做一遍）</div>
                    <div>① 双击启动脚本 —— 弹出的黑色窗口就是服务器，<b>别关它</b></div>
                    <div>② 回到这里点「✅ 就用这台服务器」，注册一个账号</div>
                    <div>③ 点「☁️ 上传当前全部数据到服务器」—— 电脑上的数据就进服务器了</div>
                  </div>

                  <div className="cloud-steps">
                    <div className="cloud-steps-title">手机这边</div>
                    <div>① 连上<b>同一个 Wi-Fi</b></div>
                    <div>② 用手机<b>相机</b>或浏览器扫码 —— <b>别用微信扫</b>，微信里没法「添加到主屏幕」</div>
                    <div>③ 打开后<b>登录同一个账号</b>，点「⬇️ 从云端拉取」—— 电脑上的数据就到手机了</div>
                  </div>

                  <div className="cloud-warn">
                    <b>⚠️ 手机上原来那个应用（从网上装的）连不上这里，也看不到这里的数据。</b>
                    <div style={{ marginTop: 4 }}>
                      这是浏览器的硬规定，两条都绕不过：<br />
                      ① 每个网址的「应用」数据各存一份，<b>互不相通</b>；<br />
                      ② 网上那个是 https 安全页，<b>不许连</b>本机这种 http 服务。<br />
                      所以手机想用这里的数据，就用上面的码打开、登录同一账号、拉取一次。
                      打开后建议选浏览器菜单里的「添加到主屏幕」，以后就像 App 一样。
                    </div>
                  </div>

                  <p className="hint">
                    ⚠️ 只在同一个 Wi-Fi 下可用：电脑关机、睡眠或合盖后，手机就打不开了。
                    <br />
                    ✅ 数据存在那台电脑上的 <code>data</code> 文件夹里，关掉服务不会丢；
                    换电脑时把整个文件夹拷过去即可。
                  </p>
                </>
              )}

              {/* ---- ③ 公网服务器 ---- */}
              {store === 'remote' && (
                <div className="info-box">
                  <div><b>填一台有公网地址的服务器（你自己买的，或同事搭好的）。</b></div>
                  <div className="hint" style={{ marginTop: 6 }}>
                    公网必须走 <b>HTTPS</b>，否则密码和数据是明文在网上传的。
                    地址填服务器<b>根地址</b>即可，不要带 <code>/api</code>。
                  </div>
                </div>
              )}

              {/* ---- 手动填地址（② ③ 共用） ---- */}
              {store !== 'local' && (
                <>
                  {sameOrigin && (
                    <button className="btn btn-primary btn-block" style={{ marginTop: 12 }}
                      disabled={busy === 'ping'} onClick={useSameOrigin}>
                      {busy === 'ping' ? '连接中…' : `✅ 使用当前这台服务器（${sameOrigin.origin}）`}
                    </button>
                  )}
                  <div className="form-group" style={{ marginTop: 12 }}>
                    <label>{sameOrigin ? '或者手动填写地址' : '服务器地址'}</label>
                    <input
                      className="form-input"
                      value={draftServer}
                      onChange={e => setDraftServer(e.target.value)}
                      placeholder={store === 'lan'
                        ? '例如 http://192.168.1.8:8787'
                        : '例如 https://jiaoshi.你的域名.com'}
                    />
                    <p className="hint">
                      填域名会自动按 https 连接；填内网 IP 用 http。首次使用请先点下面的按钮测试一次。
                    </p>
                  </div>
                  <button className="btn btn-outline btn-block" disabled={busy === 'ping'} onClick={connectServer}>
                    {busy === 'ping' ? '正在连接…' : '🔗 测试并连接'}
                  </button>
                </>
              )}
            </>
          )}

          {/* ---------- 已连接：登录 / 同步操作 ---------- */}
          {!!server && (
            <>
              <div className="cloud-status">
                <span className={`cloud-pill ${serverOk ? 'ok' : ''}`}>
                  {serverOk
                    ? `${isLanAddress(server) ? '局域网' : '公网'} · 连接正常 · v${serverOk.version}`
                    : '已保存地址'}
                </span>
                <span className="cloud-host">{server}</span>
              </div>

              {isLanAddress(server) && (
                <p className="hint" style={{ marginTop: 6 }}>
                  同一 Wi-Fi 下手机用同一个地址打开就是同一份数据。
                  {openQr && (
                    <>
                      {' '}
                      <a
                        style={{ color: 'var(--primary)', cursor: 'pointer' }}
                        onClick={() => openQr(shareUrlFor(server))}
                      >📱 手机扫码打开</a>
                    </>
                  )}
                </p>
              )}

              {/* 未登录 → 登录 / 注册 */}
              {!logged && (
                <>
                  <div className="form-group" style={{ marginTop: 12 }}>
                    <label>处理方式</label>
                    <div className="rc-seg">
                      {([['login', '登录已有账号'], ['register', '注册新账号']] as const).map(([k, l]) => (
                        <div
                          key={k}
                          className={`rc-seg-item ${mode === k ? 'active' : ''}`}
                          style={{ flex: 1, textAlign: 'center' }}
                          onClick={() => { setMode(k); setErr(''); }}
                        >{l}</div>
                      ))}
                    </div>
                  </div>
                  <div className="form-group">
                    <label>账号</label>
                    <input className="form-input" value={username} autoComplete="username"
                      onChange={e => setUsername(e.target.value)} placeholder="2~32 位，可用中文" />
                  </div>
                  <div className="form-group">
                    <label>密码</label>
                    <input className="form-input" type="password" value={password}
                      autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                      onChange={e => setPassword(e.target.value)} placeholder="至少 6 位" />
                  </div>
                  {mode === 'register' && (
                    <div className="form-group">
                      <label>邀请码</label>
                      <input className="form-input" value={invite}
                        onChange={e => setInvite(e.target.value)}
                        placeholder={isLanAddress(server) ? '在启动脚本那个黑色窗口里' : '向服务器管理员索取'} />
                      {isLanAddress(server) && (
                        <p className="hint">
                          自己电脑当服务器时，邀请码就是<b>你自己机器上的</b> ——
                          启动脚本弹出的那个黑色窗口里会打印，也写在 <code>server/config.json</code> 里。
                          第一次是你注册，之后想把账号给同事，就把这个码告诉他们。
                        </p>
                      )}
                    </div>
                  )}
                  <button className="btn btn-primary btn-block" disabled={busy === 'auth'} onClick={doAuth}>
                    {busy === 'auth' ? '请稍候…' : mode === 'register' ? '注册并登录' : '登录'}
                  </button>
                  {mode === 'register' && serverOk && !serverOk.registrationOpen && (
                    <p className="hint">⚠️ 这台服务器当前已关闭注册，请联系管理员。</p>
                  )}
                </>
              )}

              {/* 已登录 → 同步操作 */}
              {logged && user && (
                <>
                  <div className="cloud-meta">
                    <div><span>账号</span><b>{user.username}{user.isAdmin ? ' · 管理员' : ''}</b></div>
                    <div><span>本机数据</span><b>{localKB} KB</b></div>
                    {localSummary && (
                      <div><span>本机内容</span><b style={{ fontSize: 11 }}>{localSummary}</b></div>
                    )}
                    <div>
                      <span>云端备份</span>
                      <b style={{ color: blob ? '#34C759' : '#FF9500' }}>
                        {blob
                          ? `${new Date(blob.savedAt).toLocaleString()} · ${formatBytes(blob.bytes)}`
                          : '还没有上传过'}
                      </b>
                    </div>
                    {blob?.summary && (
                      <div><span>云端内容</span><b style={{ fontSize: 11 }}>{blob.summary}</b></div>
                    )}
                  </div>

                  <p className="hint" style={{ marginTop: 8 }}>
                    上传会把<b>当前全部数据</b>整包送到服务器（覆盖云端那一份，不会堆积多份）。
                    拉取用于换设备时把数据找回来。
                  </p>

                  <button className="btn btn-primary btn-block" style={{ marginTop: 10 }}
                    disabled={busy === 'upload'} onClick={doUpload}>
                    {busy === 'upload' ? '正在上传…' : '☁️ 上传当前全部数据到服务器'}
                  </button>

                  <div className="form-group" style={{ marginTop: 12 }}>
                    <label>拉取时如何处理本机数据</label>
                    <div className="rc-seg">
                      {([['merge', '合并（推荐）'], ['replace', '覆盖（整体替换）']] as const).map(([k, l]) => (
                        <div key={k} className={`rc-seg-item ${pullMode === k ? 'active' : ''}`}
                          style={{ flex: 1, textAlign: 'center' }} onClick={() => setPullMode(k)}>{l}</div>
                      ))}
                    </div>
                    <p className="hint">
                      {pullMode === 'merge'
                        ? '合并：本机现有记录保留，云端独有的记录追加进来，适合换新手机时把数据搬过来。'
                        : '覆盖：本机数据被云端那份整体替换，无法撤销 —— 只在确认本机数据不需要时用。'}
                    </p>
                  </div>

                  <button className="btn btn-outline btn-block" disabled={busy === 'download' || !blob}
                    onClick={doDownload}>
                    {busy === 'download' ? '正在拉取…' : '⬇️ 从云端拉取'}
                  </button>

                  {meta.lastUploadAt && (
                    <p className="hint" style={{ marginTop: 8 }}>
                      本机记录：上次上传 {new Date(meta.lastUploadAt).toLocaleString()}
                      {meta.lastDownloadAt ? ` · 上次拉取 ${new Date(meta.lastDownloadAt).toLocaleString()}` : ''}
                    </p>
                  )}

                  <div className="btn-row" style={{ marginTop: 12 }}>
                    <button className="btn btn-secondary btn-small" onClick={() => void refreshStatus()}>
                      🔄 刷新状态
                    </button>
                    <button className="btn btn-secondary btn-small" disabled={busy === 'logout'} onClick={doLogout}>
                      退出登录
                    </button>
                  </div>
                </>
              )}

              <button className="btn btn-danger btn-block" style={{ marginTop: 14 }} onClick={changeServer}>
                🔌 断开（改地址 / 恢复纯本机）
              </button>
              <p className="hint">
                断开只清除本机的登录状态，<b>服务器上那份数据不会被删</b>，本机数据也不受影响。
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
