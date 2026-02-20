import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
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

const TX_FEE = 5000;
const FEE_BUFFER = TX_FEE;

interface WalletInfo {
  index: number;
  publicKey: string;
  secretKey: string;
  createdAt: string;
}

function loadWalletsFromDir(dir: string): { keypair: Keypair; info: WalletInfo }[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("wallet_") && f.endsWith(".json"))
    .sort();
  return files.map((file) => {
    const data: WalletInfo = JSON.parse(
      fs.readFileSync(path.join(dir, file), "utf-8")
    );
    return { keypair: Keypair.fromSecretKey(bs58.decode(data.secretKey)), info: data };
  });
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
  const outDir = path.join(__dirname, "..", "out");
  const defDir = path.join(__dirname, "..", "def");

  console.log(`Network: ${network}`);
  console.log(`RPC: ${rpcUrl}\n`);

  // 1. Load source wallets (out)
  const sourceWallets = loadWalletsFromDir(outDir);
  if (sourceWallets.length === 0) {
    console.error("No wallets found in out/");
    process.exit(1);
  }
  console.log(`Source wallets (out): ${sourceWallets.length}`);

  // 2. Load def wallets (must already exist)
  const defWalletData = loadWalletsFromDir(defDir);
  if (defWalletData.length === 0) {
    console.error("No wallets found in def/");
    process.exit(1);
  }
  const defWallets = defWalletData.map((w) => w.keypair);
  console.log(`Target wallets (def): ${defWallets.length}\n`);

  const connection = new Connection(rpcUrl, "confirmed");

  // 3. Fetch source balances
  console.log("=== Source Wallets (out) ===\n");
  console.log(
    "Index | Public Key                                         | SOL Balance"
  );
  console.log(
    "------+------------------------------------------------------+------------"
  );

  const sourceBalances: { keypair: Keypair; balance: number }[] = [];
  let totalSourceSol = 0;

  for (const { keypair, info } of sourceWallets) {
    const balance = await connection.getBalance(keypair.publicKey);
    const sol = balance / LAMPORTS_PER_SOL;
    totalSourceSol += sol;
    sourceBalances.push({ keypair, balance });

    const idx = String(info.index).padStart(5, " ");
    const solStr = sol.toFixed(9).padStart(14, " ");
    console.log(`${idx} | ${keypair.publicKey.toBase58()} | ${solStr}`);
  }

  console.log(
    "------+------------------------------------------------------+------------"
  );
  console.log(`Total source: ${totalSourceSol.toFixed(9)} SOL\n`);

  // 4. Filter wallets with enough to send
  const sendable = sourceBalances.filter((w) => w.balance > FEE_BUFFER);
  const totalSendable = sendable.reduce(
    (sum, w) => sum + (w.balance - FEE_BUFFER),
    0
  );

  if (sendable.length === 0) {
    console.error("No out wallets have enough balance to send");
    process.exit(1);
  }

  // 5. Build distribution plan: split sources across def wallets for equal balances
  const targetPerDef = Math.floor(totalSendable / defWallets.length);

  const transfers: { defIdx: number; amount: number }[][] = sendable.map(() => []);
  const defTotals = new Array(defWallets.length).fill(0);

  let srcIdx = 0;
  let srcRemaining = sendable[0].balance - FEE_BUFFER;
  let defIdx = 0;
  let defRemaining = targetPerDef;

  while (srcIdx < sendable.length && defIdx < defWallets.length) {
    const amount = Math.min(srcRemaining, defRemaining);
    if (amount > 0) {
      transfers[srcIdx].push({ defIdx, amount });
      defTotals[defIdx] += amount;
      srcRemaining -= amount;
      defRemaining -= amount;
    }

    if (srcRemaining <= 0) {
      srcIdx++;
      if (srcIdx < sendable.length) {
        srcRemaining = sendable[srcIdx].balance - FEE_BUFFER;
      }
    }
    if (defRemaining <= 0) {
      defIdx++;
      defRemaining = defIdx === defWallets.length - 1 ? Infinity : targetPerDef;
    }
  }
  while (srcIdx < sendable.length) {
    if (srcRemaining > 0) {
      transfers[srcIdx].push({ defIdx: defWallets.length - 1, amount: srcRemaining });
      defTotals[defWallets.length - 1] += srcRemaining;
    }
    srcIdx++;
    if (srcIdx < sendable.length) {
      srcRemaining = sendable[srcIdx].balance - FEE_BUFFER;
    }
  }

  // 6. Show simulation
  console.log("=== Distribution Simulation ===\n");
  console.log(
    "Def # | Def Public Key                                       | Will Receive (SOL)"
  );
  console.log(
    "------+------------------------------------------------------+--------------------"
  );

  let totalToDistribute = 0;
  for (let i = 0; i < defWallets.length; i++) {
    const sol = defTotals[i] / LAMPORTS_PER_SOL;
    totalToDistribute += sol;
    const idx = String(i + 1).padStart(5, " ");
    const solStr = sol.toFixed(9).padStart(18, " ");
    console.log(
      `${idx} | ${defWallets[i].publicKey.toBase58()} | ${solStr}`
    );
  }

  console.log(
    "------+------------------------------------------------------+--------------------"
  );
  console.log(
    `Total to distribute: ${totalToDistribute.toFixed(9)} SOL from ${sendable.length} out wallets`
  );
  console.log(
    `Target per def wallet: ~${(targetPerDef / LAMPORTS_PER_SOL).toFixed(9)} SOL\n`
  );

  // 7. Ask confirmation
  const confirmed = await askConfirmation(
    "Proceed with distribution? (y/n): "
  );
  if (!confirmed) {
    console.log("Aborted.");
    process.exit(0);
  }

  // 8. Execute transfers (batch max 20 transfers per tx to avoid size limit)
  const MAX_TRANSFERS_PER_TX = 20;
  console.log("\nExecuting transfers...\n");

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < sendable.length; i++) {
    const source = sendable[i];
    const txTransfers = transfers[i];
    if (txTransfers.length === 0) continue;

    // Re-fetch balance once for this source
    let currentBalance = await connection.getBalance(source.keypair.publicKey);
    const plannedTotal = txTransfers.reduce((s, t) => s + t.amount, 0);

    // Split into batches of MAX_TRANSFERS_PER_TX
    for (let b = 0; b < txTransfers.length; b += MAX_TRANSFERS_PER_TX) {
      const batch = txTransfers.slice(b, b + MAX_TRANSFERS_PER_TX);
      const batchNum = Math.floor(b / MAX_TRANSFERS_PER_TX) + 1;
      const totalBatches = Math.ceil(txTransfers.length / MAX_TRANSFERS_PER_TX);

      // Reserve fee for remaining batches after this one
      const remainingBatches = totalBatches - batchNum;
      const maxSend = currentBalance - TX_FEE - remainingBatches * TX_FEE;
      if (maxSend <= 0) {
        console.log(`[${i + 1}/${sendable.length}] batch ${batchNum} skipped (insufficient balance)`);
        break;
      }

      // Scale down if needed
      const batchPlanned = batch.reduce((s, t) => s + t.amount, 0);
      const scale = batchPlanned > maxSend ? maxSend / batchPlanned : 1;
      const adjustedBatch = batch.map((t) => ({
        ...t,
        amount: Math.floor(t.amount * scale),
      }));

      try {
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash("confirmed");

        const instructions = adjustedBatch.map((t) =>
          SystemProgram.transfer({
            fromPubkey: source.keypair.publicKey,
            toPubkey: defWallets[t.defIdx].publicKey,
            lamports: t.amount,
          })
        );

        const messageV0 = new TransactionMessage({
          payerKey: source.keypair.publicKey,
          recentBlockhash: blockhash,
          instructions,
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([source.keypair]);

        const signature = await connection.sendTransaction(transaction, {
          skipPreflight: true,
          maxRetries: 3,
        });

        const totalSent = adjustedBatch.reduce((s, t) => s + t.amount, 0);
        const batchLabel = totalBatches > 1 ? ` batch ${batchNum}/${totalBatches}` : "";
        console.log(
          `[${i + 1}/${sendable.length}]${batchLabel} ${source.keypair.publicKey
            .toBase58()
            .slice(0, 8)} -> ${adjustedBatch.length} def wallets | ${(
            totalSent / LAMPORTS_PER_SOL
          ).toFixed(6)} SOL | tx: ${signature}`
        );

        await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          "confirmed"
        );
        currentBalance -= totalSent + TX_FEE;
        successCount++;
      } catch (e) {
        console.error(
          `[${i + 1}/${sendable.length}] FAILED ${source.keypair.publicKey
            .toBase58()
            .slice(0, 8)}: ${e}`
        );
        failCount++;
        break;
      }

      await sleep(1000);
    }
  }

  // 9. Show final def balances
  console.log("\n=== Final Def Wallet Balances ===\n");
  console.log(
    "Def # | Public Key                                         | SOL Balance"
  );
  console.log(
    "------+------------------------------------------------------+------------"
  );

  let totalDef = 0;
  for (let i = 0; i < defWallets.length; i++) {
    const balance = await connection.getBalance(defWallets[i].publicKey);
    const sol = balance / LAMPORTS_PER_SOL;
    totalDef += sol;
    const idx = String(i + 1).padStart(5, " ");
    const solStr = sol.toFixed(9).padStart(14, " ");
    console.log(`${idx} | ${defWallets[i].publicKey.toBase58()} | ${solStr}`);
  }

  console.log(
    "------+------------------------------------------------------+------------"
  );
  console.log(`Total def: ${totalDef.toFixed(9)} SOL`);
  console.log(`\nDone. Success: ${successCount}, Failed: ${failCount}`);
}

main().catch(console.error);
