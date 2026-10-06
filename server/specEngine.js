/*
 * 参数化规格引擎
 * ---------------------------------------------------------------
 * 职责：
 *  1) 毫米/英寸混填归一化（内部统一为 mm，1in = 25.4mm）
 *  2) 可解释的依赖计算：每个派生值都带 formula / dependsOn
 *  3) 超约束诊断：用户显式输入与派生值矛盾时给出可操作建议
 *  4) 材料清单(BOM)、报价、交期、保养说明的版本化快照
 *
 * 关键设计：改变柜体外宽不允许"只改一个字段"。
 *  width 是源头量；door_width_override / shelf_width_override 等属于
 *  超约束，必须与派生值一致，否则引擎报错并给出解除方式。
 */

const MM_PER_INCH = 25.4;
const TOL_MM = 0.6; // 毫米一致性容差（英寸换算取整误差）

// 固定结构常量（mm）
const SIDE_T = 18;          // 侧板厚
const TOP_BOTTOM_T = 18;    // 顶/底板厚
const BACK_T = 9;           // 背板厚
const SHELF_T = 18;         // 层板厚
const DOOR_T = 20;          // 门板厚
const DOOR_GAP_TOTAL = 3;   // 门缝总宽（对开门多道缝合计）
const INSET_MM = 2;         // 门板比外宽每侧内缩

// 五金
const HINGES_PER_DOOR = 3;
const HINGE_PRICE = 8.5;
const HANDLE_PER_DOOR = 1;
const HANDLE_PRICE = 12;
const SHELF_SUPPORT_PER_SHELF = 4;
const SHELF_SUPPORT_PRICE = 1.2;

// 涂饰人工（元/m2）
const FINISH_LABOR = { oil: 60, lacquer: 95, paint: 110 };
const FINISH_NAME = { oil: '木蜡油', lacquer: '清漆', paint: '混油色漆' };

// 保养说明按材料+涂饰（绑定到被批准的版本）
const CARE_BASE = {
  oil: '每 6–12 个月用同型号木蜡油薄涂保养；避免长时间积水。',
  lacquer: '湿布擦拭即可，避免丙酮/天那水等溶剂接触漆膜。',
  paint: '避免尖锐物刮擦漆面；磕碰后用同批色漆点补。'
};

const MATERIAL_CARE = {
  oak: '橡木纹理粗，顺纹方向防磕碰；',
  walnut: '黑胡桃避免长期阳光直射以防变色；',
  ash: '水曲柳吸湿性较强，室内湿度建议 45%–60%；',
  birch_ply: '多层桦木胶合板边缘需封边到位以防潮；',
  pine: '松木偏软，重物请放在固定层板上。'
};

/**
 * 解析一个尺寸输入。支持数字(mm) 或 {value, unit}。
 * 返回 {mm, raw, unit} 或抛错。
 */
function parseDim(input, fieldLabel) {
  if (input == null || input === '') throw new Error(`${fieldLabel} 缺失`);
  let value, unit = 'mm', raw;
  if (typeof input === 'object') {
    value = Number(input.value);
    unit = (input.unit || 'mm').toLowerCase();
    raw = input.raw ?? `${input.value}${unit === 'in' ? 'in' : 'mm'}`;
  } else {
    value = Number(input);
    raw = `${input}mm`;
  }
  if (!Number.isFinite(value)) throw new Error(`${fieldLabel} 不是数字: ${JSON.stringify(input)}`);
  if (!['mm', 'in', 'inch', 'inches'].includes(unit)) {
    throw new Error(`${fieldLabel} 单位不支持: ${unit}（仅 mm / in）`);
  }
  const mm = ['in', 'inch', 'inches'].includes(unit) ? value * MM_PER_INCH : value;
  return { mm, raw, unit: unit.startsWith('in') ? 'in' : 'mm', value };
}

function round1(n) { return Math.round(n * 10) / 10; }
function fmt(mm) {
  return `${round1(mm)} mm`;
}

/**
 * 主入口：计算规格
 * @param {object} rawInput 原始输入（可能含混合单位与覆盖值）
 * @param {Map} materialCatalog materialId -> material row
 * @returns 完整的派生快照
 */
