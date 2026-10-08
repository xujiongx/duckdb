import "./styles.css";
import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import duckdbWasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import * as XLSX from "xlsx";
import {
  AMAZON_ANALYSES,
  isAmazonSearchTermReport,
  type AmazonAnalysis,
  type AmazonColumn,
} from "./amazonAnalyses";
import { computeAmazonAnalysis } from "./amazonCompute";
import { generateSqlFromPrompt, isAiConfigured } from "./aiSql";

type Row = Record<string, unknown>;
type FileKind = "csv" | "parquet" | "json" | "excel";

const TABLE = "data";
const BUILD_ID = "20261008-ai-sql-v11";
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;
/** 上传/预览/亚马逊分析：不依赖 Wasm，打开页面即可用 */
let appReady = false;
/** SQL 面板依赖 DuckDB-Wasm，手机上可能较慢或失败 */
let duckdbReady = false;
let duckdbInitError = "";
let amazonMode = false;
let activeAmazonId = AMAZON_ANALYSES[0]?.id ?? "";

/** 原始行缓存：亚马逊分析直接在前端聚合，不依赖 Wasm 查询结果列 */
let cachedSourceRows: Row[] = [];

/** 数据预览分页状态（全量） */
let previewRows: Row[] = [];
let previewColumns: AmazonColumn[] = [];
let previewPage = 1;
let previewPageSize = 50;

/** 亚马逊分析结果分页状态 */
let amazonResultRows: Row[] = [];
let amazonResultColumns: AmazonColumn[] = [];
let amazonPage = 1;
let amazonPageSize = 50;

/** 缓存当前 Excel，便于切换工作表 */
let excelState: {
  fileName: string;
  size: number;
  workbook: XLSX.WorkBook;
  sheetName: string;
} | null = null;

function setStatus(text: string, isError = false): void {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("is-error", isError);
}

function toFriendlyDate(value: unknown): string | null {
  if (value == null) return null;

  let date: Date | null = null;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "string") {
    const text = value.trim();
    // 已是中文可读格式则保留
    if (/^\d{4}年\d{1,2}月\d{1,2}日/.test(text)) return text;

    const mdy = text.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/);
    if (mdy) {
      date = new Date(`${mdy[1]} ${mdy[2]}, ${mdy[3]} 00:00:00`);
    } else if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
      date = new Date(`${text.slice(0, 10)}T00:00:00`);
    }
  }

  if (!date || Number.isNaN(date.getTime())) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const week = WEEKDAYS[date.getDay()];
  return `${y}年${m}月${d}日（${week}）`;
}

function formatByType(
  value: unknown,
  format: AmazonColumn["format"] = "text",
  key = "",
): string {
  if (value == null || value === "") return "—";

  const friendlyDate = toFriendlyDate(value);
  if (
    friendlyDate &&
    (format === "text" ||
      /date|week|日期|周次/i.test(key) ||
      (typeof value === "string" && /^[A-Za-z]{3}\s+\d{1,2},\s*\d{4}/.test(value)))
  ) {
    return friendlyDate;
  }

  if (typeof value === "bigint") {
    value = Number(value);
  }

  if (typeof value === "number") {
    if (Number.isNaN(value)) return "—";
    if (format === "money") return `$${value.toFixed(2)}`;
    if (format === "percent") return `${value}%`;
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }

  if (typeof value === "object") return String(value);
  return String(value);
}

function formatCell(key: string, value: unknown): string {
  if (/cvr|转化率|涨跌|pct/i.test(key)) return formatByType(value, "percent", key);
  if (/cpc|cpa|spend|花费|销售额/i.test(key)) return formatByType(value, "money", key);
  if (/click|order|数量|次数|波动|变化|std|pp/i.test(key)) {
    return formatByType(value, "number", key);
  }
  return formatByType(value, "text", key);
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value;
  if (typeof value === "object" && value !== null) {
    // Apache Arrow 可能返回带 toString 的特殊对象
    if ("valueOf" in value && typeof (value as { valueOf: () => unknown }).valueOf === "function") {
      const raw = (value as { valueOf: () => unknown }).valueOf();
      if (typeof raw === "bigint") return Number(raw);
      if (typeof raw === "number" || typeof raw === "string") return raw;
    }
    return String(value);
  }
  return value;
}

