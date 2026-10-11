import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { ethers } from "ethers";
import Database from "better-sqlite3";
import crypto from "node:crypto";

const app = express();
app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(express.json({ limit: "20kb" }));

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const PORT = Number(process.env.PORT || 3000);
const FRONTEND_ORIGIN = required("FRONTEND_ORIGIN");
const RECEIVER = ethers.getAddress(required("RECEIVER_ADDRESS"));
const RPC_URL = required("ETHEREUM_RPC_URL");
const TOKEN_SECRET = required("TOKEN_SECRET");
const GITHUB_TOKEN = required("GITHUB_TOKEN");
const GITHUB_REPO = process.env.GITHUB_REPO || "axaxayacatl/pale-circuit-store-private";
const PDF_PATH = process.env.PDF_PATH || "products/sensationsmodule.pdf";
const PRICE_USD = Number(process.env.PRODUCT_PRICE_USD || 9);
const MIN_CONFIRMATIONS = Math.max(1, Number(process.env.MIN_CONFIRMATIONS || 2));
const QUOTE_TTL_SECONDS = Math.max(60, Number(process.env.QUOTE_TTL_SECONDS || 600));
const DOWNLOAD_TTL_SECONDS = Math.max(300, Number(process.env.DOWNLOAD_TTL_SECONDS || 2592000));

if (TOKEN_SECRET.length < 32) throw new Error("TOKEN_SECRET must be at least 32 characters long.");
if (!Number.isFinite(PRICE_USD) || PRICE_USD <= 0) throw new Error("PRODUCT_PRICE_USD is invalid.");
if (!Number.isInteger(MIN_CONFIRMATIONS)) throw new Error("MIN_CONFIRMATIONS must be an integer.");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(GITHUB_REPO)) throw new Error("GITHUB_REPO must be owner/repository.");
if (PDF_PATH.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid PDF_PATH.");

const provider = new ethers.JsonRpcProvider(RPC_URL, 1, { staticNetwork: true });
const db = new Database(process.env.DATABASE_PATH || "./purchases.sqlite");
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS purchases (
    tx_hash TEXT PRIMARY KEY,
    wallet TEXT NOT NULL,
    amount_wei TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
const savePurchase = db.prepare(`INSERT OR IGNORE INTO purchases
  (tx_hash,wallet,amount_wei,block_number,created_at)
  VALUES (@tx_hash,@wallet,@amount_wei,@block_number,@created_at)`);
const getPurchase = db.prepare("SELECT * FROM purchases WHERE tx_hash = ?");

function signPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}
function readPayload(token) {
  if (typeof token !== "string" || token.length > 4096) throw new Error("Invalid token.");
  const pieces = token.split(".");
  if (pieces.length !== 2) throw new Error("Invalid token.");
  const [body, signature] = pieces;
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest();
  const supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) throw new Error("Invalid token signature.");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!Number.isInteger(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Token expired. Start checkout again.");
  return payload;
}
async function getEthUsd() {
  const response = await fetch("https://api.coinbase.com/v2/exchange-rates?currency=ETH", { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("ETH pricing service unavailable.");
  const json = await response.json();
  const rate = Number(json?.data?.rates?.USD);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("Invalid ETH price.");
  return rate;
}
async function fetchPrivatePdf() {
  const encodedPath = PDF_PATH.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodedPath}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.raw+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pale-circuit-diary-checkout"
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) {
    console.error("Private PDF fetch failed:", response.status);
    throw new Error("Private PDF storage could not be accessed.");
  }
  const pdf = Buffer.from(await response.arrayBuffer());
  if (pdf.length < 5 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("Configured private file is not a valid PDF.");
  return pdf;
}
function validHash(hash) { return typeof hash === "string" && /^0x[a-fA-F0-9]{64}$/.test(hash); }
function validAddress(address) { return typeof address === "string" && ethers.isAddress(address); }
function sendPdf(res, pdf) {
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": 'attachment; filename="pale-circuit-diary.pdf"',
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff"
  });
  return res.status(200).send(pdf);
}

app.use("/api", cors({
  origin(origin, callback) {
    if (!origin || origin === FRONTEND_ORIGIN) return callback(null, true);
    return callback(new Error("Origin not allowed."));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}), rateLimit({ windowMs: 60000, limit: 30, standardHeaders: true, legacyHeaders: false }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "pale-circuit-checkout", chainId: 1 }));

