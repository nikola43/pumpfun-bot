import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  SystemProgram,
} from "@solana/web3.js";
import * as spl from "@solana/spl-token";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import bs58 from "bs58";
import * as fs from "fs";
import * as path from "path";

// Use the official pump-fun SDK
import {
  OnlinePumpSdk,
  PUMP_SDK,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount
} from "@pump-fun/pump-sdk";

// Import Jito utilities
import {
  sendBundleWithOnChainVerification,
  getTipAccounts,
  getRandomTipAccount,
  getTipFloor,
  JITO_ENDPOINTS,
} from "./jito";

// Import config
import { CONFIG } from "./config";

// Priority fees for transactions
const PRIORITY_FEE = {
  unitLimit: 400000,
  unitPrice: 400000,
};

// Minimum Jito tip (0.003 SOL - higher for better landing rate)
const MIN_TIP_LAMPORTS = 3_000_000;

/**
 * Simulate a transaction
 */
async function simulateTransaction(
  connection: Connection,
  transaction: VersionedTransaction
): Promise<{ success: boolean; error?: string; logs?: string[]; unitsConsumed?: number }> {
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

    return {
      success: true,
      logs: simulation.value.logs || undefined,
      unitsConsumed: simulation.value.unitsConsumed,
    };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

async function testBuyWithJito(mintAddress: string) {
  console.log("\n========== TEST BUY WITH JITO ==========\n");

  const connection = new Connection(CONFIG.RPC_URL, "confirmed");
  const mint = new PublicKey(mintAddress);
  const jitoEndpoint = JITO_ENDPOINTS.mainnet.london;

  // Load a test wallet with enough balance
  let testWallet: Keypair | null = null;
  let balance = 0;
  const walletsDir = path.join(process.cwd(), "wallets");
  const walletFiles = fs.readdirSync(walletsDir).filter(f => f.startsWith("wallet_") && f.endsWith(".json"));

  console.log(`Found ${walletFiles.length} wallet files`);

  for (const file of walletFiles) {
    const walletData = JSON.parse(fs.readFileSync(path.join(walletsDir, file), "utf-8"));
    const kp = Keypair.fromSecretKey(bs58.decode(walletData.secretKey));
    const bal = await connection.getBalance(kp.publicKey);
    console.log(`  ${file}: ${kp.publicKey.toBase58()} = ${bal / LAMPORTS_PER_SOL} SOL`);
    if (bal > balance) {
      balance = bal;
      testWallet = kp;
    }
  }

  if (!testWallet) {
    console.log("No wallets found");
    return;
  }

  console.log("\nUsing wallet:", testWallet.publicKey.toBase58());
  console.log("Wallet SOL balance:", balance / LAMPORTS_PER_SOL, "SOL");

  if (balance < 0.01 * LAMPORTS_PER_SOL) {
    console.log("Wallet has insufficient balance for test (need at least 0.01 SOL for buy + tip)");
    return;
  }

  // Get Jito tip
  console.log("\n--- Getting Jito Tip ---");
  const tipAccounts = await getTipAccounts(jitoEndpoint);
  let tipLamports: number;
  try {
    const fetchedTip = await getTipFloor(jitoEndpoint, "99");
    tipLamports = Math.max(fetchedTip, MIN_TIP_LAMPORTS);
    console.log(`Using tip: ${(tipLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  } catch {
    tipLamports = MIN_TIP_LAMPORTS;
    console.log(`Using default tip: ${(tipLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  }
  const tipAccount = getRandomTipAccount(tipAccounts);
  console.log("Tip account:", tipAccount);

  // Initialize official Pump SDK
  console.log("\n--- Initializing Pump SDK ---");
  const sdk = new OnlinePumpSdk(connection);
  console.log("SDK initialized");

  // Check which token program the mint uses
  console.log("\n--- Checking Mint Token Program ---");
  const mintInfo = await connection.getAccountInfo(mint);
  const mintOwner = mintInfo?.owner.toBase58();
  console.log("Mint owner:", mintOwner);

  const isToken2022 = mintOwner === TOKEN_2022_PROGRAM_ID.toBase58();
  const tokenProgramId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  console.log("Using token program:", tokenProgramId.toBase58());

  // Fetch global state and bonding curve
  console.log("\n--- Fetching State ---");
  const global = await sdk.fetchGlobal();
  console.log("Global state fetched");

  let feeConfig = null;
  try {
    feeConfig = await sdk.fetchFeeConfig();
    console.log("Fee config fetched");
  } catch {
    console.log("Fee config not available (using defaults)");
  }

  const buyState = await sdk.fetchBuyState(mint, testWallet.publicKey, tokenProgramId);
  console.log("Bonding curve fetched");
  console.log("  virtualSolReserves:", buyState.bondingCurve.virtualSolReserves.toString());
  console.log("  virtualTokenReserves:", buyState.bondingCurve.virtualTokenReserves.toString());
  console.log("  complete:", buyState.bondingCurve.complete);
  console.log("  creator:", buyState.bondingCurve.creator.toBase58());

  // Calculate token amount for 0.005 SOL
  const solAmount = new BN(0.005 * LAMPORTS_PER_SOL);
  console.log("\n--- Calculating Token Amount ---");
  console.log("SOL amount:", solAmount.toString(), "lamports");

  const tokenAmount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: global.tokenTotalSupply,
    bondingCurve: buyState.bondingCurve,
    amount: solAmount,
  });
  console.log("Token amount:", tokenAmount.toString());

  // Build buy instructions using SDK
  console.log("\n--- Building Buy Instructions ---");
  const buyInstructions = await PUMP_SDK.buyInstructions({
    global,
    bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
    bondingCurve: buyState.bondingCurve,
    associatedUserAccountInfo: buyState.associatedUserAccountInfo,
    mint,
    user: testWallet.publicKey,
    amount: tokenAmount,
    solAmount,
    slippage: 0.25, // 25% slippage
    tokenProgram: tokenProgramId,
  });

  console.log(`Generated ${buyInstructions.length} instructions`);

  // Build full transaction with priority fees and Jito tip
  console.log("\n--- Building Transaction ---");
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: PRIORITY_FEE.unitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE.unitPrice }),
    ...buyInstructions,
    // Add Jito tip
    SystemProgram.transfer({
      fromPubkey: testWallet.publicKey,
      toPubkey: new PublicKey(tipAccount),
      lamports: tipLamports,
    }),
  ];

  const messageV0 = new TransactionMessage({
    payerKey: testWallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([testWallet]);

  console.log("Transaction built and signed!");
  console.log("Signature:", bs58.encode(transaction.signatures[0]));

  // Simulate the transaction
  console.log("\n--- Simulating Transaction ---");
  const simResult = await simulateTransaction(connection, transaction);

  if (!simResult.success) {
    console.log("Simulation FAILED:", simResult.error);
    if (simResult.logs) {
      console.log("Logs:", simResult.logs.slice(-10).join("\n"));
    }
    return;
  }

  console.log("Simulation SUCCESS!");
  console.log("Units consumed:", simResult.unitsConsumed);

  // Try direct RPC send first (faster landing), then Jito as backup
  console.log("\n--- Sending Transaction (RPC + Jito) ---");
  const txSig = bs58.encode(transaction.signatures[0]);

  // Send directly via RPC with high priority
  try {
    const rpcSig = await connection.sendTransaction(transaction, {
      skipPreflight: true, // Skip since we already simulated
      maxRetries: 3,
      preflightCommitment: "confirmed",
    });
    console.log("Sent via RPC:", rpcSig);
    console.log("Solscan:", `https://solscan.io/tx/${rpcSig}`);

    // Wait for confirmation
    console.log("Waiting for confirmation...");
    const startTime = Date.now();
    const maxWait = 30000; // 30 seconds

    while (Date.now() - startTime < maxWait) {
      const statuses = await connection.getSignatureStatuses([rpcSig]);
      const status = statuses.value[0];

      if (status !== null) {
        if (status.err) {
          console.log("Transaction FAILED:", status.err);
          break;
        }
        if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
          console.log("Transaction CONFIRMED!");
          console.log("Slot:", status.slot);
          return;
        }
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log("RPC confirmation timeout, checking Jito...");
  } catch (e) {
    console.log("RPC send failed:", e);
  }

  // Fallback to Jito bundle
  console.log("Trying Jito bundle...");
  const serializedTx = bs58.encode(transaction.serialize());

  const result = await sendBundleWithOnChainVerification(
    connection,
    [serializedTx],
    jitoEndpoint,
    {},
    30000 // 30s timeout
  );

  if (result.success) {
    console.log("Bundle ID:", result.bundleId);
    console.log("Landed:", result.landed);
    if (result.slot) {
      console.log("Landed at slot:", result.slot);
    }
    console.log("Solscan:", `https://solscan.io/tx/${txSig}`);
  } else {
    console.log("Bundle also FAILED:", result.error);
  }
}

async function testSellWithJito(mintAddress: string) {
  console.log("\n========== TEST SELL WITH JITO ==========\n");

  const connection = new Connection(CONFIG.RPC_URL, "confirmed");
  const mint = new PublicKey(mintAddress);
  const jitoEndpoint = JITO_ENDPOINTS.mainnet.london;

  // Check which token program the mint uses
  const mintInfo = await connection.getAccountInfo(mint);
  const isToken2022 = mintInfo?.owner.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58();
  const tokenProgramId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  // Load a test wallet with token balance AND enough SOL for tip
  let testWallet: Keypair | null = null;
  let tokenBalance = BigInt(0);
  let solBalance = 0;
  const walletsDir = path.join(process.cwd(), "wallets");
  const walletFiles = fs.readdirSync(walletsDir).filter(f => f.startsWith("wallet_") && f.endsWith(".json"));

  // Find wallet with token balance and enough SOL
  for (const file of walletFiles) {
    const walletData = JSON.parse(fs.readFileSync(path.join(walletsDir, file), "utf-8"));
    const kp = Keypair.fromSecretKey(bs58.decode(walletData.secretKey));

    try {
      const ata = await spl.getAssociatedTokenAddress(mint, kp.publicKey, false, tokenProgramId);
      const account = await spl.getAccount(connection, ata, "confirmed", tokenProgramId);
      const sol = await connection.getBalance(kp.publicKey);

      if (account.amount > BigInt(0)) {
        console.log(`Wallet ${kp.publicKey.toBase58().slice(0, 8)}...:`);
        console.log(`  Token balance: ${account.amount.toString()}`);
        console.log(`  SOL balance: ${sol / LAMPORTS_PER_SOL} SOL`);

        // Need enough SOL for tip + rent
        if (sol >= 0.005 * LAMPORTS_PER_SOL && account.amount > tokenBalance) {
          testWallet = kp;
          tokenBalance = account.amount;
          solBalance = sol;
        }
      }
    } catch {
      // No token account
    }
  }

  if (!testWallet) {
    console.log("No wallets with token balance AND sufficient SOL found");
    console.log("Need at least 0.005 SOL for tip + rent");
    return;
  }

  console.log("\nUsing wallet:", testWallet.publicKey.toBase58());
  console.log("Token balance:", tokenBalance.toString());
  console.log("SOL balance:", solBalance / LAMPORTS_PER_SOL, "SOL");

  // Get Jito tip
  console.log("\n--- Getting Jito Tip ---");
  const tipAccounts = await getTipAccounts(jitoEndpoint);
  let tipLamports: number;
  try {
    const fetchedTip = await getTipFloor(jitoEndpoint, "99");
    tipLamports = Math.max(fetchedTip, MIN_TIP_LAMPORTS);
    console.log(`Using tip: ${(tipLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  } catch {
    tipLamports = MIN_TIP_LAMPORTS;
    console.log(`Using default tip: ${(tipLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  }
  const tipAccount = getRandomTipAccount(tipAccounts);
  console.log("Tip account:", tipAccount);

  // Initialize official Pump SDK
  console.log("\n--- Initializing Pump SDK ---");
  const sdk = new OnlinePumpSdk(connection);
  console.log("SDK initialized");

  // Fetch global state and bonding curve
  console.log("\n--- Fetching State ---");
  const global = await sdk.fetchGlobal();
  console.log("Global state fetched");

  let feeConfig = null;
  try {
    feeConfig = await sdk.fetchFeeConfig();
    console.log("Fee config fetched");
  } catch {
    console.log("Fee config not available (using defaults)");
  }

  const sellState = await sdk.fetchSellState(mint, testWallet.publicKey, tokenProgramId);
  console.log("Bonding curve fetched");
  console.log("  complete:", sellState.bondingCurve.complete);

  // Convert to BN
  const tokenBalanceBN = new BN(tokenBalance.toString());
  console.log("\nToken balance:", tokenBalanceBN.toString());

  // Calculate SOL output
  const solOutput = getSellSolAmountFromTokenAmount({
    global,
    feeConfig,
    mintSupply: global.tokenTotalSupply,
    bondingCurve: sellState.bondingCurve,
    amount: tokenBalanceBN,
  });
  console.log("Expected SOL output:", solOutput.toString(), "lamports");
  console.log("Expected SOL output:", Number(solOutput) / LAMPORTS_PER_SOL, "SOL");

  // Build sell instructions using SDK
  console.log("\n--- Building Sell Instructions ---");
  const sellInstructions = await PUMP_SDK.sellInstructions({
    global,
    bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
    bondingCurve: sellState.bondingCurve,
    mint,
    user: testWallet.publicKey,
    amount: tokenBalanceBN,
    solAmount: solOutput,
    slippage: 0.25, // 25% slippage
    tokenProgram: tokenProgramId,
    mayhemMode: false,
  });

  console.log(`Generated ${sellInstructions.length} instructions`);

  // Build full transaction with priority fees and Jito tip
  console.log("\n--- Building Transaction ---");
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: PRIORITY_FEE.unitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE.unitPrice }),
    ...sellInstructions,
    // Add Jito tip
    SystemProgram.transfer({
      fromPubkey: testWallet.publicKey,
      toPubkey: new PublicKey(tipAccount),
      lamports: tipLamports,
    }),
  ];

  const messageV0 = new TransactionMessage({
    payerKey: testWallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([testWallet]);

  console.log("Transaction built and signed!");
  console.log("Signature:", bs58.encode(transaction.signatures[0]));

  // Simulate the transaction
  console.log("\n--- Simulating Transaction ---");
  const simResult = await simulateTransaction(connection, transaction);

  if (!simResult.success) {
    console.log("Simulation FAILED:", simResult.error);
    if (simResult.logs) {
      console.log("Logs:", simResult.logs.slice(-10).join("\n"));
    }
    return;
  }

  console.log("Simulation SUCCESS!");
  console.log("Units consumed:", simResult.unitsConsumed);

  // Try direct RPC send first (faster landing), then Jito as backup
  console.log("\n--- Sending Transaction (RPC + Jito) ---");
  const txSig = bs58.encode(transaction.signatures[0]);

  // Send directly via RPC with high priority
  try {
    const rpcSig = await connection.sendTransaction(transaction, {
      skipPreflight: true, // Skip since we already simulated
      maxRetries: 3,
      preflightCommitment: "confirmed",
    });
    console.log("Sent via RPC:", rpcSig);
    console.log("Solscan:", `https://solscan.io/tx/${rpcSig}`);

    // Wait for confirmation
    console.log("Waiting for confirmation...");
    const startTime = Date.now();
    const maxWait = 30000; // 30 seconds

    while (Date.now() - startTime < maxWait) {
      const statuses = await connection.getSignatureStatuses([rpcSig]);
      const status = statuses.value[0];

      if (status !== null) {
        if (status.err) {
          console.log("Transaction FAILED:", status.err);
          break;
        }
        if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
          console.log("Transaction CONFIRMED!");
          console.log("Slot:", status.slot);
          return;
        }
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log("RPC confirmation timeout, checking Jito...");
  } catch (e) {
    console.log("RPC send failed:", e);
  }

  // Fallback to Jito bundle
  console.log("Trying Jito bundle...");
  const serializedTx = bs58.encode(transaction.serialize());

  const result = await sendBundleWithOnChainVerification(
    connection,
    [serializedTx],
    jitoEndpoint,
    {},
    30000 // 30s timeout
  );

  if (result.success) {
    console.log("Bundle ID:", result.bundleId);
    console.log("Landed:", result.landed);
    if (result.slot) {
      console.log("Landed at slot:", result.slot);
    }
    console.log("Solscan:", `https://solscan.io/tx/${txSig}`);
  } else {
    console.log("Bundle also FAILED:", result.error);
  }
}

// Main
const args = process.argv.slice(2);
const action = args[0] || "buy";
const mintAddress = args[1] || "BGW766Z1dbJe4vCVz4pdnYY51zogbGpnuCWqhzTapump";

console.log("Action:", action);
console.log("Mint:", mintAddress);

if (action === "buy") {
  testBuyWithJito(mintAddress).catch(console.error);
} else if (action === "sell") {
  testSellWithJito(mintAddress).catch(console.error);
} else {
  console.log("Usage: npx ts-node src/test-pump.ts [buy|sell] [mint_address]");
}
