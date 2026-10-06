# -*- coding: utf-8 -*-
"""API 层：dispatch(method, path, body) -> (status, obj)。不依赖第三方框架。"""
from __future__ import annotations
import hashlib, json, re, threading, time

import engine, store

# ---------- 工具 ----------

def _hash(obj):
    s = json.dumps(obj, sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(s.encode()).hexdigest()[:12]

def _err(status, code, message, **extra):
    obj = {"error": {"code": code, "message": message}}
    obj.update(extra)
    return status, obj

def _parse_dims(raw_inputs, units, base=None):
    """解析基础参数（支持 mm/cm/in 混填）。返回 (inputs_mm, echo, errors)。"""
    out, echo, errs = {}, {}, []
    base = base or {}
    for k, default in engine.BASE_DEFAULTS.items():
        raw = (raw_inputs or {}).get(k)
        if raw is None or raw == "":
            if k in base:
                out[k] = base[k]
            else:
                out[k] = default
                echo[k] = f"{default}mm(默认)"
            continue
        if k in engine.INT_PARAMS:
            try:
                f = float(str(raw).strip())
                if f != int(f) or f < 0:
                    raise ValueError
                out[k] = int(f)
                echo[k] = str(int(f))
            except ValueError:
                errs.append(f"「{engine.LABELS[k]}」需为非负整数: {raw!r}")
        else:
            try:
                out[k], echo[k] = engine.parse_dimension(raw, (units or {}).get(k, "mm"))
            except engine.UnitError as ex:
                errs.append(str(ex))
    return out, echo, errs

def _parse_locks(raw_locks, units):
    out, echo, errs = {}, {}, []
    for k, raw in (raw_locks or {}).items():
        if k not in engine.LOCKABLE:
            errs.append(f"「{k}」不是可锁定的派生尺寸（可锁定: {', '.join(sorted(engine.LOCKABLE))}）")
            continue
        if raw is None or raw == "":
            continue
        try:
            out[k], echo[k] = engine.parse_dimension(raw, (units or {}).get(k, "mm"))
        except engine.UnitError as ex:
            errs.append(str(ex))
    return out, echo, errs

def _rev_public(rev, with_solved=True):
    r = {"id": rev["id"], "design_id": rev["design_id"], "version": rev["version"],
         "actor": rev["actor"], "status": rev["status"], "material_id": rev["material_id"],
         "param_hash": rev["param_hash"], "created_at": rev["created_at"],
         "inputs": json.loads(rev["inputs_json"]), "locks": json.loads(rev["locks_json"]),
         "echo": json.loads(rev["echo_json"]), "locks_echo": json.loads(rev["locks_echo_json"]),
         "manual_drawing_by": rev["manual_drawing_by"]}
    if with_solved:
        r["solved"] = json.loads(rev["solved_json"])
    return r

def _conf_public(c):
    return {"id": c["id"], "revision_id": c["revision_id"], "quote_cents": c["quote_cents"],
            "lead_time_days": c["lead_time_days"], "care_text": c["care_text"],
            "status": c["status"], "invalid_reason": c["invalid_reason"],
            "created_at": c["created_at"], "accepted_at": c["accepted_at"]}

# ---------- 影响分析 ----------

def _bom_of(revision_id):
    return store.all("SELECT * FROM bom_lines WHERE revision_id=? ORDER BY seq", (revision_id,))

def _bom_diff(old_rev, new_rev):
    old = {l["name"]: l for l in _bom_of(old_rev)}
    new = {l["name"]: l for l in _bom_of(new_rev)}
    diff = []
    for name in sorted(set(old) | set(new)):
        o, n = old.get(name), new.get(name)
        if o is None:
            diff.append({"item": name, "change": "新增", "after": _line(n)})
        elif n is None:
            diff.append({"item": name, "change": "移除", "before": _line(o)})
        elif (o["qty"], o["w_mm"], o["h_mm"], o["material_id"]) != (n["qty"], n["w_mm"], n["h_mm"], n["material_id"]):
            diff.append({"item": name, "change": "尺寸/数量/材料变化",
                         "before": _line(o), "after": _line(n)})
    return diff

def _line(l):
    return {"qty": l["qty"], "w_mm": l["w_mm"], "h_mm": l["h_mm"], "material_id": l["material_id"]}

def _impact(design_id):
    revs = store.all("SELECT * FROM revisions WHERE design_id=? ORDER BY version DESC", (design_id,))
    latest = revs[0] if revs else None
    latest_approved = next((r for r in revs if r["status"] == "approved"), None)
    invalidated = [_conf_public(c) for c in store.all(
        "SELECT * FROM confirmations WHERE design_id=? AND status='invalidated'", (design_id,))]
    needs_review, affected = [], []

    for c in store.all("SELECT * FROM confirmations WHERE design_id=? AND status='accepted'", (design_id,)):
        if latest and c["revision_id"] != latest["id"]:
            needs_review.append({"type": "已接受确认单", "id": c["id"],
                "reason": f"客户改尺寸后产生 v{latest['version']}，该确认单绑定旧版本，报价/交期/保养说明需重审"})
    for w in store.all("SELECT * FROM work_orders WHERE design_id=? AND status IN ('scheduled','in_progress')", (design_id,)):
        snap = json.loads(w["quote_snapshot_json"])
        if latest and snap.get("revision_id") != latest["id"]:
            needs_review.append({"type": "进行中的工单", "id": w["id"],
                "reason": "工单已启动而设计已变更，系统不自动改单，需人工决定继续/暂停/撤销"})
        affected.append({"type": "工单", "id": w["id"], "status": w["status"]})
    for s in store.all("SELECT * FROM substitutions WHERE design_id=? AND status='pending_review'", (design_id,)):
        needs_review.append({"type": "材料替代", "id": s["id"],
            "reason": f"{s['from_material']} → {s['to_material']} 待人工复核"})
    stale = store.all("""SELECT a.* FROM attachments a JOIN revisions r ON r.id=a.revision_id
                         WHERE r.design_id=? AND a.status IN ('pending','stale')""", (design_id,))
    for a in stale:
        affected.append({"type": "附件", "id": a["id"], "kind": a["kind"], "status": a["status"],
                         "reason": "附件生成晚到或其版本已被取代"})
    bom_changes = []
    if latest and latest_approved and latest["id"] != latest_approved["id"]:
        bom_changes = _bom_diff(latest_approved["id"], latest["id"])
    return {"design_id": design_id,
            "latest_version": latest["version"] if latest else None,
            "invalidated_confirmations": invalidated,
            "needs_rereview": needs_review,
            "bom_changes": bom_changes,
            "affected_items": affected}

# ---------- 修订创建（含并发控制与失效传播） ----------

def _insert_revision(design, actor, inputs, echo, locks, locks_echo, expect_base):
    design_id = design["id"]
    row = store.one("SELECT MAX(version) v FROM revisions WHERE design_id=?", (design_id,))
    latest_v = row["v"] or 0
    if expect_base is not None and expect_base != latest_v:
        cur = store.one("SELECT * FROM revisions WHERE design_id=? AND version=?", (design_id, latest_v))
        return _err(409, "CONCURRENT_MODIFICATION",
            "双方同时改稿：服务器上已有更新的版本，你的修改基于过期版本。请查看服务器当前值并合并后重试。",
            server_version=latest_v, your_base_version=expect_base,
            server_inputs=json.loads(cur["inputs_json"]) if cur else {},
            server_locks=json.loads(cur["locks_json"]) if cur else {})
    material_id = design["material_id"]
    solved = engine.compute_all(inputs, locks, material_id)
    param_hash = _hash({k: v["mm"] for k, v in solved["values"].items()})
    version = latest_v + 1
    status = "submitted" if actor == "customer" else "draft"
    c = store.conn()
    cur = c.execute(
        """INSERT INTO revisions(design_id,version,actor,inputs_json,echo_json,locks_json,
           locks_echo_json,solved_json,material_id,param_hash,status,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
        (design_id, version, actor, json.dumps(inputs), json.dumps(echo, ensure_ascii=False),
         json.dumps(locks), json.dumps(locks_echo, ensure_ascii=False),
         json.dumps(solved, ensure_ascii=False), material_id, param_hash, status, store.now()))
    rid = cur.lastrowid
    c.execute("UPDATE revisions SET status='superseded' WHERE design_id=? AND id!=? AND status!='approved'",
              (design_id, rid))
    c.execute("UPDATE revisions SET status='superseded' WHERE design_id=? AND id!=? AND status='approved'",
              (design_id, rid))
    for l in solved["bom"]:
        c.execute("""INSERT INTO bom_lines(revision_id,seq,name,qty,w_mm,h_mm,material_id,area_m2,edge_m,flags)
                     VALUES(?,?,?,?,?,?,?,?,?,?)""",
                  (rid, l["seq"], l["name"], l["qty"], l["w_mm"], l["h_mm"],
                   l["material_id"], l["area_m2"], l["edge_m"], json.dumps(l["flags"], ensure_ascii=False)))
    # 旧确认失效（仅未接受的自动失效；已接受的保留并标记需重审）
    inv = c.execute("SELECT id FROM confirmations WHERE design_id=? AND status='active'", (design_id,)).fetchall()
    for row in inv:
        c.execute("UPDATE confirmations SET status='invalidated', invalid_reason=? WHERE id=?",
                  (f"新修订 v{version} 已创建，旧确认（报价/交期/保养）随之失效", row["id"]))
    c.commit(); c.close()
    store.log_event(design_id, "REVISION_CREATED",
                    {"revision_id": rid, "version": version, "actor": actor,
                     "invalidated_confirmations": [r["id"] for r in inv]})
    rev = store.one("SELECT * FROM revisions WHERE id=?", (rid,))
    return 201, {"revision": _rev_public(rev), "impact": _impact(design_id)}

# ---------- 路由处理 ----------

def catalog(method, body, q):
    return 200, {
        "materials": [{"id": k, **v} for k, v in engine.MATERIALS.items()],
        "base_params": [{"name": k, "label": engine.LABELS[k], "default": v,
                         "kind": ("int" if k in engine.INT_PARAMS else "dim")}
                        for k, v in engine.BASE_DEFAULTS.items()],
        "lockable_derived": [{"name": k, "label": engine.LABELS[k]} for k in sorted(engine.LOCKABLE)],
        "units": ["mm", "cm", "in"],
        "safety_policy": "系统只做参数化尺寸链/BOM/报价估算；不自动生成锯切路径、刀具轨迹等危险加工操作，危险工序须经人工图纸审批后由匠人制定。",
        "hybrid_flow": ["参数化自动核算：尺寸链、材料清单、报价与交期估算、保养说明模板",
                        "人工环节：图纸审批、危险加工工序、异形/雕刻工艺、最终工艺确认"]}

def create_design(method, body, q):
    material_id = body.get("material_id", "oak18")
    if material_id not in engine.MATERIALS or material_id == "back5":
        return _err(422, "BAD_MATERIAL", f"未知主材: {material_id}")
    inputs, echo, errs = _parse_dims(body.get("inputs"), body.get("units"))
    locks, locks_echo, lerrs = _parse_locks(body.get("locks"), body.get("units"))
    if errs or lerrs:
        return _err(422, "PARSE_ERROR", "; ".join(errs + lerrs))
    budget = body.get("budget_cny")
    c = store.conn()
    cur = c.execute(
        """INSERT INTO designs(title,customer_name,contact,address,budget_cents,product_type,
           material_id,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?)""",
        (body.get("title", "未命名定制"), body.get("customer_name", ""), body.get("contact", ""),
         body.get("address", ""), int(round(float(budget) * 100)) if budget not in (None, "") else None,
         body.get("product_type", "wall_cabinet"), material_id, body.get("notes", ""), store.now()))
    did = cur.lastrowid; c.commit(); c.close()
    store.log_event(did, "DESIGN_CREATED", {"title": body.get("title")})
    design = store.one("SELECT * FROM designs WHERE id=?", (did,))
    return _insert_revision(design, "customer", inputs, echo, locks, locks_echo, expect_base=None)

def get_design(method, body, q, design_id):
    d = store.one("SELECT * FROM designs WHERE id=?", (design_id,))
    if not d:
        return _err(404, "NOT_FOUND", "设计不存在")
    revs = [_rev_public(r, with_solved=False) for r in
            store.all("SELECT * FROM revisions WHERE design_id=? ORDER BY version DESC", (design_id,))]
    confs = [_conf_public(c) for c in
             store.all("SELECT * FROM confirmations WHERE design_id=? ORDER BY id DESC", (design_id,))]
    wos = store.all("SELECT * FROM work_orders WHERE design_id=? ORDER BY id DESC", (design_id,))
    subs = store.all("SELECT * FROM substitutions WHERE design_id=? ORDER BY id DESC", (design_id,))
    atts = store.all("""SELECT a.* FROM attachments a JOIN revisions r ON r.id=a.revision_id
                        WHERE r.design_id=? ORDER BY a.id DESC""", (design_id,))
    evs = store.all("SELECT * FROM events WHERE design_id=? ORDER BY id DESC LIMIT 50", (design_id,))
    return 200, {"design": d, "revisions": revs, "confirmations": confs,
                 "work_orders": [{**w, "quote_snapshot": json.loads(w["quote_snapshot_json"])} for w in wos],
                 "substitutions": [{**s, "impact": json.loads(s["impact_json"])} for s in subs],
                 "attachments": atts,
                 "events": [{**e, "payload": json.loads(e["payload_json"])} for e in evs],
                 "impact": _impact(design_id)}

def create_revision(method, body, q, design_id):
    d = store.one("SELECT * FROM designs WHERE id=?", (design_id,))
    if not d:
        return _err(404, "NOT_FOUND", "设计不存在")
    latest = store.one("SELECT * FROM revisions WHERE design_id=? ORDER BY version DESC LIMIT 1", (design_id,))
    base_inputs = json.loads(latest["inputs_json"]) if latest else {}
    base_locks = json.loads(latest["locks_json"]) if latest else {}
    inputs, echo, errs = _parse_dims(body.get("inputs"), body.get("units"), base=base_inputs)
    # 锁定：未提供的沿用上一版
    locks, locks_echo, lerrs = _parse_locks(body.get("locks"), body.get("units"))
    for k, v in base_locks.items():
        locks.setdefault(k, v)
    for k in list(locks):
        if (body.get("locks") or {}).get(k) == "":
            locks.pop(k)  # 显式清空锁定
    if errs or lerrs:
        return _err(422, "PARSE_ERROR", "; ".join(errs + lerrs))
    return _insert_revision(d, body.get("actor", "customer"), inputs, echo, locks, locks_echo,
                            expect_base=body.get("base_version"))

def compute_revision(method, body, q, revision_id):
    rev = store.one("SELECT * FROM revisions WHERE id=?", (revision_id,))
    if not rev:
        return _err(404, "NOT_FOUND", "修订不存在")
    design = store.one("SELECT * FROM designs WHERE id=?", (rev["design_id"],))
    base_inputs = json.loads(rev["inputs_json"])
    base_locks = json.loads(rev["locks_json"])
    inputs, _, errs = _parse_dims(body.get("inputs"), body.get("units"), base=base_inputs)
    locks, _, lerrs = _parse_locks(body.get("locks"), body.get("units"))
    for k, v in base_locks.items():
        locks.setdefault(k, v)
    if errs or lerrs:
        return _err(422, "PARSE_ERROR", "; ".join(errs + lerrs))
    return 200, engine.compute_all(inputs, locks, design["material_id"])

def submit_revision(method, body, q, revision_id):
    rev = store.one("SELECT * FROM revisions WHERE id=?", (revision_id,))
    if not rev:
        return _err(404, "NOT_FOUND", "修订不存在")
    c = store.conn()
    c.execute("UPDATE revisions SET status='submitted' WHERE id=?", (revision_id,))
    c.commit(); c.close()
    store.log_event(rev["design_id"], "REVISION_SUBMITTED", {"revision_id": revision_id})
    return 200, {"ok": True}

def approve_revision(method, body, q, revision_id):
    rev = store.one("SELECT * FROM revisions WHERE id=?", (revision_id,))
    if not rev:
        return _err(404, "NOT_FOUND", "修订不存在")
    solved = json.loads(rev["solved_json"])
    errors = [d for d in solved["diagnostics"] if d["severity"] == "error"]
    if errors:
        return _err(422, "UNRESOLVED_DIAGNOSTICS",
                    "存在未解决的尺寸矛盾，不能审批。请先处理诊断。",
                    diagnostics=errors)
    bom = _bom_of(revision_id)
    manual_flags = sorted({f for l in bom for f in json.loads(l["flags"])})
    manual_by = body.get("manual_drawing_by")
    if manual_flags and not manual_by:
        return _err(422, "MANUAL_DRAWING_REQUIRED",
                    "该设计包含需人工图纸审批的项目（如危险加工/五金定位），系统不自动放行。",
                    manual_review_items=manual_flags)
    quote = solved["quote"]
    c = store.conn()
    c.execute("UPDATE revisions SET status='approved', manual_drawing_by=?, manual_drawing_at=? WHERE id=?",
              (manual_by, store.now(), revision_id))
    cur = c.execute(
        """INSERT INTO confirmations(design_id,revision_id,quote_cents,lead_time_days,care_text,status,created_at)
           VALUES(?,?,?,?,?,'active',?)""",
        (rev["design_id"], revision_id, quote["quote_cents"], quote["lead_time_days"],
         quote["care_text"], store.now()))
    cid = cur.lastrowid
    c.commit(); c.close()
    store.log_event(rev["design_id"], "REVISION_APPROVED",
                    {"revision_id": revision_id, "approver": body.get("approver", "maker"),
                     "manual_drawing_by": manual_by, "confirmation_id": cid})
    conf = store.one("SELECT * FROM confirmations WHERE id=?", (cid,))
    return 200, {"confirmation": _conf_public(conf)}

def get_bom(method, body, q, revision_id):
    rev = store.one("SELECT * FROM revisions WHERE id=?", (revision_id,))
    if not rev:
        return _err(404, "NOT_FOUND", "修订不存在")
    lines = [{**l, "flags": json.loads(l["flags"])} for l in _bom_of(revision_id)]
    return 200, {"revision_id": revision_id, "param_hash": rev["param_hash"], "bom": lines,
                 "quote": json.loads(rev["solved_json"])["quote"]}

def accept_confirmation(method, body, q, cid):
    conf = store.one("SELECT * FROM confirmations WHERE id=?", (cid,))
    if not conf:
        return _err(404, "NOT_FOUND", "确认单不存在")
    if conf["status"] != "active":
        return _err(409, "NOT_ACTIVE", f"确认单状态为 {conf['status']}，不能接受（可能已因改尺寸而失效）。")
    c = store.conn()
    c.execute("UPDATE confirmations SET status='accepted', accepted_at=? WHERE id=?", (store.now(), cid))
    c.commit(); c.close()
    store.log_event(conf["design_id"], "CONFIRMATION_ACCEPTED", {"confirmation_id": cid})
    return 200, {"ok": True}

def start_work_order(method, body, q, cid):
    conf = store.one("SELECT * FROM confirmations WHERE id=?", (cid,))
    if not conf:
        return _err(404, "NOT_FOUND", "确认单不存在")
    if conf["status"] != "accepted":
        return _err(409, "NOT_ACCEPTED", "仅已接受的确认单可开工。")
    dup = store.one("SELECT id FROM work_orders WHERE confirmation_id=? AND status IN ('scheduled','in_progress')", (cid,))
    if dup:
        return _err(409, "WO_EXISTS", "该确认单已有进行中的工单。")
    rev = store.one("SELECT * FROM revisions WHERE id=?", (conf["revision_id"],))
    snap = {"confirmation_id": cid, "revision_id": conf["revision_id"],
            "version": rev["version"], "param_hash": rev["param_hash"],
            "quote_cents": conf["quote_cents"], "lead_time_days": conf["lead_time_days"],
            "care_text": conf["care_text"]}
    c = store.conn()
    cur = c.execute("""INSERT INTO work_orders(confirmation_id,design_id,status,started_at,quote_snapshot_json)
                       VALUES(?,?, 'in_progress', ?, ?)""",
                    (cid, conf["design_id"], store.now(), json.dumps(snap, ensure_ascii=False)))
    wid = cur.lastrowid; c.commit(); c.close()
    store.log_event(conf["design_id"], "WORK_ORDER_STARTED", {"work_order_id": wid, "confirmation_id": cid})
    return 201, {"work_order_id": wid, "snapshot": snap}

def cancel_work_order(method, body, q, wid):
    w = store.one("SELECT * FROM work_orders WHERE id=?", (wid,))
    if not w:
        return _err(404, "NOT_FOUND", "工单不存在")
    if w["status"] not in ("scheduled", "in_progress"):
        return _err(409, "NOT_CANCELLABLE", f"工单状态 {w['status']} 不可撤销。")
    reason = body.get("reason", "未填写原因")
    c = store.conn()
    c.execute("UPDATE work_orders SET status='cancelled', cancelled_at=?, cancel_reason=? WHERE id=?",
              (store.now(), reason, wid))
    c.commit(); c.close()
    store.log_event(w["design_id"], "WORK_ORDER_CANCELLED",
                    {"work_order_id": wid, "reason": reason,
                     "was": w["status"], "materials_released": True,
                     "note": "报价快照保留用于对账，不随撤销删除"})
    return 200, {"ok": True, "materials_released": True,
                 "note": "已启动工单被撤销：占用材料释放，报价快照保留审计。"}

def substitute(method, body, q, revision_id):
    rev = store.one("SELECT * FROM revisions WHERE id=?", (revision_id,))
    if not rev:
        return _err(404, "NOT_FOUND", "修订不存在")
    to = body.get("to_material")
    if to not in engine.MATERIALS or to == "back5":
        return _err(422, "BAD_MATERIAL", f"未知替代材料: {to}")
    design = store.one("SELECT * FROM designs WHERE id=?", (rev["design_id"],))
    old_mat = design["material_id"]
    if to == old_mat:
        return _err(422, "NO_OP", "替代材料与当前材料相同。")
    old_quote = json.loads(rev["solved_json"])["quote"]["quote_cents"]
    # 替代 => 生成新修订：材料与板厚联动，其余输入沿用
    inputs = json.loads(rev["inputs_json"])
    inputs["panel_thickness"] = float(engine.MATERIALS[to]["thickness_mm"])
    locks = json.loads(rev["locks_json"])
    c = store.conn()
    c.execute("UPDATE designs SET material_id=? WHERE id=?", (to, design["id"]))
    c.commit(); c.close()
    design = store.one("SELECT * FROM designs WHERE id=?", (design["id"],))
    status, obj = _insert_revision(design, body.get("actor", "maker"), inputs,
                                   {}, locks, {}, expect_base=None)
    if status != 201:
        return status, obj
    new_rev = obj["revision"]
    new_quote = new_rev["solved"]["quote"]["quote_cents"]
    impact = {"thickness_changed": engine.MATERIALS[old_mat]["thickness_mm"] != engine.MATERIALS[to]["thickness_mm"],
              "price_delta_cents": new_quote - old_quote,
              "invalidated_confirmations": [c_["id"] for c_ in obj["impact"]["invalidated_confirmations"]],
              "new_diagnostics": [d for d in new_rev["solved"]["diagnostics"] if d["severity"] == "error"]}
    c = store.conn()
    cur = c.execute("""INSERT INTO substitutions(design_id,revision_id,from_material,to_material,impact_json,created_at)
                       VALUES(?,?,?,?,?,?)""",
                    (design["id"], new_rev["id"], old_mat, to,
                     json.dumps(impact, ensure_ascii=False), store.now()))
    sid = cur.lastrowid; c.commit(); c.close()
    store.log_event(design["id"], "MATERIAL_SUBSTITUTED",
                    {"substitution_id": sid, "from": old_mat, "to": to, "revision_id": new_rev["id"]})
    return 201, {"substitution_id": sid, "new_revision": new_rev, "impact": impact,
                 "needs_rereview": True}

def request_attachment(method, body, q, revision_id):
    rev = store.one("SELECT * FROM revisions WHERE id=?", (revision_id,))
    if not rev:
        return _err(404, "NOT_FOUND", "修订不存在")
    kind = body.get("kind", "drawing_pdf")
    if kind not in ("drawing_pdf", "cutlist_csv", "care_card_pdf"):
        return _err(422, "BAD_KIND", "附件类型须为 drawing_pdf|cutlist_csv|care_card_pdf")
    delay_ms = int(body.get("delay_ms", 0))
    c = store.conn()
    cur = c.execute("INSERT INTO attachments(revision_id,kind,filename,status,created_at) VALUES(?,?,?,?,?)",
                    (revision_id, kind, f"{kind}_r{revision_id}.{ 'csv' if kind.endswith('csv') else 'pdf'}",
                     "pending", store.now()))
    aid = cur.lastrowid; c.commit(); c.close()

    def _generate():
        if delay_ms:
            time.sleep(delay_ms / 1000.0)
        r = store.one("SELECT * FROM revisions WHERE id=?", (revision_id,))
        newer = store.one("SELECT id FROM revisions WHERE design_id=? AND version>?",
                          (r["design_id"], r["version"]))
        # 晚到判定：生成时该修订已被更新版本取代 -> 陈旧
        stale = newer is not None
        sha = hashlib.sha1(f"{kind}:{revision_id}:{store.now()}".encode()).hexdigest()[:10]
        c2 = store.conn()
        c2.execute("UPDATE attachments SET status=?, sha=?, generated_at=? WHERE id=?",
                   ("stale" if stale else "generated", sha, store.now(), aid))
        c2.commit(); c2.close()
        store.log_event(r["design_id"], "ATTACHMENT_GENERATED",
                        {"attachment_id": aid, "revision_id": revision_id,
                         "stale": stale, "reason": "附件生成晚到，版本已被取代" if stale else None})
    threading.Thread(target=_generate, daemon=True).start()
    return 202, {"attachment_id": aid, "status": "pending",
                 "note": f"附件异步生成中（模拟延迟 {delay_ms}ms）"}

def toolpath(method, body, q, revision_id):
    return _err(403, "SAFETY_POLICY",
                "系统不自动生成危险加工操作（锯切路径、刀具轨迹、进给参数）。"
                "危险工序须由匠人在人工图纸审批后另行制定。")

def delivery_package(method, body, q, revision_id):
    rev = store.one("SELECT * FROM revisions WHERE id=?", (revision_id,))
    if not rev:
        return _err(404, "NOT_FOUND", "修订不存在")
    solved = json.loads(rev["solved_json"])
    conf = store.one("""SELECT * FROM confirmations WHERE revision_id=?
                        ORDER BY id DESC LIMIT 1""", (revision_id,))
    atts = store.all("SELECT * FROM attachments WHERE revision_id=?", (revision_id,))
    usable = [a for a in atts if a["status"] == "generated"]
    excluded = [{"id": a["id"], "kind": a["kind"], "status": a["status"],
                 "reason": ("附件生成晚到，所属版本已被取代，不进入交付包" if a["status"] == "stale"
                            else "附件尚未生成完成")} for a in atts if a["status"] != "generated"]
    evs = store.all("SELECT type,created_at FROM events WHERE design_id=? ORDER BY id", (rev["design_id"],))
    return 200, {
        "revision_id": revision_id, "version": rev["version"], "param_hash": rev["param_hash"],
        "manual_drawing_by": rev["manual_drawing_by"],
        "dimensions": {k: v["display"] for k, v in solved["values"].items()},
        "derived_explanations": {k: v["formula"] for k, v in solved["derived"].items()},
        "bom": [{**l, "flags": json.loads(l["flags"])} for l in _bom_of(revision_id)],
        "confirmation": _conf_public(conf) if conf else None,
        "quote_cents": conf["quote_cents"] if conf else solved["quote"]["quote_cents"],
        "lead_time_days": conf["lead_time_days"] if conf else solved["quote"]["lead_time_days"],
        "care_text": conf["care_text"] if conf else solved["quote"]["care_text"],
        "attachments": usable, "excluded_attachments": excluded,
        "trace": {"param_hash": rev["param_hash"], "events": evs},
        "privacy": "交付包不含客户预算与地址。"}

def get_impact(method, body, q, design_id):
    if not store.one("SELECT id FROM designs WHERE id=?", (design_id,)):
        return _err(404, "NOT_FOUND", "设计不存在")
    return 200, _impact(design_id)

def publish_case(method, body, q, design_id):
    d = store.one("SELECT * FROM designs WHERE id=?", (design_id,))
    if not d:
        return _err(404, "NOT_FOUND", "设计不存在")
    rev = store.one("""SELECT r.* FROM revisions r JOIN confirmations c ON c.revision_id=r.id
                       WHERE r.design_id=? AND c.status='accepted'
                       ORDER BY r.version DESC LIMIT 1""", (design_id,))
    if not rev:
        rev = store.one("SELECT * FROM revisions WHERE design_id=? AND status='approved' ORDER BY version DESC LIMIT 1",
                        (design_id,))
    if not rev:
        return _err(422, "NO_APPROVED_REVISION", "尚无获批版本，不能发布公开案例。")
    solved = json.loads(rev["solved_json"])
    snap = {"title": body.get("title", d["title"]),
            "story": body.get("story", ""),
            "product_type": d["product_type"],
            "photos": body.get("photos", []),
            "source": {"revision_version": rev["version"], "param_hash": rev["param_hash"]},
            "published_at": store.now()}
    if body.get("show_material"):
        snap["material"] = engine.MATERIALS[d["material_id"]]["name"]
    if body.get("show_dimensions"):
        snap["dimensions"] = {k: solved["values"][k]["display"]
                              for k in ("outer_width", "outer_height", "outer_depth")}
    # 隐私白名单：预算/地址/姓名/联系方式一律不进入快照
    c = store.conn()
    cur = c.execute("INSERT INTO cases(design_id,snapshot_json,published_at) VALUES(?,?,?)",
                    (design_id, json.dumps(snap, ensure_ascii=False), store.now()))
    cid = cur.lastrowid; c.commit(); c.close()
    store.log_event(design_id, "CASE_PUBLISHED", {"case_id": cid, "revision_version": rev["version"]})
    return 201, {"case_id": cid, "snapshot": snap,
                 "privacy_note": "快照为单独授权副本：不含预算、地址、客户姓名与联系方式；后续设计修改不影响已发布快照。"}

def list_cases(method, body, q):
    rows = store.all("SELECT * FROM cases ORDER BY id DESC")
    return 200, {"cases": [{"id": r["id"], "design_id": r["design_id"],
                            "snapshot": json.loads(r["snapshot_json"])} for r in rows]}

def get_case(method, body, q, case_id):
    r = store.one("SELECT * FROM cases WHERE id=?", (case_id,))
    if not r:
        return _err(404, "NOT_FOUND", "案例不存在")
    return 200, {"id": r["id"], "design_id": r["design_id"], "snapshot": json.loads(r["snapshot_json"])}

ROUTES = [
    ("GET",  r"^/api/catalog$", catalog),
    ("POST", r"^/api/designs$", create_design),
    ("GET",  r"^/api/designs/(\d+)$", get_design),
    ("POST", r"^/api/designs/(\d+)/revisions$", create_revision),
    ("GET",  r"^/api/designs/(\d+)/impact$", get_impact),
    ("POST", r"^/api/designs/(\d+)/publish$", publish_case),
    ("POST", r"^/api/revisions/(\d+)/compute$", compute_revision),
    ("POST", r"^/api/revisions/(\d+)/submit$", submit_revision),
    ("POST", r"^/api/revisions/(\d+)/approve$", approve_revision),
    ("GET",  r"^/api/revisions/(\d+)/bom$", get_bom),
    ("GET",  r"^/api/revisions/(\d+)/delivery_package$", delivery_package),
    ("POST", r"^/api/revisions/(\d+)/substitute$", substitute),
    ("POST", r"^/api/revisions/(\d+)/attachments$", request_attachment),
    ("POST", r"^/api/revisions/(\d+)/toolpath$", toolpath),
    ("POST", r"^/api/confirmations/(\d+)/accept$", accept_confirmation),
    ("POST", r"^/api/confirmations/(\d+)/start_work_order$", start_work_order),
    ("POST", r"^/api/work_orders/(\d+)/cancel$", cancel_work_order),
    ("GET",  r"^/api/cases$", list_cases),
    ("GET",  r"^/api/cases/(\d+)$", get_case),
]

def dispatch(method, path, body=None):
    body = body or {}
    for m, pat, fn in ROUTES:
        if m != method:
            continue
        mm = re.match(pat, path)
        if mm:
            args = [int(g) for g in mm.groups()]
            return fn(method, body, {}, *args)
    return _err(404, "NOT_FOUND", f"无此路由: {method} {path}")
