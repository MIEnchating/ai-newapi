import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';

const searchRoots = [process.cwd(), __dirname];
const candidates = Array.from(
  new Set(
    searchRoots.flatMap((root) =>
      Array.from({ length: 7 }, (_, depth) =>
        join(root, ...Array.from({ length: depth }, () => '..'), '.env')
      )
    )
  )
);
const envPath = candidates.find((candidate) => existsSync(candidate));

if (envPath) {
  loadEnvFile(envPath);
}
