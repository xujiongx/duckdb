/** 从样例行推断列类型，避免 Excel 文本导入后 SUM(VARCHAR) 失败 */

export type SqlColType = "BIGINT" | "DOUBLE" | "DATE" | "VARCHAR";

export type ColumnMeta = {
  name: string;
  sqlType: SqlColType;
  /** 给 AI 的一句话说明 */
  hint: string;
};

type Row = Record<string, unknown>;

function cleanNumberText(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  let text = String(value).trim();
  if (!text || text === "-" || text === "—" || /^n\/?a$/i.test(text)) return null;
  // 百分比：12.3% → 0.123
  const pct = text.match(/^(-?[\d,]+(?:\.\d+)?)\s*%$/);
  if (pct) {
    const n = Number(pct[1].replace(/,/g, ""));
    return Number.isFinite(n) ? String(n / 100) : null;
  }
  // 货币 / 千分位：¥1,234.56 / $12
  text = text.replace(/[$¥€£￥,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  return text;
}

function looksLikeDate(value: unknown): boolean {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return true;
  if (value == null) return false;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return true;
  if (/^[A-Za-z]{3}\s+\d{1,2},\s*\d{4}$/.test(text)) return true;
  return false;
}

function inferColumnType(name: string, values: unknown[]): SqlColType {
  const nonNull = values.filter((v) => v != null && String(v).trim() !== "");
  if (!nonNull.length) return "VARCHAR";

  const dateHits = nonNull.filter(looksLikeDate).length;
  if (dateHits / nonNull.length >= 0.7) return "DATE";

  let intHits = 0;
  let doubleHits = 0;
  for (const v of nonNull) {
    const cleaned = cleanNumberText(v);
    if (cleaned == null) continue;
    if (/^-?\d+$/.test(cleaned)) intHits += 1;
    else doubleHits += 1;
  }
  const numHits = intHits + doubleHits;
  if (numHits / nonNull.length >= 0.7) {
    // 点击量/订单等整数字段优先 BIGINT；花费等带小数用 DOUBLE
    const lower = name.toLowerCase();
    if (
      doubleHits > 0 ||
      /花费|spend|cost|cpc|cpa|价格|price|金额|amount|率|rate|ratio/i.test(name) ||
      /spend|cost|cpc|cpa|price|amount|rate/.test(lower)
    ) {
      return "DOUBLE";
    }
    return "BIGINT";
  }
  return "VARCHAR";
}

export function inferColumnMetas(rows: Row[], sampleSize = 80): ColumnMeta[] {
  if (!rows.length) return [];
  const keys = Object.keys(rows[0]);
  const sample = rows.slice(0, sampleSize);
  return keys.map((name) => {
    const values = sample.map((row) => row[name]);
    const sqlType = inferColumnType(name, values);
    const hint =
      sqlType === "VARCHAR"
        ? "文本；若要对数字聚合请用 TRY_CAST(\"" + name + "\" AS DOUBLE)"
        : sqlType === "DATE"
          ? "日期类；可用 CAST(\"" + name + "\" AS DATE) 或 TRY_CAST"
          : "数值，可直接 SUM/AVG/ORDER BY";
    return { name, sqlType, hint };
  });
}

/** 写出前把可解析数值列规整为纯数字，便于 DuckDB 推断正确类型 */
export function coerceRowsForDuckDB(rows: Row[]): Row[] {
  if (!rows.length) return rows;
  const metas = inferColumnMetas(rows);
  const numeric = new Set(
    metas.filter((m) => m.sqlType === "BIGINT" || m.sqlType === "DOUBLE").map((m) => m.name),
  );
  if (!numeric.size) return rows;

  return rows.map((row) => {
    const next: Row = { ...row };
    for (const name of numeric) {
      const cleaned = cleanNumberText(row[name]);
      next[name] = cleaned == null ? null : Number(cleaned);
    }
    return next;
  });
}

export function typedCreateTableSql(
  tableName: string,
  virtualCsv: string,
  metas: ColumnMeta[],
): string {
  const selects = metas.map((m) => {
    const q = `"${m.name.replace(/"/g, '""')}"`;
    if (m.sqlType === "BIGINT") {
      return `TRY_CAST(${q} AS BIGINT) AS ${q}`;
    }
    if (m.sqlType === "DOUBLE") {
      return `TRY_CAST(${q} AS DOUBLE) AS ${q}`;
    }
    // 日期格式不一（如 Sep 1, 2024），保留 VARCHAR，由查询侧再解析
    return `${q}`;
  });
  return `
    CREATE OR REPLACE TABLE ${tableName} AS
    SELECT ${selects.join(",\n           ")}
    FROM read_csv_auto('${virtualCsv}', HEADER=true, SAMPLE_SIZE=-1, ALL_VARCHAR=true)
  `;
}
