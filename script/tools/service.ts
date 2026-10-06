import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, dataDir, logsDir } from '../src/config.js';
const label = 'local.record-money.v01';
const dir = join(homedir(), 'Library', 'LaunchAgents'), path = join(dir, label + '.plist');
const target = `gui/${process.getuid!()}`;
const runtime = join(homedir(), 'Library', 'Application Support', 'RecordMoney');
const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function stop() { try { execFileSync('/bin/launchctl', ['bootout', target + '/' + label], { stdio: 'ignore' }); } catch {} }
const command = process.argv[2];
if (command === 'install') {
  if (process.platform !== 'darwin') throw new Error('service:install仅支持macOS；Linux或NAS请使用Docker');
  if (!existsSync(join(root, 'script', 'dist', 'index.html')) || !existsSync(join(root, 'script', 'build', 'server.js'))) throw new Error('请先运行 npm run build');
  mkdirSync(dir, { recursive: true }); stop();
  for (const name of ['data', 'logs', 'script', 'reports']) mkdirSync(join(runtime, name), { recursive: true, mode: 0o700 });
  for (const name of ['build', 'dist', 'node_modules', 'tools', 'src']) cpSync(join(root, 'script', name), join(runtime, 'script', name), { recursive: true });
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.server.json']) copyFileSync(join(root, 'script', name), join(runtime, 'script', name));
  cpSync(join(root, 'reports'), join(runtime, 'reports'), { recursive: true });
  const hasStorage = existsSync(join(root, 'data', 'runtime-location.txt')) || !!process.env.LEDGER_DATA_DIR;
  const storage = hasStorage ? dirname(dataDir) : runtime;
  const runtimeData = hasStorage ? dataDir : join(runtime, 'data');
  const runtimeLogs = hasStorage ? logsDir : join(runtime, 'logs');
  mkdirSync(runtimeData, { recursive: true, mode: 0o700 }); mkdirSync(runtimeLogs, { recursive: true, mode: 0o700 });
  const runtimeConfig = join(runtimeData, 'config.env');
  if (!existsSync(runtimeConfig) && existsSync(join(root, 'data', 'config.env'))) { copyFileSync(join(root, 'data', 'config.env'), runtimeConfig); chmodSync(runtimeConfig, 0o600); }
  const runtimePointer = join(runtime, 'data', 'runtime-location.txt');
  if (resolve(storage) !== resolve(runtime)) writeFileSync(runtimePointer, storage + '\n', { mode: 0o600 });
  else if (existsSync(runtimePointer)) unlinkSync(runtimePointer);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(join(runtime, 'script', 'tools', 'run.sh'))}</string></array><key>WorkingDirectory</key><string>${xml(runtime)}</string><key>EnvironmentVariables</key><dict><key>NODE_BINARY</key><string>${xml(process.execPath)}</string><key>LEDGER_DATA_DIR</key><string>${xml(runtimeData)}</string><key>LEDGER_LOGS_DIR</key><string>${xml(runtimeLogs)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(join(runtimeLogs, 'stdout.log'))}</string><key>StandardErrorPath</key><string>${xml(join(runtimeLogs, 'stderr.log'))}</string></dict></plist>`;
  writeFileSync(path, plist, { mode: 0o600 });
  execFileSync('/usr/bin/plutil', ['-lint', path], { stdio: 'inherit' });
  execFileSync('/bin/launchctl', ['bootstrap', target, path], { stdio: 'inherit' });
  writeFileSync(join(root, 'data', 'runtime-location.txt'), storage + '\n');
  console.log('后台服务已安装：登录后自动启动，接通电源时阻止自动睡眠。运行目录：' + runtime);
} else if (command === 'stop') { stop(); console.log('后台服务已停止。'); }
else if (command === 'uninstall') { stop(); if (existsSync(path)) unlinkSync(path); console.log('后台服务已卸载，账本数据保留。'); }
else throw new Error('用法：service.ts install | stop | uninstall');
