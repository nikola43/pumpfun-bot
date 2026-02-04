import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import * as spl from "@solana/spl-token";
import {
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import bs58 from "bs58";
import { getBalanceWithRetry, getBlockhashWithRetry } from "./utils";

// Import from official pump-fun SDK
import {
  OnlinePumpSdk,
  PUMP_SDK,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
} from "@pump-fun/pump-sdk";

// Import from local SDK for compatibility
import { DEFAULT_DECIMALS } from "./pumpdotfun-sdk/src/pumpfun";

// Priority fees for transactions
const PRIORITY_FEE = {
  unitLimit: 400000,
  unitPrice: 400000,
};

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get random delay between min and max
 */
function getRandomDelay(minMs: number, maxMs: number): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

/**
 * Send transaction via RPC and wait for confirmation
 * Returns signature if confirmed, null if failed
 */
async function sendTransactionWithConfirmation(
  connection: Connection,
  transaction: VersionedTransaction,
  blockhashInfo: { blockhash: string; lastValidBlockHeight: number },
  maxWaitMs: number = 30000
): Promise<{ success: boolean; signature: string; error?: string }> {
  const signature = bs58.encode(transaction.signatures[0]);

  try {
    await connection.sendTransaction(transaction, {
      skipPreflight: true,
      maxRetries: 3,
      preflightCommitment: "confirmed",
    });

    // Wait for confirmation
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      // Check if blockhash has expired
      try {
        const currentBlockHeight = await connection.getBlockHeight("confirmed");
        if (currentBlockHeight > blockhashInfo.lastValidBlockHeight) {
          return {
            success: false,
            signature,
            error: "Blockhash expired before confirmation",
          };
        }
      } catch {
        // If we can't get block height, fall through to status check
      }

      const statuses = await connection.getSignatureStatuses([signature]);
      const status = statuses.value[0];

      if (status !== null) {
        if (status.err) {
          return {
            success: false,
            signature,
            error: JSON.stringify(status.err),
          };
        }
        if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
          return { success: true, signature };
        }
      }

      await sleep(2000);
    }

    return {
      success: false,
      signature,
      error: "Confirmation timeout",
    };
  } catch (e) {
    return {
      success: false,
      signature,
      error: String(e),
    };
  }
}

/**
 * Token info from pump.fun
 */
export interface PumpTokenInfo {
  mint: PublicKey;
  exists: boolean;
  graduated: boolean;
  virtualSolReserves: BN;
  virtualTokenReserves: BN;
  realSolReserves: BN;
  realTokenReserves: BN;
}

/**
 * Fetch token info from pump.fun
 */
export async function fetchPumpTokenInfo(
  connection: Connection,
  mintAddress: string
): Promise<PumpTokenInfo | null> {
  try {
    const mint = new PublicKey(mintAddress);
    const sdk = new OnlinePumpSdk(connection);

    const bondingCurve = await sdk.fetchBondingCurve(mint);

    return {
      mint,
      exists: true,
      graduated: bondingCurve.complete,
      virtualSolReserves: bondingCurve.virtualSolReserves,
      virtualTokenReserves: bondingCurve.virtualTokenReserves,
      realSolReserves: bondingCurve.realSolReserves,
      realTokenReserves: bondingCurve.realTokenReserves,
    };
  } catch (e) {
    console.error("Error fetching token info:", e);
    return null;
  }
}

/**
 * Get token program for a mint
 */
async function getTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const mintInfo = await connection.getAccountInfo(mint);
  const isToken2022 = mintInfo?.owner.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58();
  return isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

/**
 * Get SPL token balance for a wallet
 */
export async function getTokenBalance(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey
): Promise<number> {
  try {
    const tokenProgram = await getTokenProgram(connection, mint);
    const ata = await getAssociatedTokenAddress(mint, owner, false, tokenProgram);
    const account = await getAccount(connection, ata, "confirmed", tokenProgram);
    return Number(account.amount) / Math.pow(10, DEFAULT_DECIMALS);
  } catch {
    return 0;
  }
}