function extractPayload(table: Awaited<ReturnType<duckdb.AsyncDuckDBConnection["query"]>>): string {
  // 优先按列读取单格 payload，避免多列 Arrow 丢字段
  const byName = table.getChild("payload")?.get(0);
  if (typeof byName === "string") return byName;
  if (byName != null) return String(byName);

  const byIndex = table.getChildAt(0)?.get(0);
  if (typeof byIndex === "string") return byIndex;
  if (byIndex != null) return String(byIndex);

  const first = table.toArray()[0] as { payload?: unknown; toJSON?: () => Row } | undefined;
  if (!first) return "[]";
  if (typeof first.payload === "string") return first.payload;
  if (first.toJSON) {
    const json = first.toJSON();
    if (typeof json.payload === "string") return json.payload;
    if (json.payload != null) return String(json.payload);
  }
  return "[]";
}

async function queryRows(sql: string): Promise<Row[]> {
  if (!conn) throw new Error("DuckDB 尚未就绪");

  // 把结果收成 JSON 字符串再解析，规避 duckdb-wasm/Arrow 多列丢失问题
  const cleanSql = sql.replace(/;\s*$/, "").trim();
  const wrapped = `
    SELECT COALESCE(
      CAST(json_group_array(j) AS VARCHAR),
      '[]'
    ) AS payload
    FROM (
      SELECT to_json(__t) AS j
      FROM (${cleanSql}) AS __t
    )
  `;

  const table = await conn.query(wrapped);
  const payload = extractPayload(table);

  try {
    const parsed = JSON.parse(payload) as Row[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((row) => {
      const out: Row = {};
      for (const [key, value] of Object.entries(row ?? {})) {
        out[key] = normalizeValue(value);
      }
      return out;
    });
  } catch (err) {
    throw new Error(
      `解析查询结果失败：${err instanceof Error ? err.message : String(err)}；payload=${payload.slice(0, 180)}`,
    );
  }
}

function renderTable(
  headId: string,
  bodyId: string,
  rows: Row[],
  columns?: AmazonColumn[],
): void {
  const head = document.getElementById(headId);
  const body = document.getElementById(bodyId);
  if (!head || !body) return;

  if (!rows.length) {
    head.innerHTML = "";
    body.innerHTML = `<tr><td>暂无数据</td></tr>`;
    return;
  }

  const cols: AmazonColumn[] =
    columns ??
    Object.keys(rows[0]).map((key) => ({
      key,
      label: key,
      format: "text" as const,
    }));

  head.innerHTML = `<tr>${cols
    .map((col) => `<th>${col.label}</th>`)
    .join("")}</tr>`;
  body.innerHTML = rows
    .map(
      (row) =>
        `<tr>${cols
          .map(
            (col) =>
              `<td>${formatByType(row[col.key], col.format, col.key)}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
}

function createPager(options: {
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}): HTMLDivElement {
  const { total, pageSize } = options;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, options.page), totalPages);
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  const pager = document.createElement("div");
  pager.className = "pager";

  const info = document.createElement("span");
  info.className = "pager-info";
  info.textContent = `共 ${total.toLocaleString("zh-CN")} 行 · 第 ${page}/${totalPages} 页 · 显示 ${start}-${end}`;

  const sizeLabel = document.createElement("label");
  sizeLabel.className = "pager-size";
  sizeLabel.textContent = "每页";
  const sizeSelect = document.createElement("select");
  for (const size of [20, 50, 100, 200]) {
    const opt = document.createElement("option");
    opt.value = String(size);
    opt.textContent = String(size);
    if (size === pageSize) opt.selected = true;
    sizeSelect.append(opt);
  }
  sizeSelect.addEventListener("change", () => {
    options.onPageSizeChange(Number(sizeSelect.value) || 50);
  });
  sizeLabel.append(sizeSelect);

  const actions = document.createElement("div");
  actions.className = "pager-actions";

  const addBtn = (text: string, disabled: boolean, onClick: () => void) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = text;
    btn.disabled = disabled;
    btn.addEventListener("click", onClick);
    actions.append(btn);
  };

  addBtn("首页", page <= 1, () => options.onPageChange(1));
  addBtn("上一页", page <= 1, () => options.onPageChange(page - 1));
  addBtn("下一页", page >= totalPages, () => options.onPageChange(page + 1));
  addBtn("末页", page >= totalPages, () => options.onPageChange(totalPages));

  const jumpLabel = document.createElement("label");
  jumpLabel.className = "pager-jump";
  jumpLabel.textContent = "跳转";
  const jumpInput = document.createElement("input");
  jumpInput.type = "number";
  jumpInput.min = "1";
  jumpInput.max = String(totalPages);
  jumpInput.value = String(page);
  const jump = () => options.onPageChange(Number(jumpInput.value) || 1);
  jumpInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") jump();
  });
  const jumpBtn = document.createElement("button");
  jumpBtn.type = "button";
  jumpBtn.textContent = "Go";
  jumpBtn.addEventListener("click", jump);
  jumpLabel.append(jumpInput, jumpBtn);
  actions.append(jumpLabel);

  pager.append(info, sizeLabel, actions);
  return pager;
}

