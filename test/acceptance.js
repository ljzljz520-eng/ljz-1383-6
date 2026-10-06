/* 端到端验收：node test/acceptance.js
 * 覆盖：毫米英寸混填/超约束 · 双方同时改稿 · 材料替代 · 工单启动后撤销
 *       · 附件晚到 · 改尺寸失效 · 私人信息保护与交付追溯
 */
const BASE = process.env.BASE || 'http://localhost:3000';
let passed = 0;
const ok = (c, m) => { if (!c) throw new Error('断言失败: ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(method, url, body, actor = { role: 'customer', name: 'acceptance-customer' }, extraHeaders = {}) {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-actor-role': actor.role, 'x-actor-name': actor.name, ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data, ok: r.ok };
}
const SHOP = { role: 'shop', name: 'master-zhou' };
const CUST = { role: 'customer', name: 'acceptance-customer' };

async function mkProject(tag, spec) {
  const t = await call('POST', '/api/projects', { title: `验收-${tag}`, customer_name: '验收客户', budget: 5200, address: '私人地址 Secret-Road-88' }, CUST);
  const rv = await call('POST', `/api/projects/${t.data.project_id}/revisions`, { spec }, CUST);
  return { pid: t.data.project_id, rid: rv.data.revision_id };
}
async function approveFlow(rid, drawingNo) {
  await call('POST', `/api/revisions/${rid}/submit`, {}, CUST);
  await call('POST', `/api/revisions/${rid}/drawing-review`, { decision: 'pass', drawing_no: drawingNo, note: '验收通过' }, SHOP);
  return call('POST', `/api/revisions/${rid}/confirm`, {}, CUST);
}
async function section(name, fn) {
  process.stdout.write(`\n▶ ${name} ... `);
  try { await fn(); passed++; console.log('✅'); }
  catch (e) { console.log('❌', e.message); process.exitCode = 1; }
}