/**
 * Get token balances for multiple wallets
 */
export async function getTokenBalances(
  connection: Connection,
  wallets: Keypair[],
  mint: PublicKey
): Promise<{ wallet: Keypair; balance: BN }[]> {
  const results: { wallet: Keypair; balance: BN }[] = [];
  const BATCH_SIZE = 10;

  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    const batch = wallets.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async (wallet) => {
        const balance = await getTokenBalance(connection, mint, wallet.publicKey);
        return {
          wallet,
          balance: new BN(Math.floor(balance * Math.pow(10, DEFAULT_DECIMALS))),
        };
      })
    );

    results.push(...batchResults);
  }

  return results;
}

/**
 * Buy options
 */
export interface BuyOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
  onProgress?: (current: number, total: number, success: number, failed: number, lastTx?: string) => void;
}

/**
 * Buy result
 */
export interface BuyResult {
  success: number;
  failed: number;
  signatures: string[];
}

/**
 * Simulate a transaction and return success/error
 */
async function simulateTransaction(
  connection: Connection,
  transaction: VersionedTransaction
): Promise<{ success: boolean; error?: string; logs?: string[] }> {
  try {
    const simulation = await connection.simulateTransaction(transaction, {
      commitment: "confirmed",
    });

    if (simulation.value.err) {
      return {
        success: false,
        error: JSON.stringify(simulation.value.err),
        logs: simulation.value.logs || undefined,
      };
    }

    return { success: true, logs: simulation.value.logs || undefined };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/**
 * Execute buy for multiple wallets
 * Each wallet sends its own independent transaction using 92% of SOL balance
 */
export async function executeBuy(
  connection: Connection,
  wallets: Keypair[],
  mint: PublicKey,
  slippageBps: number = 2500,
  options?: BuyOptions
): Promise<BuyResult> {
  // Initialize SDK
  const sdk = new OnlinePumpSdk(connection);

  // Get token program
  const tokenProgram = await getTokenProgram(connection, mint);

  // Fetch global state and fee config
  const global = await sdk.fetchGlobal();
  let feeConfig = null;
  try {
    feeConfig = await sdk.fetchFeeConfig();
  } catch {
    // Fee config not available
  }

  let success = 0;
  let failed = 0;
  const signatures: string[] = [];

  // Process each wallet individually - no connection between wallets
  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];

    try {
      const { blockhash, lastValidBlockHeight } = await getBlockhashWithRetry(connection);

      // Get wallet's SOL balance and use 92% for the buy
      const walletBalance = await getBalanceWithRetry(connection, wallet.publicKey);
      const solAmountLamports = Math.floor(walletBalance * 0.92);

      // Skip if wallet has insufficient balance (need some for fees)
      if (solAmountLamports <= 50000) {
        console.log(`Wallet ${wallet.publicKey.toBase58().slice(0, 8)}... has insufficient balance, skipping`);
        failed++;
        options?.onProgress?.(i + 1, wallets.length, success, failed);
        continue;
      }

      // Fetch buy state for this wallet
      const buyState = await sdk.fetchBuyState(mint, wallet.publicKey, tokenProgram);

      // Calculate token amount
      const solAmount = new BN(solAmountLamports);
      const tokenAmount = getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: global.tokenTotalSupply,
        bondingCurve: buyState.bondingCurve,
        amount: solAmount,
      });

      // Build buy instructions using SDK
      const buyInstructions = await PUMP_SDK.buyInstructions({
        global,
        bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
        bondingCurve: buyState.bondingCurve,
        associatedUserAccountInfo: buyState.associatedUserAccountInfo,
        mint,
        user: wallet.publicKey,
        amount: tokenAmount,
        solAmount,
        slippage: slippageBps / 10000,
        tokenProgram,
      });

      // Build instructions with priority fees only
      const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: PRIORITY_FEE.unitLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE.unitPrice }),
        ...buyInstructions,
      ];

      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([wallet]);

      // Simulate transaction before sending
      const simResult = await simulateTransaction(connection, transaction);
      if (!simResult.success) {
        console.error(`Simulation failed for wallet ${wallet.publicKey.toBase58().slice(0, 8)}:`, simResult.error);
        if (simResult.logs) {
          console.error("Simulation logs:", simResult.logs.slice(-5).join("\n"));
        }
        failed++;
        options?.onProgress?.(i + 1, wallets.length, success, failed);
        continue;
      }

      // Send transaction
      const result = await sendTransactionWithConfirmation(connection, transaction, { blockhash, lastValidBlockHeight }, 60000);

      if (result.success) {
        success++;
        signatures.push(result.signature);
      } else {
        console.error(`Transaction failed for wallet ${wallet.publicKey.toBase58().slice(0, 8)}:`, result.error);
        failed++;
      }

      options?.onProgress?.(i + 1, wallets.length, success, failed, result.signature);

      // Add delay between transactions if configured (default 250ms for 5 tx/sec rate limit)
      if (i < wallets.length - 1) {
        if (options?.minDelayMs && options?.maxDelayMs) {
          const delay = getRandomDelay(options.minDelayMs, options.maxDelayMs);
          await sleep(delay);
        } else {
          await sleep(250); // Default delay to respect 5 tx/sec rate limit
        }
      }
    } catch (e) {
      console.error(`Error processing wallet ${i}:`, e);
      failed++;
      options?.onProgress?.(i + 1, wallets.length, success, failed);
    }
  }

  return { success, failed, signatures };
}

