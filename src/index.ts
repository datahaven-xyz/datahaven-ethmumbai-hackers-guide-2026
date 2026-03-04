// ============================================================================
// Starter Template
// ============================================================================
// This is a blank canvas — use it to experiment with the SDK.
// Every script in this project follows this same skeleton:
//   1. Import api-augment (adds DataHaven types to the Polkadot API)
//   2. Call initWasm() — required before ANY SDK operation
//   3. Do your work
//   4. Disconnect the Polkadot API (cleans up the WebSocket connection)
// ============================================================================

// This side-effect import patches @polkadot/api with DataHaven's
// custom storage types (buckets, storage requests, etc.). Without it,
// queries like polkadotApi.query.providers.buckets() won't exist.
import '@storagehub/api-augment';
import { initWasm } from '@storagehub-sdk/core';
import { polkadotApi } from './services/clientService.js';

async function run() {
  // initWasm() loads the WASM module used for file fingerprinting
  // and file key computation. Must be called once before using any SDK functions.
  await initWasm();

  // Your code goes here — try importing functions from operations/ and calling them!

  // Always disconnect at the end to close the WebSocket connection.
  // Without this the Node.js process will hang indefinitely.
  await polkadotApi.disconnect();
}

await run();
