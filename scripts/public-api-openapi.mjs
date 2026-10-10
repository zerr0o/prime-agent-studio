import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateOpenApi } from '../lib/public-api-contract.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(ROOT, 'docs/api/openapi-v1.json');

const document = generateOpenApi();
await mkdir(dirname(TARGET), { recursive: true });
await writeFile(TARGET, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Wrote ${TARGET}`);
