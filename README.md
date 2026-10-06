# 榫隅木作 · 手作木作与定制站

一个完整的定制家具全流程站点：**展示材料/尺寸/使用情境 → 客户填定制需求 → 后端把设计修订、材料清单、确认记录存入数据库 → 混合审批 → 工单 → 可追溯交付**。
核心是一个**可解释的参数化规格引擎**：毫米/英寸混填归一化、尺寸之间带公式的依赖级联，以及"只改一个字段导致门板/内空间/用料互相矛盾"时的**超约束诊断**。

## 运行

```bash
npm install
npm start            # http://localhost:3000
npm test             # 端到端验收（需先启动服务）
```

数据库为 SQLite（通过 sql.js/WASM 驱动，无需本机编译），文件落在 `data/woodwork.db`。删除该文件可重置并重新播种演示数据。

## 目录

```
server/specEngine.js   参数化规格引擎（归一化 / 依赖计算 / 超约束诊断 / BOM / 报价）
server/server.js       Express API + 工作流状态机
server/db.js           SQLite 持久化与建表
server/seed.js         材料目录与演示项目/公开案例
public/                单页前端（案例、定制工作台、流程说明、7 个一键验收场景）
test/acceptance.js     Node 端到端验收（7 场景）
```

## 参数化规格 vs 人工图纸审批（混合流程）

| 系统自动核算（参数化） | 必须人工图纸审批 |
|---|---|
| mm/in 混填归一化（1in=25.4mm） | 木纹走向、色差与拼板方案 |
| 内宽/内高/内深、门板宽高、层板尺寸级联 | 中立板、异形结构、隐藏加固 |
| BOM 板件面积、封边长度、五金数量 | 门缝微调、铰链开启方向、碰撞检查 |
| 报价、交期随尺寸/材料自动重算 | 现场梁柱、运输通道、安装条件 |
| 跨距下垂、库存料尺寸、比例等约束 | **危险加工操作的评估与取舍** |

> ⛔ **系统不自动提供危险加工操作**（无防护高速切削指引、易燃涂装现场参数、承重吊装方案等）；这些只在人工图纸审批环节由有资质师傅评估并留痕。

状态机：`draft → pending_review（锁定）→ approved（人工图纸通过）→ confirmed（客户确认，报价/交期/保养在此绑定）→ 工单 → 交付包`。

## 关键规则

- **依赖一致性**：外宽 W 是源头量，内宽=`W-2×侧板厚`、门宽=`(W-内缩-门缝)/门数`、层板宽=内宽、BOM 面积随动。改 W 时所有派生项与材料用量同步重算，界面逐项列出"受影响项"。
- **超约束诊断**：门宽/层板宽/内宽的显式覆盖值若与派生值偏差 >0.6mm，报 `OVERCONFLICT`，给出"删除覆盖让其自动派生"或"改源头尺寸"两种可操作修复（附公式）。
- **报价/交期/保养绑定获批版本**：仅在客户确认时冻结到该修订；客户改尺寸或替代材料 → 自动新建**后继版本**，旧版 `superseded`、旧批准与确认**失效**，必须重新图纸审批+重新确认。
- **并发**：待审批版本锁定，双方不能同时直接改稿（`LOCKED_PENDING_REVIEW`）；退稿后用 `If-Match`/`expected_rev` 检测陈旧编辑（`STALE_EDIT`）并返回对方改动供合并。
- **材料替代**：不就地覆盖，生成新版本并重算跨距约束/BOM/报价/保养，旧确认失效。
- **工单启动后撤销**：系统**不自动撤销**，只登记评估请求，工坊评估已下料成本/工时/安全后 granted/denied。
- **附件晚到**：按到达阶段（批准后/开工后/完工后/交付后）打标；晚到附件不静默并入，须双方确认；图纸/保养类需另起修订重审。未确认的晚到附件会**阻断封包**（`LATE_UNACKED`）。
- **隐私**：预算、地址、客户姓名是私人字段；公开案例只来自客户**单独授权**的发布快照（白名单拷贝 + 服务端断言拦截），撤销授权立即下架。
- **交付追溯**：交付包 manifest 记录实际采用的图纸图号、绑定版本的报价/交期/保养、锁定前附件与已确认的晚到补充（含 sha256 哈希）。

## 七个验收场景（界面"验收场景"页可一键跑，或 `npm test`）

1. 毫米/英寸混填 + 超约束诊断
2. 双方同时改稿（审批锁定 + 陈旧冲突）
3. 材料替代（跨距重算、报价重批、旧确认失效）
4. 工单已启动后撤销（人工评估，非自动）
5. 附件晚到（确认前不能入交付包）
6. 客户改尺寸（受影响项清单 + 旧确认失效 + 报价重算）
7. 私人预算/地址不泄漏 + 发布快照 + 交付包追溯 + 撤销下架

## 主要 API

`GET /api/cases` · `GET /api/materials` · `GET /api/process-info` · `POST /api/calc` · `POST /api/calc-diff`
`POST /api/projects` · `POST /api/projects/:pid/revisions` · `PUT /api/revisions/:rid/spec`
`…/submit | request-changes | drawing-review | confirm | substitute | work-order | attachments | impact | publish | deliver`
`POST /api/work-orders/:wid/{cancellation-request,complete}` · `POST /api/cancellation-requests/:id/assess`
`POST /api/attachments/:id/acknowledge` · `POST /api/publications/:id/revoke` · `GET /api/delivery-packages/:id`

身份用请求头 `x-actor-role: customer|shop` 传递（显示名走 body）。
