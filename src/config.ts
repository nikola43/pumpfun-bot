/**
 * Configuration and type definitions
 */
import * as path from "path";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { JITO_ENDPOINTS, DEFAULT_JITO_CONFIG, JitoConfig } from "./jito";

// Load environment variables from multiple possible locations
const envPaths = [
  path.join(__dirname, ".env"),           // src/.env (when running ts-node)
  path.join(__dirname, "..", "src", ".env"), // src/.env (when running from dist/)
  path.join(process.cwd(), "src", ".env"),   // src/.env (from project root)
  path.join(process.cwd(), ".env"),          // .env (project root fallback)
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

// ============ TYPES ============

export type NetworkType = "mainnet-beta" | "testnet" | "devnet";

export interface NetworkConfig {
  RPC_URL: string;
  JITO_ENDPOINT: string;
  JITO_CONFIG: JitoConfig;
}

export interface WalletInfo {
  index: number;
  publicKey: string;
  secretKey: string;
  createdAt: string;
}

export interface LUTInfo {
  address: string;
  walletCount: number;
  createdAt: string;
}

export interface BalanceStats {
  funded: number;
  unfunded: number;
  total: number;
}

// ============ NETWORK CONFIGS ============

const NETWORK_CONFIGS: Record<NetworkType, NetworkConfig> = {
  "mainnet-beta": {
    RPC_URL: "https://api.mainnet-beta.solana.com",
    JITO_ENDPOINT: JITO_ENDPOINTS.mainnet.london,
    JITO_CONFIG: {
      ...DEFAULT_JITO_CONFIG,
      maxRetries: 3,
      enableEndpointFallback: true,
    },
  },
  testnet: {
    RPC_URL: "https://solana-testnet-rpc.publicnode.com",
    JITO_ENDPOINT: JITO_ENDPOINTS.testnet.ny,
    JITO_CONFIG: {
      ...DEFAULT_JITO_CONFIG,
      maxRetries: 3,
      enableEndpointFallback: false,
    },
  },
  devnet: {
    RPC_URL: "https://devnet.helius-rpc.com/?api-key=e26bf879-6bb4-49c0-aafa-8e4d86687455",
    JITO_ENDPOINT: JITO_ENDPOINTS.testnet.ny,
    JITO_CONFIG: {
      ...DEFAULT_JITO_CONFIG,
      maxRetries: 3,
      enableEndpointFallback: false,
    },
  },
};

// ============ SELECTED NETWORK ============

const SELECTED_NETWORK: NetworkType = (process.env.SOLANA_NETWORK as NetworkType) || "testnet";
const networkConfig = NETWORK_CONFIGS[SELECTED_NETWORK];

// ============ APP CONFIG ============

export const CONFIG = {
  WALLET_COUNT: 100,
  RPC_URL: networkConfig.RPC_URL,
  JITO_ENDPOINT: networkConfig.JITO_ENDPOINT,
  WALLETS_DIR: path.join(__dirname, "..", "wallets"),
  LUT_FILE: path.join(__dirname, "..", "lut.json"),
  NETWORK: SELECTED_NETWORK,
  BALANCE_CHECK_INTERVAL: 10000,
  TRANSFERS_PER_TX_WITH_LUT: 50,
  TRANSFERS_PER_TX_WITHOUT_LUT: 20,
  JITO_CONFIG: networkConfig.JITO_CONFIG,
} as const;

// ============ HELPERS ============

export function getSolscanTxUrl(signature: string): string {
  const network = CONFIG.NETWORK as string;
  const cluster = network === "mainnet-beta" ? "" : `?cluster=${network}`;
  return `https://solscan.io/tx/${signature}${cluster}`;
}
