import { Chain, defineChain } from 'viem';

// ============================================================================
// Network Configuration
// ============================================================================
// DataHaven supports two environments:
//   - devnet:  a local node for development (localhost)
//   - testnet: the shared public testnet
//
// Each network defines:
//   - id:              The EVM chain ID (used by wallets and viem to sign txs for the right chain)
//   - rpcUrl / wsUrl:  HTTP and WebSocket endpoints for sending transactions and subscribing to events
//   - mspUrl:          The MSP (Main Storage Provider) backend URL for file upload/download
//   - filesystemContractAddress: The address of the FileSystem precompile — a special
//     smart contract baked into the chain that exposes storage operations as EVM calls
// ============================================================================

export const NETWORKS = {
  devnet: {
    id: 181222,
    name: 'DataHaven Local Devnet',
    rpcUrl: 'http://127.0.0.1:9666',
    wsUrl: 'ws://127.0.0.1:9666',
    mspUrl: 'http://127.0.0.1:8080/',
    nativeCurrency: { name: 'StorageHub', symbol: 'SH', decimals: 18 },
    filesystemContractAddress: '0x0000000000000000000000000000000000000064' as `0x${string}`,
  },
  testnet: {
    id: 55931,
    name: 'DataHaven Testnet',
    rpcUrl: 'https://services.datahaven-testnet.network/testnet',
    wsUrl: 'wss://services.datahaven-testnet.network/testnet',
    mspUrl: 'https://deo-dh-backend.testnet.datahaven-infra.network/',
    nativeCurrency: { name: 'Mock', symbol: 'MOCK', decimals: 18 },
    filesystemContractAddress: '0x0000000000000000000000000000000000000404' as `0x${string}`,
  },
};

// Flip this to NETWORKS.devnet if you're running a local node
export const NETWORK = NETWORKS.testnet; // Change this to switch between devnet and testnet

// defineChain() creates a viem-compatible chain object from our config.
// viem uses this to know which chain to target when signing and sending transactions.
export const chain: Chain = defineChain({
  id: NETWORK.id,
  name: NETWORK.name,
  nativeCurrency: NETWORK.nativeCurrency,
  rpcUrls: { default: { http: [NETWORK.rpcUrl] } },
});
