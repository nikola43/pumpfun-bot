import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import * as fs from "fs";
import * as path from "path";

// Import jito-ts SDK
import { searcher, bundle as jitoBundle } from "jito-ts";

// ============ VERSION & CONSTANTS ============
export const VERSION = "3.0.0";
export const MIN_TIP_LAMPORTS = 1000;
export const DEFAULT_TIP_LAMPORTS = 2_000_000; // 0.002 SOL
export const TIP_CACHE_TTL_MS = 30000; // 30 seconds
export const ADDRESSES_PER_LUT_EXTEND = 30;

// ============ JITO ENDPOINTS ============
export const JITO_ENDPOINTS = {
  testnet: {
    global: "https://testnet.block-engine.jito.wtf",
    dallas: "https://dallas.testnet.block-engine.jito.wtf",
    ny: "https://ny.testnet.block-engine.jito.wtf",
  },
  mainnet: {
    global: "https://mainnet.block-engine.jito.wtf",
    amsterdam: "https://amsterdam.mainnet.block-engine.jito.wtf",
    dublin: "https://dublin.mainnet.block-engine.jito.wtf",
    frankfurt: "https://frankfurt.mainnet.block-engine.jito.wtf",
    london: "https://london.mainnet.block-engine.jito.wtf",
    ny: "https://ny.mainnet.block-engine.jito.wtf",
    slc: "https://slc.mainnet.block-engine.jito.wtf",
    singapore: "https://singapore.mainnet.block-engine.jito.wtf",
    tokyo: "https://tokyo.mainnet.block-engine.jito.wtf",
  },
} as const;

// All mainnet endpoints for fallback rotation
export const MAINNET_ENDPOINTS = Object.values(JITO_ENDPOINTS.mainnet);

// Default tip accounts (cached fallback if API fails)
export const DEFAULT_TIP_ACCOUNTS = [
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
];

// Jito auth keypair path
const JITO_KEYPAIR_PATH = path.join(process.cwd(), "jito-keypair.json");

// Configuration for robust operations
export interface JitoConfig {
  maxRetries: number;
  retryDelayMs: number;
  timeoutMs: number;
  enableEndpointFallback: boolean;
}

export const DEFAULT_JITO_CONFIG: JitoConfig = {
  maxRetries: 3,
  retryDelayMs: 1000,
  timeoutMs: 30000,
  enableEndpointFallback: true,
};

export interface BundleResult {
  success: boolean;
  bundleId?: string;
  error?: string;
  endpoint?: string;
  attempts?: number;
  signatures?: string[];
}

export interface TransferParams {
  fromPubkey: PublicKey;
  toPubkey: PublicKey;
  lamports: number;
}

export interface SendBundleParams {
  connection: Connection;
  payer: PublicKey;
  transfers: TransferParams[];
  tipLamports: number;
  tipAccounts: string[];
  signAllTransactions: (txs: Transaction[]) => Promise<Transaction[]>;
}

export interface BundleStatusResult {
  bundleId: string;
  status: "Invalid" | "Pending" | "Failed" | "Landed";
  landedSlot?: number;
  error?: string;
}

export type JitoErrorCode =
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "BUNDLE_REJECTED"
  | "SIMULATION_FAILED"
  | "INVALID_BUNDLE"
  | "UNKNOWN";

// ============ JITO AUTH KEYPAIR ============

let jitoAuthKeypair: Keypair | null = null;

function loadJitoAuthKeypair(): Keypair {
  if (jitoAuthKeypair) {
    return jitoAuthKeypair;
  }

  try {
    const keypairData = JSON.parse(fs.readFileSync(JITO_KEYPAIR_PATH, "utf-8"));
    jitoAuthKeypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
    console.log(`Loaded Jito auth keypair: ${jitoAuthKeypair.publicKey.toBase58().slice(0, 12)}...`);
    return jitoAuthKeypair;
  } catch (error: any) {
    throw new Error(`Failed to load Jito keypair from ${JITO_KEYPAIR_PATH}: ${error.message}`);
  }
}

// ============ SEARCHER CLIENT ============

let searcherClientInstance: searcher.SearcherClient | null = null;
let cachedEndpoint: string | null = null;

