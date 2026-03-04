// ============================================================================
// Step-by-Step File Manipulation Demo
// ============================================================================
// Run: pnpm tsx src/file-manipulation.ts
//
// Unlike end-to-end.ts which uses the high-level uploadFile() helper,
// this script breaks down the file upload process into individual steps
// so you can see each piece in isolation:
//
//   Step 1: Initialize FileManager (wraps the file stream)
//   Step 2: Compute fingerprint + gather MSP details
//   Step 3: Issue a storage request on-chain
//   Step 4: Compute the file key
//   Step 5: Read the storage request data back from chain
//
// NOTE: This script does NOT upload the file bytes to the MSP. It only
// issues the on-chain storage request. To complete the upload, you'd need
// to authenticate via SIWE and call mspClient.files.uploadFile().
// ============================================================================

import '@storagehub/api-augment';
import { FileManager, initWasm, ReplicationLevel } from '@storagehub-sdk/core';
import { polkadotApi, storageHubClient, publicClient, account } from './services/clientService.js';
import { statSync, createReadStream } from 'fs';
import { Readable } from 'stream';
import { getMspInfo } from './services/mspService.js';
import { TypeRegistry } from '@polkadot/types';
import { AccountId20, H256 } from '@polkadot/types/interfaces';

async function run() {
  await initWasm();

  // Paste a bucket ID you created earlier (from create-bucket.ts output).
  // This must be an existing bucket that belongs to your wallet.
  const bucketId: `0x${string}` = 'INSERT-UNIQUE-BUCKET-ID-HERE' as `0x${string}`;

  const fileName = 'bruce-the-moose.png';
  const filePath = new URL(`./files/${fileName}`, import.meta.url).pathname;

  // -- Step 1: Initialize FileManager --
  // FileManager wraps a file as a lazy stream. The stream factory
  // pattern means the file isn't read into memory until needed.
  const fileSize = statSync(filePath).size;
  const fileManager = new FileManager({
    size: fileSize,
    stream: () => Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>,
  });

  // -- Step 2: Compute Fingerprint and Gather Parameters --
  // The fingerprint is a content-addressable hash of the file.
  // It's stored on-chain alongside the storage request.
  const fingerprint = await fileManager.getFingerprint();
  console.log(`Fingerprint: ${fingerprint.toHex()}`);

  const fileSizeBigInt = BigInt(fileManager.getFileSize());
  console.log(`File size in BigInt: ${fileSizeBigInt} bytes`);

  // We need the MSP's ID and peer IDs for the storage request parameters.
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

  // -- Step 3: Issue Storage Request --
  // This on-chain transaction says "I want to store this file".
  // All parameters (bucket, name, fingerprint, size, MSP, peers, replicas)
  // are encoded and sent as a single EVM transaction.
  const txHash: `0x${string}` | undefined = await storageHubClient.issueStorageRequest(
    bucketId,
    fileName,
    fingerprint.toHex() as `0x${string}`,
    fileSizeBigInt,
    mspId as `0x${string}`,
    peerIds,
    replicationLevel,
    replicas
  );
  console.log('issueStorageRequest() txHash:', txHash);
  if (!txHash) {
    throw new Error('issueStorageRequest() did not return a transaction hash');
  }

  // Wait for storage request transaction
  // Don't proceed until receipt is confirmed on chain
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  if (receipt.status !== 'success') {
    throw new Error(`Storage request failed: ${txHash}`);
  }
  console.log('issueStorageRequest() txReceipt:', receipt);

  // -- Step 4: Compute the File Key --
  // The file key uniquely identifies a file in the network.
  // It's derived from (owner address + bucket ID + file name) using WASM.
  // This same key is used to query, download, and delete the file.
  const registry = new TypeRegistry();
  const owner = registry.createType('AccountId20', account.address) as AccountId20;
  const bucketIdH256 = registry.createType('H256', bucketId) as H256;
  const fileKey = await fileManager.computeFileKey(owner, bucketIdH256, fileName);

  // -- Step 5: Retrieve Storage Request Data --
  // We read the storage request back from the chain to verify
  // it was recorded correctly. This uses the Polkadot API (Substrate side).
  const storageRequest = await polkadotApi.query.fileSystem.storageRequests(fileKey);
  if (!storageRequest.isSome) {
    throw new Error('Storage request not found on chain');
  }

  // .unwrap().toHuman() converts the Substrate codec type to a plain JS object.
  const storageRequestData = storageRequest.unwrap().toHuman();
  console.log('Storage request data:', storageRequestData);

  // Disconnect the Polkadot API at the very end
  await polkadotApi.disconnect();
}

await run();
