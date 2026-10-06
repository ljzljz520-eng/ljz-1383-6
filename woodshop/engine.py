# -*- coding: utf-8 -*-
"""参数化尺寸引擎：单位解析、可解释依赖计算、超约束诊断、BOM 与报价。

设计原则：
- 所有尺寸内部统一为毫米（mm），输入允许 mm/cm/in 混填并保留原始回显。
- 派生尺寸由依赖式计算，每个结果附带人类可读的算式（可解释）。
- 用户可“锁定”派生尺寸；若锁定值与依赖式矛盾，产生超约束诊断，
  并给出“放松哪个字段、改成多少”的可执行建议（含联动到基础尺寸）。
"""
from __future__ import annotations
import re

TOL_MM = 0.5  # 尺寸一致性容差

MM_PER_UNIT = {"mm": 1.0, "cm": 10.0, "in": 25.4, "inch": 25.4, '"': 25.4,
               "毫米": 1.0, "厘米": 10.0, "英寸": 25.4}

class UnitError(ValueError):
    pass

_NUM_UNIT = re.compile(r'^([0-9]+(?:\.[0-9]+)?)\s*(mm|cm|in|inch|"|毫米|厘米|英寸)?$', re.I)

def parse_dimension(raw, default_unit="mm"):
    """解析混填尺寸 -> (毫米值, 回显串)。接受 500 / 500mm / 50cm / 20in / 20" / 20英寸。"""
    if isinstance(raw, bool):
        raise UnitError(f"无法解析尺寸: {raw!r}")
    if isinstance(raw, (int, float)):
        return float(raw) * MM_PER_UNIT[default_unit], f"{raw}{default_unit}"
    s = str(raw).strip().lower()
    m = _NUM_UNIT.match(s)
    if not m:
        raise UnitError(f"无法解析尺寸: {raw!r}（支持 500 / 500mm / 50cm / 20in / 20\"）")
    num, unit = m.group(1), (m.group(2) or default_unit).lower()
    return float(num) * MM_PER_UNIT[unit], f"{num}{unit}"

def r1(v):
    return None if v is None else round(float(v), 1)

def fmt_mm(v):
    return f"{v:.1f}mm ≈ {v/25.4:.2f}in"

LABELS = {
    "outer_width": "柜体外宽", "outer_height": "柜体外高", "outer_depth": "柜体外深",
    "panel_thickness": "板厚", "door_count": "门数", "door_gap": "门缝",
    "shelf_count": "活动层板数", "shelf_setback": "层板内缩",
    "inner_width": "内宽", "inner_height": "内高",
    "door_width": "门宽", "door_height": "门高",
    "shelf_width": "层板宽", "shelf_depth": "层板深",
}
BASE_DEFAULTS = {"outer_width": 760.0, "outer_height": 900.0, "outer_depth": 350.0,
                 "panel_thickness": 18.0, "door_count": 2, "door_gap": 3.0,
                 "shelf_count": 1, "shelf_setback": 20.0}
INT_PARAMS = {"door_count", "shelf_count"}
LOCKABLE = {"inner_width", "inner_height", "door_width", "door_height",
            "shelf_width", "shelf_depth"}
STANDARD_THICKNESS = {12, 15, 18, 20, 25}

MATERIALS = {
    "oak18":    {"name": "橡木直拼板 18mm", "thickness_mm": 18, "price_m2": 980.0,
                 "care": "避免长时间水浸与阳光暴晒；每 3–6 个月以木蜡油养护；远离暖气直吹。"},
    "walnut18": {"name": "黑胡桃直拼板 18mm", "thickness_mm": 18, "price_m2": 1280.0,
                 "care": "以干布除尘；每 6 个月补充木蜡油；避免碱性清洁剂。"},
    "ply18":    {"name": "桦木多层板 18mm", "thickness_mm": 18, "price_m2": 420.0,
                 "care": "边缘封边处避免磕碰；可用微湿布擦拭后立刻擦干。"},
    "ply20":    {"name": "桦木多层板 20mm", "thickness_mm": 20, "price_m2": 460.0,
                 "care": "边缘封边处避免磕碰；可用微湿布擦拭后立刻擦干。"},
    "back5":    {"name": "杨木胶合背板 5mm", "thickness_mm": 5, "price_m2": 120.0,
                 "care": "避免受潮。"},
}

