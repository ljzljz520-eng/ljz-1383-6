/* 榫隅木作 前端 */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const state = { project: null, revisions: [], currentRev: null, lastEval: null, materials: {} };

async function api(url, opts = {}) {
  const displayName = $('#actorName').value || '-';
  // HTTP 头只能 Latin-1，显示名放 body.actor_name
  const headers = { 'Content-Type': 'application/json',
    'x-actor-role': $('#actorRole').value, 'x-actor-name': 'user' };
  let payload = opts.body;
  if (payload && typeof payload === 'string') {
    try { const o = JSON.parse(payload); if (typeof o === 'object') { o.actor_name = displayName; o.actor_role = $('#actorRole').value; } payload = JSON.stringify(o); } catch (e) {}
  }
  const r = await fetch(url, { ...opts, headers: { ...headers, ...(opts.headers || {}) }, body: payload });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status, data });
  return data;
}
const actor = () => ({ role: $('#actorRole').value, name: $('#actorName').value || '-' });

/* ---------- Tab 切换 ---------- */
$$('.navbtn').forEach(b => b.onclick = () => {
  $$('.navbtn').forEach(x => x.classList.remove('active'));
  $$('.tab').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  $('#tab-' + b.dataset.tab).classList.add('active');
  if (b.dataset.tab === 'gallery') loadGallery();
  if (b.dataset.tab === 'process') loadProcess();
});

/* ---------- 材料 ---------- */
async function loadMaterials() {
  const list = await api('/api/materials');
  state.materials = Object.fromEntries(list.map(m => [m.id, m]));
  $('#material').innerHTML = list.map(m =>
    `<option value="${m.id}">${m.name} · ¥${m.unit_price}/m² · 最大跨距${m.max_span_mm}mm · 备料${m.lead_days}d</option>`).join('');
}

/* ---------- 公开案例 ---------- */
async function loadGallery() {
  const [cases, mats] = await Promise.all([api('/api/cases'), api('/api/materials')]);
  $('#caseGrid').innerHTML = cases.length ? cases.map(c => `
    <div class="case-card">
      <div class="case-photo">🪵</div>
      <div class="case-body">
        <h3>${esc(c.title)}</h3>
        <div class="case-meta">材料：${esc(c.material || '-')} ｜ 涂饰：${esc(c.finish || '-')}</div>
        <div class="case-meta">尺寸：${esc(c.size || '-')}</div>
        <div class="case-meta">${esc(c.story || '')}</div>
        <div class="privacy-note">🔒 来自客户授权的公开快照（${new Date(c.authorized_at).toLocaleDateString()}）；不含预算、地址、姓名。</div>
      </div>
    </div>`).join('') : '<p class="muted">暂无授权公开案例。</p>';

  $('#materialGrid').innerHTML = mats.map(m => `
    <div class="case-card">
      <div class="case-body">
        <h3>${esc(m.name)}</h3>
        <div class="case-meta">产地：${esc(m.origin)} ｜ 密度：${esc(m.density)}</div>
        <div class="case-meta">单价：¥${m.unit_price}/m² ｜ 备货：${m.lead_days} 个工作日</div>
        <div class="case-meta">库存料：${m.stock_width_mm}×${m.stock_length_mm} mm</div>
        <div class="case-meta">活动层板最大跨距：<strong>${m.max_span_mm} mm</strong>（超出即自动报警）</div>
        <div class="case-meta">${esc(m.care_note)}</div>
      </div>
    </div>`).join('');
}

/* ---------- 流程说明 ---------- */
async function loadProcess() {
  const p = await api('/api/process-info');
  $('#processInfo').innerHTML = `
    <div class="process-card">
      <h3>✅ ${p.parametric.title}</h3>
      <ul>${p.parametric.scope.map(x => `<li>${x}</li>`).join('')}</ul>
      <p class="hint">${p.parametric.limit}</p>
    </div>
    <div class="process-card">
      <h3>✍️ ${p.manual.title}</h3>
      <ul>${p.manual.scope.map(x => `<li>${x}</li>`).join('')}</ul>
      <p class="hint">图纸：${p.manual.drawings.join('、')}</p>
    </div>
    <div class="process-card" style="grid-column:1/3">
      <h3>🔀 为什么是混合流程</h3>
      <p>${p.hybrid}</p>
    </div>
    <div class="danger" style="grid-column:1/3">
      <strong>⛔ 危险加工操作策略</strong>
      <p style="margin:6px 0">${p.dangerous_policy}</p>
      <p class="hint">系统不会自动给出：${p.dangerous_operations.join('；')}。</p>
    </div>`;
}

