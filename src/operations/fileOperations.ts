import { createReadStream, statSync, createWriteStream, exists } from 'node:fs';
import { on, Readable } from 'node:stream';
import { FileManager, ReplicationLevel, FileInfo } from '@storagehub-sdk/core';
import { TypeRegistry } from '@polkadot/types';
import { AccountId20, H256 } from '@polkadot/types/interfaces';
import { address, polkadotApi, account } from '../services/clientService.js';
import { getMspInfo, authenticateUser, mspClient } from '../services/mspService.js';
import { DownloadResult, FileListResponse } from '@storagehub-sdk/msp-client';
import { PalletFileSystemStorageRequestMetadata } from '@polkadot/types/lookup';
import { storageHubClient, publicClient } from '../services/clientService.js';
import { request } from 'node:http';
import { chain } from '../config/networks.js';

// ============================================================================
// File Operations
// ============================================================================
// File upload is the most involved operation in DataHaven. It spans BOTH layers:
//
//   ON-CHAIN (via storageHubClient):
//     1. Issue a "storage request" — tells the network you want to store a file
//     2. The chain records the file's fingerprint, size, and target MSP
//
//   OFF-CHAIN (via mspClient):
//     3. Authenticate with the MSP via SIWE
//     4. Upload the actual file bytes to the MSP backend
//     5. The MSP confirms on-chain that it received the file
//     6. BSPs (Backup Storage Providers) replicate the file for redundancy
//
// Downloads are simpler — just fetch the file stream from the MSP backend.
// ============================================================================

// uploadFile()
// The complete upload flow in one function. Three phases:
//   Phase 1: Issue storage request on-chain (registers intent to store)
//   Phase 2: Verify the storage request exists on-chain
//   Phase 3: Authenticate with MSP and upload the actual file bytes
export async function uploadFile(bucketId: `0x${string}`, filePath: string, fileName: string) {
  // -- Phase 1: Issue Storage Request --

  // FileManager is the SDK's file abstraction. It wraps a file stream
  // and provides methods to compute fingerprints, file keys, and get file blobs.
  // The stream factory pattern (a function returning a stream) allows re-reading.
  const fileSize = statSync(filePath).size;
  const fileManager = new FileManager({
    size: fileSize,
    stream: () => Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>,
  });
  const bucketFilePath = 'reports/Q1/' + fileName; // this is the "path within the bucket" where the file will be stored

  // The fingerprint is a content hash of the file (like a checksum).
  // It's stored on-chain so anyone can verify the file's integrity later.
  const fingerprintH256 = await fileManager.getFingerprint();
  const fingerprint = fingerprintH256.toHex();
  console.log(`Fingerprint: ${fingerprint}`);

  const fileSizeBigInt = BigInt(fileManager.getFileSize());
  console.log(`File size: ${fileSize} bytes`);

  // We need the MSP's on-chain ID and its libp2p peer IDs.
  // The peer IDs are how the network knows where to find this MSP over P2P.
  // Fetch MSP details from the backend (includes its on-chain ID and libp2p addresses)
  const { mspId, multiaddresses } = await getMspInfo();
  // Ensure the MSP exposes at least one multiaddress (required to reach it over libp2p)
  if (!multiaddresses?.length) {
    throw new Error('MSP multiaddresses are missing');
  }
  // Extract the MSP's libp2p peer IDs from the multiaddresses
  // Each address should contain a `/p2p/<peerId>` segment
  const peerIds: string[] = extractPeerIDs(multiaddresses);
  // Validate that at least one valid peer ID was found
  if (peerIds.length === 0) {
    throw new Error('MSP multiaddresses had no /p2p/<peerId> segment');
  }

  // Extracts libp2p peer IDs from a list of multiaddresses.
  // A multiaddress commonly ends with `/p2p/<peerId>`, so this function
  // splits on that delimiter and returns the trailing segment when present.
  function extractPeerIDs(multiaddresses: string[]): string[] {
    return (multiaddresses ?? []).map((addr) => addr.split('/p2p/').pop()).filter((id): id is string => !!id);
  }

  // Set the redundancy policy for this request.
  // Custom replication allows the client to specify an exact replica count.
  const replicationLevel = ReplicationLevel.Custom;
  const replicas = 1;

  // issueStorageRequest() sends a transaction that says:
  // "I want to store this file (identified by fingerprint + size) in this bucket,
  //  with this MSP, at this replication level."
  // The chain records the intent. The MSP will pick it up and store the actual bytes.
  const txHash: `0x${string}` | undefined = await storageHubClient.issueStorageRequest(
    bucketId,
    bucketFilePath,
    fingerprint,
    fileSizeBigInt,
    mspId,
    peerIds,
    replicationLevel,
    replicas
  );
  console.log('issueStorageRequest() txHash:', txHash);
  if (!txHash) {
    throw new Error('issueStorageRequest() did not return a transaction hash');
  }

  // Wait for storage request transaction
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  if (receipt.status !== 'success') {
    throw new Error(`Storage request failed: ${txHash}`);
  }
  console.log('issueStorageRequest() txReceipt:', receipt);

  // -- Phase 2: Verify Storage Request On-Chain --

  // The file key is a unique identifier derived from (owner + bucketId + fileName).
  // It's how the chain and MSP refer to a specific file. We use Polkadot type registry
  // to create properly typed inputs for the WASM computation.
  const registry = new TypeRegistry();
  const owner = registry.createType('AccountId20', account.address) as AccountId20;
  const bucketIdH256 = registry.createType('H256', bucketId) as H256;
  const fileKeyH256 = await fileManager.computeFileKey(owner, bucketIdH256, bucketFilePath);
  const fileKey = fileKeyH256.toHex();
  console.log(`Computed file key: ${fileKey}`);

  // Verify storage request on chain
  const storageRequest = await polkadotApi.query.fileSystem.storageRequests(fileKey);
  if (!storageRequest.isSome) {
    throw new Error('Storage request not found on chain');
  }

  // Read the storage request data
  const storageRequestData = storageRequest.unwrap().toHuman();
  console.log('Storage request data:', storageRequestData);
  console.log('Storage request bucketId matches initial bucketId:', storageRequestData.bucketId === bucketId);
  console.log(
    'Storage request fingerprint matches initial fingerprint',
    storageRequestData.fingerprint === fingerprint
  );

  // -- Phase 3: Upload File Bytes to MSP --

  // Before uploading, we must prove we own the wallet via SIWE.
  // This prevents unauthorized uploads into someone else's bucket.
  const authProfile = await authenticateUser();
  console.log('Authenticated user profile:', authProfile);

  // This is where the actual file data leaves your machine and goes to the MSP.
  // The MSP receives: bucket ID, file key, file blob, fingerprint, owner address, and filename.
  const uploadReceipt = await uploadFileToMSPWithRetry(
    bucketId,
    fileKey,
    await fileManager.getFileBlob(),
    fingerprint,
    address,
    bucketFilePath
  );

  return { fileKey, uploadReceipt };
}

