// ============================================================================
// Create Bucket Demo
// ============================================================================
// Run: pnpm tsx src/create-bucket.ts
//
// This script demonstrates the bucket creation lifecycle:
//   1. Health check — make sure the MSP backend is alive
//   2. Create bucket — sends an on-chain transaction
//   3. Verify on-chain — read the bucket back from Substrate storage
//   4. Wait for backend — poll until the MSP has indexed the new bucket
//
// After running, you'll see your bucket ID in the console output.
// You can look it up on the block explorer: https://testnet.dhscan.io/
// ============================================================================

import '@storagehub/api-augment';
import { initWasm } from '@storagehub-sdk/core';
import { polkadotApi } from './services/clientService.js';
import { createBucket, verifyBucketCreation, waitForBackendBucketReady } from './operations/bucketOperations.js';
import { HealthStatus } from '@storagehub-sdk/msp-client';
import { mspClient } from './services/mspService.js';

async function run() {
  await initWasm();

  // Step 1 — Always check if the MSP is healthy before doing work.
  // If this returns anything other than "Ok", the backend is down.
  const mspHealth: HealthStatus = await mspClient.info.getHealth();
  console.log('MSP Health Status:', mspHealth);

  // Step 2 — Create a bucket.
  // Change this name to something unique if the bucket already exists.
  const bucketName = 'INSERT-UNIQUE-NAME-HERE';
  const { bucketId, txReceipt } = await createBucket(bucketName);
  console.log(`Created Bucket ID: ${bucketId}`);
  console.log(`createBucket() txReceipt: ${txReceipt}`);

  // Step 3 — Read the bucket back from on-chain storage to verify it exists
  // and the owner/MSP fields match our expectations.
  const bucketData = await verifyBucketCreation(bucketId);
  console.log('Bucket data:', bucketData);

  // Step 4 — The MSP backend indexes chain events asynchronously.
  // We poll until the bucket appears in the MSP's REST API so we know
  // it's safe to start uploading files into it.
  await waitForBackendBucketReady(bucketId);

  await polkadotApi.disconnect();
}

await run();