function evaluate(rawInput, materialCatalog) {
  const issues = [];
  const errs = [];
  const addIssue = (severity, code, message, fix, field) => {
    const it = { severity, code, message, fix, field };
    issues.push(it);
    if (severity === 'error') errs.push(it);
  };

  // ---------- 1. 归一化 ----------
  let width, height, depth, shelfCount, doorCount;
  try { width = parseDim(rawInput.width, '柜体外宽 W'); } catch (e) { addIssue('error', 'BAD_DIM', e.message, '填写正数，如 800 或 {value:31.5,unit:"in"}', 'width'); width = { mm: NaN }; }
  try { height = parseDim(rawInput.height, '柜体外高 H'); } catch (e) { addIssue('error', 'BAD_DIM', e.message, '填写正数高度', 'height'); height = { mm: NaN }; }
  try { depth = parseDim(rawInput.depth, '柜体外深 D'); } catch (e) { addIssue('error', 'BAD_DIM', e.message, '填写正数深度', 'depth'); depth = { mm: NaN }; }

  shelfCount = rawInput.shelf_count ?? rawInput.shelfCount;
  if (shelfCount == null || !Number.isInteger(Number(shelfCount)) || Number(shelfCount) < 0) {
    addIssue('error', 'BAD_SHELF_COUNT', `活动层板数非法: ${shelfCount}`, '填 0 或正整数', 'shelf_count');
    shelfCount = 0;
  } else shelfCount = Number(shelfCount);

  const materialId = rawInput.material || 'oak';
  const material = materialCatalog[materialId];
  if (!material) {
    addIssue('error', 'BAD_MATERIAL', `未知材料: ${materialId}`, `从目录选择: ${Object.keys(materialCatalog).join('/')}`, 'material');
  }
  const finish = rawInput.finish || 'oil';
  if (!FINISH_LABOR[finish]) {
    addIssue('error', 'BAD_FINISH', `未知涂饰: ${finish}`, `选择 ${Object.keys(FINISH_LABOR).join('/')}`, 'finish');
  }

  doorCount = rawInput.door_count ?? rawInput.doorCount ?? 2;
  if (![1, 2, 3, 4].includes(Number(doorCount))) {
    addIssue('error', 'BAD_DOOR_COUNT', `门数仅支持 1–4，收到 ${doorCount}`, '改为 1/2/3/4', 'door_count');
    doorCount = 2;
  }
  doorCount = Number(doorCount);

  const W = width.mm, H = height.mm, D = depth.mm;

  // 可选覆盖（超约束源）
  let doorWidthOv = rawInput.door_width_override != null ? parseDimSafe(rawInput.door_width_override, '门宽覆盖', addIssue) : null;
  let shelfWidthOv = rawInput.shelf_width_override != null ? parseDimSafe(rawInput.shelf_width_override, '层板宽覆盖', addIssue) : null;
  let innerWidthOv = rawInput.inner_width_override != null ? parseDimSafe(rawInput.inner_width_override, '内宽覆盖', addIssue) : null;

  // ---------- 2. 基础约束 ----------
  for (const [v, label] of [[W, '宽'], [H, '高'], [D, '深']]) {
    if (Number.isFinite(v) && v <= 0) addIssue('error', 'NON_POSITIVE', `${label}必须为正，当前 ${fmt(v)}`, '填写正数尺寸', label === '宽' ? 'width' : label === '高' ? 'height' : 'depth');
  }
  if (Number.isFinite(W) && (W < 200 || W > 3000)) addIssue('error', 'WIDTH_RANGE', `外宽 ${fmt(W)} 超出可做范围 200–3000mm`, '调整宽度或拆成多个柜体', 'width');
  if (Number.isFinite(H) && (H < 200 || H > 2800)) addIssue('error', 'HEIGHT_RANGE', `外高 ${fmt(H)} 超出可做范围 200–2800mm`, '调整高度', 'height');
  if (Number.isFinite(D) && (D < 150 || D > 900)) addIssue('error', 'DEPTH_RANGE', `外深 ${fmt(D)} 超出可做范围 150–900mm`, '调整深度', 'depth');

  // ---------- 3. 派生计算（每一步带 formula / dependsOn） ----------
  const derived = [];
  const addDerived = (key, label, value, unit, formula, dependsOn, note) =>
    derived.push({ key, label, value: round1(value), unit, formula, dependsOn, note });

  // 这些在尺寸非法时无法计算
  const dimsOk = [W, H, D].every(v => Number.isFinite(v) && v > 0);
  if (!dimsOk) {
    return finishOutput(rawInput, materialId, finish, { W, H, D, doorCount, shelfCount, width, height, depth },
      derived, [], issues, null, null);
  }

  // 内宽 = W − 2×侧板厚
  const innerW = W - 2 * SIDE_T;
  addDerived('inner_width', '柜内净宽', innerW, 'mm', `W(${round1(W)}) − 2×侧板厚(${SIDE_T})`, ['width'], '外宽一改，内宽必须同步，门板与层板全部级联');
  // 内高 = H − 2×顶底板厚 − 背板占位（高度方向背板不占位，仅顶底）
  const innerH = H - 2 * TOP_BOTTOM_T;
  addDerived('inner_height', '柜内净高', innerH, 'mm', `H(${round1(H)}) − 2×顶/底板厚(${TOP_BOTTOM_T})`, ['height']);
  // 内深 = D − 背板厚 − 门厚（门装在正面，占用进深）
  const innerD = D - BACK_T - DOOR_T;
  addDerived('inner_depth', '柜内净深', innerD, 'mm', `D(${round1(D)}) − 背板厚(${BACK_T}) − 门厚(${DOOR_T})`, ['depth']);

  // 门板：覆盖在正面，四周内缩 INSET；对开门还要扣门缝
  const doorTotal = W - 2 * INSET_MM;
  const doorW = (doorTotal - DOOR_GAP_TOTAL * (doorCount - 1)) / doorCount;
  const doorH = H - 2 * INSET_MM;
  addDerived('door_width', '单扇门板宽', doorW, 'mm',
    `(W(${round1(W)}) − 2×内缩(${INSET_MM}) − 门缝合计(${DOOR_GAP_TOTAL * (doorCount - 1)})) / 门数(${doorCount})`,
    ['width', 'door_count'], '改外宽或门数，每扇门板宽自动重算');
  addDerived('door_height', '门板高', doorH, 'mm', `H(${round1(H)}) − 2×内缩(${INSET_MM})`, ['height']);

  // 层板（活动）：宽=内宽，深=内深−背板处留缝(2mm)
  const shelfW = innerW;
  const shelfD = innerD - 2;
  addDerived('shelf_width', '层板宽', shelfW, 'mm', `内宽(${round1(innerW)})`, ['width'], '外宽变 → 内宽变 → 层板宽变 → 板材用量变');
  addDerived('shelf_depth', '层板深', shelfD, 'mm', `内深(${round1(innerD)}) − 2mm 留缝`, ['depth']);

  // 层板跨距（用于材料最大跨距校验）
  if (shelfCount > 0) {
    const bayH = innerH / (shelfCount + 1);
    addDerived('bay_height', '竖向均分层间净高', bayH, 'mm', `内高(${round1(innerH)}) / (层板数(${shelfCount})+1)`, ['height', 'shelf_count'], '实际五金孔位以人工图纸为准');
  }

  // 门板宽合理性
  if (doorW < 140) addIssue('error', 'DOOR_TOO_NARROW', `单扇门板宽 ${fmt(doorW)} < 140mm`, `门数从 ${doorCount} 减少，或加大外宽`, 'door_count');
  if (doorW > 650) addIssue('warning', 'DOOR_WIDE', `单扇门板宽 ${fmt(doorW)} > 650mm，铰链受力偏大`, '建议增加门数或改用重型铰链（需人工图纸确认）', 'door_count');

  // ---------- 4. 超约束诊断 ----------
  // 用户显式给了覆盖值时，必须与派生值一致；不一致就是"只改了一个字段"式矛盾。
  checkOverride('door_width_override', '门板宽', doorWidthOv, doorW, 'width / door_count', addIssue);
  checkOverride('shelf_width_override', '层板宽', shelfWidthOv, shelfW, 'width', addIssue);
  checkOverride('inner_width_override', '柜内净宽', innerWidthOv, innerW, 'width / 侧板厚', addIssue);

  // 深宽/高宽比例警告
  if (innerD > innerW * 0.95) addIssue('warning', 'DEEP_RATIO', `净深(${fmt(innerD)}) 接近净宽(${fmt(innerW)})，取物不便`, '建议减小深度', 'depth');
  if (W > H * 3) addIssue('warning', 'WIDE_LOW', `宽高比 ${(W / H).toFixed(2)} 偏大，柜体易显矮`, '确认是否为矮柜/电视柜，人工图纸将核稳定结构', 'width');

  // ---------- 5. 材料约束（依赖具体材料目录） ----------
  if (material) {
    // 板材库存尺寸能否开料
    const stockW = material.stock_width_mm, stockL = material.stock_length_mm;
    const longestCut = Math.max(H - 2 * INSET_MM, doorW, shelfD);
    if (longestCut > stockL) {
      addIssue('error', 'STOCK_TOO_SHORT',
        `${material.name}库存最长 ${stockL}mm，而门板高需 ${fmt(longestCut)}`,
        '分段拼接（需人工图纸审批）或更换更长料的材料', 'material');
    }
    if (shelfW > stockW && shelfD > stockW) {
      addIssue('error', 'STOCK_WIDTH', `${material.name}库存宽 ${stockW}mm 无法开出层板(${fmt(shelfW)}×${fmt(shelfD)})`, '换用更大幅面板材', 'material');
    }
    // 层板最大跨距（防止下垂）——外宽变大直接触发
    if (shelfCount > 0 && shelfW > material.max_span_mm) {
      addIssue('error', 'SPAN_EXCEEDED',
        `${material.name}活动层板最大建议跨距 ${material.max_span_mm}mm，当前 ${fmt(shelfW)}（外宽 ${fmt(W)} 所致）`,
        `减小外宽至约 ${material.max_span_mm + 2 * SIDE_T}mm 以内；或增加中立板（人工图纸项）；或换更高跨距材料`,
        'width');
    }
  }

  // ---------- 6. 材料清单 BOM ----------
  const bom = [];
  const addBom = (part, spec, qty, unit, area, materialName, unitPrice, note) => {
    bom.push({ part, spec, qty, unit, area_m2: area ? round1(area) : null, material: materialName, unit_price: unitPrice, amount: area ? Math.round(area * unitPrice * 100) / 100 : null, note });
  };

  if (material) {
    const m2 = (a, b) => (a * b) / 1e6;
    // 侧板×2
    addBom('侧板', `${round1(innerD + BACK_T)}×${round1(H)}×${SIDE_T}`, 2, '块', 2 * m2(innerD + BACK_T, H), material.name, material.unit_price);
    // 顶板、底板
    addBom('顶板/底板', `${round1(innerW)}×${round1(innerD + BACK_T)}×${TOP_BOTTOM_T}`, 2, '块', 2 * m2(innerW, innerD + BACK_T), material.name, material.unit_price);
    // 背板
    addBom('背板', `${round1(W)}×${round1(H - 2 * TOP_BOTTOM_T)}×${BACK_T}`, 1, '块', m2(W, innerH), material.name, material.unit_price);
    // 门板
    addBom('门板', `${round1(doorW)}×${round1(doorH)}×${DOOR_T}`, doorCount, '扇', doorCount * m2(doorW, doorH), material.name, material.unit_price,
      doorWidthOv ? '用户显式指定门宽（已与派生值核对）' : undefined);
    // 活动层板
    if (shelfCount > 0) addBom('活动层板', `${round1(shelfW)}×${round1(shelfD)}×${SHELF_T}`, shelfCount, '块', shelfCount * m2(shelfW, shelfD), material.name, material.unit_price);
    // 固定中隔板（这里按无中隔板的标准版；中立板属于人工图纸项）

    // 封边条（米）= 所有板件周长合计
    const edge =
      2 * 2 * ((innerD + BACK_T) + H) +
      2 * 2 * (innerW + innerD + BACK_T) +
      2 * (W + innerH) +
      doorCount * 2 * (doorW + doorH) +
      shelfCount * 2 * (shelfW + shelfD);
    bom.push({ part: '封边条', spec: '同材种封边', qty: Math.ceil(edge / 1000), unit: 'm', area_m2: null, material: material.name, unit_price: 3.5, amount: Math.ceil(edge / 1000) * 3.5, note: '按板件周长累计，外宽变化时联动' });

    // 五金
    bom.push({ part: '暗铰链', spec: '全盖式', qty: HINGES_PER_DOOR * doorCount, unit: '只', area_m2: null, material: '五金', unit_price: HINGE_PRICE, amount: HINGE_PER_DOOR_PRICE(HINGES_PER_DOOR * doorCount), note: '每扇门 3 只' });
    bom.push({ part: '拉手', spec: '木/金属可选', qty: HANDLE_PER_DOOR * doorCount, unit: '只', area_m2: null, material: '五金', unit_price: HANDLE_PRICE, amount: HANDLE_PER_DOOR * doorCount * HANDLE_PRICE });
    if (shelfCount > 0) bom.push({ part: '层板销', spec: '金属', qty: SHELF_SUPPORT_PER_SHELF * shelfCount, unit: '只', area_m2: null, material: '五金', unit_price: SHELF_SUPPORT_PRICE, amount: SHELF_SUPPORT_PER_SHELF * shelfCount * SHELF_SUPPORT_PRICE });
  }

  // ---------- 7. 报价 / 交期 / 保养（快照，后续随批准绑定版本） ----------
  let quote = null;
  if (material && errs.length === 0) {
    const materialCost = bom.reduce((s, x) => s + (x.amount || 0), 0);
    const totalPanelArea = bom.filter(x => x.area_m2).reduce((s, x) => s + x.area_m2, 0);
    const finishLabor = totalPanelArea * (FINISH_LABOR[finish] || 0);
    const subtotal = materialCost + finishLabor;
    const overhead = Math.round(subtotal * 0.18 * 100) / 100; // 工厂管理与损耗
    const total = Math.round((subtotal + overhead) * 100) / 100;
    // 交期：基准工作日 + 材料备货 + 大件加成（任一尺寸变大联动）
    const leadDays = 10 + material.lead_days + (W > 1500 || H > 2000 ? 5 : 0) + shelfCount;
    quote = {
      currency: 'CNY',
      breakdown: {
        material_cost: Math.round(materialCost * 100) / 100,
        finish: FINISH_NAME[finish],
        finish_labor: Math.round(finishLabor * 100) / 100,
        overhead_rate: 0.18,
        overhead
      },
      total,
      lead_workdays: leadDays,
      care: `${MATERIAL_CARE[materialId] || ''}${CARE_BASE[finish]}`,
      // 报价绑定说明
      binding_note: '本报价/交期/保养仅在该设计版本获批后生效；客户改动尺寸或替代材料后旧确认失效，须以新版本重算并重批。'
    };
  } else if (material && errs.length > 0) {
    quote = { blocked: true, reason: '存在阻断性约束错误，修正后才能报价', care: null };
  }

  return finishOutput(rawInput, materialId, finish,
    { W, H, D, doorCount, shelfCount, width, height, depth },
    derived, bom, issues, quote, material);
}

