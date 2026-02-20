import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import * as readline from "readline";
import bs58 from "bs58";

// Load .env
const envPaths = [
  path.join(__dirname, "..", "src", ".env"),
  path.join(__dirname, "..", ".env"),
];
for (const p of envPaths) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
}

const RPC_URLS: Record<string, string> = {
  "mainnet-beta":
    "https://mainnet.helius-rpc.com/?api-key=e26bf879-6bb4-49c0-aafa-8e4d86687455",
  testnet: "https://solana-testnet-rpc.publicnode.com",
  devnet:
    "https://devnet.helius-rpc.com/?api-key=e26bf879-6bb4-49c0-aafa-8e4d86687455",
};

const TOTAL_SOL = 0.8;
const TX_FEE = 5000;

interface WalletInfo {
  index: number;
  publicKey: string;
  secretKey: string;
  createdAt: string;
}

function loadWalletsFromDir(dir: string): WalletInfo[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("wallet_") && f.endsWith(".json"))
    .sort();
  return files.map((file) =>
    JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"))
  );
}

function askConfirmation(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const network = process.env.SOLANA_NETWORK || "testnet";
  const rpcUrl = RPC_URLS[network] || RPC_URLS["testnet"];
  const walletsDir = path.join(__dirname, "..", "wallets");

  console.log(`Network: ${network}`);
  console.log(`RPC: ${rpcUrl}\n`);

  // 1. Load payer
  const payerSecret = process.env.PAYER_PRIVATE;
  if (!payerSecret) {
    console.error("PAYER_PRIVATE not found in .env");
    process.exit(1);
  }
  const payer = Keypair.fromSecretKey(bs58.decode(payerSecret));
  console.log(`Payer: ${payer.publicKey.toBase58()}`);

  const connection = new Connection(rpcUrl, "confirmed");

  const payerBalance = await connection.getBalance(payer.publicKey);
  const payerSol = payerBalance / LAMPORTS_PER_SOL;
  console.log(`Payer balance: ${payerSol.toFixed(9)} SOL\n`);

  // 2. Load target wallets
  const wallets = loadWalletsFromDir(walletsDir);
  if (wallets.length === 0) {
    console.error("No wallets found in wallets/");
    process.exit(1);
  }
  console.log(`Target wallets: ${wallets.length}`);

  // 3. Calculate amount per wallet
  const totalLamports = Math.floor(TOTAL_SOL * LAMPORTS_PER_SOL);
  const perWalletLamports = Math.floor(totalLamports / wallets.length);
  const perWalletSol = perWalletLamports / LAMPORTS_PER_SOL;
  const totalFees = wallets.length * TX_FEE;
  const totalNeeded = totalLamports + totalFees;

  console.log(`Total to distribute: ${TOTAL_SOL} SOL`);
  console.log(`Per wallet: ${perWalletSol.toFixed(9)} SOL (${perWalletLamports} lamports)`);
  console.log(`Total fees: ${(totalFees / LAMPORTS_PER_SOL).toFixed(9)} SOL`);
  console.log(`Total needed: ${(totalNeeded / LAMPORTS_PER_SOL).toFixed(9)} SOL\n`);

  if (payerBalance < totalNeeded) {
    console.error(
      `Insufficient balance. Have ${payerSol.toFixed(9)} SOL, need ${(totalNeeded / LAMPORTS_PER_SOL).toFixed(9)} SOL`
    );
    process.exit(1);
  }

  // 4. Confirm
  const confirmed = await askConfirmation(
    `Send ${perWalletSol.toFixed(9)} SOL to each of ${wallets.length} wallets? (y/n): `
  );
  if (!confirmed) {
    console.log("Aborted.");
    process.exit(0);
  }

  // 5. Send one by one
  console.log("\nSending...\n");

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];

    try {
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");

      const instruction = SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: new PublicKey(wallet.publicKey),
        lamports: perWalletLamports,
      });

      const messageV0 = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions: [instruction],
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([payer]);

      const signature = await connection.sendTransaction(transaction, {
        skipPreflight: true,
        maxRetries: 3,
      });

      console.log(
        `[${i + 1}/${wallets.length}] wallet_${String(wallet.index).padStart(3, "0")} | ${perWalletSol.toFixed(6)} SOL | tx: ${signature}`
      );

      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );
      successCount++;
    } catch (e) {
      console.error(
        `[${i + 1}/${wallets.length}] wallet_${String(wallet.index).padStart(3, "0")} FAILED: ${e}`
      );
      failCount++;
    }

    if (i < wallets.length - 1) {
      await sleep(1000);
    }
  }

  // 6. Summary
  const finalBalance = await connection.getBalance(payer.publicKey);
  console.log(`\nDone. Success: ${successCount}, Failed: ${failCount}`);
  console.log(`Payer remaining: ${(finalBalance / LAMPORTS_PER_SOL).toFixed(9)} SOL`);
}

main().catch(console.error);
