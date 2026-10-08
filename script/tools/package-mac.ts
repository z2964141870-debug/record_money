import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Wallet } from 'lucide-react';

if (process.platform !== 'darwin') throw new Error('Mac应用须在macOS构建');
const root = resolve(import.meta.dirname, '../..'), version = JSON.parse(readFileSync(join(root, 'script/package.json'), 'utf8')).version;
const output = resolve(process.argv[2] || join(root, 'data/releases'));
const temp = mkdtempSync(join(tmpdir(), 'record-money-mac-'));
try {
  const libraries = execFileSync('/usr/bin/otool', ['-L', process.execPath], { encoding: 'utf8' });
  if (libraries.split('\n').some(line => /^\s+\//.test(line) && !/^\s+\/(System\/Library|usr\/lib)\//.test(line))) throw new Error('打包须使用官方Node发行版，当前Node依赖非系统动态库');
  const app = join(temp, '私人记账助手.app'), contents = join(app, 'Contents'), resources = join(contents, 'Resources'), payload = join(resources, 'payload');
  mkdirSync(join(contents, 'MacOS'), { recursive: true }); mkdirSync(join(payload, 'bin'), { recursive: true });
  for (const name of ['build', 'dist']) { if (!existsSync(join(root, 'script', name))) throw new Error('请先运行npm run build'); cpSync(join(root, 'script', name), join(payload, 'script', name), { recursive: true }); }
  for (const name of ['package.json', 'package-lock.json']) cpSync(join(root, 'script', name), join(payload, 'script', name));
  // Install only production dependencies into a fresh bundle, never copy the working tree or data.
  execFileSync('npm', ['ci', '--omit=dev'], { cwd: join(payload, 'script'), stdio: 'inherit' });
  mkdirSync(join(payload, 'script/tools')); cpSync(join(root, 'script/tools/run.sh'), join(payload, 'script/tools/run.sh'));
  mkdirSync(join(payload, 'reports')); for (const name of ['README.md', 'FEISHU.md', 'DINGTALK.md', 'DISTRIBUTION.md', 'MODELS.md', 'MODEL_EVALUATION.md', 'CHANGELOG.md', 'FUNDS.md']) cpSync(join(root, 'reports', name), join(payload, 'reports', name));
  cpSync(join(root, 'LICENSE'), join(payload, 'LICENSE')); cpSync(process.execPath, join(payload, 'bin/node'));
  const nodeLicense = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, { signal: AbortSignal.timeout(30000) });
  if (!nodeLicense.ok) throw new Error('无法取得Node发行版许可证，安装包未生成');
  writeFileSync(join(payload, 'NODE-LICENSE.txt'), await nodeLicense.text());
  execFileSync('swiftc', ['-swift-version', '5', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`, '-O', join(root, 'script/desktop/Launcher.swift'), '-o', join(contents, 'MacOS/RecordMoney')], { stdio: 'inherit' });
  cpSync(join(contents, 'MacOS/RecordMoney'), join(payload, 'bin/launcher'));
  execFileSync('swiftc', ['-swift-version', '5', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`, '-O', join(root, 'script/desktop/WakeMonitor.swift'), '-o', join(payload, 'bin/wake-monitor')], { stdio: 'inherit' });
  if (execFileSync(join(payload, 'bin/wake-monitor'), ['--self-test'], { encoding: 'utf8', timeout: 10000 }).trim() !== 'wake') throw new Error('Mac唤醒监听验收失败');
  writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.record-money.desktop</string><key>CFBundleExecutable</key><string>RecordMoney</string><key>CFBundleName</key><string>私人记账助手</string><key>CFBundleIconFile</key><string>AppIcon</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string><key>LSMinimumSystemVersion</key><string>14.0</string><key>LSUIElement</key><true/></dict></plist>`);
  const icons = join(temp, 'AppIcon.iconset'); mkdirSync(icons);
  for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
    const pixels = size * scale, canvas = createCanvas(pixels, pixels), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#397e6c'; ctx.beginPath(); ctx.roundRect(pixels * .05, pixels * .05, pixels * .9, pixels * .9, pixels * .16); ctx.fill();
    const icon = await loadImage(Buffer.from(renderToStaticMarkup(React.createElement(Wallet, { size: pixels * .55, color: '#ffffff', strokeWidth: 1.7 }))));
    ctx.drawImage(icon, pixels * .225, pixels * .225, pixels * .55, pixels * .55);
    writeFileSync(join(icons, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`), canvas.toBuffer('image/png'));
  }
  execFileSync('iconutil', ['-c', 'icns', icons, '-o', join(resources, 'AppIcon.icns')]);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  mkdirSync(output, { recursive: true }); const archive = join(output, `record-money-v${version}-macos-${process.arch}.zip`);
  if (existsSync(archive)) throw new Error('安装包已存在，请选择新输出目录');
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
  writeFileSync(archive + '.sha256', createHash('sha256').update(readFileSync(archive)).digest('hex') + '  ' + archive.split('/').at(-1) + '\n');
  console.log(JSON.stringify({ archive, version, arch: process.arch, signed: 'ad-hoc', notarized: false }));
} finally { rmSync(temp, { recursive: true, force: true }); }