class Formula:
    def __init__(self, name, deps, fn, explain, inverses=None):
        self.name, self.deps, self.fn, self.explain = name, deps, fn, explain
        self.inverses = inverses or {}

FORMULAS = {
    "inner_width": Formula("inner_width", ["outer_width", "panel_thickness"],
        lambda v: v["outer_width"] - 2 * v["panel_thickness"],
        lambda v, r: f"内宽 = 外宽 − 2×板厚 = {r1(v['outer_width'])} − 2×{r1(v['panel_thickness'])} = {r1(r)} mm",
        {"outer_width": lambda t, v: t + 2 * v["panel_thickness"],
         "panel_thickness": lambda t, v: (v["outer_width"] - t) / 2}),
    "inner_height": Formula("inner_height", ["outer_height", "panel_thickness"],
        lambda v: v["outer_height"] - 2 * v["panel_thickness"],
        lambda v, r: f"内高 = 外高 − 2×板厚 = {r1(v['outer_height'])} − 2×{r1(v['panel_thickness'])} = {r1(r)} mm",
        {"outer_height": lambda t, v: t + 2 * v["panel_thickness"],
         "panel_thickness": lambda t, v: (v["outer_height"] - t) / 2}),
    "door_width": Formula("door_width", ["inner_width", "door_count", "door_gap"],
        lambda v: (v["inner_width"] - (v["door_count"] + 1) * v["door_gap"]) / v["door_count"],
        lambda v, r: (f"门宽 = (内宽 − (门数+1)×门缝) ÷ 门数 = ({r1(v['inner_width'])} − "
                      f"{v['door_count'] + 1}×{r1(v['door_gap'])}) ÷ {v['door_count']} = {r1(r)} mm"),
        {"inner_width": lambda t, v: t * v["door_count"] + (v["door_count"] + 1) * v["door_gap"],
         "door_gap": lambda t, v: (v["inner_width"] - t * v["door_count"]) / (v["door_count"] + 1)}),
    "door_height": Formula("door_height", ["inner_height", "door_gap"],
        lambda v: v["inner_height"] - 2 * v["door_gap"],
        lambda v, r: f"门高 = 内高 − 2×门缝 = {r1(v['inner_height'])} − 2×{r1(v['door_gap'])} = {r1(r)} mm",
        {"inner_height": lambda t, v: t + 2 * v["door_gap"],
         "door_gap": lambda t, v: (v["inner_height"] - t) / 2}),
    "shelf_width": Formula("shelf_width", ["inner_width"],
        lambda v: v["inner_width"],
        lambda v, r: f"层板宽 = 内宽 = {r1(r)} mm",
        {"inner_width": lambda t, v: t}),
    "shelf_depth": Formula("shelf_depth", ["outer_depth", "shelf_setback"],
        lambda v: v["outer_depth"] - v["shelf_setback"],
        lambda v, r: f"层板深 = 外深 − 层板内缩 = {r1(v['outer_depth'])} − {r1(v['shelf_setback'])} = {r1(r)} mm",
        {"outer_depth": lambda t, v: t + v["shelf_setback"],
         "shelf_setback": lambda t, v: v["outer_depth"] - t}),
}
ORDER = ["inner_width", "inner_height", "door_width", "door_height", "shelf_width", "shelf_depth"]
# 派生量 -> 可联动建议的基础量（用于超约束建议的二级联动）
CHAIN = {"inner_width": "outer_width", "inner_height": "outer_height"}

def _diag(severity, code, equation, title, detail, involved, **extra):
    d = {"severity": severity, "code": code, "equation": equation,
         "title": title, "detail": detail, "involved": involved}
    d.update(extra)
    return d

