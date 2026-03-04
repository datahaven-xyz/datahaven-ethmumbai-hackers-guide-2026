// ============================================================================
// Delete File Demo
// ============================================================================
// Run: pnpm tsx src/delete-file.ts
//
// Demonstrates how to delete a file from a bucket:
//   1. Authenticate via SIWE (required for file operations)
//   2. List buckets and files to confirm what exists
//   3. Submit a file deletion request (on-chain transaction)
//   4. Wait for the MSP backend to process the deletion
//
// IMPORTANT: Update bucketId and fileKey below with values from your
// previous upload. You can find these in the output of end-to-end.ts.
// ============================================================================

import '@storagehub/api-augment';
import { initWasm } from '@storagehub-sdk/core';
import { polkadotApi } from './services/clientService.js';
import { authenticateUser } from './services/mspService.js';
import { getBucketFilesFromMSP, requestDeleteFile } from './operations/fileOperations.js';
import { getBucketsFromMSP, waitForBackendBucketEmpty } from './operations/bucketOperations.js';

async function run() {
  await initWasm();

  // Replace these with your actual bucket ID and file key.
  const bucketId: `0x${string}` = 'INSERT-UNIQUE-BUCKET-ID-HERE' as `0x${string}`;
  const fileKey: `0x${string}` = 'INSERT-UNIQUE-FILE-KEY-HERE' as `0x${string}`;

  // File deletion requires SIWE authentication because it's a
  // privileged operation — only the bucket owner can delete files.
  const authProfile = await authenticateUser();
  console.log('Authenticated user profile:', authProfile);

  // List what we have before deleting, so we can see the before/after.
  const buckets = await getBucketsFromMSP();
  console.log('Buckets in MSP:', buckets);

  // Pick bucket from the list and show its files before deletion.

  const files = await getBucketFilesFromMSP(bucketId);
  console.log(`Files in bucket with ID ${bucketId}:`);
  console.log(JSON.stringify(files, null, 2));

  // requestDeleteFile() sends an on-chain transaction.
  // The MSP then removes the file data after confirming the deletion on-chain.
  const isDeletionRequestSuccessful = await requestDeleteFile(bucketId, fileKey);
  console.log('File deletion request submitted successfully:', isDeletionRequestSuccessful);

  // Wait for deletion request to be processed by the MSP backend.
  // This is needed if you plan to delete the bucket next, as buckets must be empty before deletion.

  // Wait until the MSP has processed the deletion.
  // This is needed if you plan to delete the bucket next — buckets must be empty.
  await waitForBackendBucketEmpty(bucketId);

  await polkadotApi.disconnect();
}

run();
