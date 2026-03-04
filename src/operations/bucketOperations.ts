import { NETWORK, chain } from '../config/networks.js';
import {
  storageHubClient,
  address,
  publicClient,
  polkadotApi,
  account,
  walletClient,
} from '../services/clientService.js';
import { getMspInfo, getValueProps, mspClient } from '../services/mspService.js';
import { Bucket, FileListResponse } from '@storagehub-sdk/msp-client';
import fileSystemAbi from '../abi/FileSystemABI.json' with { type: 'json' };

// ============================================================================
// Bucket Operations
// ============================================================================
// A "bucket" is a named container for files — similar to an S3 bucket.
// Buckets are created ON-CHAIN via the StorageHub SDK, then the MSP backend
// indexes them so you can upload files into them.
//
// Key pattern you'll see throughout:
//   1. Send a transaction (on-chain)
//   2. Wait for tx receipt (confirmation)
//   3. Poll the MSP backend until it has indexed the change
//
// This two-step "on-chain then off-chain" pattern is fundamental to DataHaven.
// ============================================================================

// createBucket()
// Creates a new storage bucket. This is the first thing you do before uploading files.
// Steps:
//   1. Fetch MSP info (we need mspId to tell the chain which provider stores our data)
//   2. Pick a value proposition (storage plan)
//   3. Derive the bucket ID deterministically from (owner address + bucket name)
//   4. Check the bucket doesn't already exist (idempotency guard)
//   5. Submit the createBucket transaction
//   6. Wait for on-chain confirmation
export async function createBucket(bucketName: string) {
  // Get basic MSP information from the MSP including its ID
  const { mspId } = await getMspInfo();

  // Choose one of the value props retrieved from the MSP through the helper function
  const valuePropId = await getValueProps();
  console.log(`Value Prop ID: ${valuePropId}`);

  // Bucket IDs are deterministic — derived from (owner address + bucket name).
  // This means the same wallet + name always produces the same bucket ID.
  const bucketId = (await storageHubClient.deriveBucketId(address, bucketName)) as `0x${string}`;
  console.log(`Derived bucket ID: ${bucketId}`);

  // We query the Substrate storage directly to check if this bucket exists.
  // polkadotApi.query.providers.buckets() reads the on-chain "Buckets" storage map.
  const bucketBeforeCreation = await polkadotApi.query.providers.buckets(bucketId);
  console.log('Bucket before creation is empty', bucketBeforeCreation.isEmpty);
  if (!bucketBeforeCreation.isEmpty) {
    throw new Error(`Bucket already exists: ${bucketId}`);
  }

  const isPrivate = false;

  // storageHubClient.createBucket() sends an EVM transaction to the
  // FileSystem precompile. It returns a tx hash that we then wait on for confirmation.
  const txHash: `0x${string}` | undefined = await storageHubClient.createBucket(
    mspId as `0x${string}`,
    bucketName,
    isPrivate,
    valuePropId
  );

  console.log('createBucket() txHash:', txHash);
  if (!txHash) {
    throw new Error('createBucket() did not return a transaction hash');
  }

  // Wait for transaction receipt
  // Don't proceed until receipt is confirmed on chain
  const txReceipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  if (txReceipt.status !== 'success') {
    throw new Error(`Bucket creation failed: ${txHash}`);
  }

  return { bucketId, txReceipt };
}

// verifyBucketCreation()
// After a bucket is created on-chain, we can read it back from Substrate storage
// to confirm the owner and MSP match what we expect. This uses the Polkadot API
// (not viem) because the Substrate storage maps provide richer data.
export async function verifyBucketCreation(bucketId: `0x${string}`) {
  const { mspId } = await getMspInfo();

  const bucket = await polkadotApi.query.providers.buckets(bucketId);
  if (bucket.isEmpty) {
    throw new Error('Bucket not found on chain after creation');
  }

  const bucketData = bucket.unwrap().toHuman();
  console.log('Bucket userId matches initial bucket owner address', bucketData.userId === address);
  console.log(`Bucket MSPId matches initial MSPId: ${bucketData.mspId === mspId}`);
  return bucketData;
}

