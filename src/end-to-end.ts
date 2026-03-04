// ============================================================================
// End-to-End Storage Demo
// ============================================================================
// Run: pnpm tsx src/end-to-end.ts
//
// This is the "hero script" — it walks through the ENTIRE storage lifecycle:
//   1. Health check
//   2. Create bucket (on-chain tx)
//   3. Verify bucket (read from Substrate)
//   4. Wait for MSP to index the bucket
//   5. Upload a file (on-chain storage request + off-chain blob upload)
//   6. Wait for MSP confirmation + BSP replication
//   7. Download the file back
//   8. Verify byte-for-byte integrity
//
// This is the best script to demo first during the workshop — it shows
// the full picture of how on-chain and off-chain layers work together.
// ============================================================================

import '@storagehub/api-augment';
import { initWasm } from '@storagehub-sdk/core';
import { polkadotApi } from './services/clientService.js';
import {
  downloadFile,
  uploadFile,
  verifyDownload,
  waitForBackendFileReady,
  waitForMSPConfirmOnChain,
} from './operations/fileOperations.js';
import { HealthStatus } from '@storagehub-sdk/msp-client';
import { mspClient } from './services/mspService.js';
import { createBucket, verifyBucketCreation, waitForBackendBucketReady } from './operations/bucketOperations.js';

async function run() {
  await initWasm();

  console.log('Starting DataHaven Storage End-to-End Script...');

  // -- Step 1: Health Check --
  const mspHealth: HealthStatus = await mspClient.info.getHealth();
  console.log('MSP Health Status:', mspHealth);

  // -- Step 2: Create Bucket --
  // Change this name each time you run the script — bucket names
  // must be unique per wallet (the ID is derived from address + name).
  const bucketName = 'INSERT-UNIQUE-NAME-HERE';
  const { bucketId, txReceipt } = await createBucket(bucketName);
  console.log(`Created Bucket ID: ${bucketId}`);
  console.log(`createBucket() txReceipt: ${txReceipt}`);

  // -- Step 3: Verify On-Chain --
  const bucketData = await verifyBucketCreation(bucketId);
  console.log('Bucket data:', bucketData);

  // -- Step 4: Wait for MSP Backend --
  await waitForBackendBucketReady(bucketId);

  // -- Step 5: Upload File --
  // import.meta.url gives us the current file's URL, so we can
  // resolve the sample image relative to this script regardless of cwd.
  const fileName = 'bruce-the-moose.png';
  const filePath = new URL(`./files/${fileName}`, import.meta.url).pathname;

  const { fileKey, uploadReceipt } = await uploadFile(bucketId, filePath, fileName);
  console.log(`File uploaded: ${fileKey}`);
  console.log(`Status: ${uploadReceipt.status}`);

  // -- Step 6: Wait for Confirmations --
  // Two waits here:
  //   a) waitForMSPConfirmOnChain — MSP tells the chain it accepted the file
  //   b) waitForBackendFileReady — BSPs replicate and file status becomes "ready"
  await waitForMSPConfirmOnChain(fileKey.toHex());
  await waitForBackendFileReady(bucketId, fileKey.toHex());

  // -- Step 7: Download File --
  const downloadedFilePath = new URL('./files/bruce-the-moose-downloaded.png', import.meta.url).pathname;
  const downloadedFile = await downloadFile(fileKey, downloadedFilePath);
  console.log(`File type: ${downloadedFile.mime}`);
  console.log(`Downloaded ${downloadedFile.size} bytes to ${downloadedFile.path}`);

  // -- Step 8: Verify Integrity --
  // This proves the file wasn't corrupted — the downloaded bytes
  // are identical to what we originally uploaded.
  const isValid = await verifyDownload(filePath, downloadedFilePath);
  console.log(`File integrity verified: ${isValid ? 'PASSED' : 'FAILED'}`);

  console.log('DataHaven Storage End-to-End Script Completed Successfully.');

  await polkadotApi.disconnect();
}

run();
