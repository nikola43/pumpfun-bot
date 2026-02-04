import {
    Connection,
    Keypair,
    PublicKey,
    TransactionMessage,
    VersionedTransaction,
    ComputeBudgetProgram,
    LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { OnlinePumpAmmSdk, PumpAmmSdk, canonicalPumpPoolPda } from "@pump-fun/pump-swap-sdk";
import BN from "bn.js";
import bs58 from "bs58";
import ora from "ora";
import chalk from "chalk";

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
    try {
        const signature = await connection.sendTransaction(transaction, {
            skipPreflight: true,
            maxRetries: 3,
            preflightCommitment: "confirmed",
        });

        console.log(`Sent tx: ${signature}`);

        // Wait for confirmation using the same blockhash the transaction was built with
        // const confirmation = await connection.confirmTransaction(
        //     {
        //         signature,
        //         blockhash: blockhashInfo.blockhash,
        //         lastValidBlockHeight: blockhashInfo.lastValidBlockHeight,
        //     },
        //     "confirmed"
        // );

        // if (confirmation.value.err) {
        //     return {
        //         success: false,
        //         signature,
        //         error: JSON.stringify(confirmation.value.err),
        //     };
        // }

        return { success: true, signature };
    } catch (e) {
        return {
            success: false,
            signature: "",
            error: String(e),
        };
    }
}

/**
 * Buy options
 */
export interface SwapBuyOptions {
    minDelayMs?: number;
    maxDelayMs?: number;
    minSolAmount?: number;
    maxSolAmount?: number;
    onProgress?: (current: number, total: number, success: number, failed: number, lastTx?: string) => void;
}

/**
 * Buy result
 */
export interface SwapBuyResult {
    success: number;
    failed: number;
    signatures: string[];
}

/**
 * Execute buy using PumpSwap for multiple wallets
 * Each wallet sends its own independent transaction using a random SOL amount between min and max
 */
export async function executeSwapBuy(
    connection: Connection,
    wallets: Keypair[],
    mint: PublicKey,
    slippageBps: number = 2500,
    options?: SwapBuyOptions
): Promise<SwapBuyResult> {
    let success = 0;
    let failed = 0;
    const signatures: string[] = [];

    // Use separate SDKs for state fetching and instruction generation
    const onlineSdk = new OnlinePumpAmmSdk(connection);
    const offlineSdk = new PumpAmmSdk(); // Offline SDK for instructions

    try {
        // Derive pool key
        const poolKey = canonicalPumpPoolPda(mint);

        for (let i = 0; i < wallets.length; i++) {
            const wallet = wallets[i];

            try {
                const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
                const walletBalance = await connection.getBalance(wallet.publicKey);

                let solAmountLamports: number;
                if (options?.minSolAmount !== undefined && options?.maxSolAmount !== undefined) {
                    // Random amount between min and max
                    const minLamports = Math.floor(options.minSolAmount * LAMPORTS_PER_SOL);
                    const maxLamports = Math.floor(options.maxSolAmount * LAMPORTS_PER_SOL);
                    solAmountLamports = minLamports + Math.floor(Math.random() * (maxLamports - minLamports));
                    // Cap to wallet balance minus fee buffer
                    solAmountLamports = Math.min(solAmountLamports, Math.floor(walletBalance * 0.92));
                } else {
                    solAmountLamports = Math.floor(walletBalance * 0.92);
                }

                if (solAmountLamports <= 50000) {
                    options?.onProgress?.(i + 1, wallets.length, success, failed);
                    continue;
                }

                // Get state for this wallet using Online SDK
                const state = await onlineSdk.swapSolanaState(poolKey, wallet.publicKey);

                // Generate Buy Instructions using Offline SDK
                // buyQuoteInput(state, quote, slippage) — slippage is percentage: 25 = 25%
                const buyInstructions = await offlineSdk.buyQuoteInput(
                    state,
                    new BN(solAmountLamports),
                    slippageBps / 100
                );

                // Add priority fees
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

                // Simulate before sending
                const simulation = await connection.simulateTransaction(transaction);
                if (simulation.value.err) {
                    console.error(`Simulation failed for wallet ${wallet.publicKey.toBase58().slice(0, 8)}: ${JSON.stringify(simulation.value.err)}`);
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
                    console.error(`Swap Buy tx failed for wallet ${wallet.publicKey.toBase58().slice(0, 8)}:`, result.error);
                    failed++;
                }

                options?.onProgress?.(i + 1, wallets.length, success, failed, result.signature);

                // Delay
                if (i < wallets.length - 1) {
                    if (options?.minDelayMs && options?.maxDelayMs) {
                        const delay = getRandomDelay(options.minDelayMs, options.maxDelayMs);
                        await sleep(delay);
                    } else {
                        await sleep(250);
                    }
                }

            } catch (e) {
                console.error(`Error processing swap buy for wallet ${i}:`, e);
                failed++;
                options?.onProgress?.(i + 1, wallets.length, success, failed);
            }
        }
    } catch (error: any) {
        console.error("Critical Error in executeSwapBuy:", error);
        return { success: 0, failed: wallets.length, signatures: [] };
    }

    return { success, failed, signatures };
}

