const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { init, run, get, all } = require('./db');
const { seed, materialMap } = require('./seed');
const { evaluate, diffSpecs } = require('./specEngine');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const id = p => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const now = () => new Date().toISOString();

const log = (actor, action, entity, entityId, detail) =>
  run('INSERT INTO audit_log (ts,actor,action,entity,entity_id,detail) VALUES (?,?,?,?,?,?)',
    [now(), actor || 'anonymous', action, entity || null, entityId || null, detail ? JSON.stringify(detail) : null]);

const err = (res, code, message, extra = {}) => res.status(code).json({ error: message, ...extra });

function loadRevision(revId) {
  const row = get('SELECT * FROM revisions WHERE id=?', [revId]);
  if (row) for (const k of ['spec_json', 'derived_json', 'bom_json', 'quote_json', 'issues_json']) row[k] = JSON.parse(row[k]);
  return row;
}
function loadProject(pid) { return get('SELECT * FROM projects WHERE id=?', [pid]); }

function actorOf(req) {
  // 以请求体内的 actor_* 为准（页面异步切换身份时最可靠），头作为回退
  return {
    role: req.body?.actor_role || req.get('x-actor-role') || 'customer',
    name: req.body?.actor_name || (req.get('x-actor-name') !== 'user' ? req.get('x-actor-name') : null) || null
  };
}

const ROLE_LABEL = { shop: '工坊', customer: '客户' };

/* ============================================================
 * 公开信息
 * ============================================================ */
app.get('/api/materials', (req, res) => {
  res.json(all('SELECT id,name,unit_price,max_span_mm,stock_width_mm,stock_length_mm,lead_days,density,origin,care_note FROM materials ORDER BY id'));
});

// 公开案例：仅来自“已授权发布快照”，绝不读取 projects.budget / address / customer_name
app.get('/api/cases', (req, res) => {
  const rows = all(`SELECT p.id, p.snapshot_json, p.authorized_at FROM publications p
                    WHERE p.status='authorized' ORDER BY p.authorized_at DESC`);
  res.json(rows.map(r => ({ publication_id: r.id, authorized_at: r.authorized_at, ...JSON.parse(r.snapshot_json) })));
});

// 混合流程说明：参数化规格 vs 人工图纸审批 —— 自动核算范围
app.get('/api/process-info', (req, res) => {
  res.json({
    parametric: {
      title: '参数化规格（系统自动核算）',
      scope: ['毫米/英寸混填归一化', '内外尺寸与门板/层板的依赖级联', '材料清单(BOM)与封边/五金用量', '报价、交期的自动重算', '跨距/库存料/比例等约束诊断', '变更受影响项与需重审清单'],
      limit: '只覆盖规则明确、可计算的部分'
    },
    manual: {
      title: '人工图纸审批（工坊师傅）',
      scope: ['木纹走向与色差拼板方案', '中立板/异形结构与隐藏加固', '门缝微调、铰链开启方向与碰撞', '现场墙面/梁柱与运输通道', '危险加工操作的评估与取舍（系统不自动提供）'],
      drawings: ['SH 系列总装图', '开料图', '五金开孔图']
    },
    hybrid: '系统先自动核算并阻断明显矛盾；通过后转人工图纸审批，两者都过才进入客户确认。',
    dangerous_operations: ['电锯/修边等无防护高速切削的具体操作指引', '易燃易爆涂装现场作业参数', '涉及承重吊装的现场方案'],
    dangerous_policy: '系统不自动提供危险加工操作说明；此类内容仅在人工图纸审批环节由有资质师傅评估，并明确留痕。'
  });
});

/* ============================================================
 * 无状态试算（不入库）—— 给前端实时依赖计算/诊断
 * ============================================================ */
app.post('/api/calc', (req, res) => {
  const result = evaluate(req.body.spec || {}, materialMap());
  res.json(result);
});

app.post('/api/calc-diff', (req, res) => {
  const oldE = evaluate(req.body.old_spec || {}, materialMap());
  const newE = evaluate(req.body.new_spec || {}, materialMap());
  res.json({ old: oldE, new: newE, diff: diffSpecs(oldE, newE, materialMap()) });
});

/* ============================================================
 * 项目（含私人字段，仅工坊/客户本人可见，公开 API 不返回）
 * ============================================================ */
