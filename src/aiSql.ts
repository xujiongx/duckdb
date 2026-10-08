/** 调用 Agnes OpenAI 兼容接口：自然语言 → DuckDB SQL */

import type { ColumnMeta } from "./columnTypes";

export type AiSqlSchema = {
  tableName: string;
  columns: ColumnMeta[];
  sampleRows?: Record<string, unknown>[];
};

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function env(name: string): string {
  const value = (import.meta.env as Record<string, string | undefined>)[name];
  return typeof value === "string" ? value.trim() : "";
}

export function getAiConfig(): {
  apiKey: string;
  apiBase: string;
  model: string;
} {
  return {
    apiKey: env("OPENAI_API_KEY"),
    apiBase: env("AGNES_API_BASE").replace(/\/$/, "") || "https://apihub.agnes-ai.com/v1",
    model: env("OPENAI_MODEL") || "gpt-4o-mini",
  };
}

export function isAiConfigured(): boolean {
  return Boolean(getAiConfig().apiKey);
}

function buildSystemPrompt(schema: AiSqlSchema): string {
  const cols = schema.columns.length
    ? schema.columns
        .map((c) => `- "${c.name}" (${c.sqlType}) — ${c.hint}`)
        .join("\n")
    : "- （列未知）";
  const sample =
    schema.sampleRows && schema.sampleRows.length
      ? `\n样例行（JSON，仅供理解数据形态）：\n${JSON.stringify(schema.sampleRows.slice(0, 3), null, 2)}`
      : "";

  return `你是 DuckDB SQL 助手。根据用户描述，生成一条可在 DuckDB 中运行的只读 SQL。

硬性规则：
1. 只能查询表 \`${schema.tableName}\`，不要编造其他表或其他列名。
2. 只输出 SELECT / WITH / DESCRIBE / SHOW / EXPLAIN；禁止写操作。
3. 列名必须原样使用（含中文），一律用双引号包裹，例如 "客户搜索词"。
4. 聚合规则（非常重要）：
   - 类型为 BIGINT/DOUBLE 的列：可直接 SUM/AVG/ORDER BY。
   - 类型为 VARCHAR 的列：禁止直接 SUM/AVG；若内容像数字，必须写 SUM(TRY_CAST("列名" AS DOUBLE))。
   - 类型为 DATE 或日期文本：不要假设已是 DATE，可用 TRY_CAST 或按字符串分组。
5. 用户说「关键词」时优先用 "客户搜索词"；「点击」用 "点击量"；「花费」用 "花费"；「订单」用 "7天总订单数(#)"（若该列存在）。
6. 默认 LIMIT 100；若要求 Top N 则用 ORDER BY + LIMIT N。
7. 只输出 SQL 本身，不要 markdown，不要解释。
8. 不要使用图表/横轴等前端概念；只返回查询结果所需的列。

表字段：
${cols}
${sample}`;
}

function extractSql(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? trimmed).trim();
  return raw.replace(/;\s*$/, "").trim();
}

export async function generateSqlFromPrompt(
  prompt: string,
  schema: AiSqlSchema,
): Promise<string> {
  const { apiKey, apiBase, model } = getAiConfig();
  if (!apiKey) {
    throw new Error("未配置 OPENAI_API_KEY，请在项目根目录 .env 中填写");
  }
  if (!prompt.trim()) {
    throw new Error("请先输入分析需求描述");
  }
  if (!schema.columns.length) {
    throw new Error("请先上传数据，以便根据字段生成 SQL");
  }

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(schema) },
    { role: "user", content: prompt.trim() },
  ];

  const res = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `AI 请求失败（${res.status}）${body ? `：${body.slice(0, 200)}` : ""}`,
    );
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content?.trim()) {
    throw new Error("AI 未返回有效内容");
  }

  const sql = extractSql(content);
  if (!/^\s*(SELECT|WITH|DESCRIBE|SHOW|EXPLAIN)\b/i.test(sql)) {
    throw new Error(`AI 返回了非只读 SQL，已拒绝执行：\n${sql.slice(0, 200)}`);
  }
  return sql;
}
