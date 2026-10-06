// Persistence layer: sql.js (SQLite compiled to WASM, no native build).
// State is loaded from data/woodwork.db on startup and flushed after every write.
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DB_FILE = path.join(__dirname, '..', 'data', 'woodwork.db');

let db;
let dirty = false;

const SCHEMA = `
PRAGMA foreign_keys = ON;

-- 材料目录（公开信息）
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'm2',
  unit_price REAL NOT NULL,
  max_span_mm INTEGER NOT NULL,
  stock_width_mm INTEGER NOT NULL,
  stock_length_mm INTEGER NOT NULL,
  lead_days INTEGER NOT NULL DEFAULT 7,
  density TEXT,
  origin TEXT,
  care_note TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- 私人信息：永不进入公开案例
  customer_name TEXT,
  budget REAL,            -- 私人预算
  address TEXT,           -- 私人地址
  note TEXT
);

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  rev_no INTEGER NOT NULL,
  spec_json TEXT NOT NULL,            -- 规范化后的输入（mm）
  derived_json TEXT NOT NULL,         -- 派生计算结果快照
  bom_json TEXT NOT NULL,
  quote_json TEXT NOT NULL,           -- 报价/交期/保养（批准后才视为绑定）
  issues_json TEXT NOT NULL,
  status TEXT NOT NULL,               -- draft|pending_review|approved|rejected|changes_requested|confirmed|superseded
  locked_by TEXT,
  locked_at TEXT,
  superseded_by TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, rev_no)
);

-- 双方对某版本的批准 / 确认记录
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  role TEXT NOT NULL,                 -- shop | customer
  kind TEXT NOT NULL,                 -- approve | confirm
  comment TEXT,
  signed_at TEXT NOT NULL
);

-- 人工图纸审批（混合流程中不可参数化的部分）
CREATE TABLE IF NOT EXISTS drawing_reviews (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  drawing_no TEXT,
  reviewer TEXT,
  decision TEXT,                      -- pass | hold
  note TEXT,
  reviewed_at TEXT
);

-- 修订记录：批准后的尺寸/材料修改
CREATE TABLE IF NOT EXISTS amendments (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  old_json TEXT NOT NULL,
  new_json TEXT NOT NULL,
  changes_json TEXT NOT NULL,         -- 变更字段及受影响项
  reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

-- 材料替代记录
CREATE TABLE IF NOT EXISTS substitutions (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  original_material TEXT NOT NULL,
  substitute_material TEXT NOT NULL,
  requester TEXT,
  status TEXT NOT NULL,               -- proposed | accepted | rejected
  note TEXT,
  created_at TEXT NOT NULL
);

-- 工单
CREATE TABLE IF NOT EXISTS work_orders (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,               -- started | cancelled | done
  started_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT
);

-- 撤销请求（工单已启动后撤销需人工评估）
CREATE TABLE IF NOT EXISTS cancellation_requests (
  id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL REFERENCES work_orders(id),
  requester TEXT,
  reason TEXT,
  decision TEXT,                      -- pending | granted | denied
  assessed_cost REAL,
  assessed_at TEXT,
  created_at TEXT NOT NULL
);

-- 附件（人工图纸 / 工艺图 / 补充文件）
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  kind TEXT NOT NULL,                 -- drawing | care | other
  filename TEXT NOT NULL,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL,          -- 服务端接收时间
  arrived_after TEXT,                 -- 若晚到：锁定/批准/交付时间点
  late_reason TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT
);

-- 发布授权（单独快照，客户逐项授权，与主项目隔离）
CREATE TABLE IF NOT EXISTS publications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  authorization_text TEXT NOT NULL,
  authorized_by TEXT NOT NULL,
  authorized_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,        -- 授权时的公开快照（剥离私人字段）
  status TEXT NOT NULL,               -- authorized | revoked
  revoked_at TEXT
);

-- 交付包：可追溯到实际采用的图纸与说明
CREATE TABLE IF NOT EXISTS delivery_packages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0
);

-- 审计日志
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_rev_project ON revisions(project_id);
CREATE INDEX IF NOT EXISTS idx_attach_rev ON attachments(revision_id);
`;

async function init() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    const buf = fs.readFileSync(DB_FILE);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  db.run(SCHEMA);
  flush();
  return { run, get, all, flush };
}

function run(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.run(params);
  stmt.free();
  dirty = true;
  flush();
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

function all(sql, params = []) {
  const rows = [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

let flushTimer = null;
function flush() {
  if (!db) return;
  // 同步写入（教学项目数据量小）
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    if (!dirty) return;
    const data = db.export();
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, Buffer.from(data));
    dirty = false;
  }, 10);
}

module.exports = { init, run, get, all, flush };
