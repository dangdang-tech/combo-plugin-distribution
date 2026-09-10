import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRelease } from './release-lib.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--allow-pending')) {
    throw new Error('Usage: node scripts/verify-release.mjs [--allow-pending]');
  }
  const release = await verifyRelease(resolve(dirname(fileURLToPath(import.meta.url)), '..'), {
    allowPending: args[0] === '--allow-pending',
  });
  console.log(JSON.stringify({ status: release.status, version: release.version,
    artifactSetSha256: release.artifactSetSha256, files: release.files.length }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
