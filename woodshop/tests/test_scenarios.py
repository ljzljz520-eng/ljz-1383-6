# -*- coding: utf-8 -*-
"""场景测试：单位混填 / 依赖计算 / 超约束 / 并发 / 失效 / 替代 / 工单撤销 / 附件晚到 / 安全 / 隐私。"""
import os, sys, tempfile, time, unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import store, app, engine  # noqa: E402


class Base(unittest.TestCase):
    def setUp(self):
        store.set_path(os.path.join(tempfile.mkdtemp(), "t.db"))
        store.init()

    def mk_design(self, **kw):
        body = {"title": "玄关柜", "customer_name": "林女士", "contact": "138",
                "address": "杭州市西湖区某小区 1-101", "budget_cny": 6000,
                "material_id": "oak18", "inputs": {}, "units": {}, "locks": {}}
        body.update(kw)
        s, o = app.dispatch("POST", "/api/designs", body)
        assert s == 201, o
        return o["revision"]["design_id"], o["revision"]

    def approve(self, rid, drawing="匠人·王"):
        return app.dispatch("POST", f"/api/revisions/{rid}/approve",
                            {"approver": "王", "manual_drawing_by": drawing})


class TestUnitsAndDependency(Base):
    def test_mixed_units(self):
        did, rev = self.mk_design(
            inputs={"outer_width": "30in", "outer_height": "90cm", "outer_depth": "350mm"},
            units={"outer_width": "in", "outer_height": "cm", "outer_depth": "mm"})
        v = rev["solved"]["values"]
        self.assertAlmostEqual(v["outer_width"]["mm"], 762.0)
        self.assertAlmostEqual(v["outer_height"]["mm"], 900.0)
        self.assertAlmostEqual(v["outer_depth"]["mm"], 350.0)
        self.assertIn("≈", v["outer_width"]["display"])  # 双单位展示

    def test_bad_unit_rejected(self):
        s, o = app.dispatch("POST", "/api/designs",
                            {"material_id": "oak18", "inputs": {"outer_width": "abc"}})
        self.assertEqual(s, 422)
        self.assertIn("无法解析尺寸", o["error"]["message"])

    def test_dependency_recompute_and_explain(self):
        did, rev = self.mk_design(inputs={"outer_width": "800"})
        v1 = rev["solved"]["values"]
        self.assertAlmostEqual(v1["inner_width"]["mm"], 764.0)   # 800-2*18
        self.assertAlmostEqual(v1["door_width"]["mm"], (764 - 3 * 3) / 2)
        bom1 = {l["name"]: l for l in rev["solved"]["bom"]}
        # 改外宽 -> 内宽/门宽/层板/BOM 全部联动，而不是只改一个字段
        s, o = app.dispatch("POST", f"/api/designs/{did}/revisions",
                            {"actor": "customer", "base_version": 1,
                             "inputs": {"outer_width": "900"}, "units": {}})
        self.assertEqual(s, 201, o)
        v2 = o["revision"]["solved"]["values"]
        self.assertAlmostEqual(v2["inner_width"]["mm"], 864.0)
        self.assertAlmostEqual(v2["door_width"]["mm"], (864 - 9) / 2)
        bom2 = {l["name"]: l for l in o["revision"]["solved"]["bom"]}
        self.assertNotEqual(bom1["顶/底板"]["w_mm"], bom2["顶/底板"]["w_mm"])
        self.assertNotEqual(bom1["门板"]["w_mm"], bom2["门板"]["w_mm"])
        self.assertGreater(o["revision"]["solved"]["quote"]["quote_cents"],
                           rev["solved"]["quote"]["quote_cents"])  # 材料用量联动
        # 可解释：每个派生量带算式
        self.assertIn("内宽 = 外宽 − 2×板厚", o["revision"]["solved"]["derived"]["inner_width"]["formula"])


