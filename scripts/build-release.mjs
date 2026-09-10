import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactDigest, MARKETPLACE, payloadInventory, REPOSITORY, VERSION, verifyRelease } from './release-lib.mjs';

// Maintainer-only mechanical inventory generation, after independent artifact review.
try {
  if (process.argv.slice(2).join(' ') !== '--reviewed-payload') {
    throw new Error('Usage after artifact review: node scripts/build-release.mjs --reviewed-payload');
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const files = await payloadInventory(root);
  const release = { schema: 'combo-plugin-public-release/1', version: VERSION, channel: 'test',
    status: 'test', marketplace: MARKETPLACE, repository: REPOSITORY,
    artifactSetSha256: artifactDigest(files), files,
    evidence: { distributionChecks: 'run_for_candidate_commit', codexHostExtraction: 'not_run',
      claudeHostExtraction: 'not_run', modelTaskExecution: 'not_run' } };
  await verifyRelease(root, { candidateRelease: release });
  await writeFile(resolve(root, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  console.log(JSON.stringify({ artifactSetSha256: release.artifactSetSha256, files: files.length }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