// downloadFile()
// Downloads are simpler than uploads — no on-chain transaction needed.
// We just request the file stream from the MSP using the file key,
// then pipe it to a local file.
export async function downloadFile(
  fileKey: `0x${string}`,
  downloadPath: string
): Promise<{ path: string; size: number; mime?: string }> {
  // Download file from MSP
  const downloadResponse: DownloadResult = await mspClient.files.downloadFile(fileKey);
  // Check if the download response was successful
  if (downloadResponse.status !== 200) {
    throw new Error(`Download failed with status: ${downloadResponse.status}`);
  }

  // Save downloaded file

  // Create a writable stream to the target file path
  // This stream will receive binary data chunks and write them to disk.
  const writeStream = createWriteStream(downloadPath);
  // Convert the Web ReadableStream into a Node.js-readable stream
  const readableStream = Readable.fromWeb(downloadResponse.stream as any);

  // Pipe the readable (input) stream into the writable (output) stream
  // This transfers the file data chunk by chunk and closes the write stream automatically
  // when finished.
  return new Promise((resolve, reject) => {
    readableStream.pipe(writeStream);
    writeStream.on('finish', async () => {
      const { size } = await import('node:fs/promises').then((fs) => fs.stat(downloadPath));
      const mime = downloadResponse.contentType === null ? undefined : downloadResponse.contentType;

      resolve({
        path: downloadPath,
        size,
        mime, // if available
      });
    });
    writeStream.on('error', reject);
  });
}

// verifyDownload()
// Byte-for-byte comparison to prove the downloaded file is identical to the original.
// This is the integrity guarantee — the fingerprint stored on-chain ensures
// that what you get back is exactly what you uploaded.
export async function verifyDownload(originalPath: string, downloadedPath: string): Promise<boolean> {
  const originalBuffer = await import('node:fs/promises').then((fs) => fs.readFile(originalPath));
  const downloadedBuffer = await import('node:fs/promises').then((fs) => fs.readFile(downloadedPath));

  return originalBuffer.equals(downloadedBuffer);
}

