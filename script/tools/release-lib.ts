import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const allowed = ['README.md', 'LICENSE', '.gitignore', '.dockerignore',
  'reports/README.md', 'reports/FEISHU.md', 'reports/DISTRIBUTION.md', 'reports/MODELS.md', 'reports/CHANGELOG.md',
  'script/package.json', 'script/package-lock.json', 'script/config.example.env', 'script/tsconfig.json', 'script/tsconfig.server.json',
  'script/vite.config.ts', 'script/Dockerfile', 'script/compose.yaml', 'script/src', 'script/web', 'script/test', 'script/tools'];
export function packageFiles(root: string) {
  const files: string[] = [];
  function walk(path: string) {
    const full = join(root, path), stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error('发布路径不允许符号链接：' + path);
    if (stat.isDirectory()) for (const child of readdirSync(full).sort()) walk(join(path, child));
    else {
      if (/\.env$|\.sqlite(?:-[a-z]+)?$|\.log$|\.pem$|\.key$/.test(path) && path !== 'script/config.example.env') throw new Error('拒绝发布私密或运行文件：' + path);
      if (path.startsWith('script/') && !/\.(ts|tsx|css|html|json|sh)$/.test(path) && !['script/config.example.env', 'script/Dockerfile', 'script/compose.yaml'].includes(path)) throw new Error('非源文件，拒绝发布：' + path);
      const text = readFileSync(full, 'utf8');
      if (/\bsk-[A-Za-z0-9_-]{20,}/.test(text) || /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(text)) throw new Error('疑似密钥，拒绝发布：' + path);
      files.push(path);
    }
  }
  for (const path of allowed) walk(path);
  return files.sort();
}
export function buildRelease(root: string, output: string) {
  const version = JSON.parse(readFileSync(join(root, 'script', 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('版本号无效');
  const files = packageFiles(root), temp = mkdtempSync(join(tmpdir(), 'record-money-release-'));
  const name = 'record-money-v' + version, stage = join(temp, name);
  const target = resolve(output), archive = join(target, name + '.zip');
  if (existsSync(archive)) throw new Error('发布包已存在，请选择新目录或版本：' + basename(archive));
  try {
    for (const path of files) { mkdirSync(dirname(join(stage, path)), { recursive: true }); cpSync(join(root, path), join(stage, path)); }
    for (const dir of ['data', 'logs']) { mkdirSync(join(stage, dir)); writeFileSync(join(stage, dir, '.gitkeep'), ''); }
    const manifestFiles = [...files, 'data/.gitkeep', 'logs/.gitkeep'].sort();
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    writeFileSync(join(stage, 'FILES.sha256'), manifestFiles.map(path => hash(join(stage, path)) + '  ' + path).join('\n') + '\n');
    mkdirSync(target, { recursive: true });
    execFileSync('zip', ['-q', '-r', archive, name], { cwd: temp });
    writeFileSync(archive + '.sha256', hash(archive) + '  ' + basename(archive) + '\n');
    return { archive, files: manifestFiles.length, version };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