def _over_constrained(f, values, target, computed):
    residual = target - computed
    sug = [{"relax": f.name, "set_mm": r1(computed),
            "action": f"取消对「{LABELS[f.name]}」的锁定，采用计算值 {r1(computed)}mm"}]
    for dep in f.deps:
        inv = f.inverses.get(dep)
        if not inv:
            continue
        need = inv(target, values)
        if need is None or need <= 0:
            continue
        sug.append({"relax": dep, "set_mm": r1(need),
                    "action": f"将「{LABELS[dep]}」改为 {r1(need)}mm，可满足「{LABELS[f.name]}」= {r1(target)}mm"})
        ch = CHAIN.get(dep)
        if ch and ch in FORMULAS[dep].inverses:
            need2 = FORMULAS[dep].inverses[ch](need, values)
            if need2 and need2 > 0:
                sug.append({"relax": ch, "set_mm": r1(need2),
                            "action": f"（联动）将「{LABELS[ch]}」改为 {r1(need2)}mm，可经「{LABELS[dep]}」满足「{LABELS[f.name]}」= {r1(target)}mm"})
    if "door_count" in f.deps:
        sug.append({"relax": "door_count", "set_mm": None,
                    "action": "或调整「门数」（离散步进，需人工选择）"})
    return _diag("error", "OVER_CONSTRAINED", f.name,
        f"「{LABELS[f.name]}」与其依赖字段互相矛盾",
        f"按依赖式计算应为 {r1(computed)}mm，但锁定值为 {r1(target)}mm，"
        f"偏差 {r1(residual)}mm（容差 {TOL_MM}mm）。算式：{f.explain(values, computed)}",
        sorted(set(f.deps) | {f.name}), residual_mm=r1(residual), suggestions=sug)

def _soft_warnings(values):
    w = []
    dw, dh = values.get("door_width"), values.get("door_height")
    if dw is not None:
        if dw < 250:
            w.append(_diag("warning", "DOOR_TOO_NARROW", "door_width",
                "门宽过窄", f"门宽 {r1(dw)}mm < 250mm，铰链与拉手安装困难。", ["door_width"]))
        if dw > 600:
            w.append(_diag("warning", "DOOR_TOO_WIDE", "door_width",
                "门宽过大", f"门宽 {r1(dw)}mm > 600mm，长期易下垂，需人工评估加强方案。", ["door_width"]))
    if dh is not None and dh > 1200:
        w.append(_diag("warning", "DOOR_TOO_TALL", "door_height",
            "门高较大", f"门高 {r1(dh)}mm > 1200mm，建议人工评估拉直器。", ["door_height"]))
    t = values.get("panel_thickness")
    if t is not None and int(t) not in STANDARD_THICKNESS:
        w.append(_diag("warning", "NON_STANDARD_THICKNESS", "panel_thickness",
            "非标准板厚", f"板厚 {r1(t)}mm 不在标准序列 {sorted(STANDARD_THICKNESS)}，备料需人工确认。",
            ["panel_thickness"]))
    sd = values.get("shelf_depth")
    if sd is not None and values.get("shelf_count") and sd < 150:
        w.append(_diag("warning", "SHELF_TOO_SHALLOW", "shelf_depth",
            "层板过浅", f"层板深 {r1(sd)}mm < 150mm，实用性差。", ["shelf_depth"]))
    return w

def solve(inputs, locks):
    """inputs: 基础参数(mm)；locks: 被锁定的派生参数(mm)。
    返回 (values, sources, derived_explain, diagnostics)。"""
    values = dict(inputs)
    sources = {k: "user" for k in inputs}
    derived, diags = {}, []
    for name in ORDER:
        f = FORMULAS[name]
        if name in ("door_width", "door_height") and not values.get("door_count"):
            values[name] = None
            if locks.get(name) is not None:
                diags.append(_diag("warning", "LOCK_IGNORED", name,
                    "锁定被忽略", f"门数为 0，「{LABELS[name]}」的锁定不生效。", [name, "door_count"]))
            continue
        missing = [d for d in f.deps if values.get(d) is None]
        if missing:
            diags.append(_diag("error", "MISSING_INPUT", name, "缺少输入",
                "缺少输入: " + ", ".join(LABELS[d] for d in missing), missing))
            continue
        computed = f.fn(values)
        locked = locks.get(name)
        if locked is not None:
            values[name] = locked
            sources[name] = "locked"
            derived[name] = {"mm": r1(locked), "computed_mm": r1(computed),
                             "formula": f.explain(values, computed) + "（结果已被锁定值覆盖）"}
            if abs(locked - computed) > TOL_MM:
                diags.append(_over_constrained(f, values, locked, computed))
        else:
            values[name] = computed
            sources[name] = "derived"
            derived[name] = {"mm": r1(computed), "formula": f.explain(values, computed)}
    diags += _soft_warnings(values)
    return values, sources, derived, diags