app.post('/api/projects', (req, res) => {
  const { title, customer_name, budget, address, note } = req.body;
  if (!title) return err(res, 400, 'title 必填');
  const pid = id('prj');
  run('INSERT INTO projects (id,title,created_at,customer_name,budget,address,note) VALUES (?,?,?,?,?,?,?)',
    [pid, title, now(), customer_name || null, budget ?? null, address || null, note || null]);
  log(actorOf(req).name || 'customer', 'create_project', 'project', pid, { title, has_budget: budget != null, has_address: !!address });
  res.json({ project_id: pid });
});

app.get('/api/projects/:pid', (req, res) => {
  const p = loadProject(req.params.pid);
  if (!p) return err(res, 404, '项目不存在');
  const revs = all('SELECT id,rev_no,status,created_by,created_at,superseded_by,locked_by,locked_at FROM revisions WHERE project_id=? ORDER BY rev_no', [p.id]);
  res.json({ project: p, revisions: revs });
});

/* ============================================================
 * 设计版本
 * ============================================================ */
// 创建新版本（项目首版）
app.post('/api/projects/:pid/revisions', (req, res) => {
  const p = loadProject(req.params.pid);
  if (!p) return err(res, 404, '项目不存在');
  const spec = req.body.spec || {};
  const result = evaluate(spec, materialMap());
  const maxNo = get('SELECT COALESCE(MAX(rev_no),0) n FROM revisions WHERE project_id=?', [p.id]).n;
  const revNo = maxNo + 1, revId = id('rev');
  run(`INSERT INTO revisions (id,project_id,rev_no,spec_json,derived_json,bom_json,quote_json,issues_json,status,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [revId, p.id, revNo, JSON.stringify(spec), JSON.stringify(result.derived), JSON.stringify(result.bom),
     JSON.stringify(result.quote), JSON.stringify(result.issues), 'draft', actorOf(req).name || 'customer', now()]);
  log(actorOf(req).name, 'create_revision', 'revision', revId, { rev_no: revNo });
  res.json({ revision_id: revId, rev_no: revNo, evaluation: result,
    warning: result.has_errors ? '存在阻断错误，修正后才能提交审批' : undefined });
});

app.get('/api/revisions/:rid', (req, res) => {
  const rev = loadRevision(req.params.rid);
  if (!rev) return err(res, 404, '版本不存在');
  rev.approvals = all('SELECT * FROM approvals WHERE revision_id=? ORDER BY signed_at', [rev.id]);
  rev.drawings = all('SELECT * FROM drawing_reviews WHERE revision_id=? ORDER BY reviewed_at', [rev.id]);
  rev.amendments = all('SELECT * FROM amendments WHERE revision_id=? ORDER BY created_at', [rev.id]);
  rev.substitutions = all('SELECT * FROM substitutions WHERE revision_id=? ORDER BY created_at', [rev.id]);
  rev.attachments = all('SELECT * FROM attachments WHERE revision_id=? ORDER BY uploaded_at', [rev.id]);
  const wo = get('SELECT * FROM work_orders WHERE revision_id=?', [rev.id]);
  rev.work_order = wo || null;
  res.json(rev);
});

// 编辑规格。核心规则：
//  - draft / changes_requested：直接在本版改
//  - pending_review：被锁，返回 409（双方同时改稿用 If-Match 版本号检测）
//  - approved / confirmed：不就地改，生成后继版本并把旧版置 superseded（旧确认失效）
const EDITABLE = new Set(['draft', 'rejected', 'changes_requested']);
app.put('/api/revisions/:rid/spec', (req, res) => {
  const rev = loadRevision(req.params.rid);
  if (!rev) return err(res, 404, '版本不存在');
  const actor = actorOf(req);
  if (rev.status === 'pending_review') {
    return err(res, 409, '版本已提交审批并锁定，双方不能同时直接改稿；请先“请求修改”退稿', { code: 'LOCKED_PENDING_REVIEW', locked_by: rev.locked_by });
  }
  const expected = req.get('if-match') || req.body.expected_rev;
  const amendments = all('SELECT * FROM amendments WHERE revision_id=? ORDER BY created_at', [rev.id]);
  const clientSeq = amendments.length; // 简单并发标记
  if (expected && String(expected) !== String(clientSeq)) {
    return err(res, 409, '并发冲突：对方刚改过稿，你看到的不是最新版本', {
      code: 'STALE_EDIT',
      server_changes: amendments.map(a => ({ at: a.created_at, by: a.created_by, changes: JSON.parse(a.changes_json) }))
    });
  }
  const wo = get('SELECT * FROM work_orders WHERE revision_id=? AND status=?', [rev.id, 'started']);
  if (wo) {
    return err(res, 409, '工单已启动，不能直接改尺寸；请先发起撤销评估', { code: 'WORK_ORDER_STARTED', work_order_id: wo.id });
  }

  const newSpec = req.body.spec;
  const newEval = evaluate(newSpec, materialMap());
  const oldEval = { derived: rev.derived_json, bom: rev.bom_json, quote: rev.quote_json };
  const diff = diffSpecs(oldEval, newEval, materialMap());

  if (EDITABLE.has(rev.status)) {
    run('UPDATE revisions SET spec_json=?,derived_json=?,bom_json=?,quote_json=?,issues_json=? WHERE id=?',
      [JSON.stringify(newSpec), JSON.stringify(newEval.derived), JSON.stringify(newEval.bom), JSON.stringify(newEval.quote), JSON.stringify(newEval.issues), rev.id]);
    run('INSERT INTO amendments (id,revision_id,old_json,new_json,changes_json,reason,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [id('am'), rev.id, JSON.stringify(rev.spec_json), JSON.stringify(newSpec), JSON.stringify(diff), req.body.reason || null, actor.name, now()]);
    log(actor.name, 'edit_spec', 'revision', rev.id, { fields: Object.keys(newSpec) });
    return res.json({ mode: 'in_place', revision_id: rev.id, evaluation: newEval, diff });
  }

  // approved / confirmed / superseded -> 后继版本
  const projectId = rev.project_id;
  const nextNo = get('SELECT COALESCE(MAX(rev_no),0) n FROM revisions WHERE project_id=?', [projectId]).n + 1;
  const nextId = id('rev');
  run(`INSERT INTO revisions (id,project_id,rev_no,spec_json,derived_json,bom_json,quote_json,issues_json,status,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [nextId, projectId, nextNo, JSON.stringify(newSpec), JSON.stringify(newEval.derived), JSON.stringify(newEval.bom),
     JSON.stringify(newEval.quote), JSON.stringify(newEval.issues), 'draft', actor.name, now()]);
  run('UPDATE revisions SET status=?, superseded_by=? WHERE id=?', ['superseded', nextId, rev.id]);
  // 旧批准/确认对新版本不再有效（记录在案，前端标记“旧确认失效”）
  run('INSERT INTO amendments (id,revision_id,old_json,new_json,changes_json,reason,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [id('am'), nextId, JSON.stringify(rev.spec_json), JSON.stringify(newSpec),
     JSON.stringify({ ...diff, invalidation: `源自第 ${rev.rev_no} 版（${rev.status}）；旧批准与客户确认对新版本失效，须重走审批+确认；报价/交期/保养以新版本为准` }),
     req.body.reason || '客户改尺寸', actor.name, now()]);
  log(actor.name, 'supersede_revision', 'revision', rev.id, { next: nextId });
  res.json({ mode: 'new_revision', revision_id: nextId, rev_no: nextNo, superseded: rev.id, evaluation: newEval, diff,
    invalidation: { old_revision: rev.id, old_status: rev.status, message: '旧确认已失效：需重新审批图纸、重新确认报价/交期/保养' } });
});