function getSearcherClient(endpoint: string): searcher.SearcherClient {
  // Extract just the host for the SearcherClient (without https://)
  const blockEngineUrl = endpoint.replace("https://", "").replace("/api/v1/bundles", "");

  if (searcherClientInstance && cachedEndpoint === blockEngineUrl) {
    return searcherClientInstance;
  }

  const authKeypair = loadJitoAuthKeypair();
  searcherClientInstance = searcher.searcherClient(blockEngineUrl, authKeypair);
  cachedEndpoint = blockEngineUrl;

  console.log(`Connected to Jito Block Engine: ${blockEngineUrl}`);
  return searcherClientInstance;
}

function resetSearcherClient(): void {
  searcherClientInstance = null;
  cachedEndpoint = null;
}

// ============ HELPER FUNCTIONS ============

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: any) => boolean;
  onRetry?: (attempt: number, error: any, delayMs: number) => void;
}

const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, "onRetry" | "shouldRetry">> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = DEFAULT_RETRY_OPTIONS.maxRetries,
    initialDelayMs = DEFAULT_RETRY_OPTIONS.initialDelayMs,
    maxDelayMs = DEFAULT_RETRY_OPTIONS.maxDelayMs,
    backoffMultiplier = DEFAULT_RETRY_OPTIONS.backoffMultiplier,
    shouldRetry = () => true,
    onRetry,
  } = options;

  let lastError: any;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      if (attempt > maxRetries) {
        throw error;
      }

      if (!shouldRetry(error)) {
        throw error;
      }

      if (onRetry) {
        onRetry(attempt, error, delay);
      }

      await sleep(delay);
      delay = Math.min(delay * backoffMultiplier, maxDelayMs);
    }
  }

  throw lastError;
}

export function isRetryableError(error: any): boolean {
  const message = error?.message?.toLowerCase() || "";

  if (message.includes("network") || message.includes("econnrefused")) {
    return true;
  }
  if (message.includes("timeout") || error.name === "AbortError") {
    return true;
  }
  if (message.includes("429") || message.includes("rate limit")) {
    return true;
  }
  if (message.includes("500") || message.includes("502") || message.includes("503") || message.includes("504")) {
    return true;
  }
  if (message.includes("blockhash not found") || message.includes("slot skipped")) {
    return true;
  }

  return false;
}

// ============ TIP ACCOUNTS ============

export async function getTipAccounts(
  endpoint: string = JITO_ENDPOINTS.mainnet.ny,
  _config: Partial<JitoConfig> = {}
): Promise<string[]> {
  try {
    const client = getSearcherClient(endpoint);
    const result = await client.getTipAccounts();

    // Handle Result type from jito-ts
    if (result.ok && result.value.length > 0) {
      return result.value;
    }
    return DEFAULT_TIP_ACCOUNTS;
  } catch (error) {
    console.warn("Failed to fetch tip accounts, using defaults");
    return DEFAULT_TIP_ACCOUNTS;
  }
}

export function getRandomTipAccount(tipAccounts: string[]): string {
  if (tipAccounts.length === 0) {
    throw new Error("No tip accounts available");
  }
  const randomIndex = Math.floor(Math.random() * tipAccounts.length);
  return tipAccounts[randomIndex];
}

// ============ TIP FLOOR ============