class TestOverConstraint(Base):
    def test_lock_conflict_diagnosed(self):
        did, rev = self.mk_design()  # 外宽 760 -> 门宽计算值 359.5
        s, o = app.dispatch("POST", f"/api/revisions/{rev['id']}/compute",
                            {"locks": {"door_width": "400"}, "units": {}})
        self.assertEqual(s, 200)
        errs = [d for d in o["diagnostics"] if d["code"] == "OVER_CONSTRAINED"]
        self.assertEqual(len(errs), 1)
        e = errs[0]
        self.assertEqual(e["equation"], "door_width")
        self.assertIn("矛盾", e["title"])
        self.assertAlmostEqual(e["residual_mm"], 400 - 357.5)
        relax = {sg["relax"]: sg for sg in e["suggestions"]}
        self.assertIn("outer_width", relax)  # 联动建议：改外宽
        self.assertAlmostEqual(relax["outer_width"]["set_mm"], 845.0)  # 400*2+9+36
        self.assertIn("door_width", relax)   # 或取消锁定
        # 有未解决矛盾时禁止审批
        s2, o2 = app.dispatch("POST", f"/api/designs/{did}/revisions",
                              {"actor": "customer", "base_version": 1,
                               "locks": {"door_width": "400"}})
        self.assertEqual(s2, 201)
        s3, o3 = self.approve(o2["revision"]["id"])
        self.assertEqual(s3, 422)
        self.assertEqual(o3["error"]["code"], "UNRESOLVED_DIAGNOSTICS")

    def test_lock_consistent_passes(self):
        did, rev = self.mk_design()
        s, o = app.dispatch("POST", f"/api/designs/{did}/revisions",
                            {"actor": "customer", "base_version": 1,
                             "locks": {"door_width": "357.5"}})
        errs = [d for d in o["revision"]["solved"]["diagnostics"] if d["severity"] == "error"]
        self.assertEqual(errs, [])


class TestConcurrency(Base):
    def test_simultaneous_edit_conflict(self):
        did, rev = self.mk_design()
        s1, _ = app.dispatch("POST", f"/api/designs/{did}/revisions",
                             {"actor": "customer", "base_version": 1,
                              "inputs": {"outer_width": "800"}})
        self.assertEqual(s1, 201)
        # 工坊基于同一旧版本同时改稿 -> 409，返回服务器当前状态供合并
        s2, o2 = app.dispatch("POST", f"/api/designs/{did}/revisions",
                              {"actor": "maker", "base_version": 1,
                               "inputs": {"outer_depth": "400"}})
        self.assertEqual(s2, 409)
        self.assertEqual(o2["error"]["code"], "CONCURRENT_MODIFICATION")
        self.assertEqual(o2["server_version"], 2)
        self.assertEqual(o2["server_inputs"]["outer_width"], 800.0)
        # 基于最新版本重试成功
        s3, _ = app.dispatch("POST", f"/api/designs/{did}/revisions",
                             {"actor": "maker", "base_version": 2,
                              "inputs": {"outer_depth": "400"}})
        self.assertEqual(s3, 201)


class TestConfirmationBinding(Base):
    def test_quote_bound_and_invalidated_on_change(self):
        did, rev = self.mk_design()
        s, o = self.approve(rev["id"])
        self.assertEqual(s, 200, o)
        conf = o["confirmation"]
        self.assertEqual(conf["status"], "active")
        self.assertEqual(conf["revision_id"], rev["id"])
        self.assertTrue(conf["care_text"])
        # 客户改尺寸 -> 旧确认失效
        s2, o2 = app.dispatch("POST", f"/api/designs/{did}/revisions",
                              {"actor": "customer", "base_version": 1,
                               "inputs": {"outer_width": "900"}})
        self.assertEqual(s2, 201)
        inv = o2["impact"]["invalidated_confirmations"]
        self.assertEqual([c["id"] for c in inv], [conf["id"]])
        self.assertIn("失效", inv[0]["invalid_reason"])
        # 失效确认单不能再被接受
        s3, o3 = app.dispatch("POST", f"/api/confirmations/{conf['id']}/accept", {})
        self.assertEqual(s3, 409)

    def test_accepted_confirmation_flagged_for_rereview(self):
        did, rev = self.mk_design()
        _, o = self.approve(rev["id"])
        cid = o["confirmation"]["id"]
        app.dispatch("POST", f"/api/confirmations/{cid}/accept", {})
        app.dispatch("POST", f"/api/designs/{did}/revisions",
                     {"actor": "customer", "base_version": 1, "inputs": {"outer_depth": "400"}})
        s, imp = app.dispatch("GET", f"/api/designs/{did}/impact")
        kinds = [x["type"] for x in imp["needs_rereview"]]
        self.assertIn("已接受确认单", kinds)  # 已接受的不自动失效，但列入需重审


