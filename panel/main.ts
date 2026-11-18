// billion-context managed-context panel for OpenChamber.
// Data path: panel --serviceRequest--> OpenChamber host --> local service (service/main.js)
//   --> billion-context proxy /__bili/* JSON API.

import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

interface BiliCost {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  total?: number;
}

interface BiliSession {
  id: string;
  title?: string;
  live?: boolean;
  model?: string;
  requests?: number;
  contextTokens?: number;
  contextWindow?: number;
  contextTokensSource?: string;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  cacheHitPct?: number;
  blocks?: number;
  tokensSaved?: number;
  lastSeen?: string;
  missDropNew?: number;
  missDropComp?: number;
  missDropTtl?: number;
  costUsd?: BiliCost;
}

interface BiliOverview {
  sessions?: number;
  live?: number;
  requests?: number;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  hitPct?: number;
  foldsTotal?: number;
  blocks?: number;
  missNewTotal?: number;
  missCompTotal?: number;
  missTtlTotal?: number;
  missInputTotal?: number;
  costUsdTotal?: number;
  hasMoneyData?: boolean;
}

interface BiliStatus {
  version?: string;
  diskVersion?: string;
  stale?: boolean;
}

const host = (() => {
  try {
    return connectHost();
  } catch {
    return null;
  }
})();

let currentSessionId: string | null = null;
let hostSessionTitle: string | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;
let lastOk = false;
let lastError = '';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));