/* ---------- 审批工作流 ---------- */
app.post('/api/revisions/:rid/submit', (req, res) => {
  const rev = loadRevision(req.params.rid);
  if (!rev) return err(res, 404, '版本不存在');
  if (!EDITABLE.has(rev.status)) return err(res, 409, `当前状态 ${rev.status} 不可提交审批`, { code: 'BAD_TRANSITION' });
  if (rev.issues_json.some(i => i.severity === 'error'))
    return err(res, 422, '仍有阻断性约束错误，参数化核算未通过', { code: 'CONSTRAINT_ERRORS', issues: rev.issues_json.filter(i => i.severity === 'error') });
  const actor = actorOf(req);
  run("UPDATE revisions SET status='pending_review', locked_by=?, locked_at=? WHERE id=?", [actor.name || 'customer', now(), rev.id]);
  log(actor.name, 'submit_review', 'revision', rev.id, {});
  res.json({ ok: true, status: 'pending_review', next: '等待工坊人工图纸审批；期间版本锁定' });
});

// 请求修改（退稿，解锁）
app.post('/api/revisions/:rid/request-changes', (req, res) => {
  const rev = loadRevision(req.params.rid);
  if (!rev) return err(res, 404, '版本不存在');
  if (rev.status !== 'pending_review') return err(res, 409, '仅待审批版本可退稿', { code: 'BAD_TRANSITION' });
  const actor = actorOf(req);
  run("UPDATE revisions SET status='changes_requested', locked_by=NULL, locked_at=NULL WHERE id=?", [rev.id]);
  run('INSERT INTO approvals (id,revision_id,role,kind,comment,signed_at) VALUES (?,?,?,?,?,?)',
    [id('ap'), rev.id, actor.role, 'approve', `退稿/请求修改：${req.body.comment || ''}（记录留痕）`, now()]);
  log(actor.name, 'request_changes', 'revision', rev.id, { comment: req.body.comment });
  res.json({ ok: true, status: 'changes_requested' });
});