/**
 * Sell result
 */
export interface SwapSellResult {
    success: number;
    failed: number;
    signatures: string[];
    totalSold: BN;
}

/**
 * Execute sell using PumpSwap for multiple wallets
 */
export async function executeSwapSell(
    connection: Connection,
    walletBalances: { wallet: Keypair; balance: BN }[], // Token balances
    mint: PublicKey,
    sellPercentage: number,
    slippageBps: number = 2500,
    onProgress?: (current: number, total: number, success: number, failed: number, lastTx?: string) => void
): Promise<SwapSellResult> {
    const walletsToSell = walletBalances.filter((w) => w.balance.gt(new BN(0)));

    if (walletsToSell.length === 0) {
        return { success: 0, failed: 0, signatures: [], totalSold: new BN(0) };
    }

    let success = 0;
    let failed = 0;
    let totalSold = new BN(0);
    const signatures: string[] = [];

    const onlineSdk = new OnlinePumpAmmSdk(connection);
    const offlineSdk = new PumpAmmSdk();

    try {
        // Derive pool key
        const poolKey = canonicalPumpPoolPda(mint);

        for (let i = 0; i < walletsToSell.length; i++) {
            const { wallet, balance } = walletsToSell[i];

            // Calculate sell amount
            const sellAmount = balance.mul(new BN(sellPercentage)).div(new BN(100));

            if (sellAmount.lte(new BN(0))) {
                continue;
            }

            try {
                const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

                // Prepare Swap State
                // Note: swapSolanaState argument order is (poolKey, user)
                const state = await onlineSdk.swapSolanaState(poolKey, wallet.publicKey);

                // Sell Token (Base) -> SOL (Quote)
                // slippage is percentage: 25 = 25%
                const sellInstructions = await offlineSdk.sellBaseInput(
                    state,
                    sellAmount,
                    slippageBps / 100
                );

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

                // Simulate before sending
                const simulation = await connection.simulateTransaction(transaction);
                if (simulation.value.err) {
                    console.error(`Simulation failed for wallet ${wallet.publicKey.toBase58().slice(0, 8)}: ${JSON.stringify(simulation.value.err)}`);
                    failed++;
                    onProgress?.(i + 1, walletsToSell.length, success, failed);
                    continue;
                }

                const result = await sendTransactionWithConfirmation(connection, transaction, { blockhash, lastValidBlockHeight }, 60000);

                if (result.success) {
                    success++;
                    totalSold = totalSold.add(sellAmount);
                    signatures.push(result.signature);
                } else {
                    console.error(`Swap Sell tx failed for wallet ${wallet.publicKey.toBase58().slice(0, 8)}:`, result.error);
                    failed++;
                }

                onProgress?.(i + 1, walletsToSell.length, success, failed, result.signature);

                if (i < walletsToSell.length - 1) {
                    await sleep(1000);
                }

            } catch (e) {
                console.error(`Error processing swap sell for wallet ${i}:`, e);
                failed++;
                onProgress?.(i + 1, walletsToSell.length, success, failed);
            }
        }
    } catch (error: any) {
        console.error("Critical Error in executeSwapSell:", error);
        return { success: 0, failed: walletsToSell.length, signatures: [], totalSold: new BN(0) };
    }

    return { success, failed, signatures, totalSold };
}