function HINGE_PER_DOOR_PRICE(n) { return n * HINGE_PRICE; }

function parseDimSafe(input, label, addIssue) {
  try { return parseDim(input, label); }
  catch (e) { addIssue('error', 'BAD_DIM', e.message, '使用 {value,unit} 或毫米数字'); return null; }
}

function checkOverride(field, label, override, derivedMm, sourceFields, addIssue) {
  if (!override) return;
  const diff = override.mm - derivedMm;
  if (Math.abs(diff) > TOL_MM) {
    addIssue('error', 'OVERCONFLICT',
      `超约束冲突：${label}显式输入 ${fmt(override.mm)}，但按${sourceFields}派生应为 ${fmt(derivedMm)}（偏差 ${round1(diff)}mm）。不能只手改这一个字段。`,
      `二选一：① 删除${label}覆盖值，让其随外宽自动重算；② 以 ${fmt(derivedMm)} 为准修改覆盖值（或调整源头尺寸 ${sourceFields}）`,
      field);
  } else if (Math.abs(diff) > 0.05) {
    addIssue('warning', 'OVERRIDE_ROUNDED', `${label}覆盖值 ${fmt(override.mm)} 与派生值 ${fmt(derivedMm)} 有 ${round1(Math.abs(diff))}mm 取整差异，在容差 ±${TOL_MM}mm 内视为一致`, '建议直接删除覆盖值以免误解', field);
  }
}