function renderPagedTable(options: {
  mount: HTMLElement;
  rows: Row[];
  columns: AmazonColumn[];
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  chips?: HTMLElement | null;
}): { page: number } {
  const { mount, rows, columns, pageSize, chips } = options;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(Math.max(1, options.page), totalPages);
  const start = (page - 1) * pageSize;
  const viewRows = rows.slice(start, start + pageSize);

  if (chips) {
    chips.replaceChildren(
      ...columns.map((col) => {
        const chip = document.createElement("span");
        chip.className = "column-chip";
        chip.textContent = col.label;
        return chip;
      }),
    );
  }

  mount.replaceChildren();

  if (!rows.length || !columns.length) {
    const empty = document.createElement("p");
    empty.className = "view-note";
    empty.textContent = "暂无数据";
    mount.append(empty);
    return { page };
  }

  const pagerOpts = {
    total: rows.length,
    page,
    pageSize,
    onPageChange: options.onPageChange,
    onPageSizeChange: options.onPageSizeChange,
  };

  const wrap = document.createElement("div");
  wrap.className = "amazon-table-wrap";

  const table = document.createElement("table");
  table.className = "amazon-data-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const col of columns) {
    const th = document.createElement("th");
    th.textContent = col.label;
    // 按表头字数给最小宽度，多列时横向滚动而不是挤扁
    const labelLen = [...col.label].length;
    th.style.minWidth = `${Math.max(120, Math.min(280, labelLen * 16 + 28))}px`;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const row of viewRows) {
    const tr = document.createElement("tr");
    for (const col of columns) {
      const td = document.createElement("td");
      td.textContent = formatByType(row[col.key], col.format, col.key);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);

  mount.append(
    createPager(pagerOpts),
    wrap,
    createPager(pagerOpts),
  );

  return { page };
}

function renderPreviewMount(resetPage = false): void {
  if (resetPage) previewPage = 1;
  const mount = document.getElementById("preview-result-mount");
  if (!mount) return;

  const result = renderPagedTable({
    mount,
    rows: previewRows,
    columns: previewColumns,
    page: previewPage,
    pageSize: previewPageSize,
    onPageChange: (page) => {
      previewPage = page;
      renderPreviewMount();
    },
    onPageSizeChange: (size) => {
      previewPageSize = size;
      previewPage = 1;
      renderPreviewMount();
    },
  });
  previewPage = result.page;

  const note = document.getElementById("preview-note");
  if (note) {
    note.textContent = previewRows.length
      ? `全量 ${previewRows.length.toLocaleString("zh-CN")} 行 · ${previewColumns.length} 列 · 支持分页浏览`
      : "支持全量数据分页浏览";
  }
}

