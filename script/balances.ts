import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

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
  "mainnet-beta": "https://mainnet.helius-rpc.com/?api-key=e26bf879-6bb4-49c0-aafa-8e4d86687455",
  testnet: "https://solana-testnet-rpc.publicnode.com",
  devnet: "https://devnet.helius-rpc.com/?api-key=e26bf879-6bb4-49c0-aafa-8e4d86687455",
};

interface WalletInfo {
  index: number;
  publicKey: string;
  secretKey: string;
  createdAt: string;
}

async function main() {
  const network = process.env.SOLANA_NETWORK || "testnet";
  const rpcUrl = RPC_URLS[network] || RPC_URLS["testnet"];
  const walletsDir = path.join(__dirname, "..", "walletsOrigin");

  console.log(`Network: ${network}`);
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Wallets dir: ${walletsDir}\n`);

  if (!fs.existsSync(walletsDir)) {
    console.error("Wallets directory not found");
    process.exit(1);
  }

  const files = fs
    .readdirSync(walletsDir)
    .filter((f) => f.startsWith("wallet_") && f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    console.error("No wallet files found");
    process.exit(1);
  }

  const connection = new Connection(rpcUrl, "confirmed");

  console.log(`Found ${files.length} wallets\n`);
  console.log("Index | Public Key                                         | SOL Balance");
  console.log("------+------------------------------------------------------+------------");

  let totalBalance = 0;
  let funded = 0;

  for (const file of files) {
    const filePath = path.join(walletsDir, file);
    const data: WalletInfo = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const keypair = Keypair.fromSecretKey(bs58.decode(data.secretKey));
    const pubkey = keypair.publicKey.toBase58();

    try {
      const balance = await connection.getBalance(keypair.publicKey);
      const sol = balance / LAMPORTS_PER_SOL;
      totalBalance += sol;
      if (balance > 0) funded++;

      const idx = String(data.index).padStart(5, " ");
      const solStr = sol.toFixed(9).padStart(14, " ");
      console.log(`${idx} | ${pubkey} | ${solStr}`);
    } catch (e) {
      const idx = String(data.index).padStart(5, " ");
      console.log(`${idx} | ${pubkey} | ERROR`);
    }
  }

  console.log("------+------------------------------------------------------+------------");
  console.log(`Total: ${totalBalance.toFixed(9)} SOL | Funded: ${funded}/${files.length}`);
}

main().catch(console.error);
