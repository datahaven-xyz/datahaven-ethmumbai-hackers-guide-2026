import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, http, WalletClient, PublicClient } from 'viem';
import { StorageHubClient } from '@storagehub-sdk/core';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { types } from '@storagehub/types-bundle';
import { NETWORK, chain } from '../config/networks.js';
import 'dotenv/config';

// ============================================================================
// Client Initialization
// ============================================================================
// This file sets up the FOUR clients we need to interact with DataHaven:
//
//  1. walletClient  (viem)         — signs and sends EVM transactions
//  2. publicClient  (viem)         — read-only EVM queries (e.g. wait for tx receipts)
//  3. storageHubClient (SH SDK)    — high-level wrapper for storage operations
//                                    (create bucket, issue storage request, etc.)
//  4. polkadotApi   (@polkadot/api)— reads Substrate storage directly
//                                    (query on-chain bucket/file state)
//
// Why two "worlds"?
//   DataHaven is a Substrate chain with an EVM compatibility layer.
//   - Writes go through the EVM (viem / StorageHubClient)
//   - Reads can go through either EVM or Substrate; Substrate gives richer data
// ============================================================================

// Derive an in-memory signer from the private key in your .env file.
// privateKeyToAccount() returns a viem "account" object that can sign transactions.
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const address = account.address;

// walletClient — used to SIGN and SEND transactions (state-changing operations).
// Think of it as your "write" connection to the chain.
const walletClient: WalletClient = createWalletClient({
  chain,
  account,
  transport: http(NETWORK.rpcUrl),
});

// publicClient — used for READ-ONLY queries (no private key needed).
// Most common use: waitForTransactionReceipt() to confirm a tx was mined.
const publicClient: PublicClient = createPublicClient({
  chain,
  transport: http(NETWORK.rpcUrl),
});

// StorageHubClient — the SH SDK's main entry point.
// It wraps common storage operations (createBucket, issueStorageRequest, deleteBucket, etc.)
// so you don't have to manually encode ABI calls. Under the hood it uses the walletClient
// and the FileSystem precompile contract.
const storageHubClient: StorageHubClient = new StorageHubClient({
  rpcUrl: NETWORK.rpcUrl,
  chain: chain,
  walletClient: walletClient,
  filesystemContractAddress: NETWORK.filesystemContractAddress,
});

// Polkadot API — connects over WebSocket to the Substrate side of the chain.
// We use this to query on-chain storage maps (e.g. providers.buckets, fileSystem.storageRequests)
// which aren't easily accessible through the EVM layer.
const provider = new WsProvider(NETWORK.wsUrl);
const polkadotApi: ApiPromise = await ApiPromise.create({
  provider,
  typesBundle: types, // Custom type definitions for DataHaven's pallets
  noInitWarn: true,
});

export { account, address, publicClient, walletClient, storageHubClient, polkadotApi };
