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

const MID_WALLET_COUNT = 20;
const RENT_EXEMPT = 890880; // minimum rent-exempt balance for an account
const TX_FEE = 5000; // base fee per transaction
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

function generateAndSaveMidWallets(dir: string, count: number): Keypair[] {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // If wallets already exist, load them
  const existing = loadWalletsFromDir(dir);
  if (existing.length >= count) {
    console.log(`Loaded ${existing.length} existing mid wallets from ${dir}`);
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
  console.log(`Generated ${count} new mid wallets in ${dir}`);
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
  const originDir = path.join(__dirname, "..", "walletsOrigin");
  const midDir = path.join(__dirname, "..", "mid");

  console.log(`Network: ${network}`);
  console.log(`RPC: ${rpcUrl}\n`);

  // 1. Load source wallets
  const sourceWallets = loadWalletsFromDir(originDir);
  if (sourceWallets.length === 0) {
    console.error("No wallets found in walletsOrigin/");
    process.exit(1);
  }
  console.log(`Source wallets (walletsOrigin): ${sourceWallets.length}`);

  // 2. Create/load mid wallets
  const midWallets = generateAndSaveMidWallets(midDir, MID_WALLET_COUNT);
  console.log(`Target wallets (mid): ${midWallets.length}\n`);

  const connection = new Connection(rpcUrl, "confirmed");

  // 3. Fetch source balances
  console.log("=== Source Wallets (walletsOrigin) ===\n");
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
    console.error("No source wallets have enough balance to send");
    process.exit(1);
  }

  // 5. Build distribution plan: split sources across mid wallets for equal balances
  //    Each source may send to multiple mid wallets. We batch multiple transfers
  //    into a single transaction per source (1 fee per source).
  const targetPerMid = Math.floor(totalSendable / midWallets.length);

  // transfers[sourceIndex] = [{ midIdx, amount }]
  const transfers: { midIdx: number; amount: number }[][] = sendable.map(() => []);
  const midTotals = new Array(midWallets.length).fill(0);

  // Two-pointer: walk through sources and mid wallets
  let srcIdx = 0;
  let srcRemaining = sendable[0].balance - FEE_BUFFER;
  let midIdx = 0;
  let midRemaining = targetPerMid;

  while (srcIdx < sendable.length && midIdx < midWallets.length) {
    const amount = Math.min(srcRemaining, midRemaining);
    if (amount > 0) {
      transfers[srcIdx].push({ midIdx, amount });
      midTotals[midIdx] += amount;
      srcRemaining -= amount;
      midRemaining -= amount;
    }

    if (srcRemaining <= 0) {
      srcIdx++;
      if (srcIdx < sendable.length) {
        srcRemaining = sendable[srcIdx].balance - FEE_BUFFER;
      }
    }
    if (midRemaining <= 0) {
      midIdx++;
      // Last mid wallet gets whatever remains
      midRemaining = midIdx === midWallets.length - 1 ? Infinity : targetPerMid;
    }
  }
  // If any source balance remains (rounding), send to last mid wallet
  while (srcIdx < sendable.length) {
    if (srcRemaining > 0) {
      transfers[srcIdx].push({ midIdx: midWallets.length - 1, amount: srcRemaining });
      midTotals[midWallets.length - 1] += srcRemaining;
    }
    srcIdx++;
    if (srcIdx < sendable.length) {
      srcRemaining = sendable[srcIdx].balance - FEE_BUFFER;
    }
  }

  // 6. Show simulation
  console.log("=== Distribution Simulation ===\n");
  console.log(
    "Mid # | Mid Public Key                                       | Will Receive (SOL)"
  );
  console.log(
    "------+------------------------------------------------------+--------------------"
  );

  let totalToDistribute = 0;
  for (let i = 0; i < midWallets.length; i++) {
    const sol = midTotals[i] / LAMPORTS_PER_SOL;
    totalToDistribute += sol;
    const idx = String(i + 1).padStart(5, " ");
    const solStr = sol.toFixed(9).padStart(18, " ");
    console.log(
      `${idx} | ${midWallets[i].publicKey.toBase58()} | ${solStr}`
    );
  }

  console.log(
    "------+------------------------------------------------------+--------------------"
  );
  console.log(
    `Total to distribute: ${totalToDistribute.toFixed(9)} SOL from ${sendable.length} source wallets`
  );
  console.log(
    `Target per mid wallet: ~${(targetPerMid / LAMPORTS_PER_SOL).toFixed(9)} SOL\n`
  );

  // 7. Ask confirmation
  const confirmed = await askConfirmation(
    "Proceed with distribution? (y/n): "
  );
  if (!confirmed) {
    console.log("Aborted.");
    process.exit(0);
  }

  // 8. Execute transfers (one tx per source, may contain multiple transfer instructions)
  console.log("\nExecuting transfers...\n");

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < sendable.length; i++) {
    const source = sendable[i];
    const txTransfers = transfers[i];
    if (txTransfers.length === 0) continue;

    try {
      // Re-fetch balance to avoid sending more than available
      const currentBalance = await connection.getBalance(source.keypair.publicKey);
      const maxSend = currentBalance - TX_FEE;
      if (maxSend <= 0) {
        console.log(`[${i + 1}/${sendable.length}] ${source.keypair.publicKey.toBase58().slice(0, 8)} skipped (insufficient balance)`);
        continue;
      }

      // Scale down transfer amounts if needed
      const plannedTotal = txTransfers.reduce((s, t) => s + t.amount, 0);
      const scale = plannedTotal > maxSend ? maxSend / plannedTotal : 1;
      const adjustedTransfers = txTransfers.map((t) => ({
        ...t,
        amount: Math.floor(t.amount * scale),
      }));

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");

      const instructions = adjustedTransfers.map((t) =>
        SystemProgram.transfer({
          fromPubkey: source.keypair.publicKey,
          toPubkey: midWallets[t.midIdx].publicKey,
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

      const totalSent = adjustedTransfers.reduce((s, t) => s + t.amount, 0);
      const targets = adjustedTransfers.map((t) => `mid_${t.midIdx + 1}`).join(",");
      console.log(
        `[${i + 1}/${sendable.length}] ${source.keypair.publicKey
          .toBase58()
          .slice(0, 8)} -> ${targets} | ${(
          totalSent / LAMPORTS_PER_SOL
        ).toFixed(6)} SOL | tx: ${signature}`
      );

      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );
      successCount++;
    } catch (e) {
      console.error(
        `[${i + 1}/${sendable.length}] FAILED ${source.keypair.publicKey
          .toBase58()
          .slice(0, 8)}: ${e}`
      );
      failCount++;
    }

    if (i < sendable.length - 1) {
      await sleep(1000);
    }
  }

  // 9. Show final mid balances
  console.log("\n=== Final Mid Wallet Balances ===\n");
  console.log(
    "Mid # | Public Key                                         | SOL Balance"
  );
  console.log(
    "------+------------------------------------------------------+------------"
  );

  let totalMid = 0;
  for (let i = 0; i < midWallets.length; i++) {
    const balance = await connection.getBalance(midWallets[i].publicKey);
    const sol = balance / LAMPORTS_PER_SOL;
    totalMid += sol;
    const idx = String(i + 1).padStart(5, " ");
    const solStr = sol.toFixed(9).padStart(14, " ");
    console.log(`${idx} | ${midWallets[i].publicKey.toBase58()} | ${solStr}`);
  }

  console.log(
    "------+------------------------------------------------------+------------"
  );
  console.log(`Total mid: ${totalMid.toFixed(9)} SOL`);
  console.log(`\nDone. Success: ${successCount}, Failed: ${failCount}`);
}

main().catch(console.error);
