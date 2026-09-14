import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  getData, saveSettings, saveHistory, clearAll,
  importSalariesFromText, saveSalary, deleteSalary,
  saveDuty, deleteDuty, setData,
  getSalaryCategories, saveSalaryCategories,
  DEFAULT_SALARY_CATEGORIES, normalizeModuleOrder,
} from './storage';
import { drawLeaveCanvasA4 } from './leaveCanvas';
import { calcDays, getWeekByStartDate, getSemesterText, wday, wdayFull, LEAVE_TYPES, getDefaultPeriodNames } from './utils';
import { exportSalaryCSV, exportSalaryHTML, exportDutyCSV, exportDutyHTML, exportSubCSV, exportSubHTML } from './export';
import type { SubRow, SalaryRecord, DutyRecord } from './types';
import { HomeworkPage } from './homework';
import { RecitePage } from './recite';
import {
  getBackupMeta, onStorageIssue, getStorageIssue, resetAfterCorruption,
} from './storage';
import type { StorageIssue } from './storage';
import {
  exportBackup, parseBackup, applyBackup, summarize, backupAsText,
  dataSizeKB, daysSinceBackup, exportCorruptRaw, describeScope, BACKUP_EXCLUDES,
  getPreImportSnapshot, restorePreImport, snapshotBeforeImport, shareBackup,
} from './backup';
import { makeQrDataUrl } from './qr';
import { CloudPanel } from './cloudPanel';
import { probeSameOrigin, bestShareUrl, setShareOrigin, getShareOrigin } from './cloud';
import { APP_VERSION, APP_BUILD, CHANGELOG } from './version';
import './App.css';

type Page = 'home' | 'leave' | 'schedule' | 'settings' | 'salary' | 'duty' | 'substitute' | 'payment' | 'homework' | 'recite';

/* ===== Module Config ===== */
const MODULE_CONFIG: Record<string, { icon: string; iconClass: string; name: string; desc: string }> = {
  leave: { icon: '📝', iconClass: 'red', name: '请假条', desc: '生成标准请假条' },
  schedule: { icon: '📋', iconClass: 'blue', name: '我的课表', desc: '查看个人课表' },
  homework: { icon: '📚', iconClass: 'green', name: '作业收缴', desc: '学生作业完成登记' },
  recite: { icon: '📖', iconClass: 'yellow', name: '古诗文背诵', desc: '背诵默写过关统计' },
  salary: { icon: '💰', iconClass: 'green', name: '工资统计', desc: '收入记录与图表' },
  duty: { icon: '📅', iconClass: 'yellow', name: '值班统计', desc: '值班记录与统计' },
  substitute: { icon: '📊', iconClass: 'purple', name: '代课统计', desc: '给别人代课统计' },
  payment: { icon: '💳', iconClass: 'orange', name: '支付截图', desc: '截图处理工具' },
  settings: { icon: '⚙️', iconClass: 'gray', name: '个人设置', desc: '课表、学校信息' },
};

function App() {
  const [pageStack, setPageStack] = useState<Page[]>(['home']);
  const page = pageStack[pageStack.length - 1];
  const isHome = page === 'home';
  const [data, setLocalData] = useState(getData());
  const toastRef = useRef<HTMLDivElement>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [swipeProgress, setSwipeProgress] = useState(0);
  const [pageTransition, setPageTransition] = useState<'idle' | 'entering'>('idle');
  const [activeInput, setActiveInput] = useState<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const refresh = useCallback(() => setLocalData(getData()), []);

  /**
   * 启动时探一次本机服务器：如果当前页面正是由自己电脑上的服务托管的，
   * 就记住「手机该用的局域网地址」，供各页面的二维码使用。
   *
   * 电脑上多半是 http://127.0.0.1:8787 打开的，直接拿当前地址做二维码，
   * 手机扫到的是它自己，永远打不开 —— 所以要用服务端给出的局域网地址。
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      const info = await probeSameOrigin();
      if (!alive || !info?.lan) return;
      const lan = bestShareUrl(info);
      if (lan) setShareOrigin(lan);
    })();
    return () => { alive = false; };
  }, []);

  const openQr = useCallback((url: string) => setQrUrl(url), []);
  const closeQr = useCallback(() => setQrUrl(null), []);

  const toast = useCallback((msg: string) => {
    const el = toastRef.current;
    if (el) { el.textContent = msg; el.style.display = 'block'; setTimeout(() => { if (el) el.style.display = 'none'; }, 2000); }
  }, []);

  /**
   * 存储层告警收口。
   * 原来写入是裸的 localStorage.setItem —— 配额写满会抛异常且无人处理，
   * 用户以为标记成功了，其实一条都没存上。现在统一在这里提示出来。
   */
  const [storageIssue, setStorageIssue] = useState<StorageIssue | null>(() => getStorageIssue());

  useEffect(() => {
    // 先取一次「启动前」就已发生的问题（例如数据文件损坏）
    const already = getStorageIssue();
    if (already) setStorageIssue(already);
    return onStorageIssue(issue => {
      setStorageIssue(issue);
      // 损坏需要常驻横幅；其余用轻提示就够
      if (issue.kind !== 'corrupt') toast('⚠️ ' + issue.message);
    });
  }, [toast]);

  const dismissStorageIssue = useCallback(() => setStorageIssue(null), []);

  const handleDownloadCorrupt = useCallback(() => {
    const name = exportCorruptRaw();
    toast(name ? `✅ 已导出：${name}` : '没有找到可导出的原始内容');
  }, [toast]);

  const handleResetCorrupt = useCallback(() => {
    if (!confirm('确定要放弃这份损坏的数据吗？\n\n原始内容会被清除且无法找回。\n如果还没下载，请先点「下载原始数据」。')) return;
    resetAfterCorruption();
    setStorageIssue(null);
    refresh();
    toast('已清除损坏数据，可以从头开始使用');
  }, [refresh, toast]);

  // 监听 input/textarea 焦点,显示一键粘贴浮动按钮(iOS PWA 兼容)
  useEffect(() => {
    const onFocusIn = (e: Event) => {
      const target = e.target as HTMLElement;
      if (!target) return;
      const tag = target.tagName;
      // date 类型 input 不支持文本粘贴,跳过
      if (tag === 'INPUT' && (target as HTMLInputElement).type === 'date') {
        setActiveInput(null);
        return;
      }
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        setActiveInput(target as HTMLInputElement | HTMLTextAreaElement);
      } else {
        setActiveInput(null);
      }
    };
    const onFocusOut = () => {
      // 延迟清空,避免按钮点击瞬间失焦导致按钮消失
      setTimeout(() => setActiveInput(null), 200);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  const handleQuickPaste = useCallback(async () => {
    if (!activeInput) return;
    let text = '';
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        text = await navigator.clipboard.readText();
      }
    } catch {
      // 静默失败
    }
    if (!text) {
      // 兜底:尝试 execCommand
      try {
        const ta = document.createElement('textarea');
        ta.value = '';
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        document.execCommand('paste');
        text = ta.value;
        document.body.removeChild(ta);
      } catch {
        toast('未能读取剪贴板,请先复制内容');
        return;
      }
    }
    if (!text) {
      toast('剪贴板为空');
      return;
    }
    const el = activeInput;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const oldValue = el.value;
    const newValue = oldValue.slice(0, start) + text + oldValue.slice(end);
    // 通过原生 setter 触发 React onChange
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, newValue);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
    // 把光标放到新内容末尾
    const newPos = start + text.length;
    try { el.setSelectionRange(newPos, newPos); } catch { /* ignore */ }
    toast('✅ 已粘贴');
  }, [activeInput, toast]);

  const navigate = useCallback((newPage: Page) => {
    if (newPage === page) return;
    if (newPage === 'home') {
      setPageStack(['home']);
    } else {
      setPageStack(prev => [...prev, newPage]);
    }
    setPageTransition('entering');
    setTimeout(() => setPageTransition('idle'), 350);
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [page]);

  const goBack = useCallback(() => {
    if (pageStack.length <= 1) return;
    setPageStack(prev => prev.slice(0, -1));
    setPageTransition('idle');
  }, [pageStack]);

  // 左滑返回手势(iOS 风格,从屏幕左边缘右滑)
  useEffect(() => {
    if (isHome) {
      setSwipeProgress(0);
      return;
    }
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let tracking = false;

    const onTouchStart = (e: TouchEvent) => {
      // 如果触摸发生在表单输入框、按钮或文本区域内,完全跳过手势识别
      // 避免影响 iOS PWA 的长按剪贴板菜单
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
        tracking = false;
        return;
      }
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      startTime = Date.now();
      // 仅在屏幕左边缘 24px 内启动手势
      tracking = startX < 24;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!tracking) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);
      // 横向滑动占主导
      if (dx > 10 && dx > dy * 1.5) {
        // 阻力曲线:前 80px 线性,之后衰减
        const progress = dx < 80 ? dx / 120 : 0.667 + (dx - 80) / 240;
        setSwipeProgress(Math.min(progress, 0.95));
      } else if (dy > dx * 1.5) {
        // 纵向滑动,放弃手势追踪
        tracking = false;
        setSwipeProgress(0);
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!tracking) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const elapsed = Date.now() - startTime;
      // 触发条件:滑动 > 90px 且时长 < 600ms
      if (dx > 90 && elapsed < 600) {
        goBack();
      }
      setSwipeProgress(0);
      tracking = false;
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [isHome, goBack]);

  const settings = data.settings;
  const schoolName = settings?.schoolName || '××中学';
  const semesterText = getSemesterText(settings?.semesterName);
  const schedule = settings?.schedule;
  const periodNames = settings?.periodNames || getDefaultPeriodNames();
  // 首页模块顺序：必须走 normalizeModuleOrder 补齐。
  // 老数据（升级前保存过设置、或导入过旧备份）里的顺序缺后来新增的模块，
  // 直接渲染会让「古诗文背诵」等新模块的卡片凭空消失。
  const moduleOrder = normalizeModuleOrder(settings?.moduleOrder);

  const swipeOffset = swipeProgress * 90;
  const swipeOpacity = swipeProgress;
  /** 底部导航的选中态(用 string 比较,避免 TS 对 page 做字面量收窄) */
  const navActive = (p: string) => (page === p ? 'active' : '');

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-title"><span className="header-emoji">📱</span>教师个人助手</div>
      </header>

      <main
        className={`container ${pageTransition === 'entering' ? 'page-enter' : ''}`}
        style={{
          transform: swipeOffset > 0 ? `translateX(${swipeOffset}px)` : undefined,
          transition: swipeProgress > 0 ? 'none' : 'transform 0.32s cubic-bezier(0.32, 0.72, 0, 1)',
          opacity: 1 - swipeOpacity * 0.4,
        }}
      >
        {isHome && <HomePage navigate={navigate} moduleOrder={moduleOrder} />}
        {page === 'leave' && <LeavePage settings={settings} schoolName={schoolName} semesterText={semesterText} periodNames={periodNames} toast={toast} refresh={refresh} openQr={openQr} />}
        {page === 'schedule' && <SchedulePage settings={settings} periodNames={periodNames} schedule={schedule} toast={toast} openQr={openQr} />}
        {page === 'settings' && <SettingsPage settings={settings} toast={toast} refresh={refresh} moduleOrder={moduleOrder} openQr={openQr} />}
        {page === 'salary' && <SalaryPage toast={toast} />}
        {page === 'duty' && <DutyOnlyPage toast={toast} />}
        {page === 'substitute' && <SubstituteOnlyPage toast={toast} />}
        {page === 'payment' && <PaymentPage toast={toast} openQr={openQr} />}
        {page === 'homework' && <HomeworkPage toast={toast} openQr={openQr} />}
        {page === 'recite' && <RecitePage toast={toast} openQr={openQr} />}
      </main>

      {isHome && (
        <nav className="bottom-nav">
          <button className={`nav-item ${navActive('home')}`} onClick={() => navigate('home')}><span className="nav-icon">🏠</span><span>首页</span></button>
          <button className={`nav-item ${navActive('schedule')}`} onClick={() => navigate('schedule')}><span className="nav-icon">📋</span><span>课表</span></button>
          <button className={`nav-item ${navActive('settings')}`} onClick={() => navigate('settings')}><span className="nav-icon">👤</span><span>我的</span></button>
        </nav>
      )}

      {/* 一键粘贴浮动按钮(iOS PWA 兼容) */}
      {activeInput && (
        <button className="floating-paste-btn" onMouseDown={e => e.preventDefault()} onClick={handleQuickPaste} type="button">
          📋 粘贴
        </button>
      )}

      {/* 左滑返回指示器(iOS 风格) */}
      {!isHome && swipeProgress > 0 && (
        <div className="swipe-indicator" style={{ opacity: swipeProgress }}>
          <div className="swipe-indicator-arrow">‹</div>
          <div className="swipe-indicator-label">返回</div>
        </div>
      )}

      {storageIssue && (
        <div className={`storage-alert storage-alert-${storageIssue.kind}`} role="alert">
          <div className="storage-alert-head">
            <span className="storage-alert-title">
              {storageIssue.kind === 'corrupt' ? '⚠️ 本地数据文件损坏' : '⚠️ 数据未能保存'}
            </span>
            {storageIssue.kind !== 'corrupt' && (
              <button className="storage-alert-close" onClick={dismissStorageIssue} aria-label="关闭">✕</button>
            )}
          </div>
          <p className="storage-alert-text">{storageIssue.message}</p>
          {storageIssue.kind === 'corrupt' && (
            <div className="storage-alert-actions">
              <button className="btn btn-small btn-primary" onClick={handleDownloadCorrupt}>下载原始数据</button>
              <button className="btn btn-small btn-outline" onClick={handleResetCorrupt}>放弃并重新开始</button>
            </div>
          )}
        </div>
      )}

      <div ref={toastRef} className="toast" />

      {qrUrl && <QrShareModal url={qrUrl} onClose={closeQr} toast={toast} />}
    </div>
  );
}

