/**
 * Wallet management - generation, saving, loading
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import ora from "ora";
import { CONFIG, WalletInfo, LUTInfo } from "./config";

// ============ PAYER WALLET ============

export function loadPayerWallet(): Keypair {
  const privateKey = process.env.PAYER_PRIVATE;
  if (!privateKey) {
    throw new Error("PAYER_PRIVATE not found in .env file");
  }
  try {
    return Keypair.fromSecretKey(bs58.decode(privateKey));
  } catch {
    throw new Error("Invalid PAYER_PRIVATE key in .env file");
  }
}

// ============ WALLET GENERATION ============

export function generateWallet(): Keypair {
  return Keypair.generate();
}

export function keypairToWalletInfo(keypair: Keypair, index: number): WalletInfo {
  return {
    index,
    publicKey: keypair.publicKey.toBase58(),
    secretKey: bs58.encode(keypair.secretKey),
    createdAt: new Date().toISOString(),
  };
}

export function walletInfoToKeypair(info: WalletInfo): Keypair {
  return Keypair.fromSecretKey(bs58.decode(info.secretKey));
}

// ============ WALLETS DIRECTORY ============

export function ensureWalletsDir(): void {
  if (!fs.existsSync(CONFIG.WALLETS_DIR)) {
    fs.mkdirSync(CONFIG.WALLETS_DIR, { recursive: true });
  }
}

export async function generateAndSaveWallets(count: number): Promise<Keypair[]> {
  ensureWalletsDir();

  const spinner = ora({
    text: chalk.cyan(`Generating ${count} wallets...`),
    spinner: "dots12",
  }).start();

  const wallets: Keypair[] = [];

  for (let i = 0; i < count; i++) {
    const wallet = generateWallet();
    wallets.push(wallet);

    const walletInfo = keypairToWalletInfo(wallet, i + 1);
    const filePath = path.join(
      CONFIG.WALLETS_DIR,
      `wallet_${String(i + 1).padStart(3, "0")}.json`
    );
    fs.writeFileSync(filePath, JSON.stringify(walletInfo, null, 2));

    spinner.text = chalk.cyan(`Generating wallets... ${i + 1}/${count}`);
  }

  spinner.succeed(chalk.green(`Generated ${count} wallets`));
  console.log(chalk.gray(`  📁 Saved to: ${CONFIG.WALLETS_DIR}`));

  return wallets;
}

export function loadWalletsFromDir(): Keypair[] | null {
  if (!fs.existsSync(CONFIG.WALLETS_DIR)) {
    return null;
  }

  const files = fs
    .readdirSync(CONFIG.WALLETS_DIR)
    .filter((f) => f.startsWith("wallet_") && f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    return null;
  }

  const wallets: Keypair[] = [];
  for (const file of files) {
    const filePath = path.join(CONFIG.WALLETS_DIR, file);
    const data: WalletInfo = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    wallets.push(walletInfoToKeypair(data));
  }

  return wallets;
}

// ============ LUT INFO ============

export function saveLUTInfo(lutAddress: string, walletCount: number): void {
  const lutInfo: LUTInfo = {
    address: lutAddress,
    walletCount,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(CONFIG.LUT_FILE, JSON.stringify(lutInfo, null, 2));
}

export function loadLUTInfo(): LUTInfo | null {
  if (!fs.existsSync(CONFIG.LUT_FILE)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(CONFIG.LUT_FILE, "utf-8"));
}

export function deleteLUTInfo(): void {
  if (fs.existsSync(CONFIG.LUT_FILE)) {
    fs.unlinkSync(CONFIG.LUT_FILE);
  }
}
