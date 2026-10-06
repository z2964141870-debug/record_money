import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let stopping = false;
let child: ReturnType<typeof spawn>;
function start() {
  child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], { stdio: 'inherit', env: process.env });
  child.on('error', () => { console.error('无法启动记账服务，请检查安装文件'); process.exit(1); });
  child.on('exit', (code, signal) => {
    if (!stopping && code === 75) start();
    else process.exit(stopping ? 0 : code ?? (signal ? 1 : 0));
  });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopping = true; child?.kill(signal); });
start();
