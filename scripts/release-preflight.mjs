import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const requiredFiles = [
  'src-tauri/tauri.release.conf.json',
  'src-tauri/sidecar/server.bundle.cjs',
  'src-tauri/binaries/neural-os-node-aarch64-apple-darwin',
  'src-tauri/binaries/neural-os-node-x86_64-apple-darwin',
  '.github/workflows/release-macos.yml',
];

const requiredCiEnv = [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
  'TAURI_UPDATER_ENDPOINT',
  'TAURI_UPDATER_PUBKEY',
];

async function fileExists(relativePath) {
  try {
    await fs.access(path.join(rootDir, relativePath));
    return true;
  } catch {
    return false;
  }
}

function isSet(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTruthy(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function summarizeMissing(values) {
  return values.map((item) => `  - ${item}`).join('\n');
}

async function run() {
  const missingFiles = [];
  for (const relativePath of requiredFiles) {
    if (!(await fileExists(relativePath))) {
      missingFiles.push(relativePath);
    }
  }

  if (missingFiles.length > 0) {
    throw new Error(
      `Release preflight failed: required files are missing:\n${summarizeMissing(missingFiles)}`,
    );
  }

  const runningInCi = String(process.env.CI || '').toLowerCase() === 'true';
  const allowUnsignedCi = isTruthy(process.env.RELEASE_PREFLIGHT_ALLOW_UNSIGNED_CI);
  if (runningInCi) {
    const missingEnv = requiredCiEnv.filter((name) => !isSet(process.env[name]));
    if (missingEnv.length > 0) {
      if (!allowUnsignedCi) {
        throw new Error(
          `Release preflight failed: required CI secrets/env are missing:\n${summarizeMissing(missingEnv)}`,
        );
      }
      process.stdout.write(
        `[release-preflight] warning unsigned CI release mode enabled; missing secrets:\n${summarizeMissing(
          missingEnv,
        )}\n`,
      );
    }
  }

  const endpoint = process.env.TAURI_UPDATER_ENDPOINT;
  if (isSet(endpoint) && !/^https?:\/\//i.test(String(endpoint))) {
    throw new Error('Release preflight failed: TAURI_UPDATER_ENDPOINT must be an absolute http(s) URL.');
  }

  process.stdout.write('[release-preflight] ok\n');
  if (!runningInCi) {
    process.stdout.write('[release-preflight] CI secret validation skipped (not running in CI).\n');
  }
}

run().catch((error) => {
  console.error('[release-preflight] failed', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