class TestSubstitution(Base):
    def test_material_substitution(self):
        did, rev = self.mk_design()
        _, o = self.approve(rev["id"])
        # oak18 -> ply20：板厚 18->20 联动，报价变化，旧确认失效，替代待复核
        s, o = app.dispatch("POST", f"/api/revisions/{rev['id']}/substitute",
                            {"to_material": "ply20", "actor": "maker"})
        self.assertEqual(s, 201, o)
        self.assertTrue(o["impact"]["thickness_changed"])
        self.assertNotEqual(o["impact"]["price_delta_cents"], 0)
        self.assertTrue(o["needs_rereview"])
        nv = o["new_revision"]["solved"]["values"]
        self.assertEqual(nv["panel_thickness"]["mm"], 20.0)
        self.assertEqual(nv["inner_width"]["mm"], 760 - 40)  # 内宽随板厚联动
        s, imp = app.dispatch("GET", f"/api/designs/{did}/impact")
        self.assertIn("材料替代", [x["type"] for x in imp["needs_rereview"]])
        self.assertTrue(imp["invalidated_confirmations"])


class TestWorkOrder(Base):
    def test_start_then_cancel(self):
        did, rev = self.mk_design()
        _, o = self.approve(rev["id"])
        cid = o["confirmation"]["id"]
        app.dispatch("POST", f"/api/confirmations/{cid}/accept", {})
        s, o = app.dispatch("POST", f"/api/confirmations/{cid}/start_work_order", {})
        self.assertEqual(s, 201)
        wid = o["work_order_id"]
        self.assertEqual(o["snapshot"]["param_hash"], rev["param_hash"])
        # 工单已启动后撤销
        s, o = app.dispatch("POST", f"/api/work_orders/{wid}/cancel",
                            {"reason": "客户改尺寸，旧方案作废"})
        self.assertEqual(s, 200)
        self.assertTrue(o["materials_released"])
        s, d = app.dispatch("GET", f"/api/designs/{did}")
        wo = d["work_orders"][0]
        self.assertEqual(wo["status"], "cancelled")
        self.assertEqual(wo["cancel_reason"], "客户改尺寸，旧方案作废")
        self.assertEqual(wo["quote_snapshot"]["quote_cents"], 458423)  # 快照保留
        # 已撤销不可再撤销
        s, _ = app.dispatch("POST", f"/api/work_orders/{wid}/cancel", {"reason": "x"})
        self.assertEqual(s, 409)


