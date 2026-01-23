/**
 * Utility functions for UI and common operations
 */
import chalk from "chalk";
import { Connection, PublicKey } from "@solana/web3.js";
import { VERSION, withRetry, isRetryableError } from "./jito";

// ============ SLEEP ============

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============ SCREEN ============

export function clearScreen(): void {
  console.clear();
}

// ============ PRINT HELPERS ============

export function printHeader(): void {
  const versionStr = `v${VERSION}`;
  console.log(chalk.cyan.bold("\n  ╔═══════════════════════════════════════════════════════╗"));
  console.log(chalk.cyan.bold("  ║") + chalk.yellow.bold(`       🚀 SOLANA PUMPFUN BUNDLER ${versionStr} 🚀              `) + chalk.cyan.bold("║"));
  console.log(chalk.cyan.bold("  ║") + chalk.gray("         Powered by Jito Bundles + LUT                 ") + chalk.cyan.bold("║"));
  console.log(chalk.cyan.bold("  ╚═══════════════════════════════════════════════════════╝\n"));
}

export function printInfo(label: string, value: string): void {
  console.log(chalk.gray("  •") + chalk.white(` ${label}: `) + chalk.green(value));
}

export function printSuccess(message: string): void {
  console.log(chalk.green.bold(`\n  ✓ ${message}`));
}

export function printError(message: string): void {
  console.log(chalk.red.bold(`\n  ✗ ${message}`));
}

export function printWarning(message: string): void {
  console.log(chalk.yellow.bold(`\n  ⚠ ${message}`));
}

// ============ PROGRESS BAR ============

export function createProgressBar(current: number, total: number): string {
  const width = 20;
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  const percentage = Math.round((current / total) * 100);

  const bar = chalk.green("█".repeat(filled)) + chalk.gray("░".repeat(empty));
  const color = percentage === 100 ? chalk.green : percentage > 50 ? chalk.yellow : chalk.red;

  return `${bar} ${color(`${percentage}%`)}`;
}

// ============ RPC HELPERS WITH RETRY ============

export async function checkRpcHealth(connection: Connection): Promise<boolean> {
  return withRetry(
    async () => {
      await connection.getVersion();
      return true;
    },
    {
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 5000,
      shouldRetry: isRetryableError,
    }
  );
}

export async function getBalanceWithRetry(
  connection: Connection,
  publicKey: PublicKey
): Promise<number> {
  return withRetry(
    () => connection.getBalance(publicKey),
    {
      maxRetries: 2,
      initialDelayMs: 500,
      shouldRetry: isRetryableError,
    }
  );
}

export async function getMultipleAccountsWithRetry(
  connection: Connection,
  publicKeys: PublicKey[]
): Promise<(any | null)[]> {
  return withRetry(
    () => connection.getMultipleAccountsInfo(publicKeys),
    {
      maxRetries: 3,
      initialDelayMs: 500,
      shouldRetry: isRetryableError,
    }
  );
}

export async function getBlockhashWithRetry(
  connection: Connection
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  return withRetry(
    () => connection.getLatestBlockhash("confirmed"),
    {
      maxRetries: 3,
      initialDelayMs: 500,
      shouldRetry: isRetryableError,
    }
  );
}

// ============ RANDOM ============

export function getRandomAmount(minSol: number, maxSol: number): number {
  return Math.random() * (maxSol - minSol) + minSol;
}
