/** 亚马逊广告搜索词报告：固定分析 SQL（表名 data） */

const CLEAN_CTE = `
clean AS (
  SELECT
    COALESCE(
      TRY_CAST(strptime(CAST("日期" AS VARCHAR), '%b %d, %Y') AS DATE),
      TRY_CAST(strptime(CAST("日期" AS VARCHAR), '%Y-%m-%d') AS DATE),
      TRY_CAST(CAST("日期" AS VARCHAR) AS DATE)
    ) AS dt,
    CAST("广告活动名称" AS VARCHAR) AS campaign,
    CAST("客户搜索词" AS VARCHAR) AS search_term,
    CAST("匹配类型" AS VARCHAR) AS match_type,
    TRY_CAST(regexp_replace(CAST("展示量" AS VARCHAR), '[^0-9.-]', '', 'g') AS DOUBLE) AS impressions,
    TRY_CAST(regexp_replace(CAST("点击量" AS VARCHAR), '[^0-9.-]', '', 'g') AS DOUBLE) AS clicks,
    TRY_CAST(regexp_replace(CAST("花费" AS VARCHAR), '[^0-9.-]', '', 'g') AS DOUBLE) AS spend,
    TRY_CAST(regexp_replace(CAST("单次点击成本 (CPC)" AS VARCHAR), '[^0-9.-]', '', 'g') AS DOUBLE) AS cpc,
    TRY_CAST(regexp_replace(CAST("7天总订单数(#)" AS VARCHAR), '[^0-9.-]', '', 'g') AS DOUBLE) AS orders,
    TRY_CAST(regexp_replace(CAST("7天总销售额" AS VARCHAR), '[^0-9.-]', '', 'g') AS DOUBLE) AS sales
  FROM data
)`;

const DATE_LABEL = `
  strftime(dt, '%Y年%m月%d日') || '（' ||
  CASE dayofweek(dt)
    WHEN 0 THEN '周日'
    WHEN 1 THEN '周一'
    WHEN 2 THEN '周二'
    WHEN 3 THEN '周三'
    WHEN 4 THEN '周四'
    WHEN 5 THEN '周五'
    WHEN 6 THEN '周六'
  END || '）'`;

const WEEK_LABEL = `
  strftime(date_trunc('week', dt), '%Y年%m月%d日') || ' 当周'`;

export type AmazonColumn = {
  key: string;
  label: string;
  format?: "number" | "money" | "percent" | "text";
};

export type AmazonAnalysis = {
  id: string;
  title: string;
  description: string;
  columns: AmazonColumn[];
  sql: string;
};