/* ============ 二维码分享模态框 ============ */
function QrShareModal({ url, onClose, toast }: { url: string; onClose: () => void; toast: (m: string) => void }) {
  // 本地生成,不再依赖第三方二维码接口:断网或对方服务异常时照样能扫
  const qrSrc = useMemo(() => makeQrDataUrl(url, 6), [url]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('链接已复制到剪贴板');
    } catch {
      toast('复制失败,请手动选择文本');
    }
  };

  return (
    <div className="qr-modal-overlay" onClick={onClose}>
      <div className="qr-modal" onClick={e => e.stopPropagation()}>
        <div className="qr-modal-header">
          <span className="qr-modal-title">📱 扫码访问</span>
          <button className="qr-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="qr-modal-body">
          {qrSrc
            ? <img src={qrSrc} alt="分享二维码" className="qr-img" />
            : <div className="qr-img-error">二维码生成失败，请改用下方「复制链接」</div>}
          <p className="qr-hint">📲 用手机相机/微信扫一扫即可打开</p>
          <p className="qr-hint-sub">iPhone Safari / Android Chrome 可"添加到主屏幕",像 App 一样使用</p>
          <div className="qr-url-box">{url}</div>
          <div className="qr-btn-row">
            <button className="btn btn-primary" onClick={copyLink}>📋 复制链接</button>
            <button className="btn btn-outline" onClick={onClose}>关闭</button>
          </div>
          <p className="qr-tip">💡 提示:长按上方二维码图片可直接保存到相册,然后发到微信/QQ</p>
        </div>
      </div>
    </div>
  );
}

/* ============ 首页 ============ */
function HomePage({ navigate, moduleOrder }: { navigate: (p: Page) => void; moduleOrder: string[] }) {
  // 备份提醒：只在「确实有数据」且「超过 14 天没备份」时出现
  const d = getData();
  const hasData = (d.history?.length || 0) + (d.salaries?.length || 0) + (d.duties?.length || 0)
    + (d.homeworkRecords?.length || 0) + (d.reciteRecords?.length || 0) > 0;
  const days = daysSinceBackup();
  const needBackup = hasData && (days === Infinity || days >= 14);

  return (
    <div>
      {needBackup && (
        <div className="backup-tip" onClick={() => navigate('settings')}>
          <span className="backup-tip-icon">💾</span>
          <div className="backup-tip-text">
            <b>{days === Infinity ? '你的数据还没备份过' : `上次备份已经是 ${days} 天前了`}</b>
            <em>数据只存在这台设备里，清缓存或换手机会全部丢失，建议导出备份</em>
          </div>
          <span className="backup-tip-go">去备份 ›</span>
        </div>
      )}
      <div className="home-grid">
        {moduleOrder.map(key => {
          const mod = MODULE_CONFIG[key];
          if (!mod) return null;
          return (
            <div key={key} className="feature-card" onClick={() => navigate(key as Page)}>
              <div className={`feature-icon ${mod.iconClass}`}>{mod.icon}</div>
              <div className="feature-name">{mod.name}</div>
              <div className="feature-desc">{mod.desc}</div>
            </div>
          );
        })}
      </div>
      {/* 版本号放在首页最下面：一眼能看出自己用的是哪一版 */}
      <div className="home-ver" onClick={() => navigate('settings')}>
        教师助手 <b>{APP_VERSION}</b> · 更新于 {APP_BUILD} · 点这里看更新内容
      </div>
    </div>
  );
}

