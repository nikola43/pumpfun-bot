/**
 * SOL distribution functions
 */
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import chalk from "chalk";
import ora from "ora";
import { CONFIG, getSolscanTxUrl } from "./config";
import {
  sleep,
  printInfo,
  printError,
  printSuccess,
  getRandomAmount,
  getBalanceWithRetry,
} from "./utils";
import {
  getCachedTipFloor,
  sendVersionedBundle,
  sendVersionedBundleWithLUT,
  BundleResult,
} from "./jito";

// ============ CREATE TRANSFER INSTRUCTIONS ============

export function createRandomTransferInstructions(
  fromPubkey: Keypair["publicKey"],
  wallets: Keypair[],
  amounts: number[]
): TransactionInstruction[] {
  return wallets.map((wallet, i) =>
    SystemProgram.transfer({
      fromPubkey,
      toPubkey: wallet.publicKey,
      lamports: amounts[i],
    })
  );
}

// ============ FALLBACK: REGULAR TRANSACTIONS ============

export async function sendRegularTransactionsWithAmounts(
  connection: Connection,
  fundingWallet: Keypair,
  targetWallets: Keypair[],
  amounts: number[]
): Promise<void> {
  const TRANSFERS_PER_TX = 20;

  for (let i = 0; i < targetWallets.length; i += TRANSFERS_PER_TX) {
    const batchWallets = targetWallets.slice(i, i + TRANSFERS_PER_TX);
    const batchAmounts = amounts.slice(i, i + TRANSFERS_PER_TX);
    const transaction = new Transaction();

    for (let j = 0; j < batchWallets.length; j++) {
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: fundingWallet.publicKey,
          toPubkey: batchWallets[j].publicKey,
          lamports: batchAmounts[j],
        })
      );
    }

    try {
      const signature = await connection.sendTransaction(transaction, [fundingWallet]);
      await connection.confirmTransaction(signature, "confirmed");
    } catch {
      // Silent fail for fallback
    }

    await sleep(500);
  }
}

// ============ DISTRIBUTION SUMMARY ============

export function printDistributionSummary(
  successful: number,
  failed: number,
  total: number,
  usedLUT: boolean
): void {
  console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════"));
  printSuccess("Distribution Complete!");
  console.log(
    chalk.gray("  •") +
      chalk.white(` Mode: `) +
      (usedLUT ? chalk.magenta("LUT (Optimized)") : chalk.yellow("Standard"))
  );
  console.log(
    chalk.gray("  •") +
      chalk.white(` Successful: `) +
      chalk.green(`${successful}/${total}`)
  );
  if (failed > 0) {
    console.log(
      chalk.gray("  •") +
        chalk.white(` Fallback used: `) +
        chalk.yellow(`${failed}`)
    );
  }
  console.log(chalk.cyan.bold("  ══════════════════════════════════════════\n"));
}

// ============ DISTRIBUTE WITH LUT ============

