import { register } from 'node:module';
import { realpathSync } from 'node:fs';
const packageRoot = process.env.PRIME_STUDIO_RELAY_PACKAGE;
if (packageRoot)
  register('./daemon-stream-hook.mjs', import.meta.url, { data: { packageRoot: realpathSync(packageRoot) } });