/**
 * Sell result
 */
export interface SellResult {
  success: number;
  failed: number;
  signatures: string[];
  totalSold: BN;
}

/**
 * Execute sell for multiple wallets
 * Each wallet sends its own independent transaction
 */
export async function executeSell(
  connection: Connection,
  walletBalances: { wallet: Keypair; balance: BN }[],
  mint: PublicKey,
  sellPercentage: number,
  slippageBps: number = 2500,
  onProgress?: (current: number, total: number, success: number, failed: number, lastTx?: string) => void
): Promise<SellResult> {
  // Initialize SDK
  const sdk = new OnlinePumpSdk(connection);

  // Get token program
  const tokenProgram = await getTokenProgram(connection, mint);

  // Fetch global state and fee config
  const global = await sdk.fetchGlobal();
  let feeConfig = null;
  try {
    feeConfig = await sdk.fetchFeeConfig();
  } catch {
    // Fee config not available
  }

  // Filter wallets with balance
  const walletsToSell = walletBalances.filter((w) => w.balance.gt(new BN(0)));

  if (walletsToSell.length === 0) {
    return { success: 0, failed: 0, signatures: [], totalSold: new BN(0) };
  }

  let success = 0;
  let failed = 0;
  let totalSold = new BN(0);
  const signatures: string[] = [];

  // Process each wallet individually - no connection between wallets
  for (let i = 0; i < walletsToSell.length; i++) {
    const { wallet, balance } = walletsToSell[i];

    // Calculate sell amount based on percentage
    const sellAmount = balance.mul(new BN(sellPercentage)).div(new BN(100));

    if (sellAmount.lte(new BN(0))) {
      continue;
    }

    try {
      const { blockhash, lastValidBlockHeight } = await getBlockhashWithRetry(connection);

      // Check if wallet has enough SOL for transaction fees
      const walletSolBalance = await getBalanceWithRetry(connection, wallet.publicKey);
      if (walletSolBalance < 10000) {
        console.log(`Wallet ${wallet.publicKey.toBase58().slice(0, 8)}... has insufficient SOL for fees (${walletSolBalance} lamports), skipping`);
        failed++;
        onProgress?.(i + 1, walletsToSell.length, success, failed);
        continue;
      }

      // Fetch sell state for this wallet
      const sellState = await sdk.fetchSellState(mint, wallet.publicKey, tokenProgram);

      // Calculate min SOL output
      const solOutput = getSellSolAmountFromTokenAmount({
        global,
        feeConfig,
        mintSupply: global.tokenTotalSupply,
        bondingCurve: sellState.bondingCurve,
        amount: sellAmount,
      });

      // Build sell instructions using SDK
      const sellInstructions = await PUMP_SDK.sellInstructions({
        global,
        bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
        bondingCurve: sellState.bondingCurve,
        mint,
        user: wallet.publicKey,
        amount: sellAmount,
        solAmount: solOutput,
        slippage: slippageBps / 10000,
        tokenProgram,
        mayhemMode: sellState.bondingCurve.isMayhemMode || false,
      });

      // Build instructions with priority fees only
      const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: PRIORITY_FEE.unitLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE.unitPrice }),
        ...sellInstructions,
      ];

      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([wallet]);

      // Simulate transaction before sending
      const simResult = await simulateTransaction(connection, transaction);
      if (!simResult.success) {
        console.error(`Simulation failed for wallet ${wallet.publicKey.toBase58().slice(0, 8)}:`, simResult.error);
        if (simResult.logs) {
          console.error("Simulation logs:", simResult.logs.slice(-5).join("\n"));
        }
        failed++;
        onProgress?.(i + 1, walletsToSell.length, success, failed);
        continue;
      }

      // Send transaction
      const result = await sendTransactionWithConfirmation(connection, transaction, { blockhash, lastValidBlockHeight }, 60000);

      if (result.success) {
        success++;
        totalSold = totalSold.add(sellAmount);
        signatures.push(result.signature);
      } else {
        console.error(`Sell tx failed for wallet ${wallet.publicKey.toBase58().slice(0, 8)}:`, result.error);
        failed++;
      }

      onProgress?.(i + 1, walletsToSell.length, success, failed, result.signature);

      // Delay between transactions to respect 5 tx/sec rate limit
      if (i < walletsToSell.length - 1) {
        await sleep(250);
      }
    } catch (e) {
      console.error(`Error processing sell for wallet ${i}:`, e);
      failed++;
      onProgress?.(i + 1, walletsToSell.length, success, failed);
    }
  }

  return { success, failed, signatures, totalSold };
}