export interface TipFloorResponse {
  landed_tips_25th_percentile: number;
  landed_tips_50th_percentile: number;
  landed_tips_75th_percentile: number;
  landed_tips_95th_percentile: number;
  landed_tips_99th_percentile: number;
  ema_landed_tips_50th_percentile: number;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function getTipFloor(
  endpoint: string = JITO_ENDPOINTS.mainnet.ny,
  percentile: "25" | "50" | "75" | "95" | "99" = "99",
  config: Partial<JitoConfig> = {}
): Promise<number> {
  const { timeoutMs = DEFAULT_JITO_CONFIG.timeoutMs } = config;

  // Normalize endpoint URL
  let baseUrl: string;
  if (endpoint.includes("api/v1/bundles")) {
    baseUrl = endpoint;
  } else if (endpoint.startsWith("https://")) {
    baseUrl = `${endpoint}/api/v1/bundles`;
  } else {
    baseUrl = `https://${endpoint}/api/v1/bundles`;
  }
  const tipFloorUrl = baseUrl.replace("/api/v1/bundles", "/api/v1/bundles/tip_floor");

  try {
    const response = await fetchWithTimeout(
      tipFloorUrl,
      {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      },
      timeoutMs
    );

    if (!response.ok) {
      return DEFAULT_TIP_LAMPORTS;
    }

    const data = (await response.json()) as TipFloorResponse[];

    if (!data || data.length === 0) {
      return DEFAULT_TIP_LAMPORTS;
    }

    const tipData = data[0];
    let tipLamports: number;

    switch (percentile) {
      case "25":
        tipLamports = tipData.landed_tips_25th_percentile;
        break;
      case "50":
        tipLamports = tipData.landed_tips_50th_percentile;
        break;
      case "75":
        tipLamports = tipData.landed_tips_75th_percentile;
        break;
      case "95":
        tipLamports = tipData.landed_tips_95th_percentile;
        break;
      case "99":
      default:
        tipLamports = tipData.landed_tips_99th_percentile;
        break;
    }

    // Convert SOL to lamports if needed (API returns SOL)
    if (tipLamports < 1) {
      tipLamports = Math.floor(tipLamports * LAMPORTS_PER_SOL);
    }

    return Math.max(tipLamports, MIN_TIP_LAMPORTS);
  } catch {
    return DEFAULT_TIP_LAMPORTS;
  }
}

let cachedTipFloor: { value: number; timestamp: number } | null = null;

export async function getCachedTipFloor(
  endpoint: string = JITO_ENDPOINTS.mainnet.ny,
  percentile: "25" | "50" | "75" | "95" | "99" = "99",
  config: Partial<JitoConfig> = {}
): Promise<number> {
  const now = Date.now();

  if (cachedTipFloor && now - cachedTipFloor.timestamp < TIP_CACHE_TTL_MS) {
    return cachedTipFloor.value;
  }

  const tipFloor = await getTipFloor(endpoint, percentile, config);
  cachedTipFloor = { value: tipFloor, timestamp: now };

  return tipFloor;
}

// ============ BUNDLE OPERATIONS ============

export function createTransferTransaction(
  params: TransferParams,
  blockhash: string,
  feePayer: PublicKey
): Transaction {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: params.fromPubkey,
      toPubkey: params.toPubkey,
      lamports: params.lamports,
    })
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = feePayer;
  return tx;
}

export function createTipTransaction(
  fromPubkey: PublicKey,
  tipAccount: string,
  tipLamports: number,
  blockhash: string
): Transaction {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey,
      toPubkey: new PublicKey(tipAccount),
      lamports: tipLamports,
    })
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = fromPubkey;
  return tx;
}

export function createTipInstruction(
  fromPubkey: PublicKey,
  tipAccount: string,
  tipLamports: number
): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey,
    toPubkey: new PublicKey(tipAccount),
    lamports: tipLamports,
  });
}

/**
 * Send a bundle using jito-ts SearcherClient and wait for result
 */
export async function sendBundle(
  serializedTransactions: string[],
  endpoint: string = JITO_ENDPOINTS.mainnet.ny,
  config: Partial<JitoConfig> = {}
): Promise<BundleResult> {
  const {
    maxRetries = DEFAULT_JITO_CONFIG.maxRetries,
    retryDelayMs = DEFAULT_JITO_CONFIG.retryDelayMs,
  } = config;

  let lastError = "";
  let totalAttempts = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    totalAttempts++;

    try {
      const client = getSearcherClient(endpoint);

      // Deserialize transactions
      const transactions: VersionedTransaction[] = serializedTransactions.map((serialized) => {
        const buffer = bs58.decode(serialized);
        return VersionedTransaction.deserialize(buffer);
      });

      // Create Jito bundle
      const bundle = new jitoBundle.Bundle(transactions, transactions.length);

      // Send bundle - returns Result type
      const result = await client.sendBundle(bundle);

      // Handle Result type from jito-ts
      if (result.ok) {
        return {
          success: true,
          bundleId: result.value,
          endpoint,
          attempts: totalAttempts,
        };
      } else {
        lastError = result.error?.message || "Bundle rejected";
        // Don't retry on simulation failures
        if (lastError.includes("simulation failed")) {
          return {
            success: false,
            error: lastError,
            endpoint,
            attempts: totalAttempts,
          };
        }
      }
    } catch (error: any) {
      lastError = error.message || "Unknown error";
    }

    // Retry with backoff
    if (attempt < maxRetries) {
      const delay = retryDelayMs * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }

  return {
    success: false,
    error: `All attempts failed. Last error: ${lastError}`,
    attempts: totalAttempts,
  };
}

