/**
 * Solana Pumpfun Bundler - Entry Point
 *
 * A production-ready CLI tool for batch wallet operations on Solana
 * with pump.fun trading support via Jito bundles.
 *
 * File Structure:
 * - index.ts    : Entry point (this file)
 * - config.ts   : Configuration and types
 * - utils.ts    : Helper functions
 * - wallet.ts   : Wallet management
 * - balance.ts  : Balance checking
 * - distribute.ts : SOL distribution
 * - actions.ts  : Menu action handlers
 * - menu.ts     : Main menu and dashboard
 * - jito.ts     : Jito bundle utilities
 * - pump.ts     : Pump.fun trading
 */

import { Connection } from "@solana/web3.js";
import chalk from "chalk";
import ora from "ora";

import { CONFIG } from "./config";
import { clearScreen, printHeader, printError, checkRpcHealth } from "./utils";
import { loadPayerWallet } from "./wallet";
import { showMainMenu, printDashboard } from "./menu";

// ============ GRACEFUL SHUTDOWN ============

let isShuttingDown = false;

function setupGracefulShutdown(): void {
  const shutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(chalk.yellow(`\n\n  ⚠️  Received ${signal}. Shutting down gracefully...`));
    console.log(chalk.gray("  Please wait for pending operations to complete.\n"));
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// ============ MAIN ============

async function main(): Promise<void> {
  setupGracefulShutdown();
  clearScreen();
  printHeader();

  const spinner = ora({
    text: chalk.cyan("Initializing..."),
    spinner: "dots12",
  }).start();

  const connection = new Connection(CONFIG.RPC_URL, "confirmed");

  try {
    const payerWallet = loadPayerWallet();

    // Validate connection with retries
    try {
      await checkRpcHealth(connection);
    } catch (error: any) {
      spinner.fail(chalk.red("Failed to connect to RPC"));
      printError(`Cannot connect to ${CONFIG.RPC_URL}`);
      console.log(chalk.gray(`\n  Error: ${error.message}`));
      console.log(chalk.gray("\n  💡 Tips:"));
      console.log(chalk.gray("     • Check your internet connection"));
      console.log(chalk.gray("     • Try a different RPC endpoint"));
      console.log(chalk.gray("     • Set MAINNET_RPC_URL in .env for custom RPC\n"));
      process.exit(1);
    }

    spinner.succeed(chalk.green("Initialization complete"));

    // Main loop
    let running = true;
    while (running) {
      clearScreen();
      printHeader();
      await printDashboard(connection, payerWallet);
      running = await showMainMenu(connection, payerWallet);
    }
  } catch (error: any) {
    spinner.fail(chalk.red("Initialization failed"));
    printError(error.message);

    if (error.message.includes("PAYER_PRIVATE")) {
      console.log(chalk.gray("\n  💡 Create src/.env with your payer private key:"));
      console.log(chalk.cyan("     PAYER_PRIVATE=your-base58-private-key\n"));
    }

    process.exit(1);
  }
}

// Run
main().catch((error) => {
  console.error(chalk.red("\n  Fatal error:"), error.message);
  process.exit(1);
});