function renderAmazonMount(
  rows?: Row[],
  columns?: AmazonColumn[],
  resetPage = false,
): void {
  if (rows && columns) {
    amazonResultRows = rows;
    amazonResultColumns = columns;
    if (resetPage) amazonPage = 1;
  }

  const mount = document.getElementById("amazon-result-mount");
  if (!mount) return;

  const result = renderPagedTable({
    mount,
    rows: amazonResultRows,
    columns: amazonResultColumns,
    page: amazonPage,
    pageSize: amazonPageSize,
    chips: document.getElementById("amazon-column-chips"),
    onPageChange: (page) => {
      amazonPage = page;
      renderAmazonMount();
    },
    onPageSizeChange: (size) => {
      amazonPageSize = size;
      amazonPage = 1;
      renderAmazonMount();
    },
  });
  amazonPage = result.page;
}

function columnsFromRows(rows: Row[]): AmazonColumn[] {
  if (!rows.length) return [];
  return Object.keys(rows[0]).map((key) => ({
    key,
    label: key,
    format: "text" as const,
  }));
}

function switchView(name: string): void {
  document.querySelectorAll(".tab").forEach((tab) => {
    const el = tab as HTMLElement;
    if (el.hidden) {
      el.classList.remove("is-active");
      return;
    }
    el.classList.toggle("is-active", el.dataset.view === name);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("is-active", view.id === `view-${name}`);
  });
}

function detectKind(fileName: string): FileKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) return "excel";
  if (lower.endsWith(".parquet")) return "parquet";
  if (
    lower.endsWith(".json") ||
    lower.endsWith(".jsonl") ||
    lower.endsWith(".ndjson")
  ) {
    return "json";
  }
  return "csv";
}

function readerSql(kind: Exclude<FileKind, "excel">, virtualName: string): string {
  if (kind === "parquet") return `read_parquet('${virtualName}')`;
  if (kind === "json") return `read_json_auto('${virtualName}')`;
  return `read_csv_auto('${virtualName}', HEADER=true)`;
}

function defaultSql(columns: string[]): string {
  const firstText =
    columns.find((c) => !/id|count|qty|quantity|price|amount|total/i.test(c)) ??
    columns[0];
  if (columns.length >= 2) {
    return `SELECT "${firstText}", COUNT(*) AS rows
FROM ${TABLE}
GROUP BY 1
ORDER BY rows DESC
LIMIT 20;`;
  }
  return `SELECT * FROM ${TABLE} LIMIT 20;`;
}

function showWorkspace(show: boolean): void {
  document.getElementById("upload-panel")!.hidden = show;
  document.getElementById("workspace")!.hidden = !show;
}

function updateSheetPicker(sheetNames: string[], active: string): void {
  const picker = document.getElementById("sheet-picker")!;
  const select = document.getElementById("sheet-select") as HTMLSelectElement;

  if (sheetNames.length <= 1) {
    picker.hidden = true;
    select.innerHTML = "";
    return;
  }

  select.innerHTML = sheetNames
    .map(
      (name) =>
        `<option value="${name.replace(/"/g, "&quot;")}" ${
          name === active ? "selected" : ""
        }>${name}</option>`,
    )
    .join("");
  picker.hidden = false;
}

function renderAmazonCards(): void {
  const grid = document.getElementById("amazon-grid")!;
  grid.innerHTML = AMAZON_ANALYSES.map(
    (item) => `
      <button
        type="button"
        class="amazon-card ${item.id === activeAmazonId ? "is-active" : ""}"
        data-amazon-id="${item.id}"
      >
        <span class="amazon-card-title">${item.title}</span>
        <span class="amazon-card-desc">${item.description}</span>
      </button>
    `,
  ).join("");

  grid.querySelectorAll(".amazon-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = (btn as HTMLElement).dataset.amazonId ?? "";
      const analysis = AMAZON_ANALYSES.find((item) => item.id === id);
      if (analysis) void runAmazonAnalysis(analysis);
    });
  });
}

function setAmazonMode(enabled: boolean): void {
  amazonMode = enabled;
  const tab = document.getElementById("tab-amazon")!;
  tab.hidden = !enabled;
  document.getElementById("amazon-note")!.textContent = enabled
    ? "已识别亚马逊搜索词报告。点击下方模块即可查看点击量、转化、CPC 趋势；日期显示为可读中文。"
    : "当前文件不是亚马逊搜索词报告（缺少必要字段），无法使用本模块。";
}