/**
 * Extract signatures from serialized transactions
 */
function extractSignaturesFromSerializedTxs(serializedTransactions: string[]): string[] {
  const signatures: string[] = [];
  for (const serialized of serializedTransactions) {
    try {
      const decoded = bs58.decode(serialized);
      const tx = VersionedTransaction.deserialize(decoded);
      if (tx.signatures.length > 0) {
        signatures.push(bs58.encode(tx.signatures[0]));
      }
    } catch {
      // Skip invalid transactions
    }
  }
  return signatures;
}

/**
 * Send bundle and wait for confirmation
 * Uses SearcherClient to send + HTTP polling for status (more reliable)
 */
export async function sendBundleWithConfirmation(
  serializedTransactions: string[],
  endpoint: string = JITO_ENDPOINTS.mainnet.ny,
  config: Partial<JitoConfig> = {},
  maxWaitMs: number = 60000
): Promise<BundleResult & { landed: boolean; slot?: number }> {
  const { enableEndpointFallback = true } = config;

  // List of endpoints to try (starting with the provided one)
  const endpointsToTry = enableEndpointFallback
    ? [endpoint, ...MAINNET_ENDPOINTS.filter(e => e !== endpoint)]
    : [endpoint];

  let lastError = "";

  for (const currentEndpoint of endpointsToTry) {
    try {
      // Send bundle via SearcherClient
      const sendResult = await sendBundle(serializedTransactions, currentEndpoint, config);

      if (!sendResult.success) {
        if (isRateLimitError(sendResult.error)) {
          lastError = sendResult.error || "Rate limited";
          console.log(`Endpoint ${currentEndpoint} rate limited, trying next...`);
          resetSearcherClient();
          await sleep(500);
          continue;
        }
        return {
          ...sendResult,
          landed: false,
        };
      }

      // Bundle sent successfully, now poll for confirmation
      if (sendResult.bundleId) {
        console.log(`Bundle sent: ${sendResult.bundleId}, waiting for confirmation...`);

        const status = await waitForBundleConfirmation(
          sendResult.bundleId,
          currentEndpoint,
          maxWaitMs,
          2000 // Poll every 2s
        );

        return {
          ...sendResult,
          landed: status.status === "Landed",
          slot: status.landedSlot,
          error: status.status !== "Landed" ? status.error : undefined,
        };
      }

      return {
        ...sendResult,
        landed: false,
      };
    } catch (error: any) {
      lastError = error.message || "Unknown error";
      if (!isRateLimitError(lastError)) {
        return {
          success: false,
          endpoint: currentEndpoint,
          landed: false,
          error: lastError,
        };
      }
      resetSearcherClient();
      await sleep(500);
    }
  }

  return {
    success: false,
    endpoint,
    landed: false,
    error: `All endpoints failed. Last error: ${lastError}`,
  };
}

/**
 * Enhanced bundle send with on-chain verification
 * Uses SearcherClient to send, then verifies landing via Jito API + on-chain fallback
 */