class TestLateAttachment(Base):
    def test_late_attachment_marked_stale_and_excluded(self):
        did, rev = self.mk_design()
        self.approve(rev["id"])
        s, o = app.dispatch("POST", f"/api/revisions/{rev['id']}/attachments",
                            {"kind": "drawing_pdf", "delay_ms": 600})
        self.assertEqual(s, 202)
        aid = o["attachment_id"]
        # 附件生成前，客户改尺寸产生 v2 -> 附件晚到
        app.dispatch("POST", f"/api/designs/{did}/revisions",
                     {"actor": "customer", "base_version": 1, "inputs": {"outer_width": "820"}})
        time.sleep(1.0)
        s, d = app.dispatch("GET", f"/api/designs/{did}")
        att = [a for a in d["attachments"] if a["id"] == aid][0]
        self.assertEqual(att["status"], "stale")
        # 交付包排除晚到附件并说明原因
        s, pkg = app.dispatch("GET", f"/api/revisions/{rev['id']}/delivery_package")
        self.assertEqual(pkg["attachments"], [])
        self.assertEqual(pkg["excluded_attachments"][0]["reason"],
                         "附件生成晚到，所属版本已被取代，不进入交付包")
        # 影响分析列出受影响附件
        s, imp = app.dispatch("GET", f"/api/designs/{did}/impact")
        self.assertIn("附件", [a["type"] for a in imp["affected_items"]])

    def test_ontime_attachment_in_package(self):
        did, rev = self.mk_design()
        self.approve(rev["id"])
        app.dispatch("POST", f"/api/revisions/{rev['id']}/attachments",
                     {"kind": "cutlist_csv", "delay_ms": 100})
        time.sleep(0.4)
        s, pkg = app.dispatch("GET", f"/api/revisions/{rev['id']}/delivery_package")
        self.assertEqual(len(pkg["attachments"]), 1)
        self.assertEqual(pkg["attachments"][0]["kind"], "cutlist_csv")


class TestSafetyAndHybrid(Base):
    def test_manual_drawing_required(self):
        did, rev = self.mk_design()
        s, o = app.dispatch("POST", f"/api/revisions/{rev['id']}/approve",
                            {"approver": "王"})  # 未给人工图纸审批人
        self.assertEqual(s, 422)
        self.assertEqual(o["error"]["code"], "MANUAL_DRAWING_REQUIRED")
        self.assertTrue(o["manual_review_items"])
        s, o = self.approve(rev["id"])
        self.assertEqual(s, 200)

    def test_toolpath_always_forbidden(self):
        did, rev = self.mk_design()
        s, o = app.dispatch("POST", f"/api/revisions/{rev['id']}/toolpath", {})
        self.assertEqual(s, 403)
        self.assertEqual(o["error"]["code"], "SAFETY_POLICY")
        self.assertIn("危险加工", o["error"]["message"])


class TestPrivacyAndTraceability(Base):
    def test_public_snapshot_excludes_private_and_is_frozen(self):
        did, rev = self.mk_design()
        _, o = self.approve(rev["id"])
        cid = o["confirmation"]["id"]
        app.dispatch("POST", f"/api/confirmations/{cid}/accept", {})
        s, o = app.dispatch("POST", f"/api/designs/{did}/publish",
                            {"title": "玄关柜", "story": "…", "show_dimensions": True,
                             "show_material": True})
        self.assertEqual(s, 201)
        snap = o["snapshot"]
        raw = str(snap)
        for private in ("6000", "杭州市", "林女士", "138", "budget", "address", "contact"):
            self.assertNotIn(private, raw)
        self.assertEqual(snap["source"]["param_hash"], rev["param_hash"])
        # 后续改尺寸不影响已发布快照（单独授权快照）
        app.dispatch("POST", f"/api/designs/{did}/revisions",
                     {"actor": "customer", "base_version": 1, "inputs": {"outer_width": "1200"}})
        s, c = app.dispatch("GET", f"/api/cases/{o['case_id']}")
        self.assertEqual(c["snapshot"], snap)

    def test_delivery_package_traceable_and_clean(self):
        did, rev = self.mk_design()
        self.approve(rev["id"])
        s, pkg = app.dispatch("GET", f"/api/revisions/{rev['id']}/delivery_package")
        self.assertEqual(pkg["param_hash"], rev["param_hash"])
        self.assertTrue(pkg["derived_explanations"])  # 实际采用的说明/算式
        self.assertTrue(pkg["trace"]["events"])
        self.assertNotIn("杭州市", str(pkg))
        self.assertNotIn("600000", str(pkg))  # 预算不进入交付包


if __name__ == "__main__":
    unittest.main(verbosity=2)
