/**
 * Menu action handlers
 */
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import chalk from "chalk";
import ora from "ora";
import { select, input, confirm, number } from "@inquirer/prompts";
import bs58 from "bs58";
import BN from "bn.js";

import { CONFIG, getSolscanTxUrl } from "./config";
import {
  sleep,
  printInfo,
  printError,
  printSuccess,
  printWarning,
  getBlockhashWithRetry,
  getBalanceWithRetry,
} from "./utils";
import {
  loadWalletsFromDir,
  generateAndSaveWallets,
  loadLUTInfo,
  saveLUTInfo,
} from "./wallet";
import { checkBalances, getWalletBalances } from "./balance";
import { distributeSOLWithLUT, distributeSOLWithoutLUT } from "./distribute";
import {
  createLookupTable,
  extendLookupTable,
  getLookupTableAccount,
  waitForLookupTableActive,
  sendBundleWithConfirmation,
  getTipAccounts,
  getRandomTipAccount,
  getTipFloor,
} from "./jito";
import {
  fetchPumpTokenInfo,
  getTokenBalances,
  executeBuy,
  executeSell,
  getAllWalletTokenHoldings,
  aggregateTokenHoldings,
  transferAllTokensToWallet,
} from "./pump";
import { executeSwapBuy, executeSwapSell } from "./pumpswap";

// Quick trade token address
const QUICK_TRADE_TOKEN = "GMk6j2defJhS7F194toqmJNFNhAkbDXhYJo5oR3Rpump";

// ============ PRESS ENTER TO CONTINUE ============

export async function pressAnyKeyToContinue(): Promise<void> {
  await sleep(100);
  await select({
    message: chalk.gray("Done!"),
    choices: [{ name: chalk.cyan("← Back to Menu"), value: true }],
  });
}

// ============ CREATE WALLETS ============

export async function actionCreateWallets(): Promise<void> {
  const existingWallets = loadWalletsFromDir();
  if (existingWallets && existingWallets.length > 0) {
    printWarning(`Found ${existingWallets.length} existing wallets`);

    const action = await select({
      message: chalk.yellow("What would you like to do?"),
      choices: [
        { name: chalk.white("Keep existing wallets"), value: "keep" },
        { name: chalk.red("Delete and create new wallets"), value: "delete" },
        { name: chalk.gray("Cancel"), value: "cancel" },
      ],
    });

    if (action === "cancel") {
      return;
    }

    if (action === "keep") {
      console.log(chalk.gray(`\n  Using existing ${existingWallets.length} wallets.\n`));
      await pressAnyKeyToContinue();
      return;
    }
  }

  const count = await number({
    message: chalk.cyan("How many wallets to create?"),
    default: CONFIG.WALLET_COUNT,
    validate: (value) => (value && value > 0 ? true : "Please enter a positive number"),
  });

  await generateAndSaveWallets(count || CONFIG.WALLET_COUNT);
  await pressAnyKeyToContinue();
}

// ============ CREATE LUT ============

export async function actionCreateLUT(
  connection: Connection,
  payerWallet: Keypair
): Promise<void> {
  const wallets = loadWalletsFromDir();

  if (!wallets || wallets.length === 0) {
    printError("No wallets found. Create wallets first!");
    return;
  }

  const existingLUT = loadLUTInfo();
  if (existingLUT) {
    printWarning(`Found existing LUT: ${existingLUT.address.slice(0, 20)}...`);

    const recreate = await confirm({
      message: chalk.yellow("Create new LUT? (old one will be abandoned)"),
      default: false,
    });

    if (!recreate) {
      console.log(chalk.gray("\n  Cancelled.\n"));
      return;
    }
  }

  console.log(chalk.cyan.bold("\n  🔧 Creating Address Lookup Table\n"));
  printInfo("Wallets to include", `${wallets.length}`);
  printInfo("Payer", payerWallet.publicKey.toBase58().slice(0, 20) + "...");

  const shouldProceed = await confirm({
    message: chalk.yellow("Proceed with LUT creation?"),
    default: true,
  });

  if (!shouldProceed) {
    console.log(chalk.gray("\n  Cancelled.\n"));
    return;
  }

  const createSpinner = ora({
    text: chalk.cyan("Creating Lookup Table..."),
    spinner: "dots12",
  }).start();

  try {
    const { lookupTableAddress } = await createLookupTable(connection, payerWallet);

    createSpinner.succeed(chalk.green(`LUT created: ${lookupTableAddress.toBase58().slice(0, 20)}...`));

    const extendSpinner = ora({
      text: chalk.cyan(`Adding ${wallets.length + 1} addresses to LUT...`),
      spinner: "dots12",
    }).start();

    const addressesToAdd = [
      payerWallet.publicKey,
      ...wallets.map((w) => w.publicKey),
    ];

    await extendLookupTable(connection, payerWallet, lookupTableAddress, addressesToAdd);

    extendSpinner.succeed(chalk.green(`Added ${addressesToAdd.length} addresses`));

    const waitSpinner = ora({
      text: chalk.cyan("Waiting for LUT to become active..."),
      spinner: "dots12",
    }).start();

    const lutAccount = await waitForLookupTableActive(
      connection,
      lookupTableAddress,
      addressesToAdd.length
    );

    if (lutAccount) {
      waitSpinner.succeed(chalk.green("LUT is active and ready!"));
      saveLUTInfo(lookupTableAddress.toBase58(), wallets.length);
      printSuccess("Lookup Table created successfully!");
      printInfo("Address", lookupTableAddress.toBase58());
      printInfo("Entries", `${lutAccount.state.addresses.length}`);
    } else {
      waitSpinner.fail(chalk.red("LUT activation timeout"));
    }
  } catch (error: any) {
    createSpinner.fail(chalk.red(`Failed: ${error.message}`));
  }

  await pressAnyKeyToContinue();
}

// ============ FUND WALLETS ============

export async function actionFundWallets(
  connection: Connection,
  payerWallet: Keypair
): Promise<void> {
  const allWallets = loadWalletsFromDir();

  if (!allWallets || allWallets.length === 0) {
    printError("No wallets found. Create wallets first!");
    await pressAnyKeyToContinue();
    return;
  }

  console.log(chalk.cyan(`  📁 Found ${allWallets.length} wallets\n`));

  // Ask for wallet range
  const fromWallet = await number({
    message: chalk.cyan("From wallet #") + chalk.gray(` (1-${allWallets.length}, default: 1)`) + chalk.cyan(":"),
    default: 1,
    step: 1,
    validate: (value) => (value && value >= 1 && value <= allWallets.length ? true : `Must be 1-${allWallets.length}`),
  }) || 1;

  const toWallet = await number({
    message: chalk.cyan("To wallet #") + chalk.gray(` (${fromWallet}-${allWallets.length}, default: ${allWallets.length})`) + chalk.cyan(":"),
    default: allWallets.length,
    step: 1,
    validate: (value) => (value && value >= fromWallet && value <= allWallets.length ? true : `Must be ${fromWallet}-${allWallets.length}`),
  }) || allWallets.length;

  // Slice wallets (convert 1-based to 0-based index)
  const wallets = allWallets.slice(fromWallet - 1, toWallet);
  console.log(chalk.cyan(`\n  📋 Selected wallets ${fromWallet}-${toWallet} (${wallets.length} wallets)\n`));

  const minSol = await number({
    message: chalk.cyan("Min SOL per wallet") + chalk.gray(" (default: 0.001)") + chalk.cyan(":"),
    default: 0.001,
    step: 0.0001,
    validate: (value) => (value && value > 0 ? true : "Must be greater than 0"),
  }) || 0.001;

  const maxSol = await number({
    message: chalk.cyan("Max SOL per wallet") + chalk.gray(` (default: 0.01)`) + chalk.cyan(":"),
    default: 0.01,
    step: 0.0001,
    validate: (value) => (value && value >= minSol ? true : "Must be >= min amount"),
  }) || 0.01;

  const avgSol = (minSol + maxSol) / 2;
  const estimatedTotal = avgSol * wallets.length;

  const shouldContinue = await confirm({
    message: chalk.yellow(
      `This will distribute ~${estimatedTotal.toFixed(4)} SOL to ${wallets.length} wallets. Continue?`
    ),
    default: true,
  });

  if (!shouldContinue) {
    console.log(chalk.gray("\n  Cancelled.\n"));
    await pressAnyKeyToContinue();
    return;
  }

  const lutInfo = loadLUTInfo();
  let lookupTableAccount: AddressLookupTableAccount | null = null;

  if (lutInfo) {
    lookupTableAccount = await getLookupTableAccount(
      connection,
      new PublicKey(lutInfo.address)
    );
  }

  if (lookupTableAccount) {
    await distributeSOLWithLUT(
      connection,
      payerWallet,
      wallets,
      minSol,
      maxSol,
      lookupTableAccount
    );
  } else {
    printWarning("No LUT found. Using standard transactions (slower).");
    await distributeSOLWithoutLUT(connection, payerWallet, wallets, minSol, maxSol);
  }

  await pressAnyKeyToContinue();
}