async function runAmazonAnalysis(analysis: AmazonAnalysis): Promise<void> {
  const errorEl = document.getElementById("amazon-error")!;
  errorEl.hidden = true;
  activeAmazonId = analysis.id;
  renderAmazonCards();

  document.getElementById("amazon-result-title")!.textContent = analysis.title;
  document.getElementById("amazon-result-desc")!.textContent = analysis.description;

  try {
    setStatus(`正在运行：${analysis.title}…`);
    if (!cachedSourceRows.length) {
      throw new Error("没有可用的原始数据，请重新上传报告");
    }

    // 关键：前端直接聚合 + 整块 HTML 重绘
    const rows = computeAmazonAnalysis(analysis, cachedSourceRows);
    if (!rows.length) {
      throw new Error("查询无结果，请确认已导入搜索词报告");
    }

    renderAmazonMount(rows, analysis.columns, true);
    document.getElementById("amazon-result-title")!.textContent =
      `${analysis.title}（${analysis.columns.length} 列 · ${rows.length.toLocaleString("zh-CN")} 行）`;
    setStatus(
      `「${analysis.title}」已完成（${rows.length.toLocaleString("zh-CN")} 行，已分页）· ${BUILD_ID}`,
    );
    switchView("amazon");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errorEl.hidden = false;
    errorEl.textContent = message;
    setStatus(`分析失败：${message}`, true);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${label}超时（${Math.round(ms / 1000)}s），手机网络较慢时可先上传分析`));
    }, ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function isMobileBrowser(): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

async function initDuckDB(): Promise<void> {
  const mobile = isMobileBrowser();
  setStatus(
    mobile
      ? "正在后台加载 DuckDB-Wasm（手机约需下载几十 MB，可先上传文件分析）…"
      : "正在后台加载 DuckDB-Wasm…",
  );

  // 手机只走 MVP（更小、兼容更好）；桌面再尝试 EH
  const localBundles: duckdb.DuckDBBundles = mobile
    ? { mvp: { mainModule: duckdbWasm, mainWorker: mvpWorker } }
    : {
        mvp: { mainModule: duckdbWasm, mainWorker: mvpWorker },
        eh: { mainModule: duckdbWasmEh, mainWorker: ehWorker },
      };

  const tryLocal = async (bundles: duckdb.DuckDBBundles) => {
    const bundle = await duckdb.selectBundle(bundles);
    const worker = new Worker(bundle.mainWorker!);
    const instance = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
    await instance.instantiate(bundle.mainModule, bundle.pthreadWorker);
    return instance;
  };

  // CDN Worker 跨域需 Blob 包装（官方推荐写法）
  const tryCdn = async () => {
    const bundles = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(
      mobile ? { mvp: bundles.mvp } : bundles,
    );
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker!}");`], {
        type: "text/javascript",
      }),
    );
    try {
      const worker = new Worker(workerUrl);
      const instance = new duckdb.AsyncDuckDB(
        new duckdb.ConsoleLogger(),
        worker,
      );
      await instance.instantiate(bundle.mainModule, bundle.pthreadWorker);
      return instance;
    } finally {
      URL.revokeObjectURL(workerUrl);
    }
  };

  try {
    db = await withTimeout(tryLocal(localBundles), 90_000, "本地 Wasm 初始化");
  } catch (localErr) {
    console.warn("本地 Wasm 失败，尝试 CDN", localErr);
    setStatus("本地引擎加载失败，改试 CDN…");
    db = await withTimeout(tryCdn(), 120_000, "CDN Wasm 初始化");
  }

  conn = await db.connect();
  duckdbReady = true;
  duckdbInitError = "";
}

async function syncRowsToDuckDB(rows: Row[]): Promise<void> {
  if (!duckdbReady || !db || !conn || !rows.length) return;
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const csv = XLSX.utils.sheet_to_csv(worksheet);
  const virtualName = `sync_${Date.now()}.csv`;
  await db.registerFileBuffer(virtualName, new TextEncoder().encode(csv));
  await conn.query(`
    CREATE OR REPLACE TABLE ${TABLE} AS
    SELECT * FROM read_csv_auto('${virtualName}', HEADER=true, SAMPLE_SIZE=-1)
  `);
}

