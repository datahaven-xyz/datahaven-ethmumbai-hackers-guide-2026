import { HealthStatus, InfoResponse, MspClient, UserInfo, ValueProp } from '@storagehub-sdk/msp-client';
import { HttpClientConfig } from '@storagehub-sdk/core';
import { address, walletClient } from './clientService.js';
import { NETWORK } from '../config/networks.js';

// ============================================================================
// MSP (Main Storage Provider) Service
// ============================================================================
// The MSP is the off-chain backend that actually stores your files.
// On-chain, we record *metadata* (bucket IDs, file keys, fingerprints).
// Off-chain, the MSP holds the *actual file bytes* and serves downloads.
//
// This file sets up:
//   - An HTTP client pointing to the MSP backend
//   - Session management via SIWE (Sign-In With Ethereum)
//   - Helper functions: health check, info, auth, value propositions
// ============================================================================

// Point the HTTP client at the MSP's REST API.
const httpCfg: HttpClientConfig = { baseUrl: NETWORK.mspUrl };

// Session token management.
// Before authentication this is undefined. After SIWE auth, it holds a JWT-like
// token that the MSP uses to authorize file uploads and private downloads.
let sessionToken: string | undefined = undefined;

// The session provider is a callback the MspClient calls on every request.
// If we have a token, it attaches it to the request headers automatically.
const sessionProvider = async () =>
  sessionToken ? ({ token: sessionToken, user: { address: address } } as const) : undefined;

// MspClient.connect() establishes a connection to the MSP backend.
// The second argument (sessionProvider) is called before each request to inject auth.
const mspClient = await MspClient.connect(httpCfg, sessionProvider);

// Retrieve MSP metadata, including its unique ID and version, and log it to the console
const getMspInfo = async (): Promise<InfoResponse> => {
  const mspInfo = await mspClient.info.getInfo();
  console.log(`MSP ID: ${mspInfo.mspId}`);
  return mspInfo;
};

// Retrieve and log the MSP's current health status
const getMspHealth = async (): Promise<HealthStatus> => {
  const mspHealth = await mspClient.info.getHealth();
  console.log(`MSP Health: ${mspHealth}`);
  return mspHealth;
};

// SIWE Authentication
// SIWE (Sign-In With Ethereum) proves to the MSP that you own your wallet.
// Flow:
//   1. The MSP generates a challenge message
//   2. Your wallet signs the message (no on-chain tx — just a signature)
//   3. The MSP verifies the signature and returns a session token
//   4. All subsequent requests include this token for authorization
//
// This is required BEFORE uploading files or accessing private content.
const authenticateUser = async (): Promise<UserInfo> => {
  console.log('Authenticating user with MSP via SIWE...');

  // In development domain and uri can be arbitrary placeholders,
  // but in production they must match your actual frontend origin.
  const domain = 'localhost';
  const uri = 'http://localhost';

  const siweSession = await mspClient.auth.SIWE(walletClient, domain, uri);
  console.log('SIWE Session:', siweSession);
  sessionToken = (siweSession as { token: string }).token;

  const profile: UserInfo = await mspClient.auth.getProfile();
  return profile;
};

// Value Propositions
// A value proposition is an MSP's advertised storage terms (pricing, capacity, etc.).
// When creating a bucket you must select one — it's like choosing a storage plan.
// Here we just grab the first available one for simplicity.
const getValueProps = async (): Promise<`0x${string}`> => {
  const valueProps: ValueProp[] = await mspClient.info.getValuePropositions();
  console.log('Available MSP Value Propositions:', valueProps);
  if (!Array.isArray(valueProps) || valueProps.length === 0) {
    throw new Error('No value propositions available from MSP');
  }
  // For simplicity, select the first value proposition and return its ID
  const valuePropId = valueProps[0].id as `0x${string}`;
  console.log(`Chose Value Prop ID: ${valuePropId}`);
  return valuePropId;
};

// Export initialized client and helper functions for use in other modules
export { mspClient, getMspInfo, getMspHealth, authenticateUser, getValueProps };