/* ---------- 规格输入 ---------- */
function readSpec() {
  const dim = (vSel, uSel) => {
    const v = Number($(vSel).value);
    return { value: v, unit: $(uSel).value };
  };
  const spec = {
    width: dim('#wVal', '#wUnit'), height: dim('#hVal', '#hUnit'), depth: dim('#dVal', '#dUnit'),
    door_count: Number($('#doorCount').value), shelf_count: Number($('#shelfCount').value),
    material: $('#material').value, finish: $('#finish').value
  };
  if ($('#doorOv').value.trim()) spec.door_width_override = { value: Number($('#doorOv').value), unit: 'mm' };
  if ($('#innerOv').value.trim()) spec.inner_width_override = { value: Number($('#innerOv').value), unit: 'mm' };
  return spec;
}
function fillFormFromSpec(s) {
  const setDim = (selV, selU, d) => { if (typeof d === 'object') { $(selV).value = d.value; $(selU).value = d.unit || 'mm'; } else { $(selV).value = d; $(selU).value = 'mm'; } };
  setDim('#wVal', '#wUnit', s.width); setDim('#hVal', '#hUnit', s.height); setDim('#dVal', '#dUnit', s.depth);
  $('#doorCount').value = s.door_count ?? 2; $('#shelfCount').value = s.shelf_count ?? 0;
  $('#material').value = s.material || 'oak'; $('#finish').value = s.finish || 'oil';
  $('#doorOv').value = s.door_width_override ? (s.door_width_override.value ?? '') : '';
  $('#innerOv').value = s.inner_width_override ? (s.inner_width_override.value ?? '') : '';
}

/* ---------- 试算渲染 ---------- */
function renderEval(e) {
  state.lastEval = e;
  const sevIcon = { error: '⛔', warning: '⚠️' };
  $('#issues').innerHTML = e.issues.length ? e.issues.map(i =>
    `<div class="issue ${i.severity}">${sevIcon[i.severity] || ''} <strong>${esc(i.message)}</strong><span class="fix">💡 建议：${esc(i.fix || '')}</span></div>`).join('')
    : '<div class="issue ok">✅ 依赖一致，无阻断性约束。</div>';

  $('#derivedTable').querySelector('tbody').innerHTML = e.derived.map(d =>
    `<tr><td>${esc(d.label)}</td><td><strong>${d.value}</strong> ${d.unit}</td>
     <td><div>${esc(d.formula)}</div>${d.note ? `<div class="formula">↳ ${esc(d.note)}</div>` : ''}</td></tr>`).join('');

  $('#bomTable').querySelector('tbody').innerHTML = e.bom.map(b =>
    `<tr><td>${esc(b.part)}</td><td>${esc(b.spec)}</td><td>${b.qty} ${b.unit}${b.note ? `<div class="formula">${esc(b.note)}</div>` : ''}</td>
     <td>${b.amount != null ? '¥' + b.amount.toFixed(2) : ''}</td></tr>`).join('');

  const q = e.quote;
  if (!q) $('#quoteBox').className = 'muted', $('#quoteBox').innerHTML = '无法报价。';
  else if (q.blocked) $('#quoteBox').innerHTML = `<div class="issue error">⛔ ${esc(q.reason)}</div>`;
  else {
    $('#quoteBox').className = '';
    $('#quoteBox').innerHTML = `
      <div class="quote-big">¥${q.total.toFixed(2)}</div>
      <div class="quote-grid">
        <div>材料 ¥${q.breakdown.material_cost.toFixed(2)}</div>
        <div>${esc(q.breakdown.finish)}人工 ¥${q.breakdown.finish_labor.toFixed(2)}</div>
        <div>管理损耗(18%) ¥${q.breakdown.overhead.toFixed(2)}</div>
        <div>交期 <strong>${q.lead_workdays}</strong> 个工作日</div>
      </div>
      <div class="care"><strong>保养：</strong>${esc(q.care)}</div>
      <div class="bound">🔒 ${esc(q.binding_note)}</div>`;
  }
}