export async function sendBundleWithOnChainVerification(
  connection: Connection,
  serializedTransactions: string[],
  endpoint: string = JITO_ENDPOINTS.mainnet.ny,
  config: Partial<JitoConfig> = {},
  maxWaitMs: number = 60000
): Promise<BundleResult & { landed: boolean; slot?: number }> {
  const { enableEndpointFallback = true } = config;

  // Extract signatures for on-chain verification
  const signatures = extractSignaturesFromSerializedTxs(serializedTransactions);

  // List of endpoints to try
  const endpointsToTry = enableEndpointFallback
    ? [endpoint, ...MAINNET_ENDPOINTS.filter(e => e !== endpoint)]
    : [endpoint];

  let lastError = "";

  for (const currentEndpoint of endpointsToTry) {
    try {
      const sendResult = await sendBundle(serializedTransactions, currentEndpoint, config);

      if (!sendResult.success) {
        if (isRateLimitError(sendResult.error)) {
          lastError = sendResult.error || "Rate limited";
          console.log(`Endpoint ${currentEndpoint} rate limited, trying next...`);
          resetSearcherClient();
          await sleep(500);
          continue;
        }
        return { ...sendResult, landed: false };
      }

      if (sendResult.bundleId) {
        console.log(`Bundle sent: ${sendResult.bundleId}, waiting for confirmation...`);

        // Use enhanced confirmation with on-chain fallback
        const status = await waitForBundleWithOnChainFallback(
          connection,
          sendResult.bundleId,
          signatures,
          currentEndpoint,
          maxWaitMs
        );

        return {
          ...sendResult,
          landed: status.status === "Landed",
          slot: status.landedSlot,
          error: status.status !== "Landed" ? status.error : undefined,
        };
      }

      return { ...sendResult, landed: false };
    } catch (error: any) {
      lastError = error.message || "Unknown error";
      if (!isRateLimitError(lastError)) {
        return {
          success: false,
          endpoint: currentEndpoint,
          landed: false,
          error: lastError,
        };
      }
      resetSearcherClient();
      await sleep(500);
    }
  }

  return {
    success: false,
    endpoint,
    landed: false,
    error: `All endpoints failed. Last error: ${lastError}`,
  };
}

function isRateLimitError(error?: string): boolean {
  if (!error) return false;
  const lowerError = error.toLowerCase();
  return lowerError.includes("rate limit") ||
         lowerError.includes("resource_exhausted") ||
         lowerError.includes("congested");
}

// ============ BUNDLE STATUS ============

export async function getBundleStatus(
  bundleId: string,
  endpoint: string = JITO_ENDPOINTS.mainnet.ny,
  config: Partial<JitoConfig> = {}
): Promise<BundleStatusResult> {
  const { timeoutMs = DEFAULT_JITO_CONFIG.timeoutMs } = config;

  // Normalize endpoint URL for HTTP status check
  let baseUrl: string;
  if (endpoint.includes("api/v1/bundles")) {
    baseUrl = endpoint;
  } else if (endpoint.startsWith("https://")) {
    baseUrl = `${endpoint}/api/v1/bundles`;
  } else {
    baseUrl = `https://${endpoint}/api/v1/bundles`;
  }

  interface BundleStatusResponse {
    jsonrpc: string;
    id: number;
    result?: {
      context: { slot: number };
      value: Array<{
        bundle_id: string;
        transactions: string[];
        slot: number;
        confirmation_status: string;
        err?: unknown;
      } | null>;
    };
    error?: {
      code?: number;
      message?: string;
    };
  }

  try {
    const response = await fetchWithTimeout(
      baseUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getBundleStatuses",
          params: [[bundleId]],
        }),
      },
      timeoutMs
    );

    const result = (await response.json()) as BundleStatusResponse;

    if (result.error) {
      return {
        bundleId,
        status: "Invalid",
        error: result.error.message || JSON.stringify(result.error),
      };
    }

    const statuses = result.result?.value;
    if (!statuses || statuses.length === 0 || !statuses[0]) {
      return { bundleId, status: "Pending" };
    }

    const bundleStatus = statuses[0];
    return {
      bundleId,
      status: bundleStatus.confirmation_status === "confirmed" ? "Landed" : "Pending",
      landedSlot: bundleStatus.slot,
    };
  } catch (error: any) {
    return {
      bundleId,
      status: "Invalid",
      error: error.message || "Failed to get bundle status",
    };
  }
}

export async function waitForBundleConfirmation(
  bundleId: string,
  endpoint: string = JITO_ENDPOINTS.mainnet.ny,
  maxWaitMs: number = 60000,
  pollIntervalMs: number = 2000
): Promise<BundleStatusResult> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const status = await getBundleStatus(bundleId, endpoint);

    if (status.status === "Landed" || status.status === "Failed" || status.status === "Invalid") {
      return status;
    }

    await sleep(pollIntervalMs);
  }

  return {
    bundleId,
    status: "Pending",
    error: "Timeout waiting for bundle confirmation",
  };
}