// 工坊人工图纸审批
app.post('/api/revisions/:rid/drawing-review', (req, res) => {
  const rev = loadRevision(req.params.rid);
  if (!rev) return err(res, 404, '版本不存在');
  if (rev.status !== 'pending_review') return err(res, 409, '仅待审批版本可做图纸审批', { code: 'BAD_TRANSITION' });
  if (actorOf(req).role !== 'shop') return err(res, 403, '仅工坊可做图纸审批');
  const { decision, note, drawing_no } = req.body;
  if (!['pass', 'hold'].includes(decision)) return err(res, 400, 'decision 必须为 pass/hold');
  run('INSERT INTO drawing_reviews (id,revision_id,drawing_no,reviewer,decision,note,reviewed_at) VALUES (?,?,?,?,?,?,?)',
    [id('dr'), rev.id, drawing_no || null, actorOf(req).name || '工坊师傅', decision, note || null, now()]);
  if (decision === 'pass') {
    run("UPDATE revisions SET status='approved', locked_by=NULL, locked_at=NULL WHERE id=?", [rev.id]);
    run('INSERT INTO approvals (id,revision_id,role,kind,comment,signed_at) VALUES (?,?,?,?,?,?)',
      [id('ap'), rev.id, 'shop', 'approve', `人工图纸审批通过（${drawing_no || '无图号'}）：${note || ''}`, now()]);
  }
  log(actorOf(req).name, 'drawing_review', 'revision', rev.id, { decision });
  res.json({ ok: true, status: decision === 'pass' ? 'approved' : 'pending_review', decision });
});

// 客户确认（报价/交期/保养在此刻绑定到该批准版本）
app.post('/api/revisions/:rid/confirm', (req, res) => {
  const rev = loadRevision(req.params.rid);
  if (!rev) return err(res, 404, '版本不存在');
  if (rev.status !== 'approved') return err(res, 409, '仅“已批准(人工图纸通过)”版本可由客户确认', { code: 'BAD_TRANSITION' });
  if (actorOf(req).role !== 'customer') return err(res, 403, '仅客户可确认');
  run("UPDATE revisions SET status='confirmed' WHERE id=?", [rev.id]);
  run('INSERT INTO approvals (id,revision_id,role,kind,comment,signed_at) VALUES (?,?,?,?,?,?)',
    [id('ap'), rev.id, 'customer', 'confirm', `确认绑定：报价 ¥${rev.quote_json.total}，交期 ${rev.quote_json.lead_workdays} 个工作日，保养说明随版存档`, now()]);
  log(actorOf(req).name, 'confirm_revision', 'revision', rev.id, { total: rev.quote_json.total });
  res.json({ ok: true, status: 'confirmed', bound: { quote: rev.quote_json.total, lead_workdays: rev.quote_json.lead_workdays, care: rev.quote_json.care, revision_id: rev.id, rev_no: rev.rev_no } });
});