function parseWorkbookSheet(
  workbook: XLSX.WorkBook,
  sheetName: string,
): Row[] {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`找不到工作表：${sheetName}`);
  const rows = XLSX.utils.sheet_to_json<Row>(sheet, {
    defval: null,
    raw: false,
  });
  if (!rows.length) throw new Error(`工作表「${sheetName}」没有数据`);
  return rows;
}

async function refreshWorkspace(
  fileName: string,
  size: number,
  formatLabel: string,
  metaExtra = "",
): Promise<void> {
  if (!cachedSourceRows.length && duckdbReady) {
    cachedSourceRows = await queryRows(`SELECT * FROM ${TABLE}`);
  }
  if (!cachedSourceRows.length) {
    throw new Error("没有可用数据，请重新上传文件");
  }

  previewRows = cachedSourceRows;
  previewColumns = columnsFromRows(previewRows);
  previewPage = 1;
  const columns = previewColumns.map((col) => col.key);

  // 有 DuckDB 时后台同步，供 SQL 面板使用；失败不影响预览/分析
  if (duckdbReady) {
    void syncRowsToDuckDB(cachedSourceRows).catch((err) => {
      console.warn("同步到 DuckDB 失败", err);
    });
  }

  document.getElementById("file-name")!.textContent = fileName;
  document.getElementById("file-meta")!.textContent =
    `${formatBytes(size)} · ${formatLabel}${metaExtra}` +
    (duckdbReady ? ` · SQL 可用` : ` · SQL 待引擎就绪`);
  document.getElementById("stat-rows")!.textContent =
    previewRows.length.toLocaleString("zh-CN");
  document.getElementById("stat-cols")!.textContent = String(previewColumns.length);
  document.getElementById("stat-table")!.textContent = TABLE;
  document.getElementById("stat-format")!.textContent = formatLabel;

  (document.getElementById("sql-input") as HTMLTextAreaElement).value =
    defaultSql(columns);

  renderPreviewMount(true);
  renderTable(
    "head-schema",
    "body-schema",
    previewColumns.map((col) => ({
      column_name: col.key,
      column_type: "VARCHAR",
      null: "YES",
    })),
  );
  renderTable("head-sql", "body-sql", []);

  const isAmazon = isAmazonSearchTermReport(columns);
  setAmazonMode(isAmazon);
  renderAmazonCards();

  showWorkspace(true);

  if (isAmazon) {
    document.getElementById("amazon-result-title")!.textContent = "分析结果";
    document.getElementById("amazon-result-desc")!.textContent =
      "请选择上方分析模块";
    switchView("amazon");
    setStatus(`已加载亚马逊搜索词报告，正在生成搜索词汇总…`);
    await runAmazonAnalysis(AMAZON_ANALYSES[0]);
  } else {
    switchView("preview");
    setStatus(
      `已加载 ${fileName}（${previewRows.length.toLocaleString("zh-CN")} 行，预览已分页）`,
    );
  }
}