/**
 * Wait for bundle confirmation with on-chain fallback
 * First checks Jito API, then verifies on-chain as fallback
 */
export async function waitForBundleWithOnChainFallback(
  connection: Connection,
  bundleId: string,
  signatures: string[],
  endpoint: string = JITO_ENDPOINTS.mainnet.ny,
  maxWaitMs: number = 60000
): Promise<BundleStatusResult> {
  const startTime = Date.now();
  const pollIntervalMs = 2000;

  while (Date.now() - startTime < maxWaitMs) {
    // Check Jito API first
    const status = await getBundleStatus(bundleId, endpoint);

    if (status.status === "Landed" || status.status === "Failed" || status.status === "Invalid") {
      return status;
    }

    // Fallback: check on-chain transaction status
    if (signatures.length > 0) {
      try {
        const statuses = await connection.getSignatureStatuses(signatures);
        const allConfirmed = statuses.value.every(s => s !== null && s.confirmationStatus === "confirmed");

        if (allConfirmed) {
          return {
            bundleId,
            status: "Landed",
            landedSlot: statuses.value[0]?.slot,
          };
        }

        // Check if any failed
        const anyFailed = statuses.value.some(s => s !== null && s.err !== null);
        if (anyFailed) {
          return {
            bundleId,
            status: "Failed",
            error: "Transaction failed on-chain",
          };
        }
      } catch {
        // Continue polling if on-chain check fails
      }
    }

    await sleep(pollIntervalMs);
  }

  return {
    bundleId,
    status: "Pending",
    error: "Timeout waiting for bundle confirmation",
  };
}

// ============ VERSIONED BUNDLE HELPERS ============

export function createTransferInstructions(
  fromPubkey: PublicKey,
  recipients: Array<{ publicKey: PublicKey }>,
  lamportsEach: number
): TransactionInstruction[] {
  return recipients.map((recipient) =>
    SystemProgram.transfer({
      fromPubkey,
      toPubkey: recipient.publicKey,
      lamports: lamportsEach,
    })
  );
}

export async function sendVersionedBundle(
  connection: Connection,
  fundingWallet: Keypair,
  instructions: TransactionInstruction[][],
  tipLamports: number,
  endpoint: string = JITO_ENDPOINTS.mainnet.ny,
  config: Partial<JitoConfig> = {}
): Promise<BundleResult> {
  try {
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tipAccounts = await getTipAccounts(endpoint, config);
    const tipAccount = getRandomTipAccount(tipAccounts);

    const serializedTransactions: string[] = [];
    const signatures: string[] = [];

    for (let i = 0; i < instructions.length; i++) {
      const txInstructions = [...instructions[i]];

      // Add tip to the last transaction
      if (i === instructions.length - 1) {
        txInstructions.push(
          createTipInstruction(fundingWallet.publicKey, tipAccount, tipLamports)
        );
      }

      const messageV0 = new TransactionMessage({
        payerKey: fundingWallet.publicKey,
        recentBlockhash: blockhash,
        instructions: txInstructions,
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([fundingWallet]);

      const signature = bs58.encode(transaction.signatures[0]);
      signatures.push(signature);

      serializedTransactions.push(bs58.encode(transaction.serialize()));
    }

    // Use confirmation to wait for bundle to land
    const result = await sendBundleWithConfirmation(serializedTransactions, endpoint, config, 60000);
    return { ...result, signatures, success: result.success && result.landed };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || "Failed to send versioned bundle",
    };
  }
}

export async function sendVersionedBundleWithLUT(
  connection: Connection,
  fundingWallet: Keypair,
  instructions: TransactionInstruction[][],
  tipLamports: number,
  lookupTableAccount: AddressLookupTableAccount,
  endpoint: string = JITO_ENDPOINTS.mainnet.ny,
  config: Partial<JitoConfig> = {}
): Promise<BundleResult> {
  try {
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tipAccounts = await getTipAccounts(endpoint, config);
    const tipAccount = getRandomTipAccount(tipAccounts);

    const serializedTransactions: string[] = [];
    const signatures: string[] = [];

    for (let i = 0; i < instructions.length; i++) {
      const txInstructions = [...instructions[i]];

      // Add tip to the last transaction
      if (i === instructions.length - 1) {
        txInstructions.push(
          createTipInstruction(fundingWallet.publicKey, tipAccount, tipLamports)
        );
      }

      // Compile with Lookup Table for smaller transaction size
      const messageV0 = new TransactionMessage({
        payerKey: fundingWallet.publicKey,
        recentBlockhash: blockhash,
        instructions: txInstructions,
      }).compileToV0Message([lookupTableAccount]);

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([fundingWallet]);

      const signature = bs58.encode(transaction.signatures[0]);
      signatures.push(signature);

      serializedTransactions.push(bs58.encode(transaction.serialize()));
    }

    // Use confirmation to wait for bundle to land
    const result = await sendBundleWithConfirmation(serializedTransactions, endpoint, config, 60000);
    return { ...result, signatures, success: result.success && result.landed };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || "Failed to send LUT bundle",
    };
  }
}