$('#btnCalc').onclick = async () => {
  try { renderEval(await api('/api/calc', { method: 'POST', body: JSON.stringify({ spec: readSpec() }) })); }
  catch (e) { alert(e.message); }
};

/* ---------- 项目 ---------- */
$('#btnLoadDemo').onclick = async () => {
  const p = await api('/api/projects/demo');
  state.project = p.project; state.revisions = p.revisions;
  $('#budget').value = p.project.budget ?? ''; $('#address').value = p.project.address ?? '';
  renderProject(); renderRevList();
  if (p.revisions.length) selectRevision(p.revisions[p.revisions.length - 1].id);
};

$('#btnNewProject').onclick = async () => {
  const title = prompt('作品/项目名称', '我的定制柜');
  if (!title) return;
  const r = await api('/api/projects', { method: 'POST', body: JSON.stringify({
    title, customer_name: $('#actorName').value, budget: Number($('#budget').value) || null, address: $('#address').value || null }) });
  const p = await api('/api/projects/' + r.project_id);
  state.project = p.project; state.revisions = [];
  renderProject(); renderRevList();
  $('#projectInfo').innerHTML += '<br>已建项目，调好参数后点“存为新版本”。';
};

function renderProject() {
  $('#projectInfo').className = 'project-info';
  $('#projectInfo').innerHTML = `<strong>${esc(state.project.title)}</strong>
    <div class="muted">客户：${esc(state.project.customer_name || '—')} ｜ 预算/地址已作为<strong>私人字段</strong>存储，公开接口不会返回。</div>`;
}

/* ---------- 存版本 ---------- */
$('#btnSaveRev').onclick = async () => {
  if (!state.project) return alert('请先载入或新建项目');
  try {
    const r = await api(`/api/projects/${state.project.id}/revisions`, { method: 'POST', body: JSON.stringify({ spec: readSpec() }) });
    await reloadRevisions();
    selectRevision(r.revision_id);
    if (r.warning) alert(r.warning);
  } catch (e) { alert(e.message); }
};

async function reloadRevisions() {
  const p = await api('/api/projects/' + state.project.id);
  state.revisions = p.revisions;
  renderRevList();
}

function renderRevList() {
  if (!state.revisions.length) { $('#revList').innerHTML = '无版本'; $('#revList').className = 'revlist muted'; return; }
  $('#revList').className = 'revlist';
  $('#revList').innerHTML = state.revisions.map(r => `
    <div class="rev ${state.currentRev?.id === r.id ? 'current' : ''}" data-id="${r.id}">
      第 ${r.rev_no} 版 <span class="status ${r.status}">${statusZh(r.status)}</span>
      ${r.superseded_by ? '<span class="muted"> → 已被后继版取代</span>' : ''}
      <div class="muted">${r.created_by} · ${new Date(r.created_at).toLocaleString()}${r.locked_by ? ' ｜ 🔒 ' + esc(r.locked_by) + ' 审批中' : ''}</div>
    </div>`).join('');
  $$('#revList .rev').forEach(el => el.onclick = () => selectRevision(el.dataset.id));
}
const statusZh = s => ({ draft: '草稿', pending_review: '待审批', approved: '已批准', rejected: '已驳回', changes_requested: '请修改', confirmed: '已确认', superseded: '已取代' }[s] || s);

async function selectRevision(rid) {
  const rev = await api('/api/revisions/' + rid);
  state.currentRev = rev;
  fillFormFromSpec(rev.spec_json);
  renderEval({ normalized: null, derived: rev.derived_json, bom: rev.bom_json, issues: rev.issues_json, quote: rev.quote_json });
  renderRevList();
  renderRevDetail(rev);
  renderPubDeliver(rev);
  renderRevContext(rev);
}

// 版本血缘提示：旧确认失效 / 新版本继承自被取代的旧版
function renderRevContext(rev) {
  const inv = (rev.amendments || []).map(a => { try { return JSON.parse(a.changes_json).invalidation; } catch { return null; } }).find(Boolean);
  let html = '';
  if (inv) html = `<div class="invalidation">🔕 ${esc(inv)}</div>`;
  // 若本版已被取代
  if (rev.status === 'superseded') html += `<div class="invalidation">本版已被后继版本取代，其批准与确认不再有效；报价/交期/保养以后继版本为准。</div>`;
  // 旧版列表里标注
  const existing = $('#revContextBanner');
  if (existing) existing.remove();
  if (html) {
    const b = document.createElement('div');
    b.id = 'revContextBanner';
    b.style.marginBottom = '8px';
    b.innerHTML = html;
    $('#revDetail').parentNode.insertBefore(b, $('#revDetail'));
  }
}