// ============ CHECK BALANCES ============

export async function actionCheckBalances(connection: Connection): Promise<void> {
  const wallets = loadWalletsFromDir();

  if (!wallets || wallets.length === 0) {
    printError("No wallets found. Create wallets first!");
    await pressAnyKeyToContinue();
    return;
  }

  console.log(chalk.cyan.bold("\n  📊 Wallet Balances\n"));

  const stats = await checkBalances(connection, wallets, true);

  console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════"));
  console.log(
    chalk.gray("  •") +
    chalk.white(" Funded: ") +
    chalk.green(`${stats.funded}/${wallets.length}`)
  );
  console.log(
    chalk.gray("  •") +
    chalk.white(" Total Balance: ") +
    chalk.green(`${(stats.total / LAMPORTS_PER_SOL).toFixed(6)} SOL`)
  );
  console.log(chalk.cyan.bold("  ══════════════════════════════════════════\n"));

  await pressAnyKeyToContinue();
}

// ============ CHECK TOKEN BALANCES ============

export async function actionCheckTokenBalances(connection: Connection): Promise<void> {
  const wallets = loadWalletsFromDir();

  if (!wallets || wallets.length === 0) {
    printError("No wallets found. Create wallets first!");
    await pressAnyKeyToContinue();
    return;
  }

  console.log(chalk.cyan.bold("\n  🪙 Token Holdings Across All Wallets\n"));

  const spinner = ora({
    text: chalk.cyan(`Scanning ${wallets.length} wallets for token holdings...`),
    spinner: "dots12",
  }).start();

  try {
    const holdings = await getAllWalletTokenHoldings(connection, wallets);
    const aggregated = aggregateTokenHoldings(holdings);

    spinner.stop();

    if (aggregated.length === 0) {
      printWarning("No tokens found in any wallet.");
      await pressAnyKeyToContinue();
      return;
    }

    console.log(chalk.cyan.bold("  ══════════════════════════════════════════════════════════════════════════════\n"));
    console.log(
      chalk.gray("  ") +
      chalk.white.bold("Token Mint".padEnd(46)) +
      chalk.white.bold("Balance".padStart(20)) +
      chalk.white.bold("Holders".padStart(10))
    );
    console.log(chalk.cyan.bold("  ──────────────────────────────────────────────────────────────────────────────\n"));

    for (const token of aggregated) {
      const mintDisplay = token.mint.slice(0, 20) + "..." + token.mint.slice(-8);
      const balanceDisplay = token.totalUiBalance.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      });

      console.log(
        chalk.gray("  ") +
        chalk.cyan(mintDisplay.padEnd(46)) +
        chalk.green(balanceDisplay.padStart(20)) +
        chalk.yellow(`${token.holdersCount}`.padStart(10))
      );
    }

    console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════════════════════════════════════════\n"));

    // Summary
    const totalTokens = aggregated.length;
    const walletsWithTokens = holdings.filter((h) => h.tokens.length > 0).length;

    console.log(
      chalk.gray("  •") +
      chalk.white(" Total unique tokens: ") +
      chalk.green(`${totalTokens}`)
    );
    console.log(
      chalk.gray("  •") +
      chalk.white(" Wallets with tokens: ") +
      chalk.green(`${walletsWithTokens}/${wallets.length}`)
    );
    console.log();

    // Ask if user wants to see detailed breakdown
    if (aggregated.length > 0) {
      const showDetails = await confirm({
        message: chalk.yellow("Show detailed breakdown per wallet?"),
        default: false,
      });

      if (showDetails) {
        for (const token of aggregated) {
          console.log(chalk.cyan.bold(`\n  Token: ${token.mint.slice(0, 20)}...${token.mint.slice(-8)}`));
          console.log(chalk.gray("  " + "─".repeat(60)));

          for (const holder of token.holders) {
            const walletDisplay = holder.walletAddress.slice(0, 12) + "..." + holder.walletAddress.slice(-8);
            const balanceDisplay = holder.uiBalance.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 6,
            });

            console.log(
              chalk.gray("    ") +
              chalk.white(walletDisplay.padEnd(25)) +
              chalk.green(balanceDisplay.padStart(20))
            );
          }
        }
        console.log();
      }
    }
  } catch (error: any) {
    spinner.fail(chalk.red(`Failed to fetch token holdings: ${error.message}`));
  }

  await pressAnyKeyToContinue();
}

// ============ SHOW STATUS ============

export async function actionShowStatus(connection: Connection): Promise<void> {
  console.log(chalk.cyan.bold("\n  ℹ️  System Status\n"));

  const wallets = loadWalletsFromDir();
  const lutInfo = loadLUTInfo();

  printInfo("Network", CONFIG.NETWORK);
  printInfo("RPC", CONFIG.RPC_URL.slice(0, 40) + "...");
  printInfo("Wallets", wallets ? `${wallets.length}` : "None");
  printInfo("LUT", lutInfo ? `${lutInfo.address.slice(0, 20)}...` : "Not created");

  if (wallets && wallets.length > 0) {
    console.log(chalk.cyan.bold("\n  Quick Balance Check:\n"));

    const spinner = ora({
      text: chalk.cyan("Fetching balances..."),
      spinner: "dots",
    }).start();

    const stats = await checkBalances(connection, wallets, false);
    spinner.stop();

    console.log(
      chalk.gray("  •") +
      chalk.white(" Funded wallets: ") +
      chalk.green(`${stats.funded}/${wallets.length}`)
    );
    console.log(
      chalk.gray("  •") +
      chalk.white(" Total balance: ") +
      chalk.green(`${(stats.total / LAMPORTS_PER_SOL).toFixed(6)} SOL`)
    );
  }

  console.log();
  await pressAnyKeyToContinue();
}

// ============ RETURN SOL ============

