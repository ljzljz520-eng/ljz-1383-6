# -*- coding: utf-8 -*-
"""SQLite 存储层：设计、修订、确认、BOM、工单、附件、替代、公开案例、事件日志。"""
import json, os, sqlite3
from datetime import datetime, timezone

DB_PATH = os.environ.get("WOODSHOP_DB", os.path.join(os.path.dirname(__file__), "woodshop.db"))

def set_path(p):
    global DB_PATH
    DB_PATH = p

def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    return c

SCHEMA = """
CREATE TABLE IF NOT EXISTS designs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT, customer_name TEXT, contact TEXT,
  address TEXT,                 -- 私密：不进入公开案例
  budget_cents INTEGER,         -- 私密：不进入公开案例
  product_type TEXT, material_id TEXT, notes TEXT,
  status TEXT DEFAULT 'active', created_at TEXT);
CREATE TABLE IF NOT EXISTS revisions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  design_id INTEGER NOT NULL, version INTEGER NOT NULL, actor TEXT,
  inputs_json TEXT, echo_json TEXT, locks_json TEXT, locks_echo_json TEXT,
  solved_json TEXT, material_id TEXT, param_hash TEXT,
  status TEXT DEFAULT 'draft',  -- draft|submitted|approved|superseded|changes_requested
  manual_drawing_by TEXT, manual_drawing_at TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS confirmations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  design_id INTEGER NOT NULL, revision_id INTEGER NOT NULL,
  quote_cents INTEGER, lead_time_days INTEGER, care_text TEXT,
  status TEXT DEFAULT 'active', -- active|accepted|invalidated
  invalid_reason TEXT, created_at TEXT, accepted_at TEXT);
CREATE TABLE IF NOT EXISTS bom_lines(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id INTEGER NOT NULL, seq INTEGER, name TEXT, qty INTEGER,
  w_mm REAL, h_mm REAL, material_id TEXT, area_m2 REAL, edge_m REAL, flags TEXT);
CREATE TABLE IF NOT EXISTS work_orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  confirmation_id INTEGER NOT NULL, design_id INTEGER NOT NULL,
  status TEXT DEFAULT 'scheduled', -- scheduled|in_progress|completed|cancelled
  started_at TEXT, cancelled_at TEXT, cancel_reason TEXT,
  quote_snapshot_json TEXT);
CREATE TABLE IF NOT EXISTS attachments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id INTEGER NOT NULL, kind TEXT, filename TEXT,
  status TEXT DEFAULT 'pending', -- pending|generated|stale
  sha TEXT, generated_at TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS substitutions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  design_id INTEGER NOT NULL, revision_id INTEGER NOT NULL,
  from_material TEXT, to_material TEXT,
  impact_json TEXT, status TEXT DEFAULT 'pending_review', created_at TEXT);
CREATE TABLE IF NOT EXISTS cases(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  design_id INTEGER NOT NULL, snapshot_json TEXT, published_at TEXT);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  design_id INTEGER NOT NULL, type TEXT, payload_json TEXT, created_at TEXT);
"""

def init():
    c = conn()
    c.executescript(SCHEMA)
    c.commit()
    c.close()

def one(q, a=()):
    c = conn(); r = c.execute(q, a).fetchone(); c.close()
    return dict(r) if r else None

def all(q, a=()):
    c = conn(); r = c.execute(q, a).fetchall(); c.close()
    return [dict(x) for x in r]

def log_event(design_id, type_, payload):
    c = conn()
    c.execute("INSERT INTO events(design_id,type,payload_json,created_at) VALUES(?,?,?,?)",
              (design_id, type_, json.dumps(payload, ensure_ascii=False), now()))
    c.commit(); c.close()