/* ---------- 版本操作 ---------- */
function btn(label, cls, fn, disabled) {
  const b = document.createElement('button');
  b.className = 'btn small ' + (cls || ''); b.textContent = label; b.disabled = !!disabled;
  b.onclick = fn; return b;
}

function renderRevDetail(rev) {
  const box = $('#revActions'); box.innerHTML = '';
  const isShop = actor().role === 'shop', isCust = !isShop;
  const add = (l, fn, dis) => box.appendChild(btn(l, '', fn, dis));

  if (['draft', 'changes_requested', 'rejected'].includes(rev.status))
    add('📤 提交审批（锁定）', () => act(rev, 'submit'), rev.issues_json.some(i => i.severity === 'error'));
  if (rev.status === 'pending_review') {
    add('↩️ 请求修改（退稿解锁）', () => act(rev, 'request-changes', { comment: prompt('退稿说明') }));
    if (isShop) {
      add('✍️ 人工图纸审批：通过', () => act(rev, 'drawing-review', { decision: 'pass', drawing_no: 'SH-' + Date.now().toString().slice(-6), note: prompt('审批备注（木纹/门缝/加固）') || '通过' }));
      add('⏸ 图纸暂缓', () => act(rev, 'drawing-review', { decision: 'hold', note: prompt('暂缓原因') }));
    }
  }
  if (rev.status === 'approved' && isCust)
    add('✅ 客户确认（绑定报价/交期/保养）', () => act(rev, 'confirm'));
  if (rev.status === 'confirmed' && isShop && !rev.work_order)
    add('🏭 开工（生成工单）', () => act(rev, 'work-order', {}));
  if (rev.work_order?.status === 'started') {
    if (isShop) add('🎉 工单完成', () => woAct(rev.work_order.id, 'complete'));
    add('❌ 工单已启动·申请撤销（人工评估）', () => woAct(rev.work_order.id, 'cancellation-request', { reason: prompt('撤销原因') }));
  }

  // 通用：改尺寸（走 PUT，自动处理失效/新版本）
  add('📐 按当前表单改尺寸', () => editSpec(rev));
  add('🔄 材料替代', async () => {
    const mat = prompt('替代为材料 id（oak/walnut/ash/birch_ply/pine）', 'walnut');
    if (!mat) return;
    try {
      const r = await api(`/api/revisions/${rev.id}/substitute`, { method: 'POST', body: JSON.stringify({ material: mat, note: '客户希望升级黑胡桃' }) });
      await afterStructureChange(rev, r);
    } catch (e) { showApiErr(e); }
  });
  add('📎 上传附件', async () => {
    const kind = prompt('附件类型 drawing / care / other', 'drawing');
    const filename = prompt('文件名', '补充节点图.pdf');
    try {
      const r = await api(`/api/revisions/${rev.id}/attachments`, { method: 'POST', body: JSON.stringify({ kind, filename, content: 'demo' }) });
      let msg = r.late ? `⚠️ 附件晚到（阶段：${r.arrived_after}）\n受影响：${(r.impact?.affected || []).join('、')}\n${r.guidance}` : r.guidance;
      if (r.late && confirm(msg + '\n\n是否现在确认收件？')) {
        await api(`/api/attachments/${r.attachment_id}/acknowledge`, { method: 'POST', body: '{}' });
      } else alert(msg);
      selectRevision(rev.id);
    } catch (e) { showApiErr(e); }
  });

  // 详情
  $('#revDetail').innerHTML = `
    <div class="impact-section">
      <h4>签署记录</h4>
      ${(rev.approvals || []).map(a => `<div>· ${a.role === 'shop' ? '工坊' : '客户'} ${a.kind === 'confirm' ? '确认' : '批准/记录'} @ ${new Date(a.signed_at).toLocaleString()} — ${esc(a.comment || '')}</div>`).join('') || '<div class="muted">无</div>'}
      <h4>人工图纸审批</h4>
      ${(rev.drawings || []).map(d => `<div>· ${esc(d.drawing_no || '-')} ${d.decision === 'pass' ? '✅通过' : '⏸暂缓'}（${esc(d.reviewer)}）${esc(d.note || '')}</div>`).join('') || '<div class="muted">尚未审批</div>'}
      <h4>材料替代</h4>
      ${(rev.substitutions || []).map(s => `<div>· ${esc(s.original_material)} → ${esc(s.substitute_material)}（${s.status}）</div>`).join('') || '<div class="muted">无</div>'}
      <h4>附件${rev.attachments?.some(a => a.arrived_after) ? '（含晚到）' : ''}</h4>
      ${(rev.attachments || []).map(a => `<div>· ${a.kind} ${esc(a.filename)} ${a.arrived_after ? `<strong style="color:#b9770e">晚到:${a.arrived_after}</strong> ${a.acknowledged ? '✅已确认' : '⏳待确认'}` : ''}</div>`).join('') || '<div class="muted">无</div>'}
      ${rev.work_order ? `<h4>工单</h4><div>${esc(rev.work_order.id)} · <span class="status ${rev.work_order.status}">${({ started: '进行中', done: '已完成', cancelled: '已撤销' })[rev.work_order.status]}</span>${rev.work_order.cancel_reason ? ' — ' + esc(rev.work_order.cancel_reason) : ''}</div>` : ''}
    </div>`;

}


