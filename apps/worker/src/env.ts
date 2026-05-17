import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';

const candidates = [join(process.cwd(), '.env'), join(process.cwd(), '..', '..', '.env')];
const envPath = candidates.find((candidate) => existsSync(candidate));

if (envPath) {
  loadEnvFile(envPath);
}
