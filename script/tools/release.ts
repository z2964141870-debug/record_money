import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { buildRelease } from './release-lib.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = process.argv[2] ? resolve(process.argv[2]) : join(root, 'data', 'releases');
console.log(JSON.stringify(buildRelease(root, output), null, 2));
