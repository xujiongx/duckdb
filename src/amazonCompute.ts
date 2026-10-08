import type { AmazonAnalysis } from "./amazonAnalyses";

export type Row = Record<string, unknown>;

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function num(value: unknown): number {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (value == null) return null;
  const text = String(value).trim();
  const mdy = text.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/);
  if (mdy) {
    const d = new Date(`${mdy[1]} ${mdy[2]}, ${mdy[3]} 00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const d = new Date(`${text.slice(0, 10)}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function dateLabel(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}年${m}月${day}日（${WEEKDAYS[d.getDay()]}）`;
}

function weekStart(d: Date): Date {
  const x = new Date(d);
  const day = x.getDay(); // 0 Sun
  const diff = day === 0 ? -6 : 1 - day; // Monday start
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}

function weekLabel(d: Date): string {
  const w = weekStart(d);
  const y = w.getFullYear();
  const m = String(w.getMonth() + 1).padStart(2, "0");
  const day = String(w.getDate()).padStart(2, "0");
  return `${y}年${m}月${day}日 当周`;
}

function getTerm(row: Row): string {
  return String(row["客户搜索词"] ?? row.search_term ?? "").trim();
}

function getClicks(row: Row): number {
  return num(row["点击量"] ?? row.clicks);
}

function getSpend(row: Row): number {
  return num(row["花费"] ?? row.spend);
}

function getOrders(row: Row): number {
  return num(row["7天总订单数(#)"] ?? row["7天总订单数"] ?? row.orders);
}

function ratio(n: number, d: number): number | null {
  if (!d) return null;
  return round2(n / d);
}

function pct(n: number, d: number): number | null {
  if (!d) return null;
  return round2((n * 100) / d);
}

export function computeAmazonAnalysis(
  analysis: AmazonAnalysis,
  sourceRows: Row[],
): Row[] {
  switch (analysis.id) {
    case "term-summary":
      return computeTermSummary(sourceRows);
    case "daily-trend":
      return computeDailyTrend(sourceRows);
    case "daily-change":
      return computeDailyChange(sourceRows);
    case "weekly-trend":
      return computeWeeklyTrend(sourceRows);
    case "volatile-terms":
      return computeVolatileTerms(sourceRows);
    default:
      throw new Error(`未知分析：${analysis.id}`);
  }
}

function computeTermSummary(rows: Row[]): Row[] {
  const map = new Map<string, { clicks: number; spend: number; orders: number }>();

  for (const row of rows) {
    const term = getTerm(row);
    if (!term) continue;
    const cur = map.get(term) ?? { clicks: 0, spend: 0, orders: 0 };
    cur.clicks += getClicks(row);
    cur.spend += getSpend(row);
    cur.orders += getOrders(row);
    map.set(term, cur);
  }

  return [...map.entries()]
    .map(([search_term, v]) => ({
      search_term,
      clicks: Math.round(v.clicks),
      spend: round2(v.spend),
      orders: Math.round(v.orders),
      cpc: ratio(v.spend, v.clicks),
      cvr: pct(v.orders, v.clicks),
      cpa: ratio(v.spend, v.orders),
    }))
    .sort((a, b) => b.clicks - a.clicks || b.spend - a.spend);
}

function aggregateByDate(rows: Row[]): { dt: Date; clicks: number; spend: number; orders: number }[] {
  const map = new Map<string, { dt: Date; clicks: number; spend: number; orders: number }>();

  for (const row of rows) {
    const dt = parseDate(row["日期"] ?? row.dt ?? row.date);
    if (!dt) continue;
    const key = `${dt.getFullYear()}-${dt.getMonth()}-${dt.getDate()}`;
    const cur = map.get(key) ?? { dt, clicks: 0, spend: 0, orders: 0 };
    cur.clicks += getClicks(row);
    cur.spend += getSpend(row);
    cur.orders += getOrders(row);
    map.set(key, cur);
  }

  return [...map.values()].sort((a, b) => a.dt.getTime() - b.dt.getTime());
}

function computeDailyTrend(rows: Row[]): Row[] {
  return aggregateByDate(rows).map((v) => ({
    date_label: dateLabel(v.dt),
    clicks: Math.round(v.clicks),
    orders: Math.round(v.orders),
    spend: round2(v.spend),
    cpc: ratio(v.spend, v.clicks),
    cvr: pct(v.orders, v.clicks),
  }));
}

function computeDailyChange(rows: Row[]): Row[] {
  const daily = aggregateByDate(rows);
  return daily.map((v, i) => {
    const prev = i > 0 ? daily[i - 1] : null;
    const cvr = v.clicks ? v.orders / v.clicks : null;
    const prevCvr = prev && prev.clicks ? prev.orders / prev.clicks : null;
    const cpc = v.clicks ? v.spend / v.clicks : null;
    const prevCpc = prev && prev.clicks ? prev.spend / prev.clicks : null;

    return {
      date_label: dateLabel(v.dt),
      clicks: Math.round(v.clicks),
      clicks_change: prev ? Math.round(v.clicks - prev.clicks) : null,
      clicks_change_pct:
        prev && prev.clicks ? round2((v.clicks / prev.clicks - 1) * 100) : null,
      cvr: cvr == null ? null : round2(cvr * 100),
      cvr_change_pp:
        cvr != null && prevCvr != null ? round2((cvr - prevCvr) * 100) : null,
      cvr_change_pct:
        cvr != null && prevCvr ? round2((cvr / prevCvr - 1) * 100) : null,
      cpc: cpc == null ? null : round2(cpc),
      cpc_change:
        cpc != null && prevCpc != null ? round2(cpc - prevCpc) : null,
      cpc_change_pct:
        cpc != null && prevCpc ? round2((cpc / prevCpc - 1) * 100) : null,
    };
  });
}

function computeWeeklyTrend(rows: Row[]): Row[] {
  const map = new Map<string, { dt: Date; clicks: number; spend: number; orders: number }>();

  for (const row of rows) {
    const dt = parseDate(row["日期"] ?? row.dt ?? row.date);
    if (!dt) continue;
    const w = weekStart(dt);
    const key = w.toISOString().slice(0, 10);
    const cur = map.get(key) ?? { dt: w, clicks: 0, spend: 0, orders: 0 };
    cur.clicks += getClicks(row);
    cur.spend += getSpend(row);
    cur.orders += getOrders(row);
    map.set(key, cur);
  }

  return [...map.values()]
    .sort((a, b) => a.dt.getTime() - b.dt.getTime())
    .map((v) => ({
      week_label: weekLabel(v.dt),
      clicks: Math.round(v.clicks),
      orders: Math.round(v.orders),
      spend: round2(v.spend),
      cpc: ratio(v.spend, v.clicks),
      cvr: pct(v.orders, v.clicks),
    }));
}

function computeVolatileTerms(rows: Row[]): Row[] {
  const byTermDay = new Map<string, Map<string, { clicks: number; spend: number; orders: number }>>();

  for (const row of rows) {
    const term = getTerm(row);
    const dt = parseDate(row["日期"] ?? row.dt ?? row.date);
    if (!term || !dt) continue;
    const dayKey = `${dt.getFullYear()}-${dt.getMonth()}-${dt.getDate()}`;
    if (!byTermDay.has(term)) byTermDay.set(term, new Map());
    const dayMap = byTermDay.get(term)!;
    const cur = dayMap.get(dayKey) ?? { clicks: 0, spend: 0, orders: 0 };
    cur.clicks += getClicks(row);
    cur.spend += getSpend(row);
    cur.orders += getOrders(row);
    dayMap.set(dayKey, cur);
  }

  const result: Row[] = [];
  for (const [search_term, dayMap] of byTermDay) {
    const days = [...dayMap.values()];
    const totalClicks = days.reduce((s, d) => s + d.clicks, 0);
    if (totalClicks < 20) continue;

    const clickSeries = days.map((d) => d.clicks);
    const cvrSeries = days.map((d) => (d.clicks ? d.orders / d.clicks : 0));
    const cpcSeries = days.map((d) => (d.clicks ? d.spend / d.clicks : 0));

    const avg = (arr: number[]) => arr.reduce((s, n) => s + n, 0) / arr.length;
    const std = (arr: number[]) => {
      if (arr.length < 2) return 0;
      const m = avg(arr);
      const v = arr.reduce((s, n) => s + (n - m) ** 2, 0) / (arr.length - 1);
      return Math.sqrt(v);
    };

    result.push({
      search_term,
      total_clicks: Math.round(totalClicks),
      clicks_std: round2(std(clickSeries)),
      avg_cvr: round2(avg(cvrSeries) * 100),
      cvr_std_pp: round2(std(cvrSeries) * 100),
      avg_cpc: round2(avg(cpcSeries)),
      cpc_std: round2(std(cpcSeries)),
    });
  }

  return result
    .sort((a, b) => Number(b.clicks_std) - Number(a.clicks_std))
    .slice(0, 30);
}