// uploadFileToMSPWithRetry()
// After issuing a storage request on-chain, the MSP may not have picked it up yet.
// This function retries the file upload until the MSP accepts it.
async function uploadFileToMSPWithRetry(
  bucketId: `0x${string}`,
  fileKey: `0x${string}`,
  fileBlob: Blob,
  fingerprint: `0x${string}`,
  address: `0x${string}`,
  bucketFilePath: string
) {
  const maxAttempts = 10; // Number of upload attempts
  const delayMs = 1000; // Delay between attempts in milliseconds

  for (let i = 0; i < maxAttempts; i++) {
    console.log(`Uploading file to MSP, attempt ${i + 1} of ${maxAttempts}...`);

    try {
      const uploadReceipt = await mspClient.files.uploadFile(
        bucketId,
        fileKey,
        fileBlob,
        fingerprint,
        address,
        bucketFilePath
      );

      if (uploadReceipt.status === 'upload_successful') {
        console.log('File upload receipt:', uploadReceipt);
        return uploadReceipt;
      }

      // Non-successful status — retryable
      console.log(`Upload status is "${uploadReceipt.status}", waiting...`);
    } catch (error: any) {
      // Backend hasn't indexed the storage request yet
      if (error.status === 404 || error.body.error === 'Not found: Record') {
        console.log(`Storage request not found in MSP backend yet (404).`);
      } else {
        // Any other error is unexpected and should fail the entire workflow
        console.log('Unexpected error while uploading file to MSP:', error);
        throw error;
      }
    }

    // Wait before retrying
    await new Promise((r) => setTimeout(r, delayMs));
  }

  // All attempts exhausted
  throw new Error('Timed out waiting for file upload to MSP');
}

// waitForMSPConfirmOnChain()
// After you upload a file, the MSP must confirm on-chain that it received it.
// This function polls the on-chain storage request until the MSP's status
// changes to "AcceptedNewFile" or "AcceptedExistingFile".
// Until the MSP confirms, the file isn't considered stored by the network.
export async function waitForMSPConfirmOnChain(fileKey: `0x${string}`) {
  const maxAttempts = 20; // Number of polling attempts
  const delayMs = 2000; // Delay between attempts in milliseconds

  for (let i = 0; i < maxAttempts; i++) {
    console.log(
      `Check if storage request has been confirmed by the MSP on-chain, attempt ${i + 1} of ${maxAttempts}...`
    );

    // Query the runtime for the StorageRequest entry associated with this fileKey
    const req = await polkadotApi.query.fileSystem.storageRequests(fileKey);

    // StorageRequest removed from state before confirmation is an error
    if (req.isNone) {
      throw new Error(`StorageRequest for ${fileKey} no longer exists on-chain.`);
    }
    // Decode the on-chain metadata struct
    const data: PalletFileSystemStorageRequestMetadata = req.unwrap();

    // Check MSP status
    const mspStatus = data.mspStatus;
    console.log(`MSP confirmation status: ${mspStatus.type}`);

    const mspConfirmed = mspStatus.isAcceptedNewFile || mspStatus.isAcceptedExistingFile;

    // If MSP has confirmed the storage request, we're good to proceed
    if (mspConfirmed) {
      console.log('Storage request confirmed by MSP on-chain');
      return;
    }

    // Wait before polling again
    await new Promise((r) => setTimeout(r, delayMs));
  }
  // All attempts exhausted
  throw new Error('Timed out waiting for MSP confirmation on-chain');
}

// waitForBackendFileAvailable()
// After the MSP confirms on-chain, the file needs to be indexed in the backend
// before it can be downloaded. This polls until the file is available (status
// "ready" or "inProgress"), meaning the MSP has it and can serve it.
// The file transitions through statuses:
//   pending → inProgress (MSP has it, BSPs still replicating — downloadable)
//   pending → ready      (fully replicated — downloadable)
//   pending → revoked    (user cancelled)
//   pending → rejected   (MSP refused)
//   pending → expired    (BSPs didn't replicate in time)
export async function waitForBackendFileAvailable(bucketId: `0x${string}`, fileKey: `0x${string}`) {
  // wait up to 12 minutes (144 attempts x 5 seconds)
  // 11 minutes is the amount of time BSPs have to reach the required replication level
  const maxAttempts = 144; // Number of polling attempts
  const delayMs = 5000; // Delay between attempts in milliseconds

  for (let i = 0; i < maxAttempts; i++) {
    console.log(`Checking for file in MSP backend, attempt ${i + 1} of ${maxAttempts}...`);

    try {
      // Query MSP backend for the file metadata
      const fileInfo = await mspClient.files.getFileInfo(bucketId, fileKey);

      // File is fully ready — backend has indexed it and can serve it
      if (fileInfo.status === 'ready' || fileInfo.status === 'inProgress') {
        console.log('File found in MSP backend:', fileInfo);
        return fileInfo;
      }

      // Failure statuses (irrecoverable for this upload lifecycle)
      if (fileInfo.status === 'revoked') {
        throw new Error('File upload was cancelled by user');
      } else if (fileInfo.status === 'rejected') {
        throw new Error('File upload was rejected by MSP');
      } else if (fileInfo.status === 'expired') {
        throw new Error(
          'Storage request expired: the required number of BSP replicas was not achieved within the deadline'
        );
      }

      // Otherwise still pending (indexer not done, MSP still syncing, etc.)
      console.log(`File status is "${fileInfo.status}", waiting...`);
    } catch (error: any) {
      if (error?.status === 404 || error?.body?.error === 'Not found: Record') {
        // Handle "not yet indexed" as a *non-fatal* condition
        console.log('File not yet indexed in MSP backend (404 Not Found). Waiting before retry...');
      } else {
        // Any unexpected backend error should stop the workflow and surface to the caller
        console.log('Unexpected error while fetching file from MSP:', error);
        throw error;
      }
    }

    // Wait before polling again
    await new Promise((r) => setTimeout(r, delayMs));
  }

  // All attempts exhausted
  throw new Error('Timed out waiting for MSP backend to mark file as ready');
}