async function loadBuffer(
  fileName: string,
  buffer: Uint8Array,
  size: number,
): Promise<void> {
  const kind = detectKind(fileName);

  if (kind === "excel") {
    const workbook = XLSX.read(buffer, {
      type: "array",
      cellDates: true,
    });
    if (!workbook.SheetNames.length) throw new Error("Excel 文件中没有工作表");

    const preferred =
      workbook.SheetNames.find((name) => {
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], {
          defval: null,
        });
        return rows.length > 0;
      }) ?? workbook.SheetNames[0];

    excelState = { fileName, size, workbook, sheetName: preferred };
    updateSheetPicker(workbook.SheetNames, preferred);
    cachedSourceRows = parseWorkbookSheet(workbook, preferred);
    await refreshWorkspace(
      fileName,
      size,
      "EXCEL",
      ` · 工作表「${preferred}」`,
    );
    return;
  }

  excelState = null;
  updateSheetPicker([], "");

  if (kind === "csv" || kind === "json") {
    const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
    const sheetName = workbook.SheetNames[0];
    cachedSourceRows = parseWorkbookSheet(workbook, sheetName);
  } else if (kind === "parquet") {
    if (!duckdbReady) {
      throw new Error("Parquet 需要 DuckDB 引擎，请等待引擎加载完成后再试");
    }
    const virtualName = `upload_${Date.now()}_${fileName.replace(/[^\w.-]+/g, "_")}`;
    await db!.registerFileBuffer(virtualName, buffer);
    await conn!.query(`
      CREATE OR REPLACE TABLE ${TABLE} AS
      SELECT * FROM ${readerSql(kind, virtualName)}
    `);
    cachedSourceRows = await queryRows(`SELECT * FROM ${TABLE}`);
  } else {
    cachedSourceRows = [];
  }

  await refreshWorkspace(fileName, size, kind.toUpperCase());
}

async function switchExcelSheet(sheetName: string): Promise<void> {
  if (!excelState) return;
  setStatus(`正在切换到工作表「${sheetName}」…`);
  try {
    excelState.sheetName = sheetName;
    cachedSourceRows = parseWorkbookSheet(excelState.workbook, sheetName);
    updateSheetPicker(excelState.workbook.SheetNames, sheetName);
    await refreshWorkspace(
      excelState.fileName,
      excelState.size,
      "EXCEL",
      ` · 工作表「${sheetName}」`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(`切换工作表失败：${message}`, true);
  }
}

async function handleFile(file: File): Promise<void> {
  if (!appReady) {
    setStatus("页面还在准备，请稍候再上传", true);
    return;
  }

  setStatus(`正在导入 ${file.name}…`);
  try {
    const buffer = new Uint8Array(await file.arrayBuffer());
    await loadBuffer(file.name, buffer, file.size);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(`导入失败：${message}`, true);
    console.error(err);
  }
}

async function loadSampleFile(url: string, fileName: string, tip: string): Promise<void> {
  if (!appReady) {
    setStatus("页面还在准备，请稍候", true);
    return;
  }

  setStatus(tip);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`无法获取文件：${url}`);
    const buffer = new Uint8Array(await res.arrayBuffer());
    await loadBuffer(fileName, buffer, buffer.byteLength);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(`示例加载失败：${message}`, true);
  }
}