app.get("/api/quote", async (_req, res) => {
  try {
    const ethUsd = await getEthUsd();
    const amountWei = ethers.parseEther((PRICE_USD / ethUsd).toFixed(8));
    const now = Math.floor(Date.now() / 1000);
    const quote = signPayload({ v: 1, amountWei: amountWei.toString(), priceUsd: PRICE_USD, exp: now + QUOTE_TTL_SECONDS, nonce: crypto.randomUUID() });
    res.set("Cache-Control", "no-store");
    res.json({ currency: "ETH", chainId: 1, receiver: RECEIVER, priceUsd: PRICE_USD, ethUsd, amountWei: amountWei.toString(), amountEth: ethers.formatEther(amountWei), expiresAt: now + QUOTE_TTL_SECONDS, quote });
  } catch (error) {
    console.error("Quote error:", error.message);
    res.status(503).json({ error: "Unable to create a checkout quote right now." });
  }
});

app.post("/api/verify-and-deliver", async (req, res) => {
  try {
    const { txHash, wallet, quote } = req.body || {};
    if (!validHash(txHash)) return res.status(400).json({ error: "Invalid transaction hash." });
    if (!validAddress(wallet)) return res.status(400).json({ error: "Invalid wallet address." });
    const quoteData = readPayload(quote);
    if (quoteData.v !== 1 || typeof quoteData.amountWei !== "string" || !/^\d+$/.test(quoteData.amountWei)) return res.status(400).json({ error: "Invalid checkout quote." });

    const normalizedHash = txHash.toLowerCase();
    let purchase = getPurchase.get(normalizedHash);

    if (purchase) {
      if (purchase.wallet.toLowerCase() !== wallet.toLowerCase()) return res.status(403).json({ error: "This transaction belongs to another wallet." });
    } else {
      const network = await provider.getNetwork();
      if (network.chainId !== 1n) throw new Error("Payment verifier is not connected to Ethereum Mainnet.");
      const tx = await provider.getTransaction(txHash);
      if (!tx) return res.status(202).json({ pending: true, error: "Transaction not yet available. Retry shortly." });
      if (tx.chainId !== 1n) return res.status(400).json({ error: "Transaction is not on Ethereum Mainnet." });
      if (!tx.to || tx.to.toLowerCase() !== RECEIVER.toLowerCase()) return res.status(400).json({ error: "Transaction recipient does not match." });
      if (tx.from.toLowerCase() !== wallet.toLowerCase()) return res.status(400).json({ error: "Wallet does not match transaction sender." });
      if (tx.value < BigInt(quoteData.amountWei)) return res.status(400).json({ error: "Payment is below the signed checkout quote." });
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) return res.status(202).json({ pending: true, error: "Payment is not yet confirmed. Retry shortly." });
      const currentBlock = await provider.getBlockNumber();
      const confirmations = currentBlock - receipt.blockNumber + 1;
      if (confirmations < MIN_CONFIRMATIONS) return res.status(202).json({ pending: true, confirmations, requiredConfirmations: MIN_CONFIRMATIONS, error: "Waiting for additional confirmations." });
      purchase = {
        tx_hash: normalizedHash,
        wallet: tx.from.toLowerCase(),
        amount_wei: tx.value.toString(),
        block_number: receipt.blockNumber,
        created_at: Math.floor(Date.now() / 1000)
      };
      savePurchase.run(purchase);
      purchase = getPurchase.get(normalizedHash);
    }

    const downloadToken = signPayload({ v: 1, txHash: purchase.tx_hash, exp: Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS });
    const pdf = await fetchPrivatePdf();
    res.set("X-Payment-Verified", "true");
    res.set("X-Download-Token", downloadToken);
    return sendPdf(res, pdf);
  } catch (error) {
    console.error("Verification/delivery error:", error.message);
    return res.status(400).json({ error: error.message || "Unable to verify payment or deliver PDF." });
  }
});

app.get("/api/download/:token", async (req, res) => {
  try {
    const payload = readPayload(req.params.token);
    if (payload.v !== 1 || !validHash(payload.txHash)) return res.status(400).json({ error: "Invalid download token." });
    const purchase = getPurchase.get(payload.txHash.toLowerCase());
    if (!purchase) return res.status(403).json({ error: "No verified purchase found." });
    const pdf = await fetchPrivatePdf();
    return sendPdf(res, pdf);
  } catch (error) {
    console.error("Download error:", error.message);
    return res.status(403).json({ error: "Download token invalid or expired." });
  }
});

app.use((error, _req, res, _next) => {
  if (error.message === "Origin not allowed.") return res.status(403).json({ error: error.message });
  console.error(error.message);
  res.status(500).json({ error: "Internal server error." });
});

app.listen(PORT, () => console.log(`Pale Circuit checkout backend listening on port ${PORT}`));