export async function actionReturnSOL(
  connection: Connection,
  payerWallet: Keypair
): Promise<void> {
  const wallets = loadWalletsFromDir();

  if (!wallets || wallets.length === 0) {
    printError("No wallets found!");
    await pressAnyKeyToContinue();
    return;
  }

  console.log(chalk.cyan.bold("\n  🔄 Return SOL to Payer\n"));

  const spinner = ora({
    text: chalk.cyan("Checking wallet balances..."),
    spinner: "dots",
  }).start();

  const walletBalances = await getWalletBalances(connection, wallets);

  const walletsWithBalance = walletBalances.filter((w) => w.balance > 0);
  const totalToReturn = walletsWithBalance.reduce((sum, w) => sum + w.balance, 0);

  spinner.stop();

  if (walletsWithBalance.length === 0) {
    printWarning("No wallets have returnable balance.");
    await pressAnyKeyToContinue();
    return;
  }

  printInfo("Wallets with balance", `${walletsWithBalance.length}`);
  printInfo("Total to return", `~${(totalToReturn / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  printInfo("Destination", payerWallet.publicKey.toBase58().slice(0, 20) + "...");

  const shouldProceed = await confirm({
    message: chalk.yellow("Proceed with return?"),
    default: true,
  });

  if (!shouldProceed) {
    console.log(chalk.gray("\n  Cancelled.\n"));
    await pressAnyKeyToContinue();
    return;
  }

  // Get dynamic tip floor (99th percentile) with minimum floor for guaranteed landing
  const MIN_TIP_LAMPORTS = 2_000_000; // Minimum 0.002 SOL
  const PRIORITY_FEE = { unitLimit: 250000, unitPrice: 250000 };

  const tipFloorSpinner = ora({
    text: chalk.cyan("Fetching 99th percentile tip floor..."),
    spinner: "dots",
  }).start();

  let tipLamports: number;
  try {
    const fetchedTip = await getTipFloor(CONFIG.JITO_ENDPOINT, "99", CONFIG.JITO_CONFIG);
    // Use max of fetched tip and minimum to ensure landing
    tipLamports = Math.max(fetchedTip, MIN_TIP_LAMPORTS);
    tipFloorSpinner.succeed(chalk.green(`Tip floor: ${(tipLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`));
  } catch {
    tipLamports = MIN_TIP_LAMPORTS;
    tipFloorSpinner.warn(chalk.yellow(`Using default tip: ${(tipLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`));
  }

  // Rate limit protection - wait before making more Jito requests
  await sleep(1500);

  // Each wallet signs its own return, so max ~5 signers per tx
  const RETURNS_PER_TX = 5;
  const TXNS_PER_BUNDLE = 5;

  const batches: { wallet: Keypair; balance: number }[][] = [];
  for (let i = 0; i < walletsWithBalance.length; i += RETURNS_PER_TX) {
    batches.push(walletsWithBalance.slice(i, i + RETURNS_PER_TX));
  }

  const bundleBatches: typeof batches[] = [];
  for (let i = 0; i < batches.length; i += TXNS_PER_BUNDLE) {
    bundleBatches.push(batches.slice(i, i + TXNS_PER_BUNDLE));
  }

  let successful = 0;
  let failed = 0;
  let totalReturned = 0;

  // Fetch tip accounts once (not per bundle) to avoid rate limiting
  const tipAccounts = await getTipAccounts(CONFIG.JITO_ENDPOINT, CONFIG.JITO_CONFIG);

  console.log(chalk.cyan.bold("\n  🚀 Sending Return Transactions\n"));

  for (let bundleIdx = 0; bundleIdx < bundleBatches.length; bundleIdx++) {
    const bundleBatch = bundleBatches[bundleIdx];

    const bundleSpinner = ora({
      text: chalk.cyan(`Bundle ${bundleIdx + 1}/${bundleBatches.length}...`),
      spinner: "dots12",
    }).start();

    try {
      const { blockhash } = await getBlockhashWithRetry(connection);
      const tipAccount = getRandomTipAccount(tipAccounts);

      const serializedTransactions: string[] = [];
      const signatures: string[] = [];

      for (let txIdx = 0; txIdx < bundleBatch.length; txIdx++) {
        const txBatch = bundleBatch[txIdx];
        const signers: Keypair[] = [payerWallet]; // Payer is always first signer (fee payer)
        let txReturned = 0;

        // Check if this is the last tx in the bundle (needs tip)
        const isLastTxInBundle = txIdx === bundleBatch.length - 1;

        // Start with compute budget instructions for priority
        const instructions: any[] = [
          ComputeBudgetProgram.setComputeUnitLimit({ units: PRIORITY_FEE.unitLimit }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE.unitPrice }),
        ];

        for (const { wallet, balance } of txBatch) {
          // Drain entire balance - payer pays tx fees
          if (balance > 0) {
            instructions.push({
              programId: new PublicKey("11111111111111111111111111111111"),
              keys: [
                { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
                { pubkey: payerWallet.publicKey, isSigner: false, isWritable: true },
              ],
              data: Buffer.concat([
                Buffer.from([2, 0, 0, 0]),
                Buffer.from(new BN(balance).toArray("le", 8)),
              ]),
            });
            signers.push(wallet);
            txReturned += balance;
          }
        }

        // Add tip instruction on last tx of bundle
        if (isLastTxInBundle && txReturned > 0) {
          instructions.push({
            programId: new PublicKey("11111111111111111111111111111111"),
            keys: [
              { pubkey: payerWallet.publicKey, isSigner: true, isWritable: true },
              { pubkey: new PublicKey(tipAccount), isSigner: false, isWritable: true },
            ],
            data: Buffer.concat([
              Buffer.from([2, 0, 0, 0]),
              Buffer.from(new BN(tipLamports).toArray("le", 8)),
            ]),
          });
        }

        if (txReturned > 0) {
          const messageV0 = new TransactionMessage({
            payerKey: payerWallet.publicKey, // Payer pays tx fees
            recentBlockhash: blockhash,
            instructions,
          }).compileToV0Message();

          const transaction = new VersionedTransaction(messageV0);
          transaction.sign(signers);

          const sig = bs58.encode(transaction.signatures[0]);
          signatures.push(sig);
          serializedTransactions.push(bs58.encode(transaction.serialize()));
          totalReturned += txReturned;
        }
      }

      if (serializedTransactions.length > 0) {
        bundleSpinner.text = chalk.cyan(`Bundle ${bundleIdx + 1} sending via SearcherClient...`);

        // Send bundle and wait for confirmation using SearcherClient
        const result = await sendBundleWithConfirmation(
          serializedTransactions,
          CONFIG.JITO_ENDPOINT,
          CONFIG.JITO_CONFIG,
          60000 // 60s timeout
        );

        if (result.success && result.landed) {
          successful++;
          bundleSpinner.succeed(
            chalk.green(`Bundle ${bundleIdx + 1}/${bundleBatches.length} LANDED`) +
            (result.slot ? chalk.gray(` slot: ${result.slot}`) : "")
          );
          signatures.forEach((sig, idx) => {
            console.log(
              chalk.gray(`     TX ${idx + 1}: `) +
              chalk.cyan(getSolscanTxUrl(sig))
            );
          });
        } else if (result.success && !result.landed) {
          // Bundle sent but confirmation timed out - likely still landed
          bundleSpinner.warn(
            chalk.yellow(`Bundle ${bundleIdx + 1} sent, confirmation pending`) +
            chalk.gray(` ID: ${result.bundleId?.slice(0, 16)}...`)
          );
          signatures.forEach((sig, idx) => {
            console.log(
              chalk.gray(`     TX ${idx + 1}: `) +
              chalk.cyan(getSolscanTxUrl(sig))
            );
          });
          successful++; // Count as success since bundle was accepted
        } else {
          failed++;
          bundleSpinner.fail(
            chalk.red(`Bundle ${bundleIdx + 1} failed: ${result.error || "Unknown error"}`)
          );
        }
      } else {
        bundleSpinner.warn(chalk.yellow(`Bundle ${bundleIdx + 1} skipped (no valid returns)`));
      }

      if (bundleIdx < bundleBatches.length - 1) {
        await sleep(1500); // Rate limit protection
      }
    } catch (error: any) {
      failed++;
      bundleSpinner.fail(chalk.red(`Bundle ${bundleIdx + 1} error: ${error.message || error}`));
    }
  }

  console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════"));
  printSuccess("Return Complete!");
  console.log(
    chalk.gray("  •") +
    chalk.white(` Successful bundles: `) +
    chalk.green(`${successful}/${bundleBatches.length}`)
  );
  console.log(
    chalk.gray("  •") +
    chalk.white(` Total returned: `) +
    chalk.green(`${(totalReturned / LAMPORTS_PER_SOL).toFixed(6)} SOL`)
  );
  console.log(chalk.cyan.bold("  ══════════════════════════════════════════\n"));

  try {
    const newPayerBalance = await getBalanceWithRetry(connection, payerWallet.publicKey);
    printInfo("New payer balance", `${(newPayerBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  } catch {
    printInfo("New payer balance", "Unable to fetch");
  }

  await pressAnyKeyToContinue();
}

// ============ BUY TOKEN ============

export async function actionBuyToken(
  connection: Connection,
  _payerWallet: Keypair
): Promise<void> {
  if (CONFIG.NETWORK !== "mainnet-beta") {
    printError("Pump.fun trading only works on mainnet-beta!");
    printInfo("Current network", CONFIG.NETWORK);
    console.log(chalk.gray("\n  Set SOLANA_NETWORK=mainnet-beta in .env to enable trading.\n"));
    await pressAnyKeyToContinue();
    return;
  }

  const wallets = loadWalletsFromDir();

  if (!wallets || wallets.length === 0) {
    printError("No wallets found. Create wallets first!");
    await pressAnyKeyToContinue();
    return;
  }

  const tokenMint = await input({
    message: chalk.cyan("Enter pump.fun token mint address:"),
    default: "H2WrPJFJMG2ZgtaacdKYCVHG1UhapkP9DEhzxqiipump",
    validate: (value) => value.length > 30 ? true : "Invalid mint address",
  });

  const spinner = ora({
    text: chalk.cyan("Fetching token info..."),
    spinner: "dots",
  }).start();

  const tokenInfo = await fetchPumpTokenInfo(connection, tokenMint);

  if (!tokenInfo) {
    spinner.fail(chalk.red("Token not found on pump.fun"));
    await pressAnyKeyToContinue();
    return;
  }

  if (tokenInfo.graduated) {
    spinner.fail(chalk.red("Token has graduated from pump.fun"));
    await pressAnyKeyToContinue();
    return;
  }

  spinner.succeed(chalk.green("Token found!"));

  console.log(chalk.cyan.bold("\n  📊 Token Info\n"));
  printInfo("Mint", tokenMint.slice(0, 20) + "...");
  printInfo("Virtual SOL", `${(tokenInfo.virtualSolReserves.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  printInfo("Buy Amount", "92% of each wallet's SOL balance");

  const slippage = await number({
    message: chalk.cyan("Slippage %") + chalk.gray(" (default: 25)") + chalk.cyan(":"),
    default: 25,
    step: 1,
    validate: (value) => (value && value > 0 && value <= 100 ? true : "Must be 1-100"),
  }) || 25;

  const minDelaySeconds = await number({
    message: chalk.cyan("Min delay between bundles (seconds)") + chalk.gray(" (default: 0)") + chalk.cyan(":"),
    default: 0,
    step: 1,
    validate: (value) => (value !== undefined && value >= 0 ? true : "Must be >= 0"),
  }) ?? 0;

  const maxDelaySeconds = await number({
    message: chalk.cyan("Max delay between bundles (seconds)") + chalk.gray(" (default: 0)") + chalk.cyan(":"),
    default: 0,
    step: 1,
    validate: (value) => (value !== undefined && value >= minDelaySeconds ? true : "Must be >= min delay"),
  }) ?? 0;

  const shouldBuy = await confirm({
    message: chalk.yellow(
      `Buy with 92% of SOL balance from ${wallets.length} wallets?`
    ),
    default: true,
  });

  if (!shouldBuy) {
    console.log(chalk.gray("\n  Cancelled.\n"));
    await pressAnyKeyToContinue();
    return;
  }

  console.log(chalk.cyan.bold("\n  🛒 Executing Buy Orders\n"));

  const buySpinner = ora({
    text: chalk.cyan("Processing buy orders..."),
    spinner: "dots12",
  }).start();

  try {
    // Convert slippage % to basis points (1% = 100 bps)
    const slippageBps = slippage * 100;

    const result = await executeBuy(
      connection,
      wallets,
      tokenInfo.mint,
      slippageBps,
      {
        minDelayMs: minDelaySeconds * 1000,
        maxDelayMs: maxDelaySeconds * 1000,
        onProgress: (current, total, success, failed, lastTx) => {
          const delayInfo = maxDelaySeconds > 0 ? chalk.gray(` (delay: ${minDelaySeconds}-${maxDelaySeconds}s)`) : "";
          buySpinner.text = chalk.cyan(
            `Wallet ${current}/${total} | ✓ ${success} | ✗ ${failed}${delayInfo}`
          );
        },
      }
    );

    buySpinner.stop();

    console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════"));
    printSuccess("Buy Orders Complete!");
    console.log(
      chalk.gray("  •") +
      chalk.white(` Successful: `) +
      chalk.green(`${result.success}`)
    );
    console.log(
      chalk.gray("  •") +
      chalk.white(` Failed: `) +
      chalk.red(`${result.failed}`)
    );

    if (result.signatures && result.signatures.length > 0) {
      console.log(chalk.cyan.bold("\n  📜 Transaction Signatures:\n"));
      result.signatures.forEach((sig, idx) => {
        console.log(
          chalk.gray(`  TX ${idx + 1}: `) +
          chalk.cyan(getSolscanTxUrl(sig))
        );
      });
    }

    console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════\n"));
  } catch (error: any) {
    buySpinner.fail(chalk.red(`Buy failed: ${error.message}`));
  }

  await pressAnyKeyToContinue();
}

// ============ SELL TOKEN ============

export async function actionSellToken(
  connection: Connection,
  _payerWallet: Keypair
): Promise<void> {
  if (CONFIG.NETWORK !== "mainnet-beta") {
    printError("Pump.fun trading only works on mainnet-beta!");
    printInfo("Current network", CONFIG.NETWORK);
    console.log(chalk.gray("\n  Set SOLANA_NETWORK=mainnet-beta in .env to enable trading.\n"));
    await pressAnyKeyToContinue();
    return;
  }

  const wallets = loadWalletsFromDir();

  if (!wallets || wallets.length === 0) {
    printError("No wallets found. Create wallets first!");
    await pressAnyKeyToContinue();
    return;
  }

  const tokenMint = await input({
    message: chalk.cyan("Enter pump.fun token mint address:"),
    default: "H2WrPJFJMG2ZgtaacdKYCVHG1UhapkP9DEhzxqiipump",
    validate: (value) => value.length > 30 ? true : "Invalid mint address",
  });

  const spinner = ora({
    text: chalk.cyan("Fetching token info and balances..."),
    spinner: "dots",
  }).start();

  const tokenInfo = await fetchPumpTokenInfo(connection, tokenMint);

  if (!tokenInfo) {
    spinner.fail(chalk.red("Token not found on pump.fun"));
    await pressAnyKeyToContinue();
    return;
  }

  if (tokenInfo.graduated) {
    spinner.fail(chalk.red("Token has graduated from pump.fun"));
    await pressAnyKeyToContinue();
    return;
  }

  const balances = await getTokenBalances(
    connection,
    wallets,
    tokenInfo.mint
  );

  spinner.stop();

  const walletsWithTokens = balances.filter((b) => b.balance.gt(new BN(0)));

  if (walletsWithTokens.length === 0) {
    printWarning("No wallets hold this token.");
    await pressAnyKeyToContinue();
    return;
  }

  const totalTokens = walletsWithTokens.reduce(
    (sum, w) => sum.add(w.balance),
    new BN(0)
  );

  console.log(chalk.cyan.bold("\n  📊 Token Holdings\n"));
  printInfo("Wallets with tokens", `${walletsWithTokens.length}`);
  printInfo("Total tokens", totalTokens.toString());

  const sellOption = await select<number | string>({
    message: chalk.cyan("How much to sell?"),
    choices: [
      { name: chalk.white("100% - Sell all"), value: 100 },
      { name: chalk.white("75%"), value: 75 },
      { name: chalk.white("50%"), value: 50 },
      { name: chalk.white("25%"), value: 25 },
      { name: chalk.white("Custom percentage"), value: "custom" },
    ],
  });

  let sellPercentage: number = typeof sellOption === "number" ? sellOption : 50;

  if (sellOption === "custom") {
    const customPercent = await number({
      message: chalk.cyan("Enter percentage") + chalk.gray(" (default: 50)") + chalk.cyan(":"),
      default: 50,
      step: 1,
      validate: (value) => (value && value > 0 && value <= 100 ? true : "Must be 1-100"),
    });
    sellPercentage = customPercent || 50;
  }

  const slippage = await number({
    message: chalk.cyan("Slippage %") + chalk.gray(" (default: 25)") + chalk.cyan(":"),
    default: 25,
    step: 1,
    validate: (value) => (value && value > 0 && value <= 100 ? true : "Must be 1-100"),
  }) || 25;

  const shouldSell = await confirm({
    message: chalk.yellow(
      `Sell ${sellPercentage}% of tokens from ${walletsWithTokens.length} wallets?`
    ),
    default: true,
  });

  if (!shouldSell) {
    console.log(chalk.gray("\n  Cancelled.\n"));
    await pressAnyKeyToContinue();
    return;
  }

  console.log(chalk.cyan.bold("\n  💰 Executing Sell Orders\n"));

  const sellSpinner = ora({
    text: chalk.cyan("Processing sell orders..."),
    spinner: "dots12",
  }).start();

  try {
    // Convert slippage % to basis points (1% = 100 bps)
    const slippageBps = slippage * 100;

    const result = await executeSell(
      connection,
      walletsWithTokens,
      tokenInfo.mint,
      sellPercentage,
      slippageBps,
      (current, total, success, failed, lastTx) => {
        sellSpinner.text = chalk.cyan(
          `Wallet ${current}/${total} | ✓ ${success} | ✗ ${failed}`
        );
      }
    );

    sellSpinner.stop();

    console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════"));
    printSuccess("Sell Orders Complete!");
    console.log(
      chalk.gray("  •") +
      chalk.white(` Successful: `) +
      chalk.green(`${result.success}`)
    );
    console.log(
      chalk.gray("  •") +
      chalk.white(` Failed: `) +
      chalk.red(`${result.failed}`)
    );

    if (result.signatures && result.signatures.length > 0) {
      console.log(chalk.cyan.bold("\n  📜 Transaction Signatures:\n"));
      result.signatures.forEach((sig, idx) => {
        console.log(
          chalk.gray(`  TX ${idx + 1}: `) +
          chalk.cyan(getSolscanTxUrl(sig))
        );
      });
    }

    console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════\n"));
  } catch (error: any) {
    sellSpinner.fail(chalk.red(`Sell failed: ${error.message}`));
  }

  await pressAnyKeyToContinue();
}

// ============ TRANSFER TOKENS TO PAYER ============

export async function actionTransferTokensToPayer(
  connection: Connection,
  payerWallet: Keypair
): Promise<void> {
  const wallets = loadWalletsFromDir();

  if (!wallets || wallets.length === 0) {
    printError("No wallets found. Create wallets first!");
    await pressAnyKeyToContinue();
    return;
  }

  console.log(chalk.cyan.bold("\n  📤 Transfer All Tokens to Payer Wallet\n"));

  const spinner = ora({
    text: chalk.cyan(`Scanning ${wallets.length} wallets for token holdings...`),
    spinner: "dots12",
  }).start();

  try {
    const holdings = await getAllWalletTokenHoldings(connection, wallets);
    const aggregated = aggregateTokenHoldings(holdings);

    spinner.stop();

    if (aggregated.length === 0) {
      printWarning("No tokens found in any wallet.");
      await pressAnyKeyToContinue();
      return;
    }

    const walletsWithTokens = holdings.filter((h) => h.tokens.length > 0).length;

    console.log(chalk.cyan.bold("  ══════════════════════════════════════════════════════════════\n"));
    console.log(
      chalk.gray("  ") +
      chalk.white.bold("Token Mint".padEnd(46)) +
      chalk.white.bold("Total Balance".padStart(20))
    );
    console.log(chalk.cyan.bold("  ──────────────────────────────────────────────────────────────\n"));

    for (const token of aggregated) {
      const mintDisplay = token.mint.slice(0, 20) + "..." + token.mint.slice(-8);
      const balanceDisplay = token.totalUiBalance.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      });

      console.log(
        chalk.gray("  ") +
        chalk.cyan(mintDisplay.padEnd(46)) +
        chalk.green(balanceDisplay.padStart(20))
      );
    }

    console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════════════════════════\n"));

    printInfo("Unique tokens", `${aggregated.length}`);
    printInfo("Wallets with tokens", `${walletsWithTokens}`);
    printInfo("Destination", payerWallet.publicKey.toBase58().slice(0, 20) + "...");

    const shouldTransfer = await confirm({
      message: chalk.yellow(
        `Transfer all ${aggregated.length} token(s) from ${walletsWithTokens} wallets to payer?`
      ),
      default: true,
    });

    if (!shouldTransfer) {
      console.log(chalk.gray("\n  Cancelled.\n"));
      await pressAnyKeyToContinue();
      return;
    }

    console.log(chalk.cyan.bold("\n  🚀 Transferring Tokens\n"));

    const transferSpinner = ora({
      text: chalk.cyan("Preparing transfers..."),
      spinner: "dots12",
    }).start();

    const result = await transferAllTokensToWallet(
      connection,
      wallets,
      payerWallet.publicKey,
      (current, total, message) => {
        transferSpinner.text = chalk.cyan(`[${current}%] ${message}`);
      },
      payerWallet // Use payer wallet to pay for fees
    );

    transferSpinner.stop();

    console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════"));
    printSuccess("Token Transfer Complete!");
    console.log(
      chalk.gray("  •") +
      chalk.white(` Successful transfers: `) +
      chalk.green(`${result.success}`)
    );
    console.log(
      chalk.gray("  •") +
      chalk.white(` Failed transfers: `) +
      chalk.red(`${result.failed}`)
    );

    if (result.tokensTransferred.length > 0) {
      console.log(chalk.cyan.bold("\n  📜 Tokens Transferred:\n"));

      // Group by mint
      const mintTotals = new Map<string, BN>();
      for (const { mint, amount } of result.tokensTransferred) {
        const existing = mintTotals.get(mint) || new BN(0);
        mintTotals.set(mint, existing.add(amount));
      }

      for (const [mint, amount] of mintTotals) {
        console.log(
          chalk.gray("  ") +
          chalk.cyan(mint.slice(0, 16) + "...") +
          chalk.white(" → ") +
          chalk.green(amount.toString())
        );
      }
    }

    if (result.signatures && result.signatures.length > 0) {
      console.log(chalk.cyan.bold("\n  📜 Transaction Signatures:\n"));
      result.signatures.slice(0, 10).forEach((sig, idx) => {
        console.log(
          chalk.gray(`  TX ${idx + 1}: `) +
          chalk.cyan(getSolscanTxUrl(sig))
        );
      });
      if (result.signatures.length > 10) {
        console.log(chalk.gray(`  ... and ${result.signatures.length - 10} more`));
      }
    }

    console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════\n"));
  } catch (error: any) {
    spinner.stop();
    printError(`Transfer failed: ${error.message}`);
  }

  await pressAnyKeyToContinue();
}

// ============ QUICK BUY TOKEN ============

export async function actionQuickBuyToken(
  connection: Connection,
  _payerWallet: Keypair
): Promise<void> {
  if (CONFIG.NETWORK !== "mainnet-beta") {
    printError("Pump.fun trading only works on mainnet-beta!");
    printInfo("Current network", CONFIG.NETWORK);
    console.log(chalk.gray("\n  Set SOLANA_NETWORK=mainnet-beta in .env to enable trading.\n"));
    await pressAnyKeyToContinue();
    return;
  }

  const wallets = loadWalletsFromDir();

  if (!wallets || wallets.length === 0) {
    printError("No wallets found. Create wallets first!");
    await pressAnyKeyToContinue();
    return;
  }

  console.log(chalk.cyan.bold("\n  🚀 Quick Buy - " + QUICK_TRADE_TOKEN.slice(0, 12) + "...\n"));

  const spinner = ora({
    text: chalk.cyan("Fetching token info..."),
    spinner: "dots",
  }).start();

  const tokenInfo = await fetchPumpTokenInfo(connection, QUICK_TRADE_TOKEN);

  if (!tokenInfo) {
    spinner.fail(chalk.red("Token not found on pump.fun"));
    await pressAnyKeyToContinue();
    return;
  }

  if (tokenInfo.graduated) {
    spinner.fail(chalk.red("Token has graduated from pump.fun"));
    await pressAnyKeyToContinue();
    return;
  }

  spinner.succeed(chalk.green("Token found!"));

  console.log(chalk.cyan.bold("\n  📊 Token Info\n"));
  printInfo("Mint", QUICK_TRADE_TOKEN.slice(0, 20) + "...");
  printInfo("Virtual SOL", `${(tokenInfo.virtualSolReserves.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  printInfo("Buy Amount", "92% of each wallet's SOL balance");

  const slippage = await number({
    message: chalk.cyan("Slippage %") + chalk.gray(" (default: 25)") + chalk.cyan(":"),
    default: 25,
    step: 1,
    validate: (value) => (value && value > 0 && value <= 100 ? true : "Must be 1-100"),
  }) || 25;

  const minDelaySeconds = await number({
    message: chalk.cyan("Min delay between bundles (seconds)") + chalk.gray(" (default: 0)") + chalk.cyan(":"),
    default: 0,
    step: 1,
    validate: (value) => (value !== undefined && value >= 0 ? true : "Must be >= 0"),
  }) ?? 0;

  const maxDelaySeconds = await number({
    message: chalk.cyan("Max delay between bundles (seconds)") + chalk.gray(" (default: 0)") + chalk.cyan(":"),
    default: 0,
    step: 1,
    validate: (value) => (value !== undefined && value >= minDelaySeconds ? true : "Must be >= min delay"),
  }) ?? 0;

  const shouldBuy = await confirm({
    message: chalk.yellow(
      `Buy with 92% of SOL balance from ${wallets.length} wallets?`
    ),
    default: true,
  });

  if (!shouldBuy) {
    console.log(chalk.gray("\n  Cancelled.\n"));
    await pressAnyKeyToContinue();
    return;
  }

  console.log(chalk.cyan.bold("\n  🛒 Executing Buy Orders\n"));

  const buySpinner = ora({
    text: chalk.cyan("Processing buy orders..."),
    spinner: "dots12",
  }).start();

  try {
    const slippageBps = slippage * 100;

    const result = await executeBuy(
      connection,
      wallets,
      tokenInfo.mint,
      slippageBps,
      {
        minDelayMs: minDelaySeconds * 1000,
        maxDelayMs: maxDelaySeconds * 1000,
        onProgress: (current, total, success, failed, lastTx) => {
          const delayInfo = maxDelaySeconds > 0 ? chalk.gray(` (delay: ${minDelaySeconds}-${maxDelaySeconds}s)`) : "";
          buySpinner.text = chalk.cyan(
            `Wallet ${current}/${total} | ✓ ${success} | ✗ ${failed}${delayInfo}`
          );
        },
      }
    );

    buySpinner.stop();

    console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════"));
    printSuccess("Buy Orders Complete!");
    console.log(
      chalk.gray("  •") +
      chalk.white(` Successful: `) +
      chalk.green(`${result.success}`)
    );
    console.log(
      chalk.gray("  •") +
      chalk.white(` Failed: `) +
      chalk.red(`${result.failed}`)
    );

    if (result.signatures && result.signatures.length > 0) {
      console.log(chalk.cyan.bold("\n  📜 Transaction Signatures:\n"));
      result.signatures.forEach((sig, idx) => {
        console.log(
          chalk.gray(`  TX ${idx + 1}: `) +
          chalk.cyan(getSolscanTxUrl(sig))
        );
      });
    }

    console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════\n"));
  } catch (error: any) {
    buySpinner.fail(chalk.red(`Buy failed: ${error.message}`));
  }

  await pressAnyKeyToContinue();
}

// ============ QUICK SELL TOKEN ============

export async function actionQuickSellToken(
  connection: Connection,
  _payerWallet: Keypair
): Promise<void> {
  if (CONFIG.NETWORK !== "mainnet-beta") {
    printError("Pump.fun trading only works on mainnet-beta!");
    printInfo("Current network", CONFIG.NETWORK);
    console.log(chalk.gray("\n  Set SOLANA_NETWORK=mainnet-beta in .env to enable trading.\n"));
    await pressAnyKeyToContinue();
    return;
  }

  const wallets = loadWalletsFromDir();

  if (!wallets || wallets.length === 0) {
    printError("No wallets found. Create wallets first!");
    await pressAnyKeyToContinue();
    return;
  }

  console.log(chalk.cyan.bold("\n  💰 Quick Sell - " + QUICK_TRADE_TOKEN.slice(0, 12) + "...\n"));

  const spinner = ora({
    text: chalk.cyan("Fetching token info and balances..."),
    spinner: "dots",
  }).start();

  const tokenInfo = await fetchPumpTokenInfo(connection, QUICK_TRADE_TOKEN);

  if (!tokenInfo) {
    spinner.fail(chalk.red("Token not found on pump.fun"));
    await pressAnyKeyToContinue();
    return;
  }

  if (tokenInfo.graduated) {
    spinner.fail(chalk.red("Token has graduated from pump.fun"));
    await pressAnyKeyToContinue();
    return;
  }

  const balances = await getTokenBalances(
    connection,
    wallets,
    tokenInfo.mint
  );

  spinner.stop();

  const walletsWithTokens = balances.filter((b) => b.balance.gt(new BN(0)));

  if (walletsWithTokens.length === 0) {
    printWarning("No wallets hold this token.");
    await pressAnyKeyToContinue();
    return;
  }

  const totalTokens = walletsWithTokens.reduce(
    (sum, w) => sum.add(w.balance),
    new BN(0)
  );

  console.log(chalk.cyan.bold("\n  📊 Token Holdings\n"));
  printInfo("Token", QUICK_TRADE_TOKEN.slice(0, 20) + "...");
  printInfo("Wallets with tokens", `${walletsWithTokens.length}`);
  printInfo("Total tokens", totalTokens.toString());

  const sellOption = await select<number | string>({
    message: chalk.cyan("How much to sell?"),
    choices: [
      { name: chalk.white("100% - Sell all"), value: 100 },
      { name: chalk.white("75%"), value: 75 },
      { name: chalk.white("50%"), value: 50 },
      { name: chalk.white("25%"), value: 25 },
      { name: chalk.white("Custom percentage"), value: "custom" },
    ],
  });

  let sellPercentage: number = typeof sellOption === "number" ? sellOption : 50;

  if (sellOption === "custom") {
    const customPercent = await number({
      message: chalk.cyan("Enter percentage") + chalk.gray(" (default: 50)") + chalk.cyan(":"),
      default: 50,
      step: 1,
      validate: (value) => (value && value > 0 && value <= 100 ? true : "Must be 1-100"),
    });
    sellPercentage = customPercent || 50;
  }

  const slippage = await number({
    message: chalk.cyan("Slippage %") + chalk.gray(" (default: 25)") + chalk.cyan(":"),
    default: 25,
    step: 1,
    validate: (value) => (value && value > 0 && value <= 100 ? true : "Must be 1-100"),
  }) || 25;

  const shouldSell = await confirm({
    message: chalk.yellow(
      `Sell ${sellPercentage}% of tokens from ${walletsWithTokens.length} wallets?`
    ),
    default: true,
  });

  if (!shouldSell) {
    console.log(chalk.gray("\n  Cancelled.\n"));
    await pressAnyKeyToContinue();
    return;
  }

  console.log(chalk.cyan.bold("\n  💰 Executing Sell Orders\n"));

  const sellSpinner = ora({
    text: chalk.cyan("Processing sell orders..."),
    spinner: "dots12",
  }).start();

  try {
    const slippageBps = slippage * 100;

    const result = await executeSell(
      connection,
      walletsWithTokens,
      tokenInfo.mint,
      sellPercentage,
      slippageBps,
      (current, total, success, failed, lastTx) => {
        sellSpinner.text = chalk.cyan(
          `Wallet ${current}/${total} | ✓ ${success} | ✗ ${failed}`
        );
      }
    );

    sellSpinner.stop();

    console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════"));
    printSuccess("Sell Orders Complete!");
    console.log(
      chalk.gray("  •") +
      chalk.white(` Successful: `) +
      chalk.green(`${result.success}`)
    );
    console.log(
      chalk.gray("  •") +
      chalk.white(` Failed: `) +
      chalk.red(`${result.failed}`)
    );

    if (result.signatures && result.signatures.length > 0) {
      console.log(chalk.cyan.bold("\n  📜 Transaction Signatures:\n"));
      result.signatures.forEach((sig, idx) => {
        console.log(
          chalk.gray(`  TX ${idx + 1}: `) +
          chalk.cyan(getSolscanTxUrl(sig))
        );
      });
    }

    console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════\n"));
  } catch (error: any) {
    sellSpinner.fail(chalk.red(`Sell failed: ${error.message}`));
  }

  await pressAnyKeyToContinue();
}

// ============ SHOW HELP ============

export async function actionShowHelp(): Promise<void> {
  console.log(chalk.cyan.bold("\n  ╔═══════════════════════════════════════════════════════╗"));
  console.log(chalk.cyan.bold("  ║") + chalk.yellow.bold("              📚 HELP & INSTRUCTIONS                   ") + chalk.cyan.bold("║"));
  console.log(chalk.cyan.bold("  ╚═══════════════════════════════════════════════════════╝\n"));

  console.log(chalk.white.bold("  🔄 RECOMMENDED WORKFLOW\n"));
  console.log(chalk.cyan("  Step 1: ") + chalk.white("Create Wallets"));
  console.log(chalk.gray("          Generate the wallets that will hold tokens.\n"));

  console.log(chalk.cyan("  Step 2: ") + chalk.white("Create Lookup Table") + chalk.magenta(" (Optional but recommended)"));
  console.log(chalk.gray("          Reduces transaction costs by ~60% and increases speed 2.5x.\n"));

  console.log(chalk.cyan("  Step 3: ") + chalk.white("Fund Wallets"));
  console.log(chalk.gray("          Distribute SOL to wallets for trading fees.\n"));

  console.log(chalk.cyan("  Step 4: ") + chalk.white("Buy Token") + chalk.magenta(" (Mainnet only)"));
  console.log(chalk.gray("          Purchase pump.fun tokens with all wallets.\n"));

  console.log(chalk.cyan("  Step 5: ") + chalk.white("Sell Token") + chalk.magenta(" (Mainnet only)"));
  console.log(chalk.gray("          Sell tokens (100%, 75%, 50%, 25% or custom).\n"));

  console.log(chalk.cyan("  Step 6: ") + chalk.white("Return SOL to Payer"));
  console.log(chalk.gray("          Collect remaining SOL back to your main wallet.\n"));

  console.log(chalk.white.bold("  ⚡ KEY FEATURES\n"));
  console.log(chalk.gray("  •") + chalk.white(" Jito Bundles: ") + chalk.green("MEV protection & fast execution"));
  console.log(chalk.gray("  •") + chalk.white(" Lookup Tables: ") + chalk.green("Cheaper & faster transactions"));
  console.log(chalk.gray("  •") + chalk.white(" Batch Operations: ") + chalk.green("Process 100 wallets efficiently"));
  console.log(chalk.gray("  •") + chalk.white(" Real-time Tips: ") + chalk.green("Dynamic Jito tip optimization"));
  console.log(chalk.gray("  •") + chalk.white(" Graceful Shutdown: ") + chalk.green("Ctrl+C safely stops operations\n"));

  console.log(chalk.white.bold("  🌐 NETWORK CONFIGURATION\n"));
  console.log(chalk.gray("  Set in src/.env:"));
  console.log(chalk.white("  • ") + chalk.cyan("SOLANA_NETWORK=mainnet-beta") + chalk.gray(" → Real trading on pump.fun"));
  console.log(chalk.white("  • ") + chalk.cyan("SOLANA_NETWORK=testnet") + chalk.gray("      → Testing without real funds"));
  console.log(chalk.white("  • ") + chalk.cyan("SOLANA_NETWORK=devnet") + chalk.gray("       → Development testing\n"));

  console.log(chalk.gray("  Note: Pump.fun trading ONLY works on mainnet-beta.\n"));

  console.log(chalk.white.bold("  💡 PRO TIPS\n"));
  console.log(chalk.gray("  1. ") + chalk.white("Always create a Lookup Table for best performance."));
  console.log(chalk.gray("  2. ") + chalk.white("Use a private RPC (Helius, QuickNode) for mainnet."));
  console.log(chalk.gray("  3. ") + chalk.white("Fund wallets with slightly more SOL than needed."));
  console.log(chalk.gray("  4. ") + chalk.white("Check balances before trading to ensure funding."));
  console.log(chalk.gray("  5. ") + chalk.white("Keep your .env and wallets/ folder secure!\n"));

  console.log(chalk.red.bold("  ⚠️  SECURITY WARNING\n"));
  console.log(chalk.yellow("  • Never share your .env file or private keys"));
  console.log(chalk.yellow("  • The wallets/ folder contains private keys - back it up securely"));
  console.log(chalk.yellow("  • Only use funds you can afford to lose"));
  console.log(chalk.yellow("  • This software is provided as-is without warranty\n"));

  await pressAnyKeyToContinue();
}

// ============ BUY TOKEN (SWAP) ============

export async function actionBuyTokenSwap(
  connection: Connection,
  _payerWallet: Keypair
): Promise<void> {
  if (CONFIG.NETWORK !== "mainnet-beta") {
    printError("Pump.fun trading only works on mainnet-beta!");
    printInfo("Current network", CONFIG.NETWORK);
    console.log(chalk.gray("\n  Set SOLANA_NETWORK=mainnet-beta in .env to enable trading.\n"));
    await pressAnyKeyToContinue();
    return;
  }

  const wallets = loadWalletsFromDir();

  if (!wallets || wallets.length === 0) {
    printError("No wallets found. Create wallets first!");
    await pressAnyKeyToContinue();
    return;
  }

  console.log(chalk.cyan.bold("\n  🔄 Buy Token (via PumpSwap)\n"));

  const tokenMint = await input({
    message: chalk.cyan("Enter pump.fun token mint address:"),
    default: "H2WrPJFJMG2ZgtaacdKYCVHG1UhapkP9DEhzxqiipump",
    validate: (value) => value.length > 30 ? true : "Invalid mint address",
  });

  const spinner = ora({
    text: chalk.cyan("Fetching token info..."),
    spinner: "dots",
  }).start();

  const tokenInfo = await fetchPumpTokenInfo(connection, tokenMint);

  if (!tokenInfo) {
    spinner.fail(chalk.red("Token not found on pump.fun"));
    await pressAnyKeyToContinue();
    return;
  }

  spinner.succeed(chalk.green("Token found!"));

  console.log(chalk.cyan.bold("\n  📊 Token Info\n"));
  printInfo("Mint", tokenMint.slice(0, 20) + "...");
  printInfo("Virtual SOL", `${(tokenInfo.virtualSolReserves.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const minSolAmount = await number({
    message: chalk.cyan("Min buy amount per wallet (SOL):"),
    default: 0.001,
    step: 0.0001,
    validate: (value) => (value && value > 0 ? true : "Must be > 0"),
  }) || 0.001;

  const maxSolAmount = await number({
    message: chalk.cyan("Max buy amount per wallet (SOL):"),
    default: 0.003,
    step: 0.0001,
    validate: (value) => (value && value >= minSolAmount ? true : `Must be >= ${minSolAmount}`),
  }) || 0.003;

  printInfo("Buy Amount", `random ${minSolAmount}-${maxSolAmount} SOL per wallet`);

  const slippage = await number({
    message: chalk.cyan("Slippage %") + chalk.gray(" (default: 25)") + chalk.cyan(":"),
    default: 25,
    step: 1,
    validate: (value) => (value && value > 0 && value <= 100 ? true : "Must be 1-100"),
  }) || 25;

  const minDelaySeconds = await number({
    message: chalk.cyan("Min delay between bundles (seconds)") + chalk.gray(" (default: 0)") + chalk.cyan(":"),
    default: 0,
    step: 1,
    validate: (value) => (value !== undefined && value >= 0 ? true : "Must be >= 0"),
  }) ?? 0;

  const maxDelaySeconds = await number({
    message: chalk.cyan("Max delay between bundles (seconds)") + chalk.gray(" (default: 0)") + chalk.cyan(":"),
    default: 0,
    step: 1,
    validate: (value) => (value !== undefined && value >= minDelaySeconds ? true : "Must be >= min delay"),
  }) ?? 0;

  const shouldBuy = await confirm({
    message: chalk.yellow(
      `Swap Buy ${minSolAmount}-${maxSolAmount} SOL per wallet from ${wallets.length} wallets?`
    ),
    default: true,
  });

  if (!shouldBuy) {
    console.log(chalk.gray("\n  Cancelled.\n"));
    await pressAnyKeyToContinue();
    return;
  }

  console.log(chalk.cyan.bold("\n  🛒 Executing Swap Buy Orders\n"));

  const buySpinner = ora({
    text: chalk.cyan("Processing swap buy orders..."),
    spinner: "dots12",
  }).start();

  try {
    const slippageBps = slippage * 100;

    const result = await executeSwapBuy(
      connection,
      wallets,
      tokenInfo.mint,
      slippageBps,
      {
        minDelayMs: minDelaySeconds * 1000,
        maxDelayMs: maxDelaySeconds * 1000,
        minSolAmount,
        maxSolAmount,
        onProgress: (current, total, success, failed, lastTx) => {
          const delayInfo = maxDelaySeconds > 0 ? chalk.gray(` (delay: ${minDelaySeconds}-${maxDelaySeconds}s)`) : "";
          buySpinner.text = chalk.cyan(
            `Wallet ${current}/${total} | ✓ ${success} | ✗ ${failed}${delayInfo}`
          );
        },
      }
    );

    buySpinner.stop();

    console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════"));
    printSuccess("Swap Buy Orders Complete!");
    console.log(
      chalk.gray("  •") +
      chalk.white(` Successful: `) +
      chalk.green(`${result.success}`)
    );
    console.log(
      chalk.gray("  •") +
      chalk.white(` Failed: `) +
      chalk.red(`${result.failed}`)
    );

    if (result.signatures && result.signatures.length > 0) {
      console.log(chalk.cyan.bold("\n  📜 Transaction Signatures:\n"));
      result.signatures.forEach((sig, idx) => {
        console.log(
          chalk.gray(`  TX ${idx + 1}: `) +
          chalk.cyan(getSolscanTxUrl(sig))
        );
      });
    }

    console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════\n"));
  } catch (error: any) {
    buySpinner.fail(chalk.red(`Swap Buy failed: ${error.message}`));
  }

  await pressAnyKeyToContinue();
}

// ============ SELL TOKEN (SWAP) ============

export async function actionSellTokenSwap(
  connection: Connection,
  _payerWallet: Keypair
): Promise<void> {
  if (CONFIG.NETWORK !== "mainnet-beta") {
    printError("Pump.fun trading only works on mainnet-beta!");
    printInfo("Current network", CONFIG.NETWORK);
    console.log(chalk.gray("\n  Set SOLANA_NETWORK=mainnet-beta in .env to enable trading.\n"));
    await pressAnyKeyToContinue();
    return;
  }

  const wallets = loadWalletsFromDir();

  if (!wallets || wallets.length === 0) {
    printError("No wallets found. Create wallets first!");
    await pressAnyKeyToContinue();
    return;
  }

  console.log(chalk.cyan.bold("\n  🔄 Sell Token (via PumpSwap)\n"));

  const tokenMint = await input({
    message: chalk.cyan("Enter pump.fun token mint address:"),
    default: "H2WrPJFJMG2ZgtaacdKYCVHG1UhapkP9DEhzxqiipump",
    validate: (value) => value.length > 30 ? true : "Invalid mint address",
  });

  const spinner = ora({
    text: chalk.cyan("Fetching token info and balances..."),
    spinner: "dots",
  }).start();

  const tokenInfo = await fetchPumpTokenInfo(connection, tokenMint);

  if (!tokenInfo) {
    spinner.fail(chalk.red("Token not found on pump.fun"));
    await pressAnyKeyToContinue();
    return;
  }

  const balances = await getTokenBalances(
    connection,
    wallets,
    tokenInfo.mint
  );

  spinner.stop();

  const walletsWithTokens = balances.filter((b) => b.balance.gt(new BN(0)));

  if (walletsWithTokens.length === 0) {
    printWarning("No wallets hold this token.");
    await pressAnyKeyToContinue();
    return;
  }

  const totalTokens = walletsWithTokens.reduce(
    (sum, w) => sum.add(w.balance),
    new BN(0)
  );

  console.log(chalk.cyan.bold("\n  📊 Token Holdings\n"));
  printInfo("Wallets with tokens", `${walletsWithTokens.length}`);
  printInfo("Total tokens", totalTokens.toString());

  const sellOption = await select<number | string>({
    message: chalk.cyan("How much to sell?"),
    choices: [
      { name: chalk.white("100% - Sell all"), value: 100 },
      { name: chalk.white("75%"), value: 75 },
      { name: chalk.white("50%"), value: 50 },
      { name: chalk.white("25%"), value: 25 },
      { name: chalk.white("Custom percentage"), value: "custom" },
    ],
  });

  let sellPercentage: number = typeof sellOption === "number" ? sellOption : 50;

  if (sellOption === "custom") {
    const customPercent = await number({
      message: chalk.cyan("Enter percentage") + chalk.gray(" (default: 50)") + chalk.cyan(":"),
      default: 50,
      step: 1,
      validate: (value) => (value && value > 0 && value <= 100 ? true : "Must be 1-100"),
    });
    sellPercentage = customPercent || 50;
  }

  const slippage = await number({
    message: chalk.cyan("Slippage %") + chalk.gray(" (default: 25)") + chalk.cyan(":"),
    default: 25,
    step: 1,
    validate: (value) => (value && value > 0 && value <= 100 ? true : "Must be 1-100"),
  }) || 25;

  const shouldSell = await confirm({
    message: chalk.yellow(
      `Swap Sell ${sellPercentage}% of tokens from ${walletsWithTokens.length} wallets?`
    ),
    default: true,
  });

  if (!shouldSell) {
    console.log(chalk.gray("\n  Cancelled.\n"));
    await pressAnyKeyToContinue();
    return;
  }

  console.log(chalk.cyan.bold("\n  💰 Executing Swap Sell Orders\n"));

  const sellSpinner = ora({
    text: chalk.cyan("Processing swap sell orders..."),
    spinner: "dots12",
  }).start();

  try {
    const slippageBps = slippage * 100;

    const result = await executeSwapSell(
      connection,
      walletsWithTokens,
      tokenInfo.mint,
      sellPercentage,
      slippageBps,
      (current, total, success, failed, lastTx) => {
        sellSpinner.text = chalk.cyan(
          `Wallet ${current}/${total} | ✓ ${success} | ✗ ${failed}`
        );
      }
    );

    sellSpinner.stop();

    console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════"));
    printSuccess("Swap Sell Orders Complete!");
    console.log(
      chalk.gray("  •") +
      chalk.white(` Successful: `) +
      chalk.green(`${result.success}`)
    );
    console.log(
      chalk.gray("  •") +
      chalk.white(` Failed: `) +
      chalk.red(`${result.failed}`)
    );

    if (result.signatures && result.signatures.length > 0) {
      console.log(chalk.cyan.bold("\n  📜 Transaction Signatures:\n"));
      result.signatures.forEach((sig, idx) => {
        console.log(
          chalk.gray(`  TX ${idx + 1}: `) +
          chalk.cyan(getSolscanTxUrl(sig))
        );
      });
    }

    console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════\n"));
  } catch (error: any) {
    sellSpinner.fail(chalk.red(`Swap Sell failed: ${error.message}`));
  }

  await pressAnyKeyToContinue();
}