export const AMAZON_ANALYSES: AmazonAnalysis[] = [
  {
    id: "term-summary",
    title: "搜索词汇总",
    description:
      "按客户搜索词汇总点击量、花费、订单，并计算 CPC / CVR / CPA（对应透视表统计）",
    columns: [
      { key: "search_term", label: "客户搜索词", format: "text" },
      { key: "clicks", label: "点击量", format: "number" },
      { key: "spend", label: "花费", format: "money" },
      { key: "orders", label: "7天总订单数", format: "number" },
      { key: "cpc", label: "CPC", format: "money" },
      { key: "cvr", label: "CVR", format: "percent" },
      { key: "cpa", label: "CPA", format: "money" },
    ],
    sql: `
WITH ${CLEAN_CTE}
SELECT
  search_term,
  CAST(COALESCE(SUM(clicks), 0) AS INTEGER) AS clicks,
  ROUND(COALESCE(SUM(spend), 0), 2) AS spend,
  CAST(COALESCE(SUM(orders), 0) AS INTEGER) AS orders,
  ROUND(SUM(spend) / NULLIF(SUM(clicks), 0), 2) AS cpc,
  ROUND(SUM(orders) * 100.0 / NULLIF(SUM(clicks), 0), 2) AS cvr,
  ROUND(SUM(spend) / NULLIF(SUM(orders), 0), 2) AS cpa
FROM clean
WHERE search_term IS NOT NULL
  AND TRIM(search_term) <> ''
GROUP BY search_term
ORDER BY clicks DESC, spend DESC;
`.trim(),
  },
  {
    id: "daily-trend",
    title: "每日趋势",
    description: "按自然日汇总点击量、转化率、CPC，适合看整体走势",
    columns: [
      { key: "date_label", label: "日期", format: "text" },
      { key: "clicks", label: "点击量", format: "number" },
      { key: "orders", label: "订单数", format: "number" },
      { key: "spend", label: "花费", format: "money" },
      { key: "cpc", label: "CPC", format: "money" },
      { key: "cvr", label: "转化率", format: "percent" },
    ],
    sql: `
WITH ${CLEAN_CTE}
SELECT
  ${DATE_LABEL} AS date_label,
  CAST(COALESCE(SUM(clicks), 0) AS INTEGER) AS clicks,
  CAST(COALESCE(SUM(orders), 0) AS INTEGER) AS orders,
  ROUND(COALESCE(SUM(spend), 0), 2) AS spend,
  ROUND(SUM(spend) / NULLIF(SUM(clicks), 0), 2) AS cpc,
  ROUND(SUM(orders) * 100.0 / NULLIF(SUM(clicks), 0), 2) AS cvr
FROM clean
WHERE dt IS NOT NULL
GROUP BY dt
ORDER BY dt;
`.trim(),
  },
  {
    id: "daily-change",
    title: "日环比浮动",
    description: "对比前一天：点击量、转化率、CPC 的变化幅度",
    columns: [
      { key: "date_label", label: "日期", format: "text" },
      { key: "clicks", label: "点击量", format: "number" },
      { key: "clicks_change", label: "点击量变化", format: "number" },
      { key: "clicks_change_pct", label: "点击量涨跌", format: "percent" },
      { key: "cvr", label: "转化率", format: "percent" },
      { key: "cvr_change_pp", label: "转化率变化(百分点)", format: "number" },
      { key: "cvr_change_pct", label: "转化率涨跌", format: "percent" },
      { key: "cpc", label: "CPC", format: "money" },
      { key: "cpc_change", label: "CPC变化", format: "money" },
      { key: "cpc_change_pct", label: "CPC涨跌", format: "percent" },
    ],
    sql: `
WITH ${CLEAN_CTE},
daily AS (
  SELECT
    dt,
    SUM(clicks) AS clicks,
    ROUND(SUM(orders) * 1.0 / NULLIF(SUM(clicks), 0), 6) AS cvr,
    ROUND(SUM(spend) / NULLIF(SUM(clicks), 0), 6) AS cpc
  FROM clean
  WHERE dt IS NOT NULL
  GROUP BY dt
)
SELECT
  ${DATE_LABEL} AS date_label,
  CAST(clicks AS INTEGER) AS clicks,
  CAST(ROUND(clicks - LAG(clicks) OVER (ORDER BY dt), 0) AS INTEGER) AS clicks_change,
  ROUND((clicks / NULLIF(LAG(clicks) OVER (ORDER BY dt), 0) - 1) * 100, 2) AS clicks_change_pct,
  ROUND(cvr * 100, 2) AS cvr,
  ROUND((cvr - LAG(cvr) OVER (ORDER BY dt)) * 100, 2) AS cvr_change_pp,
  ROUND((cvr / NULLIF(LAG(cvr) OVER (ORDER BY dt), 0) - 1) * 100, 2) AS cvr_change_pct,
  ROUND(cpc, 2) AS cpc,
  ROUND(cpc - LAG(cpc) OVER (ORDER BY dt), 2) AS cpc_change,
  ROUND((cpc / NULLIF(LAG(cpc) OVER (ORDER BY dt), 0) - 1) * 100, 2) AS cpc_change_pct
FROM daily
ORDER BY dt;
`.trim(),
  },
  {
    id: "weekly-trend",
    title: "按周趋势",
    description: "按周汇总，波动更平滑，适合看阶段表现",
    columns: [
      { key: "week_label", label: "周次", format: "text" },
      { key: "clicks", label: "点击量", format: "number" },
      { key: "orders", label: "订单数", format: "number" },
      { key: "spend", label: "花费", format: "money" },
      { key: "cpc", label: "CPC", format: "money" },
      { key: "cvr", label: "转化率", format: "percent" },
    ],
    sql: `
WITH ${CLEAN_CTE}
SELECT
  ${WEEK_LABEL} AS week_label,
  CAST(COALESCE(SUM(clicks), 0) AS INTEGER) AS clicks,
  CAST(COALESCE(SUM(orders), 0) AS INTEGER) AS orders,
  ROUND(COALESCE(SUM(spend), 0), 2) AS spend,
  ROUND(SUM(spend) / NULLIF(SUM(clicks), 0), 2) AS cpc,
  ROUND(SUM(orders) * 100.0 / NULLIF(SUM(clicks), 0), 2) AS cvr
FROM clean
WHERE dt IS NOT NULL
GROUP BY date_trunc('week', dt)
ORDER BY date_trunc('week', dt);
`.trim(),
  },
  {
    id: "volatile-terms",
    title: "波动最大搜索词",
    description: "找出点击量波动最大的搜索词（至少 20 次点击）",
    columns: [
      { key: "search_term", label: "客户搜索词", format: "text" },
      { key: "total_clicks", label: "总点击量", format: "number" },
      { key: "clicks_std", label: "点击量波动", format: "number" },
      { key: "avg_cvr", label: "平均转化率", format: "percent" },
      { key: "cvr_std_pp", label: "转化率波动(百分点)", format: "number" },
      { key: "avg_cpc", label: "平均CPC", format: "money" },
      { key: "cpc_std", label: "CPC波动", format: "money" },
    ],
    sql: `
WITH ${CLEAN_CTE},
term_daily AS (
  SELECT
    search_term,
    dt,
    SUM(clicks) AS clicks,
    ROUND(SUM(orders) * 1.0 / NULLIF(SUM(clicks), 0), 6) AS cvr,
    ROUND(SUM(spend) / NULLIF(SUM(clicks), 0), 6) AS cpc
  FROM clean
  WHERE dt IS NOT NULL
    AND search_term IS NOT NULL
  GROUP BY 1, 2
),
term_stats AS (
  SELECT
    search_term,
    SUM(clicks) AS total_clicks,
    ROUND(STDDEV_SAMP(clicks), 2) AS clicks_std,
    ROUND(STDDEV_SAMP(cvr) * 100, 2) AS cvr_std_pp,
    ROUND(STDDEV_SAMP(cpc), 2) AS cpc_std,
    ROUND(AVG(cpc), 2) AS avg_cpc,
    ROUND(AVG(cvr) * 100, 2) AS avg_cvr
  FROM term_daily
  GROUP BY 1
  HAVING SUM(clicks) >= 20
)
SELECT
  search_term,
  CAST(total_clicks AS INTEGER) AS total_clicks,
  clicks_std,
  avg_cvr,
  cvr_std_pp,
  avg_cpc,
  cpc_std
FROM term_stats
ORDER BY clicks_std DESC
LIMIT 30;
`.trim(),
  },
];

export const AMAZON_REQUIRED_COLUMNS = [
  "日期",
  "点击量",
  "花费",
  "单次点击成本 (CPC)",
  "7天总订单数(#)",
  "客户搜索词",
] as const;

export function isAmazonSearchTermReport(columns: string[]): boolean {
  return AMAZON_REQUIRED_COLUMNS.every((col) => columns.includes(col));
}
