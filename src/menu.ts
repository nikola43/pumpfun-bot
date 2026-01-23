/**
 * Main menu and dashboard
 */
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import chalk from "chalk";
import { select, Separator } from "@inquirer/prompts";
import { CONFIG } from "./config";
import { getBalanceWithRetry } from "./utils";
import { loadWalletsFromDir, loadLUTInfo } from "./wallet";
import {
  actionShowHelp,
  actionCreateWallets,
  actionCreateLUT,
  actionFundWallets,
  actionCheckBalances,
  actionCheckTokenBalances,
  actionShowStatus,
  actionReturnSOL,
  actionBuyToken,
  actionSellToken,
  actionTransferTokensToPayer,
} from "./actions";

// ============ DASHBOARD ============

export async function printDashboard(
  connection: Connection,
  payerWallet: Keypair
): Promise<void> {
  console.log(chalk.cyan.bold("  ══════════════════════════════════════════════════════\n"));

  const boxWidth = 55;

  const formatRow = (label: string, value: string, valueColor: (s: string) => string = chalk.white): string => {
    const prefix = chalk.gray("  • ");
    const labelPart = chalk.white(`${label}: `);
    const valuePart = valueColor(value);
    const labelLen = label.length + 2;
    const valueLen = value.length;
    const padding = boxWidth - 4 - labelLen - valueLen;
    return prefix + labelPart + valuePart + " ".repeat(Math.max(0, padding));
  };

  console.log(formatRow("Network", CONFIG.NETWORK.toUpperCase(), chalk.magenta));

  const wallets = loadWalletsFromDir();
  const walletCount = wallets?.length || 0;
  console.log(formatRow("Wallets", `${walletCount}`, walletCount > 0 ? chalk.green : chalk.yellow));

  const lutInfo = loadLUTInfo();
  const lutStatus = lutInfo ? "Active ✓" : "Not created";
  console.log(formatRow("LUT", lutStatus, lutInfo ? chalk.green : chalk.yellow));

  console.log(formatRow("Payer", payerWallet.publicKey.toBase58().slice(0, 24) + "...", chalk.cyan));

  try {
    const balance = await getBalanceWithRetry(connection, payerWallet.publicKey);
    const balanceStr = `${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
    console.log(formatRow("Balance", balanceStr, chalk.green));
  } catch {
    console.log(formatRow("Balance", "Unable to fetch", chalk.yellow));
  }

  console.log(chalk.cyan.bold("\n  ══════════════════════════════════════════════════════\n"));
}

// ============ MAIN MENU ============

export async function showMainMenu(
  connection: Connection,
  payerWallet: Keypair
): Promise<boolean> {
  const wallets = loadWalletsFromDir();
  const walletCount = wallets?.length || 0;
  const walletStatus = walletCount > 0
    ? chalk.green(` (${walletCount})`)
    : chalk.yellow(" (none)");

  const lutInfo = loadLUTInfo();
  const lutStatus = lutInfo ? chalk.green(" ✓") : chalk.yellow(" (create for 2.5x speed)");

  const networkBadge = CONFIG.NETWORK === "mainnet-beta"
    ? chalk.green.bold(" [MAINNET]")
    : CONFIG.NETWORK === "testnet"
      ? chalk.yellow.bold(" [TESTNET]")
      : chalk.blue.bold(" [DEVNET]");

  const action = await select({
    message: chalk.cyan.bold("Select an action:") + networkBadge,
    choices: [
      {
        name: chalk.white("📚  Help & Instructions"),
        value: "help",
      },
      new Separator(chalk.gray(" ── Setup ──")),
      {
        name: chalk.white("🔑  Create Wallets") + walletStatus,
        value: "create",
      },
      {
        name: chalk.white("📋  Create Lookup Table") + lutStatus,
        value: "lut",
      },
      {
        name: chalk.white("💸  Fund Wallets"),
        value: "fund",
      },
      new Separator(chalk.gray(" ── Operations ──")),
      {
        name: chalk.white("📊  Check SOL Balances"),
        value: "check",
      },
      {
        name: chalk.white("🪙  Check Token Holdings"),
        value: "tokens",
      },
      {
        name: chalk.white("🔄  Return SOL to Payer"),
        value: "return",
      },
      {
        name: chalk.white("ℹ️   System Status"),
        value: "status",
      },
      new Separator(chalk.magenta(" ── Pump.fun Trading ──")),
      {
        name: chalk.green("🛒  Buy Token") + (CONFIG.NETWORK !== "mainnet-beta" ? chalk.gray(" (mainnet only)") : ""),
        value: "buy",
      },
      {
        name: chalk.red("💰  Sell Token") + (CONFIG.NETWORK !== "mainnet-beta" ? chalk.gray(" (mainnet only)") : ""),
        value: "sell",
      },
      {
        name: chalk.yellow("📤  Transfer Tokens to Payer"),
        value: "transfer_tokens",
      },
      new Separator(),
      {
        name: chalk.gray("👋  Exit"),
        value: "exit",
      },
    ],
    loop: false,
    pageSize: 15,
  });

  switch (action) {
    case "help":
      await actionShowHelp();
      break;
    case "create":
      await actionCreateWallets();
      break;
    case "lut":
      await actionCreateLUT(connection, payerWallet);
      break;
    case "fund":
      await actionFundWallets(connection, payerWallet);
      break;
    case "check":
      await actionCheckBalances(connection);
      break;
    case "tokens":
      await actionCheckTokenBalances(connection);
      break;
    case "return":
      await actionReturnSOL(connection, payerWallet);
      break;
    case "status":
      await actionShowStatus(connection);
      break;
    case "buy":
      await actionBuyToken(connection, payerWallet);
      break;
    case "sell":
      await actionSellToken(connection, payerWallet);
      break;
    case "transfer_tokens":
      await actionTransferTokensToPayer(connection, payerWallet);
      break;
    case "exit":
      console.log(chalk.cyan("\n  👋 Goodbye!\n"));
      return false;
  }

  return true;
}
