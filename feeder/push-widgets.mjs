#!/usr/bin/env node
/* 把 Ted 自己的工具資料推到工作台
 *
 * 用途：工作台前端只讀私有 repo 裡的 widgets/*.json。這支腳本負責產生那些 JSON。
 * 執行環境：MacBook 或 mini（mini 已有每日 crontab，可掛在那）。
 * 授權：需要環境變數 DASH_TOKEN（fine-grained token，只給 dashboard-data 的 Contents 讀寫）。
 *       絕對不要把 token 寫進這個檔案，也不要 commit 進 repo。
 *
 * 用法：
 *   DASH_TOKEN=xxx node feeder/push-widgets.mjs
 *   DASH_TOKEN=xxx node feeder/push-widgets.mjs --dry     # 只印出會寫什麼，不上傳
 *
 * 加一個新工具卡片＝寫一支 collect 函式，回傳 widget 格式物件，然後加進 FEEDS。
 * widget 格式：{ title, updated, percent?:0-100, metrics:[{label,value}], lines:[string], link:{href,text} }
 *   percent 是可選欄位：有給的話，前端會在卡片上多畫一個圓環進度圖（渲染邏輯見
 *   dashboard/assets/app.js 的 renderDonut()），不影響沒有這個欄位的舊卡片。
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OWNER = 'tientien830205-tech';
const REPO = 'dashboard-data';
const BRANCH = 'main';
const TOKEN = process.env.DASH_TOKEN;
const DRY = process.argv.includes('--dry');

const nowLabel = () => new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
const nt = n => Number(n).toLocaleString('zh-TW');

/* ---------- 說了算 App 財務快照 ---------- */
async function collectFinance() {
  const p = join(homedir(), 'Library/Mobile Documents/iCloud~com~ted~ledgerai/Documents/snapshot.json');
  let snap;
  try {
    snap = JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null; // App v0.24 還沒部署到實機，或 iCloud 還沒同步下來
  }
  const months = snap.monthlySummary || [];
  const cur = months[months.length - 1] || {};
  const metrics = [
    { label: '本月收入', value: `$${nt(cur.income ?? 0)}` },
    { label: '本月支出', value: `$${nt(cur.expense ?? 0)}` },
    { label: '本月淨額', value: `$${nt((cur.income ?? 0) - (cur.expense ?? 0))}` },
  ];
  const lines = (snap.topCategoriesThisMonth || []).slice(0, 4).map(c => `${c.name}　$${nt(c.amount)}`);
  if (snap.baselineThisMonth != null) lines.push(`基準線 $${nt(snap.baselineThisMonth)}／一次性 $${nt(snap.oneOffThisMonth ?? 0)}`);
  return { title: '說了算 · 財務快照', updated: snap.generatedAt || nowLabel(), metrics, lines };
}

/* ---------- LINE 官方帳號額度 ---------- */
async function collectLine() {
  const base = 'https://qingpu-property-browser.onrender.com';
  try {
    const r = await fetch(`${base}/api/admin/line-quota`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(String(r.status));
    const q = await r.json();
    const used = q.used ?? q.totalUsage ?? 0;
    const limit = q.limit ?? q.quota ?? 200;
    return {
      title: 'LINE 官方帳號 · 額度',
      updated: nowLabel(),
      metrics: [
        { label: '本月已用', value: `${used}/${limit}` },
        { label: '剩餘', value: String(Math.max(0, limit - used)) },
      ],
      lines: [
        used / limit >= 0.9 ? '⚠️ 額度快用完，新聞簡報可能推不出去' : '額度正常',
        '7 月曾用滿 200 則，全部是 push',
      ],
      link: { href: `${base}/api/admin/line-delivery`, text: '看逐日推播明細' },
    };
  } catch (e) {
    return { title: 'LINE 官方帳號 · 額度', updated: nowLabel(), metrics: [], lines: [`讀不到端點：${e.message}（Render 冷啟動或端點變更）`] };
  }
}

const FEEDS = [
  { file: 'widgets/finance.json', collect: collectFinance },
  { file: 'widgets/line.json', collect: collectLine },
];

/* ---------- GitHub 寫入 ---------- */
async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  return res;
}

async function put(file, obj) {
  const body = JSON.stringify(obj, null, 2) + '\n';
  if (DRY) { console.log(`--- ${file} ---\n${body}`); return; }
  const head = await gh(`${file}?ref=${BRANCH}`);
  const sha = head.ok ? (await head.json()).sha : undefined;
  const res = await gh(file, {
    method: 'PUT',
    body: JSON.stringify({
      message: `feeder: ${file} ${nowLabel()}`,
      content: Buffer.from(body, 'utf8').toString('base64'),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new Error(`${file} 寫入失敗 ${res.status} ${await res.text()}`);
  console.log(`✓ ${file}`);
}

if (!TOKEN && !DRY) {
  console.error('缺少 DASH_TOKEN 環境變數。'); process.exit(1);
}
let failed = 0;
for (const f of FEEDS) {
  try {
    const data = await f.collect();
    if (!data) { console.log(`– ${f.file} 跳過（資料源還沒接上）`); continue; }
    await put(f.file, data);
  } catch (e) {
    failed++; console.error(`✗ ${f.file}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
