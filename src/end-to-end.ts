// ============================================================================
// End-to-End Storage Demo
// ============================================================================
// Run: pnpm tsx src/end-to-end.ts
//
// This is the "hero script" — it walks through the ENTIRE storage lifecycle:
//   1. Health check
//   2. Create bucket (on-chain tx)
//   3. Verify bucket (read from Substrate)
//   4. Upload a file (on-chain storage request + off-chain blob upload)
//   5. Wait for on-chain MSP confirmation
//   6. Download the file back
//   7. Verify byte-for-byte integrity
//   8. Wait for file to be fully replicated
//
// ============================================================================

import '@storagehub/api-augment';
import { initWasm } from '@storagehub-sdk/core';
import { polkadotApi } from './services/clientService.js';
import {
  downloadFile,
  uploadFile,
  verifyDownload,
  waitForBackendFileAvailable,
  waitForFileReplicationComplete,
  waitForMSPConfirmOnChain,
} from './operations/fileOperations.js';
import { HealthStatus } from '@storagehub-sdk/msp-client';
import { mspClient } from './services/mspService.js';
import { createBucket, verifyBucketCreation } from './operations/bucketOperations.js';
import { fileURLToPath } from 'node:url';

async function run() {
  await initWasm();

  console.log('Starting DataHaven Storage End-to-End Script...');

  // -- Step 1: Health Check --
  const mspHealth: HealthStatus = await mspClient.info.getHealth();
  console.log('MSP Health Status:', mspHealth);

  // -- Step 2: Create Bucket --
  // Change this name each time you run the script — bucket names
  // must be unique per wallet (the ID is derived from address + name).
  const bucketName = 'bucket-' + Date.now();
  const { bucketId, txReceipt } = await createBucket(bucketName);
  console.log(`Created Bucket ID: ${bucketId}`);
  console.log(`createBucket() txReceipt: ${txReceipt}`);

  // -- Step 3: Verify On-Chain --
  const bucketData = await verifyBucketCreation(bucketId);
  console.log('Bucket data:', bucketData);

  // -- Step 4: Upload File --
  // import.meta.url gives us the current file's URL, so we can
  // resolve the sample image relative to this script regardless of cwd.
  const fileName = 'henloworld.txt';
  const filePath = fileURLToPath(new URL(`./files/${fileName}`, import.meta.url));

  const { fileKey, uploadReceipt } = await uploadFile(bucketId, filePath, fileName);
  console.log(`File uploaded: ${fileKey}`);
  console.log(`Status: ${uploadReceipt?.status}`);

  // -- Step 5: Wait for MSP to tell the chain it accepted the file --
  await waitForMSPConfirmOnChain(fileKey);
  await waitForBackendFileAvailable(bucketId, fileKey);

  // -- Step 6: Download File --
  // const downloadedFilePath = fileURLToPath(new URL(`./files/henloworld-downloaded.txt`, import.meta.url));
  const downloadedFilePath = new URL(`./files/downloaded/henloworld-downloaded.txt`, import.meta.url).pathname;
  const downloadedFile = await downloadFile(fileKey, downloadedFilePath);
  console.log(`File type: ${downloadedFile.mime}`);
  console.log(`Downloaded ${downloadedFile.size} bytes to ${downloadedFile.path}`);

  // -- Step 7: Verify Integrity --
  // This proves the file wasn't corrupted — the downloaded bytes
  // are identical to what we originally uploaded.
  const isValid = await verifyDownload(filePath, downloadedFilePath);
  console.log(`File integrity verified: ${isValid ? 'PASSED' : 'FAILED'}`);

  // -- Step 8: Wait for Full Replication --
  // Wait for BSPs to fully replicate the file.
  // The file should transition from "inProgress" → "ready".
  const finalFileInfo = await waitForFileReplicationComplete(bucketId, fileKey);
  console.log(`Final file status: ${finalFileInfo.status}`);

  console.log('DataHaven Storage End-to-End Script Completed Successfully.');

  await polkadotApi.disconnect();
}

run();
