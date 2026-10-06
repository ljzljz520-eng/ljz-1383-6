/* 七个验收场景：真实端到端调用 API。浏览器版与 test/acceptance.js 逻辑一致。 */
async function mkProject(api, log, suffix, spec) {
  const title = `验收-${suffix}-${Date.now().toString().slice(-4)}`;
  const pr = await api('/api/projects', { method: 'POST', body: JSON.stringify({
    title, customer_name: '验收客户', budget: 5200, address: '私人地址：某市某区 Secret-Road-88' }) });
  const rr = await api(`/api/projects/${pr.project_id}/revisions`, { method: 'POST', body: JSON.stringify({ spec }) });
  log(`建项目 ${pr.project_id}，第 1 版 ${rr.revision_id}（含私人预算 5200 与私密地址）`);
  return { pid: pr.project_id, rid: rr.revision_id, eval0: rr.evaluation };
}
async function approveAndConfirm(api, log, rid, drawingNo) {
  setRole('shop'); await api(`/api/revisions/${rid}/submit`, { method: 'POST', body: '{}' });
  await api(`/api/revisions/${rid}/drawing-review`, { method: 'POST', body: JSON.stringify({ decision: 'pass', drawing_no: drawingNo, note: '验收通过' }) });
  setRole('customer'); const c = await api(`/api/revisions/${rid}/confirm`, { method: 'POST', body: '{}' });
  log(`审批+确认完成：绑定报价 ¥${c.bound.quote}，交期 ${c.bound.lead_workdays} 工作日`);
  return c;
}
function setRole(r) { $('#actorRole').value = r; $('#actorName').value = r === 'shop' ? 'master-zhou' : 'acceptance-customer'; }
const expect = (cond, msg) => { if (!cond) throw new Error('断言失败：' + msg); };