/**
 * Token account info
 */
export interface TokenAccountInfo {
  mint: string;
  balance: BN;
  decimals: number;
  uiBalance: number;
}

/**
 * Wallet token holdings
 */
export interface WalletTokenHoldings {
  wallet: Keypair;
  walletAddress: string;
  tokens: TokenAccountInfo[];
}

/**
 * Aggregated token info across all wallets
 */
export interface AggregatedTokenInfo {
  mint: string;
  totalBalance: BN;
  decimals: number;
  totalUiBalance: number;
  holdersCount: number;
  holders: { walletAddress: string; balance: BN; uiBalance: number }[];
}

/**
 * Get all token accounts for a single wallet
 */
export async function getWalletTokenAccounts(
  connection: Connection,
  wallet: PublicKey
): Promise<TokenAccountInfo[]> {
  const tokens: TokenAccountInfo[] = [];

  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet, {
      programId: TOKEN_PROGRAM_ID,
    });

    for (const { account } of tokenAccounts.value) {
      const parsed = account.data.parsed;
      if (parsed.type === "account") {
        const info = parsed.info;
        const balance = new BN(info.tokenAmount.amount);
        if (balance.gt(new BN(0))) {
          tokens.push({
            mint: info.mint,
            balance,
            decimals: info.tokenAmount.decimals,
            uiBalance: info.tokenAmount.uiAmount || 0,
          });
        }
      }
    }

    try {
      const token2022Accounts = await connection.getParsedTokenAccountsByOwner(wallet, {
        programId: TOKEN_2022_PROGRAM_ID,
      });

      for (const { account } of token2022Accounts.value) {
        const parsed = account.data.parsed;
        if (parsed.type === "account") {
          const info = parsed.info;
          const balance = new BN(info.tokenAmount.amount);
          if (balance.gt(new BN(0))) {
            tokens.push({
              mint: info.mint,
              balance,
              decimals: info.tokenAmount.decimals,
              uiBalance: info.tokenAmount.uiAmount || 0,
            });
          }
        }
      }
    } catch {
      // TOKEN_2022 might not be supported
    }
  } catch {
    // Return empty array on error
  }

  return tokens;
}