function finishOutput(rawInput, materialId, finish, norm, derived, bom, issues, quote, material) {
  const normalized = {
    width_mm: Number.isFinite(norm.W) ? round1(norm.W) : null,
    height_mm: Number.isFinite(norm.H) ? round1(norm.H) : null,
    depth_mm: Number.isFinite(norm.D) ? round1(norm.D) : null,
    door_count: norm.doorCount,
    shelf_count: norm.shelfCount,
    material: materialId,
    finish,
    raw_inputs: {
      width: norm.width ? { raw: norm.width.raw, unit: norm.width.unit, mm: round1(norm.width.mm) } : null,
      height: norm.height ? { raw: norm.height.raw, unit: norm.height.unit, mm: round1(norm.height.mm) } : null,
      depth: norm.depth ? { raw: norm.depth.raw, unit: norm.depth.unit, mm: round1(norm.depth.mm) } : null
    }
  };
  return {
    normalized,
    derived,
    bom,
    issues,
    quote,
    material: material ? { id: material.id, name: material.name, max_span_mm: material.max_span_mm, stock: `${material.stock_width_mm}×${material.stock_length_mm}` } : null,
    has_errors: issues.some(i => i.severity === 'error')
  };
}

/*
 * 影响分析：给定旧 spec 与新 spec，列出受影响的派生项 / BOM / 需重审内容。
 * 前端在改尺寸后用它渲染"受影响项"面板。
 */