window.scenarios = {
  mixed_units: {
    title: '毫米/英寸混填 + 超约束诊断',
    async run(log, api) {
      setRole('customer');
      // 宽用英寸、深用英寸、高毫米；再故意把门宽覆盖成错误值
      const spec = { width: { value: 36, unit: 'in' }, height: 1800, depth: { value: 15, unit: 'in' },
        shelf_count: 3, door_count: 2, material: 'oak', finish: 'oil', door_width_override: 500 };
      const r = await api('/api/calc', { method: 'POST', body: JSON.stringify({ spec }) });
      log(`36 in = ${r.normalized.width_mm} mm（期望 914.4）；15 in = ${r.normalized.depth_mm} mm（期望 381）`);
      expect(Math.abs(r.normalized.width_mm - 914.4) < 0.1, '英寸→毫米换算错误');
      const conflict = r.issues.find(i => i.code === 'OVERCONFLICT');
      expect(conflict, '未检测出门宽超约束冲突');
      const door = r.derived.find(d => d.key === 'door_width').value;
      log(`派生门板宽 ${door} mm；用户只手改门宽为 500mm →`, 'err');
      log(`诊断：${conflict.message}`);
      log(`修复建议：${conflict.fix}`);
      // 按建议删除覆盖值 → 一致
      delete spec.door_width_override;
      const r2 = await api('/api/calc', { method: 'POST', body: JSON.stringify({ spec }) });
      expect(!r2.issues.some(i => i.code === 'OVERCONFLICT'), '删除覆盖后仍报冲突');
      log('删除覆盖值、让门宽随外宽派生后，冲突消除 ✅', 'ok');
    }
  },

  concurrent: {
    title: '双方同时改稿：审批锁定 + 版本冲突',
    async run(log, api) {
      setRole('customer');
      const { rid } = await mkProject(api, log, '并发', { width: 800, height: 1800, depth: 400, shelf_count: 2, door_count: 2, material: 'ash', finish: 'lacquer' });
      await api(`/api/revisions/${rid}/submit`, { method: 'POST', body: '{}' });
      log('客户已提交审批，版本锁定');
      setRole('shop');
      // 工坊在锁定态直接改 → 409
      try {
        await api(`/api/revisions/${rid}/spec`, { method: 'PUT', body: JSON.stringify({ spec: { width: 810, height: 1800, depth: 400, shelf_count: 2, door_count: 2, material: 'ash', finish: 'lacquer' } }) });
        throw new Error('锁定态竟允许改稿');
      } catch (e) {
        expect(e.status === 409 && e.data.code === 'LOCKED_PENDING_REVIEW', '应返回 LOCKED_PENDING_REVIEW');
        log(`工坊在 pending_review 改稿被拒：${e.message}（${e.data.code}）`, 'ok');
      }
      // 退稿后双方都可改；模拟陈旧 If-Match
      await api(`/api/revisions/${rid}/request-changes`, { method: 'POST', body: JSON.stringify({ comment: '门缝需调' }) });
      setRole('customer');
      await api(`/api/revisions/${rid}/spec`, { method: 'PUT', body: JSON.stringify({ spec: { width: 820, height: 1800, depth: 400, shelf_count: 2, door_count: 2, material: 'ash', finish: 'lacquer' }, reason: '客户先改' }) });
      log('客户已先把宽度改为 820');
      setRole('shop');
      try {
        await api(`/api/revisions/${rid}/spec`, { method: 'PUT',
          headers: { 'If-Match': '0' },
          body: JSON.stringify({ expected_rev: '0', spec: { width: 830, height: 1800, depth: 400, shelf_count: 2, door_count: 2, material: 'ash', finish: 'lacquer' } }) });
        throw new Error('陈旧编辑竟被接受');
      } catch (e) {
        expect(e.status === 409 && e.data.code === 'STALE_EDIT', '应返回 STALE_EDIT');
        log(`工坊基于旧稿的修改被拒：${e.message}，并返回对方改动供合并`, 'ok');
      }
    }
  },

  substitute: {
    title: '材料替代：跨距重算、报价重批、旧确认失效',
    async run(log, api) {
      setRole('customer');
      const { rid } = await mkProject(api, log, '替代', { width: 850, height: 1900, depth: 380, shelf_count: 4, door_count: 2, material: 'oak', finish: 'oil' });
      const c = await approveAndConfirm(api, log, rid, 'SH-SUB-01');
      // 替代为松木（最大跨距 600）
      const r = await api(`/api/revisions/${rid}/substitute`, { method: 'POST', body: JSON.stringify({ material: 'pine', note: '降本' }) });
      log(`替代 oak→pine，生成第 ${r.rev_no} 版；旧版：${r.invalidation.old_status} → superseded`);
      expect(!!r.invalidation, '缺少旧确认失效说明');
      const spanErr = r.evaluation.issues.find(i => i.code === 'SPAN_EXCEEDED');
      log(spanErr ? `跨距约束触发：${spanErr.message}` : '跨距未超限（松木 600mm 上限，当前层板更宽时应报错）');
      log(`受影响项：${r.diff.affectedDerived.map(d => d.label).join('、') || '尺寸无变化'}`);
      log(`需重审：${r.diff.recheck.slice(0, 3).join('；')}`);
      log('材料替代不就地覆盖已确认版本，而是新版本重新审批 ✅', 'ok');
    }
  },

  cancel: {
    title: '工单已启动后撤销：系统不自动撤销，人工评估',
    async run(log, api) {
      setRole('customer');
      const { rid } = await mkProject(api, log, '撤销', { width: 700, height: 1600, depth: 360, shelf_count: 2, door_count: 2, material: 'birch_ply', finish: 'lacquer' });
      await approveAndConfirm(api, log, rid, 'SH-CAN-01');
      setRole('shop'); const wo = await api(`/api/revisions/${rid}/work-order`, { method: 'POST', body: '{}' });
      log('工单已启动：' + wo.work_order_id);
      // 开工后改尺寸被拒
      try {
        await api(`/api/revisions/${rid}/spec`, { method: 'PUT', body: JSON.stringify({ spec: { width: 760, height: 1600, depth: 360, shelf_count: 2, door_count: 2, material: 'birch_ply', finish: 'lacquer' } }) });
        throw new Error('开工后竟允许直接改尺寸');
      } catch (e) { expect(e.data.code === 'WORK_ORDER_STARTED', '应被 WORK_ORDER_STARTED 拦截'); log(`开工后改尺寸被拦截：${e.message}`, 'ok'); }
      // 客户申请撤销
      setRole('customer');
      const cr = await api(`/api/work-orders/${wo.work_order_id}/cancellation-request`, { method: 'POST', body: JSON.stringify({ reason: '装修方案变更' }) });
      log(cr.message);
      // 工坊评估：同意，计成本，工单 cancelled
      setRole('shop');
      const a = await api(`/api/cancellation-requests/${cr.cancellation_request_id}/assess`, { method: 'POST', body: JSON.stringify({ decision: 'granted', assessed_cost: 320 }) });
      expect(a.work_order_status === 'cancelled', '工单应已撤销');
      log(`工坊评估同意撤销，已下料/工时成本 ¥320，工单状态=${a.work_order_status}`, 'ok');
    }
  },

  late: {
    title: '附件晚到：锁定后来件 → 双方确认 → 才可入交付包',
    async run(log, api) {
      setRole('customer');
      const { rid } = await mkProject(api, log, '晚到', { width: 760, height: 1700, depth: 370, shelf_count: 3, door_count: 2, material: 'oak', finish: 'oil' });
      // 锁定前附件
      const a0 = await api(`/api/revisions/${rid}/attachments`, { method: 'POST', body: JSON.stringify({ kind: 'drawing', filename: '初版开料图.pdf', content: 'v1' }) });
      expect(!a0.late, '初版附件不应标记晚到');
      await approveAndConfirm(api, log, rid, 'SH-LATE-01');
      setRole('shop'); const wo = await api(`/api/revisions/${rid}/work-order`, { method: 'POST', body: '{}' });
      await api(`/api/work-orders/${wo.work_order_id}/complete`, { method: 'POST', body: '{}' });
      // 开工后才来的节点图
      const a1 = await api(`/api/revisions/${rid}/attachments`, { method: 'POST', body: JSON.stringify({ kind: 'drawing', filename: '背板开槽节点-迟到.pdf', content: 'late1', late_reason: '供应商图纸延迟' }) });
      expect(a1.late && a1.arrived_after === 'work_done', '应识别为完工后晚到');
      log(`晚到附件阶段=${a1.arrived_after}；受影响：${a1.impact.affected.join('、')}`);
      // 未确认就封包 → 拒绝
      try {
        await api(`/api/revisions/${rid}/deliver`, { method: 'POST', body: '{}' });
        throw new Error('未确认晚到附件竟可封包');
      } catch (e) { expect(e.data.code === 'LATE_UNACKED', '应 LATE_UNACKED'); log(`封包被拦截：${e.data.items[0].filename} 待确认`, 'ok'); }
      await api(`/api/attachments/${a1.attachment_id}/acknowledge`, { method: 'POST', body: '{}' });
      log('双方确认收件（图纸类另起修订重审，本例作为补充留档演示）');
      const dp = await api(`/api/revisions/${rid}/deliver`, { method: 'POST', body: '{}' });
      expect(dp.manifest.attachments_locked_before_cutoff.length === 1, '锁定前附件应=1');
      expect(dp.manifest.late_supplements_acknowledged.length === 1, '晚到补充应=1');
      log(`交付包生成：锁定前 1 件、确认晚到补充 1 件，均带哈希可追溯`, 'ok');
    }
  },

  resize: {
    title: '客户改尺寸：旧确认失效 + 受影响项/重审清单',
    async run(log, api) {
      setRole('customer');
      const { rid, eval0 } = await mkProject(api, log, '改尺寸', { width: 900, height: 2000, depth: 380, shelf_count: 4, door_count: 2, material: 'oak', finish: 'oil' });
      await approveAndConfirm(api, log, rid, 'SH-RES-01');
      const before = (await api('/api/revisions/' + rid, { method: 'GET' })).quote_json.total;
      // 外宽 900 → 1100（其余保持），看级联
      const r = await api(`/api/revisions/${rid}/spec`, { method: 'PUT', body: JSON.stringify({ spec: { width: 1100, height: 2000, depth: 380, shelf_count: 4, door_count: 2, material: 'oak', finish: 'oil' }, reason: '墙面多出 20cm' }) });
      expect(r.mode === 'new_revision' && r.invalidation, '应生成新版本并声明旧确认失效');
      log(`外宽 900→1100mm，生成第 ${r.rev_no} 版，旧版 superseded`);
      log('受影响派生项：');
      r.diff.affectedDerived.forEach(d => log(`   · ${d.label} ${d.from}→${d.to}mm  [${d.formula}]`));
      expect(r.diff.affectedDerived.some(d => d.key === 'door_width'), '门板宽应受影响');
      expect(r.diff.affectedDerived.some(d => d.key === 'shelf_width'), '层板宽应受影响');
      expect(r.diff.priceChanged, '报价应变化');
      log(`BOM 变化 ${r.diff.bomChanges.length} 项；新报价 ¥${r.evaluation.quote.total}（旧 ¥${before}）`);
      log('需重审：' + r.diff.recheck.join('；'));
      log(r.invalidation.message, 'err');
    }
  },

  privacy: {
    title: '私人预算/地址不泄漏 + 交付包可追溯',
    async run(log, api) {
      setRole('customer');
      const { rid } = await mkProject(api, log, '隐私', { width: 820, height: 1850, depth: 380, shelf_count: 3, door_count: 2, material: 'walnut', finish: 'oil' });
      await approveAndConfirm(api, log, rid, 'SH-PRIV-01');
      // 授权发布
      const pub = await api(`/api/revisions/${rid}/publish`, { method: 'POST', body: JSON.stringify({ public_title: '公开验收柜', story: '匿名故事' }) });
      const snap = JSON.stringify(pub.snapshot);
      expect(!snap.includes('5200') && !snap.includes('Secret-Road') && !snap.includes('验收客户'), '公开快照泄漏私人信息');
      log('公开快照已剔除预算 5200 / 地址 Secret-Road-88 / 客户姓名 ✅', 'ok');
      // 公开案例接口再验
      const cases = await api('/api/cases', { method: 'GET' });
      const raw = JSON.stringify(cases);
      expect(!raw.includes('Secret-Road') && !raw.includes('"budget"'), '/api/cases 泄漏私人字段');
      log('/api/cases 公开列表中无预算与地址字段 ✅', 'ok');
      // 交付追溯
      setRole('shop'); const wo = await api(`/api/revisions/${rid}/work-order`, { method: 'POST', body: '{}' });
      await api(`/api/work-orders/${wo.work_order_id}/complete`, { method: 'POST', body: '{}' });
      const dp = await api(`/api/revisions/${rid}/deliver`, { method: 'POST', body: '{}' });
      const m = dp.manifest;
      expect(m.adopted_drawings[0].drawing_no === 'SH-PRIV-01', '交付包未记录实际采用图纸');
      expect(m.bound_at_confirmation.quote_total > 0 && m.bound_at_confirmation.care, '交付包未绑定报价与保养');
      log(`交付包追溯：图纸 ${m.adopted_drawings.map(d => d.drawing_no).join(',')}；报价 ¥${m.bound_at_confirmation.quote_total}；保养随版；附件带哈希`, 'ok');
      // 撤销发布（须切回客户身份）
      setRole('customer');
      await api(`/api/publications/${pub.publication_id}/revoke`, { method: 'POST', body: '{}' });
      const cases2 = await api('/api/cases', { method: 'GET' });
      expect(!cases2.find(c => c.publication_id === pub.publication_id), '撤销后仍公开');
      log('客户撤销授权后，该案例立即从公开列表移除 ✅', 'ok');
    }
  }
};