export async function distributeSOLWithLUT(
  connection: Connection,
  fundingWallet: Keypair,
  targetWallets: Keypair[],
  minSol: number,
  maxSol: number,
  lookupTableAccount: AddressLookupTableAccount
): Promise<boolean> {
  const amounts: number[] = targetWallets.map(() => {
    const solAmount = getRandomAmount(minSol, maxSol);
    return Math.floor(solAmount * LAMPORTS_PER_SOL);
  });

  const totalLamports = amounts.reduce((sum, a) => sum + a, 0);
  const totalSol = totalLamports / LAMPORTS_PER_SOL;

  // Get real-time tip floor
  const tipSpinner = ora({
    text: chalk.cyan("Fetching real-time Jito tip floor..."),
    spinner: "dots",
  }).start();

  const tipLamports = await getCachedTipFloor(CONFIG.JITO_ENDPOINT, "99", CONFIG.JITO_CONFIG);
  tipSpinner.succeed(chalk.green(`Tip floor: ${(tipLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL (99th percentile)`));

  console.log(chalk.cyan.bold("\n  📋 Distribution Plan") + chalk.magenta.bold(" [LUT MODE]") + "\n");
  printInfo("Min per wallet", `${minSol} SOL`);
  printInfo("Max per wallet", `${maxSol} SOL`);
  printInfo("Total to distribute", `${totalSol.toFixed(6)} SOL`);
  printInfo("Wallets", `${targetWallets.length}`);
  printInfo("Transfers per TX", `~${CONFIG.TRANSFERS_PER_TX_WITH_LUT} (with LUT)`);
  printInfo("Jito Tip", `${(tipLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL (real-time)`);

  const balance = await getBalanceWithRetry(connection, fundingWallet.publicKey);
  const requiredBalance = totalLamports + tipLamports * 3 + 100000;

  console.log();
  printInfo("Wallet balance", `${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  printInfo("Required", `${(requiredBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

  if (balance < requiredBalance) {
    printError("INSUFFICIENT BALANCE!");
    const shortfall = (requiredBalance - balance) / LAMPORTS_PER_SOL;
    console.log(chalk.gray(`\n  Need: ${shortfall.toFixed(6)} more SOL`));
    if (CONFIG.NETWORK !== "mainnet-beta") {
      console.log(chalk.yellow(`\n  💡 Get free ${CONFIG.NETWORK} SOL:`));
      console.log(chalk.gray("     • https://faucet.solana.com"));
      console.log(chalk.gray("     • https://solfaucet.com\n"));
    }
    return false;
  }

  // Batch with larger size thanks to LUT
  const TRANSFERS_PER_TX = CONFIG.TRANSFERS_PER_TX_WITH_LUT;
  const batches: { wallets: Keypair[]; amounts: number[] }[] = [];

  for (let i = 0; i < targetWallets.length; i += TRANSFERS_PER_TX) {
    batches.push({
      wallets: targetWallets.slice(i, i + TRANSFERS_PER_TX),
      amounts: amounts.slice(i, i + TRANSFERS_PER_TX),
    });
  }

  const TXNS_PER_BUNDLE = 5;
  const bundleBatches: { wallets: Keypair[]; amounts: number[] }[][] = [];

  for (let i = 0; i < batches.length; i += TXNS_PER_BUNDLE) {
    bundleBatches.push(batches.slice(i, i + TXNS_PER_BUNDLE));
  }

  console.log(chalk.cyan.bold("\n  🚀 Sending Transactions\n"));
  const totalTransfers = targetWallets.length;
  console.log(chalk.gray(`  Mode: `) + chalk.magenta("LUT Optimized"));
  console.log(chalk.gray(`  Bundles: `) + chalk.white(`${bundleBatches.length}`));
  console.log(chalk.gray(`  Transactions: `) + chalk.white(`${batches.length}`));
  console.log(chalk.gray(`  Total transfers: `) + chalk.white(`${totalTransfers}\n`));

  let successfulBundles = 0;
  let failedBundles = 0;
  let processedTransfers = 0;

  for (let bundleIdx = 0; bundleIdx < bundleBatches.length; bundleIdx++) {
    const bundleBatch = bundleBatches[bundleIdx];
    const bundleTransfers = bundleBatch.reduce((sum, b) => sum + b.wallets.length, 0);

    const progressPct = Math.round((processedTransfers / totalTransfers) * 100);
    const spinner = ora({
      text: chalk.cyan(`Bundle ${bundleIdx + 1}/${bundleBatches.length}`) + chalk.gray(` [${progressPct}% complete]`),
      spinner: "dots12",
    }).start();

    try {
      const instructionBatches: TransactionInstruction[][] = bundleBatch.map(
        (batch) =>
          createRandomTransferInstructions(
            fundingWallet.publicKey,
            batch.wallets,
            batch.amounts
          )
      );

      const currentTip = await getCachedTipFloor(CONFIG.JITO_ENDPOINT, "99", CONFIG.JITO_CONFIG);

      const result: BundleResult = await sendVersionedBundleWithLUT(
        connection,
        fundingWallet,
        instructionBatches,
        currentTip,
        lookupTableAccount,
        CONFIG.JITO_ENDPOINT,
        CONFIG.JITO_CONFIG
      );

      if (result.success) {
        successfulBundles++;
        processedTransfers += bundleTransfers;
        spinner.succeed(
          chalk.green(`Bundle ${bundleIdx + 1}/${bundleBatches.length}`) +
            chalk.magenta(` [LUT] `) +
            chalk.gray(`ID: ${result.bundleId?.slice(0, 16)}...`)
        );

        if (result.signatures && result.signatures.length > 0) {
          result.signatures.forEach((sig, idx) => {
            console.log(
              chalk.gray(`     TX ${idx + 1}: `) +
                chalk.cyan(getSolscanTxUrl(sig))
            );
          });
        }
      } else {
        spinner.warn(chalk.yellow(`Bundle ${bundleIdx + 1} failed, using fallback...`));
        failedBundles++;
        processedTransfers += bundleTransfers;

        await sendRegularTransactionsWithAmounts(
          connection,
          fundingWallet,
          bundleBatch.flatMap((b) => b.wallets),
          bundleBatch.flatMap((b) => b.amounts)
        );
      }

      if (bundleIdx < bundleBatches.length - 1) {
        await sleep(1000);
      }
    } catch {
      spinner.fail(chalk.red(`Bundle ${bundleIdx + 1} error`));
      failedBundles++;
      processedTransfers += bundleTransfers;
    }
  }

  printDistributionSummary(successfulBundles, failedBundles, bundleBatches.length, true);
  return true;
}

// ============ DISTRIBUTE WITHOUT LUT ============

export async function distributeSOLWithoutLUT(
  connection: Connection,
  fundingWallet: Keypair,
  targetWallets: Keypair[],
  minSol: number,
  maxSol: number
): Promise<boolean> {
  const amounts: number[] = targetWallets.map(() => {
    const solAmount = getRandomAmount(minSol, maxSol);
    return Math.floor(solAmount * LAMPORTS_PER_SOL);
  });

  const totalLamports = amounts.reduce((sum, a) => sum + a, 0);
  const totalSol = totalLamports / LAMPORTS_PER_SOL;

  // Get real-time tip floor
  const tipSpinner = ora({
    text: chalk.cyan("Fetching real-time Jito tip floor..."),
    spinner: "dots",
  }).start();

  const tipLamports = await getCachedTipFloor(CONFIG.JITO_ENDPOINT, "99", CONFIG.JITO_CONFIG);
  tipSpinner.succeed(chalk.green(`Tip floor: ${(tipLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL (99th percentile)`));

  console.log(chalk.cyan.bold("\n  📋 Distribution Plan") + chalk.yellow.bold(" [NO LUT]") + "\n");
  printInfo("Min per wallet", `${minSol} SOL`);
  printInfo("Max per wallet", `${maxSol} SOL`);
  printInfo("Total to distribute", `${totalSol.toFixed(6)} SOL`);
  printInfo("Wallets", `${targetWallets.length}`);
  printInfo("Transfers per TX", `~${CONFIG.TRANSFERS_PER_TX_WITHOUT_LUT} (without LUT)`);
  printInfo("Jito Tip", `${(tipLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL (real-time)`);

  const balance = await getBalanceWithRetry(connection, fundingWallet.publicKey);
  const requiredBalance = totalLamports + tipLamports * 5 + 100000;

  console.log();
  printInfo("Wallet balance", `${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  printInfo("Required", `${(requiredBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

  if (balance < requiredBalance) {
    printError("INSUFFICIENT BALANCE!");
    const shortfall = (requiredBalance - balance) / LAMPORTS_PER_SOL;
    console.log(chalk.gray(`\n  Need: ${shortfall.toFixed(6)} more SOL`));
    if (CONFIG.NETWORK !== "mainnet-beta") {
      console.log(chalk.yellow(`\n  💡 Get free ${CONFIG.NETWORK} SOL:`));
      console.log(chalk.gray("     • https://faucet.solana.com"));
      console.log(chalk.gray("     • https://solfaucet.com\n"));
    }
    return false;
  }

  const TRANSFERS_PER_TX = CONFIG.TRANSFERS_PER_TX_WITHOUT_LUT;
  const batches: { wallets: Keypair[]; amounts: number[] }[] = [];

  for (let i = 0; i < targetWallets.length; i += TRANSFERS_PER_TX) {
    batches.push({
      wallets: targetWallets.slice(i, i + TRANSFERS_PER_TX),
      amounts: amounts.slice(i, i + TRANSFERS_PER_TX),
    });
  }

  const TXNS_PER_BUNDLE = 5;
  const bundleBatches: { wallets: Keypair[]; amounts: number[] }[][] = [];

  for (let i = 0; i < batches.length; i += TXNS_PER_BUNDLE) {
    bundleBatches.push(batches.slice(i, i + TXNS_PER_BUNDLE));
  }

  console.log(chalk.cyan.bold("\n  🚀 Sending Transactions\n"));

  let successfulBundles = 0;
  let failedBundles = 0;

  for (let bundleIdx = 0; bundleIdx < bundleBatches.length; bundleIdx++) {
    const bundleBatch = bundleBatches[bundleIdx];

    const spinner = ora({
      text: chalk.cyan(`Bundle ${bundleIdx + 1}/${bundleBatches.length}...`),
      spinner: "dots12",
    }).start();

    try {
      const instructionBatches: TransactionInstruction[][] = bundleBatch.map(
        (batch) =>
          createRandomTransferInstructions(
            fundingWallet.publicKey,
            batch.wallets,
            batch.amounts
          )
      );

      const currentTip = await getCachedTipFloor(CONFIG.JITO_ENDPOINT, "99", CONFIG.JITO_CONFIG);

      const result: BundleResult = await sendVersionedBundle(
        connection,
        fundingWallet,
        instructionBatches,
        currentTip,
        CONFIG.JITO_ENDPOINT,
        CONFIG.JITO_CONFIG
      );

      if (result.success) {
        successfulBundles++;
        spinner.succeed(
          chalk.green(`Bundle ${bundleIdx + 1}/${bundleBatches.length}`) +
            chalk.gray(` ID: ${result.bundleId?.slice(0, 16)}...`)
        );

        if (result.signatures && result.signatures.length > 0) {
          result.signatures.forEach((sig, idx) => {
            console.log(
              chalk.gray(`     TX ${idx + 1}: `) +
                chalk.cyan(getSolscanTxUrl(sig))
            );
          });
        }
      } else {
        spinner.warn(chalk.yellow(`Bundle ${bundleIdx + 1} failed, using fallback...`));
        failedBundles++;

        await sendRegularTransactionsWithAmounts(
          connection,
          fundingWallet,
          bundleBatch.flatMap((b) => b.wallets),
          bundleBatch.flatMap((b) => b.amounts)
        );
      }

      if (bundleIdx < bundleBatches.length - 1) {
        await sleep(1000);
      }
    } catch {
      spinner.fail(chalk.red(`Bundle ${bundleIdx + 1} error`));
      failedBundles++;
    }
  }

  printDistributionSummary(successfulBundles, failedBundles, bundleBatches.length, false);
  return true;
}
