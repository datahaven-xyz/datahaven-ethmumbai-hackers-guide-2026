// ============================================================================
// Update Bucket Privacy Demo
// ============================================================================
// Run: pnpm tsx src/update-bucket-privacy.ts
//
// Demonstrates how to toggle a bucket between public and private:
//   1. Call updateBucketPrivacy() — sends a tx to the FileSystem precompile
//   2. Read the bucket back from chain to verify the privacy flag changed
//
// Public buckets:  Anyone can download files without authentication.
// Private buckets: Downloads require SIWE authentication (proof of ownership).
//
// NOTE: This uses a direct contract call (walletClient.writeContract) rather
// than the SDK wrapper — a good example of how you can always fall back to
// raw ABI calls when needed.
// ============================================================================

import '@storagehub/api-augment';
import { initWasm } from '@storagehub-sdk/core';
import { polkadotApi } from './services/clientService.js';
import { verifyBucketCreation, updateBucketPrivacy } from './operations/bucketOperations.js';

async function run() {
  await initWasm();

  // Replace with your bucket ID.
  const bucketId: `0x${string}` = 'INSERT-UNIQUE-BUCKET-ID-HERE' as `0x${string}`;

  // Set to true for private, false for public.
  await updateBucketPrivacy(bucketId, true);

  // Read the bucket data back from Substrate to confirm the change.
  const bucketDataAfterPrivate = await verifyBucketCreation(bucketId);
  console.log('Bucket data after setting private:', bucketDataAfterPrivate);
  console.log(`Privacy after update: ${bucketDataAfterPrivate.private}\n`);

  await polkadotApi.disconnect();
}

run();