function diffSpecs(oldEval, newEval, materialCatalog) {
  const oldD = Object.fromEntries(oldEval.derived.map(d => [d.key, d.value]));
  const newD = Object.fromEntries(newEval.derived.map(d => [d.key, d.value]));
  const affectedDerived = [];
  for (const d of newEval.derived) {
    if (oldD[d.key] == null || Math.abs(oldD[d.key] - d.value) > TOL_MM) {
      affectedDerived.push({ key: d.key, label: d.label, from: oldD[d.key] ?? null, to: d.value, formula: d.formula });
    }
  }
  // BOM 变化（按 part+spec 聚合数量与金额）
  const bomKey = b => `${b.part}|${b.spec}`;
  const oldBom = new Map(oldEval.bom.map(b => [bomKey(b), b]));
  const newBom = new Map(newEval.bom.map(b => [bomKey(b), b]));
  const bomChanges = [];
  for (const [k, b] of newBom) {
    const o = oldBom.get(k);
    if (!o) bomChanges.push({ type: 'added', part: b.part, spec: b.spec, qty: b.qty, amount: b.amount });
    else if (o.qty !== b.qty || Math.abs((o.amount || 0) - (b.amount || 0)) > 0.01)
      bomChanges.push({ type: 'changed', part: b.part, spec: b.spec, qty_from: o.qty, qty_to: b.qty, amount_from: o.amount, amount_to: b.amount });
  }
  for (const [k, b] of oldBom) if (!newBom.has(k)) bomChanges.push({ type: 'removed', part: b.part, spec: b.spec, qty: b.qty, amount: b.amount });

  const priceChanged = !oldEval.quote?.total || !newEval.quote?.total
    ? oldEval.quote?.total !== newEval.quote?.total
    : Math.abs(oldEval.quote.total - newEval.quote.total) > 0.01;

  const recheck = [];
  if (affectedDerived.some(d => d.key.startsWith('door'))) recheck.push('门板尺寸/铰链数量（人工图纸核对门缝与开启方向）');
  if (affectedDerived.some(d => d.key === 'shelf_width' || d.key === 'shelf_depth')) recheck.push('层板开料与最大跨距（材料下垂风险）');
  if (bomChanges.length) recheck.push('材料清单与开料图（用量已变）');
  if (priceChanged && newEval.quote?.total) recheck.push('报价与交期（须按新版本重新确认，旧确认失效）');
  if (newEval.issues.some(i => i.severity === 'error')) recheck.push('阻断性约束：修正前不可提交审批');
  recheck.push('保养说明随材料/涂饰版本绑定，若替代材料则重发');

  return { affectedDerived, bomChanges, priceChanged, recheck, newIssues: newEval.issues };
}

module.exports = { evaluate, diffSpecs, parseDim, MM_PER_INCH, TOL_MM, FINISH_NAME };