// ============ LOOKUP TABLE OPERATIONS ============

export async function createLookupTable(
  connection: Connection,
  payer: Keypair
): Promise<{ signature: string; lookupTableAddress: PublicKey }> {
  return withRetry(
    async () => {
      const slot = await connection.getSlot();

      const [createInstruction, lookupTableAddress] =
        AddressLookupTableProgram.createLookupTable({
          authority: payer.publicKey,
          payer: payer.publicKey,
          recentSlot: slot - 1,
        });

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash();

      const message = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions: [createInstruction],
      }).compileToV0Message();

      const transaction = new VersionedTransaction(message);
      transaction.sign([payer]);

      const signature = await connection.sendTransaction(transaction);
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      return { signature, lookupTableAddress };
    },
    {
      maxRetries: 3,
      initialDelayMs: 1000,
      shouldRetry: isRetryableError,
    }
  );
}

export async function extendLookupTable(
  connection: Connection,
  payer: Keypair,
  lookupTableAddress: PublicKey,
  addresses: PublicKey[]
): Promise<string[]> {
  const signatures: string[] = [];
  const ADDRESSES_PER_TX = ADDRESSES_PER_LUT_EXTEND;

  for (let i = 0; i < addresses.length; i += ADDRESSES_PER_TX) {
    const batch = addresses.slice(i, i + ADDRESSES_PER_TX);

    const signature = await withRetry(
      async () => {
        const extendInstruction = AddressLookupTableProgram.extendLookupTable({
          payer: payer.publicKey,
          authority: payer.publicKey,
          lookupTable: lookupTableAddress,
          addresses: batch,
        });

        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash();

        const message = new TransactionMessage({
          payerKey: payer.publicKey,
          recentBlockhash: blockhash,
          instructions: [extendInstruction],
        }).compileToV0Message();

        const transaction = new VersionedTransaction(message);
        transaction.sign([payer]);

        const sig = await connection.sendTransaction(transaction);
        await connection.confirmTransaction({
          signature: sig,
          blockhash,
          lastValidBlockHeight,
        });

        return sig;
      },
      {
        maxRetries: 3,
        initialDelayMs: 1000,
        shouldRetry: isRetryableError,
      }
    );

    signatures.push(signature);

    if (i + ADDRESSES_PER_TX < addresses.length) {
      await sleep(500);
    }
  }

  return signatures;
}

export async function getLookupTableAccount(
  connection: Connection,
  lookupTableAddress: PublicKey
): Promise<AddressLookupTableAccount | null> {
  const response = await connection.getAddressLookupTable(lookupTableAddress);
  return response.value;
}

export async function waitForLookupTableActive(
  connection: Connection,
  lookupTableAddress: PublicKey,
  expectedAddresses: number,
  maxWaitMs: number = 30000
): Promise<AddressLookupTableAccount | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const lookupTable = await getLookupTableAccount(connection, lookupTableAddress);

    if (lookupTable && lookupTable.state.addresses.length >= expectedAddresses) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return lookupTable;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return null;
}

// ============ UTILITIES ============

export function solToLamports(sol: number): number {
  return Math.floor(sol * LAMPORTS_PER_SOL);
}

export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

export function isValidPublicKey(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}