/**
 * Get all token holdings for multiple wallets
 */
export async function getAllWalletTokenHoldings(
  connection: Connection,
  wallets: Keypair[]
): Promise<WalletTokenHoldings[]> {
  const results: WalletTokenHoldings[] = [];
  const BATCH_SIZE = 10;

  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    const batch = wallets.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async (wallet) => {
        const tokens = await getWalletTokenAccounts(connection, wallet.publicKey);
        return {
          wallet,
          walletAddress: wallet.publicKey.toBase58(),
          tokens,
        };
      })
    );

    results.push(...batchResults);
  }

  return results;
}

/**
 * Aggregate token holdings across all wallets
 */
export function aggregateTokenHoldings(
  holdings: WalletTokenHoldings[]
): AggregatedTokenInfo[] {
  const tokenMap = new Map<string, AggregatedTokenInfo>();

  for (const walletHolding of holdings) {
    for (const token of walletHolding.tokens) {
      const existing = tokenMap.get(token.mint);

      if (existing) {
        existing.totalBalance = existing.totalBalance.add(token.balance);
        existing.totalUiBalance += token.uiBalance;
        existing.holdersCount++;
        existing.holders.push({
          walletAddress: walletHolding.walletAddress,
          balance: token.balance,
          uiBalance: token.uiBalance,
        });
      } else {
        tokenMap.set(token.mint, {
          mint: token.mint,
          totalBalance: token.balance,
          decimals: token.decimals,
          totalUiBalance: token.uiBalance,
          holdersCount: 1,
          holders: [
            {
              walletAddress: walletHolding.walletAddress,
              balance: token.balance,
              uiBalance: token.uiBalance,
            },
          ],
        });
      }
    }
  }

  return Array.from(tokenMap.values()).sort(
    (a, b) => b.totalUiBalance - a.totalUiBalance
  );
}

/**
 * Transfer token result
 */
export interface TokenTransferResult {
  success: number;
  failed: number;
  signatures: string[];
  tokensTransferred: { mint: string; amount: BN }[];
}

/**
 * Transfer all tokens from wallets to destination
 * Uses feePayer to pay for transaction fees so source wallets don't need SOL
 */