async function act(rev, path, body = {}) {
  try {
    const r = await api(`/api/revisions/${rev.id}/${path}`, { method: 'POST', body: JSON.stringify(body) });
    if (r.bound) alert(`已绑定到版本：\n报价 ¥${r.bound.quote}\n交期 ${r.bound.lead_workdays} 工作日\n保养：${r.bound.care.slice(0, 40)}…`);
    await reloadRevisions(); selectRevision(rev.id);
  } catch (e) { showApiErr(e); }
}
async function woAct(wid, path, body = {}) {
  try {
    const r = await api(`/api/work-orders/${wid}/${path}`, { method: 'POST', body: JSON.stringify(body) });
    if (r.decision === 'pending') alert(r.message);
    if (path === 'cancellation-request' && actor().role === 'shop') {
      const decision = confirm('工坊评估：同意撤销？(确定=同意并记成本，取消=拒绝)');
      const cost = decision ? Number(prompt('已发生成本（元）', '300')) : 0;
      const a = await api(`/api/cancellation-requests/${r.cancellation_request_id}/assess`, { method: 'POST', body: JSON.stringify({ decision: decision ? 'granted' : 'denied', assessed_cost: cost }) });
      alert('评估结果：' + a.decision + (a.assessed_cost != null ? `，成本 ¥${a.assessed_cost}` : ''));
    }
    const revId = state.currentRev.id; await reloadRevisions(); selectRevision(revId);
  } catch (e) { showApiErr(e); }
}

async function editSpec(rev) {
  try {
    const r = await api(`/api/revisions/${rev.id}/spec`, { method: 'PUT', body: JSON.stringify({ spec: readSpec(), reason: '客户调整尺寸' }) });
    await afterStructureChange(rev, r);
  } catch (e) { showApiErr(e); }
}

async function afterStructureChange(rev, r) {
  await reloadRevisions();
  if (r.evaluation) renderEval(r.evaluation);
  renderImpact(r.diff);
  if (r.invalidation) {
    $('#impactBox').insertAdjacentHTML('afterbegin', `<div class="invalidation">🔕 ${esc(r.invalidation.message)}</div>`);
  }
  const nextId = r.revision_id || rev.id;
  await selectRevision(nextId);
  if (r.diff) renderImpact(r.diff);
}

