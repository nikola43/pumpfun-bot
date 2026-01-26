import {
    Connection,
    Keypair,
    PublicKey,
    TransactionMessage,
    VersionedTransaction,
    ComputeBudgetProgram,
    LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { OnlinePumpAmmSdk } from "@pump-fun/pump-swap-sdk";
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
    maxWaitMs: number = 30000
): Promise<{ success: boolean; signature: string; error?: string }> {
    try {
        const signature = await connection.sendTransaction(transaction, {
            skipPreflight: true,
            maxRetries: 3,
            preflightCommitment: "confirmed",
        });

        // Wait for confirmation
        const latestBlockhash = await connection.getLatestBlockhash();
        const confirmation = await connection.confirmTransaction(
            {
                signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            },
            "confirmed"
        );

        if (confirmation.value.err) {
            return {
                success: false,
                signature,
                error: JSON.stringify(confirmation.value.err),
            };
        }

        return { success: true, signature };
    } catch (e) {
        return {
            success: false,
            signature: "", // Might be empty if sendTransaction failed
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
 * Each wallet sends its own independent transaction using 92% of SOL balance
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

    // Use OnlinePumpAmmSdk
    // Note: We cast to any if TS complains about missing methods that exist at runtime
    const sdk = new OnlinePumpAmmSdk(connection) as any;

    for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];

        try {
            const { blockhash } = await connection.getLatestBlockhash("confirmed");
            const walletBalance = await connection.getBalance(wallet.publicKey);

            // Use 92% of balance
            const solAmountLamports = Math.floor(walletBalance * 0.92);

            if (solAmountLamports <= 50000) {
                options?.onProgress?.(i + 1, wallets.length, success, failed);
                continue;
            }

            // Prepare Swap State
            // We assume mint is the pool key.
            const state = await sdk.swapSolanaState(mint, wallet.publicKey);

            // Buy using SOL (Quote) -> Token (Base)
            // buyQuoteInput(state, solAmount, slippage)
            const buyInstructions = await sdk.buyQuoteInput(
                state,
                new BN(solAmountLamports),
                slippageBps / 10000 // Slippage in decimal (0.01 = 1%)
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

            // Send transaction
            const result = await sendTransactionWithConfirmation(connection, transaction, 60000);

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

    const sdk = new OnlinePumpAmmSdk(connection) as any;

    for (let i = 0; i < walletsToSell.length; i++) {
        const { wallet, balance } = walletsToSell[i];

        // Calculate sell amount
        const sellAmount = balance.mul(new BN(sellPercentage)).div(new BN(100));

        if (sellAmount.lte(new BN(0))) {
            continue;
        }

        try {
            const { blockhash } = await connection.getLatestBlockhash("confirmed");

            // Prepare Swap State
            const state = await sdk.swapSolanaState(mint, wallet.publicKey);

            // Sell Token (Base) -> SOL (Quote)
            const sellInstructions = await sdk.sellBaseInput(
                state,
                sellAmount,
                slippageBps / 10000
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

            const result = await sendTransactionWithConfirmation(connection, transaction, 60000);

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
                await sleep(250);
            }

        } catch (e) {
            console.error(`Error processing swap sell for wallet ${i}:`, e);
            failed++;
            onProgress?.(i + 1, walletsToSell.length, success, failed);
        }
    }

    return { success, failed, signatures, totalSold };
}