/* ---------- 材料替代（批准后也会使确认失效，需重审+重确认） ---------- */
app.post('/api/revisions/:rid/substitute', (req, res) => {
  const rev = loadRevision(req.params.rid);
  if (!rev) return err(res, 404, '版本不存在');
  const mats = materialMap();
  const newMat = req.body.material;
  if (!mats[newMat]) return err(res, 400, `未知替代材料: ${newMat}`);
  const actor = actorOf(req);
  const status0 = rev.status;
  const oldEval = { derived: rev.derived_json, bom: rev.bom_json, quote: rev.quote_json };
  const newSpec = { ...rev.spec_json, material: newMat };
  const newEval = evaluate(newSpec, mats);
  const diff = diffSpecs(oldEval, newEval, mats);

  run('INSERT INTO substitutions (id,revision_id,original_material,substitute_material,requester,status,note,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [id('sb'), rev.id, rev.spec_json.material, newMat, actor.name, 'proposed', req.body.note || null, now()]);

  // 无论此前何种状态，材料替代都产生新版本：旧确认失效，重新审批
  const nextNo = get('SELECT COALESCE(MAX(rev_no),0) n FROM revisions WHERE project_id=?', [rev.project_id]).n + 1;
  const nextId = id('rev');
  run(`INSERT INTO revisions (id,project_id,rev_no,spec_json,derived_json,bom_json,quote_json,issues_json,status,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [nextId, rev.project_id, nextNo, JSON.stringify(newSpec), JSON.stringify(newEval.derived), JSON.stringify(newEval.bom),
     JSON.stringify(newEval.quote), JSON.stringify(newEval.issues), 'draft', actor.name, now()]);
  run('UPDATE revisions SET status=?, superseded_by=? WHERE id=?', ['superseded', nextId, rev.id]);
  run('INSERT INTO amendments (id,revision_id,old_json,new_json,changes_json,reason,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [id('am'), nextId, JSON.stringify(rev.spec_json), JSON.stringify(newSpec),
     JSON.stringify({ ...diff, material_substitution: `${rev.spec_json.material} → ${newMat}`, invalidation: `第 ${rev.rev_no} 版（${status0}）的确认失效；材料替代影响跨距约束、BOM、报价与保养，须重审重批` }),
     `材料替代：${req.body.note || ''}`, actor.name, now()]);
  log(actor.name, 'substitute_material', 'revision', rev.id, { newMaterial: newMat, next: nextId });
  res.json({ ok: true, mode: 'new_revision', revision_id: nextId, rev_no: nextNo, superseded: rev.id,
    substitution: { from: rev.spec_json.material, to: newMat }, evaluation: newEval, diff,
    invalidation: { old_revision: rev.id, message: '材料替代：旧确认失效，需重新图纸审批与客户确认；保养说明随新材料重发' } });
});

/* ---------- 工单 ---------- */
app.post('/api/revisions/:rid/work-order', (req, res) => {
  const rev = loadRevision(req.params.rid);
  if (!rev) return err(res, 404, '版本不存在');
  if (rev.status !== 'confirmed') return err(res, 409, '仅客户已确认的版本可开工', { code: 'BAD_TRANSITION' });
  const exist = get('SELECT * FROM work_orders WHERE revision_id=?', [rev.id]);
  if (exist) return err(res, 409, '该版本已有工单', { work_order_id: exist.id });
  const wid = id('wo');
  run("INSERT INTO work_orders (id,revision_id,project_id,status,started_at) VALUES (?,?,?,?,?)",
    [wid, rev.id, rev.project_id, 'started', now()]);
  log(actorOf(req).name, 'start_work_order', 'work_order', wid, { revision: rev.id });
  res.json({ ok: true, work_order_id: wid, status: 'started' });
});

// 工单已启动后撤销 —— 不自动执行，先登记评估（成本/安全/进度），由工坊决定
app.post('/api/work-orders/:wid/cancellation-request', (req, res) => {
  const wo = get('SELECT * FROM work_orders WHERE id=?', [req.params.wid]);
  if (!wo) return err(res, 404, '工单不存在');
  if (wo.status !== 'started') return err(res, 409, `工单状态 ${wo.status}，无需撤销评估`);
  const actor = actorOf(req);
  const cid = id('cr');
  run("INSERT INTO cancellation_requests (id,work_order_id,requester,reason,decision,created_at) VALUES (?,?,?,?,?,?)",
    [cid, wo.id, actor.name, req.body.reason || null, 'pending', now()]);
  log(actor.name, 'request_cancellation', 'cancellation_request', cid, { work_order: wo.id });
  res.json({ ok: true, cancellation_request_id: cid, decision: 'pending',
    message: '已登记撤销请求。工单已启动，系统不自动撤销：工坊将评估已下料成本、工时与安全，并给出处理结论。' });
});

app.post('/api/cancellation-requests/:cid/assess', (req, res) => {
  const cr = get('SELECT * FROM cancellation_requests WHERE id=?', [req.params.cid]);
  if (!cr) return err(res, 404, '撤销请求不存在');
  if (actorOf(req).role !== 'shop') return err(res, 403, '仅工坊可评估');
  const { decision, assessed_cost } = req.body;
  if (!['granted', 'denied'].includes(decision)) return err(res, 400, 'decision 必须 granted/denied');
  run('UPDATE cancellation_requests SET decision=?, assessed_cost=?, assessed_at=? WHERE id=?',
    [decision, assessed_cost ?? null, now(), cr.id]);
  if (decision === 'granted') run("UPDATE work_orders SET status='cancelled', cancelled_at=?, cancel_reason=? WHERE id=?",
    [now(), `撤销评估通过，已发生成本 ¥${assessed_cost ?? 0}`, cr.work_order_id]);
  log(actorOf(req).name, 'assess_cancellation', 'cancellation_request', cr.id, { decision, assessed_cost });
  res.json({ ok: true, decision, assessed_cost, work_order_status: decision === 'granted' ? 'cancelled' : 'started' });
});

/* ---------- 附件（含“晚到”） ---------- */
app.post('/api/revisions/:rid/attachments', (req, res) => {
  const rev = loadRevision(req.params.rid);
  if (!rev) return err(res, 404, '版本不存在');
  const actor = actorOf(req);
  const wo = get("SELECT * FROM work_orders WHERE revision_id=? AND status IN ('started','done')", [rev.id]);
  const delivered = get('SELECT * FROM delivery_packages WHERE revision_id=? AND delivered=1', [rev.id]);
  let arrivedAfter = null;
  if (delivered) arrivedAfter = 'delivery';
  else if (wo) arrivedAfter = wo.status === 'done' ? 'work_done' : 'work_started';
  else if (['confirmed', 'approved', 'superseded'].includes(rev.status)) arrivedAfter = rev.status;

  const aid = id('at');
  const hash = crypto.createHash('sha256').update(JSON.stringify(req.body.content ?? req.body.filename)).digest('hex').slice(0, 16);
  run(`INSERT INTO attachments (id,revision_id,kind,filename,uploaded_by,uploaded_at,arrived_after,late_reason,acknowledged,content_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [aid, rev.id, req.body.kind || 'other', req.body.filename || '未命名附件', actor.name, now(),
     arrivedAfter, arrivedAfter ? (req.body.late_reason || '未说明') : null, 0, hash]);
  log(actor.name, 'upload_attachment', 'attachment', aid, { revision: rev.id, arrivedAfter });

  const late = !!arrivedAfter;
  res.json({ ok: true, attachment_id: aid, late, arrived_after: arrivedAfter,
    impact: late ? buildLateImpact(rev, req.body.kind, arrivedAfter) : null,
    guidance: late
      ? '附件晚到：不静默并入已确认版本。须双方确认收件；若影响尺寸/工艺/保养，则新建修订版本重新审批，交付包仅收“锁定前”附件或附补充确认。'
      : '附件已挂到当前版本，随人工图纸审批一并查看。' });
});

// 双方确认晚到附件
app.post('/api/attachments/:aid/acknowledge', (req, res) => {
  const at = get('SELECT * FROM attachments WHERE id=?', [req.params.aid]);
  if (!at) return err(res, 404, '附件不存在');
  run('UPDATE attachments SET acknowledged=1 WHERE id=?', [at.id]);
  const rev = loadRevision(at.revision_id);
  log(actorOf(req).name, 'acknowledge_attachment', 'attachment', at.id, {});
  const needsNewRev = at.arrived_after && (at.kind === 'drawing' || at.kind === 'care');
  res.json({ ok: true, acknowledged: true,
    needs_new_revision: needsNewRev,
    note: needsNewRev
      ? '该晚到附件涉及图纸/保养说明，需新建修订版本重新审批后才能进入交付包。'
      : '收件已确认；非结构性附件可作为交付补充留档。' });
});

function buildLateImpact(rev, kind, arrivedAfter) {
  const map = {
    drawing: ['实际采用图纸可能变化', '需人工重新审批', '已确认报价/交期可能需重算'],
    care: ['保养说明与批准版本不一致风险', '交付包内说明需更新并经客户确认'],
    other: ['仅作留档，原则上不改尺寸']
  };
  return {
    stage: arrivedAfter,
    affected: (map[kind] || map.other),
    recheck: ['确认双方均已知悉', '是否影响已批准结构', '交付包是否需要补充确认页']
  };
}

/* ---------- 受影响项 / 需重审（独立查询，供界面直接调用） ---------- */
app.post('/api/revisions/:rid/impact', (req, res) => {
  const rev = loadRevision(req.params.rid);
  if (!rev) return err(res, 404, '版本不存在');
  const newEval = evaluate(req.body.spec || {}, materialMap());
  const diff = diffSpecs({ derived: rev.derived_json, bom: rev.bom_json, quote: rev.quote_json }, newEval, materialMap());
  res.json({ diff, evaluation: newEval });
});

/* ---------- 发布授权（独立快照，剥离私人信息） ---------- */
app.post('/api/revisions/:rid/publish', (req, res) => {
  const rev = loadRevision(req.params.rid);
  if (!rev) return err(res, 404, '版本不存在');
  const p = loadProject(rev.project_id);
  const actor = actorOf(req);
  if (actor.role !== 'customer') return err(res, 403, '发布必须由客户单独授权');
  if (rev.status !== 'confirmed')
    return err(res, 409, '仅已确认（被批准且报价绑定）的版本可授权发布；被取代版本不发布');

  // 公开快照：白名单式拷贝，budget / address / customer_name 永不进入
  const mats = materialMap();
  const e = evaluate(rev.spec_json, mats);
  const snapshot = {
    title: req.body.public_title || p.title,
    material: rev.bom_json.find(b => b.material !== '五金')?.material || null,
    finish: { oil: '木蜡油', lacquer: '清漆', paint: '混油色漆' }[rev.spec_json.finish] || rev.spec_json.finish,
    size: `${e.normalized.width_mm} × ${e.normalized.height_mm} × ${e.normalized.depth_mm} mm`,
    story: req.body.story || '',
    photo: req.body.photo || null,
    spec: { width_mm: e.normalized.width_mm, height_mm: e.normalized.height_mm, depth_mm: e.normalized.depth_mm }
  };
  // 安全断言：快照中不含私人字段
  const raw = JSON.stringify(snapshot);
  if (p.budget != null && raw.includes(String(p.budget))) return err(res, 500, '发布快照异常包含预算，已拦截');
  if (p.address && raw.includes(p.address)) return err(res, 500, '发布快照异常包含地址，已拦截');

  const pubId = id('pub');
  const authText = req.body.authorization_text || '我授权以匿名方式公开作品照片、尺寸区间、材料与工艺说明；明确不公开预算、地址与姓名。';
  run(`INSERT INTO publications (id,project_id,revision_id,authorization_text,authorized_by,authorized_at,snapshot_json,status)
       VALUES (?,?,?,?,?,?,?,?)`,
    [pubId, p.id, rev.id, authText, actor.name || '客户', now(), JSON.stringify(snapshot), 'authorized']);
  log(actor.name, 'authorize_publication', 'publication', pubId, { revision: rev.id });
  res.json({ ok: true, publication_id: pubId, snapshot, private_fields_excluded: ['budget', 'address', 'customer_name'] });
});


app.post('/api/publications/:pubId/revoke', (req, res) => {
  const pub = get('SELECT * FROM publications WHERE id=?', [req.params.pubId]);
  if (!pub) return err(res, 404, '发布不存在');
  if (actorOf(req).role !== 'customer') return err(res, 403, '仅授权方可撤销');
  run("UPDATE publications SET status='revoked', revoked_at=? WHERE id=?", [now(), pub.id]);
  log(actorOf(req).name, 'revoke_publication', 'publication', pub.id, {});
  res.json({ ok: true, status: 'revoked' });
});

/* ---------- 交付包：锁定到实际采用的图纸与说明 ---------- */
app.post('/api/revisions/:rid/deliver', (req, res) => {
  const rev = loadRevision(req.params.rid);
  if (!rev) return err(res, 404, '版本不存在');
  if (rev.status !== 'confirmed') return err(res, 409, '仅已确认版本可生成交付包');
  const wo = get("SELECT * FROM work_orders WHERE revision_id=?", [rev.id]);
  if (!wo || wo.status !== 'done') return err(res, 409, '工单需已完成才能交付', { hint: '演示可先调用 /api/work-orders/:id/complete' });

  const attachments = all('SELECT * FROM attachments WHERE revision_id=? ORDER BY uploaded_at', [rev.id]);
  const locked = [], lateUnacked = [], lateAckedSupp = [];
  for (const a of attachments) {
    if (!a.arrived_after) locked.push(a);
    else if (!a.acknowledged) lateUnacked.push(a);
    else lateAckedSupp.push(a);
  }
  if (lateUnacked.length) {
    return err(res, 409, '存在未确认的晚到附件，不能封包交付', {
      code: 'LATE_UNACKED',
      items: lateUnacked.map(a => ({ attachment_id: a.id, filename: a.filename, arrived_after: a.arrived_after })),
      instruction: '先由双方确认收件；图纸/保养类需另起修订重审，或作为补充确认页附入。'
    });
  }

  const drawings = all('SELECT * FROM drawing_reviews WHERE revision_id=? AND decision=?', [rev.id, 'pass']);
  const manifest = {
    package_for: { project_id: rev.project_id, revision_id: rev.id, rev_no: rev.rev_no },
    bound_at_confirmation: {
      quote_total: rev.quote_json.total,
      lead_workdays: rev.quote_json.lead_workdays,
      care: rev.quote_json.care
    },
    adopted_drawings: drawings.map(d => ({ drawing_no: d.drawing_no, reviewer: d.reviewer, reviewed_at: d.reviewed_at, note: d.note })),
    adopted_spec: (() => { const e = evaluate(rev.spec_json, materialMap()); return { normalized: e.normalized, derived: e.derived, bom: e.bom }; })(),
    attachments_locked_before_cutoff: locked.map(a => ({ id: a.id, kind: a.kind, filename: a.filename, hash: a.content_hash, uploaded_at: a.uploaded_at })),
    late_supplements_acknowledged: lateAckedSupp.map(a => ({ id: a.id, kind: a.kind, filename: a.filename, hash: a.content_hash, arrived_after: a.arrived_after, note: '晚到附件，经双方确认，作为补充留档' })),
    traceability: '本交付包逐项可追到实际采用的图纸图号、批准版本的报价/交期/保养，以及附件哈希。',
    generated_at: now()
  };
  const dpId = id('dp');
  run('INSERT INTO delivery_packages (id,project_id,revision_id,manifest_json,created_at,delivered) VALUES (?,?,?,?,?,1)',
    [dpId, rev.project_id, rev.id, JSON.stringify(manifest), now()]);
  log(actorOf(req).name, 'deliver_package', 'delivery_package', dpId, { revision: rev.id });
  res.json({ ok: true, delivery_package_id: dpId, manifest });
});

app.get('/api/delivery-packages/:dpid', (req, res) => {
  const dp = get('SELECT * FROM delivery_packages WHERE id=?', [req.params.dpid]);
  if (!dp) return err(res, 404, '交付包不存在');
  res.json({ ...dp, manifest_json: JSON.parse(dp.manifest_json) });
});

// 工单完成（演示辅助）
app.post('/api/work-orders/:wid/complete', (req, res) => {
  const wo = get('SELECT * FROM work_orders WHERE id=?', [req.params.wid]);
  if (!wo || wo.status !== 'started') return err(res, 409, '只有进行中的工单可完成');
  run("UPDATE work_orders SET status='done' WHERE id=?", [wo.id]);
  log(actorOf(req).name, 'complete_work_order', 'work_order', wo.id, {});
  res.json({ ok: true, status: 'done' });
});

const PORT = process.env.PORT || 3000;
init().then(() => {
  seed();
  app.listen(PORT, () => console.log(`木作定制站 listening on http://localhost:${PORT}`));
});