(async () => {
  // 0. 健康
  const h = await call('GET', '/api/materials');
  ok(h.ok && h.data.length === 5, '材料目录应就绪');

  await section('1) 毫米/英寸混填 + 超约束诊断', async () => {
    let r = await call('POST', '/api/calc', { spec: { width: { value: 36, unit: 'in' }, height: 1800, depth: { value: 15, unit: 'in' }, shelf_count: 3, door_count: 2, material: 'oak', finish: 'oil', door_width_override: 500 } });
    ok(Math.abs(r.data.normalized.width_mm - 914.4) < 0.1, '36in=914.4mm');
    ok(Math.abs(r.data.normalized.depth_mm - 381) < 0.1, '15in=381mm');
    const c = r.data.issues.find(i => i.code === 'OVERCONFLICT');
    ok(c, '应报告门宽超约束');
    ok(/不能只手改/.test(c.message) && /删除/.test(c.fix), '诊断须可解释并给出解除方式');
    r = await call('POST', '/api/calc', { spec: { width: { value: 36, unit: 'in' }, height: 1800, depth: { value: 15, unit: 'in' }, shelf_count: 3, door_count: 2, material: 'oak', finish: 'oil' } });
    ok(!r.data.issues.some(i => i.code === 'OVERCONFLICT'), '删除覆盖后冲突应消失');
  });

  await section('2) 双方同时改稿：审批锁定 + 陈旧编辑冲突', async () => {
    const { rid } = await mkProject('并发', { width: 800, height: 1800, depth: 400, shelf_count: 2, door_count: 2, material: 'ash', finish: 'lacquer' });
    await call('POST', `/api/revisions/${rid}/submit`, {}, CUST);
    let r = await call('PUT', `/api/revisions/${rid}/spec`, { spec: { width: 810, height: 1800, depth: 400, shelf_count: 2, door_count: 2, material: 'ash', finish: 'lacquer' } }, SHOP);
    ok(r.status === 409 && r.data.code === 'LOCKED_PENDING_REVIEW', '锁定态禁止直接改');
    await call('POST', `/api/revisions/${rid}/request-changes`, { comment: '门缝需调' }, SHOP);
    await call('PUT', `/api/revisions/${rid}/spec`, { spec: { width: 820, height: 1800, depth: 400, shelf_count: 2, door_count: 2, material: 'ash', finish: 'lacquer' }, reason: '客户先改' }, CUST);
    r = await call('PUT', `/api/revisions/${rid}/spec`, { expected_rev: '0', spec: { width: 830, height: 1800, depth: 400, shelf_count: 2, door_count: 2, material: 'ash', finish: 'lacquer' } }, SHOP);
    ok(r.status === 409 && r.data.code === 'STALE_EDIT', '陈旧编辑应冲突并返回对方改动');
    ok(r.data.server_changes.length >= 1, '应携带服务端变更供合并');
  });

  await section('3) 材料替代：重算/重批/旧确认失效', async () => {
    const { rid } = await mkProject('替代', { width: 850, height: 1900, depth: 380, shelf_count: 4, door_count: 2, material: 'oak', finish: 'oil' });
    await approveFlow(rid, 'SH-SUB-01');
    const r = await call('POST', `/api/revisions/${rid}/substitute`, { material: 'pine', note: '降本' }, CUST);
    ok(r.ok && r.data.invalidation, '替代须声明旧确认失效');
    const old = await call('GET', `/api/revisions/${rid}`);
    ok(old.data.status === 'superseded', '旧版应置为 superseded');
    ok(r.data.diff.recheck.some(x => /保养/.test(x)), '须提示保养随材料重审');
  });

  await section('4) 工单启动后撤销：人工评估而非自动撤销', async () => {
    const { rid } = await mkProject('撤销', { width: 700, height: 1600, depth: 360, shelf_count: 2, door_count: 2, material: 'birch_ply', finish: 'lacquer' });
    await approveFlow(rid, 'SH-CAN-01');
    const wo = await call('POST', `/api/revisions/${rid}/work-order`, {}, SHOP);
    let r = await call('PUT', `/api/revisions/${rid}/spec`, { spec: { width: 760, height: 1600, depth: 360, shelf_count: 2, door_count: 2, material: 'birch_ply', finish: 'lacquer' } }, CUST);
    ok(r.status === 409 && r.data.code === 'WORK_ORDER_STARTED', '开工后改尺寸须先撤销评估');
    const cr = await call('POST', `/api/work-orders/${wo.data.work_order_id}/cancellation-request`, { reason: '方案变更' }, CUST);
    ok(cr.data.decision === 'pending', '撤销先挂起评估');
    const asr = await call('POST', `/api/cancellation-requests/${cr.data.cancellation_request_id}/assess`, { decision: 'granted', assessed_cost: 320 }, SHOP);
    ok(asr.data.work_order_status === 'cancelled', '评估通过后工单撤销');
  });

  await section('5) 附件晚到：确认后才入交付包', async () => {
    const { rid } = await mkProject('晚到', { width: 760, height: 1700, depth: 370, shelf_count: 3, door_count: 2, material: 'oak', finish: 'oil' });
    const a0 = await call('POST', `/api/revisions/${rid}/attachments`, { kind: 'drawing', filename: '初版开料图.pdf', content: 'v1' }, SHOP);
    ok(!a0.data.late, '锁定前附件不算晚到');
    await approveFlow(rid, 'SH-LATE-01');
    const wo = await call('POST', `/api/revisions/${rid}/work-order`, {}, SHOP);
    await call('POST', `/api/work-orders/${wo.data.work_order_id}/complete`, {}, SHOP);
    const a1 = await call('POST', `/api/revisions/${rid}/attachments`, { kind: 'drawing', filename: '迟到节点图.pdf', content: 'late', late_reason: '供应商延迟' }, SHOP);
    ok(a1.data.late && a1.data.arrived_after === 'work_done', '应识别完工后晚到');
    let dp = await call('POST', `/api/revisions/${rid}/deliver`, {}, SHOP);
    ok(dp.status === 409 && dp.data.code === 'LATE_UNACKED', '未确认晚到附件禁止封包');
    await call('POST', `/api/attachments/${a1.data.attachment_id}/acknowledge`, {}, CUST);
    dp = await call('POST', `/api/revisions/${rid}/deliver`, {}, SHOP);
    ok(dp.ok, '确认后可以封包');
    ok(dp.data.manifest.attachments_locked_before_cutoff.length === 1 && dp.data.manifest.late_supplements_acknowledged.length === 1, '交付包区分锁定前/晚到补充');
  });

  await section('6) 改尺寸：受影响项 + 旧确认失效 + 报价重算', async () => {
    const { rid } = await mkProject('改尺寸', { width: 900, height: 2000, depth: 380, shelf_count: 4, door_count: 2, material: 'oak', finish: 'oil' });
    await approveFlow(rid, 'SH-RES-01');
    const before = (await call('GET', `/api/revisions/${rid}`)).data.quote_json.total;
    const r = await call('PUT', `/api/revisions/${rid}/spec`, { spec: { width: 1100, height: 2000, depth: 380, shelf_count: 4, door_count: 2, material: 'oak', finish: 'oil' }, reason: '墙面多 20cm' }, CUST);
    ok(r.data.mode === 'new_revision' && r.data.invalidation, '确认后改尺寸须出版本并失效旧确认');
    const keys = r.data.diff.affectedDerived.map(d => d.key);
    ok(keys.includes('door_width') && keys.includes('shelf_width') && keys.includes('inner_width'), '门宽/层板/内宽必须联动');
    ok(r.data.diff.priceChanged && r.data.evaluation.quote.total !== before, '报价必须重算');
    const old = await call('GET', `/api/revisions/${rid}`);
    ok(old.data.status === 'superseded', '旧版本 superseded');
  });

  await section('7) 私人预算/地址不公开 + 发布快照 + 交付追溯 + 撤销', async () => {
    const { rid } = await mkProject('隐私', { width: 820, height: 1850, depth: 380, shelf_count: 3, door_count: 2, material: 'walnut', finish: 'oil' });
    await approveFlow(rid, 'SH-PRIV-01');
    const pub = await call('POST', `/api/revisions/${rid}/publish`, { public_title: '公开验收柜', story: '匿名故事' }, CUST);
    ok(pub.ok, '客户授权发布');
    const snap = JSON.stringify(pub.data.snapshot);
    ok(!snap.includes('5200') && !snap.includes('Secret-Road') && !snap.includes('验收客户'), '快照不得含预算/地址/姓名');
    const cases = await call('GET', '/api/cases');
    const raw = JSON.stringify(cases.data);
    ok(raw.includes('公开验收柜') && !raw.includes('Secret-Road') && !raw.includes('5200'), '公开列表含案例但不含隐私');
    const wo = await call('POST', `/api/revisions/${rid}/work-order`, {}, SHOP);
    await call('POST', `/api/work-orders/${wo.data.work_order_id}/complete`, {}, SHOP);
    const dp = await call('POST', `/api/revisions/${rid}/deliver`, {}, SHOP);
    ok(dp.data.manifest.adopted_drawings[0].drawing_no === 'SH-PRIV-01', '交付包须追到实际图纸');
    ok(dp.data.manifest.bound_at_confirmation.quote_total && dp.data.manifest.bound_at_confirmation.care, '交付包绑定报价与保养');
    await call('POST', `/api/publications/${pub.data.publication_id}/revoke`, {}, CUST);
    const cases2 = await call('GET', '/api/cases');
    ok(!JSON.stringify(cases2.data).includes('公开验收柜'), '撤销后案例下架');
  });

  console.log(`\n结果：${passed}/7 个场景通过`);
})();
