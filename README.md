# DuckDB-Wasm 数据分析

纯浏览器数据分析小工具：上传 Excel / CSV / Parquet / JSON，在本地用 DuckDB-Wasm 预览并执行 SQL。

## 环境

- Node.js 18+

## 安装

```bash
npm install
```

## 启动

```bash
npm start
```

浏览器打开 [http://localhost:3000](http://localhost:3000)

## 使用

1. 等待引擎就绪
2. 拖拽或选择数据文件（可用「试用亚马逊搜索词报告」一键加载）
3. Excel 若有多个工作表，可在右上角切换
4. 若识别为亚马逊搜索词报告，自动打开「亚马逊运营分析」：
   - 搜索词汇总（点击量 / 花费 / 订单 / CPC / CVR / CPA）
   - 每日趋势
   - 日环比浮动
   - 按周趋势
   - 波动最大搜索词
5. 也可在 SQL 面板对表 `data` 自定义查询

时间字段会显示为「2026年09月01日（周一）」这类可读格式。

文件只在浏览器内处理，不会上传到服务器。Excel 会先在浏览器解析，再导入 DuckDB。

## 项目结构

```
duckdb/
├── index.html
├── public/data/sales.csv   # 可选示例数据
├── src/
│   ├── main.ts
│   └── styles.css
├── package.json
└── vite.config.ts
```
