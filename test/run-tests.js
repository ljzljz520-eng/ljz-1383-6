// 自包含验收：启动服务 → 等待就绪 → 运行 acceptance.js → 关闭
const { spawn } = require('child_process');
const path = require('path');

const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
  cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: process.env.PORT || '3000' }
});
let started = false;
srv.stdout.on('data', d => { if (!started && d.includes('listening')) { started = true; runTests(); } });
srv.on('error', e => { console.error(e); process.exit(1); });

function runTests() {
  const t = spawn(process.execPath, [path.join(__dirname, 'acceptance.js')], { stdio: 'inherit' });
  t.on('exit', code => { srv.kill(); setTimeout(() => process.exit(code || 0), 100); });
}
setTimeout(() => { if (!started) { console.error('服务启动超时'); srv.kill(); process.exit(1); } }, 8000);
