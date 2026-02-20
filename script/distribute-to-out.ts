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

// No fixed count — reads however many wallets exist in the out/ folder
const RENT_EXEMPT = 890880;
const TX_FEE = 5000;
const FEE_BUFFER = TX_FEE; // only reserve tx fee, drain everything else

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

function generateAndSaveWallets(dir: string, count: number): Keypair[] {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const existing = loadWalletsFromDir(dir);
  if (existing.length >= count) {
    console.log(`Loaded ${existing.length} existing out wallets from ${dir}`);
    return existing.slice(0, count).map((w) => w.keypair);
  }

  const wallets: Keypair[] = [];
  for (let i = 0; i < count; i++) {
    const wallet = Keypair.generate();
    wallets.push(wallet);
    const walletInfo: WalletInfo = {
      index: i + 1,
      publicKey: wallet.publicKey.toBase58(),
      secretKey: bs58.encode(wallet.secretKey),
      createdAt: new Date().toISOString(),
    };
    const filePath = path.join(
      dir,
      `wallet_${String(i + 1).padStart(3, "0")}.json`
    );
    fs.writeFileSync(filePath, JSON.stringify(walletInfo, null, 2));
  }
  console.log(`Generated ${count} new out wallets in ${dir}`);
  return wallets;
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
  const midDir = path.join(__dirname, "..", "mid");
  const outDir = path.join(__dirname, "..", "out");

  console.log(`Network: ${network}`);
  console.log(`RPC: ${rpcUrl}\n`);

  // 1. Load source wallets (mid)
  const sourceWallets = loadWalletsFromDir(midDir);
  if (sourceWallets.length === 0) {
    console.error("No wallets found in mid/");
    process.exit(1);
  }
  console.log(`Source wallets (mid): ${sourceWallets.length}`);

  // 2. Load out wallets (must already exist)
  const outWalletData = loadWalletsFromDir(outDir);
  if (outWalletData.length === 0) {
    console.error("No wallets found in out/");
    process.exit(1);
  }
  const outWallets = outWalletData.map((w) => w.keypair);
  console.log(`Target wallets (out): ${outWallets.length}\n`);

  const connection = new Connection(rpcUrl, "confirmed");

  // 3. Fetch source balances
  console.log("=== Source Wallets (mid) ===\n");
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
    console.error("No mid wallets have enough balance to send");
    process.exit(1);
  }

  // 5. Build distribution plan: split sources across out wallets for equal balances
  const targetPerOut = Math.floor(totalSendable / outWallets.length);

  const transfers: { outIdx: number; amount: number }[][] = sendable.map(() => []);
  const outTotals = new Array(outWallets.length).fill(0);

  let srcIdx = 0;
  let srcRemaining = sendable[0].balance - FEE_BUFFER;
  let outIdx = 0;
  let outRemaining = targetPerOut;

  while (srcIdx < sendable.length && outIdx < outWallets.length) {
    const amount = Math.min(srcRemaining, outRemaining);
    if (amount > 0) {
      transfers[srcIdx].push({ outIdx, amount });
      outTotals[outIdx] += amount;
      srcRemaining -= amount;
      outRemaining -= amount;
    }

    if (srcRemaining <= 0) {
      srcIdx++;
      if (srcIdx < sendable.length) {
        srcRemaining = sendable[srcIdx].balance - FEE_BUFFER;
      }
    }
    if (outRemaining <= 0) {
      outIdx++;
      outRemaining = outIdx === outWallets.length - 1 ? Infinity : targetPerOut;
    }
  }
  while (srcIdx < sendable.length) {
    if (srcRemaining > 0) {
      transfers[srcIdx].push({ outIdx: outWallets.length - 1, amount: srcRemaining });
      outTotals[outWallets.length - 1] += srcRemaining;
    }
    srcIdx++;
    if (srcIdx < sendable.length) {
      srcRemaining = sendable[srcIdx].balance - FEE_BUFFER;
    }
  }

  // 6. Show simulation
  console.log("=== Distribution Simulation ===\n");
  console.log(
    "Out # | Out Public Key                                       | Will Receive (SOL)"
  );
  console.log(
    "------+------------------------------------------------------+--------------------"
  );

  let totalToDistribute = 0;
  for (let i = 0; i < outWallets.length; i++) {
    const sol = outTotals[i] / LAMPORTS_PER_SOL;
    totalToDistribute += sol;
    const idx = String(i + 1).padStart(5, " ");
    const solStr = sol.toFixed(9).padStart(18, " ");
    console.log(
      `${idx} | ${outWallets[i].publicKey.toBase58()} | ${solStr}`
    );
  }

  console.log(
    "------+------------------------------------------------------+--------------------"
  );
  console.log(
    `Total to distribute: ${totalToDistribute.toFixed(9)} SOL from ${sendable.length} mid wallets`
  );
  console.log(
    `Target per out wallet: ~${(targetPerOut / LAMPORTS_PER_SOL).toFixed(9)} SOL\n`
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

    let currentBalance = await connection.getBalance(source.keypair.publicKey);

    for (let b = 0; b < txTransfers.length; b += MAX_TRANSFERS_PER_TX) {
      const batch = txTransfers.slice(b, b + MAX_TRANSFERS_PER_TX);
      const batchNum = Math.floor(b / MAX_TRANSFERS_PER_TX) + 1;
      const totalBatches = Math.ceil(txTransfers.length / MAX_TRANSFERS_PER_TX);

      const remainingBatches = totalBatches - batchNum;
      const maxSend = currentBalance - TX_FEE - remainingBatches * TX_FEE;
      if (maxSend <= 0) {
        console.log(`[${i + 1}/${sendable.length}] batch ${batchNum} skipped (insufficient balance)`);
        break;
      }

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
            toPubkey: outWallets[t.outIdx].publicKey,
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
            .slice(0, 8)} -> ${adjustedBatch.length} out wallets | ${(
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

  // 9. Show final out balances
  console.log("\n=== Final Out Wallet Balances ===\n");
  console.log(
    "Out # | Public Key                                         | SOL Balance"
  );
  console.log(
    "------+------------------------------------------------------+------------"
  );

  let totalOut = 0;
  for (let i = 0; i < outWallets.length; i++) {
    const balance = await connection.getBalance(outWallets[i].publicKey);
    const sol = balance / LAMPORTS_PER_SOL;
    totalOut += sol;
    const idx = String(i + 1).padStart(5, " ");
    const solStr = sol.toFixed(9).padStart(14, " ");
    console.log(`${idx} | ${outWallets[i].publicKey.toBase58()} | ${solStr}`);
  }

  console.log(
    "------+------------------------------------------------------+------------"
  );
  console.log(`Total out: ${totalOut.toFixed(9)} SOL`);
  console.log(`\nDone. Success: ${successCount}, Failed: ${failCount}`);
}

main().catch(console.error);
