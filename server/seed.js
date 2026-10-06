// 初始化材料目录 + 演示数据
const { run, get, all } = require('./db');
const { evaluate } = require('./specEngine');

const MATERIALS = [
  { id: 'oak',       unit: 'm2',       name: '白橡木（北美）',     unit_price: 220, max_span_mm: 900,  stock_width_mm: 1220, stock_length_mm: 2440, lead_days: 7, density: '0.75g/cm³', origin: '北美', care_note: '纹理粗犷、耐冲击' },
  { id: 'walnut',    unit: 'm2',    name: '黑胡桃木（北美）',   unit_price: 380, max_span_mm: 850,  stock_width_mm: 1220, stock_length_mm: 2440, lead_days: 14, density: '0.68g/cm³', origin: '北美', care_note: '避免阳光直晒变色' },
  { id: 'ash',       unit: 'm2',       name: '水曲柳',             unit_price: 190, max_span_mm: 800,  stock_width_mm: 1220, stock_length_mm: 2440, lead_days: 5, density: '0.69g/cm³', origin: '东北', care_note: '注意湿度 45–60%' },
  { id: 'birch_ply', unit: 'm2', name: '桦木多层板（E0）',   unit_price: 150, max_span_mm: 700,  stock_width_mm: 1250, stock_length_mm: 2500, lead_days: 3, density: '—', origin: '芬兰', care_note: '封边必须完整防潮' },
  { id: 'pine',      unit: 'm2',      name: '樟子松（指接板）',   unit_price: 120, max_span_mm: 600,  stock_width_mm: 1220, stock_length_mm: 2440, lead_days: 3, density: '0.5g/cm³', origin: '俄罗斯', care_note: '材质偏软，重物放固定层板' }
];

function materialMap() {
  const m = {};
  for (const row of all('SELECT * FROM materials')) m[row.id] = row;
  return m;
}

function seed() {
  if (get('SELECT COUNT(*) c FROM materials').c === 0) {
    for (const m of MATERIALS) {
      run(`INSERT INTO materials (id,name,unit,unit_price,max_span_mm,stock_width_mm,stock_length_mm,lead_days,density,origin,care_note)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [m.id, m.name, m.unit, m.unit_price, m.max_span_mm, m.stock_width_mm, m.stock_length_mm, m.lead_days, m.density, m.origin, m.care_note]);
    }
    console.log('seeded materials:', MATERIALS.length);
  }

  if (!get('SELECT id FROM projects WHERE id=?', ['demo'])) {
    run(`INSERT INTO projects (id,title,created_at,customer_name,budget,address,note)
         VALUES (?,?,?,?,?,?,?)`,
      ['demo', '客厅书柜（演示案例）', '2026-09-20T09:00:00Z', '林女士', 9000, '（私人地址，不公开）上海市徐汇区XX路', '希望能放 A4 文件夹与装饰品']);

    const spec = { width: 900, height: 2000, depth: 380, shelf_count: 4, door_count: 2, material: 'oak', finish: 'oil' };
    const r = evaluate(spec, materialMap());
    const id = 'demo-rev1';
    run(`INSERT INTO revisions (id,project_id,rev_no,spec_json,derived_json,bom_json,quote_json,issues_json,status,created_by,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, 'demo', 1, JSON.stringify(spec), JSON.stringify(r.derived), JSON.stringify(r.bom), JSON.stringify(r.quote), JSON.stringify(r.issues),
       'confirmed', 'customer', '2026-09-21T03:00:00Z']);
    run(`INSERT INTO approvals (id,revision_id,role,kind,comment,signed_at) VALUES (?,?,?,?,?,?)`,
      ['a1', id, 'shop', 'approve', '结构无问题，注意橡木色差', '2026-09-22T02:00:00Z']);
    run(`INSERT INTO approvals (id,revision_id,role,kind,comment,signed_at) VALUES (?,?,?,?,?,?)`,
      ['a2', id, 'customer', 'confirm', '确认报价与交期', '2026-09-22T06:00:00Z']);
    run(`INSERT INTO drawing_reviews (id,revision_id,drawing_no,reviewer,decision,note,reviewed_at)
         VALUES (?,?,?,?,?,?,?)`,
      ['dr1', id, 'SH-2026-011', '周师傅', 'pass', '门缝2.5mm，铰链位标准', '2026-09-22T02:30:00Z']);

    // 一个已授权发布的公开案例（快照不含预算/地址）
    const snapshot = {
      title: '白橡木客厅书柜',
      material: '白橡木（北美）', finish: '木蜡油',
      size: '900 × 2000 × 380 mm',
      story: '客户用整墙收纳 A4 文件夹与旅行纪念品，活动层板可调。',
      photo: 'oak-case.jpg',
      spec: { width_mm: r.normalized.width_mm, height_mm: r.normalized.height_mm, depth_mm: r.normalized.depth_mm }
    };
    run(`INSERT INTO publications (id,project_id,revision_id,authorization_text,authorized_by,authorized_at,snapshot_json,status)
         VALUES (?,?,?,?,?,?,?,?)`,
      ['pub1', 'demo', id, '我授权以匿名方式公开作品照片、尺寸区间、材料与工艺说明；不公开预算、地址、姓名。', '林女士', '2026-10-01T08:00:00Z', JSON.stringify(snapshot), 'authorized']);

    console.log('seeded demo project + public case');
  }
}

module.exports = { seed, materialMap };
