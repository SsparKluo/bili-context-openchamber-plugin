// billion-context managed-context strip for the OpenChamber Work Status panel.
// Data path: status page --serviceRequest--> OpenChamber host --> local service
// (service/main.js) --> billion-context proxy /__bili/* JSON API.
//
// Shown per current session:
//   - context usage (tokens / window, with the ~50K nudge line on the bar)
//   - cache health (hit %, cached tokens)
//   - compressed: block count + tokens folded
//   - pending: growth since the last fold point (contextBest) = marked-but-
//     not-yet-folded tokens (bili 0.1.216 exposes no per-block pending list)

import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

interface BiliContextBest {
  tokens?: number;
  kind?: string;
  at?: number;
}

interface BiliSession {
  id: string;
  contextTokens?: number;
  contextWindow?: number;
  contextBest?: BiliContextBest | null;
  cacheHitPct?: number;
  cachedTokens?: number;
  inputTokens?: number;
  requests?: number;
  blocks?: number;
  foldCount?: number;
  tokensSaved?: number;
  netSaved?: number;
  compRepay?: number;
  model?: string;
  lastSeen?: string;
}

interface BiliStatus {
  version?: string;
  stale?: boolean;
}

// bili's default growth step before it nudges the model to fold
// (compress.nudgeGrowthTokens / ACP_COMPRESS_NUDGE override; NUDGE_DEFAULT = 50000).
const NUDGE_DEFAULT_TOKENS = 50_000;

const host = (() => {
  try {
    return connectHost();
  } catch {
    return null;
  }
})();

let currentSessionId: string | null = null;
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

async function fetchBili<T>(path: string): Promise<{ ok: boolean; data?: T; error?: string }> {
  if (!host) return { ok: false, error: 'HOST_UNAVAILABLE' };
  try {
    const res = await host.serviceRequest({ method: 'GET', path });
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

function render(sess: BiliSession | null, status: BiliStatus | null): void {
  const dot = $<HTMLSpanElement>('dot');
  dot.className = 'dot ' + (lastOk ? 'ok' : 'err');

  const meta: string[] = [];
  if (status?.version) meta.push('v' + esc(status.version));
  if (status?.stale) meta.push('<span class="stale">stale</span>');
  $<HTMLSpanElement>('hdr-meta').innerHTML = meta.join(' · ');
  $<HTMLSpanElement>('hdr-right').textContent = sess?.lastSeen ? fmtRel(sess.lastSeen) : '';

  const body = $<HTMLDivElement>('body');
  if (!lastOk) {
    body.innerHTML = `<div class="notice err">${esc(hintFor(lastError))}</div>`;
    host?.setHeight?.(92);
    return;
  }
  if (!sess) {
    body.innerHTML =
      '<div class="notice">当前没有经过 bili 代理的活动会话。</div>';
    host?.setHeight?.(92);
    return;
  }

  const ctxTokens = sess.contextTokens ?? 0;
  const ctxWindow = sess.contextWindow ?? 0;
  const ctxPct = ctxWindow > 0 ? Math.min(100, (ctxTokens / ctxWindow) * 100) : 0;

  // Pending = growth since the lowest observed context (the last fold point).
  const bestTokens = sess.contextBest?.tokens;
  const pending = bestTokens !== undefined ? Math.max(0, ctxTokens - bestTokens) : undefined;
  const pendingOfNudge = pending !== undefined ? Math.min(100, (pending / NUDGE_DEFAULT_TOKENS) * 100) : 0;

  const nudgeMark =
    ctxWindow > 0 && NUDGE_DEFAULT_TOKENS < ctxWindow
      ? `<span class="bar-nudge" style="left:${(NUDGE_DEFAULT_TOKENS / ctxWindow) * 100}%"></span>`
      : '';

  body.innerHTML = `
    <div class="ctxline">
      <span class="k">上下文</span>
      <div class="bar"><div class="bar-fill ${pressureClass(ctxPct)}" style="width:${ctxWindow > 0 ? Math.max(1, ctxPct) : 0}%"></div>${nudgeMark}</div>
      <span class="v mono ${pressureClass(ctxPct)}">${esc(fmtTokens(ctxTokens))}<span class="v dim"> / ${esc(ctxWindow ? fmtTokens(ctxWindow) : '?')}</span> · ${esc(ctxWindow ? ctxPct.toFixed(0) + '%' : '—')}</span>
    </div>
    <div class="row">
      <span class="cell"><span class="k">缓存</span><span class="v ${hitClass(sess.cacheHitPct)}">${esc(sess.cacheHitPct !== undefined ? sess.cacheHitPct.toFixed(sess.cacheHitPct >= 99 ? 0 : 1) + '%' : '—')}</span></span>
      <span class="cell"><span class="k">缓存读</span><span class="v mono">${esc(fmtTokens(sess.cachedTokens))}</span></span>
      <span class="cell"><span class="k">输入累计</span><span class="v mono">${esc(fmtTokens(sess.inputTokens))}</span></span>
      <span class="cell"><span class="k">请求</span><span class="v mono">${esc(String(sess.requests ?? '—'))}</span></span>
    </div>
    <div class="row">
      <span class="cell"><span class="k">已压缩</span><span class="v">${esc(String(sess.blocks ?? 0))} 块</span><span class="v mono">${esc(fmtTokens(sess.tokensSaved))} tok</span></span>
      <span class="cell"><span class="k">待折叠</span><span class="v ${pending !== undefined && pending > NUDGE_DEFAULT_TOKENS ? 'warn' : ''}">${pending !== undefined ? '≈' + esc(fmtTokens(pending)) + ' tok' : '—'}</span><span class="pendingbar"><i style="width:${pendingOfNudge}%"></i></span><span class="v dim">50K 线</span></span>
    </div>
  `;
  host?.setHeight?.(118);
}

function hintFor(error: string): string {
  if (error.includes('NO_SERVICE')) return '本地 service 未批准：设置 → 扩展 中批准后重试';
  if (error.includes('SERVICE_FAILED')) return '本地 service 启动失败，查看 OpenChamber 日志';
  if (error.includes('bili-unreachable') || error.includes('ECONNREFUSED')) return 'bili 代理不可达：先启动 bili start';
  return `bili 数据不可用：${error}`;
}

async function refresh(): Promise<void> {
  if (inFlight || document.hidden) return;
  inFlight = true;
  try {
    const [sessionsR, statusR] = await Promise.all([
      fetchBili<{ sessions?: BiliSession[] }>('/bili/sessions'),
      fetchBili<BiliStatus>('/bili/status'),
    ]);

    lastOk = sessionsR.ok;
    lastError = lastOk ? '' : (sessionsR.error || 'bili 不可达');

    const list = sessionsR.ok ? sessionsR.data?.sessions ?? [] : [];
    const mine = currentSessionId ? list.find((s) => s.id === currentSessionId) ?? null : null;
    render(mine, statusR.ok ? statusR.data ?? null : null);
  } finally {
    inFlight = false;
  }
}

function main(): void {
  if (!host) {
    document.body.innerHTML =
      '<div class="notice err">此页面需要在 OpenChamber 内打开（HOST_UNAVAILABLE）。</div>';
    return;
  }

  host.onReady((ctx) => {
    applyHostReady(ctx, document.documentElement);
    currentSessionId = ctx.session?.id ?? null;
    timer = setInterval(refresh, 5000);
    refresh();
  });

  host.onSession((s) => {
    const id = s?.id ?? null;
    if (id === currentSessionId) return;
    currentSessionId = id;
    refresh();
  });
}

main();