// waitForFileReplicationComplete()
// After the file is available for download, BSPs still need to fully replicate it.
// This polls until the file reaches a terminal state:
//   "ready"   — BSPs replicated successfully (ideal outcome)
//   "revoked" — user cancelled
//   "rejected"— MSP refused
//   "expired" — BSPs didn't replicate in time
// Unlike waitForBackendFileAvailable, this does NOT accept "inProgress" as a
// success condition — it waits for the replication process to fully resolve.
export async function waitForFileReplicationComplete(bucketId: `0x${string}`, fileKey: `0x${string}`) {
  // wait up to 12 minutes (144 attempts x 5 seconds)
  // 11 minutes is the amount of time BSPs have to reach the required replication level
  const maxAttempts = 144; // Number of polling attempts
  const delayMs = 5000; // Delay between attempts in milliseconds

  for (let i = 0; i < maxAttempts; i++) {
    console.log(`Waiting for file replication to complete, attempt ${i + 1} of ${maxAttempts}...`);

    try {
      const fileInfo = await mspClient.files.getFileInfo(bucketId, fileKey);

      // Terminal states — replication has resolved one way or another
      const terminalStatuses = ['ready', 'revoked', 'rejected', 'expired'];
      if (terminalStatuses.includes(fileInfo.status)) {
        console.log(`File reached terminal status: "${fileInfo.status}"`, fileInfo);
        return fileInfo;
      }

      // Still in progress — BSPs are replicating
      console.log(`File status is "${fileInfo.status}", waiting for replication...`);
    } catch (error: any) {
      if (error?.status === 404 || error?.body?.error === 'Not found: Record') {
        console.log('File not yet indexed in MSP backend (404 Not Found). Waiting before retry...');
      } else {
        console.log('Unexpected error while fetching file from MSP:', error);
        throw error;
      }
    }

    // Wait before polling again
    await new Promise((r) => setTimeout(r, delayMs));
  }

  // All attempts exhausted
  throw new Error('Timed out waiting for file replication to complete');
}

export async function getBucketFilesFromMSP(bucketId: `0x${string}`): Promise<FileListResponse> {
  const files: FileListResponse = await mspClient.buckets.getFiles(bucketId);
  return files;
}

// requestDeleteFile()
// File deletion is also a two-layer operation:
//   1. Fetch file metadata from the MSP (needed for the signed deletion request)
//   2. Submit a deletion transaction on-chain
// The MSP then removes the file data after confirming the on-chain deletion.
export async function requestDeleteFile(bucketId: `0x${string}`, fileKey: `0x${string}`): Promise<boolean> {
  // Get file info before deletion
  const fileInfo: FileInfo = await mspClient.files.getFileInfo(bucketId, fileKey);
  console.log('File info:', fileInfo);

  // Request file deletion
  const txHashRequestDeleteFile: `0x${string}` = await storageHubClient.requestDeleteFile(fileInfo);
  console.log('requestDeleteFile() txHash:', txHashRequestDeleteFile);

  // Wait for delete file transaction receipt
  const receiptRequestDeleteFile = await publicClient.waitForTransactionReceipt({
    hash: txHashRequestDeleteFile,
  });
  console.log('requestDeleteFile() txReceipt:', receiptRequestDeleteFile);
  if (receiptRequestDeleteFile.status !== 'success') {
    throw new Error(`File deletion failed: ${txHashRequestDeleteFile}`);
  }

  console.log(`File deletion request with key ${fileKey} from bucket ${bucketId} was initiated successfully on-chain.`);
  return true;
}