async function generateAiSql(): Promise<void> {
  const errorEl = document.getElementById("sql-error")!;
  const btn = document.getElementById("ai-generate-btn") as HTMLButtonElement;
  const promptEl = document.getElementById("ai-prompt") as HTMLTextAreaElement;
  const sqlEl = document.getElementById("sql-input") as HTMLTextAreaElement;
  errorEl.hidden = true;

  if (!isAiConfigured()) {
    errorEl.hidden = false;
    errorEl.textContent =
      "未配置 AI：请在项目根目录 .env 填写 OPENAI_API_KEY / AGNES_API_BASE，并重启开发服务";
    return;
  }

  const columns = previewColumns.length
    ? previewColumns.map((col) => col.key)
    : columnsFromRows(cachedSourceRows).map((col) => col.key);

  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = "生成中…";
  setStatus("正在调用 AI 生成 SQL…");

  try {
    const sql = await generateSqlFromPrompt(promptEl.value, {
      tableName: TABLE,
      columns,
      sampleRows: cachedSourceRows.slice(0, 3),
    });
    sqlEl.value = sql;
    setStatus("SQL 已生成，可编辑后点击「运行查询」");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errorEl.hidden = false;
    errorEl.textContent = message;
    setStatus(`AI 生成失败：${message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel ?? "AI 生成 SQL";
  }
}

async function runSql(event: Event): Promise<void> {
  event.preventDefault();
  const errorEl = document.getElementById("sql-error")!;
  errorEl.hidden = true;

  if (!duckdbReady) {
    errorEl.hidden = false;
    errorEl.textContent = duckdbInitError
      ? `DuckDB 未就绪：${duckdbInitError}`
      : "DuckDB 仍在后台加载，请稍后再试 SQL；预览和亚马逊分析可先用";
    return;
  }

  const sql = (document.getElementById("sql-input") as HTMLTextAreaElement)
    .value.trim();

  if (!/^\s*(SELECT|WITH|DESCRIBE|SHOW|EXPLAIN)\b/i.test(sql)) {
    errorEl.hidden = false;
    errorEl.textContent =
      "演示模式仅支持 SELECT / WITH / DESCRIBE / SHOW / EXPLAIN";
    return;
  }

  try {
    if (cachedSourceRows.length) {
      await syncRowsToDuckDB(cachedSourceRows);
    }
    const rows = await queryRows(sql);
    renderTable("head-sql", "body-sql", rows);
    setStatus(`查询完成，返回 ${rows.length.toLocaleString("zh-CN")} 行`);
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = err instanceof Error ? err.message : String(err);
  }
}

function bindUi(): void {
  const dropzone = document.getElementById("dropzone")!;
  const fileInput = document.getElementById("file-input") as HTMLInputElement;

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void handleFile(file);
    fileInput.value = "";
  });

  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("is-dragover");
  });
  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("is-dragover");
  });
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragover");
    const file = event.dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  });

  document.getElementById("sample-btn")!.addEventListener("click", () => {
    void loadSampleFile("/data/sales.csv", "sales.csv", "正在加载示例销售数据…");
  });
  document.getElementById("sample-amazon-btn")!.addEventListener("click", () => {
    void loadSampleFile(
      "/data/amazon_search_terms.xlsx",
      "amazon_search_terms.xlsx",
      "正在加载亚马逊搜索词报告…",
    );
  });
  document.getElementById("reset-btn")!.addEventListener("click", () => {
    excelState = null;
    cachedSourceRows = [];
    previewRows = [];
    previewColumns = [];
    previewPage = 1;
    amazonResultRows = [];
    amazonResultColumns = [];
    amazonPage = 1;
    amazonMode = false;
    updateSheetPicker([], "");
    setAmazonMode(false);
    showWorkspace(false);
    const previewMount = document.getElementById("preview-result-mount");
    if (previewMount) {
      previewMount.innerHTML =
        `<p class="view-note">上传数据后在这里分页预览</p>`;
    }
    setStatus("请上传文件，或试用示例数据");
  });

  document.getElementById("sheet-select")!.addEventListener("change", (event) => {
    const sheetName = (event.target as HTMLSelectElement).value;
    void switchExcelSheet(sheetName);
  });

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const view = (tab as HTMLElement).dataset.view ?? "preview";
      if ((tab as HTMLElement).hidden) return;
      switchView(view);
    });
  });

  document.getElementById("sql-form")!.addEventListener("submit", (event) => {
    void runSql(event);
  });
  document.getElementById("ai-generate-btn")!.addEventListener("click", () => {
    void generateAiSql();
  });

  const aiHint = document.getElementById("ai-hint");
  if (aiHint) {
    aiHint.textContent = isAiConfigured()
      ? "生成后可再编辑，再点「运行查询」"
      : "未检测到 OPENAI_API_KEY（检查 .env 并重启服务）";
  }

  renderAmazonCards();
}

async function main(): Promise<void> {
  bindUi();
  showWorkspace(false);
  setAmazonMode(false);
  document.body.dataset.build = BUILD_ID;

  // 立刻允许上传：预览/亚马逊分析不依赖 Wasm
  appReady = true;
  setStatus(
    isMobileBrowser()
      ? "可直接上传分析（DuckDB 在后台加载，手机可能较慢）"
      : "可直接上传分析；DuckDB 正在后台加载（SQL 面板需要）",
  );

  try {
    await initDuckDB();
    setStatus(
      `全部就绪。可上传 Excel / 试用亚马逊报告；SQL 面板已可用（${BUILD_ID}）`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    duckdbInitError = message;
    duckdbReady = false;
    setStatus(
      `上传/预览/亚马逊分析可用；DuckDB(SQL) 加载失败：${message}`,
      true,
    );
    console.error(err);
  }
}

void main();
