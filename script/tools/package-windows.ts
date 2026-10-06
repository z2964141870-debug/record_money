import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows安装包须在Windows x64构建');
const root = resolve(import.meta.dirname, '../..'), version = JSON.parse(readFileSync(join(root, 'script/package.json'), 'utf8')).version;
const output = resolve(process.argv[2] || join(root, 'data/releases'));
const temp = mkdtempSync(join(tmpdir(), 'record-money-windows-'));
try {
  const stage = join(temp, `record-money-v${version}-windows-x64`), payload = join(stage, 'payload');
  mkdirSync(join(payload, 'bin'), { recursive: true });
  for (const name of ['build', 'dist']) {
    if (!existsSync(join(root, 'script', name))) throw new Error('请先运行npm run build');
    cpSync(join(root, 'script', name), join(payload, 'script', name), { recursive: true });
  }
  for (const name of ['package.json', 'package-lock.json']) cpSync(join(root, 'script', name), join(payload, 'script', name));
  if (!process.env.npm_execpath) throw new Error('请使用npm run package:windows打包');
  execFileSync(process.execPath, [process.env.npm_execpath, 'ci', '--omit=dev'], { cwd: join(payload, 'script'), stdio: 'inherit' });
  const docs = ['README.md', 'FEISHU.md', 'DINGTALK.md', 'DISTRIBUTION.md', 'MODELS.md', 'MODEL_EVALUATION.md', 'CHANGELOG.md'];
  for (const destination of [payload, stage]) {
    mkdirSync(join(destination, 'reports'));
    for (const name of docs) cpSync(join(root, 'reports', name), join(destination, 'reports', name));
    cpSync(join(root, 'LICENSE'), join(destination, 'LICENSE'));
  }
  cpSync(join(root, 'README.md'), join(stage, 'README.md'));
  cpSync(process.execPath, join(payload, 'bin/node.exe'));
  const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, { signal: AbortSignal.timeout(30000) });
  if (!license.ok) throw new Error('无法取得Node许可证，安装包未生成');
  writeFileSync(join(payload, 'NODE-LICENSE.txt'), await license.text());
  const compiler = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const launcher = join(stage, 'RecordMoney.exe');
  execFileSync(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001', '/out:' + launcher,
    '/win32manifest:' + join(root, 'script/desktop/WindowsLauncher.manifest'),
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', join(root, 'script/desktop/WindowsLauncher.cs')], { stdio: 'inherit' });
  cpSync(launcher, join(payload, 'bin/RecordMoney.exe'));
  for (const destination of [stage, join(payload, 'bin')]) cpSync(join(root, 'script/desktop/WindowsLauncher.exe.config'), join(destination, 'RecordMoney.exe.config'));
  mkdirSync(output, { recursive: true });
  const archive = join(output, `record-money-v${version}-windows-x64.zip`);
  if (existsSync(archive)) throw new Error('安装包已存在，请选择新输出目录');
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:RM_STAGE_ROOT, $env:RM_ARCHIVE, [System.IO.Compression.CompressionLevel]::Optimal, $true)'],
    { env: { ...process.env, RM_STAGE_ROOT: stage, RM_ARCHIVE: archive }, stdio: 'inherit' });
  writeFileSync(archive + '.sha256', createHash('sha256').update(readFileSync(archive)).digest('hex') + '  ' + archive.split(/[\\/]/).at(-1) + '\n');
  console.log(JSON.stringify({ archive, version, arch: 'x64', signed: false }));
} finally { rmSync(temp, { recursive: true, force: true }); }