// waitForBackendBucketReady()
// The MSP backend runs an indexer that watches the chain for new events.
// After a bucket is created on-chain, there's a short delay before the MSP
// knows about it. This function polls the MSP's REST API until the bucket appears.
// This is the "sync gap" between on-chain and off-chain — a common pattern in
// blockchain + backend architectures.
export async function waitForBackendBucketReady(bucketId: `0x${string}`) {
  const maxAttempts = 10; // Number of polling attempts
  const delayMs = 2000; // Delay between attempts in milliseconds

  for (let i = 0; i < maxAttempts; i++) {
    console.log(`Checking for bucket in MSP backend, attempt ${i + 1} of ${maxAttempts}...`);
    try {
      // Query the MSP backend for the bucket metadata.
      // If the backend has synced the bucket, this call resolves successfully.
      const bucket = await mspClient.buckets.getBucket(bucketId);

      if (bucket) {
        // Bucket is now available and the script can safely continue
        console.log('Bucket found in MSP backend:', bucket);
        return;
      }
    } catch (error: any) {
      // Backend hasn't indexed the bucket yet
      if (error.status === 404 || error.body.error === 'Not found: Record') {
        console.log(`Bucket not found in MSP backend yet (404).`);
      } else {
        // Any other error is unexpected and should fail the entire workflow
        console.log('Unexpected error while fetching bucket from MSP:', error);
        throw error;
      }
    }
    // Wait before polling again
    await new Promise((r) => setTimeout(r, delayMs));
  }
  // All attempts exhausted
  throw new Error(`Bucket ${bucketId} not found in MSP backend after waiting`);
}

export async function getBucketsFromMSP(): Promise<Bucket[]> {
  const buckets: Bucket[] = await mspClient.buckets.listBuckets();
  return buckets;
}

export async function getBucketFromMSP(bucketId: `0x${string}`): Promise<Bucket> {
  const bucket: Bucket = await mspClient.buckets.getBucket(bucketId);
  return bucket;
}

export async function waitForBackendBucketEmpty(bucketId: `0x${string}`) {
  const maxAttempts = 144; // 12 minutes total (144 * 5s)
  const delayMs = 5000;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const bucket: Bucket = await mspClient.buckets.getBucket(bucketId);

      if (bucket.fileCount === 0) {
        console.log('Bucket is empty in MSP backend:', bucket);
        return;
      }
      console.log(
        `Checking MSP backend for empty bucket... bucket is still not empty. ` + `Attempt ${i + 1}/${maxAttempts}`
      );
    } catch (error: any) {
      console.log('Unexpected error while fetching bucket from MSP:', error);
      throw error;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`Bucket ${bucketId} not empty in MSP backend after waiting`);
}

// deleteBucket()
// Deletes a bucket on-chain. The bucket MUST be empty (no files) before deletion.
// If you try to delete a bucket with files, the transaction will revert.
export async function deleteBucket(bucketId: `0x${string}`): Promise<boolean> {
  const txHash: `0x${string}` | undefined = await storageHubClient.deleteBucket(bucketId);
  console.log('deleteBucket() txHash:', txHash);
  if (!txHash) {
    throw new Error('deleteBucket() did not return a transaction hash');
  }

  // Wait for transaction
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  console.log('deleteBucket() txReceipt:', receipt);
  if (receipt.status !== 'success') {
    throw new Error(`Bucket deletion failed: ${txHash}`);
  }

  return true;
}

// updateBucketPrivacy()
// Toggles a bucket between public and private. Private buckets require SIWE
// authentication before files can be downloaded.
//
// NOTE: This function calls the FileSystem precompile DIRECTLY via walletClient.writeContract()
// instead of using storageHubClient. This shows that you can always fall back to raw
// contract calls using the ABI when the SDK doesn't expose a convenience method.
export async function updateBucketPrivacy(bucketId: `0x${string}`, isPrivate: boolean): Promise<boolean> {
  // Update bucket privacy on chain by calling the FileSystem precompile directly
  const txHash = await walletClient.writeContract({
    account,
    address: NETWORK.filesystemContractAddress,
    abi: fileSystemAbi,
    functionName: 'updateBucketPrivacy',
    args: [bucketId, isPrivate],
    chain: chain,
  });
  console.log('updateBucketPrivacy() txHash:', txHash);
  if (!txHash) {
    throw new Error('updateBucketPrivacy() did not return a transaction hash');
  }

  // Wait for transaction receipt
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  console.log('updateBucketPrivacy() txReceipt:', receipt);
  if (receipt.status !== 'success') {
    throw new Error(`Bucket privacy update failed: ${txHash}`);
  }

  console.log(`Bucket ${bucketId} privacy updated to ${isPrivate ? 'private' : 'public'}`);
  return true;
}