def build_bom(values, material_id):
    """由解算后的尺寸生成材料清单（板材开料尺寸，非加工路径）。"""
    if values.get("inner_width") is None or values.get("inner_height") is None:
        return []
    L = []
    def add(name, qty, w, h, mat, flags=None, edge_m=0.0):
        L.append({"seq": len(L) + 1, "name": name, "qty": qty,
                  "w_mm": r1(w), "h_mm": r1(h), "material_id": mat,
                  "area_m2": round(qty * w * h / 1e6, 3),
                  "edge_m": round(edge_m, 2), "flags": flags or []})
    oh, od = values["outer_height"], values["outer_depth"]
    iw, ih = values["inner_width"], values["inner_height"]
    add("侧板", 2, od, oh, material_id, edge_m=2 * oh / 1000)
    add("顶/底板", 2, iw, od, material_id, edge_m=2 * iw / 1000)
    add("背板", 1, iw, ih, "back5", flags=["背板嵌槽属危险加工，需人工图纸确认，系统不自动生成"])
    dc = values.get("door_count") or 0
    if dc:
        add("门板", dc, values["door_width"], values["door_height"], material_id,
            flags=["铰链杯孔定位需人工图纸确认"],
            edge_m=dc * 2 * (values["door_width"] + values["door_height"]) / 1000)
    sc = values.get("shelf_count") or 0
    if sc:
        add("活动层板", sc, values["shelf_width"], values["shelf_depth"], material_id,
            edge_m=sc * values["shelf_width"] / 1000)
    return L

def quote_and_care(lines, material_id):
    mat, back = MATERIALS[material_id], MATERIALS["back5"]
    main_area = sum(l["area_m2"] for l in lines if l["material_id"] == material_id)
    back_area = sum(l["area_m2"] for l in lines if l["material_id"] == "back5")
    mat_cost = main_area * mat["price_m2"] * 1.15 + back_area * back["price_m2"] * 1.10
    qty = sum(l["qty"] for l in lines)
    labor, finish = 800 + 150 * qty, 260
    total = mat_cost + labor + finish
    return {"quote_cents": int(round(total * 100)),
            "lead_time_days": min(45, 12 + 3 * qty),
            "care_text": mat["care"],
            "breakdown": {"main_area_m2": round(main_area, 3), "back_area_m2": round(back_area, 3),
                          "material_cny": round(mat_cost, 2), "labor_cny": labor,
                          "finish_cny": finish,
                          "note": "材料含 15% 损耗（背板 10%）；不含运输与安装"}}

def compute_all(inputs, locks, material_id):
    values, sources, derived, diags = solve(inputs, locks)
    for k in ("outer_width", "outer_height", "outer_depth", "panel_thickness"):
        if values.get(k) is not None and values[k] <= 0:
            diags.append(_diag("error", "NON_POSITIVE", k, "尺寸必须为正",
                f"「{LABELS[k]}」必须为正数，当前 {values[k]}。", [k]))
    has_hard_error = any(d["severity"] == "error" and d["code"] == "NON_POSITIVE" for d in diags)
    bom = [] if has_hard_error else build_bom(values, material_id)
    quote = quote_and_care(bom, material_id)
    out_values = {}
    for k, v in values.items():
        disp = str(v) if k in INT_PARAMS else (fmt_mm(v) if isinstance(v, (int, float)) and v is not None else "—")
        out_values[k] = {"mm": r1(v) if isinstance(v, (int, float)) else v,
                         "display": disp, "source": sources.get(k), "label": LABELS.get(k, k)}
    return {"values": out_values, "derived": derived, "diagnostics": diags,
            "bom": bom, "quote": quote}
