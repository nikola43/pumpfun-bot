/**
 * Balance checking and monitoring functions
 */
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import chalk from "chalk";
import ora from "ora";
import { CONFIG, BalanceStats } from "./config";
import { sleep, createProgressBar, getMultipleAccountsWithRetry, printSuccess } from "./utils";

// ============ CHECK BALANCES ============

export async function checkBalances(
  connection: Connection,
  wallets: Keypair[],
  showDetails: boolean = true
): Promise<BalanceStats> {
  let funded = 0;
  let unfunded = 0;
  let totalBalance = 0;

  const spinner = showDetails
    ? null
    : ora({ text: chalk.cyan("Checking balances..."), spinner: "dots" }).start();

  const BATCH_SIZE = 100;
  const balances: number[] = [];

  // Fetch balances in batches with retry
  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    const batchWallets = wallets.slice(i, i + BATCH_SIZE);
    const publicKeys = batchWallets.map((w) => w.publicKey);

    const accounts = await getMultipleAccountsWithRetry(connection, publicKeys);

    for (const account of accounts) {
      balances.push(account?.lamports ?? 0);
    }
  }

  // Process results
  for (let i = 0; i < wallets.length; i++) {
    const balance = balances[i];
    totalBalance += balance;

    if (balance > 0) {
      funded++;
      if (showDetails) {
        console.log(
          chalk.gray(`  ${String(i + 1).padStart(3, "0")}.`) +
            chalk.white(` ${wallets[i].publicKey.toBase58().slice(0, 20)}...`) +
            chalk.green(` ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL `) +
            chalk.green("✓")
        );
      }
    } else {
      unfunded++;
      if (showDetails) {
        console.log(
          chalk.gray(`  ${String(i + 1).padStart(3, "0")}.`) +
            chalk.white(` ${wallets[i].publicKey.toBase58().slice(0, 20)}...`) +
            chalk.red(` 0 SOL`)
        );
      }
    }
  }

  if (spinner) {
    spinner.stop();
  }

  return { funded, unfunded, total: totalBalance };
}

// ============ POLL BALANCES ============

export async function pollBalancesUntilFunded(
  connection: Connection,
  wallets: Keypair[]
): Promise<void> {
  console.log(chalk.cyan.bold("\n  📊 Monitoring Balances"));
  console.log(chalk.gray("  Press Ctrl+C to stop\n"));

  let allFunded = false;
  let checkCount = 0;

  while (!allFunded) {
    checkCount++;
    const timestamp = new Date().toLocaleTimeString();

    const spinner = ora({
      text: chalk.cyan(`[${timestamp}] Check #${checkCount}...`),
      spinner: "dots",
    }).start();

    const stats = await checkBalances(connection, wallets, false);

    spinner.stop();

    const progressBar = createProgressBar(stats.funded, wallets.length);
    console.log(
      chalk.gray(`  [${timestamp}]`) +
        chalk.white(` Check #${checkCount} `) +
        progressBar +
        chalk.white(` ${stats.funded}/${wallets.length}`)
    );

    if (stats.unfunded === 0) {
      allFunded = true;
      printSuccess("ALL WALLETS FUNDED!");
      console.log(
        chalk.green(`  💰 Total: ${(stats.total / LAMPORTS_PER_SOL).toFixed(6)} SOL\n`)
      );
    } else {
      await sleep(CONFIG.BALANCE_CHECK_INTERVAL);
    }
  }
}

// ============ GET WALLET BALANCES FOR RETURN ============

export async function getWalletBalances(
  connection: Connection,
  wallets: Keypair[]
): Promise<{ wallet: Keypair; balance: number }[]> {
  const BATCH_SIZE = 100;
  const balances: number[] = [];

  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    const batchWallets = wallets.slice(i, i + BATCH_SIZE);
    const publicKeys = batchWallets.map((w) => w.publicKey);
    const accounts = await getMultipleAccountsWithRetry(connection, publicKeys);

    for (const account of accounts) {
      balances.push(account?.lamports ?? 0);
    }
  }

  return wallets.map((wallet, i) => ({ wallet, balance: balances[i] }));
}