export async function transferAllTokensToWallet(
  connection: Connection,
  wallets: Keypair[],
  destinationWallet: PublicKey,
  onProgress?: (current: number, total: number, message: string) => void,
  feePayer?: Keypair // Optional fee payer - if provided, pays for fees
): Promise<TokenTransferResult> {
  onProgress?.(0, 100, "Scanning wallets for tokens...");
  const holdings = await getAllWalletTokenHoldings(connection, wallets);

  const walletsWithTokens = holdings.filter((h) => h.tokens.length > 0);

  if (walletsWithTokens.length === 0) {
    return { success: 0, failed: 0, signatures: [], tokensTransferred: [] };
  }

  const uniqueMints = new Set<string>();
  for (const holding of walletsWithTokens) {
    for (const token of holding.tokens) {
      uniqueMints.add(token.mint);
    }
  }

  onProgress?.(10, 100, `Found ${uniqueMints.size} unique tokens in ${walletsWithTokens.length} wallets`);

  let success = 0;
  let failed = 0;
  const signatures: string[] = [];
  const tokensTransferred: { mint: string; amount: BN }[] = [];

  // Determine the actual fee payer
  const actualFeePayer = feePayer || null;
  if (actualFeePayer) {
    const feePayerBalance = await connection.getBalance(actualFeePayer.publicKey);
    console.log(`Fee payer: ${actualFeePayer.publicKey.toBase58().slice(0, 8)}... (${feePayerBalance / LAMPORTS_PER_SOL} SOL)`);
  }

  // Collect all transfers
  const allTransfers: { holding: WalletTokenHoldings; token: TokenAccountInfo }[] = [];
  for (const holding of walletsWithTokens) {
    for (const token of holding.tokens) {
      allTransfers.push({ holding, token });
    }
  }

  // Process each transfer individually
  for (let i = 0; i < allTransfers.length; i++) {
    const { holding, token } = allTransfers[i];
    const progress = 20 + Math.floor((i / allTransfers.length) * 75);
    onProgress?.(progress, 100, `Processing transfer ${i + 1}/${allTransfers.length}...`);

    try {
      const { blockhash, lastValidBlockHeight } = await getBlockhashWithRetry(connection);
      const mintPubkey = new PublicKey(token.mint);

      // Determine token program
      const mintInfo = await connection.getAccountInfo(mintPubkey);
      const tokenProgram = mintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

      const sourceAta = await getAssociatedTokenAddress(mintPubkey, holding.wallet.publicKey, false, tokenProgram);
      const destAta = await getAssociatedTokenAddress(mintPubkey, destinationWallet, false, tokenProgram);

      // Use fee payer if provided, otherwise use source wallet
      const txPayer = actualFeePayer ? actualFeePayer.publicKey : holding.wallet.publicKey;

      const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: PRIORITY_FEE.unitLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE.unitPrice }),
      ];

      // Check if destination ATA exists - use fee payer to create if needed
      try {
        await getAccount(connection, destAta, "confirmed", tokenProgram);
      } catch {
        instructions.push(
          createAssociatedTokenAccountInstruction(
            txPayer, // Fee payer pays for ATA creation
            destAta,
            destinationWallet,
            mintPubkey,
            tokenProgram
          )
        );
      }

      instructions.push(
        createTransferInstruction(
          sourceAta,
          destAta,
          holding.wallet.publicKey, // Source wallet is still the authority
          BigInt(token.balance.toString()),
          [],
          tokenProgram
        )
      );

      const messageV0 = new TransactionMessage({
        payerKey: txPayer,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);

      // Sign with both fee payer (if different) and source wallet
      if (actualFeePayer && !actualFeePayer.publicKey.equals(holding.wallet.publicKey)) {
        transaction.sign([actualFeePayer, holding.wallet]);
      } else {
        transaction.sign([holding.wallet]);
      }

      // Simulate transaction before sending
      const simResult = await simulateTransaction(connection, transaction);
      if (!simResult.success) {
        console.error(`Simulation failed for transfer from ${holding.wallet.publicKey.toBase58().slice(0, 8)}:`, simResult.error);
        if (simResult.logs) {
          console.error("Simulation logs:", simResult.logs.slice(-5).join("\n"));
        }
        failed++;
        continue;
      }

      // Send transaction
      const result = await sendTransactionWithConfirmation(connection, transaction, { blockhash, lastValidBlockHeight }, 60000);

      if (result.success) {
        success++;
        signatures.push(result.signature);
        tokensTransferred.push({ mint: token.mint, amount: token.balance });
      } else {
        console.error(`Transfer failed for ${holding.wallet.publicKey.toBase58().slice(0, 8)}:`, result.error);
        failed++;
      }

      // Delay between transfers to respect 5 tx/sec rate limit
      if (i < allTransfers.length - 1) {
        await sleep(250);
      }
    } catch (e) {
      console.error(`Transfer error:`, e);
      failed++;
    }
  }

  onProgress?.(100, 100, "Transfer complete");

  return { success, failed, signatures, tokensTransferred };
}