function renderImpact(diff) {
  if (!diff) { $('#impactBox').className = 'muted'; $('#impactBox').innerHTML = '改尺寸或替代材料后显示。'; return; }
  $('#impactBox').className = 'impact-section';
  $('#impactBox').innerHTML = `
    <h4>受影响的派生项（可解释级联）</h4>
    <ul>${(diff.affectedDerived || []).map(d => `<li>${esc(d.label)}：${d.from ?? '—'} → <strong>${d.to}</strong> mm<div class="formula">${esc(d.formula)}</div></li>`).join('') || '<li>无</li>'}</ul>
    <h4>材料清单变化</h4>
    <ul>${(diff.bomChanges || []).map(b => `<li>[${({ added: '新增', removed: '删除', changed: '变化' })[b.type]}] ${esc(b.part)} ${esc(b.spec || '')} ${b.type === 'changed' ? `数量 ${b.qty_from}→${b.qty_to}，金额 ¥${(b.amount_from || 0).toFixed(2)}→¥${(b.amount_to || 0).toFixed(2)}` : `×${b.qty}`}</li>`).join('') || '<li>无</li>'}</ul>
    <h4>❗ 需重审 / 重确认</h4>
    <ul>${(diff.recheck || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    ${diff.priceChanged ? '<div class="invalidation">报价已变化，旧确认不再适用。</div>' : ''}`;
}

function showApiErr(e) {
  let msg = e.message;
  if (e.data?.code === 'LOCKED_PENDING_REVIEW') msg += `\n（锁定者：${e.data.locked_by}）。请先退稿再改。`;
  if (e.data?.code === 'STALE_EDIT') msg += '\n对方的改动：' + JSON.stringify(e.data.server_changes, null, 2);
  if (e.data?.code === 'CONSTRAINT_ERRORS') msg += '\n' + e.data.issues.map(i => '· ' + i.message).join('\n');
  if (e.data?.code === 'LATE_UNACKED') { msg += '\n' + e.data.items.map(i => '· ' + i.filename).join('\n') + '\n' + e.data.instruction; }
  alert('⛔ ' + msg);
}

/* ---------- 发布 / 交付 ---------- */
function renderPubDeliver(rev) {
  $('#pubDeliver').innerHTML = '';
}
$('#btnPublish').onclick = async () => {
  const rev = state.currentRev; if (!rev) return;
  try {
    const r = await api(`/api/revisions/${rev.id}/publish`, { method: 'POST', body: JSON.stringify({
      public_title: '白橡木客厅书柜（公开）', story: prompt('公开故事文字', '客户用于客厅收纳，活动层板灵活可调。') || '' }) });
    alert('已生成授权快照，已剔除：' + r.private_fields_excluded.join('、'));
    $('#pubDeliver').innerHTML = `<div class="issue ok">发布ID ${esc(r.publication_id)}，快照不含预算/地址/姓名。</div>`;
  } catch (e) { showApiErr(e); }
};
$('#btnDeliver').onclick = async () => {
  const rev = state.currentRev; if (!rev) return;
  try {
    const r = await api(`/api/revisions/${rev.id}/deliver`, { method: 'POST', body: '{}' });
    $('#pubDeliver').innerHTML = `<div class="issue ok">📦 交付包 ${esc(r.delivery_package_id)}
      <div class="formula">绑定报价 ¥${r.manifest.bound_at_confirmation.quote_total} ｜ 图纸 ${r.manifest.adopted_drawings.map(d => d.drawing_no).join(',') || '无'} ｜ 附件 ${r.manifest.attachments_locked_before_cutoff.length} 件（锁定前），晚到补充 ${r.manifest.late_supplements_acknowledged.length} 件</div></div>`;
  } catch (e) { showApiErr(e); }
};

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---------- 身份切换时重渲染按钮 ---------- */
$('#actorRole').onchange = () => { if (state.currentRev) renderRevDetail(state.currentRev); };
$('#actorName').onchange = () => { if (state.currentRev) renderRevDetail(state.currentRev); };

/* ---------- 验收场景 ---------- */
const logBox = $('#scenarioLog');
function slog(msg, cls) {
  const span = document.createElement('div');
  if (cls) span.className = cls;
  span.textContent = msg;
  logBox.appendChild(span);
  logBox.scrollTop = logBox.scrollHeight;
}
$$('.scenario').forEach(b => b.onclick = () => runScenario(b.dataset.s));

async function runScenario(name) {
  logBox.innerHTML = '';
  const scen = scenarios[name];
  slog(`▶ 场景：${scen.title}`, 'dim');
  try { await scen.run(slog, api); slog('\n✅ 场景通过', 'ok'); }
  catch (e) { slog('\n⛔ 场景失败：' + e.message, 'err'); console.error(e); }
}


// 初始加载
loadMaterials();
loadGallery();