/* ============ 请假条 ============ */
function LeavePage({ settings, schoolName, semesterText, periodNames, toast, refresh, openQr }: any) {
  const [name, setName] = useState(settings?.name || '');
  const [reason, setReason] = useState('');
  const [type, setType] = useState('公假');
  const [sd, setSd] = useState(() => new Date().toISOString().slice(0, 10));
  const [ed, setEd] = useState(() => new Date().toISOString().slice(0, 10));
  const [sp, setSp] = useState('上午');
  const [ep, setEp] = useState('下午');
  const [days, setDays] = useState(0.5);
  const [sw, setSw] = useState(1);
  const [ew, setEw] = useState(1);
  const [subs, setSubs] = useState<SubRow[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  // A4打印版（唯一模式）
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modalCanvasRef = useRef<HTMLCanvasElement>(null);
  const [showModal, setShowModal] = useState(false);

  // 当模态框打开时，从预览canvas复制内容到modal canvas
  useEffect(() => {
    if (showModal && canvasRef.current && modalCanvasRef.current) {
      const src = canvasRef.current;
      const dst = modalCanvasRef.current;
      dst.width = src.width;
      dst.height = src.height;
      const ctx = dst.getContext('2d');
      if (ctx) ctx.drawImage(src, 0, 0);
    }
  }, [showModal]);

  const classSubjectOptions = (() => {
    const opts = new Set<string>();
    if (settings?.schedule) for (const day in settings.schedule.courses) for (const c of settings.schedule.courses[day]) if (c.classSubject) opts.add(c.classSubject);
    return Array.from(opts).sort();
  })();

  const updateSubsFromDates = (startD: string, endD: string, startP: string, endP: string) => {
    const d = calcDays(startD, endD, startP, endP);
    setDays(d);
    if (startD && endD) {
      const s = new Date(startD); const e = new Date(endD);
      setSw(getWeekByStartDate(s, settings?.startSchoolDate));
      setEw(getWeekByStartDate(e, settings?.startSchoolDate));
      if (settings?.schedule) {
        const rows: SubRow[] = [];
        const cur = new Date(s); const endDt = new Date(e);
        while (cur <= endDt) {
          const dn = cur.getDay();
          if (dn !== 0 && dn !== 6) {
            const cs = settings.schedule.courses[dn] || [];
            for (const c of cs) rows.push({ week: getWeekByStartDate(new Date(cur), settings?.startSchoolDate), day: wdayFull(new Date(cur)), dayShort: wday(new Date(cur)), dayNum: dn, period: c.period, classSubject: c.classSubject, teacher: '' });
          }
          cur.setDate(cur.getDate() + 1);
        }
        setSubs(rows);
      }
    }
  };

  const generate = () => {
    if (!name || !reason || !sd || !ed) { toast('请填写完整信息'); return; }
    try {
      const tempCanvas = document.createElement('canvas');
      const data = { name, reason, type, days, start: new Date(sd), end: new Date(ed), sp, ep, sw, ew, subs, schoolName, semesterText };
      drawLeaveCanvasA4(tempCanvas, data);

      setShowPreview(true);
      requestAnimationFrame(() => {
        const c = canvasRef.current;
        if (c) {
          c.width = tempCanvas.width;
          c.height = tempCanvas.height;
          const ctx = c.getContext('2d');
          if (ctx) ctx.drawImage(tempCanvas, 0, 0);
        }
      });

      saveHistory({ name, reason, type, days, sd, ed, sp, ep, sw, ew, subs, time: new Date().toISOString() });
      refresh();
      toast('生成成功！');
    } catch (e: any) {
      console.error(e);
      toast('生成失败：' + (e.message || '未知错误'));
    }
  };

  return (
    <div className="page">
      <div className="card">
        <div className="card-header"><span className="header-icon">📝</span><span>请假条助手</span></div>
        <div className="card-body">
          <div className="form-group">
            <label>请假人 <span className="required">*</span></label>
            <input className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="请输入姓名" />
          </div>
          <div className="form-group">
            <label>请假类型</label>
            <div className="type-grid">
              {LEAVE_TYPES.map(t => <div key={t} className={`type-btn ${type === t ? 'selected' : ''}`} onClick={() => setType(t)}>{t}</div>)}
            </div>
          </div>
          <div className="form-group">
            <label>请假原因 <span className="required">*</span></label>
            <select className="form-select" onChange={e => { if (e.target.value) setReason(e.target.value); }}>
              <option value="">-- 选择常见原因 --</option>
              {['参加教研活动','参加教师培训','参加教学研讨会','外出学习交流','参加学校会议','参加班主任培训','因病就诊','家中急事','处理个人事务'].map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <input className="form-input" value={reason} onChange={e => setReason(e.target.value)} placeholder="输入具体原因" style={{ marginTop: 8 }} />
            <div className="quick-tags">
              {['教研活动','教师培训','因病就诊','学习交流','学校会议','家中急事'].map(tag => (
                <button key={tag} className="quick-tag" onClick={() => { const map: Record<string, string> = { '教研活动': '参加教研活动', '教师培训': '参加教师培训', '因病就诊': '因病就诊', '学习交流': '外出学习交流', '学校会议': '参加学校会议', '家中急事': '家中急事' }; setReason(map[tag] || tag); }}>{tag}</button>
              ))}
            </div>
          </div>
          <div className="form-row">
            <div className="form-group flex1">
              <label>开始日期</label>
              <input type="date" className="form-input" value={sd} onChange={e => { setSd(e.target.value); updateSubsFromDates(e.target.value, ed, sp, ep); }} />
            </div>
            <div className="form-group flex1">
              <label>开始时段</label>
              <div className="period-seg">
                {['上午','下午','全天'].map(p => (
                  <div key={p} className={`period-seg-item ${sp === p ? 'selected' : ''}`} onClick={() => { setSp(p); updateSubsFromDates(sd, ed, p, ep); }}>
                    {p}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group flex1">
              <label>结束日期</label>
              <input type="date" className="form-input" value={ed} onChange={e => { setEd(e.target.value); updateSubsFromDates(sd, e.target.value, sp, ep); }} />
            </div>
            <div className="form-group flex1">
              <label>结束时段</label>
              <div className="period-seg">
                {['上午','下午','全天'].map(p => (
                  <div key={p} className={`period-seg-item ${ep === p ? 'selected' : ''}`} onClick={() => { setEp(p); updateSubsFromDates(sd, ed, sp, p); }}>
                    {p}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="info-box">
            <div>📅 请假 <strong>{days % 1 === 0 ? days : days.toFixed(1)}</strong> 天</div>
            <div>第 {sw} 周 星期{wday(new Date(sd))} 至 第 {ew} 周 星期{wday(new Date(ed))}</div>
            <div>{subs.length > 0 ? `📚 ${subs.length} 节课需安排代课` : '📚 该时间段无课程安排'}</div>
          </div>
          {subs.length > 0 && (
            <div className="sub-section">
              <div className="sub-header"><span>🔄 代课人员安排</span><span className="badge">第 {sw} 周</span></div>
              {subs.map((s, i) => (
                <div key={i} className="sub-card">
                  <div className="sub-card-header"><span className="sub-day">{s.day}</span><span className="sub-delete" onClick={() => setSubs(prev => prev.filter((_, idx) => idx !== i))}>×</span></div>
                  <div className="sub-card-body">
                    <div className="sub-field">
                      <label>节次</label>
                      <select className="sub-select" value={s.period} onChange={e => setSubs(prev => { const n = [...prev]; n[i] = { ...n[i], period: e.target.value }; return n; })}>
                        {periodNames.map((p: string) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </div>
                    <div className="sub-field">
                      <label>班级科目</label>
                      <select className="sub-select" value={s.classSubject} onChange={e => setSubs(prev => { const n = [...prev]; n[i] = { ...n[i], classSubject: e.target.value }; return n; })}>
                        <option value="">--选择--</option>
                        {classSubjectOptions.map((o: string) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </div>
                    <div className="sub-field">
                      <label>代课教师</label>
                      <input className="sub-input" value={s.teacher} onChange={e => setSubs(prev => { const n = [...prev]; n[i] = { ...n[i], teacher: e.target.value }; return n; })} placeholder="填写" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="add-row" onClick={() => setSubs(prev => [...prev, { week: sw, day: '星期一', dayShort: '一', dayNum: 1, period: '第1节', classSubject: '', teacher: '' }])}><span>+</span> 手动添加代课安排</div>
          <button className="btn btn-primary btn-block" onClick={generate} style={{ marginTop: 16 }}>✨ 生成请假条</button>
        </div>
      </div>
      {showPreview && (
        <div id="previewSection" className="card" style={{ marginTop: 12 }}>
          <div className="card-body">
            <div className="preview-header">
              <span>🖼️ 请假条预览（点击放大）</span>
              <div className="view-tabs">
                <span style={{ fontSize: 13, color: '#666' }}>📄 A4打印版</span>
              </div>
            </div>
            <canvas ref={canvasRef} style={{ width: '100%', height: 'auto', borderRadius: 8, boxShadow: '0 2px 12px rgba(0,0,0,0.1)', cursor: 'pointer' }} onClick={() => setShowModal(true)} />
            <div className="btn-row" style={{ justifyContent: 'center' }}>
              <button className="btn" style={{ background: 'linear-gradient(135deg,#c62828 0%,#b71c1c 100%)', color: '#fff', fontSize: 16, padding: '12px 40px', flex: 'none', minWidth: 200 }} onClick={() => { const c = canvasRef.current; if (!c) return; const win = window.open('', '_blank'); if (!win) return; win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>请假条</title><style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;font-family:sans-serif;}img{max-width:95%;box-shadow:0 4px 20px rgba(0,0,0,0.15);}.back-btn{position:fixed;top:20px;left:20px;padding:10px 20px;background:#c62828;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;z-index:1000;box-shadow:0 2px 8px rgba(0,0,0,0.2);}@media print{body{background:white;}img{box-shadow:none;}.back-btn{display:none!important;}}</style></head><body><button class="back-btn" onclick="window.close()">← 返回</button><img src="${c.toDataURL('image/png')}" /></body></html>`); win.document.close(); toast('已打开，按Ctrl+P打印或另存为PDF'); }}>🖨️ 导出PDF</button>
              {/* 新增:分享请假条 */}
              <button className="btn btn-primary" title="通过系统分享到微信/QQ/收藏等" onClick={async () => {
                const c = canvasRef.current; if (!c) return;
                c.toBlob(async (blob) => {
                  if (!blob) { toast('生成失败'); return; }
                  const file = new File([blob], `请假条_${name}_${sd}.png`, { type: 'image/png' });
                  if ((navigator as any).canShare?.({ files: [file] })) {
                    try { await (navigator as any).share({ files: [file], title: '请假条', text: `${name} ${type} ${sd}` }); toast('✅ 已分享'); }
                    catch (e: any) { if (e?.name !== 'AbortError') toast('分享失败'); }
                  } else if ((navigator as any).share) {
                    try { await (navigator as any).share({ title: '请假条', text: `${name} ${type} ${sd}`, url: location.href }); toast('✅ 已分享'); }
                    catch { /* 用户取消 */ }
                  } else {
                    try {
                      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                      toast('✅ 请假条已复制到剪贴板,长按图片或去聊天粘贴');
                    } catch {
                      const a = document.createElement('a'); a.download = `请假条_${name}.png`; a.href = c.toDataURL('image/png'); a.click();
                      toast('当前浏览器不支持分享,已下载图片,请手动发送');
                    }
                  }
                }, 'image/png');
              }}>🔗 分享</button>
              {/* 新增:二维码分享 */}
              <button className="btn btn-outline" onClick={() => openQr?.(settings?.pwaUrl || getShareOrigin())} title="生成二维码,扫码分享 PWA">📱 二维码</button>
            </div>
            <p className="hint" style={{ textAlign: 'center' }}>点击图片可放大查看,长按图片可保存到相册</p>
          </div>
        </div>
      )}
      {showModal && (
        <div className="modal-overlay-light" onClick={() => setShowModal(false)}>
          <button className="modal-close" style={{ background: 'rgba(0,0,0,0.5)', color: 'white' }} onClick={() => setShowModal(false)}>×</button>
          <div className="modal-content-light" onClick={e => e.stopPropagation()}>
            <canvas ref={modalCanvasRef} style={{ maxWidth: '95vw', maxHeight: '75vh', width: 'auto', height: 'auto', borderRadius: 4, boxShadow: '0 4px 20px rgba(0,0,0,0.15)' }} />
          </div>
          <button className="btn" style={{ marginTop: 12, background: 'linear-gradient(135deg,#c62828 0%,#b71c1c 100%)', color: '#fff', fontSize: 16, padding: '10px 32px' }} onClick={() => {
            const c = modalCanvasRef.current || canvasRef.current;
            if (!c) return;
            const win = window.open('', '_blank');
            if (!win) return;
            win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>请假条</title><style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;font-family:sans-serif;}img{max-width:95%;box-shadow:0 4px 20px rgba(0,0,0,0.15);}.back-btn{position:fixed;top:20px;left:20px;padding:10px 20px;background:#c62828;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;z-index:1000;box-shadow:0 2px 8px rgba(0,0,0,0.2);}@media print{body{background:white;}img{box-shadow:none;}.back-btn{display:none!important;}}</style></head><body><button class="back-btn" onclick="window.close()">← 返回</button><img src="${c.toDataURL('image/png')}" /></body></html>`);
            win.document.close();
            toast('已打开，按Ctrl+P打印或另存为PDF');
          }}>🖨️ 导出PDF</button>
          <div style={{ color: '#999', fontSize: 12, marginTop: 8 }}>👆 点击空白处关闭</div>
        </div>
      )}
    </div>
  );
}

/* ============ 课表查看(支持表格/图片双模式;时间可折叠) ============ */
function SchedulePage({ settings, periodNames, schedule, toast, openQr }: any) {
  const [viewMode, setViewMode] = useState<'table' | 'image'>('table');
  // 时间显示开关:默认折叠(更紧凑),true=展开,显示 07:20-07:50;false=只显示节次名
  const [showPeriodTime, setShowPeriodTime] = useState<boolean>(true);
  // 作息时间表(顶部那一行)默认折叠
  const [showTimeTable, setShowTimeTable] = useState<boolean>(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modalCanvasRef = useRef<HTMLCanvasElement>(null);
  const [showImageModal, setShowImageModal] = useState(false);

  if (!schedule) return <div className="page"><div className="card"><div className="card-header"><span className="header-icon">📋</span><span>我的课表</span></div><div className="card-body empty"><div className="empty-icon">📋</div><p>暂无课表数据</p></div></div></div>;

  const timeTable = settings?.timeTable || [];
  const dayNames = ['星期一','星期二','星期三','星期四','星期五'];

  const drawScheduleImage = (canvas: HTMLCanvasElement | null) => {
    const c = canvas || canvasRef.current; if (!c) return;
    const ctx = c.getContext('2d'); if (!ctx) return;
    const cw = 900, ch = 640, lm = 40, tm = 50, rh = showPeriodTime ? 46 : 32, cw_cell = (cw - lm - 100) / 5;
    c.width = cw; c.height = ch + (timeTable.length > 0 ? 60 : 0);

    // 背景
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);

    // 标题
    ctx.fillStyle = '#c41e3a'; ctx.font = 'bold 22px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText((settings?.schoolName || '××中学') + ' 课程表', cw / 2, 32);

    // 表头
    ctx.fillStyle = '#fde8eb'; ctx.fillRect(lm, tm, 100, rh);
    ctx.strokeStyle = '#c41e3a'; ctx.lineWidth = 1; ctx.strokeRect(lm, tm, 100, rh);
    ctx.fillStyle = '#c41e3a'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('节次', lm + 50, tm + rh / 2 + 5);

    dayNames.forEach((d, i) => {
      const x = lm + 100 + i * cw_cell;
      ctx.fillStyle = '#fde8eb'; ctx.fillRect(x, tm, cw_cell, rh);
      ctx.strokeStyle = '#c41e3a'; ctx.strokeRect(x, tm, cw_cell, rh);
      ctx.fillStyle = '#c41e3a'; ctx.fillText(d, x + cw_cell / 2, tm + rh / 2 + 5);
    });

    // 数据行
    periodNames.forEach((period: string, pi: number) => {
      const y = tm + rh + pi * rh;
      // 时间列
      const timeSlot = timeTable.find((t: any) => t.name === period);
      ctx.fillStyle = '#fafafa'; ctx.fillRect(lm, y, 100, rh);
      ctx.strokeStyle = '#e0e0e0'; ctx.strokeRect(lm, y, 100, rh);
      ctx.fillStyle = '#333'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(period, lm + 50, y + rh / 2 + (showPeriodTime ? -2 : 5));
      if (showPeriodTime && timeSlot) {
        ctx.fillStyle = '#999'; ctx.font = '10px sans-serif';
        ctx.fillText(timeSlot.startTime + '-' + timeSlot.endTime, lm + 50, y + rh / 2 + 14);
      }

      dayNames.forEach((_day: string, di: number) => {
        const x = lm + 100 + di * cw_cell;
        const courses = schedule.courses[di + 1] || [];
        const found = courses.find((cc: any) => cc.period === period);
        ctx.fillStyle = found ? '#e8f4ff' : '#fff'; ctx.fillRect(x, y, cw_cell, rh);
        ctx.strokeStyle = '#e0e0e0'; ctx.strokeRect(x, y, cw_cell, rh);
        if (found) {
          ctx.fillStyle = '#0066cc'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
          ctx.fillText(found.classSubject, x + cw_cell / 2, y + rh / 2 + 4);
        }
      });
    });

    // 底部时间
    if (timeTable.length > 0 && showPeriodTime) {
      const ty = tm + rh + periodNames.length * rh + 20;
      ctx.fillStyle = '#666'; ctx.font = '12px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('⏰ 作息时间表:' + timeTable.map((t: any) => t.name + ' ' + t.startTime + '-' + t.endTime).join(' | '), lm, ty);
    }
  };

  // 切换模式时自动重绘
  useEffect(() => {
    if (viewMode === 'image') {
      setTimeout(() => drawScheduleImage(canvasRef.current), 100);
    }
  }, [viewMode, showPeriodTime]);

  // 同步到大图预览
  useEffect(() => {
    if (showImageModal && canvasRef.current && modalCanvasRef.current) {
      drawScheduleImage(modalCanvasRef.current);
    }
  }, [showImageModal]);

  /** 一键分享课表图(Web Share API 优先,降级到复制+下载) */
  const shareSchedule = async () => {
    drawScheduleImage(canvasRef.current);
    const c = canvasRef.current; if (!c) return;
    c.toBlob(async (blob) => {
      if (!blob) { toast('生成失败'); return; }
      const file = new File([blob], '我的课表.png', { type: 'image/png' });
      if ((navigator as any).share && (navigator as any).canShare?.({ files: [file] })) {
        try {
          await (navigator as any).share({ files: [file], title: '我的课表', text: `${settings?.schoolName || ''} 教师课表` });
          toast('✅ 已分享');
        } catch (e: any) { if (e?.name !== 'AbortError') toast('分享已取消'); }
      } else if ((navigator as any).share) {
        try {
          await (navigator as any).share({ title: '我的课表', text: `${settings?.schoolName || ''} 教师课表 - 课表助手生成`, url: location.href });
          toast('✅ 已分享');
        } catch (e: any) { if (e?.name !== 'AbortError') toast('分享已取消'); }
      } else {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          toast('✅ 课表已复制到剪贴板,长按图片或去聊天粘贴');
        } catch {
          const a = document.createElement('a'); a.download = '我的课表.png'; a.href = c.toDataURL('image/png'); a.click();
          toast('当前浏览器不支持分享,已下载图片,请手动发送给同事');
        }
      }
    }, 'image/png');
  };

  return (
    <div className="page">
      <div className="card">
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span className="header-icon">📋</span><span>我的课表</span></div>
          <div className="view-tabs">
            {/* 新增:时间可折叠开关 */}
            <button
              className={`view-tab time-toggle ${showPeriodTime ? 'active' : ''}`}
              onClick={() => setShowPeriodTime(v => !v)}
              title={showPeriodTime ? '折叠时间,只看节次' : '展开时间,显示每节课具体时段'}
            >
              {showPeriodTime ? '⏰ 折叠时间' : '⏰ 展开时间'}
            </button>
            <button className={`view-tab ${viewMode === 'table' ? 'active' : ''}`} onClick={() => setViewMode('table')}>📊 表格</button>
            <button className={`view-tab ${viewMode === 'image' ? 'active' : ''}`} onClick={() => { setViewMode('image'); setTimeout(() => drawScheduleImage(canvasRef.current), 100); }}>🖼️ 图片</button>
          </div>
        </div>
        <div className="card-body">
          {/* 表格模式 */}
          {viewMode === 'table' && (
            <>
              {timeTable.length > 0 && (
                <div className="time-table" style={{ marginBottom: 16 }}>
                  <div
                    className="section-title collapse-toggle"
                    onClick={() => setShowTimeTable(v => !v)}
                  >
                    <span>⏰ 学校作息时间表</span>
                    <span className="caret">{showTimeTable ? '▼' : '▶'}</span>
                  </div>
                  {showTimeTable && (
                    <div className="time-table-grid">{timeTable.map((t: any, i: number) => <div key={i} className="time-slot"><span className="time-name">{t.name}</span><span className="time-range">{t.startTime} - {t.endTime}</span></div>)}</div>
                  )}
                </div>
              )}
              <div className="schedule-scroll">
                <table className="schedule-table">
                  <thead><tr><th>节次<br/><span style={{fontSize:10,fontWeight:400,color:'#999'}}>时间</span></th>{dayNames.map(d => <th key={d}>{d}</th>)}</tr></thead>
                  <tbody>
                    {periodNames.map((period: string) => (
                      <tr key={period}>
                        <td className="period-cell">
                          {period}
                          {showPeriodTime && (() => { const tt = timeTable.find((t: any) => t.name === period); return tt ? <div style={{fontSize:10,color:'#999',fontWeight:400}}>{tt.startTime}-{tt.endTime}</div> : null; })()}
                        </td>
                        {dayNames.map((day, di) => { const courses = schedule.courses[di + 1] || []; const found = courses.find((c: any) => c.period === period); return <td key={day} className={found ? 'has-course' : 'empty'}>{found ? <span className="course-tag">{found.classSubject}</span> : '-'}</td>; })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="hint" style={{ textAlign: 'center', marginTop: 8 }}>
                💡 顶部「⏰ 折叠时间」可让表格更紧凑;作息时间表可点击标题折叠
              </p>
            </>
          )}

          {/* 图片模式 */}
          {viewMode === 'image' && (
            <div>
              <canvas ref={canvasRef} onClick={() => setShowImageModal(true)} style={{ width: '100%', borderRadius: 8, border: '1px solid #eee', boxShadow: '0 2px 8px rgba(0,0,0,0.06)', cursor: 'pointer' }} />
              <div className="btn-row" style={{ marginTop: 12 }}>
                <button className="btn btn-success" onClick={() => { drawScheduleImage(canvasRef.current); const c = canvasRef.current; if (!c) return; const a = document.createElement('a'); a.download = '我的课表.png'; a.href = c.toDataURL('image/png'); a.click(); }}>📥 保存课表图片</button>
                <button className="btn btn-outline" onClick={() => drawScheduleImage(canvasRef.current)}>🔄 重新生成</button>
                {/* 新增:分享课表 */}
                <button className="btn btn-primary" onClick={shareSchedule} title="通过系统分享到微信/QQ/收藏等">🔗 分享</button>
                {/* 新增:二维码分享 */}
                <button className="btn btn-outline" onClick={() => openQr?.(settings?.pwaUrl || getShareOrigin())} title="生成二维码,扫码分享 PWA">📱 二维码</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 课表大图预览模态框(原项目无此功能,加上的) */}
      {showImageModal && (
        <div className="modal-overlay" onClick={() => setShowImageModal(false)}>
          <button className="modal-close" onClick={() => setShowImageModal(false)}>×</button>
          <div className="modal-content" onClick={(e: any) => e.stopPropagation()}>
            <canvas ref={modalCanvasRef} style={{ maxWidth: '95vw', maxHeight: '80vh', borderRadius: 6, boxShadow: '0 4px 24px rgba(0,0,0,0.2)' }} />
          </div>
          <div className="modal-hint">点击空白处或 × 关闭</div>
        </div>
      )}
    </div>
  );
}

/* ============ 设置（含模块排序） ============ */
/* ============ 版本与更新记录 ============
   版本号与更新内容都写在 src/version.ts，发版时只改那一个文件。
   这里只负责展示 —— 免得版本号散落在多处、改漏一个用户就看不出区别。 */
export function VersionSection({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="settings-section">
      <div className={`section-header ${open ? '' : 'collapsed'}`} onClick={() => setOpen(!open)}>
        <span>🆕 版本与更新记录</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <em className="sec-ver">{APP_VERSION}</em>
          <span>{open ? '▼' : '▶'}</span>
        </span>
      </div>
      {open && (
        <div className="section-body">
          <div className="ver-hero">
            <div className="ver-hero-num">{APP_VERSION}</div>
            <div className="ver-hero-meta">
              <div>更新于 <b>{APP_BUILD}</b></div>
              <div className="hint">和别人对一下这个号，就知道两台设备用的是不是同一版。</div>
            </div>
          </div>
          {CHANGELOG.map((r, i) => (
            <div key={r.version} className={`ver-rel ${i === 0 ? 'cur' : ''}`}>
              <div className="ver-rel-head">
                <b>{r.version}</b>
                {i === 0 && <em className="ver-tag">当前版本</em>}
                <span className="ver-rel-date">{r.date}</span>
              </div>
              <ul className="ver-list">
                {r.items.map((t, j) => <li key={j}>{t}</li>)}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SettingsPage({ settings, toast, refresh, moduleOrder, openQr }: any) {
  // 学校名称默认留空占位（"××中学"），由使用者自己在设置里填写
  const defaultSchoolName = '××中学';
  // 学期自动计算
  const defaultSemester = getSemesterText('');
  const [name, setName] = useState(settings?.name || '');
  const [schoolName, setSchoolName] = useState(settings?.schoolName || defaultSchoolName);
  const [semesterName, setSemesterName] = useState(settings?.semesterName || defaultSemester);
  const [startSchoolDate, setStartSchoolDate] = useState(settings?.startSchoolDate || '');
  const [scheduleText, setScheduleText] = useState('');
  const [periodNames, setPeriodNames] = useState(settings?.periodNames?.join('\n') || getDefaultPeriodNames().join('\n'));
  const [timeTableText, setTimeTableText] = useState(() => { const tt = settings?.timeTable || []; return tt.map((t: any) => `${t.name} ${t.startTime}-${t.endTime}`).join('\n'); });
  const [expanded, setExpanded] = useState<string>('basic');
  const [localOrder, setLocalOrder] = useState<string[]>(moduleOrder);

  /* ---- 数据备份 ---- */
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [backupInfo, setBackupInfo] = useState(() => getBackupMeta());
  /** 上次「覆盖导入」之前的数据快照（可一键退回） */
  const [preImport, setPreImport] = useState(() => getPreImportSnapshot());
  const backupFileRef = useRef<HTMLInputElement>(null);

  /**
   * 「这份备份里装了什么」清单。
   * 只在备份区块展开时才计算 —— getData() 要解析整份 localStorage（几 MB 时好几毫秒），
   * 放在渲染路径上会在设置页里每敲一个字都重新解析一遍。
   */
  const backupScope = useMemo(
    () => (expanded === 'backup' ? describeScope(getData()) : []),
    [expanded, backupInfo],
  );

  const doExportBackup = () => {
    const name = exportBackup();
    setBackupInfo(getBackupMeta());
    toast(`✅ 已导出 ${name}`);
  };

  const doImportBackup = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = parseBackup(String(reader.result || ''));
      if (!res.ok || !res.file) { toast('❌ ' + (res.error || '解析失败')); return; }
      const info = summarize(res.file.data);
      const when = res.file.exportedAt ? new Date(res.file.exportedAt).toLocaleString() : '未知时间';
      const ok = confirm(
        `备份文件时间：${when}\n备份内容：${info}\n\n` +
        (importMode === 'replace'
          ? '导入方式：覆盖 —— 这台设备上现有的数据会被全部替换，且无法恢复！\n\n确定继续吗？'
          : '导入方式：合并 —— 现有数据会保留，备份里多出来的记录会追加进来。\n\n确定继续吗？'),
      );
      if (!ok) return;
      // 覆盖导入会把这台设备上的数据整体换掉，先留一份撤销快照。
      // 快照存不下（数据偏大接近配额）时如实再问一次，而不是默默覆盖。
      if (importMode === 'replace') {
        const snapOk = snapshotBeforeImport();
        if (!snapOk) {
          const go = confirm(
            '⚠️ 当前数据偏大，浏览器已存不下「撤销快照」。\n\n' +
            '一旦覆盖，这台设备上的现有数据就无法找回了。\n\n仍要继续吗？',
          );
          if (!go) return;
        }
      }
      try {
        applyBackup(res.file.data, importMode);
        setBackupInfo(getBackupMeta());
        setPreImport(getPreImportSnapshot());
        toast('✅ 导入完成，正在刷新…');
        setTimeout(() => window.location.reload(), 900);
      } catch (e) {
        toast('❌ 导入失败：' + String(e));
      }
    };
    reader.readAsText(file);
  };

  /** 退回上次覆盖导入之前的数据 */
  const doUndoImport = () => {
    if (!confirm('恢复到上次「覆盖导入」之前的数据？\n\n这台设备上当前的数据会被替换掉（如果想留着，请先导出一份备份）。')) return;
    if (restorePreImport()) {
      setPreImport(null);
      toast('✅ 已恢复到导入前的数据，正在刷新…');
      setTimeout(() => window.location.reload(), 900);
    } else {
      toast('❌ 撤销失败，快照可能已被清理');
    }
  };

  /** 把备份文件直接发出去（手机发微信 / 隔空投送），电脑上会自动退回下载 */
  const doShareBackup = () => {
    void shareBackup().then(r => {
      setBackupInfo(getBackupMeta());
      if (r === 'shared') toast('✅ 备份文件已发出（记得在微信里选「文件传输助手」）');
      else if (r === 'downloaded') toast('这台设备的浏览器不支持直接分享，已改成下载文件');
      else toast('❌ 分享失败，请改用下面的「导出备份文件」');
    });
  };

  const doCopyBackup = () => {
    const text = backupAsText();
    navigator.clipboard?.writeText(text)
      .then(() => toast('✅ 备份内容已复制，粘贴到备忘录/网盘保存'))
      .catch(() => toast('复制失败，请改用「导出备份文件」'));
  };

  const save = () => {
    if (!name) { toast('请输入教师姓名'); return; }
    const schedule = parseSchedule(scheduleText || '');
    const pn = periodNames.split('\n').map((s: string) => s.trim()).filter(Boolean);
    const tt: any[] = [];
    for (const line of timeTableText.split('\n')) { const parts = line.trim().split(/\s+/); if (parts.length >= 2) { const timePart = parts[parts.length - 1]; const times = timePart.split(/[-~]/); if (times.length === 2) tt.push({ name: parts.slice(0, -1).join(' '), startTime: times[0], endTime: times[1] }); } }
    saveSettings({
      name,
      schoolName: schoolName || defaultSchoolName,
      semesterName: semesterName || defaultSemester,
      startSchoolDate,
      schedule: scheduleText ? schedule : (settings?.schedule || { courses: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] } }),
      periodNames: pn.length > 0 ? pn : getDefaultPeriodNames(),
      timeTable: tt,
      moduleOrder: localOrder,
      salaryCategories: settings?.salaryCategories || DEFAULT_SALARY_CATEGORIES,
    });
    refresh(); toast('✅ 设置已保存！');
  };

  const moveModule = (index: number, direction: -1 | 1) => {
    const newOrder = [...localOrder];
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= newOrder.length) return;
    [newOrder[index], newOrder[newIndex]] = [newOrder[newIndex], newOrder[index]];
    setLocalOrder(newOrder);
  };

  return (
    <div className="page">
      <div className="card">
        <div className="card-header"><span className="header-icon">⚙️</span><span>个人设置</span><span className="app-ver-badge">{APP_VERSION}</span></div>
        <div className="card-body">
          {/* PWA安装引导 */}
          <div className="settings-section">
            <div className={`section-header pwa-header ${expanded === 'pwa' ? '' : 'collapsed'}`} onClick={() => setExpanded(expanded === 'pwa' ? '' : 'pwa')}>
              <span>📱 添加到桌面</span><span>{expanded === 'pwa' ? '▼' : '▶'}</span>
            </div>
            {expanded === 'pwa' && (
              <div className="section-body pwa-guide">
                <p className="pwa-intro">把「教师助手」添加到手机桌面，像原生App一样使用，无需每次打开浏览器！</p>
                <div className="pwa-step">
                  <div className="pwa-device">🍎 iPhone (Safari)</div>
                  <ol>
                    <li>用 Safari 打开本网页</li>
                    <li>点击底部中间的 <strong>分享按钮</strong>（⬆️ 方框带箭头）</li>
                    <li>上滑找到 <strong>「添加到主屏幕」</strong></li>
                    <li>点击「添加」即可</li>
                  </ol>
                </div>
                <div className="pwa-step">
                  <div className="pwa-device">🤖 安卓 (Chrome/微信浏览器)</div>
                  <ol>
                    <li>用 Chrome 或浏览器打开本网页</li>
                    <li>点击右上角 <strong>菜单（⋮）</strong></li>
                    <li>选择 <strong>「添加到主屏幕」</strong> 或 <strong>「安装应用」</strong></li>
                    <li>确认添加即可</li>
                  </ol>
                </div>
                <div className="pwa-note">
                  💡 添加后，手机桌面会出现「教师助手」图标，点击即可全屏打开，<strong>无需联网也能查看</strong>（离线缓存）！
                </div>
              </div>
            )}
          </div>

          <div className="settings-section">
            <div className={`section-header ${expanded === 'basic' ? '' : 'collapsed'}`} onClick={() => setExpanded(expanded === 'basic' ? '' : 'basic')}>
              <span>👤 基本信息</span><span>{expanded === 'basic' ? '▼' : '▶'}</span>
            </div>
            {expanded === 'basic' && (
              <div className="section-body">
                <div className="form-group"><label>教师姓名 <span className="required">*</span></label><input className="form-input" value={name} onChange={e => setName(e.target.value)} /></div>
                <div className="form-group"><label>学校名称</label><input className="form-input" value={schoolName} onChange={e => setSchoolName(e.target.value)} /></div>
                <div className="form-group"><label>学期</label><input className="form-input" value={semesterName} onChange={e => setSemesterName(e.target.value)} placeholder="留空自动计算" /><p className="hint">留空则根据当前日期自动计算</p></div>
                <div className="form-group"><label>开学日期</label><input type="date" className="form-input" value={startSchoolDate} onChange={e => setStartSchoolDate(e.target.value)} /><p className="hint">用于计算周次</p>
                {startSchoolDate && (
                  <div className="week-display">
                    📅 今天是第 <strong>{getWeekByStartDate(new Date(), startSchoolDate)}</strong> 周
                    <span className="week-check">（请核对是否正确）</span>
                  </div>
                )}</div>
              </div>
            )}
          </div>
          <div className="settings-section">
            <div className={`section-header ${expanded === 'schedule' ? '' : 'collapsed'}`} onClick={() => setExpanded(expanded === 'schedule' ? '' : 'schedule')}>
              <span>📋 课表设置</span><span>{expanded === 'schedule' ? '▼' : '▶'}</span>
            </div>
            {expanded === 'schedule' && (
              <div className="section-body">
                <div className="form-group">
                  <label>📤 第1步：上传课表截图给豆包识别</label>
                  <div className="copy-box" onClick={() => {
                    const text = `请识别这张课程表图片，严格按以下格式逐行输出每节课：

【输出格式】（每节课一行）
星期几 节次名称 班级科目

【示例】
星期一 晨读 初一(1)语文
星期一 第1节 初一(1)语文
星期一 第3节 初二(2)语文
星期二 晨读 初二(2)语文

【要求】
1. 每行格式：星期 + 一个空格 + 节次名称 + 一个空格 + 班级科目
2. 星期写：星期一 星期二 星期三 星期四 星期五
3. 节次写图片上左侧栏的原样名称：晨读 第1节 第2节 第3节 第4节 第5节 第6节 第7节 第8节 自主1 自主2 自主3 晚1 晚2 晚3 晚4 等
4. 班级科目保留完整名称和括号：如 初一(1)语文 初二(2)数学
5. 空白节次不输出，只输出有课的
6. 只输出课程数据，不要任何解释、不要表格、不要"好的"之类的废话`;
                    navigator.clipboard?.writeText(text).then(() => toast('✅ 提示词已复制！')).catch(() => { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); toast('✅ 已复制'); });
                  }}>
                    <div className="copy-badge">点击复制</div>
                    <pre>{`请识别这张课程表图片，严格按以下格式逐行输出每节课...

【示例】
星期一 晨读 初一(1)语文
星期一 第1节 初一(1)语文

【要求】6条规则...`}</pre>
                  </div>
                  <p className="hint">👆 点击复制提示词 → 发给豆包 → 上传课表截图 → 豆包返回文字</p>
                </div>
                <div className="form-group"><label>📋 第2步：粘贴豆包返回的课表文字</label><textarea className="form-textarea" value={scheduleText} onChange={e => setScheduleText(e.target.value)} rows={6} placeholder="星期一 晨读 初一(1)语文&#10;星期一 第1节 初二(4)语文" /></div>
                <div className="form-group"><label>节次名称（每行一个）</label><textarea className="form-textarea" value={periodNames} onChange={e => setPeriodNames(e.target.value)} rows={4} /></div>
                <div className="form-group"><label>学校作息时间表（可选）</label><textarea className="form-textarea" value={timeTableText} onChange={e => setTimeTableText(e.target.value)} rows={4} placeholder="晨读 07:20-07:50" /></div>
              </div>
            )}
          </div>
          <div className="settings-section">
            <div className={`section-header ${expanded === 'backup' ? '' : 'collapsed'}`} onClick={() => setExpanded(expanded === 'backup' ? '' : 'backup')}>
              <span>💾 数据备份与恢复</span><span>{expanded === 'backup' ? '▼' : '▶'}</span>
            </div>
            {expanded === 'backup' && (
              <div className="section-body">
                <div className="info-box">
                  <div>
                    上次备份：
                    <b style={{ color: backupInfo.lastBackupAt ? '#34C759' : '#FF9500' }}>
                      {backupInfo.lastBackupAt
                        ? new Date(backupInfo.lastBackupAt).toLocaleString()
                        : '从未备份过'}
                    </b>
                  </div>
                  <div>当前数据量：约 <b>{dataSizeKB()}</b> KB · 已备份 {backupInfo.count} 次</div>
                  <div className="hint" style={{ marginTop: 6 }}>
                    ⚠️ 所有数据（请假、课表、工资、值班、代课、作业收缴、背诵统计、个人设置）只保存在这台设备的浏览器里。
                    <b>清理缓存、换手机、卸载浏览器都会导致数据全部丢失</b>，而且找不回来。建议每周导出一次备份，存在微信文件传输助手或网盘里。
                  </div>
                </div>

                <div className="bk-move">
                  <div className="bk-move-title">📱 ↔ 💻 手机上的数据怎么搬到电脑（不用连服务器、不用同一个 Wi-Fi）</div>
                  <div className="bk-move-row">
                    <span className="bk-move-no">1</span>
                    <div>在<b>手机</b>上打开「个人设置 → 💾 数据备份与恢复」，点 <b>📤 分享备份</b>，
                      选微信的<b>「文件传输助手」</b>（苹果手机也可以选隔空投送）</div>
                  </div>
                  <div className="bk-move-row">
                    <span className="bk-move-no">2</span>
                    <div>在<b>电脑</b>上打开教师助手，还是这个区块，点 <b>⬆️ 选择备份文件并导入</b>，
                      把刚收到的那个 .json 文件选上</div>
                  </div>
                  <div className="bk-move-row">
                    <span className="bk-move-no">3</span>
                    <div>导入方式选 <b>合并（推荐）</b> —— 电脑上原来的数据一条都不会丢</div>
                  </div>
                  <div className="bk-move-note">
                    反方向搬（电脑 → 手机）步骤一样，只是「导出」和「导入」换个地方点。
                    这是最省事的一条路：不装服务器、不用两台设备连同一个网络、也不用记账号密码。
                  </div>
                </div>

                <button className="btn btn-primary btn-block" style={{ marginTop: 12 }} onClick={doExportBackup}>
                  ⬇️ 导出备份文件（.json）
                </button>
                <button className="btn btn-outline btn-block" style={{ marginTop: 8 }} onClick={doShareBackup}>
                  📤 分享备份（手机上直接发到微信 / 隔空投送）
                </button>

                <div className="bk-scope">
                  <div className="bk-scope-title">
                    ✅ 一次导出即包含<b>全部模块</b>，不需要逐个板块分别备份
                  </div>
                  {backupScope.map(it => (
                    <div key={it.label} className="bk-scope-row">
                      <span className="bk-scope-name">{it.icon} {it.label}</span>
                      <b className="bk-scope-detail">{it.detail}</b>
                    </div>
                  ))}
                  <div className="bk-scope-note">{BACKUP_EXCLUDES}</div>
                </div>

                <div className="form-group" style={{ marginTop: 14 }}>
                  <label>导入备份时的处理方式</label>
                  <div className="rc-seg">
                    {([['merge', '合并（推荐·不丢现有数据）'], ['replace', '覆盖（用备份完全替换）']] as const).map(([k, l]) => (
                      <div key={k} className={`rc-seg-item ${importMode === k ? 'active' : ''}`}
                        style={{ flex: 1, textAlign: 'center' }} onClick={() => setImportMode(k)}>{l}</div>
                    ))}
                  </div>
                  <p className="hint">
                    {importMode === 'merge'
                      ? '合并：现有记录全部保留，备份里独有的记录会追加进来，适合「换了新手机想把旧数据搬过来」。'
                      : '覆盖：这台设备上的数据会被备份内容整体替换。导入前会自动留一份撤销快照，万一不对可以在下面一键退回。'}
                  </p>
                </div>

                <button className="btn btn-outline btn-block" onClick={() => backupFileRef.current?.click()}>
                  ⬆️ 选择备份文件并导入
                </button>
                <input ref={backupFileRef} type="file" accept=".json,application/json" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) doImportBackup(f); e.target.value = ''; }} />

                {preImport && (
                  <div className="bk-undo">
                    <div className="bk-undo-text">
                      <b>↩️ 还能退回导入前的数据</b>
                      <em>覆盖导入前的状态 · {new Date(preImport.at).toLocaleString()}</em>
                      <em>{preImport.summary}</em>
                    </div>
                    <button className="btn btn-small btn-secondary" onClick={doUndoImport}>撤回那次导入</button>
                  </div>
                )}

                <button className="btn btn-secondary btn-block" style={{ marginTop: 8 }} onClick={doCopyBackup}>
                  📋 复制备份内容（不方便存文件时，粘贴到备忘录即可）
                </button>
              </div>
            )}
          </div>

          <CloudPanel toast={toast} openQr={openQr} />

          <div className="settings-section">
            <div className={`section-header ${expanded === 'modules' ? '' : 'collapsed'}`} onClick={() => setExpanded(expanded === 'modules' ? '' : 'modules')}>
              <span>🧩 首页模块排序</span><span>{expanded === 'modules' ? '▼' : '▶'}</span>
            </div>
            {expanded === 'modules' && (
              <div className="section-body">
                <p className="hint" style={{ marginBottom: 10 }}>点击 ↑ ↓ 调整模块在首页的显示顺序</p>
                {localOrder.map((key, i) => {
                  const mod = MODULE_CONFIG[key]; if (!mod) return null;
                  return (
                    <div key={key} className="module-sort-item">
                      <span>{mod.icon} {mod.name}</span>
                      <div className="module-sort-btns">
                        <button className="btn btn-small btn-secondary" disabled={i === 0} onClick={() => moveModule(i, -1)}>↑</button>
                        <button className="btn btn-small btn-secondary" disabled={i === localOrder.length - 1} onClick={() => moveModule(i, 1)}>↓</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <VersionSection />

          <div className="btn-row">
            <button className="btn btn-primary" onClick={save}>💾 保存设置</button>
            <button className="btn btn-secondary" onClick={() => { setName('张××'); setSchoolName('××中学'); setSemesterName(''); setStartSchoolDate('2026-03-04'); setScheduleText(`星期一 晨读 初一(1)语早\n星期一 第2节 初二(1)语文\n星期一 第4节 初一(1)语文\n星期一 第5节 初一(1)语文\n星期二 晨读 初一(1)语早\n星期二 第1节 初二(1)语文\n星期二 第2节 初二(1)语文\n星期三 晨读 初二(1)语早\n星期三 第1节 初一(1)语文\n星期三 第2节 初二(1)语文\n星期三 第3节 初一(1)语文\n星期四 第2节 初一(1)语文\n星期四 第3节 初一(1)语文\n星期四 第4节 初二(1)语文\n星期五 第1节 初一(1)语文\n星期五 第2节 初一(1)语文\n星期五 第5节 初二(1)语文`); setPeriodNames(getDefaultPeriodNames().join('\n')); }}>📖 加载示例</button>
          </div>
          <button className="btn btn-danger btn-block" style={{ marginTop: 8 }} onClick={() => { if (confirm('确定清空所有设置？')) { clearAll(); refresh(); toast('已清空'); } }}>🗑️ 清空所有设置</button>
        </div>
      </div>
    </div>
  );
}

/* ============ 工资统计（增强版） ============ */
function SalaryPage({ toast }: { toast: (msg: string) => void }) {
  const [records, setRecords] = useState<SalaryRecord[]>(() => getData().salaries);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState('');
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [timeView, setTimeView] = useState<'year' | 'quarter' | 'month'>('month');
  const [showCatMgr, setShowCatMgr] = useState(false);
  const [newCat, setNewCat] = useState('');
  const [categories, setCategories] = useState<string[]>(getSalaryCategories);
  const refresh = () => setRecords(getData().salaries);

  const addCategory = () => {
    if (!newCat.trim()) { toast('请输入类别名称'); return; }
    if (categories.includes(newCat.trim())) { toast('该类别已存在'); return; }
    const newCats = [...categories, newCat.trim()];
    setCategories(newCats);
    saveSalaryCategories(newCats);
    setNewCat('');
    toast('✅ 类别已添加');
  };
  const removeCategory = (cat: string) => {
    const newCats = categories.filter(c => c !== cat);
    setCategories(newCats);
    saveSalaryCategories(newCats);
    toast('已删除');
  };

  const save = () => { if (!date || !amount) { toast('请填写完整'); return; } saveSalary({ id: editId || 'sal_' + Date.now(), date, description, category: category || '其他', amount: parseFloat(amount) }); refresh(); setShowForm(false); setEditId(''); setDate(''); setDescription(''); setCategory(''); setAmount(''); toast('✅ 已保存'); };
  const doImport = () => { const newRecords = importSalariesFromText(importText); if (newRecords.length === 0) { toast('未识别到有效数据'); return; } const d = getData(); d.salaries = [...newRecords, ...d.salaries]; setData(d); refresh(); setShowImport(false); setImportText(''); toast(`✅ 导入 ${newRecords.length} 条`); };

  const totalIncome = records.reduce((s, r) => s + r.amount, 0);

  // 按类别统计
  const byCategory: Record<string, number> = {};
  for (const r of records) byCategory[r.category] = (byCategory[r.category] || 0) + r.amount;

  // 按时间维度统计
  const byTime: Record<string, number> = {};
  for (const r of records) {
    let key: string;
    if (timeView === 'year') key = r.date.slice(0, 4) + '年';
    else if (timeView === 'quarter') { const m = parseInt(r.date.slice(5, 7)); const q = Math.ceil(m / 3); key = r.date.slice(0, 4) + '年Q' + q; }
    else key = r.date.slice(0, 7);
    byTime[key] = (byTime[key] || 0) + r.amount;
  }
  const timeKeys = Object.keys(byTime).sort();
  const maxTimeVal = Math.max(...Object.values(byTime), 0);

  return (
    <div className="page">
      <div className="card">
        <div className="card-header"><span className="header-icon">💰</span><span>工资统计</span></div>
        <div className="card-body">
          <div className="salary-stats">
            <div className="stat-card"><div className="stat-label">总收入</div><div className="stat-value">¥{totalIncome.toFixed(2)}</div></div>
            <div className="stat-card"><div className="stat-label">记录数</div><div className="stat-value">{records.length}</div></div>
          </div>

          {/* 按类别 */}
          {Object.keys(byCategory).length > 0 && (
            <div className="chart-section">
              <div className="section-title">按类别统计</div>
              {Object.entries(byCategory).map(([cat, val]) => {
                const pct = totalIncome > 0 ? (val / totalIncome * 100).toFixed(1) : '0';
                return <div key={cat} className="chart-bar"><div className="chart-label">{cat}</div><div className="chart-track"><div className="chart-fill" style={{ width: pct + '%' }} /></div><div className="chart-value">¥{val.toFixed(2)} ({pct}%)</div></div>;
              })}
            </div>
          )}

          {/* 按时间维度 */}
          {timeKeys.length > 0 && (
            <div className="chart-section">
              <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>按时间统计</span>
                <div className="view-tabs">
                  {([['year', '年度'], ['quarter', '季度'], ['month', '月度']] as const).map(([v, label]) => (
                    <button key={v} className={`view-tab ${timeView === v ? 'active' : ''}`} onClick={() => setTimeView(v)}>{label}</button>
                  ))}
                </div>
              </div>
              {timeKeys.map(key => {
                const pct = maxTimeVal > 0 ? (byTime[key] / maxTimeVal * 100).toFixed(1) : '0';
                return <div key={key} className="chart-bar"><div className="chart-label">{key}</div><div className="chart-track"><div className="chart-fill" style={{ width: pct + '%' }} /></div><div className="chart-value">¥{byTime[key].toFixed(2)}</div></div>;
              })}
            </div>
          )}

          <div className="btn-row">
            <button className="btn btn-primary" onClick={() => setShowForm(true)}>➕ 添加</button>
            <button className="btn btn-secondary" onClick={() => setShowImport(true)}>📥 导入</button>
            {records.length > 0 && <button className="btn btn-outline" onClick={() => exportSalaryCSV(records)}>📊 导出Excel</button>}
            {records.length > 0 && <button className="btn btn-outline" onClick={() => exportSalaryHTML(records)}>📄 导出PDF</button>}
          </div>

          {showImport && (
            <div className="form-group" style={{ marginTop: 12 }}>
              <label>粘贴工资数据（每行一条）</label>
              <textarea className="form-textarea" value={importText} onChange={e => setImportText(e.target.value)} rows={6} placeholder="2025-01-15 基本工资 工资 4500.50" />
              <p className="hint">格式：日期 描述 类别 金额</p>
              <div className="btn-row"><button className="btn btn-primary" onClick={doImport}>导入</button><button className="btn btn-secondary" onClick={() => setShowImport(false)}>取消</button></div>
            </div>
          )}

          {/* 类别管理弹窗 */}
          {showCatMgr && (
            <div className="card" style={{ marginTop: 12, background: '#fafafa' }}>
              <div className="card-body">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontWeight: 600 }}>🏷️ 类别管理</span>
                  <button className="btn btn-small btn-secondary" onClick={() => setShowCatMgr(false)}>关闭</button>
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                  <input className="form-input" value={newCat} onChange={e => setNewCat(e.target.value)} placeholder="新类别名称" style={{ flex: 1 }} />
                  <button className="btn btn-primary" onClick={addCategory}>添加</button>
                </div>
                <div className="cat-list">
                  {categories.map(c => (
                    <div key={c} className="cat-item">
                      <span>{c}</span>
                      <button className="btn btn-small btn-danger" onClick={() => removeCategory(c)}>删除</button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {showForm && (
            <div className="form-stack" style={{ marginTop: 12 }}>
              <div className="form-group"><label>日期</label><input type="date" className="form-input" value={date} onChange={e => setDate(e.target.value)} /></div>
              <div className="form-group"><label>描述</label><input className="form-input" value={description} onChange={e => setDescription(e.target.value)} placeholder="如：基本工资" /></div>
              <div className="form-group">
                <label>类别</label>
                <div className="category-select-row">
                  <input className="form-input" value={category} onChange={e => setCategory(e.target.value)} placeholder="输入类别或选择" style={{ flex: 1 }} />
                  <select className="form-select" value="" onChange={e => { if (e.target.value) setCategory(e.target.value); }} style={{ width: '42%', flexShrink: 0 }}>
                    <option value="">选常见</option>
                    {categories.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="cat-chips" style={{ marginTop: 6 }}>
                  {categories.map(c => (
                    <button key={c} className={`cat-chip ${category === c ? 'active' : ''}`} onClick={() => setCategory(c)}>{c}</button>
                  ))}
                  <button className="cat-chip cat-chip-add" onClick={() => setShowCatMgr(true)}>+ 管理</button>
                </div>
              </div>
              <div className="form-group"><label>金额（元）</label><input type="number" className="form-input" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" /></div>
              <div className="btn-row"><button className="btn btn-primary" onClick={save}>保存</button><button className="btn btn-secondary" onClick={() => setShowForm(false)}>取消</button></div>
            </div>
          )}

          {/* 数据表格 */}
          {records.length > 0 && (
            <div style={{ marginTop: 16, overflowX: 'auto' }}>
              <div className="section-title">📋 记录明细</div>
              <table className="data-table">
                <thead><tr><th>日期</th><th>描述</th><th>类别</th><th>金额</th><th>操作</th></tr></thead>
                <tbody>
                  {records.map(r => (
                    <tr key={r.id}>
                      <td>{r.date}</td>
                      <td>{r.description || '-'}</td>
                      <td><span className="tag">{r.category}</span></td>
                      <td style={{ color: '#07c160', fontWeight: 600 }}>+¥{r.amount.toFixed(2)}</td>
                      <td><button className="btn btn-small btn-secondary" onClick={() => { deleteSalary(r.id); refresh(); toast('已删除'); }}>删除</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {records.length === 0 && <div className="empty"><div className="empty-icon">💰</div><p>暂无记录</p></div>}
        </div>
      </div>
    </div>
  );
}

/* ============ 值班统计（独立） ============ */
function DutyOnlyPage({ toast }: { toast: (msg: string) => void }) {
  const [records, setRecords] = useState<DutyRecord[]>(() => getData().duties.filter((d: DutyRecord) => d.type === '值班'));
  const [showForm, setShowForm] = useState(false);
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const refresh = () => setRecords(getData().duties.filter((d: DutyRecord) => d.type === '值班'));

  const save = () => { if (!date) { toast('请填写日期'); return; } saveDuty({ id: 'duty_' + Date.now(), date, type: '值班', description }); refresh(); setShowForm(false); setDate(''); setDescription(''); toast('✅ 已保存'); };

  const total = records.length;
  const byMonth: Record<string, number> = {};
  for (const r of records) { const m = r.date.slice(0, 7); byMonth[m] = (byMonth[m] || 0) + 1; }
  const monthKeys = Object.keys(byMonth).sort();
  const maxMonth = Math.max(...Object.values(byMonth), 0);

  return (
    <div className="page">
      <div className="card">
        <div className="card-header"><span className="header-icon">📅</span><span>值班统计</span></div>
        <div className="card-body">
          <div className="salary-stats">
            <div className="stat-card"><div className="stat-label">值班总次数</div><div className="stat-value">{total}</div></div>
            <div className="stat-card"><div className="stat-label">涉及月份</div><div className="stat-value">{monthKeys.length}</div></div>
          </div>

          {monthKeys.length > 0 && (
            <div className="chart-section">
              <div className="section-title">按月统计</div>
              {monthKeys.map(m => <div key={m} className="chart-bar"><div className="chart-label">{m}</div><div className="chart-track"><div className="chart-fill" style={{ width: maxMonth > 0 ? (byMonth[m] / maxMonth * 100) + '%' : '0%' }} /></div><div className="chart-value">{byMonth[m]} 次</div></div>)}
            </div>
          )}

          <div className="btn-row">
            <button className="btn btn-primary" onClick={() => setShowForm(true)}>➕ 添加</button>
            {records.length > 0 && <button className="btn btn-outline" onClick={() => exportDutyCSV(records)}>📊 导出Excel</button>}
            {records.length > 0 && <button className="btn btn-outline" onClick={() => exportDutyHTML(records)}>📄 导出PDF</button>}
          </div>
          {showForm && (
            <div className="form-stack" style={{ marginTop: 12 }}>
              <div className="form-group"><label>日期</label><input type="date" className="form-input" value={date} onChange={e => setDate(e.target.value)} /></div>
              <div className="form-group"><label>备注</label><input className="form-input" value={description} onChange={e => setDescription(e.target.value)} placeholder="如：行政值班" /></div>
              <div className="btn-row"><button className="btn btn-primary" onClick={save}>保存</button><button className="btn btn-secondary" onClick={() => setShowForm(false)}>取消</button></div>
            </div>
          )}

          {/* 统计表格 */}
          {records.length > 0 && (
            <div style={{ marginTop: 16, overflowX: 'auto' }}>
              <div className="section-title">📋 值班记录表</div>
              <table className="data-table">
                <thead><tr><th>序号</th><th>日期</th><th>备注</th><th>操作</th></tr></thead>
                <tbody>
                  {records.map((r, idx) => (
                    <tr key={r.id}>
                      <td>{idx + 1}</td>
                      <td>{r.date}</td>
                      <td>{r.description || '-'}</td>
                      <td><button className="btn btn-small btn-secondary" onClick={() => { deleteDuty(r.id); refresh(); toast('已删除'); }}>删除</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {records.length === 0 && <div className="empty"><div className="empty-icon">📅</div><p>暂无值班记录</p></div>}
        </div>
      </div>
    </div>
  );
}

/* ============ 代课统计（独立） ============ */
function SubstituteOnlyPage({ toast }: { toast: (msg: string) => void }) {
  const [records, setRecords] = useState<DutyRecord[]>(() => getData().duties.filter((d: DutyRecord) => d.type === '代课'));
  const [showForm, setShowForm] = useState(false);
  const [date, setDate] = useState('');
  const [substituteFor, setSubstituteFor] = useState('');
  const [period, setPeriod] = useState('');
  const [classSubject, setClassSubject] = useState('');
  const [description, setDescription] = useState('');
  const refresh = () => setRecords(getData().duties.filter((d: DutyRecord) => d.type === '代课'));

  const save = () => { if (!date) { toast('请填写日期'); return; } saveDuty({ id: 'duty_' + Date.now(), date, type: '代课', description, substituteFor, period, classSubject }); refresh(); setShowForm(false); setDate(''); setSubstituteFor(''); setPeriod(''); setClassSubject(''); setDescription(''); toast('✅ 已保存'); };

  const total = records.length;
  const byMonth: Record<string, number> = {};
  const byPerson: Record<string, { count: number; details: Array<{ date: string; period: string; classSubject: string }> }> = {};
  for (const r of records) {
    const m = r.date.slice(0, 7); byMonth[m] = (byMonth[m] || 0) + 1;
    if (r.substituteFor) { if (!byPerson[r.substituteFor]) byPerson[r.substituteFor] = { count: 0, details: [] }; byPerson[r.substituteFor].count++; byPerson[r.substituteFor].details.push({ date: r.date, period: r.period || '', classSubject: r.classSubject || '' }); }
  }
  const monthKeys = Object.keys(byMonth).sort();
  const maxMonth = Math.max(...Object.values(byMonth), 0);

  return (
    <div className="page">
      <div className="card">
        <div className="card-header"><span className="header-icon">📊</span><span>代课统计</span></div>
        <div className="card-body">
          <div className="salary-stats">
            <div className="stat-card"><div className="stat-label">代课总次数</div><div className="stat-value">{total}</div></div>
            <div className="stat-card"><div className="stat-label">涉及教师</div><div className="stat-value">{Object.keys(byPerson).length}</div></div>
          </div>

          {monthKeys.length > 0 && (
            <div className="chart-section">
              <div className="section-title">按月统计</div>
              {monthKeys.map(m => <div key={m} className="chart-bar"><div className="chart-label">{m}</div><div className="chart-track"><div className="chart-fill" style={{ width: maxMonth > 0 ? (byMonth[m] / maxMonth * 100) + '%' : '0%' }} /></div><div className="chart-value">{byMonth[m]} 次</div></div>)}
            </div>
          )}

          {Object.keys(byPerson).length > 0 && (
            <div className="chart-section">
              <div className="section-title">按教师统计</div>
              {Object.entries(byPerson).sort((a, b) => b[1].count - a[1].count).map(([person, data]) => (
                <div key={person} className="person-card">
                  <div className="person-header"><span className="person-name">{person}</span><span className="person-count">{data.count} 次</span></div>
                  <div className="person-details">{data.details.map((d, i) => <div key={i} className="person-detail">{d.date} {d.period} {d.classSubject}</div>)}</div>
                </div>
              ))}
            </div>
          )}

          <div className="btn-row">
            <button className="btn btn-primary" onClick={() => setShowForm(true)}>➕ 添加</button>
            {records.length > 0 && <button className="btn btn-outline" onClick={() => exportSubCSV(records)}>📊 导出Excel</button>}
            {records.length > 0 && <button className="btn btn-outline" onClick={() => exportSubHTML(records)}>📄 导出PDF</button>}
          </div>
          {showForm && (
            <div className="form-stack" style={{ marginTop: 12 }}>
              <div className="form-group"><label>日期</label><input type="date" className="form-input" value={date} onChange={e => setDate(e.target.value)} /></div>
              <div className="form-group"><label>替谁代课</label><input className="form-input" value={substituteFor} onChange={e => setSubstituteFor(e.target.value)} placeholder="教师姓名" /></div>
              <div className="form-group"><label>节次</label><input className="form-input" value={period} onChange={e => setPeriod(e.target.value)} placeholder="如：第1节" /></div>
              <div className="form-group"><label>班级科目</label><input className="form-input" value={classSubject} onChange={e => setClassSubject(e.target.value)} placeholder="如：初一(1)语文" /></div>
              <div className="form-group"><label>备注</label><input className="form-input" value={description} onChange={e => setDescription(e.target.value)} /></div>
              <div className="btn-row"><button className="btn btn-primary" onClick={save}>保存</button><button className="btn btn-secondary" onClick={() => setShowForm(false)}>取消</button></div>
            </div>
          )}

          {/* 统计表格 */}
          {records.length > 0 && (
            <div style={{ marginTop: 16, overflowX: 'auto' }}>
              <div className="section-title">📋 代课记录表</div>
              <table className="data-table">
                <thead><tr><th>序号</th><th>日期</th><th>替谁</th><th>节次</th><th>班级科目</th><th>操作</th></tr></thead>
                <tbody>
                  {records.map((r, idx) => (
                    <tr key={r.id}>
                      <td>{idx + 1}</td>
                      <td>{r.date}</td>
                      <td>{r.substituteFor || '-'}</td>
                      <td>{r.period || '-'}</td>
                      <td>{r.classSubject || '-'}</td>
                      <td><button className="btn btn-small btn-secondary" onClick={() => { deleteDuty(r.id); refresh(); toast('已删除'); }}>删除</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {records.length === 0 && <div className="empty"><div className="empty-icon">📊</div><p>暂无代课记录</p></div>}
        </div>
      </div>
    </div>
  );
}

/* ============ 支付截图处理（差旅报销助手）- 带裁剪+纯图排版 ============ */
interface PaymentEntry {
  id: string;
  date: string;
  timeSlot: '早上' | '中午' | '晚上';
  finalTime: string;
  editedSrc: string;
  croppedSrc: string;
}

function PaymentPage({ toast, openQr }: { toast: (msg: string) => void; openQr: (url: string) => void }) {
  const [phase, setPhase] = useState<1 | 2 | 3>(1);
  const [entries, setEntries] = useState<PaymentEntry[]>([]);
  const [colsPerRow, setColsPerRow] = useState(3);
  const [rowsPerPage, setRowsPerPage] = useState(3);
  const [a4Images, setA4Images] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadTargetId, setUploadTargetId] = useState('');
  const [tripStart, setTripStart] = useState('');
  const [tripEnd, setTripEnd] = useState('');
  const [cropPercent, setCropPercent] = useState(15);
  const [promptText, setPromptText] = useState('');

  const generateEntriesFromRange = () => {
    if (!tripStart || !tripEnd) { toast('请选择出差开始和结束日期'); return; }
    const start = new Date(tripStart); const end = new Date(tripEnd);
    if (end < start) { toast('结束日期不能早于开始日期'); return; }
    const newEntries: PaymentEntry[] = [];
    const cur = new Date(start);
    while (cur <= end) {
      const dateStr = cur.toISOString().slice(0, 10);
      for (const slot of [['早上', 7], ['中午', 12], ['晚上', 17]] as const) {
        const h = slot[1] + Math.floor(Math.random() * 2);
        const m = Math.floor(Math.random() * 60).toString().padStart(2, '0');
        const s = Math.floor(Math.random() * 60).toString().padStart(2, '0');
        newEntries.push({ id: 'ent_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), date: dateStr, timeSlot: slot[0] as '早上'|'中午'|'晚上', finalTime: `${h}:${m}:${s}`, editedSrc: '', croppedSrc: '' });
      }
      cur.setDate(cur.getDate() + 1);
    }
    setEntries(newEntries);
    toast(`✅ 已生成 ${newEntries.length} 个时间条目（${newEntries.length / 3} 天）`);
  };

  const randomizeTimes = () => {
    setEntries(prev => prev.map(e => {
      const h = e.timeSlot === '早上' ? 7 + Math.floor(Math.random() * 2) : e.timeSlot === '中午' ? 12 + Math.floor(Math.random() * 2) : 17 + Math.floor(Math.random() * 2);
      return { ...e, finalTime: `${h}:${Math.floor(Math.random() * 60).toString().padStart(2, '0')}:${Math.floor(Math.random() * 60).toString().padStart(2, '0')}` };
    }));
    toast('✅ 时间已重新随机生成');
  };

  const updateEntry = (id: string, field: keyof PaymentEntry, value: string) => {
    setEntries(prev => prev.map(e => e.id === id ? { ...e, [field]: value } : e));
  };

  const removeEntry = (id: string) => setEntries(prev => prev.filter(e => e.id !== id));

  const toggleTimeSlot = (id: string) => {
    setEntries(prev => prev.map(e => {
      if (e.id !== id) return e;
      const slots: Array<'早上' | '中午' | '晚上'> = ['早上', '中午', '晚上'];
      const next = slots[(slots.indexOf(e.timeSlot) + 1) % 3];
      const h = next === '早上' ? 7 + Math.floor(Math.random() * 2) : next === '中午' ? 12 + Math.floor(Math.random() * 2) : 17 + Math.floor(Math.random() * 2);
      return { ...e, timeSlot: next, finalTime: `${h}:${Math.floor(Math.random() * 60).toString().padStart(2, '0')}:${Math.floor(Math.random() * 60).toString().padStart(2, '0')}` };
    }));
  };

  // 生成并展示提示词
  const generatePrompt = () => {
    if (entries.length === 0) { toast('请先生成时间条目'); return; }
    const timeList = entries.map((e, i) => {
      const d = new Date(e.date);
      return `第${i + 1}张：${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${e.finalTime}（${e.timeSlot}）`;
    }).join('\n');

    const prompt = `你是一个专业的图片编辑助手。请帮我修改以下微信零钱明细截图中的支付时间/转账时间，其他所有内容保持不变。

【修改要求】
1. 只修改"支付时间"或"转账时间"后面的时间值，其他文字、图标、布局完全不动
2. 修改后的字体、大小、颜色、位置要和原图完全一致，看不出来修改过
3. 时间格式保持：XXXX年X月X日 XX:XX:XX
4. 如果原图有"转账时间"标签，就修改转账时间；如果是"支付时间"标签，就修改支付时间

【每张截图要修改的时间】
${timeList}

【输出要求】
- 直接输出修改后的图片
- 保持原图的分辨率和清晰度
- 不要添加任何水印、标记、边框或其他装饰`;

    setPromptText(prompt);
    navigator.clipboard?.writeText(prompt).then(() => toast('✅ 提示词已复制')).catch(() => {
      const ta = document.createElement('textarea'); ta.value = prompt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); toast('✅ 已复制');
    });
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const src = ev.target?.result as string;
      if (uploadTargetId) {
        // 上传后同时做裁剪
        setEntries(prev => prev.map(en => {
          if (en.id !== uploadTargetId) return en;
          // 异步裁剪
          import('./payment').then(({ cropImageBottom }) => {
            cropImageBottom(src, cropPercent).then(cropped => {
              setEntries(p => p.map(e => e.id === uploadTargetId ? { ...e, editedSrc: src, croppedSrc: cropped } : e));
            }).catch(() => {
              setEntries(p => p.map(e => e.id === uploadTargetId ? { ...e, editedSrc: src, croppedSrc: src } : e));
            });
          });
          return { ...en, editedSrc: src, croppedSrc: '' };
        }));
      }
    };
    reader.readAsDataURL(file);
    if (fileRef.current) fileRef.current.value = '';
  };

  // 使用裁剪后的图片排序
  const sortedEntries = [...entries].filter(e => e.editedSrc).sort((a, b) => {
    const ta = a.date + ' ' + a.finalTime;
    const tb = b.date + ' ' + b.finalTime;
    return ta.localeCompare(tb);
  });

  const drawA4Preview = async () => {
    const imagesToUse = sortedEntries.map(e => e.croppedSrc || e.editedSrc).filter(Boolean);
    if (imagesToUse.length === 0) { toast('请先上传图片'); return; }
    const { exportA4PureImages } = await import('./payment');
    const pages = await exportA4PureImages(imagesToUse, colsPerRow, rowsPerPage);
    setA4Images(pages);
    toast(`✅ 已生成 ${pages.length} 页`);
  };

  const exportPDF = () => {
    const imagesToUse = sortedEntries.map(e => e.croppedSrc || e.editedSrc).filter(Boolean);
    if (imagesToUse.length === 0) { toast('请先上传图片'); return; }
    import('./payment').then(({ openPrintWindow }) => {
      openPrintWindow(imagesToUse, colsPerRow, rowsPerPage);
      toast('已打开打印窗口');
    });
  };

  const entriesByDate: Record<string, PaymentEntry[]> = {};
  for (const e of entries) { if (!entriesByDate[e.date]) entriesByDate[e.date] = []; entriesByDate[e.date].push(e); }

  return (
    <div className="page">
      {/* 阶段指示器 */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="phase-indicator">
          {[{n:1,t:'选择时间',i:'⏰'},{n:2,t:'上传P好的图',i:'📤'},{n:3,t:'排版导出',i:'📄'}].map(p => (
            <div key={p.n} className={`phase-step ${phase === p.n ? 'active' : ''} ${phase > p.n ? 'done' : ''}`} onClick={() => setPhase(p.n as 1|2|3)}>
              <div className="phase-num">{phase > p.n ? '✓' : p.i}</div>
              <div className="phase-label">{p.t}</div>
            </div>
          ))}
        </div>
      </div>

      <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} style={{ display: 'none' }} />

      {/* ===== 阶段1：选择出差时间范围 ===== */}
      {phase === 1 && (
        <div className="card">
          <div className="card-header"><span className="header-icon">⏰</span><span>第1步：选择出差时间范围</span></div>
          <div className="card-body">
            <div className="info-box" style={{ marginBottom: 16 }}>
              <strong>使用流程：</strong><br />
              1️⃣ 选择出差起止日期 → 自动生成每天早中晚时间<br />
              2️⃣ 检查时间 → 生成提示词 → 复制给豆包<br />
              3️⃣ 把微信零钱明细截图发给豆包P图
            </div>

            <div className="form-row">
              <div className="form-group flex1">
                <label>出差开始日期</label>
                <input type="date" className="form-input" value={tripStart} onChange={e => setTripStart(e.target.value)} />
              </div>
              <div className="form-group flex1">
                <label>出差结束日期</label>
                <input type="date" className="form-input" value={tripEnd} onChange={e => setTripEnd(e.target.value)} />
              </div>
            </div>
            <button className="btn btn-primary btn-block" onClick={generateEntriesFromRange}>⚡ 自动生成每天早中晚时间</button>

            {entries.length > 0 && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '16px 0 10px' }}>
                  <div className="section-title" style={{ margin: 0 }}>📋 共 {entries.length} 个条目（{Object.keys(entriesByDate).length} 天）</div>
                  <button className="btn btn-small btn-secondary" onClick={randomizeTimes}>🎲 重新随机</button>
                </div>

                {Object.entries(entriesByDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, dayEntries]) => (
                  <div key={date} style={{ marginBottom: 12, background: '#fafafa', borderRadius: 10, padding: '10px 12px', border: '1px solid var(--border)' }}>
                    <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8, color: 'var(--primary)' }}>{date}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {dayEntries.map(e => (
                        <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'white', borderRadius: 8, padding: '6px 10px', border: '1.5px solid var(--border)' }}>
                          <div style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, minWidth: 52, textAlign: 'center', padding: '4px 8px', borderRadius: 6, background: e.timeSlot === '早上' ? '#e6f7e6' : e.timeSlot === '中午' ? '#fff7e6' : '#e6f4ff', color: e.timeSlot === '早上' ? '#07c160' : e.timeSlot === '中午' ? '#faad14' : '#1890ff' }} onClick={() => toggleTimeSlot(e.id)}>
                            {e.timeSlot}
                          </div>
                          <input className="form-input" style={{ flex: 1, padding: '6px 8px', fontSize: 13, marginBottom: 0, minWidth: 0 }} value={e.finalTime} onChange={ev => updateEntry(e.id, 'finalTime', ev.target.value)} />
                          <div style={{ cursor: 'pointer', color: '#c41e3a', fontSize: 18, flexShrink: 0, width: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => removeEntry(e.id)}>×</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

                <button className="btn btn-primary btn-block" style={{ marginTop: 16 }} onClick={generatePrompt}>📋 生成豆包提示词并复制</button>
                {promptText && (
                  <div className="prompt-display" style={{ marginTop: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>👇 提示词预览（请检查）</span>
                      <button className="btn btn-small btn-primary" onClick={() => { navigator.clipboard?.writeText(promptText); toast('已复制'); }}>复制</button>
                    </div>
                    <pre style={{ background: '#f8f9fa', border: '1px solid var(--border)', borderRadius: 8, padding: 12, fontSize: 12, lineHeight: 1.6, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{promptText}</pre>
                  </div>
                )}
                <button className="btn btn-success btn-block" style={{ marginTop: 8 }} onClick={() => setPhase(2)}>下一步：上传豆包P好的图 →</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ===== 阶段2：上传豆包P好的图片（带裁剪） ===== */}
      {phase === 2 && (
        <div className="card">
          <div className="card-header"><span className="header-icon">📤</span><span>第2步：上传豆包修改后的截图</span></div>
          <div className="card-body">
            <div className="info-box" style={{ marginBottom: 12 }}>
              豆包处理后的图片底部可能有水印，已自动裁剪底部 {cropPercent}%。如不满意可调整。
            </div>
            <div className="form-group">
              <label>底部裁剪比例（去除豆包水印）</label>
              <input type="range" min={0} max={30} value={cropPercent} onChange={e => setCropPercent(parseInt(e.target.value))} style={{ width: '100%' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#999' }}>
                <span>不裁剪</span><span>当前: {cropPercent}%</span><span>裁剪30%</span>
              </div>
            </div>

            {entries.map((e, i) => (
              <div key={e.id} className="shot-config-card">
                <div className="shot-thumb">
                  {e.editedSrc ? <img src={e.editedSrc} alt={`图${i + 1}`} /> : <div className="shot-placeholder">待上传</div>}
                </div>
                <div className="shot-info">
                  <div><strong>{i + 1}</strong> <span className="badge badge-green">{e.date}</span> <span className="badge">{e.timeSlot}</span> <span className="badge">{e.finalTime}</span></div>
                  <div style={{ marginTop: 8 }}>
                    {e.editedSrc ? (
                      <span style={{ color: '#07c160', fontSize: 13 }}>✅ 已上传{e.croppedSrc ? '（已裁剪）' : ''}</span>
                    ) : (
                      <button className="btn btn-small btn-primary" onClick={() => { setUploadTargetId(e.id); fileRef.current?.click(); }}>📤 上传</button>
                    )}
                  </div>
                </div>
              </div>
            ))}
            <button className="btn btn-success btn-block" style={{ marginTop: 16 }} onClick={() => setPhase(3)}>下一步：排版导出 →</button>
          </div>
        </div>
      )}

      {/* ===== 阶段3：纯图排版导出 ===== */}
      {phase === 3 && (
        <div className="card">
          <div className="card-header"><span className="header-icon">📄</span><span>第3步：排版导出</span></div>
          <div className="card-body">
            <div className="form-row">
              <div className="form-group flex1">
                <label>每行张数</label>
                <div className="num-btns">
                  {[2, 3, 4].map(n => <div key={n} className={`num-btn ${colsPerRow === n ? 'selected' : ''}`} onClick={() => setColsPerRow(n)}>{n}</div>)}
                </div>
              </div>
              <div className="form-group flex1">
                <label>每页行数</label>
                <div className="num-btns">
                  {[2, 3, 4, 5].map(n => <div key={n} className={`num-btn ${rowsPerPage === n ? 'selected' : ''}`} onClick={() => setRowsPerPage(n)}>{n}</div>)}
                </div>
              </div>
            </div>
            <div className="info-box">
              共 {sortedEntries.length} 张 · 每页 {colsPerRow * rowsPerPage} 张 · 预计 {Math.ceil(sortedEntries.length / (colsPerRow * rowsPerPage))} 页
            </div>
            <div className="btn-row">
              <button className="btn btn-primary" onClick={drawA4Preview}>👁️ 预览</button>
              <button className="btn btn-success" onClick={exportPDF}>🖨️ 导出PDF</button>
              {/* 新增:分享第一页图片 */}
              {a4Images.length > 0 && (
                <button className="btn btn-outline" onClick={async () => {
                  if (a4Images.length === 0) { toast('请先预览'); return; }
                  const src = a4Images[0];
                  const res = await fetch(src);
                  const blob = await res.blob();
                  const file = new File([blob], `截图_排版_第1页.png`, { type: 'image/png' });
                  if ((navigator as any).canShare?.({ files: [file] })) {
                    try { await (navigator as any).share({ files: [file], title: '微信截图排版', text: `共 ${a4Images.length} 页` }); toast('✅ 已分享'); }
                    catch { /* 用户取消 */ }
                  } else {
                    try {
                      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                      toast('✅ 第一页已复制到剪贴板');
                    } catch {
                      const a = document.createElement('a'); a.download = '截图_排版_第1页.png'; a.href = src; a.click();
                      toast('当前浏览器不支持分享,已下载');
                    }
                  }
                }} title="分享排版图到微信/QQ等">🔗 分享</button>
              )}
              {/* 新增:二维码分享 */}
              <button className="btn btn-outline" onClick={() => openQr?.(getShareOrigin())} title="生成二维码,扫码分享 PWA">📱 二维码</button>
            </div>
            {a4Images.length > 0 && (
              <div style={{ marginTop: 16 }}>
                {a4Images.map((src, i) => (
                  <div key={i} style={{ marginBottom: 16 }}>
                    <img src={src} style={{ width: '100%', border: '1px solid #eee', borderRadius: 4 }} alt={`第${i + 1}页`} />
                    <button className="btn btn-outline btn-block" style={{ marginTop: 6 }} onClick={() => { const a = document.createElement('a'); a.download = `截图_第${i + 1}页.png`; a.href = src; a.click(); }}>📥 下载第{i + 1}页</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ============ Parse Schedule ============ */
function parseSchedule(text: string) {
  const schedule = { courses: { 0: [] as any[], 1: [] as any[], 2: [] as any[], 3: [] as any[], 4: [] as any[], 5: [] as any[], 6: [] as any[] } };
  const dayMap: Record<string, number> = { '星期一': 1, '星期二': 2, '星期三': 3, '星期四': 4, '星期五': 5, '星期六': 6, '星期日': 0, '星期天': 0 };
  for (const line of text.split('\n')) {
    const trimmed = line.trim(); if (!trimmed) continue;
    const parts = trimmed.split(/\s+/); if (parts.length < 3) continue;
    let dayNum: number | null = null;
    for (const key in dayMap) if (parts[0].includes(key)) { dayNum = dayMap[key]; break; }
    if (dayNum === null) continue;
    schedule.courses[dayNum as keyof typeof schedule.courses].push({ period: parts[1], classSubject: parts.slice(2).join(' ') });
  }
  return schedule;
}

export default App;
