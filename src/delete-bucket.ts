// ============================================================================
// Delete Bucket Demo
// ============================================================================
// Run: pnpm tsx src/delete-bucket.ts
//
// Demonstrates how to delete an empty bucket:
//   1. Authenticate via SIWE
//   2. Fetch bucket metadata from the MSP
//   3. Check that the bucket has no files (deletion will revert if not empty)
//   4. Submit the deletion transaction on-chain
//
// IMPORTANT: Delete all files in the bucket FIRST (use delete-file.ts).
// You cannot delete a bucket that still contains files.
// ============================================================================

import '@storagehub/api-augment';
import { initWasm } from '@storagehub-sdk/core';
import { polkadotApi } from './services/clientService.js';
import { authenticateUser } from './services/mspService.js';
import { deleteBucket, getBucketFromMSP } from './operations/bucketOperations.js';

async function run() {
  await initWasm();

  // Replace with your bucket ID.
  const bucketId: `0x${string}` = 'INSERT-UNIQUE-BUCKET-ID-HERE' as `0x${string}`;

  const authProfile = await authenticateUser();
  console.log('Authenticated user profile:', authProfile);

  // Fetch bucket info from the MSP to check its file count.
  const bucket = await getBucketFromMSP(bucketId);
  console.log('Bucket:', bucket);

  if (!bucket) {
    throw new Error(`Bucket not found: ${bucketId}`);
  }

  // Safety check — only delete if the bucket is empty.
  // The on-chain transaction would revert anyway, but this saves gas.
  if (bucket.fileCount === 0) {
    const isBucketDeletionSuccessful = await deleteBucket(bucketId);
    console.log('Bucket deletion successful:', isBucketDeletionSuccessful);
  }

  await polkadotApi.disconnect();
}

run();
