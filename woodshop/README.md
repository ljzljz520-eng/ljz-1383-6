# 木语工坊 · 手作木作与定制站

纯 Python 标准库实现（无第三方依赖）：尺寸引擎 + SQLite 后端 API + 单页前端。

## 运行

```bash
cd woodshop
python3 server.py          # http://127.0.0.1:8000
python3 tests/test_scenarios.py   # 16 个场景测试
```

## 混合流程：参数化规格 vs 人工图纸审批

| 可自动核算（参数化） | 必须人工 |
|---|---|
| 尺寸链联动（外宽→内宽→门宽/层板/BOM/用量） | 图纸审批（`manual_drawing_by`，审批前置条件） |
| 超约束诊断与修复建议（可解释算式） | 危险加工工序（锯切路径、刀具轨迹、开槽、铰链孔定位） |
| 报价/交期估算、保养说明模板 | 异形、雕刻、非标工艺的最终确认 |

安全政策：系统**不自动提供危险加工操作**。`POST /api/revisions/{id}/toolpath` 恒 403；
BOM 中危险/定位工序以 `flags` 标注，未填人工图纸审批人时审批接口返回 422。

## 关键机制

- **单位与约束**：内部统一 mm；输入支持 `500 / 50cm / 20in / 20"` 混填并保留回显。
  派生尺寸由依赖式计算并附算式；锁定派生尺寸与基础尺寸矛盾时产生
  `OVER_CONSTRAINED` 诊断，给出"放松哪个字段、改成多少"的建议（含二级联动到基础尺寸）。
- **版本绑定**：报价、交期、保养说明写入 confirmation 并绑定获批修订；
  客户改尺寸产生新修订 → 未接受的确认自动 `invalidated`，已接受的列入"需重审"。
- **并发**：修订携带 `base_version`，双方同时改稿时后到者收 409 与服务器当前值。
- **材料替代**：生成新修订（板厚随材料联动），旧确认失效，替代记录 `pending_review`。
- **工单**：已启动工单可撤销（记录原因、释放材料、保留报价快照）；设计变更不自动改单。
- **附件晚到**：异步生成；生成时版本已被取代则标记 `stale`，交付包排除并说明原因。
- **隐私**：预算/地址/姓名/联系方式只在工坊视图；公开案例为**单独授权快照**（白名单字段，
  发布后冻结，后续修改不影响）；交付包可经 `param_hash` 追溯到实际采用的图纸与说明。

## API 摘要

```
GET  /api/catalog                        材料/参数规格/安全政策
POST /api/designs                        提交定制需求（含尺寸混填、私密字段）
POST /api/designs/{id}/revisions         新修订（base_version 乐观并发）
POST /api/revisions/{id}/compute         试算（不入库，返回诊断）
POST /api/revisions/{id}/approve         审批（需无错误诊断 + 人工图纸审批人）
POST /api/confirmations/{id}/accept      客户接受报价
POST /api/confirmations/{id}/start_work_order   开工（快照）
POST /api/work_orders/{id}/cancel        撤销工单
POST /api/revisions/{id}/substitute      材料替代
POST /api/revisions/{id}/attachments     异步附件（delay_ms 模拟晚到）
GET  /api/revisions/{id}/delivery_package  交付包（溯源）
GET  /api/designs/{id}/impact            受影响项与需重审清单
POST /api/designs/{id}/publish           发布授权快照
GET  /api/cases                          公开作品（无私密字段）
```