function fmtTokens(n: number | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtUsd(n: number | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return '$' + (n >= 1 ? n.toFixed(2) : n.toFixed(4));
}

function fmtRel(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.round(s / 60)}m 前`;
  return `${Math.round(s / 3600)}h 前`;
}

function hitClass(pct: number | undefined): string {
  if (pct === undefined) return '';
  if (pct >= 96) return 'good';
  if (pct >= 90) return 'warn';
  return 'bad';
}

function pressureClass(pct: number): string {
  if (pct >= 90) return 'err';
  if (pct >= 70) return 'warn';
  return '';
}

async function fetchBili<T>(path: string, query?: Record<string, string>): Promise<{ ok: boolean; data?: T; error?: string }> {
  if (!host) return { ok: false, error: 'HOST_UNAVAILABLE' };
  try {
    const res = await host.serviceRequest({ method: 'GET', path, query });
    if (res.status !== 200) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(res.body);
        if (j?.error) msg += ` ${typeof j.error === 'string' ? j.error : JSON.stringify(j.error)}`;
      } catch { /* keep plain */ }
      return { ok: false, error: msg };
    }
    return { ok: true, data: JSON.parse(res.body) as T };
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code ?? '';
    const msg = (e as { message?: string })?.message ?? String(e);
    return { ok: false, error: code ? `${code}: ${msg}` : msg };
  }
}

function renderSession(sess: BiliSession | null, hostSessionTitle: string | null): void {
  const el = $<HTMLDivElement>('session-body');
  if (!sess) {
    el.innerHTML = hostSessionTitle
      ? `<div class="notice">当前会话不在 bili 会话列表中。<br>` +
        `<span style="font-size:11px">可能 bili 代理未运行、该会话未经过代理，或走了另一条 lane。</span></div>`
      : `<div class="notice">没有打开的会话。打开一个经过 bili 代理的会话即可查看。</div>`;
    return;
  }

  const ctxTokens = sess.contextTokens ?? 0;
  const ctxWindow = sess.contextWindow ?? 0;
  const ctxPct = ctxWindow > 0 ? Math.min(100, (ctxTokens / ctxWindow) * 100) : 0;
  const pctLabel = ctxWindow > 0 ? `${ctxPct.toFixed(1)}%` : '';

  const missNew = sess.missDropNew ?? 0;
  const missTtl = sess.missDropTtl ?? 0;
  const missComp = sess.missDropComp ?? 0;
  const missSum = missNew + missTtl + missComp;
  const w = (v: number) => (missSum > 0 ? (v / missSum) * 100 : 0);

  const title = sess.title || hostSessionTitle || sess.id;

  el.innerHTML = `
    <div class="sess-title" title="${esc(title)}">${esc(title)}</div>
    <div class="sess-sub mono">${esc(sess.model ?? '')}${sess.model ? ' · ' : ''}${esc(fmtRel(sess.lastSeen))}${sess.live ? ' · live' : ''}</div>
    <div class="bar-label"><span>上下文占用</span><span class="mono">${esc(fmtTokens(ctxTokens))} / ${esc(ctxWindow ? fmtTokens(ctxWindow) : '?')} ${esc(pctLabel)}</span></div>
    <div class="bar"><div class="bar-fill ${pressureClass(ctxPct)}" style="width:${ctxWindow > 0 ? Math.max(1.5, ctxPct) : 0}%"></div></div>
    <div class="grid">
      <div class="stat"><div class="v ${hitClass(sess.cacheHitPct)}">${esc(sess.cacheHitPct !== undefined ? sess.cacheHitPct + '%' : '—')}</div><div class="k">缓存命中</div></div>
      <div class="stat"><div class="v">${esc(fmtTokens(sess.inputTokens))}</div><div class="k">累计输入</div></div>
      <div class="stat"><div class="v">${esc(fmtTokens(sess.cachedTokens))}</div><div class="k">其中缓存读</div></div>
      <div class="stat"><div class="v">${esc(String(sess.requests ?? '—'))}</div><div class="k">请求数</div></div>
      <div class="stat"><div class="v">${esc(String(sess.blocks ?? 0))}</div><div class="k">压缩块</div></div>
      <div class="stat"><div class="v">${esc(fmtUsd(sess.costUsd?.total))}</div><div class="k">成本</div></div>
    </div>
    ${missSum > 0 ? `
    <div class="bar-label" style="margin-top:10px"><span>未命中归因</span><span class="mono">new ${missNew.toFixed(1)}% · ttl ${missTtl.toFixed(1)}% · comp ${missComp.toFixed(1)}%</span></div>
    <div class="missbar">
      <span class="m-new" style="width:${w(missNew)}%"></span>
      <span class="m-ttl" style="width:${w(missTtl)}%"></span>
      <span class="m-comp" style="width:${w(missComp)}%"></span>
    </div>
    <div class="miss-legend">
      <span><i class="m-new"></i>新内容</span>
      <span><i class="m-ttl"></i>缓存过期</span>
      <span><i class="m-comp"></i>压缩回填</span>
    </div>` : ''}
  `;
}

function renderGlobal(ov: BiliOverview | null): void {
  const el = $<HTMLDivElement>('global-body');
  if (!ov) {
    el.innerHTML = '<div class="notice">暂无全局数据。</div>';
    return;
  }
  el.innerHTML = `
    <div class="grid" style="margin-top:0">
      <div class="stat"><div class="v ${hitClass(ov.hitPct)}">${esc(ov.hitPct !== undefined ? ov.hitPct + '%' : '—')}</div><div class="k">总命中率</div></div>
      <div class="stat"><div class="v">${esc(String(ov.requests ?? '—'))}</div><div class="k">总请求</div></div>
      <div class="stat"><div class="v">${esc(String(ov.live ?? '—'))}<span style="font-size:11px;color:var(--oc-muted,#888)">/${esc(String(ov.sessions ?? '—'))}</span></div><div class="k">活跃/会话</div></div>
      <div class="stat"><div class="v">${esc(fmtTokens(ov.inputTokens))}</div><div class="k">累计输入</div></div>
      <div class="stat"><div class="v">${esc(fmtTokens(ov.cachedTokens))}</div><div class="k">缓存读</div></div>
      <div class="stat"><div class="v">${esc(String(ov.blocks ?? 0))}</div><div class="k">压缩块</div></div>
    </div>
  `;
}

function renderHeader(status: BiliStatus | null): void {
  $<HTMLSpanElement>('dot').className = 'dot ' + (lastOk ? 'ok' : 'err');
  const meta = $<HTMLSpanElement>('hdr-meta');
  const bits: string[] = [];
  if (status?.version) bits.push('v' + status.version);
  if (status?.stale) bits.push('<span class="stale">stale</span>');
  meta.innerHTML = bits.join(' · ');
}

function renderFooter(origin: string): void {
  $<HTMLSpanElement>('foot-origin').textContent = origin;
  $<HTMLSpanElement>('foot-status').textContent = lastOk
    ? `已更新 ${new Date().toLocaleTimeString()}`
    : lastError
      ? `错误：${lastError}`
      : '';
}

function setSessionCardError(message: string): void {
  $<HTMLDivElement>('session-body').innerHTML = `<div class="notice err">${esc(message)}</div>`;
}

async function refresh(): Promise<void> {
  if (inFlight || document.hidden) return;
  inFlight = true;
  try {
    const [sessionsR, overviewR, statusR] = await Promise.all([
      fetchBili<{ sessions?: BiliSession[] }>('/bili/sessions'),
      fetchBili<{ overview?: BiliOverview }>('/bili/overview'),
      fetchBili<BiliStatus>('/bili/status'),
    ]);

    lastOk = sessionsR.ok || overviewR.ok;
    lastError = lastOk ? '' : (sessionsR.error || overviewR.error || 'bili 不可达');

    renderHeader(statusR.ok ? statusR.data ?? null : null);
    renderGlobal(overviewR.ok ? overviewR.data?.overview ?? null : null);

    if (sessionsR.ok) {
      const list = sessionsR.data?.sessions ?? [];
      const mine = currentSessionId ? list.find((s) => s.id === currentSessionId) ?? null : null;
      renderSession(mine, hostSessionTitle);
    } else {
      setSessionCardError(hintFor(sessionsR.error ?? ''));
    }
    renderFooter(lastOk ? '' : '');
  } finally {
    inFlight = false;
  }
}

function hintFor(error: string): string {
  if (error.includes('NO_SERVICE')) {
    return '本地 service 尚未批准或未启动。<br>请在 设置 → 扩展 中批准本地服务后重试。';
  }
  if (error.includes('SERVICE_FAILED')) {
    return '本地 service 启动失败（SERVICE_FAILED）。<br>查看 OpenChamber 日志，或重启扩展。';
  }
  if (error.includes('bili-unreachable') || error.includes('ECONNREFUSED')) {
    return 'bili 代理不可达。先启动它：<br><code>bili start</code> 或 <code>bili opencode …</code>';
  }
  return `bili 数据不可用：${esc(error)}`;
}

function startPolling(): void {
  if (timer) return;
  timer = setInterval(refresh, 5000);
}

function main(): void {
  if (!host) {
    document.body.innerHTML =
      '<div class="notice err" style="padding:24px">此页面需要在 OpenChamber 内打开（HOST_UNAVAILABLE）。</div>';
    return;
  }

  host.onReady((ctx) => {
    applyHostReady(ctx, document.documentElement);
    currentSessionId = ctx.session?.id ?? null;
    hostSessionTitle = ctx.session?.title ?? null;
    startPolling();
    refresh();
  });

  host.onSession((s) => {
    const id = s?.id ?? null;
    if (id === currentSessionId) return;
    currentSessionId = id;
    hostSessionTitle = s?.title ?? null;
    refresh();
  });
}

main();
