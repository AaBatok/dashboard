/**
 * ╔══════════════════════════════════════════════════════╗
 * ║       🤖 CANTOR8 MULTI-ACCOUNT WALLET BOT V2        ║
 * ║    Auto CC ↔ USDCX Round-Trip Swap (Parallel)       ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * Usage: node index.js
 * Config: config.json (accounts[], swap settings, API URLs)
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import { randomBytes } from 'crypto';
import http from 'http';
import https from 'https';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import axios from 'axios';
import chalk from 'chalk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';

// ── Setup ────────────────────────────────────────────────────────────────
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

// ── Command Poller (dashboard → VPS, runs in background) ────────────────
import './command_poller.js';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf-8'));

// ── Load accounts: .env → fallback accounts.json ──
// Di VPS tinggal rename accounts.json → .env, format sama persis (1 mnemonic per baris)
// Baris yang ada = atau # otomatis di-skip
let accountLines = [];
const envPath = new URL('./.env', import.meta.url);

try {
    const envRaw = readFileSync(envPath, 'utf-8');
    accountLines = envRaw.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#') && !l.includes('='));

    if (accountLines.length > 0) {
        console.log(chalk.green(`✅ Loaded ${accountLines.length} accounts from .env`));
    }
} catch { /* .env not found, will try accounts.json */ }

if (accountLines.length === 0) {
    // Fallback: baca accounts.json
    try {
        accountLines = readFileSync(new URL('./accounts.json', import.meta.url), 'utf-8')
            .split('\n').map(l => l.trim()).filter(l => l.length > 0);
        console.log(chalk.yellow(`📄 Loaded ${accountLines.length} accounts from accounts.json`));
    } catch {
        console.error(chalk.red('❌ No accounts found! Rename accounts.json → .env atau buat accounts.json'));
        process.exit(1);
    }
}

let proxyLines = [];
try {
    proxyLines = readFileSync(new URL('./proxy.txt', import.meta.url), 'utf-8')
        .split('\n').map(l => l.trim()).filter(l => l.length > 0);
} catch { /* proxy.txt optional */ }

config.accounts = accountLines.map((mnemonic, i) => ({
    name: `Acc ${i + 1}`,
    mnemonic,
    proxy: proxyLines[i] || '',
}));

const BACKEND = config.api.backend_url;
const SWAP_API = config.api.swap_url;
const EXCHANGE = config.api.exchange_url;

const ASSET_TO_INSTRUMENT = { '0x0': 'Amulet', 'USDCX': 'USDCx', 'CETH': 'cETH' };
const CETH_INST_ADMIN = 'rails-cethMain-1::12200350ba6e96e3b701c3048b5aa013a8c1c08833e8ebf54339cff581055c29003a';

// ── Active Pair Mode (set at startup) ────────────────────────────────────
let activePairMode = 'USDCX'; // 'USDCX' or 'CETH'
let swapMode = 4; // 1=CC↔USDCx, 2=CC↔CETH, 3=Triangular, 4=Extended, 5=Consolidate, 6=SmartConsol, 7=StuckOrder, 8=Extended4Step

const CC_ASSET_KEYS = ['Amulet', 'CC (Amulet)', 'CC'];
const USDCX_ASSET_KEYS = ['USDCx', 'USDCX'];
const CETH_ASSET_KEYS = ['cETH', 'CETH'];
const RCC_ASSET_KEYS = ['rCC', 'RCC', 'rcc', 'Rebate CC'];

function getPairBAssetKeys() {
    return activePairMode === 'CETH' ? CETH_ASSET_KEYS : USDCX_ASSET_KEYS;
}
function getPairBLabel() {
    return activePairMode === 'CETH' ? 'CETH' : 'USDCx';
}

function getPairBDecimals() {
    return activePairMode === 'CETH' ? 8 : 4;
}
function getHoldingBal(holdings, keys) {
    for (const k of keys) {
        if (holdings?.[k]?.balance != null) return holdings[k].balance;
    }
    return 0;
}
function getActivePairB() {
    return activePairMode === 'CETH'
        ? (config.swap.pair_ceth || { chain: 'CC', asset: 'CETH', label: 'CETH' })
        : config.swap.pair_b;
}

// ── Dynamic Minimum Swap Config (SIMPLE) ─────────────────────────────────
const dynamicMinSwap = {
    enabled: config.swap?.dynamic_minimum_swap?.enabled ?? false,
    extraCc: config.swap?.dynamic_minimum_swap?.extra_cc ?? 1.5,
    fallbackMin: config.swap?.dynamic_minimum_swap?.fallback_min || config.swap.min_amount || 27,
    lastRawMin: null,
};

// ═══════════════════════════════════════════════════════════
// ── TOGGLE SWITCHES (edit di sini buat on/off) ──
// ═══════════════════════════════════════════════════════════
// Mode 4: Top-up rescue → swap gagal "below minimum" → pakai CC sendiri buat top-up pair
const ENABLE_MODE4_TOPUP_RESCUE = false;
// Mode 4: Cross-wallet helper → wallet stuck minta CC dari wallet lain
const ENABLE_MODE4_HELPER = false;
// Adaptive Rate Limit: true = pakai adaptiveRL learner (auto-adjust cooldown dari observed gap)
//                      false = pakai fixed rate_limit_wait_seconds + 3m buffer (seperti normal.js)
const ENABLE_ADAPTIVE_RATE_LIMIT = false;
// ═══════════════════════════════════════════════════════════

// ── Adaptive Rate Limit Learner ──────────────────────────────────────────
// Cara kerja: ukur jarak waktu antar first-swap tiap cycle.
// Cycle 1 first swap: 20:45 → Cycle 2 first swap: 21:45 → gap = 60m
// Pakai gap itu sebagai cooldown cycle berikutnya + buffer 3m.
// Kalau kena 429, probe tiap 5m sampai berhasil, lalu record gap baru.
const adaptiveRL = {
    lastFirstSwapMs: 0,            // timestamp first swap cycle sebelumnya
    observedGaps: [],              // gap (detik) antar cycle yang sukses
    probeIntervalSec: 5 * 60,      // probe tiap 5 menit kalau kena 429
    bufferSec: 3 * 60,             // buffer 3 menit
    minCooldownSec: 15 * 60,       // minimum 15 menit
    maxCooldownSec: 4 * 3600,      // maximum 4 jam

    // Dipanggil saat first swap cycle BERHASIL — record gap dari cycle sebelumnya
    recordSuccess(firstSwapMs) {
        if (this.lastFirstSwapMs > 0 && firstSwapMs > this.lastFirstSwapMs) {
            const gapSec = Math.round((firstSwapMs - this.lastFirstSwapMs) / 1000);
            this.observedGaps.push(gapSec);
            if (this.observedGaps.length > 10) this.observedGaps.shift();
        }
        this.lastFirstSwapMs = firstSwapMs;
    },

    // Hitung cooldown optimal dari rata-rata 3 gap terakhir
    getCooldownSeconds() {
        if (this.observedGaps.length === 0) {
            // Belum ada data → pakai config default + buffer
            return (config.swap.rate_limit_wait_seconds || 3600) + this.bufferSec;
        }
        // Rata-rata 3 gap terakhir + buffer (bisa naik DAN turun)
        const recent = this.observedGaps.slice(-3);
        const avgGap = Math.round(recent.reduce((a, b) => a + b, 0) / recent.length);
        return Math.min(this.maxCooldownSec, Math.max(this.minCooldownSec, avgGap + this.bufferSec));
    },

    getCooldownMinutes() { return Math.round(this.getCooldownSeconds() / 60); },

    // Status untuk logging
    getStatus() {
        if (this.observedGaps.length === 0) return 'no data, using default';
        const gaps = this.observedGaps.map(g => Math.round(g / 60) + 'm');
        return 'gaps: [' + gaps.join(', ') + '] → cooldown: ' + this.getCooldownMinutes() + 'm';
    },
};


// ── Swap State Persistence (survive restarts) ─────────────────────────
const SWAP_STATE_FILE = new URL('./swap_state.json', import.meta.url);
let swapState = {};
try { swapState = JSON.parse(readFileSync(SWAP_STATE_FILE, 'utf-8')); } catch { /* no state file */ }

function saveSwapState() {
    try { writeFileSync(SWAP_STATE_FILE, JSON.stringify(swapState, null, 2)); } catch { /* ignore */ }
}

function getAccState(idx) {
    const key = 'acc_' + (idx + 1);
    if (!swapState[key]) swapState[key] = {};
    return swapState[key];
}

// Headers untuk wallet-backend (cantor8 wallet) — domain wallet.cantor8.tech
const BASE_HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://wallet.cantor8.tech',
    'Referer': 'https://wallet.cantor8.tech/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
};

// Headers untuk swap API (api.vectornine.tech) — domain exchange.cantor8.tech
const SWAP_HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://exchange.cantor8.tech',
    'Referer': 'https://exchange.cantor8.tech/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
};

const TOKEN_MAX_AGE_MS = 45 * 60 * 1000;
const SETUP_WAIT_MAX = 30;   // max retries waiting for account setup (422) — ~15 min at 30s intervals
const SETUP_WAIT_SEC = 10;   // seconds between setup retries

// ── Crypto ───────────────────────────────────────────────────────────────

function generateKeyPairs(mnemonic) {
    const { path_prefix, path_suffix, key_count } = config.derivation;
    const seed = mnemonicToSeedSync(mnemonic, '');
    const hdkey = HDKey.fromMasterSeed(seed);
    const keyPairs = [];
    for (let i = 0; i < key_count; i++) {
        const path = `${path_prefix}/${i}'/${path_suffix}`;
        const child = hdkey.derive(path);
        const privateKey = child.privateKey;
        if (!privateKey || privateKey.length !== 32) throw new Error(`Key derivation failed at ${path}`);
        const publicKey = ed.getPublicKey(privateKey);
        keyPairs.push({
            index: i, path, privateKey, publicKey,
            publicKeyHex: Buffer.from(publicKey).toString('hex'),
        });
    }
    return keyPairs;
}

function signMessage(privateKey, message) {
    const msg = typeof message === 'string' ? new TextEncoder().encode(message) : message;
    return ed.sign(msg, privateKey);
}

function toHex(bytes) { return Buffer.from(bytes).toString('hex'); }
function toBase64(bytes) { return Buffer.from(bytes).toString('base64'); }

/**
 * Sign and finalize pending delegation transactions (rebate_cc_delegation_v12, yiksi-auto-accept-*, etc).
 * Call after login or periodically to ensure all delegations are active.
 * @returns {number} Number of transactions signed, or -1 on error
 */
async function signAndFinaliseDelegations(walletApi, session, log) {
    try {
        const confirmResp = await walletApi.postConfirmV2(session.walletToken);
        const txToSign = confirmResp?.transactions_to_sign || [];
        if (txToSign.length === 0) return 0;

        log(`🔏 ${txToSign.length} delegation tx: ${txToSign.map(t => t.code).join(', ')}`);

        const signedTxs = txToSign.map(tx => {
            const hashBytes = Buffer.from(tx.hash_b64, 'base64');
            const signature = signMessage(session.keyPair.privateKey, hashBytes);
            return {
                code: tx.code,
                prepared_tx_b64: tx.prepared_tx_b64,
                hashing_scheme_version: tx.hashing_scheme_version,
                signature_b64: Buffer.from(signature).toString('base64'),
            };
        });

        await walletApi.finaliseV3(session.walletToken, signedTxs);
        log(`✅ ${txToSign.length} delegations finalized`);

        if (txToSign.some(t => t.code.includes('rebate_cc_delegation'))) {
            log('🟣 rebate_cc_delegation signed → rCC akan landing!');
        }
        return txToSign.length;
    } catch (err) {
        log(`⚠️ Delegation signing: ${err.response?.status || err.message || 'error'}`);
        return -1;
    }
}

function generateOrderId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = randomBytes(20);
    let id = 'ord_';
    for (let i = 0; i < 20; i++) id += chars[bytes[i] % chars.length];
    return id;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const sleep = (sec) => new Promise(r => setTimeout(r, sec * 1000));
const shortId = (id) => id.length > 20 ? `${id.slice(0, 12)}...${id.slice(-8)}` : id;

// ── Telegram Notifications ───────────────────────────────────────────────
async function sendTelegramMessage(text) {
    const tcfg = config.telegram;
    if (!tcfg?.enabled || !tcfg?.bot_token || !tcfg?.user_id) return;
    try {
        const url = `https://api.telegram.org/bot${tcfg.bot_token}/sendMessage`;
        await axios.post(url, {
            chat_id: tcfg.user_id,
            text: text,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
    } catch (err) { }
}

async function sendSwapNotification(ctx, type, sendAmount, result, fromPair, toPair, stepReward = 0) {
    if (!config.telegram?.enabled) return;
    const { index } = ctx;
    const a = dashboard.accounts[index];
    if (!a) return;

    const pairLabel = getPairBLabel();
    const pairDec = getPairBDecimals();

    // Use actual pair labels if provided, fallback to legacy logic
    let fromSymbol, toSymbol, nextText, recvDec;
    if (fromPair && toPair) {
        fromSymbol = fromPair.label || fromPair.asset;
        toSymbol = toPair.label || toPair.asset;
        recvDec = toPair.asset === 'CETH' ? 10 : toPair.asset === '0x0' ? 4 : 4;
        // Detect next step in chain (mode 8 = 4-step, mode 3/4 = 3-step)
        const chainFlow = swapMode === 8
            ? ['CC', 'USDCx', 'CETH', 'USDCx', 'CC']   // 4-step: next is index+1
            : ['CC', 'USDCx', 'CETH', 'CC'];            // 3-step: next is index+1
        // Find current "to" in the chain flow to predict next step
        const toAsset = toPair.asset === '0x0' ? 'CC' : toPair.asset === 'USDCX' ? 'USDCx' : toPair.asset;
        const fromAsset = fromPair.asset === '0x0' ? 'CC' : fromPair.asset === 'USDCX' ? 'USDCx' : fromPair.asset;
        // Match from→to in chainFlow to find position
        let nextText2 = '';
        for (let ci = 0; ci < chainFlow.length - 1; ci++) {
            if (chainFlow[ci] === fromAsset && chainFlow[ci + 1] === toAsset && ci + 2 < chainFlow.length) {
                nextText2 = chainFlow[ci + 1] + ' → ' + chainFlow[ci + 2];
                break;
            }
        }
        nextText = nextText2 || (toAsset + ' → CC');
    } else {
        const isMain = type === 'MAIN';
        fromSymbol = isMain ? 'CC' : pairLabel;
        toSymbol = isMain ? pairLabel : 'CC';
        nextText = isMain ? `${pairLabel} → CC` : `CC → ${pairLabel}`;
        recvDec = pairDec;
    }

    const receiveAmount = typeof result === 'object' ? result?.receiveAmount : result;
    const swapData = typeof result === 'object' ? result : {};

    const formatUptimeLocal = (startMs) => {
        const sec = Math.floor((Date.now() - startMs) / 1000);
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
        return `${m}m${String(s).padStart(2, '0')}s`;
    };
    const uptimeStr = formatUptimeLocal(a.startTime);

    const now = new Date();
    const wibDate = new Date(now.getTime() + (420 + now.getTimezoneOffset()) * 60000);
    let dateStr = wibDate.toLocaleString('en-GB', { hour12: false }) + ' WIB';
    try {
        const d = String(wibDate.getDate()).padStart(2, '0');
        const m = String(wibDate.getMonth() + 1).padStart(2, '0');
        const y = wibDate.getFullYear();
        const t = wibDate.toTimeString().split(' ')[0];
        dateStr = `${d}/${m}/${y} ${t} WIB`;
    } catch (e) { }

    // For triangular modes (3/4/8), show both USDCx + CETH
    const balLine = (swapMode === 3 || swapMode === 4 || swapMode === 8)
        ? `💰 <code>${a.cc.toFixed(4)} CC</code> | <code>${(a.usdcx ?? 0).toFixed(4)} USDCx</code> | <code>${(a.ceth ?? 0).toFixed(10)} CETH</code> | 🟣 <code>${(a.rcc ?? 0).toFixed(4)} rCC</code>`
        : `💰 <code>${a.cc.toFixed(5)} CC</code>  |  <code>${(activePairMode === 'CETH' ? (a.ceth ?? 0) : a.usdcx).toFixed(pairDec)} ${pairLabel}</code> | 🟣 <code>${(a.rcc ?? 0).toFixed(4)} rCC</code>`;

    // TX Detail block
    let txBlock = '';
    const fee = swapData.fee ?? 0;
    const slippagePct = (swapData.slippageBps ?? 200) / 100;
    const userTx = swapData.userTxId || '';
    const solverTx = swapData.solverTxId || '';
    txBlock += `\n\n<b>📋 TX Detail</b>\n`;
    txBlock += `  ↕️ Dir     : <code>OUT</code>\n`;
    txBlock += `  💸 Amount  : <code>${parseFloat(sendAmount || 0).toFixed(4)} ${fromSymbol}</code>\n`;
    txBlock += `  🔖 Fee TX  : <code>${parseFloat(fee).toFixed(6)} ${fromSymbol}</code>\n`;
    txBlock += `  📐 Slippage: <code>${slippagePct.toFixed(1)}%</code>\n`;
    if (userTx) txBlock += `  📤 <a href='https://ccview.io/updates/${userTx}/'>Send TX</a>\n`;
    if (solverTx) txBlock += `  📥 <a href='https://ccview.io/updates/${solverTx}/'>Recv TX</a>\n`;
    if (stepReward > 0) {
        txBlock += `  🟣 rCC Gain : <code>+${stepReward.toFixed(4)} rCC</code> <i>(landed)</i>\n`;
    }

    // Leaderboard block with delta
    let lbBlock = '';
    if (a.rank > 0 || a.monthReward > 0) {
        const medal = a.rank === 1 ? '🥇' : a.rank === 2 ? '🥈' : a.rank === 3 ? '🥉' : '🏅';
        const deltaRcc = (a.diffRcc || 0) > 0 ? ` <code>(+${(a.diffRcc || 0).toFixed(4)} rCC)</code>` : '';
        lbBlock += `\n\n<b>📊 Leaderboard</b>\n`;
        lbBlock += `  ${medal} Rank      : <b>#${a.rank}</b>\n`;
        lbBlock += `  🔄 Swaps     : <code>${a.monthTxns}</code>\n`;
        lbBlock += `  📈 Volume    : <code>$${a.monthVolume.toFixed(2)}</code>\n`;
        lbBlock += `  🟣 rCC Bal   : <code>${(a.rcc ?? 0).toFixed(4)} rCC</code>${deltaRcc}\n`;
        lbBlock += `  🟡 Pending   : <code>${a.pendingReward.toFixed(4)} CC</code> <i>(belum convert)</i>\n`;
        lbBlock += `  💰 Total Rew : <code>${a.totalReward.toFixed(4)} CC</code>`;
    }

    const text = `✅ <b>Swap #${a.totalSwaps} done</b>\n` +
        `👤 ${a.name}\n` +
        `──────────────────\n` +
        `📤 <code>${parseFloat(sendAmount || 0).toFixed(4)} ${fromSymbol}</code>  →  <code>${parseFloat(receiveAmount || 0).toFixed(recvDec)} ${toSymbol}</code>\n` +
        `➡️ next: <code>${nextText}</code>\n` +
        `⏱️ ${uptimeStr}\n\n` +
        `${balLine}` +
        `${txBlock}${lbBlock}\n<i>${dateStr}</i>`;

    await sendTelegramMessage(text);
}




// ── Cycle Notification (Full Circular Swap P/L + Rebates) ────────────────

async function sendCycleNotification(ctx, cycle, rounds, info) {
    if (!config.telegram?.enabled) return;
    const { index } = ctx;
    const a = dashboard.accounts[index];
    if (!a) return;

    const { ccCycleStart, ccCycleEnd, spreadLoss, totalCcSent, totalCcReceived, rebatesBefore, rebatesAfter, rewardGain, netPL, stepFailed, totalSwaps: swaps, legRewards, rccBefore, rccAfter } = info;

    const formatUptimeLocal = (startMs) => {
        const sec = Math.floor((Date.now() - startMs) / 1000);
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
        return `${m}m${String(s).padStart(2, '0')}s`;
    };
    const uptimeStr = formatUptimeLocal(a.startTime);

    const now = new Date();
    const wibDate = new Date(now.getTime() + (420 + now.getTimezoneOffset()) * 60000);
    let dateStr;
    try {
        const d = String(wibDate.getDate()).padStart(2, '0');
        const mo = String(wibDate.getMonth() + 1).padStart(2, '0');
        const y = wibDate.getFullYear();
        const t = wibDate.toTimeString().split(' ')[0];
        dateStr = `${d}/${mo}/${y} ${t} WIB`;
    } catch { dateStr = wibDate.toLocaleString('en-GB', { hour12: false }) + ' WIB'; }

    const plIcon = netPL >= 0 ? '✅' : '❌';
    const plSign = netPL >= 0 ? '+' : '';
    const status = stepFailed ? '⚠️ INCOMPLETE' : '✅ SELESAI';

    let text = `🔁 <b>Siklus #${cycle}/${rounds} ${status}</b>\n`;
    text += `👤 ${a.name}\n`;
    text += `──────────────────\n`;
    text += `💰 CC Awal     : <code>${ccCycleStart.toFixed(4)} CC</code>\n`;
    text += `💰 CC Akhir    : <code>${ccCycleEnd.toFixed(4)} CC</code>\n`;
    text += `📉 Spread Loss : <code>-${spreadLoss.toFixed(4)} CC</code>\n`;
    text += `──────────────────\n`;
    const rccGain = (rccAfter || 0) - (rccBefore || 0);
    text += `🟣 rCC Before   : <code>${(rccBefore || 0).toFixed(4)} rCC</code>\n`;
    text += `🟣 rCC After    : <code>${(rccAfter || 0).toFixed(4)} rCC</code>\n`;
    text += `🟢 rCC Gained   : <code>+${rccGain.toFixed(4)} rCC</code>\n`;
    if (rebatesBefore > 0 || rebatesAfter > 0) {
        text += `🟡 Pending CC   : <code>${rebatesAfter.toFixed(4)} CC</code> <i>(belum convert)</i>\n`;
    }
    // Per-leg rCC breakdown
    if (legRewards && legRewards.some(r => r > 0)) {
        const _legLabels = legRewards.length === 4
            ? ['CC→USDCx', 'USDCx→CETH', 'CETH→USDCx', 'USDCx→CC']
            : ['CC→USDCx', 'USDCx→CETH', 'CETH→CC'];
        legRewards.forEach((r, i) => {
            const _p = i < legRewards.length - 1 ? '├' : '└';
            text += `  ${_p} ${_legLabels[i].padEnd(10)}: <code>+${r.toFixed(4)} rCC</code>\n`;
        });
    }
    text += `──────────────────\n`;
    text += `📊 Net P/L: <code>${plSign}${netPL.toFixed(4)} CC</code> ${plIcon} (${netPL >= 0 ? 'UNTUNG' : 'RUGI'})\n`;
    text += `──────────────────\n`;
    text += `💰 <code>${ccCycleEnd.toFixed(4)} CC</code> | <code>${(a.usdcx ?? 0).toFixed(4)} USDCx</code> | <code>${(a.ceth ?? 0).toFixed(10)} CETH</code> | 🟣 <code>${(a.rcc ?? 0).toFixed(4)} rCC</code>\n`;
    text += `🔄 Total swaps: ${swaps}\n`;
    text += `⏱️ ${uptimeStr}\n`;

    if (a.rank > 0) {
        const medal = a.rank === 1 ? '🥇' : a.rank === 2 ? '🥈' : a.rank === 3 ? '🥉' : '🏅';
        const deltaRcc = (a.diffRcc || 0) > 0 ? ` (+${(a.diffRcc || 0).toFixed(4)} rCC)` : '';
        text += `${medal} #${a.rank} | 🔄 ${a.monthTxns} swaps | 🟣 ${(a.rcc ?? 0).toFixed(4)} rCC${deltaRcc}\n`;
    }

    text += `<i>${dateStr}</i>`;
    await sendTelegramMessage(text);
}

// ── Random Delay Helpers ─────────────────────────────────────────────────
function getRandomDelay(minSec, maxSec) {
    return Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
}

function formatDelayTime(seconds) {
    if (seconds >= 60) {
        const min = Math.floor(seconds / 60);
        const sec = seconds % 60;
        return sec > 0 ? `${min}m${sec}s` : `${min}m`;
    }
    return `${seconds}s`;
}

// ── Fetch Dynamic Minimum Swap (SIMPLE - fetch fresh setiap swap) ────────
// Flow: fetch minimum dari API → tambah extra → Math.max dengan config min_amount
async function fetchDynamicMinSwap(swapApi, log) {
    if (!dynamicMinSwap.enabled) return config.swap.min_amount;

    const { pair_a } = config.swap;
    const pair_b = getActivePairB();
    const configMin = config.swap.min_amount || 27;

    try {
        // Fetch minimum dari API
        const rawMin = await swapApi.getMinimumSwap(pair_a.chain, pair_a.asset, pair_b.chain, pair_b.asset);

        if (rawMin !== null && !isNaN(rawMin) && rawMin > 0) {
            dynamicMinSwap.lastRawMin = rawMin;
            const dynamicAmount = rawMin + dynamicMinSwap.extraCc;
            // Gunakan Math.max: config min_amount sebagai floor guarantee
            const swapAmount = Math.max(dynamicAmount, configMin);
            log(`📊 Min: ${rawMin}CC + ${dynamicMinSwap.extraCc}CC = ${dynamicAmount.toFixed(2)}CC → use ${swapAmount.toFixed(2)}CC (config min: ${configMin})`);
            return swapAmount;
        }
    } catch (err) {
        // Silent fail, use fallback
    }

    // Fallback jika API gagal — tetap pakai Math.max dengan config
    const fallbackAmount = Math.max(dynamicMinSwap.fallbackMin + dynamicMinSwap.extraCc, configMin);
    return fallbackAmount;
}


// ── Fetch minimum for a SPECIFIC pair (for CETH leg) ─────────────────────
async function fetchMinSwapForPair(swapApi, log, fromPair, toPair) {
    const configMin = config.swap.min_amount || 27;
    try {
        const rawMin = await swapApi.getMinimumSwap(fromPair.chain, fromPair.asset, toPair.chain, toPair.asset);
        if (rawMin !== null && !isNaN(rawMin) && rawMin > 0) {
            const extra = dynamicMinSwap.enabled ? dynamicMinSwap.extraCc : 0;
            const dynamicAmount = rawMin + extra;
            // Floor guarantee: minimal sebesar config min_amount
            const swapAmount = Math.max(dynamicAmount, configMin);
            log(`📊 Min ${fromPair.label}→${toPair.label}: ${rawMin}CC + ${extra}CC = ${dynamicAmount.toFixed(2)}CC → use ${swapAmount.toFixed(2)}CC`);
            return swapAmount;
        }
    } catch { /* silent */ }
    const fallback = dynamicMinSwap.enabled
        ? Math.max(dynamicMinSwap.fallbackMin + dynamicMinSwap.extraCc, configMin)
        : configMin;
    return fallback;
}



// ── Retry on Network Error ──────────────────────────────────────────────

const RETRYABLE_CODES = [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND',
    'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
    'ERR_SOCKET_CONNECTION_TIMEOUT', 'ECONNABORTED',
    'ERR_NETWORK', 'EHOSTDOWN', 'ESOCKETTIMEDOUT', 'EADDRINFO',
];

function isRetryableError(err) {
    // 500+ and 429 are NOT retryable here — they have dedicated handlers
    // ERR_BAD_RESPONSE should trigger soft restart, not retry
    if (err.code === 'ERR_BAD_RESPONSE') return false;
    if (RETRYABLE_CODES.includes(err.code)) return true;
    if (err.response?.status === 400) {
        const detail = String(err.response?.data?.detail || err.response?.data?.message || JSON.stringify(err.response?.data || ''));
        if (detail.toLowerCase().includes('challenge')) return true;
    }
    if (err.message?.includes('socket hang up')) return true;
    if (err.message?.includes('ECONNRESET')) return true;
    if (err.message?.includes('network')) return true;
    if (err.message?.includes('timeout')) return true;
    if (err.message?.includes('tunneling socket')) return true;
    if (err.message?.includes('connect ETIMEDOUT')) return true;
    if (err.message?.includes('Proxy')) return true;
    return false;
}

// Escalating retry for rate limit (429) and server rejected (422)
function getEscalatingDelay(attempt, delays) {
    if (attempt < delays.length) return delays[attempt];
    return delays[delays.length - 1]; // max delay forever
}

async function retryOnNetwork(fn, { maxRetries = Infinity, baseDelay = 3, label = '', log = null, onRateLimitRetry = null } = {}) {
    let rateLimitAttempt = 0;
    const rateLimitInitialDelayMin = config.retry?.rate_limit_initial_delay_minutes ?? 15;
    const rateLimitDelays = config.retry?.rate_limit_delays || [5, 10, 10, 10, 10];
    const rateLimitMaxTotalMin = config.retry?.rate_limit_max_total_minutes ?? 60;
    let rateLimitTotalWaitMin = 0; // track cumulative 429 wait
    let consecutiveTimeouts = 0;
    const MAX_CONSECUTIVE_TIMEOUTS = 3;

    for (let attempt = 0; ; attempt++) {
        try {
            const result = await fn();
            consecutiveTimeouts = 0; // reset on success
            return result;
        } catch (err) {
            // 500+ → throw immediately (soft restart by runAccount)
            if (err.response?.status >= 500) throw err;

            // 429 rate limit → 15m first, then +5m, +10m, +10m... until total >= 60m
            if (err.response?.status === 429) {
                let delayMin;
                if (rateLimitAttempt === 0) {
                    delayMin = rateLimitInitialDelayMin;
                } else {
                    delayMin = getEscalatingDelay(rateLimitAttempt - 1, rateLimitDelays);
                }

                // Check if adding this delay would exceed max total
                if (rateLimitTotalWaitMin + delayMin > rateLimitMaxTotalMin) {
                    delayMin = rateLimitMaxTotalMin - rateLimitTotalWaitMin;
                    if (delayMin <= 0) {
                        if (log) log(`❌ Rate limit: total wait ${rateLimitTotalWaitMin}m >= ${rateLimitMaxTotalMin}m — skip`);
                        throw err; // bail out, let caller handle
                    }
                }

                rateLimitTotalWaitMin += delayMin;
                const remaining = rateLimitMaxTotalMin - rateLimitTotalWaitMin;
                if (log) log(`⏳ Rate limited — ${delayMin}m (total: ${rateLimitTotalWaitMin}/${rateLimitMaxTotalMin}m, sisa: ${remaining}m)`);

                rateLimitAttempt++;
                await sleep(delayMin * 60);

                // Callback setelah 429 wait — refresh tokens, quote, orderId
                if (typeof onRateLimitRetry === 'function') {
                    await onRateLimitRetry({ attempt: rateLimitAttempt, delay: delayMin * 60, err });
                }
                continue;
            }

            // 422 → throw immediately (handled specifically by executeSwap with fresh quotes)
            if (err.response?.status === 422) throw err;

            if (!isRetryableError(err)) throw err;

            // Track consecutive connection failures → soft restart after MAX
            const isFatalConn = err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED'
                || err.code === 'ERR_SOCKET_CONNECTION_TIMEOUT'
                || (err.message && err.message.includes('timeout'))
                || (err.message && err.message.includes('stream'));
            if (isFatalConn) {
                consecutiveTimeouts++;
                if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
                    if (log) log(`❌ ${MAX_CONSECUTIVE_TIMEOUTS}x conn fail — soft restart`);
                    throw err; // trigger soft restart via runAccount
                }
            } else {
                consecutiveTimeouts = 0;
            }

            const rawDelay = Math.min(baseDelay * Math.pow(2, attempt), 30);
            const jitter = rawDelay * (0.7 + Math.random() * 0.6); // ±30% jitter
            const delay = Math.round(jitter * 10) / 10;
            if (log) log(`🔄 ${formatError(err)} — ${delay}s (#${attempt + 1})`);
            await sleep(delay);
        }
    }
}

function formatUptime(startMs) {
    const sec = Math.floor((Date.now() - startMs) / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
    return `${m}m${String(s).padStart(2, '0')}s`;
}

function formatError(err) {
    if (err.response) {
        const code = err.response.status;
        const msg = err.response.data?.detail || err.response.data?.message || '';
        if (code >= 500) return `[${code}] Server error`;
        if (code === 401) return `[401] Auth expired`;
        if (code === 400) return `[400] ${msg || 'Bad request'}`;
        if (code === 409) return `[409] Active order exists`;
        if (code === 422) return `[422] ${msg || 'Rejected'}`;
        if (code === 429) return `[429] Rate limited`;
        return `[${code}] ${msg || 'Error'}`;
    }
    if (err.code) return `[${err.code}]`;
    return err.message?.slice(0, 50) || 'Unknown error';
}

function ts() {
    return new Date().toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(/:/g, '.');
}

// ── Axios Factory (per-account proxy) ────────────────────────────────────

// Keep-alive agents for direct connections (no proxy)
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

function createAxiosInstance(proxyUrl) {
    const opts = {
        timeout: 90000,           // 90s per-request hard limit
        maxRedirects: 5,
        decompress: true,
    };

    if (proxyUrl) {
        // Proxy agent options: keep-alive to avoid opening a new tunnel each request
        const agentOpts = {
            keepAlive: true,
            maxSockets: 10,
            timeout: 90000,
        };
        const httpsAgent = new HttpsProxyAgent(proxyUrl, agentOpts);
        const httpAgent = new HttpProxyAgent(proxyUrl, agentOpts);
        opts.httpAgent = httpAgent;
        opts.httpsAgent = httpsAgent;
        opts.proxy = false; // disable axios native proxy – use agent instead
    } else {
        // No proxy: still use keep-alive so sockets are reused
        opts.httpAgent = keepAliveHttpAgent;
        opts.httpsAgent = keepAliveHttpsAgent;
    }

    return axios.create(opts);
}

// ── API Factories ────────────────────────────────────────────────────────

function createWalletApi(ax) {
    const h = BASE_HEADERS;
    const auth = (token) => ({ ...h, Authorization: `Bearer ${token}` });
    return {
        recoverAccount: (keys) =>
            ax.post(`${BACKEND}/accounts/recovery_v3`, { public_keys: keys }, { headers: h }).then(r => r.data),
        getChallenge: (pid) =>
            ax.post(`${BACKEND}/auth/challenge`, { party_id: pid }, { headers: h }).then(r => r.data),
        login: (pid, ch, sig) =>
            ax.post(`${BACKEND}/auth/login`, { party_id: pid, challenge: ch, signature: sig }, { headers: h }).then(r => r.data),
        getBalance: (token) =>
            ax.get(`${BACKEND}/balance`, { headers: auth(token) }).then(r => r.data),
        getHistory: (token) =>
            ax.get(`${BACKEND}/transfer/history`, { headers: auth(token) }).then(r => r.data),
        getMyTag: (token) =>
            ax.get(`${BACKEND}/tags/my`, { headers: auth(token) }).then(r => r.data),
        prepareTransfer: (token, body) =>
            ax.post(`${BACKEND}/transfer/prepare`, {
                instrument_admin_id: body.instrumentAdminId,
                instrument_id: body.instrumentId,
                receiver_party_id: body.receiverPartyId,
                amount: body.amount,
                reason: body.reason || '',
                app_name: body.appName || 'swap-v1',
                metadata: body.metadata || {}
            }, { headers: auth(token) }).then(r => r.data),
        executeTransaction: (token, body) =>
            ax.post(`${BACKEND}/transaction/execute`, {
                command_id: body.commandId,
                prepared_tx_b64: body.preparedTxB64,
                hashing_scheme_version: body.hashingSchemeVersion,
                signature_b64: body.signatureB64,
            }, { headers: auth(token) }).then(r => r.data),
        getCommandStatus: (token, commandId) =>
            ax.get(`${BACKEND}/command/${commandId}/status`, { headers: auth(token) }).then(r => r.data),
        getOffers: (token) =>
            ax.get(`${BACKEND}/offers`, { headers: auth(token) }).then(r => r.data),
        acceptOfferPrepare: (token, body) =>
            ax.post(`${BACKEND}/offer/accept/prepare`, {
                contract_id: body.contractId, party_id: body.partyId
            }, { headers: auth(token) }).then(r => r.data),
        getTransferStatus: (token, commandId) =>
            ax.get(`${BACKEND}/transfer/status`, { params: { command_id: commandId }, headers: auth(token) }).then(r => r.data),
        getRegisterStatus: (token) =>
            ax.get(`${BACKEND}/register/status_v2`, { headers: auth(token) }).then(r => r.data),
        postConfirmV2: (token) =>
            ax.post(`${BACKEND}/register/post_confirm_v2`, {}, { headers: auth(token) }).then(r => r.data),
        finaliseV3: (token, signedTransactions) =>
            ax.post(`${BACKEND}/register/finalise_v3`, { signed_transactions: signedTransactions }, { headers: auth(token) }).then(r => r.data),
        getOutgoingExpired: (token) =>
            ax.get(`${BACKEND}/offers/outgoing_expired`, { headers: auth(token) }).then(r => r.data),
    };
}

function createSwapApi(ax) {
    // Swap API requires Origin: https://exchange.cantor8.tech (not wallet.cantor8.tech)
    const h = SWAP_HEADERS;
    const auth = (token) => ({ ...h, Authorization: `Bearer ${token}` });
    return {
        getNonce: () =>
            ax.get(`${SWAP_API}/auth/nonce`, { headers: h }).then(r => r.data),
        bindSignature: (nonce, cantonAddress) =>
            ax.post(`${SWAP_API}/auth/signature`, { nonce, cantonAddress, signature: null }, { headers: h }).then(r => r.data),
        getQuote: (fromChain, fromAsset, toChain, toAsset, sendAmount) =>
            ax.post(`${SWAP_API}/quotes`, {
                fromChain, fromAsset, toChain, toAsset, sendAmount: String(sendAmount)
            }, { headers: h }).then(r => r.data),
        // Fetch minimum swap amount from quote API by testing with a small amount
        getMinimumSwap: async (fromChain, fromAsset, toChain, toAsset) => {
            try {
                // Try to get a quote with a very small amount to trigger minimum error
                // or parse the minimum from the quote response
                const testAmount = 0.1;
                const quote = await ax.post(`${SWAP_API}/quotes`, {
                    fromChain, fromAsset, toChain, toAsset, sendAmount: String(testAmount)
                }, { headers: h }).then(r => r.data);

                // Check if quote has minimum info
                if (quote.minimumSendAmount) {
                    return parseFloat(quote.minimumSendAmount);
                }
                if (quote.minSendAmount) {
                    return parseFloat(quote.minSendAmount);
                }
                if (quote.minimum) {
                    return parseFloat(quote.minimum);
                }

                // If quote succeeded with small amount, try incrementally to find minimum
                // by checking error messages
                return null;
            } catch (err) {
                // Parse minimum from error message
                const detail = err.response?.data?.detail || err.response?.data?.message || '';
                const detailStr = typeof detail === 'object' ? JSON.stringify(detail) : String(detail);

                // Common patterns: "Minimum swap amount is 25 CC", "minimum: 25", "min_amount: 25"
                const patterns = [
                    /minimum.*?(\d+\.?\d*)/i,
                    /min[_\s]?amount.*?(\d+\.?\d*)/i,
                    /at least (\d+\.?\d*)/i,
                    /below (\d+\.?\d*)/i,
                    /minSendAmount.*?(\d+\.?\d*)/i,
                ];

                for (const pattern of patterns) {
                    const match = detailStr.match(pattern);
                    if (match && match[1]) {
                        return parseFloat(match[1]);
                    }
                }

                return null;
            }
        },
        createOrder: (swapToken, orderId, quoteId, toAddress, slippageBps = 200) =>
            ax.post(`${SWAP_API}/orders`, { orderId, quoteId, toAddress, slippageBps }, { headers: auth(swapToken) }).then(r => r.data),
        getOrderStatus: (swapToken, orderId) =>
            ax.get(`${SWAP_API}/orders/${encodeURIComponent(orderId)}`, { headers: auth(swapToken) }).then(r => r.data),
        getActiveOrder: (swapToken, filters = {}) =>
            ax.get(`${SWAP_API}/orders/active`, { params: filters, headers: auth(swapToken) }).then(r => r.data),
        cancelOrder: (swapToken, orderId) =>
            ax.post(`${SWAP_API}/orders/${encodeURIComponent(orderId)}/cancel`, {}, { headers: auth(swapToken) }).then(r => r.data),
        checkExchange: async () => {
            // Retry up to 3 times before declaring offline
            for (let i = 0; i < 3; i++) {
                try {
                    await ax.head(EXCHANGE, { headers: h, timeout: 10000 });
                    return true;
                } catch (err) {
                    // 5xx = server down, actually offline
                    if (err.response?.status >= 500) return false;
                    // 4xx (403, etc) = server responded, so it's online
                    if (err.response?.status >= 400) return true;
                    // Network errors = retry
                    if (i < 2) await new Promise(r => setTimeout(r, 2000));
                }
            }
            return true; // Assume online if just network issues
        },
        getLeaderboard: (address = null) => {
            // Reward period: 16 May 2026 onwards (1-15 May rewards finalized, landing ~18-19 May)
            const rewardDateFrom = '2026-05-16';
            return ax.get(`${SWAP_API}/leaderboard`, {
                params: { limit: 50, includeRewards: true, includeAll: true, rewardDateFrom, ...(address ? { address } : {}) },
                headers: h,
            }).then(r => r.data);
        },
        // All-time leaderboard (no date filter) — for accurate claimed/pending
        getLeaderboardAllTime: (address = null) => {
            return ax.get(`${SWAP_API}/leaderboard`, {
                params: { limit: 50, includeRewards: true, includeAll: true, ...(address ? { address } : {}) },
                headers: h,
            }).then(r => r.data);
        },
        checkEligibility: (partyId) =>
            ax.get(`${SWAP_API}/party/check-eligibility`, { params: { partyId }, headers: h }).then(r => r.data),
    };
}

// ── Per-Account Dashboard + Log ──────────────────────────────────────────

const MAX_ACC_LOGS = 5;
const MAX_GLOBAL_LOGS = 20; // execution logs at bottom

const dashboard = {
    accounts: [],
    globalLogs: [],
    _timer: null,
    _renderPending: false,

    init(accountConfigs) {
        this.accounts = accountConfigs.map((acc, i) => ({
            name: acc.name || `Acc ${i + 1}`,
            num: i + 1,
            startTime: Date.now(),
            cc: 0, usdcx: 0, ceth: 0, rcc: 0,
            swapsCCtoU: 0, swapsUtCC: 0,
            maxCCtoU: config.swap.rounds || 0, maxUtCC: 0,
            totalSwaps: 0, lastSwapDir: '',
            monthReward: 0, monthVolume: 0, monthTxns: 0,
            totalReward: 0, pendingReward: 0, rank: 0,
            rewardDate: '',
            initialTxns: null, initialReward: null,
            initialRcc: null, diffRcc: 0,
            diffTxns: 0, diffReward: 0,
            nonce: false, swap: false, proxy: !!acc.proxy,
            proxyHost: '',
            proxyIp: '',
            status: 'init',
            logs: [],
        }));
        this.globalLogs = [];
    },

    update(index, data) {
        Object.assign(this.accounts[index], data);
        this._scheduleRender();
    },

    log(index, msg) {
        const a = this.accounts[index];
        const timestamp = ts();
        const logLine = `${timestamp} ${msg}`;
        a.logs.push(logLine);
        while (a.logs.length > MAX_ACC_LOGS) a.logs.shift();
        // Also push to global execution logs
        this.globalLogs.push(`${chalk.cyan(`[${a.name}]`)} ${timestamp} ${msg}`);
        while (this.globalLogs.length > MAX_GLOBAL_LOGS) this.globalLogs.shift();
        this._scheduleRender();
    },

    _scheduleRender() {
        if (this._renderPending) return;
        this._renderPending = true;
        setTimeout(() => {
            this._renderPending = false;
            this._render();
        }, 200);
    },

    _render() {
        const out = process.stdout;
        out.write('\x1B[H\x1B[2J');

        // Column widths (character count including padding)
        const W = { num: 4, cc: 10, usdcx: 10, ceth: 14, rcc: 10, swaps: 7, up: 9, rew: 10, delta: 9, rank: 7, status: 16 };
        const pad = (s, w) => String(s).padStart(w);
        const padE = (s, w) => String(s).padEnd(w);
        const sep = chalk.gray('│');

        // ── Header ──
        const modeLabel = 'CC ↔ USDCx ↔ CETH';
        const headerTime = new Date().toLocaleTimeString('en-GB', { hour12: false });
        const totalW = W.num + W.cc + W.usdcx + W.ceth + W.rcc + W.swaps + W.up + W.rew + W.delta + W.rank + W.status + 11;
        const hdr = chalk.gray('─'.repeat(totalW));

        out.write(
            chalk.cyan.bold('  CANTOR8 BOT V2') +
            chalk.gray(` | ${modeLabel} | ${this.accounts.length} acc | ${headerTime}`) + '\n'
        );

        // ── Table Header ──
        out.write(hdr + '\n');
        out.write(
            chalk.gray(padE(' #', W.num)) + sep +
            chalk.white.bold(pad('CC', W.cc)) + sep +
            chalk.white.bold(pad('USDCx', W.usdcx)) + sep +
            chalk.white.bold(pad('CETH', W.ceth)) + sep +
            chalk.magentaBright.bold(pad('rCC', W.rcc)) + sep +
            chalk.white.bold(pad('Swap', W.swaps)) + sep +
            chalk.white.bold(pad('Uptime', W.up)) + sep +
            chalk.white.bold(pad('Reward', W.rew)) + sep +
            chalk.magentaBright.bold(pad('D.rCC', W.delta)) + sep +
            chalk.white.bold(pad('Rank', W.rank)) + sep +
            chalk.white.bold(padE(' Status', W.status)) +
            '\n'
        );
        out.write(hdr + '\n');

        // ── Table Rows ──
        let totCC = 0, totUSDCx = 0, totCETH = 0, totRCC = 0, totReward = 0, totDelta = 0, totSwaps = 0;

        for (const a of this.accounts) {
            totCC += a.cc;
            totUSDCx += a.usdcx;
            totCETH += a.ceth || 0;
            totRCC += a.rcc || 0;
            totReward += a.monthReward;
            totDelta += a.diffRcc || 0;
            totSwaps += a.totalSwaps;

            const deltaVal = a.diffRcc || 0;
            const deltaFmt = deltaVal >= 0 ? `+${deltaVal.toFixed(4)}` : `${deltaVal.toFixed(4)}`;
            const rankFmt = a.rank > 0 ? `#${a.rank}` : '-';
            const statusFmt = (a.status || 'init').slice(0, W.status - 1);

            // Color coding
            const ccColor = a.cc >= 25 ? chalk.green : a.cc >= 10 ? chalk.yellow : chalk.red;
            const deltaColor = deltaVal > 0 ? chalk.green : deltaVal < 0 ? chalk.red : chalk.gray;
            const statusColor = a.status === 'swapping' ? chalk.cyan :

                a.status === 'init' ? chalk.gray :
                    a.status === 'done' ? chalk.green :
                        a.status?.includes('kurang') ? chalk.red :
                            a.status?.includes('wait') ? chalk.yellow :
                                chalk.white;

            out.write(
                chalk.white(pad(a.num, W.num)) + sep +
                ccColor(pad(a.cc.toFixed(2), W.cc)) + sep +
                chalk.blue(pad(a.usdcx.toFixed(4), W.usdcx)) + sep +
                chalk.cyan(pad((a.ceth || 0).toFixed(8), W.ceth)) + sep +
                chalk.magentaBright(pad((a.rcc || 0).toFixed(4), W.rcc)) + sep +
                chalk.white(pad(a.totalSwaps, W.swaps)) + sep +
                chalk.gray(pad(formatUptime(a.startTime), W.up)) + sep +
                chalk.green(pad(a.monthReward.toFixed(2), W.rew)) + sep +
                deltaColor(pad(deltaFmt, W.delta)) + sep +
                chalk.magenta(pad(rankFmt, W.rank)) + sep +
                statusColor(padE(` ${statusFmt}`, W.status)) +
                '\n'
            );
        }

        // ── Totals ──
        out.write(hdr + '\n');
        const totDeltaFmt = totDelta >= 0 ? `+${totDelta.toFixed(4)}` : `${totDelta.toFixed(4)}`;
        out.write(
            chalk.white.bold(padE(' TOT', W.num)) + sep +
            chalk.green.bold(pad(totCC.toFixed(2), W.cc)) + sep +
            chalk.blue.bold(pad(totUSDCx.toFixed(4), W.usdcx)) + sep +
            chalk.cyan.bold(pad(totCETH.toFixed(8), W.ceth)) + sep +
            chalk.magentaBright.bold(pad(totRCC.toFixed(4), W.rcc)) + sep +
            chalk.white.bold(pad(totSwaps, W.swaps)) + sep +
            chalk.gray(pad('', W.up)) + sep +
            chalk.green.bold(pad(totReward.toFixed(2), W.rew)) + sep +
            chalk.magentaBright.bold(pad(totDeltaFmt, W.delta)) + sep +
            chalk.gray(pad('', W.rank)) + sep +
            chalk.gray(padE('', W.status)) +
            '\n'
        );
        out.write(hdr + '\n');

        // ── Execution Logs ──
        out.write('\n' + chalk.yellow.bold('  Execution Logs') + '\n');
        out.write(chalk.gray('  ' + '─'.repeat(totalW - 4)) + '\n');

        if (this.globalLogs.length === 0) {
            out.write(chalk.gray('  (no logs yet)') + '\n');
        } else {
            for (const line of this.globalLogs) {
                out.write('  ' + line + '\n');
            }
        }
    },

    startAutoRefresh() {
        if (this._timer) return;
        this._timer = setInterval(() => this._scheduleRender(), 10000);
    },

    stop() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    },
};

// ── Dashboard Web Push (Vercel) ─────────────────────────────────────────
// Sends ONLY balances/rewards to dashboard. NEVER sends mnemonics/keys.

const botStartTime = Date.now();
let dashboardPushTimer = null;
let cachedDashPrices = { ccUsd: 0, cethUsd: 0, ts: 0 };
const DASH_PRICE_CACHE_MS = 5 * 60 * 1000;

async function fetchDashboardPrices() {
    if (cachedDashPrices.ts && Date.now() - cachedDashPrices.ts < DASH_PRICE_CACHE_MS) return cachedDashPrices;
    let ccUsd = cachedDashPrices.ccUsd || 0;
    let cethUsd = cachedDashPrices.cethUsd || 0;
    try {
        const q = await axios.post(`${SWAP_API}/quotes`, {
            fromChain: 'CC', fromAsset: '0x0',
            toChain: 'CC', toAsset: 'USDCX',
            sendAmount: '100'
        }, { timeout: 15000 }).then(r => r.data);
        if (q.receiveAmount) ccUsd = parseFloat(q.receiveAmount) / 100;
    } catch { }
    try {
        const q2 = await axios.post(`${SWAP_API}/quotes`, {
            fromChain: 'CC', fromAsset: 'CETH',
            toChain: 'CC', toAsset: 'USDCX',
            sendAmount: '0.01'
        }, { timeout: 15000 }).then(r => r.data);
        if (q2.receiveAmount) cethUsd = parseFloat(q2.receiveAmount) / 0.01;
    } catch { }
    cachedDashPrices = { ccUsd, cethUsd, ts: Date.now() };
    return cachedDashPrices;
}

async function pushToDashboard() {
    const dashCfg = config.dashboard;
    if (!(dashCfg?.enabled || dashCfg?.aktif) || !dashCfg.url || !dashCfg.api_key) return;

    try {
        const prices = await fetchDashboardPrices();

        // SAFE: only send balances, rewards, status — NEVER mnemonics/keys
        const accounts = dashboard.accounts.map(a => {
            const totalR = a.totalReward || 0;
            const pendingR = a.pendingReward || 0;
            const claimedR = Math.max(0, totalR - pendingR);
            const mTxns = a.monthTxns || 0;
            const mReward = a.monthReward || 0;
            return {
                name: a.name,
                cc: a.cc || 0,
                usdcx: a.usdcx || 0,
                ceth: a.ceth || 0,
                rcc: a.rcc || 0,
                monthReward: mReward,
                monthVolume: a.monthVolume || 0,
                monthTxns: mTxns,
                totalReward: totalR,
                pendingReward: pendingR,
                claimedReward: claimedR,
                rewardPerTx: mTxns > 0 ? +(mReward / mTxns).toFixed(4) : 0,
                rank: a.rank || 0,
                status: a.status || 'idle',
                totalSwaps: a.totalSwaps || 0,
                diffReward: a.diffReward || 0,
                diffRcc: a.diffRcc || 0,
                lastSwapDir: a.lastSwapDir || '',
                swapsCCtoU: a.swapsCCtoU || 0,
                swapsUtCC: a.swapsUtCC || 0,
                logs: (a.logs || []).slice(-8),
                error: null,
            };
        });

        const payload = {
            vpsId: dashCfg.vps_id || 'auto',
            accounts,
            prices,
            totalAccounts: dashboard.accounts.length,
            botUptime: Math.floor((Date.now() - botStartTime) / 1000),
            timestamp: new Date().toISOString(),
        };

        const url = dashCfg.url.replace(/\/+$/, '') + '/api/push';
        const pushResp = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': dashCfg.api_key,
            },
            timeout: 15000,
        });
        // If dashboard requested a balance refresh, trigger it immediately
        if (pushResp.data?.refreshBalance) {
            dashboard.log(0, '🔄 Dashboard requested balance refresh, refreshing all accounts...');
            // Trigger immediate refresh for all accounts (non-blocking)
            for (let i = 0; i < dashboard.accounts.length; i++) {
                const acc = dashboard.accounts[i];
                if (acc && acc._refreshFn) {
                    acc._refreshFn().catch(() => {});
                }
            }
        }
    } catch (err) {
        if (!pushToDashboard._failCount) pushToDashboard._failCount = 0;
        pushToDashboard._failCount++;
        if (pushToDashboard._failCount === 1 || pushToDashboard._failCount % 10 === 0) {
            const msg = err.response ? `[${err.response.status}]` : err.code || err.message?.slice(0, 40);
            if (dashboard.accounts.length > 0) {
                dashboard.log(0, `⚠️ Dashboard push #${pushToDashboard._failCount}: ${msg}`);
            }
        }
    }
}
pushToDashboard._failCount = 0;

function startDashboardPush() {
    const dashCfg = config.dashboard;
    if (!(dashCfg?.enabled || dashCfg?.aktif)) return null;
    if (!dashCfg.url || !dashCfg.api_key) {
        console.log(chalk.yellow('⚠️ Dashboard aktif tapi url/api_key kosong, skip'));
        return null;
    }
    const intervalSec = dashCfg.push_interval_seconds || dashCfg.push_interval_detik || 30;
    const intervalMs = Math.max(5, intervalSec) * 1000;
    console.log(chalk.cyan(`  🌐 Dashboard push aktif (tiap ${intervalSec}s → ${dashCfg.url})`));

    setTimeout(() => pushToDashboard(), 10 * 1000);
    dashboardPushTimer = setInterval(() => pushToDashboard(), intervalMs);
    return dashboardPushTimer;
}

function stopDashboardPush() {
    if (dashboardPushTimer) {
        clearInterval(dashboardPushTimer);
        dashboardPushTimer = null;
    }
}

// ── Session Factory ──────────────────────────────────────────────────────

function createSession() {
    return {
        walletToken: null,
        swapToken: null,
        partyId: null,
        keyPair: null,
        keyPairs: null,
        matchIdx: 0,
        walletLoginTime: 0,
        swapLoginTime: 0,

        async refreshWalletToken(walletApi, log) {
            log('🔑 Refreshing wallet token...');
            await retryOnNetwork(async () => {
                const { challenge } = await walletApi.getChallenge(this.partyId);
                const sig = toHex(signMessage(this.keyPair.privateKey, challenge));
                const { access_token } = await walletApi.login(this.partyId, challenge, sig);
                this.walletToken = access_token;
                this.walletLoginTime = Date.now();
            }, { maxRetries: 8, baseDelay: 3, label: 'refreshWallet', log });
        },

        async refreshSwapToken(swapApi, log) {
            log('🔑 Refreshing swap token...');
            await retryOnNetwork(async () => {
                const { nonce } = await swapApi.getNonce();
                const swapAuth = await swapApi.bindSignature(nonce, this.partyId);
                this.swapToken = swapAuth.accessToken;
                this.swapLoginTime = Date.now();
            }, { maxRetries: 8, baseDelay: 3, label: 'refreshSwap', log });
        },

        async ensureFreshTokens(walletApi, swapApi, log) {
            const now = Date.now();
            if (this.walletLoginTime && (now - this.walletLoginTime) > TOKEN_MAX_AGE_MS) {
                try {
                    await this.refreshWalletToken(walletApi, log);
                } catch (err) {
                    log(`⚠️ Wallet token refresh failed: ${formatError(err)}`);
                }
            }
            if (this.swapLoginTime && (now - this.swapLoginTime) > TOKEN_MAX_AGE_MS) {
                try {
                    await this.refreshSwapToken(swapApi, log);
                } catch (err) {
                    log(`⚠️ Swap token refresh failed: ${formatError(err)}`);
                }
            }
        },

        async withRetry(fn, tokenType, walletApi, swapApi, log, retryOptions = {}) {
            // Wrap with network retry first, then handle 401 inside
            return await retryOnNetwork(async () => {
                try {
                    return await fn();
                } catch (err) {
                    if (err.response?.status === 401) {
                        if (tokenType === 'swap') {
                            await this.refreshSwapToken(swapApi, log);
                        } else {
                            await this.refreshWalletToken(walletApi, log);
                        }
                        return await fn();
                    }
                    throw err;
                }
            }, { maxRetries: 5, baseDelay: 3, label: 'apiCall', log, ...retryOptions });
        },
    };
}

// ── Get Active Order with Retry (5xx/network = retry, 404 = no order, 401 = throw) ──
async function getActiveOrderWithRetry(swapApi, swapToken, log, maxRetries = 3, delaySec = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await swapApi.getActiveOrder(swapToken, {});
        } catch (err) {
            const status = err.response?.status;
            // 404 = API bilang "no active order" — ini NORMAL, bukan error
            if (status === 404) return null;
            // 401 = token expired, lempar ke caller buat refresh
            if (status === 401) throw err;
            // 4xx lain (selain 404/401) = client error, gak perlu retry
            if (status && status >= 400 && status < 500) return null;
            // 5xx / network error → retry
            if (attempt < maxRetries) {
                log('⚠️ getActiveOrder error (attempt ' + attempt + '/' + maxRetries + '): ' + (status || err.message) + ' → retry in ' + delaySec + 's...');
                await new Promise(r => setTimeout(r, delaySec * 1000));
            } else {
                log('❌ getActiveOrder failed after ' + maxRetries + ' attempts: ' + (status || err.message));
                throw err;
            }
        }
    }
}

// ── Resolve Active Order Helper ──────────────────────────────────────────

async function resolveActiveOrder(ctx) {
    const { session, swapApi, walletApi, log } = ctx;
    const TERMINAL_S = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
    try {
        const active = await getActiveOrderWithRetry(swapApi, session.swapToken, log);
        if (!active?.orderId || TERMINAL_S.includes(active.status)) return false;
        log(`🔄 Active order ${shortId(active.orderId)} (${active.status}), polling...`);

        // Phase 1: Poll for up to ~2 minutes (24 × 5s) for natural completion
        for (let rp = 0; rp < 24; rp++) {
            await sleep(5);
            if (rp % 12 === 0 && rp > 0) await session.ensureFreshTokens(walletApi, swapApi, log);
            try {
                const st = await retryOnNetwork(
                    () => swapApi.getOrderStatus(session.swapToken, active.orderId),
                    { maxRetries: 3, baseDelay: 3, label: 'resolveOrder', log }
                );
                if (TERMINAL_S.includes(st.status)) {
                    log(`✅ Order ${shortId(active.orderId)} → ${st.status}`);
                    return true;
                }
                if (rp % 6 === 5) log(`🔄 ${shortId(active.orderId)} → ${st.status} (${(rp + 1) * 5}s)`);
            } catch (pe) {
                if (pe.response?.status === 401) { await session.refreshSwapToken(swapApi, log); continue; }
                log(`⚠️ resolveOrder poll error: ${formatError(pe)}`);
                break;
            }
        }

        // Phase 2: Order stuck > 2 min → attempt cancel
        log(`⚠️ Order ${shortId(active.orderId)} stuck > 2min, attempting cancel...`);
        let cancelSent = false;
        try {
            await session.ensureFreshTokens(walletApi, swapApi, log);
            await swapApi.cancelOrder(session.swapToken, active.orderId);
            log(`📤 Cancel request sent for ${shortId(active.orderId)}`);
            cancelSent = true;
        } catch (cancelErr) {
            const msg = formatError(cancelErr);
            const msgLower = String(cancelErr.response?.data?.detail || cancelErr.response?.data?.message || msg).toLowerCase();
            if (msgLower.includes('already') || msgLower.includes('completed') || msgLower.includes('cancelled')) {
                log(`✅ Order already resolved: ${msg}`);
                return true;
            }
            log(`⚠️ Cancel request failed: ${msg} — will continue polling...`);
        }

        // Phase 3: Post-cancel poll (up to ~60s) to confirm resolution
        for (let rp = 0; rp < 12; rp++) {
            await sleep(5);
            try {
                if (rp % 6 === 0 && rp > 0) await session.ensureFreshTokens(walletApi, swapApi, log);
                const st = await retryOnNetwork(
                    () => swapApi.getOrderStatus(session.swapToken, active.orderId),
                    { maxRetries: 2, baseDelay: 3, label: 'postCancel', log }
                );
                if (TERMINAL_S.includes(st.status)) {
                    log(`✅ Order ${shortId(active.orderId)} → ${st.status}${cancelSent ? ' (after cancel)' : ''}`);
                    return true;
                }
            } catch (pe) {
                if (pe.response?.status === 404) {
                    log(`✅ Order ${shortId(active.orderId)} resolved (404)`);
                    return true;
                }
                if (pe.response?.status === 401) { await session.refreshSwapToken(swapApi, log); continue; }
            }
        }

        log(`⚠️ Order ${shortId(active.orderId)} still stuck after cancel attempt`);
        return true;
    } catch { return false; }
}

// ── Per-Account Runner ───────────────────────────────────────────────────

const MAX_ACCOUNT_RETRIES = Infinity;
const ACCOUNT_RETRY_BASE_DELAY = 15; // seconds

async function runAccount(accConfig, index) {
    const name = accConfig.name || `Acc ${index + 1}`;
    const log = (msg) => dashboard.log(index, msg);

    for (let accountAttempt = 1; ; accountAttempt++) {
        try {
            await runAccountOnce(accConfig, index, name, log);
            return; // success, exit retry loop
        } catch (err) {
            // Error 500+ → soft restart immediately (short delay)
            if (err.response?.status >= 500) {
                log(`🔄 [${err.response.status}] soft restart 5s`);
                dashboard.update(index, { status: 'soft-restart' });
                await sleep(5);
                accountAttempt = Math.max(1, accountAttempt - 1); // don't escalate delay for 500
                continue;
            }

            // ERR_BAD_RESPONSE → soft restart immediately
            if (err.code === 'ERR_BAD_RESPONSE' || err.message?.includes('ERR_BAD_RESPONSE')) {
                log(`🔄 [ERR_BAD_RESPONSE] soft restart 5s`);
                dashboard.update(index, { status: 'soft-restart' });
                await sleep(5);
                accountAttempt = Math.max(1, accountAttempt - 1);
                continue;
            }

            log(`❌ ${formatError(err)}`);
            const delay = Math.min(ACCOUNT_RETRY_BASE_DELAY * Math.pow(1.5, accountAttempt - 1), 120);
            log(`🔄 Restart ${Math.round(delay)}s (#${accountAttempt})`);
            dashboard.update(index, { status: `restart #${accountAttempt}` });
            await sleep(delay);
        }
    }
}

async function runAccountOnce(accConfig, index, name, log) {
    const ax = createAxiosInstance(accConfig.proxy || '');
    const walletApi = createWalletApi(ax);
    const swapApi = createSwapApi(ax);
    const session = createSession();

    if (accConfig.proxy) {
        log(`Proxy: ${accConfig.proxy.replace(/\/\/.*@/, '//***@')}`);
        // Extract hostname robustly via regex
        const proxyHost = (accConfig.proxy.match(/@([^:/]+)/) || [])[1]
            || accConfig.proxy.split('@').pop().split(':')[0]
            || 'proxy';
        dashboard.update(index, { proxyHost });
        // Fetch actual outbound IP in background (non-blocking)
        const IP_ENDPOINTS = [
            { url: 'https://api.ipify.org?format=json', extract: r => r.data?.ip },
            { url: 'https://api4.my-ip.io/ip.json', extract: r => r.data?.ip },
            { url: 'https://ipinfo.io/json', extract: r => r.data?.ip },
            { url: 'https://api.ipify.org', extract: r => String(r.data).trim() },
        ];
        (async () => {
            for (const ep of IP_ENDPOINTS) {
                try {
                    const r = await ax.get(ep.url, { timeout: 15000 });
                    const ip = ep.extract(r);
                    if (ip && ip.includes('.')) { dashboard.update(index, { proxyIp: ip }); return; }
                } catch { /* try next */ }
            }
        })();
    }

    // Step 1: Derive keys
    dashboard.update(index, { status: 'deriving' });
    log('🔑 Deriving key pairs...');
    const keyPairs = generateKeyPairs(accConfig.mnemonic);
    log(`🔑 ${keyPairs.length} keys derived`);

    // Step 2: Recover account (with network retry)
    dashboard.update(index, { status: 'recovering' });
    log('🔍 Recovering account...');
    const recovery = await retryOnNetwork(
        () => walletApi.recoverAccount(keyPairs.map(k => k.publicKeyHex)),
        { maxRetries: 5, baseDelay: 3, label: 'recover', log }
    );
    const matchIdx = (recovery.results || []).findIndex(r => r !== null);
    if (matchIdx === -1) throw new Error('No account found for this mnemonic');
    const acct = recovery.results[matchIdx];
    log(`🆔 Party: ${shortId(acct.party_id)}`);

    // Step 3: Login (with network retry)
    dashboard.update(index, { status: 'auth', nonce: true });
    log('🔐 Authenticating...');
    session.partyId = acct.party_id;
    session.keyPairs = keyPairs;
    session.matchIdx = matchIdx;
    session.keyPair = keyPairs[matchIdx];

    // Custom login loop: on challenge errors retry immediately (no backoff) since challenge is re-fetched each attempt
    for (let loginAttempt = 1; ; loginAttempt++) {
        try {
            const { challenge } = await walletApi.getChallenge(acct.party_id);
            const sig = toHex(signMessage(keyPairs[matchIdx].privateKey, challenge));
            const { access_token } = await walletApi.login(acct.party_id, challenge, sig);
            session.walletToken = access_token;
            session.walletLoginTime = Date.now();
            break; // success
        } catch (err) {
            const is400Challenge = err.response?.status === 400 &&
                String(err.response?.data?.detail || err.response?.data?.message || JSON.stringify(err.response?.data || ''))
                    .toLowerCase().includes('challenge');
            if (is400Challenge) {
                // Challenge expired in transit — fetch fresh one immediately, no wait
                log(`🔄 [login] Challenge expired, retrying immediately... (attempt ${loginAttempt})`);
                continue;
            }
            if (!isRetryableError(err)) throw err;
            const delay = Math.min(3 * Math.pow(2, loginAttempt - 1), 30);
            log(`🔄 [login] ${formatError(err)} (attempt ${loginAttempt}, wait ${delay}s)`);
            await sleep(delay);
        }
    }
    log('✅ Authenticated');

    // Step 3b: Post-login registration checks + delegation signing (rebate_cc_delegation etc)
    try {
        const regStatus = await walletApi.getRegisterStatus(session.walletToken);
        log(`📋 Registration: ${regStatus.is_registered ? '✅' : '⏳'}`);
        await signAndFinaliseDelegations(walletApi, session, log);
        await walletApi.getOutgoingExpired(session.walletToken);
    } catch (err) {
        log(`⚠️ Registration/delegation check: ${err.response?.status || err.message || 'error'}`);
    }

    // Step 4: Dashboard data
    const ctx = { session, walletApi, swapApi, log, name, index, ax };
    log('📊 Fetching balance & stats...');
    const holdings = await refreshAccountData(ctx);

    // Step 4b: Start background refresh for balance & reward
    const bgRefreshId = startBackgroundRefresh(ctx);

    // Step 5: Swap
    try {
        if (config.swap.enabled) {
            dashboard.update(index, { swap: true });
            await performSwap(ctx, holdings);
        } else {
            log('⏸ Swap disabled');
            dashboard.update(index, { status: 'idle' });
        }
    } finally {
        // Always stop background refresh when done
        stopBackgroundRefresh(bgRefreshId);
    }

    log('🏁 Completed');
    dashboard.update(index, { status: 'done' });
}

// ── Refresh Account Data ─────────────────────────────────────────────────

async function refreshAccountData(ctx) {
    const { session, walletApi, swapApi, log, index } = ctx;

    const { holdings = {} } = await session.withRetry(
        () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
    );

    let cc = 0, usdcx = 0, ceth = 0, rcc = 0;
    // Debug: log ALL holdings keys (first time only) to discover rCC key name
    const prevAcc0 = dashboard.accounts[index];
    if (!prevAcc0._holdingsKeysLogged) {
        const allKeys = Object.entries(holdings).map(([k, v]) => `${k}=${v.balance||0}`);
        log(`🔍 [DEBUG] Holdings keys: [${allKeys.join(', ')}]`);
        dashboard.update(index, { _holdingsKeysLogged: true });
    }
    for (const [tok, info] of Object.entries(holdings)) {
        if (CC_ASSET_KEYS.includes(tok)) cc = info.balance || 0;
        if (USDCX_ASSET_KEYS.includes(tok)) usdcx = info.balance || 0;
        if (CETH_ASSET_KEYS.includes(tok)) ceth = info.balance || 0;
        // Match rCC flexibly: exact keys OR case-insensitive contains
        const tokLower = tok.toLowerCase();
        if (RCC_ASSET_KEYS.includes(tok) || tokLower.includes('rcc') || tokLower.includes('rebate')) {
            rcc = info.balance || 0;
            if (!prevAcc0._rccKeyLogged) {
                log(`🟣 [rCC] Found rCC token key="${tok}" balance=${rcc}`);
                dashboard.update(index, { _rccKeyLogged: true });
            }
        }
    }

    // Retain last known values as fallback when API fails
    const prevAccount = dashboard.accounts[index];
    let monthReward = prevAccount.monthReward || 0;
    let monthVolume = prevAccount.monthVolume || 0;
    let monthTxns = prevAccount.monthTxns || 0;
    let totalReward = prevAccount.totalReward || 0;
    let pendingReward = prevAccount.pendingReward || 0;
    let rank = prevAccount.rank || 0;
    let lbFetchOk = false;
    try {
        const lb = await swapApi.getLeaderboard(session.partyId);
        const me = lb.requestedAddress || null;
        if (me) {
            // Debug: log all available fields (first time only)
            if (!prevAccount._lbFieldsLogged) {
                log('🔍 [DEBUG] Leaderboard fields: ' + JSON.stringify(me, null, 0).slice(0, 500));
                dashboard.update(index, { _lbFieldsLogged: true });
            }

            // Monthly fields (filtered by rewardDateFrom = current period)
            monthReward = parseFloat(me.rewardAccruedCc ?? 0);
            monthVolume = parseFloat(me.rewardVolumeUsd ?? me.volumeUsd ?? 0);
            monthTxns = parseInt(me.rewardSwapCount ?? me.swapCount ?? 0);
            rank = parseInt(me.rank ?? me.position ?? 0);
            lbFetchOk = true;
        }
    } catch (lbErr) {
        log(`⚠️ Leaderboard fetch failed: ${formatError(lbErr)} — using cached data`);
    }

    // Fetch ALL-TIME leaderboard (no date filter) for accurate claimed/pending
    try {
        const lbAll = await swapApi.getLeaderboardAllTime(session.partyId);
        const meAll = lbAll.requestedAddress || null;
        if (meAll) {
            // All-time total earned & accrued (pending/unclaimed)
            totalReward = parseFloat(meAll.rewardTotalCc ?? meAll.totalRewardCc ?? 0);
            pendingReward = parseFloat(meAll.rewardAccruedCc ?? meAll.totalRewardAccruedCc ?? 0);
            if (!prevAccount._lbAllTimeLogged) {
                log(`📊 All-time: total=${totalReward.toFixed(2)} pending=${pendingReward.toFixed(2)} claimed=${Math.max(0, totalReward - pendingReward).toFixed(2)}`);
                dashboard.update(index, { _lbAllTimeLogged: true });
            }
        }
    } catch { /* all-time fetch failed, keep monthly data */ }

    // Track initial values for diff calculation
    const currentAccount = dashboard.accounts[index];
    let diffTxns = currentAccount.diffTxns || 0;
    let diffReward = currentAccount.diffReward || 0;

    if (currentAccount.initialTxns === null && monthReward > 0) {
        // First time with VALID data — only set when API returned real values
        dashboard.update(index, { initialTxns: monthTxns, initialReward: monthReward });
    } else if (currentAccount.initialTxns !== null && monthReward > 0) {
        // Auto-correct: reset baseline if initialReward=0 (stale) OR
        // if monthReward dropped significantly (month rollover / reward reset)
        const needsReset = (currentAccount.initialReward === 0 && monthReward > 1)
            || (monthReward < currentAccount.initialReward * 0.5); // reward dropped >50% = month rollover
        if (needsReset) {
            dashboard.update(index, { initialTxns: monthTxns, initialReward: monthReward });
            diffTxns = 0;
            diffReward = 0;
        } else {
            diffTxns = monthTxns - currentAccount.initialTxns;
            diffReward = monthReward - currentAccount.initialReward;

            // Monthly reward should never decrease — if negative, reset baseline
            // (can happen due to API recalculation or timing)
            if (diffReward < 0) {
                dashboard.update(index, { initialTxns: monthTxns, initialReward: monthReward });
                diffTxns = 0;
                diffReward = 0;
            }
        }
    }

    // ── rCC delta tracking (rCC gained since bot start) ──
    let diffRcc = currentAccount.diffRcc || 0;
    if (currentAccount.initialRcc === null && rcc > 0) {
        dashboard.update(index, { initialRcc: rcc });
        diffRcc = 0;
    } else if (currentAccount.initialRcc !== null && rcc > 0) {
        diffRcc = rcc - currentAccount.initialRcc;
    }

    dashboard.update(index, {
        cc, usdcx, ceth, rcc,
        monthReward, monthVolume, monthTxns,
        totalReward, pendingReward, rank,
        diffTxns, diffReward, diffRcc,
        rewardDate: new Date().toISOString().slice(0, 10),
    });

    return holdings;
}

// ── Background Refresh (Balance & Reward) ────────────────────────────────

function startBackgroundRefresh(ctx) {
    const { session, walletApi, swapApi, log, index } = ctx;
    const bgConfig = config.background_refresh || {};
    const enabled = bgConfig.enabled !== false;
    const intervalSec = bgConfig.interval_seconds || 60;

    if (!enabled) {
        log('📊 Background refresh disabled');
        return null;
    }

    log(`📊 BG refresh (${intervalSec}s)`);

    // Register refresh function so dashboard can trigger immediate refresh
    const doRefresh = async () => {
        try {
            await session.ensureFreshTokens(walletApi, swapApi, () => { });
            const holdings = await walletApi.getBalance(session.token);
            if (holdings) {
                const cc = getHoldingBal(holdings, CC_ASSET_KEYS);
                const usdcx = getHoldingBal(holdings, USDCX_ASSET_KEYS);
                const ceth = getHoldingBal(holdings, CETH_ASSET_KEYS);
                const rcc = getRccBalance(holdings);
                
                // rCC delta tracking
                const currentAccount = dashboard.accounts[index];
                let diffRcc = currentAccount.diffRcc || 0;
                if (currentAccount.initialRcc === null && rcc > 0) {
                    dashboard.update(index, { initialRcc: rcc });
                    diffRcc = 0;
                } else if (currentAccount.initialRcc !== null && rcc > 0) {
                    diffRcc = rcc - currentAccount.initialRcc;
                }
                
                dashboard.update(index, { cc, usdcx, ceth, rcc, diffRcc });
                log('🔄 Balance refreshed: CC:' + cc.toFixed(2) + ' USDCx:' + usdcx.toFixed(4) + ' CETH:' + ceth.toFixed(10) + ' rCC:' + rcc.toFixed(4));
            }
        } catch { /* silent */ }
    };
    dashboard.accounts[index]._refreshFn = doRefresh;

    const intervalId = setInterval(async () => {
        try {
            // Ensure tokens are fresh before refresh
            await session.ensureFreshTokens(walletApi, swapApi, () => { });

            // Refresh balance
            const { holdings = {} } = await session.withRetry(
                () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, () => { }
            );

            let cc = 0, usdcx = 0, ceth = 0, rcc = 0;
            for (const [tok, info] of Object.entries(holdings)) {
                if (CC_ASSET_KEYS.includes(tok)) cc = info.balance || 0;
                if (USDCX_ASSET_KEYS.includes(tok)) usdcx = info.balance || 0;
                if (CETH_ASSET_KEYS.includes(tok)) ceth = info.balance || 0;
                const tokLower = tok.toLowerCase();
                if (RCC_ASSET_KEYS.includes(tok) || tokLower.includes('rcc') || tokLower.includes('rebate')) rcc = info.balance || 0;
            }

            // Refresh reward/leaderboard data — retain last known values on failure
            const prevAcc = dashboard.accounts[index];
            let monthReward = prevAcc.monthReward || 0;
            let monthVolume = prevAcc.monthVolume || 0;
            let monthTxns = prevAcc.monthTxns || 0;
            let totalReward = prevAcc.totalReward || 0;
            let pendingReward = prevAcc.pendingReward || 0;
            let rank = prevAcc.rank || 0;
            let bgLbOk = false;
            try {
                const lb = await swapApi.getLeaderboard(session.partyId);
                const me = lb.requestedAddress || null;
                if (me) {
                    monthReward = parseFloat(me.rewardAccruedCc ?? 0);
                    monthVolume = parseFloat(me.rewardVolumeUsd ?? me.volumeUsd ?? 0);
                    monthTxns = parseInt(me.rewardSwapCount ?? me.swapCount ?? 0);
                    rank = parseInt(me.rank ?? me.position ?? 0);
                    bgLbOk = true;
                }
            } catch { /* skip */ }

            // All-time for claimed/pending
            try {
                const lbAll = await swapApi.getLeaderboardAllTime(session.partyId);
                const meAll = lbAll.requestedAddress || null;
                if (meAll) {
                    totalReward = parseFloat(meAll.rewardTotalCc ?? meAll.totalRewardCc ?? 0);
                    pendingReward = parseFloat(meAll.rewardAccruedCc ?? meAll.totalRewardAccruedCc ?? 0);
                }
            } catch { /* skip */ }

            // Track diff values
            const currentAccount = dashboard.accounts[index];
            let diffTxns = currentAccount.diffTxns || 0;
            let diffReward = currentAccount.diffReward || 0;

            if (currentAccount.initialTxns === null && monthReward > 0) {
                dashboard.update(index, { initialTxns: monthTxns, initialReward: monthReward });
                diffTxns = 0;
                diffReward = 0;
            } else if (currentAccount.initialTxns !== null && monthReward > 0) {
                const needsReset = (currentAccount.initialReward === 0 && monthReward > 1)
                    || (monthReward < currentAccount.initialReward * 0.5);
                if (needsReset) {
                    dashboard.update(index, { initialTxns: monthTxns, initialReward: monthReward });
                    diffTxns = 0;
                    diffReward = 0;
                } else {
                    diffTxns = monthTxns - currentAccount.initialTxns;
                    diffReward = monthReward - currentAccount.initialReward;

                    // Monthly reward should never decrease — reset baseline if negative
                    if (diffReward < 0) {
                        dashboard.update(index, { initialTxns: monthTxns, initialReward: monthReward });
                        diffTxns = 0;
                        diffReward = 0;
                    }
                }
            }

            // rCC delta tracking
            let diffRcc = currentAccount.diffRcc || 0;
            if (currentAccount.initialRcc === null && rcc > 0) {
                dashboard.update(index, { initialRcc: rcc });
                diffRcc = 0;
            } else if (currentAccount.initialRcc !== null && rcc > 0) {
                diffRcc = rcc - currentAccount.initialRcc;
            }

            // Update dashboard silently
            dashboard.update(index, {
                cc, usdcx, ceth, rcc,
                monthReward, monthVolume, monthTxns,
                totalReward, pendingReward, rank,
                diffTxns, diffReward, diffRcc,
                rewardDate: new Date().toISOString().slice(0, 10),
            });
        } catch {
            // Silent fail for background refresh
        }
    }, intervalSec * 1000);

    return intervalId;
}

function stopBackgroundRefresh(intervalId) {
    if (intervalId) {
        clearInterval(intervalId);
    }
}

// ── Wait for Account Setup (422 handling) ────────────────────────────────

async function waitForAccountSetup(swapApi, swapToken, partyId, log) {
    for (let i = 1; i <= SETUP_WAIT_MAX; i++) {
        log(`⏳ Setup pending (${i}), wait 30s...`);
        await sleep(30);
        try {
            // Only test with getQuote - don't create orders during setup
            const pb = getActivePairB();
            const minAmt = config.swap.min_amount || 27;
            const q = await swapApi.getQuote('CC', '0x0', pb.chain, pb.asset, minAmt);
            if (q && q.quoteId) {
                log('✅ Account setup complete (quote OK)');
                return true;
            }
        } catch (err) {
            const status = err.response?.status;
            const detail = String(err.response?.data?.detail || err.response?.data?.message || '');
            if (status === 422 && detail.includes('Account setup not complete')) {
                log(`⏳ Still setting up... (attempt ${i})`);
                continue;
            }
            // Different error = setup might be done
            log(`⚠️ Setup check got: [${status}] ${detail.slice(0, 80)}`);
            return true;
        }
    }
    return false;
}

// ── Instrument Admin ID Helper ───────────────────────────────────────────

function getInstrumentAdminId(holdings, assetKey) {
    // assetKey is '0x0' (Amulet/CC), 'USDCX', or 'CETH'
    const nameMap = {
        '0x0': ['Amulet', 'CC (Amulet)', 'CC'],
        'USDCX': ['USDCx', 'USDCX'],
        'CETH': ['cETH', 'CETH'],
    };
    const names = nameMap[assetKey] || [assetKey];
    for (const n of names) {
        if (holdings?.[n]?.instrument_admin_id) return holdings[n].instrument_admin_id;
    }
    // Fallback for CETH if not found in holdings
    if (assetKey === 'CETH') return CETH_INST_ADMIN;
    return '';
}

// ── Auto-Send CC (when balance >= threshold, send excess to target) ──────
//
// Trigger: CC balance >= config.auto_send.threshold (default 100)
// Action : transfer (balance - reserve) CC to config.auto_send.target_party_id
// Reserve: config.auto_send.reserve (default 50) tetap di wallet biar bisa ikut swap lagi
// Returns: { ccBalance, holdings, sent, success, error } setelah refresh balance
//
async function autoSendCC(ctx) {
    const { session, walletApi, swapApi, log, name, index } = ctx;
    const cfg = config.auto_send || {};
    if (!cfg.enabled) return null;

    const target = cfg.target_party_id;
    if (!target) {
        log('⚠️ Auto-send: target_party_id kosong, skip');
        return null;
    }
    if (target === session.partyId) {
        log('⚠️ Auto-send: target sama dengan wallet sendiri, skip');
        return null;
    }

    const threshold = cfg.threshold ?? 100;
    const reserve = cfg.reserve ?? 50;

    // Refresh balance untuk dapat angka terbaru
    let holdings = null;
    try {
        await session.ensureFreshTokens(walletApi, swapApi, log);
        const r = await session.withRetry(
            () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
        );
        holdings = r.holdings || {};
    } catch (err) {
        log(`⚠️ Auto-send: gagal refresh balance: ${err.message}`);
        // Return null supaya caller tidak overwrite ccBalance/holdingsCache dgn data palsu;
        // outer reward-landed check akan tetap pause dgn ccBalance lama (yang masih >= threshold).
        return null;
    }

    const ccBalance = getHoldingBal(holdings, CC_ASSET_KEYS);
    if (ccBalance < threshold) {
        return { ccBalance, sent: 0, holdings, success: false };
    }

    // Floor ke 4 desimal supaya aman
    const sendable = Math.max(0, Math.floor((ccBalance - reserve) * 10000) / 10000);
    if (sendable <= 0) {
        log(`⚠️ Auto-send: sendable=${sendable} (CC ${ccBalance.toFixed(4)} - reserve ${reserve}), skip`);
        return { ccBalance, sent: 0, holdings, success: false };
    }

    log(`💸 Auto-send triggered: CC(${ccBalance.toFixed(4)}) >= ${threshold} → kirim ${sendable} CC, sisain ${reserve} CC`);
    log(`📬 Target: ${shortId(target)}`);
    dashboard.update(index, { status: 'auto-send' });

    try {
        const instrumentAdminId = getInstrumentAdminId(holdings, '0x0');

        const rawPrepare = await session.withRetry(() => walletApi.prepareTransfer(session.walletToken, {
            instrumentAdminId: instrumentAdminId || '',
            instrumentId: 'Amulet',
            receiverPartyId: target,
            amount: String(sendable),
            reason: 'auto-send',
            appName: 'auto-send-v1',
            metadata: { type: 'auto-send', timestamp: String(Date.now()) },
        }), 'wallet', walletApi, swapApi, log);

        const commandId = rawPrepare.command_id || rawPrepare.commandId;
        const preparedTxB64 = rawPrepare.prepared_tx_b64 || rawPrepare.preparedTxB64;
        const hashingSchemeVersion = rawPrepare.hashing_scheme_version || rawPrepare.hashingSchemeVersion || 'HASHING_SCHEME_VERSION_V2';
        const hashB64 = rawPrepare.hash_b64 || rawPrepare.hashB64;

        if (!preparedTxB64 || !hashB64) {
            log('❌ Auto-send: missing prepared_tx_b64/hash_b64');
            return { ccBalance, sent: 0, holdings, error: true };
        }

        const signature = signMessage(session.keyPair.privateKey, Buffer.from(hashB64, 'base64'));
        await session.withRetry(() => walletApi.executeTransaction(session.walletToken, {
            commandId, preparedTxB64,
            signatureB64: toBase64(signature),
            hashingSchemeVersion,
        }), 'wallet', walletApi, swapApi, log);

        // Poll status (max ~45s)
        let success = false;
        for (let i = 0; i < 15; i++) {
            await sleep(3);
            try {
                const txStatus = await walletApi.getTransferStatus(session.walletToken, commandId);
                if (txStatus.status === 'success') { success = true; break; }
                if (txStatus.status === 'failed' || txStatus.status === 'rejected') {
                    log(`❌ Auto-send: transfer ${txStatus.status}`);
                    break;
                }
            } catch { /* continue polling */ }
        }

        if (success) {
            log(`✅ Auto-send confirmed: ${sendable} CC → ${shortId(target)}`);
        } else {
            log('⚠️ Auto-send: status pending after polling, refreshing balance anyway');
        }

        // Refresh balance setelah send
        let newCc = ccBalance;
        let newHoldings = holdings;
        try {
            const r2 = await session.withRetry(
                () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
            );
            newHoldings = r2.holdings || {};
            newCc = getHoldingBal(newHoldings, CC_ASSET_KEYS);
            const u = getHoldingBal(newHoldings, USDCX_ASSET_KEYS);
            const c = getHoldingBal(newHoldings, CETH_ASSET_KEYS);
            dashboard.update(index, { cc: newCc, usdcx: u, ceth: c });
            log(`💰 Balance setelah auto-send: CC ${ccBalance.toFixed(4)} → ${newCc.toFixed(4)}`);
        } catch { /* non-critical */ }

        try {
            await sendTelegramMessage(
                `💸 <b>Auto-send</b>\n👤 ${name}\n` +
                `📤 <code>${sendable.toFixed(4)} CC</code> → <code>${shortId(target)}</code>\n` +
                `💰 <code>${ccBalance.toFixed(4)} → ${newCc.toFixed(4)} CC</code> (reserve ${reserve})\n` +
                `${success ? '✅ Confirmed' : '⏳ Pending'}`
            );
        } catch { /* ignore */ }

        return { ccBalance: newCc, sent: sendable, holdings: newHoldings, success };
    } catch (err) {
        const detail = err.response?.data?.detail || err.response?.data?.message || err.message;
        const detailStr = typeof detail === 'object' ? JSON.stringify(detail) : String(detail);
        log(`❌ Auto-send failed: ${detailStr}`);
        return { ccBalance, sent: 0, holdings, error: true };
    }
}

// ── Mode 5 Consolidation Coordinator (cross-wallet CC donation) ──────────
const consolCoordinator = {
    needsHelp: [],  // { index, partyId, amountNeeded, resolved: false }
};

// ── Perform Swap ─────────────────────────────────────────────────────────

async function performSwap(ctx, holdings) {
    const { session, walletApi, swapApi, log, name, index } = ctx;
    const { rounds, delay_min_seconds, delay_max_seconds, min_amount, pair_a } = config.swap;
    const pair_b = getActivePairB();

    dashboard.update(index, { status: 'checking', maxCCtoU: rounds });

    log('🌐 Checking exchange status...');
    const exchangeOk = await swapApi.checkExchange();
    if (!exchangeOk) {
        log('❌ Exchange offline → soft restart 30s');
        dashboard.update(index, { status: 'offline', swap: false });
        const offlineErr = new Error('EXCHANGE_OFFLINE');
        offlineErr.response = { status: 500 }; // trigger soft restart
        throw offlineErr;
    }

    // ── Dynamic Minimum Swap: Initial fetch ──
    if (dynamicMinSwap.enabled) {
        log('🔍 Fetching minimum swap from API...');
        const initialAmount = await fetchDynamicMinSwap(swapApi, log);
        log(`📊 Initial swap amount: ${initialAmount.toFixed(2)}CC (raw: ${dynamicMinSwap.lastRawMin})`);
    }

    // Get effective swap amount (dynamic or static) - will be fetched fresh before each swap
    const getMinThreshold = () => dynamicMinSwap.enabled
        ? Math.max(dynamicMinSwap.lastRawMin + dynamicMinSwap.extraCc, min_amount)
        : min_amount;

    let ccBalance = getHoldingBal(holdings, CC_ASSET_KEYS);
    let usdcxBalance = getHoldingBal(holdings, getPairBAssetKeys());
    let holdingsCache = holdings || {}; // cache for instrument_admin_id lookups
    const rewardThreshold = config.swap.reward_landed_threshold ?? config.auto_send?.threshold ?? 100;

    // Check if reward landed (CC > threshold) → auto-send (if enabled) then continue, else pause
    if (ccBalance >= rewardThreshold) {
        log(`🎉 Reward landed! CC(${ccBalance.toFixed(2)}) >= ${rewardThreshold}`);
        if (config.auto_send?.enabled) {
            const ar = await autoSendCC(ctx);
            if (ar && ar.holdings && !ar.error) {
                holdingsCache = ar.holdings;
                ccBalance = ar.ccBalance;
                usdcxBalance = getHoldingBal(holdingsCache, getPairBAssetKeys());
            }
        }
        if (ccBalance >= rewardThreshold) {
            log(`⏸ CC(${ccBalance.toFixed(2)}) masih >= ${rewardThreshold} → pausing`);
            dashboard.update(index, { status: 'reward-landed', swap: false });
            return;
        }
        log(`▶️ CC(${ccBalance.toFixed(2)}) < ${rewardThreshold} setelah auto-send → lanjut swap`);
    }

    // Auth swap API
    dashboard.update(index, { status: 'swap-auth' });
    log('🔐 Authenticating swap API...');
    await retryOnNetwork(async () => {
        const { nonce } = await swapApi.getNonce();
        const swapAuth = await swapApi.bindSignature(nonce, session.partyId);
        session.swapToken = swapAuth.accessToken;
        session.swapLoginTime = Date.now();
    }, { maxRetries: 8, baseDelay: 5, label: 'swapAuth', log });
    dashboard.update(index, { swap: true });
    log('✅ Swap API ready');

    // Check eligibility (retry infinitely until eligible)
    for (let eligAttempt = 1; ; eligAttempt++) {
        try {
            const eligibility = await swapApi.checkEligibility(session.partyId);
            if (eligibility.eligible) {
                log('✅ Eligible for swap');
                break;
            }
            log(`⏳ Not eligible, retry 30s (#${eligAttempt})`);
            dashboard.update(index, { status: `ineligible #${eligAttempt}` });
            await sleep(30);
            await session.ensureFreshTokens(walletApi, swapApi, log);
        } catch {
            // API error = non-critical, assume eligible and continue
            break;
        }
    }

    // ── Recovery: check for in-flight orders from previous session ──
    log('🔍 Checking for unfinished orders...');
    let hadActiveOrderAtStart = false; // Track if there was an active order at start
    try {
        const activeOrder = await getActiveOrderWithRetry(swapApi, session.swapToken, log);
        if (activeOrder?.orderId) {
            const TERMINAL = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
            if (!TERMINAL.includes(activeOrder.status)) {
                hadActiveOrderAtStart = true; // Mark that we had active order
                log(`🔄 Resume ${shortId(activeOrder.orderId)} (${activeOrder.status})`);
                dashboard.update(index, { status: `resuming ${activeOrder.status}` });

                const maxResumePoll = Infinity;
                let resumeCount = 0;
                let lastResumeStatus = activeOrder.status;
                while (resumeCount < maxResumePoll) {
                    await sleep(5);
                    resumeCount++;
                    if (resumeCount % 12 === 0) await session.ensureFreshTokens(walletApi, swapApi, log);
                    try {
                        const check = await swapApi.getOrderStatus(session.swapToken, activeOrder.orderId);
                        if (check.status !== lastResumeStatus) {
                            log(`⏳ Order: ${lastResumeStatus} → ${check.status}`);
                            lastResumeStatus = check.status;
                        }
                        if (TERMINAL.includes(check.status)) {
                            log(`✅ Order ${shortId(activeOrder.orderId)} → ${check.status}`);
                            break;
                        }
                    } catch (pollErr) {
                        if (pollErr.response?.status === 401) {
                            await session.refreshSwapToken(swapApi, log);
                            continue;
                        }
                        log(`✅ Order resolved`);
                        break;
                    }
                }
            } else {
                log(`✅ Previous order already ${activeOrder.status}`);
            }
        } else {
            log('✅ No unfinished orders');
        }
    } catch {
        log('✅ No active orders found');
    }

    log('📩 Checking pending offers...');
    await acceptPendingOffers(ctx);

    log('💰 Refreshing balances...');
    try {
        const { holdings: h } = await session.withRetry(
            () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
        );
        ccBalance = getHoldingBal(h, CC_ASSET_KEYS);
        usdcxBalance = getHoldingBal(h, getPairBAssetKeys());
        holdingsCache = h || holdingsCache;
        dashboard.update(index, { cc: ccBalance, usdcx: usdcxBalance });
        log(`💰 CC:${ccBalance.toFixed(2)} ${getPairBLabel()}:${usdcxBalance.toFixed(getPairBDecimals())}`);
    } catch { /* use original */ }


    const ccReserve = config.swap.cc_reserve ?? 0.1;
    const initialSwapAmount = getMinThreshold();
    log(`⚡ ${rounds} siklus (swap_amount:${initialSwapAmount.toFixed(2)}CC${dynamicMinSwap.enabled ? ' [dynamic]' : ''})`);
    let totalSwaps = 0;

    // ══════════════════════════════════════════════════════════════
    // ── TRIANGULAR SWAP CYCLE ENGINE (3 TX/hour)                ──
    // ══════════════════════════════════════════════════════════════
    // Mode B: No pre-emptive cooldown, 429-driven timing
    //   Step 1: CC   → USDCx          (langsung)
    //   Step 2: USDCx → CETH          (langsung)
    //   Step 3: CETH → CC             (kena 429 → tunggu 28m → retry)
    //   ⏳ Smart cooldown: sisa waktu untuk genap 1 jam dari start siklus
    // Total: ~60 min per cycle, 3 TX/hour = max allowed
    // ══════════════════════════════════════════════════════════════

    const pair_usdcx = config.swap.pair_b || { chain: 'CC', asset: 'USDCX', label: 'USDCX' };
    const pair_ceth = config.swap.pair_ceth || { chain: 'CC', asset: 'CETH', label: 'CETH' };
    const rateLimitWaitSec = config.swap.rate_limit_wait_seconds ?? 1860; // 31 minutes default

    // Helper: fetch pending rebates from leaderboard API
    async function fetchPendingRebates() {
        try {
            await session.ensureFreshTokens(walletApi, swapApi, log);
            const lb = await swapApi.getLeaderboard(session.partyId);
            const me = lb.requestedAddress || null;
            if (me) return parseFloat(me.rewardAccruedCc ?? 0);
        } catch { /* skip */ }
        return 0;
    }

    // Track last swap failure reason for smart retry in consolSwapToCC
    let lastSwapFailReason = 'unknown'; // 'belowMinimum' | 'rateLimit' | 'network' | 'unknown'

    // Helper: execute one swap step
    async function doSwapStep(stepNum, fromPair, toPair, amount) {
        lastSwapFailReason = 'unknown';
        const decimals = fromPair.asset === 'CETH' ? 10 : 4;
        log(`\n🔄 Step ${stepNum}: ${amount.toFixed(decimals)} ${fromPair.label} → ${toPair.label}`);
        dashboard.update(index, { status: `S${stepNum} ${fromPair.label}→${toPair.label}` });

        // Capture rCC balance BEFORE swap (direct token tracking replaces rebate API polling)
        const rccBeforeStep = parseFloat(dashboard.accounts[index]?.rcc) || 0;

        await session.ensureFreshTokens(walletApi, swapApi, log);
        await resolveActiveOrder(ctx);

        const result = await executeSwap(ctx, {
            fromChain: fromPair.chain, fromAsset: fromPair.asset,
            toChain: toPair.chain, toAsset: toPair.asset,
            amount, fromLabel: fromPair.label, toLabel: toPair.label,
            instrumentAdminId: getInstrumentAdminId(holdingsCache, fromPair.asset),
        }, { pollTimeoutMinutes: 15 });

        if (!result || result.error) {
            const msg = (result?.message || '').toLowerCase();
            if (msg.includes('below minimum') || msg.includes('minimum')) {
                lastSwapFailReason = 'belowMinimum';
            } else if (msg.includes('rate') || msg.includes('429') || msg.includes('limit')) {
                lastSwapFailReason = 'rateLimit';
            } else if (msg.includes('econnaborted') || msg.includes('timeout') || msg.includes('network')) {
                lastSwapFailReason = 'network';
            } else {
                lastSwapFailReason = 'unknown';
            }
            log(`❌ Step ${stepNum} failed: ${result?.message || 'unknown'} [reason: ${lastSwapFailReason}]`);
            return null;
        }

        await sleep(5);
        try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
        await sleep(3);
        try { await acceptPendingOffers(ctx); } catch { /* ignore */ }

        try {
            const refreshed = await refreshAccountData(ctx);
            holdingsCache = refreshed || holdingsCache;
            ccBalance = getHoldingBal(refreshed, CC_ASSET_KEYS);
        } catch { /* use cached */ }

        const uBal = getHoldingBal(holdingsCache, USDCX_ASSET_KEYS);
        const cBal = getHoldingBal(holdingsCache, CETH_ASSET_KEYS);
        // Only count normal chain swaps, not rescue/recovery/top-up/cleanup:
        // T* = rescue top-up (T0, T1)   | R* = startup recovery (R0, R1)
        // F* = final cleanup (F1, F2)   | *-T = mode 5 top-up (P1-T)
        // M6-T/M6-RT = mode 6 top-up    | *-R = mode 5 retry end (rarely)
        const isRescueSwap = typeof stepNum === 'string' && /^[TRF]|[-]T$|[-]R$|M6-.*T/.test(stepNum);
        if (!isRescueSwap) {
            dashboard.update(index, { cc: ccBalance, usdcx: uBal, ceth: cBal, totalSwaps: totalSwaps + 1 });
            totalSwaps++;
        } else {
            dashboard.update(index, { cc: ccBalance, usdcx: uBal, ceth: cBal });
        }

        // Calculate per-step rCC gain (rCC token landed directly, replaces rebate polling)
        let rccAfterStep = parseFloat(dashboard.accounts[index]?.rcc) || 0;
        // If rCC hasn't updated yet, do one more balance refresh after short delay
        if (rccAfterStep <= rccBeforeStep) {
            await sleep(8);
            try {
                const refreshed2 = await refreshAccountData(ctx);
                holdingsCache = refreshed2 || holdingsCache;
                rccAfterStep = parseFloat(dashboard.accounts[index]?.rcc) || 0;
            } catch { /* skip */ }
        }
        const stepReward = Math.max(0, rccAfterStep - rccBeforeStep);

        const recvDec = toPair.asset === 'CETH' ? 10 : 4;
        const rewStr = stepReward > 0 ? ` | 🟣 rCC +${stepReward.toFixed(4)}` : '';
        log(`✅ Step ${stepNum} OK: +${parseFloat(result.receiveAmount || 0).toFixed(recvDec)} ${toPair.label} | CC:${ccBalance.toFixed(2)} USDCx:${uBal.toFixed(4)} CETH:${cBal.toFixed(10)} rCC:${rccAfterStep.toFixed(4)}${rewStr}`);
        await sendSwapNotification(ctx, `S${stepNum}`, amount, result, fromPair, toPair, stepReward);

        return { result, ccBalance, usdcxBal: uBal, cethBal: cBal, stepReward };
    }

    // Helper: do the 31-minute cooldown wait with countdown in dashboard
    async function doCooldownWait(reason) {
        const waitSec = rateLimitWaitSec;
        const waitMin = Math.round(waitSec / 60);
        log(`\n⏳ ${reason}: menunggu ${waitMin} menit...`);
        dashboard.update(index, { status: `cooldown ${waitMin}m` });
        await sleep(waitSec);
        log(`✅ Cooldown selesai, lanjut swap...`);
    }

    // ══════════════════════════════════════════════════════
    // ── MULTI-MODE SWAP ENGINE (Mode 1-5)               ──
    // ══════════════════════════════════════════════════════

    const cooldownBetweenBatches = config.swap.cooldown_seconds ?? 1320;

    if (swapMode === 5) {
        // ════════════════════════════════════════════════════
        // MODE 5: CONSOLIDATE — swap semua USDCx + CETH → CC
        //
        // Flow:
        //   1. Resolve stuck orders (infinite poll)
        //   2. Accept all pending offers
        //   3. Swap USDCx → CC (jika ada)
        //   4. Swap CETH → CC (jika ada)
        //   5. Jika below minimum → top-up 25 CC → pair, lalu swap ALL balik ke CC
        //   6. Jika kena 429 rate limit → tunggu (sama kayak mode 4)
        //   7. Selesai jika CC > 40 & USDCx ≈ 0 & CETH ≈ 0 → auto stop
        // ════════════════════════════════════════════════════

        const CONSOL_CC_TARGET = 35;  // CC harus di atas ini untuk dianggap selesai
        const CONSOL_USDCX_DUST = 0.5;   // di bawah ini dianggap kosong
        const CONSOL_CETH_DUST = 0.0001;  // di bawah ini dianggap kosong
        const topUpAmount = config.swap.min_amount || 25;

        log('\n' + '═'.repeat(55));
        log('🔄 MODE 5: CONSOLIDATE — semua pair → CC');
        log('═'.repeat(55));

        // ── Cleanup stale needsHelp entries dari soft-restart sebelumnya ──
        // Hindari donor over-donation kalau wallet ini sebelumnya request donation tapi sekarang self-resolve
        const staleCount = consolCoordinator.needsHelp.filter(h => h.index === index && !h.resolved).length;
        if (staleCount > 0) {
            log('🧹 Cleanup ' + staleCount + ' stale donation request(s) dari run sebelumnya');
            consolCoordinator.needsHelp = consolCoordinator.needsHelp.filter(h => h.index !== index || h.resolved);
        }

        // ── Phase 0: Infinite resolve stuck orders + accept offers ──
        log('🔍 Phase 0: Resolve stuck orders & accept pending offers...');
        dashboard.update(index, { status: 'consol: resolving' });

        let stuckSinceMs = 0;
        let lastTelegramMin = 0;
        let resolveRound = 0;

        while (true) {
            resolveRound++;

            // Resolve active orders
            try {
                await session.ensureFreshTokens(walletApi, swapApi, log);
                await resolveActiveOrder(ctx);
            } catch { /* ignore */ }

            // Wallet confirmations
            try { await signAndFinaliseDelegations(walletApi, session, log); } catch { /* ignore */ }
            try { await walletApi.getRegisterStatus(session.walletToken); } catch { /* ignore */ }

            // Expired offers
            try {
                const expired = await walletApi.getOutgoingExpired(session.walletToken);
                if (expired?.offers?.length > 0) {
                    log('📬 Found ' + expired.offers.length + ' expired offers');
                }
            } catch { /* ignore */ }

            // Accept pending offers (3x)
            for (let i = 0; i < 3; i++) {
                try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
                await sleep(3);
            }

            // Refresh balance
            try {
                const { holdings: h } = await session.withRetry(
                    () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                );
                ccBalance = getHoldingBal(h, CC_ASSET_KEYS);
                usdcxBalance = getHoldingBal(h, USDCX_ASSET_KEYS);
                const cethBal = getHoldingBal(h, CETH_ASSET_KEYS);
                holdingsCache = h || holdingsCache;
                dashboard.update(index, { cc: ccBalance, usdcx: usdcxBalance, ceth: cethBal });
                log('💰 CC:' + ccBalance.toFixed(4) + ' USDCx:' + usdcxBalance.toFixed(4) + ' CETH:' + cethBal.toFixed(10));
            } catch { /* cached */ }

            // Check if there are still active orders
            let hasActiveOrder = false;
            try {
                const activeOrder = await getActiveOrderWithRetry(swapApi, session.swapToken, log);
                const TERMINAL = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
                if (activeOrder?.orderId && !TERMINAL.includes(activeOrder.status)) {
                    hasActiveOrder = true;
                    if (!stuckSinceMs) stuckSinceMs = Date.now();
                    const stuckMin = Math.round((Date.now() - stuckSinceMs) / 60000);
                    log('⏳ Active order: ' + shortId(activeOrder.orderId) + ' (' + activeOrder.status + ') stuck ' + stuckMin + 'm');
                    dashboard.update(index, { status: 'consol: order stuck ' + stuckMin + 'm' });

                    // Telegram update every 10 min
                    if (stuckMin >= lastTelegramMin + 10) {
                        lastTelegramMin = stuckMin;
                        const a = dashboard.accounts[index];
                        await sendTelegramMessage(
                            `⏳ <b>CONSOL: Order Stuck</b>\n` +
                            `👤 ${a?.name || name}\n` +
                            `───────────────────\n` +
                            `📋 Order: <code>${shortId(activeOrder.orderId)}</code> (${activeOrder.status})\n` +
                            `💰 CC: <code>${ccBalance.toFixed(4)}</code>\n` +
                            `⏱ Stuck: ${stuckMin} menit\n` +
                            `⏳ Nunggu order selesai...`
                        );
                    }
                }
            } catch { /* no active order = good */ }

            if (!hasActiveOrder) {
                if (stuckSinceMs) {
                    const resolvedMin = Math.round((Date.now() - stuckSinceMs) / 60000);
                    log('✅ Stuck order resolved! (' + resolvedMin + 'm)');
                    stuckSinceMs = 0;
                    lastTelegramMin = 0;
                }
                break; // No active orders, proceed to consolidation
            }

            // Escalating wait
            const interval = resolveRound <= 15 ? 30 : resolveRound <= 30 ? 60 : 120;
            await sleep(interval);
        }

        log('✅ Phase 0 done: no active orders');

        // ── Helper: cek nilai CC real dari pair balance via quote API ──
        // Return receiveAmount (CC) kalau swap pair→CC di-quote sukses, atau null kalau gagal/unknown.
        // Dipakai untuk membedakan "benar-benar below minimum" vs "false-positive belowMinimum / network error"
        async function getPairValueCC(fromPair, balance) {
            if (!balance || balance <= 0) return 0;
            try {
                const q = await swapApi.getQuote(
                    fromPair.chain, fromPair.asset,
                    pair_a.chain, pair_a.asset,
                    balance
                );
                if (q && q.receiveAmount != null) {
                    return parseFloat(q.receiveAmount);
                }
            } catch (e) {
                // Kalau quote gagal karena "below minimum", berarti value memang < 25 CC
                const msg = (e?.response?.data?.detail || e?.response?.data?.message || e?.message || '').toString().toLowerCase();
                if (msg.includes('minimum') || msg.includes('below')) {
                    return 0; // confirmed below minimum
                }
                // Kalau gagal karena network/rate limit/unknown → tidak bisa tentukan
                return null;
            }
            return null;
        }

        // ── Helper: try swap pair→CC with retries, if genuinely "below minimum" → auto top-up CC→pair → retry ──
        async function consolSwapToCC(phaseName, fromPair, fromBalance, fromDecimals, dustThreshold) {
            if (fromBalance < dustThreshold) {
                log('✅ ' + phaseName + ': ' + fromPair.label + ' clean (' + fromBalance.toFixed(fromDecimals) + ')');
                return true; // already clean
            }

            log('\n🔄 ' + phaseName + ': ' + fromPair.label + '(' + fromBalance.toFixed(fromDecimals) + ') → CC');
            dashboard.update(index, { status: 'consol: ' + fromPair.label + '→CC' });

            // ── Try swap directly — infinite retry for rate limit/network, break on belowMinimum ──
            const rlInitialMin = config.retry?.rate_limit_initial_delay_minutes ?? 15;
            const rlDelays = config.retry?.rate_limit_delays || [5, 10, 10, 10, 10];
            const rlMaxTotalMin = config.retry?.rate_limit_max_total_minutes ?? 60;
            let rlTotalWaitMin = 0;
            let rlAttempt = 0;

            for (let attempt = 1; ; attempt++) {
                log('🔄 Attempt ' + attempt + ': ' + fromBalance.toFixed(fromDecimals) + ' ' + fromPair.label + ' → CC');
                dashboard.update(index, { status: 'consol: ' + fromPair.label + '→CC #' + attempt });

                // Refresh tokens before each attempt
                await session.ensureFreshTokens(walletApi, swapApi, log);

                const result = await doSwapStep(phaseName + (attempt > 1 ? '-' + attempt : ''), fromPair, pair_a, fromBalance);
                if (result) {
                    ccBalance = result.ccBalance;
                    log('✅ ' + fromPair.label + ' → CC done! CC:' + ccBalance.toFixed(4));
                    return true;
                }

                // ── CETH fallback: kalau CETH→CC gagal (pair MT), coba CETH→USDCx→CC ──
                if (fromPair.asset === 'CETH' && lastSwapFailReason !== 'rateLimit' && lastSwapFailReason !== 'rateLimited') {
                    log('🔄 CETH→CC gagal [' + lastSwapFailReason + '] → fallback CETH→USDCx→CC');
                    dashboard.update(index, { status: 'consol: CETH→USDCx (fallback)' });

                    // Step 1: CETH → USDCx
                    const fbResult = await doSwapStep(phaseName + '-FB1', fromPair, pair_usdcx, fromBalance);
                    if (fbResult) {
                        ccBalance = fbResult.ccBalance;
                        log('✅ CETH → USDCx done!');

                        // Refresh balance untuk dapet USDCx amount
                        await sleep(3);
                        try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
                        let fbUsdcx;
                        try {
                            const { holdings: fbh } = await session.withRetry(
                                () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                            );
                            holdingsCache = fbh || holdingsCache;
                            fbUsdcx = getHoldingBal(fbh, USDCX_ASSET_KEYS);
                            ccBalance = getHoldingBal(fbh, CC_ASSET_KEYS);
                            dashboard.update(index, {
                                cc: ccBalance,
                                usdcx: fbUsdcx,
                                ceth: getHoldingBal(fbh, CETH_ASSET_KEYS),
                            });
                        } catch { fbUsdcx = 0; }

                        // Step 2: USDCx → CC (pakai consolSwapToCC recursive)
                        if (fbUsdcx >= CONSOL_USDCX_DUST) {
                            log('🔄 Fallback step 2: ' + fbUsdcx.toFixed(4) + ' USDCx → CC');
                            dashboard.update(index, { status: 'consol: USDCx→CC (fallback)' });
                            const fbCcResult = await consolSwapToCC(phaseName + '-FB2', pair_usdcx, fbUsdcx, 4, CONSOL_USDCX_DUST);
                            if (fbCcResult) {
                                log('✅ Fallback CETH→USDCx→CC complete!');
                                return true;
                            }
                        }
                        // USDCx might be 0 if CETH→USDCx produced dust → consider done
                        log('✅ CETH cleaned via fallback (USDCx→CC will handle remaining)');
                        return true;
                    } else {
                        log('⚠️ Fallback CETH→USDCx juga gagal [' + lastSwapFailReason + ']');
                        // Fall through ke rate limit delay logic di bawah
                    }
                }

                // ── Check WHY it failed ──
                if (lastSwapFailReason === 'belowMinimum') {
                    // Double-check via quote: apakah pair value BENAR-BENAR < topUpAmount CC?
                    // Kalau value >= topUpAmount, ini false-positive (API error msg nyebut "minimum" tapi bukan karena balance kurang)
                    const pairValCC = await getPairValueCC(fromPair, fromBalance);
                    if (pairValCC !== null && pairValCC >= topUpAmount) {
                        log('📊 Quote says ' + fromPair.label + ' = ' + pairValCC.toFixed(2) + ' CC (≥ ' + topUpAmount + ') → false-positive belowMinimum, keep retrying direct swap');
                        lastSwapFailReason = 'transient';
                        // fall through ke delay logic di bawah (retry langsung, bukan top-up)
                    } else {
                        log('📉 Confirmed below minimum (quote: ' + (pairValCC !== null ? pairValCC.toFixed(2) + ' CC' : 'unknown') + ' < ' + topUpAmount + ') → masuk top-up path');
                        break; // Exit retry loop → go to top-up path below
                    }
                }

                // Rate limit / ECONNABORTED / network / unknown → escalating delay like Mode 4
                let delayMin;
                if (rlAttempt === 0) {
                    delayMin = rlInitialMin; // 15m first
                } else {
                    delayMin = rlDelays[Math.min(rlAttempt - 1, rlDelays.length - 1)]; // 5m, 10m, 10m...
                }

                // Check if exceeded max total
                if (rlTotalWaitMin + delayMin > rlMaxTotalMin) {
                    delayMin = rlMaxTotalMin - rlTotalWaitMin;
                    if (delayMin <= 0) {
                        // Reset counter — start fresh cycle
                        log('🔄 Rate limit cycle selesai (' + rlMaxTotalMin + 'm), mulai ulang...');
                        rlTotalWaitMin = 0;
                        rlAttempt = 0;
                        delayMin = rlInitialMin;
                    }
                }

                rlTotalWaitMin += delayMin;
                rlAttempt++;
                const remaining = rlMaxTotalMin - rlTotalWaitMin;
                log('⏳ ' + lastSwapFailReason + ' — ' + delayMin + 'm (total: ' + rlTotalWaitMin + '/' + rlMaxTotalMin + 'm, sisa: ' + remaining + 'm)');
                dashboard.update(index, { status: 'consol: ' + lastSwapFailReason + ' ' + delayMin + 'm (' + rlTotalWaitMin + '/' + rlMaxTotalMin + 'm)' });
                await sleep(delayMin * 60);

                // Re-login after cooldown (same as Mode 4)
                log('🔐 Re-authenticating after cooldown...');
                try {
                    await session.ensureFreshTokens(walletApi, swapApi, log);
                    const { nonce } = await swapApi.getNonce();
                    const swapAuth = await swapApi.bindSignature(nonce, session.partyId);
                    session.swapToken = swapAuth.accessToken;
                    session.swapLoginTime = Date.now();
                    log('✅ Re-authenticated');
                } catch (reAuthErr) {
                    log('⚠️ Re-auth failed: ' + formatError(reAuthErr) + ' → will retry');
                }

                // Refresh balance after wait
                try {
                    await acceptPendingOffers(ctx);
                    const { holdings: rh } = await session.withRetry(
                        () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                    );
                    holdingsCache = rh || holdingsCache;
                    fromBalance = getHoldingBal(rh, fromPair.asset === 'USDCX' ? USDCX_ASSET_KEYS : CETH_ASSET_KEYS);
                    ccBalance = getHoldingBal(rh, CC_ASSET_KEYS);
                    dashboard.update(index, {
                        cc: ccBalance,
                        usdcx: getHoldingBal(rh, USDCX_ASSET_KEYS),
                        ceth: getHoldingBal(rh, CETH_ASSET_KEYS),
                    });
                } catch { /* cached */ }

                if (fromBalance < dustThreshold) {
                    log('✅ ' + fromPair.label + ' now clean after wait');
                    return true;
                }
            }

            // ── Only reach here if: API confirmed belowMinimum ──
            log('⚠️ ' + fromPair.label + ' → CC gagal [reason: ' + lastSwapFailReason + ']');

            if (ccBalance < topUpAmount + ccReserve) {
                log('❌ CC(' + ccBalance.toFixed(2) + ') kurang untuk top-up (' + topUpAmount + ' + ' + ccReserve + ')');
                return false;
            }

            // ── Top-up path: CC→pair to boost balance, then swap ALL back to CC ──
            dashboard.update(index, { status: 'consol: topup→' + fromPair.label });
            log('🔄 Top-up: ' + topUpAmount + ' CC → ' + fromPair.label);
            const topResult = await doSwapStep(phaseName + '-T', pair_a, fromPair, topUpAmount);
            if (!topResult) {
                log('❌ Top-up CC → ' + fromPair.label + ' gagal');
                return false;
            }
            ccBalance = topResult.ccBalance;
            // totalSwaps already incremented inside doSwapStep

            // Refresh balance to get new pair amount
            await sleep(5);
            try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
            try {
                const { holdings: th } = await session.withRetry(
                    () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                );
                holdingsCache = th || holdingsCache;
                fromBalance = getHoldingBal(th, fromPair.asset === 'USDCX' ? USDCX_ASSET_KEYS : CETH_ASSET_KEYS);
                ccBalance = getHoldingBal(th, CC_ASSET_KEYS);
                dashboard.update(index, {
                    cc: ccBalance,
                    usdcx: getHoldingBal(th, USDCX_ASSET_KEYS),
                    ceth: getHoldingBal(th, CETH_ASSET_KEYS),
                });
            } catch { /* cached */ }

            // Retry with rate limit wait: swap ALL boosted balance → CC
            const m5RlWaitMin = Math.round((config.swap.rate_limit_wait_seconds ?? 3600) / 60);
            const m5MaxRetries = 5;
            for (let retryAttempt = 1; retryAttempt <= m5MaxRetries; retryAttempt++) {
                // Setelah top-up pasti kena rate limit → tunggu dulu
                log('⏳ Cooldown ' + m5RlWaitMin + 'm sebelum retry ' + fromPair.label + '→CC (' + retryAttempt + '/' + m5MaxRetries + ')');
                dashboard.update(index, { status: 'consol: wait ' + m5RlWaitMin + 'm (' + fromPair.label + ')' });
                await sleep(m5RlWaitMin * 60);

                // Re-auth setelah cooldown
                try {
                    await session.ensureFreshTokens(walletApi, swapApi, log);
                    const { nonce } = await swapApi.getNonce();
                    const swapAuth = await swapApi.bindSignature(nonce, session.partyId);
                    session.swapToken = swapAuth.accessToken;
                    session.swapLoginTime = Date.now();
                    log('✅ Re-authenticated');
                } catch (e) { log('⚠️ Re-auth: ' + formatError(e)); }

                // Refresh balance
                try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
                try {
                    const { holdings: rh } = await session.withRetry(
                        () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                    );
                    holdingsCache = rh || holdingsCache;
                    fromBalance = getHoldingBal(rh, fromPair.asset === 'USDCX' ? USDCX_ASSET_KEYS : CETH_ASSET_KEYS);
                    ccBalance = getHoldingBal(rh, CC_ASSET_KEYS);
                    dashboard.update(index, {
                        cc: ccBalance,
                        usdcx: getHoldingBal(rh, USDCX_ASSET_KEYS),
                        ceth: getHoldingBal(rh, CETH_ASSET_KEYS),
                    });
                } catch { /* cached */ }

                if (fromBalance < dustThreshold) {
                    log('✅ ' + fromPair.label + ' sudah clean setelah cooldown!');
                    return true;
                }

                log('🔄 Retry ' + retryAttempt + '/' + m5MaxRetries + ': ' + fromBalance.toFixed(fromDecimals) + ' ' + fromPair.label + ' → CC');
                dashboard.update(index, { status: 'consol: ' + fromPair.label + '→CC #' + retryAttempt });
                const retryResult = await doSwapStep(phaseName + '-R' + retryAttempt, fromPair, pair_a, fromBalance);
                if (retryResult) {
                    ccBalance = retryResult.ccBalance;
                    log('✅ ' + fromPair.label + ' → CC done (after top-up)! CC:' + ccBalance.toFixed(4));
                    return true;
                }

                // Setelah top-up, pair PASTI di atas minimum (25 CC ditambahkan).
                // Fail apapun (rateLimit/network/unknown) dianggap transient → retry sampai m5MaxRetries.
                // Hanya break kalau benar-benar belowMinimum (aneh post-top-up, mungkin balance refresh gagal).
                if (lastSwapFailReason === 'belowMinimum') {
                    // Verifikasi lagi via quote — kalau value masih >= topUpAmount, lanjut retry
                    const postTopupVal = await getPairValueCC(fromPair, fromBalance);
                    if (postTopupVal !== null && postTopupVal >= topUpAmount) {
                        log('📊 Post-top-up quote: ' + fromPair.label + ' = ' + postTopupVal.toFixed(2) + ' CC (≥ ' + topUpAmount + ') → retry terus');
                        continue;
                    }
                    log('❌ Post-top-up masih below minimum (quote: ' + (postTopupVal !== null ? postTopupVal.toFixed(2) : '?') + ' CC) → stop');
                    break;
                }
                log('⏳ ' + fromPair.label + '→CC gagal [' + lastSwapFailReason + '] — retry lagi (' + retryAttempt + '/' + m5MaxRetries + ')');
                continue;
            }

            log('❌ ' + fromPair.label + ' → CC masih gagal setelah top-up + retries');
            return false;
        }

        // ── Phase 1: Consolidate USDCx → CC ──
        let currentUsdcx = getHoldingBal(holdingsCache, USDCX_ASSET_KEYS);
        let currentCeth = getHoldingBal(holdingsCache, CETH_ASSET_KEYS);
        await consolSwapToCC('P1', pair_usdcx, currentUsdcx, 4, CONSOL_USDCX_DUST);

        // ── Phase 2: Consolidate CETH → CC ──
        // Refresh balance after Phase 1
        try {
            const { holdings: h2 } = await session.withRetry(
                () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
            );
            holdingsCache = h2 || holdingsCache;
            ccBalance = getHoldingBal(h2, CC_ASSET_KEYS);
            currentCeth = getHoldingBal(h2, CETH_ASSET_KEYS);
            currentUsdcx = getHoldingBal(h2, USDCX_ASSET_KEYS);
            dashboard.update(index, { cc: ccBalance, usdcx: currentUsdcx, ceth: currentCeth });
        } catch { /* cached */ }

        await consolSwapToCC('P2', pair_ceth, currentCeth, 10, CONSOL_CETH_DUST);

        // ── Phase 3: Final check + cross-wallet help ──
        await sleep(5);
        try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
        await sleep(3);
        try { await acceptPendingOffers(ctx); } catch { /* ignore */ }

        try {
            const { holdings: hf } = await session.withRetry(
                () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
            );
            holdingsCache = hf || holdingsCache;
            ccBalance = getHoldingBal(hf, CC_ASSET_KEYS);
            currentUsdcx = getHoldingBal(hf, USDCX_ASSET_KEYS);
            currentCeth = getHoldingBal(hf, CETH_ASSET_KEYS);
            dashboard.update(index, { cc: ccBalance, usdcx: currentUsdcx, ceth: currentCeth });
        } catch { /* cached */ }

        let isConsolidated = currentUsdcx < CONSOL_USDCX_DUST && currentCeth < CONSOL_CETH_DUST;

        // ── Phase 3a-pre: Kalau pair sangkut valuenya >= 25 CC, retry swap langsung (no donation needed) ──
        // Donation HANYA untuk case pair sangkut < 25 CC (butuh top-up CC→pair dulu)
        if (!isConsolidated) {
            let keepRetrying = true;
            let retryRound = 0;
            while (keepRetrying && retryRound < 3 && !isConsolidated) {
                retryRound++;
                keepRetrying = false;

                // Cek nilai CC dari USDCx & CETH yang masih sangkut
                let usdcxValCC = null, cethValCC = null;
                if (currentUsdcx >= CONSOL_USDCX_DUST) {
                    usdcxValCC = await getPairValueCC(pair_usdcx, currentUsdcx);
                    log('📊 USDCx ' + currentUsdcx.toFixed(4) + ' = ' + (usdcxValCC !== null ? usdcxValCC.toFixed(2) + ' CC' : '? CC (quote fail)'));
                }
                if (currentCeth >= CONSOL_CETH_DUST) {
                    cethValCC = await getPairValueCC(pair_ceth, currentCeth);
                    log('📊 CETH ' + currentCeth.toFixed(10) + ' = ' + (cethValCC !== null ? cethValCC.toFixed(2) + ' CC' : '? CC (quote fail)'));
                }

                // Retry langsung untuk pair yang valuenya >= 25 CC (tanpa top-up/donation)
                if (usdcxValCC !== null && usdcxValCC >= topUpAmount && currentUsdcx >= CONSOL_USDCX_DUST) {
                    log('🔄 USDCx value ' + usdcxValCC.toFixed(2) + ' CC ≥ ' + topUpAmount + ' → retry direct swap (skip donation)');
                    await consolSwapToCC('P3a-U' + retryRound, pair_usdcx, currentUsdcx, 4, CONSOL_USDCX_DUST);
                    keepRetrying = true;
                }
                if (cethValCC !== null && cethValCC >= topUpAmount && currentCeth >= CONSOL_CETH_DUST) {
                    log('🔄 CETH value ' + cethValCC.toFixed(2) + ' CC ≥ ' + topUpAmount + ' → retry direct swap (skip donation)');
                    await consolSwapToCC('P3a-C' + retryRound, pair_ceth, currentCeth, 10, CONSOL_CETH_DUST);
                    keepRetrying = true;
                }

                if (keepRetrying) {
                    // Refresh balances setelah retry
                    try {
                        const { holdings: rh } = await session.withRetry(
                            () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                        );
                        holdingsCache = rh || holdingsCache;
                        ccBalance = getHoldingBal(rh, CC_ASSET_KEYS);
                        currentUsdcx = getHoldingBal(rh, USDCX_ASSET_KEYS);
                        currentCeth = getHoldingBal(rh, CETH_ASSET_KEYS);
                        dashboard.update(index, { cc: ccBalance, usdcx: currentUsdcx, ceth: currentCeth });
                    } catch { /* cached */ }
                    isConsolidated = currentUsdcx < CONSOL_USDCX_DUST && currentCeth < CONSOL_CETH_DUST;
                }
            }
        }

        // ── Phase 3a: If not consolidated & CC too low & stuck pair value < topUpAmount → request help ──
        // Hanya minta donation kalau SEMUA pair sangkut nilainya di bawah topUpAmount CC
        // (butuh top-up CC→pair untuk bisa swap balik, tapi CC kurang untuk top-up)
        let needsDonation = false;
        if (!isConsolidated && ccBalance < topUpAmount + ccReserve) {
            // Cek: apakah ada pair sangkut yang valuenya MASIH >= topUpAmount?
            // Kalau ada → jangan minta donation (harusnya bisa di-swap langsung)
            let anyPairAboveMin = false;
            if (currentUsdcx >= CONSOL_USDCX_DUST) {
                const v = await getPairValueCC(pair_usdcx, currentUsdcx);
                if (v !== null && v >= topUpAmount) anyPairAboveMin = true;
            }
            if (!anyPairAboveMin && currentCeth >= CONSOL_CETH_DUST) {
                const v = await getPairValueCC(pair_ceth, currentCeth);
                if (v !== null && v >= topUpAmount) anyPairAboveMin = true;
            }
            if (anyPairAboveMin) {
                log('⏭️ Ada pair sangkut value ≥ ' + topUpAmount + ' CC → skip donation, harusnya bisa swap langsung (mungkin rate limit sementara)');
            } else {
                needsDonation = true;
            }
        }

        if (needsDonation) {
            const amountNeeded = Math.ceil((topUpAmount + 3) - ccBalance); // e.g., 28 - 24.63 = ~4 CC
            log('📢 CC(' + ccBalance.toFixed(2) + ') kurang untuk top-up & pair sangkut < ' + topUpAmount + ' CC → minta bantuan ' + amountNeeded + ' CC dari wallet lain...');
            dashboard.update(index, { status: 'consol: waiting CC help' });

            // Register need
            consolCoordinator.needsHelp.push({
                index, partyId: session.partyId, amountNeeded, resolved: false
            });

            // Send Telegram
            const accInfo = dashboard.accounts[index];
            await sendTelegramMessage(
                `📢 <b>CONSOL: Need CC Help</b>\n` +
                `👤 ${accInfo?.name || name}\n` +
                `───────────────────\n` +
                `💰 CC: <code>${ccBalance.toFixed(4)}</code> (butuh min ${topUpAmount + ccReserve})\n` +
                `💵 USDCx: <code>${currentUsdcx.toFixed(4)}</code>\n` +
                `🪙 CETH: <code>${currentCeth.toFixed(10)}</code>\n` +
                `⏳ Menunggu donasi CC dari wallet lain...`
            );

            // Poll balance until CC increases (max 60 min)
            const maxWaitPolls = 120; // 120 × 30s = 60 min
            for (let wp = 0; wp < maxWaitPolls; wp++) {
                await sleep(30);

                // Accept offers (someone may have sent CC)
                try { await acceptPendingOffers(ctx); } catch { /* ignore */ }

                // Refresh balance
                try {
                    const { holdings: wh } = await session.withRetry(
                        () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                    );
                    holdingsCache = wh || holdingsCache;
                    ccBalance = getHoldingBal(wh, CC_ASSET_KEYS);
                    dashboard.update(index, { cc: ccBalance });
                } catch { /* cached */ }

                if (ccBalance >= topUpAmount + ccReserve) {
                    log('✅ CC help received! CC:' + ccBalance.toFixed(2) + ' → retry consolidation');
                    break;
                }

                if (wp % 20 === 19) {
                    log('⏳ Waiting CC help (' + Math.round((wp + 1) * 30 / 60) + 'm) CC:' + ccBalance.toFixed(2));
                }
            }

            // Mark request as resolved
            const myReq = consolCoordinator.needsHelp.find(h => h.index === index);
            if (myReq) myReq.resolved = true;

            // Retry consolidation if CC is now sufficient
            if (ccBalance >= topUpAmount + ccReserve) {
                // Refresh all balances
                try {
                    const { holdings: rh } = await session.withRetry(
                        () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                    );
                    holdingsCache = rh || holdingsCache;
                    currentUsdcx = getHoldingBal(rh, USDCX_ASSET_KEYS);
                    currentCeth = getHoldingBal(rh, CETH_ASSET_KEYS);
                    ccBalance = getHoldingBal(rh, CC_ASSET_KEYS);
                    dashboard.update(index, { cc: ccBalance, usdcx: currentUsdcx, ceth: currentCeth });
                } catch { /* cached */ }

                log('🔄 Retry Phase 1 & 2 setelah donasi CC...');
                if (currentUsdcx >= CONSOL_USDCX_DUST) {
                    await consolSwapToCC('P1-R', pair_usdcx, currentUsdcx, 4, CONSOL_USDCX_DUST);
                }

                // Refresh after P1 retry
                try {
                    const { holdings: r2 } = await session.withRetry(
                        () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                    );
                    holdingsCache = r2 || holdingsCache;
                    currentCeth = getHoldingBal(r2, CETH_ASSET_KEYS);
                    currentUsdcx = getHoldingBal(r2, USDCX_ASSET_KEYS);
                    ccBalance = getHoldingBal(r2, CC_ASSET_KEYS);
                    dashboard.update(index, { cc: ccBalance, usdcx: currentUsdcx, ceth: currentCeth });
                } catch { /* cached */ }

                if (currentCeth >= CONSOL_CETH_DUST) {
                    await consolSwapToCC('P2-R', pair_ceth, currentCeth, 10, CONSOL_CETH_DUST);
                }

                // Final refresh
                try {
                    const { holdings: rf } = await session.withRetry(
                        () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                    );
                    holdingsCache = rf || holdingsCache;
                    ccBalance = getHoldingBal(rf, CC_ASSET_KEYS);
                    currentUsdcx = getHoldingBal(rf, USDCX_ASSET_KEYS);
                    currentCeth = getHoldingBal(rf, CETH_ASSET_KEYS);
                    dashboard.update(index, { cc: ccBalance, usdcx: currentUsdcx, ceth: currentCeth });
                } catch { /* cached */ }

                isConsolidated = currentUsdcx < CONSOL_USDCX_DUST && currentCeth < CONSOL_CETH_DUST;
            }
        }

        // ── Phase 4: Donate CC to wallets that need help ──
        if (isConsolidated && ccBalance > CONSOL_CC_TARGET + 5) {
            const pendingHelp = consolCoordinator.needsHelp.filter(h => !h.resolved && !h.claimed && h.index !== index);
            for (const helpReq of pendingHelp) {
                // Claim this request atomically to prevent double donation
                if (helpReq.claimed || helpReq.resolved) continue;
                helpReq.claimed = true;
                const donateAmount = Math.min(helpReq.amountNeeded + 2, Math.floor(ccBalance - CONSOL_CC_TARGET));
                if (donateAmount < 1) continue;

                log('💸 Donating ' + donateAmount + ' CC to Acc #' + (helpReq.index + 1) + ' (needs ' + helpReq.amountNeeded + ')');
                dashboard.update(index, { status: 'consol: donating→Acc' + (helpReq.index + 1) });

                try {
                    // Use existing helper for CC instrumentAdminId
                    const ccInstrumentAdminId = getInstrumentAdminId(holdingsCache, '0x0');

                    const rawPrepare = await session.withRetry(() => walletApi.prepareTransfer(session.walletToken, {
                        instrumentAdminId: ccInstrumentAdminId,
                        instrumentId: 'Amulet',
                        receiverPartyId: helpReq.partyId,
                        amount: String(donateAmount),
                        reason: 'consol-help',
                        appName: 'swap-v1',
                        metadata: {},
                    }), 'wallet', walletApi, swapApi, log);

                    const commandId = rawPrepare.command_id || rawPrepare.commandId;
                    const preparedTxB64 = rawPrepare.prepared_tx_b64 || rawPrepare.preparedTxB64;
                    const hashingSchemeVersion = rawPrepare.hashing_scheme_version || rawPrepare.hashingSchemeVersion || 'HASHING_SCHEME_VERSION_V2';
                    const hashB64 = rawPrepare.hash_b64 || rawPrepare.hashB64;

                    if (preparedTxB64 && hashB64) {
                        const signature = signMessage(session.keyPair.privateKey, Buffer.from(hashB64, 'base64'));
                        await session.withRetry(() => walletApi.executeTransaction(session.walletToken, {
                            commandId, preparedTxB64,
                            signatureB64: toBase64(signature),
                            hashingSchemeVersion,
                        }), 'wallet', walletApi, swapApi, log);

                        // Poll transfer status
                        for (let ts = 0; ts < 15; ts++) {
                            await sleep(3);
                            try {
                                const txStatus = await walletApi.getTransferStatus(session.walletToken, commandId);
                                if (txStatus.status === 'success') break;
                            } catch { /* continue */ }
                        }

                        ccBalance -= donateAmount;
                        dashboard.update(index, { cc: ccBalance });
                        log('✅ Donated ' + donateAmount + ' CC to Acc #' + (helpReq.index + 1));

                        await sendTelegramMessage(
                            `💸 <b>CC Donation Sent</b>\n` +
                            `👤 ${dashboard.accounts[index]?.name || name} → Acc #${helpReq.index + 1}\n` +
                            `───────────────────\n` +
                            `💰 Sent: <code>${donateAmount}</code> CC\n` +
                            `💰 Remaining: <code>${ccBalance.toFixed(2)}</code> CC`
                        );
                    }
                } catch (donateErr) {
                    log('⚠️ Donate failed: ' + formatError(donateErr));
                    helpReq.claimed = false; // Release claim so another donor can try
                }

                // Stop donating if CC dropped below threshold
                if (ccBalance <= CONSOL_CC_TARGET + 2) break;
            }
        }

        // ── Phase 3b: If pairs clean but CC still low → funds might not have landed yet ──
        // Keep polling offers/balance until CC reaches target or timeout
        if (isConsolidated && ccBalance < CONSOL_CC_TARGET) {
            log('⏳ Pairs clean tapi CC(' + ccBalance.toFixed(2) + ') < ' + CONSOL_CC_TARGET + ' → mungkin ada saldo belum landing...');
            dashboard.update(index, { status: 'consol: waiting funds' });

            const recoveryMaxPolls = 60; // 60 × 30s = 30 min max
            let lastRecoveryLog = 0;

            for (let rp = 0; rp < recoveryMaxPolls; rp++) {
                // Try to pull in any pending funds
                try { await signAndFinaliseDelegations(walletApi, session, log); } catch { /* ignore */ }
                try { await walletApi.getRegisterStatus(session.walletToken); } catch { /* ignore */ }
                try {
                    const expired = await walletApi.getOutgoingExpired(session.walletToken);
                    if (expired?.offers?.length > 0) {
                        log('📬 Found ' + expired.offers.length + ' expired offers');
                    }
                } catch { /* ignore */ }

                for (let oa = 0; oa < 3; oa++) {
                    try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
                    await sleep(3);
                }

                // Refresh balance
                try {
                    const { holdings: rh } = await session.withRetry(
                        () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                    );
                    holdingsCache = rh || holdingsCache;
                    ccBalance = getHoldingBal(rh, CC_ASSET_KEYS);
                    currentUsdcx = getHoldingBal(rh, USDCX_ASSET_KEYS);
                    currentCeth = getHoldingBal(rh, CETH_ASSET_KEYS);
                    dashboard.update(index, { cc: ccBalance, usdcx: currentUsdcx, ceth: currentCeth });
                } catch { /* cached */ }

                if (ccBalance >= CONSOL_CC_TARGET) {
                    log('✅ Funds landed! CC:' + ccBalance.toFixed(2) + ' >= ' + CONSOL_CC_TARGET);
                    break;
                }

                // Check if new intermediates appeared → need to re-consolidate
                if (currentUsdcx >= CONSOL_USDCX_DUST || currentCeth >= CONSOL_CETH_DUST) {
                    log('🔄 New balance detected! USDCx:' + currentUsdcx.toFixed(4) + ' CETH:' + currentCeth.toFixed(10) + ' → re-consolidate');
                    if (currentUsdcx >= CONSOL_USDCX_DUST) {
                        await consolSwapToCC('P1-F', pair_usdcx, currentUsdcx, 4, CONSOL_USDCX_DUST);
                    }
                    if (currentCeth >= CONSOL_CETH_DUST) {
                        await consolSwapToCC('P2-F', pair_ceth, currentCeth, 10, CONSOL_CETH_DUST);
                    }
                    // Refresh after re-consolidation
                    try {
                        const { holdings: rf } = await session.withRetry(
                            () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                        );
                        holdingsCache = rf || holdingsCache;
                        ccBalance = getHoldingBal(rf, CC_ASSET_KEYS);
                        currentUsdcx = getHoldingBal(rf, USDCX_ASSET_KEYS);
                        currentCeth = getHoldingBal(rf, CETH_ASSET_KEYS);
                        dashboard.update(index, { cc: ccBalance, usdcx: currentUsdcx, ceth: currentCeth });
                    } catch { /* cached */ }
                    isConsolidated = currentUsdcx < CONSOL_USDCX_DUST && currentCeth < CONSOL_CETH_DUST;
                    if (ccBalance >= CONSOL_CC_TARGET) break;
                }

                const stuckMin = Math.round((rp + 1) * 30 / 60);
                if (stuckMin > lastRecoveryLog) {
                    lastRecoveryLog = stuckMin;
                    log('⏳ Waiting funds landing... CC:' + ccBalance.toFixed(2) + ' (' + stuckMin + 'm)');
                    dashboard.update(index, { status: 'consol: waiting funds ' + stuckMin + 'm' });
                }

                await sleep(30);
            }

            // Update consolidated status after recovery
            isConsolidated = currentUsdcx < CONSOL_USDCX_DUST && currentCeth < CONSOL_CETH_DUST;
        }

        // ── Final Report ──
        log('\n' + '═'.repeat(55));
        log('📊 CONSOLIDATION RESULT');
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        log('💰 CC     : ' + ccBalance.toFixed(4));
        log('💵 USDCx  : ' + currentUsdcx.toFixed(4) + (currentUsdcx < CONSOL_USDCX_DUST ? ' ✅' : ' ⚠️'));
        log('🪙 CETH   : ' + currentCeth.toFixed(10) + (currentCeth < CONSOL_CETH_DUST ? ' ✅' : ' ⚠️'));
        log('🔄 Swaps  : ' + totalSwaps);
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        if (isConsolidated && ccBalance >= CONSOL_CC_TARGET) {
            log('✅ CONSOLIDATION COMPLETE! CC(' + ccBalance.toFixed(2) + ') >= ' + CONSOL_CC_TARGET + ' & pair kosong');
            dashboard.update(index, { status: 'consolidated ✅', totalSwaps });
        } else if (isConsolidated) {
            log('✅ Pairs kosong, CC(' + ccBalance.toFixed(2) + ') < ' + CONSOL_CC_TARGET + ' (mungkin total awal segini)');
            dashboard.update(index, { status: 'done (CC:' + ccBalance.toFixed(0) + ')', totalSwaps });
        } else {
            log('⚠️ Masih ada sisa intermediate');
            dashboard.update(index, { status: 'consol partial', totalSwaps });
        }

        // Telegram final notification
        const consolStatus = isConsolidated
            ? (ccBalance >= CONSOL_CC_TARGET ? 'DONE ✅' : 'DONE (CC low)')
            : 'PARTIAL ⚠️';
        const consolFooter = isConsolidated
            ? (ccBalance >= CONSOL_CC_TARGET ? '✅ Fully consolidated!' : '✅ Pairs clean, CC total: ' + ccBalance.toFixed(2))
            : '⏳ Masih ada sisa intermediate';

        const a = dashboard.accounts[index];
        await sendTelegramMessage(
            `🔄 <b>CONSOLIDATE ${consolStatus}</b>\n` +
            `👤 ${a?.name || name}\n` +
            `───────────────────\n` +
            `💰 CC: <code>${ccBalance.toFixed(4)}</code>${ccBalance >= CONSOL_CC_TARGET ? ' ✅' : ' ⚠️'}\n` +
            `💵 USDCx: <code>${currentUsdcx.toFixed(4)}</code>${currentUsdcx < CONSOL_USDCX_DUST ? ' ✅' : ' ⚠️'}\n` +
            `🪙 CETH: <code>${currentCeth.toFixed(10)}</code>${currentCeth < CONSOL_CETH_DUST ? ' ✅' : ' ⚠️'}\n` +
            `🔄 Swaps: ${totalSwaps}\n` +
            consolFooter
        );

        await refreshAccountData(ctx);
        log('🏁 Consolidation finished! ' + totalSwaps + ' swaps');
        dashboard.update(index, { status: isConsolidated ? 'done ✅' : 'done (partial)', totalSwaps });

        // ── Stay alive: help late-registering wallets that need CC donation ──
        // Wallets that finish early stay alive to catch wallets still processing
        if (isConsolidated && ccBalance > CONSOL_CC_TARGET + 5) {
            const stayAlivePolls = 60; // 60 × 30s = 30 min
            log('⏳ Staying alive 30m to help wallets that may need CC...');
            dashboard.update(index, { status: 'done ✅ (helper)' });

            for (let sa = 0; sa < stayAlivePolls; sa++) {
                await sleep(30);

                const lateHelp = consolCoordinator.needsHelp.filter(h => !h.resolved && !h.claimed && h.index !== index);
                if (lateHelp.length === 0) continue;

                for (const helpReq of lateHelp) {
                    // Skip already claimed/resolved
                    if (helpReq.claimed || helpReq.resolved) continue;
                    helpReq.claimed = true;
                    const donateAmt = Math.min(helpReq.amountNeeded + 2, Math.floor(ccBalance - CONSOL_CC_TARGET));
                    if (donateAmt < 1) continue;

                    log('💸 [Helper] Donating ' + donateAmt + ' CC to Acc #' + (helpReq.index + 1));
                    dashboard.update(index, { status: 'helping Acc#' + (helpReq.index + 1) });

                    try {
                        const ccAdminId = getInstrumentAdminId(holdingsCache, '0x0');
                        const rawPrep = await session.withRetry(() => walletApi.prepareTransfer(session.walletToken, {
                            instrumentAdminId: ccAdminId,
                            instrumentId: 'Amulet',
                            receiverPartyId: helpReq.partyId,
                            amount: String(donateAmt),
                            reason: 'consol-help',
                            appName: 'swap-v1',
                            metadata: {},
                        }), 'wallet', walletApi, swapApi, log);

                        const cmdId = rawPrep.command_id || rawPrep.commandId;
                        const prepTx = rawPrep.prepared_tx_b64 || rawPrep.preparedTxB64;
                        const hashScheme = rawPrep.hashing_scheme_version || rawPrep.hashingSchemeVersion || 'HASHING_SCHEME_VERSION_V2';
                        const hash64 = rawPrep.hash_b64 || rawPrep.hashB64;

                        if (prepTx && hash64) {
                            const sig = signMessage(session.keyPair.privateKey, Buffer.from(hash64, 'base64'));
                            await session.withRetry(() => walletApi.executeTransaction(session.walletToken, {
                                commandId: cmdId, preparedTxB64: prepTx,
                                signatureB64: toBase64(sig),
                                hashingSchemeVersion: hashScheme,
                            }), 'wallet', walletApi, swapApi, log);

                            for (let ts = 0; ts < 15; ts++) {
                                await sleep(3);
                                try {
                                    const st = await walletApi.getTransferStatus(session.walletToken, cmdId);
                                    if (st.status === 'success') break;
                                } catch { /* continue */ }
                            }

                            ccBalance -= donateAmt;
                            dashboard.update(index, { cc: ccBalance });
                            log('✅ Donated ' + donateAmt + ' CC to Acc #' + (helpReq.index + 1));
                            helpReq.resolved = true;

                            await sendTelegramMessage(
                                `💸 <b>CC Donation (Helper)</b>\n` +
                                `👤 ${a?.name || name} → Acc #${helpReq.index + 1}\n` +
                                `💰 Sent: <code>${donateAmt}</code> CC | Remaining: <code>${ccBalance.toFixed(2)}</code>`
                            );
                        }
                    } catch (err) {
                        log('⚠️ Helper donate failed: ' + formatError(err));
                        helpReq.claimed = false; // Release claim
                    }

                    if (ccBalance <= CONSOL_CC_TARGET + 2) break;
                }

                if (ccBalance <= CONSOL_CC_TARGET + 2) {
                    log('💰 CC depleted, stopping helper');
                    break;
                }
            }

            dashboard.update(index, { status: 'done ✅' });
        }

        // ── Auto-send CC setelah consolidate selesai (baca threshold dari config) ──
        if (config.auto_send?.enabled) {
            const asCfg = config.auto_send;
            const asThreshold = asCfg.threshold ?? 100;
            if (ccBalance >= asThreshold) {
                log('📤 Post-consol auto-send: CC(' + ccBalance.toFixed(2) + ') >= ' + asThreshold);
                try {
                    const asResult = await autoSendCC(ctx);
                    if (asResult?.success) {
                        ccBalance = asResult.ccBalance;
                        log('✅ Auto-send selesai, sisa CC: ' + ccBalance.toFixed(4));
                        dashboard.update(index, { cc: ccBalance, status: 'done ✅ (sent)' });
                    }
                } catch (asErr) {
                    log('⚠️ Auto-send error: ' + (asErr.message || asErr));
                }
            } else {
                log('💰 CC(' + ccBalance.toFixed(2) + ') < threshold(' + asThreshold + '), skip auto-send');
            }
        }

        return; // Auto stop

    } else if (swapMode === 6) {
        // ════════════════════════════════════════════════════
        // MODE 6: SMART CONSOLIDATE — detect sisa pair, top-up jika below min, swap balik ke CC, selesai
        //
        // Flow:
        //   1. Resolve stuck orders + accept offers
        //   2. Detect balance USDCx & CETH
        //   3. Jika pair ada tapi below minimum → top-up 25.1 CC ke pair tsb
        //   4. Swap ALL pair → CC
        //   5. Selesai → auto stop (wallet berhenti setelah semua jadi CC)
        // ════════════════════════════════════════════════════

        const M6_USDCX_DUST = 0.5;    // di bawah ini dianggap kosong
        const M6_CETH_DUST  = 0.0001;  // di bawah ini dianggap kosong
        const M6_USDCX_MIN  = 1;       // minimum USDCx untuk bisa swap langsung
        const M6_CETH_MIN   = 0.0005;  // minimum CETH untuk bisa swap langsung
        const m6TopUpAmount = config.swap.min_amount || 25;

        log('\n' + '═'.repeat(55));
        log('🔄 MODE 6: SMART CONSOLIDATE — detect & fix → CC');
        log('═'.repeat(55));

        // ── Phase 0: Resolve stuck orders ──
        log('🔍 Phase 0: Resolve stuck orders & accept offers...');
        dashboard.update(index, { status: 'm6: resolving' });

        try {
            await session.ensureFreshTokens(walletApi, swapApi, log);
            await resolveActiveOrder(ctx);
        } catch { /* ignore */ }

        // Accept offers (3 rounds)
        for (let i = 0; i < 3; i++) {
            try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
            await sleep(3);
        }

        // Wallet confirmations
        try { await signAndFinaliseDelegations(walletApi, session, log); } catch { /* ignore */ }
        try { await walletApi.getRegisterStatus(session.walletToken); } catch { /* ignore */ }

        // ── Phase 1: Detect balances ──
        log('\n📊 Phase 1: Detecting balances...');
        dashboard.update(index, { status: 'm6: detecting' });

        try {
            const { holdings: h } = await session.withRetry(
                () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
            );
            holdingsCache = h || holdingsCache;
            ccBalance = getHoldingBal(h, CC_ASSET_KEYS);
        } catch { /* cached */ }

        let m6Usdcx = getHoldingBal(holdingsCache, USDCX_ASSET_KEYS);
        let m6Ceth  = getHoldingBal(holdingsCache, CETH_ASSET_KEYS);

        log('💰 CC: ' + ccBalance.toFixed(4) + ' | USDCx: ' + m6Usdcx.toFixed(4) + ' | CETH: ' + m6Ceth.toFixed(10));
        dashboard.update(index, { cc: ccBalance, usdcx: m6Usdcx, ceth: m6Ceth });

        const m6HasUsdcx = m6Usdcx >= M6_USDCX_DUST;
        const m6HasCeth  = m6Ceth >= M6_CETH_DUST;

        if (!m6HasUsdcx && !m6HasCeth) {
            log('✅ Tidak ada sisa pair — semua sudah CC!');
            dashboard.update(index, { status: 'm6: clean ✅' });

            const a = dashboard.accounts[index];
            await sendTelegramMessage(
                `✅ <b>MODE 6: Already Clean</b>\n` +
                `👤 ${a?.name || name}\n` +
                `───────────────────\n` +
                `💰 CC: <code>${ccBalance.toFixed(4)}</code>\n` +
                `💵 USDCx: <code>${m6Usdcx.toFixed(4)}</code> ✅\n` +
                `🪙 CETH: <code>${m6Ceth.toFixed(10)}</code> ✅`
            );
            return;
        }

        // ── Helper: swap pair→CC with rate limit wait+retry ──
        const m6RlWaitMin = Math.round((config.swap.rate_limit_wait_seconds ?? 3600) / 60);

        async function m6SwapToCC(pairFrom, pairLabel, assetKeys, dustThreshold, minBal, decimals) {
            let pairBal = getHoldingBal(holdingsCache, assetKeys);
            if (pairBal < dustThreshold) {
                log('✅ ' + pairLabel + ' clean (' + pairBal.toFixed(decimals) + ')');
                return true;
            }

            log('\n🔄 ' + pairLabel + '(' + pairBal.toFixed(decimals) + ') → CC');
            dashboard.update(index, { status: 'm6: ' + pairLabel + '→CC' });

            // Step A: jika pair < minBal → top-up dulu
            let didTopUp = false;
            if (pairBal < minBal) {
                log('⚠️ ' + pairLabel + '(' + pairBal.toFixed(decimals) + ') < min(' + minBal + ') → top-up');
                if (ccBalance < m6TopUpAmount + ccReserve) {
                    log('❌ CC(' + ccBalance.toFixed(2) + ') kurang untuk top-up');
                    return false;
                }
                dashboard.update(index, { status: 'm6: topup CC→' + pairLabel });
                const topResult = await doSwapStep('M6-T', pair_a, pairFrom, m6TopUpAmount);
                if (!topResult) { log('❌ Top-up gagal'); return false; }
                ccBalance = topResult.ccBalance;
                didTopUp = true;
                try {
                    const { holdings: th } = await session.withRetry(
                        () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                    );
                    holdingsCache = th || holdingsCache;
                    pairBal = getHoldingBal(th, assetKeys);
                    ccBalance = getHoldingBal(th, CC_ASSET_KEYS);
                    dashboard.update(index, { cc: ccBalance, usdcx: getHoldingBal(th, USDCX_ASSET_KEYS), ceth: getHoldingBal(th, CETH_ASSET_KEYS) });
                } catch { /* cached */ }
                log('✅ Top-up OK: ' + pairLabel + ' now ' + pairBal.toFixed(decimals));
            }

            // Step B: swap pair→CC (max 5 attempts, with rate limit wait)
            const maxAttempts = 5;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                if (didTopUp || attempt > 1) {
                    const waitMin = m6RlWaitMin;
                    log('⏳ Cooldown ' + waitMin + 'm sebelum swap ' + pairLabel + '→CC (attempt ' + attempt + '/' + maxAttempts + ')');
                    dashboard.update(index, { status: 'm6: wait ' + waitMin + 'm (' + pairLabel + ')' });
                    await sleep(waitMin * 60);

                    try {
                        await session.ensureFreshTokens(walletApi, swapApi, log);
                        const { nonce } = await swapApi.getNonce();
                        const swapAuth = await swapApi.bindSignature(nonce, session.partyId);
                        session.swapToken = swapAuth.accessToken;
                        session.swapLoginTime = Date.now();
                        log('✅ Re-authenticated');
                    } catch (e) { log('⚠️ Re-auth: ' + formatError(e)); }

                    try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
                    try {
                        const { holdings: rh } = await session.withRetry(
                            () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                        );
                        holdingsCache = rh || holdingsCache;
                        pairBal = getHoldingBal(rh, assetKeys);
                        ccBalance = getHoldingBal(rh, CC_ASSET_KEYS);
                        dashboard.update(index, { cc: ccBalance, usdcx: getHoldingBal(rh, USDCX_ASSET_KEYS), ceth: getHoldingBal(rh, CETH_ASSET_KEYS) });
                    } catch { /* cached */ }

                    if (pairBal < dustThreshold) {
                        log('✅ ' + pairLabel + ' sudah clean setelah cooldown!');
                        return true;
                    }
                    didTopUp = false;
                }

                log('🔄 Attempt ' + attempt + ': ' + pairBal.toFixed(decimals) + ' ' + pairLabel + ' → CC');
                dashboard.update(index, { status: 'm6: ' + pairLabel + '→CC #' + attempt });

                const result = await doSwapStep('M6-S' + attempt, pairFrom, pair_a, pairBal);
                if (result) {
                    ccBalance = result.ccBalance;
                    log('✅ ' + pairLabel + ' → CC done! CC: ' + ccBalance.toFixed(4));
                    return true;
                }

                if (lastSwapFailReason === 'belowMinimum') {
                    log('📉 belowMinimum → rescue top-up ' + m6TopUpAmount + ' CC→' + pairLabel);
                    if (ccBalance < m6TopUpAmount + ccReserve) {
                        log('❌ CC kurang untuk rescue'); return false;
                    }
                    const rescue = await doSwapStep('M6-RT', pair_a, pairFrom, m6TopUpAmount);
                    if (!rescue) { log('❌ Rescue gagal'); return false; }
                    ccBalance = rescue.ccBalance;
                    try {
                        const { holdings: rh2 } = await session.withRetry(
                            () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                        );
                        holdingsCache = rh2 || holdingsCache;
                        pairBal = getHoldingBal(rh2, assetKeys);
                        ccBalance = getHoldingBal(rh2, CC_ASSET_KEYS);
                    } catch { /* cached */ }
                    didTopUp = true;
                    continue;
                }

                if (lastSwapFailReason === 'rateLimit') {
                    log('⏳ Rate limited, retry setelah cooldown...');
                    continue;
                }

                log('❌ ' + pairLabel + ' → CC gagal [' + lastSwapFailReason + ']');
                return false;
            }
            log('❌ ' + pairLabel + ' → CC gagal setelah ' + maxAttempts + ' attempts');
            return false;
        }

        // ── Phase 2: Process USDCx ──
        if (m6HasUsdcx) {
            await m6SwapToCC(pair_usdcx, 'USDCx', USDCX_ASSET_KEYS, M6_USDCX_DUST, M6_USDCX_MIN, 4);
        }

        // ── Phase 3: Process CETH ──
        try {
            const { holdings: h3 } = await session.withRetry(
                () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
            );
            holdingsCache = h3 || holdingsCache;
            ccBalance = getHoldingBal(h3, CC_ASSET_KEYS);
            m6Ceth = getHoldingBal(h3, CETH_ASSET_KEYS);
            m6Usdcx = getHoldingBal(h3, USDCX_ASSET_KEYS);
            dashboard.update(index, { cc: ccBalance, usdcx: m6Usdcx, ceth: m6Ceth });
        } catch { /* cached */ }

        if (m6Ceth >= M6_CETH_DUST) {
            await m6SwapToCC(pair_ceth, 'CETH', CETH_ASSET_KEYS, M6_CETH_DUST, M6_CETH_MIN, 10);
        }
        // ── Final Report ──
        try {
            const { holdings: hf } = await session.withRetry(
                () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
            );
            holdingsCache = hf || holdingsCache;
            ccBalance = getHoldingBal(hf, CC_ASSET_KEYS);
            m6Usdcx = getHoldingBal(hf, USDCX_ASSET_KEYS);
            m6Ceth = getHoldingBal(hf, CETH_ASSET_KEYS);
            dashboard.update(index, { cc: ccBalance, usdcx: m6Usdcx, ceth: m6Ceth });
        } catch { /* cached */ }

        const m6Clean = m6Usdcx < M6_USDCX_DUST && m6Ceth < M6_CETH_DUST;

        log('\n' + '═'.repeat(55));
        log('📊 MODE 6 RESULT');
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        log('💰 CC     : ' + ccBalance.toFixed(4));
        log('💵 USDCx  : ' + m6Usdcx.toFixed(4) + (m6Usdcx < M6_USDCX_DUST ? ' ✅' : ' ⚠️'));
        log('🪙 CETH   : ' + m6Ceth.toFixed(10) + (m6Ceth < M6_CETH_DUST ? ' ✅' : ' ⚠️'));
        log('🔄 Swaps  : ' + totalSwaps);
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        log(m6Clean ? '✅ SMART CONSOLIDATE DONE!' : '⚠️ Masih ada sisa intermediate');

        const m6Status = m6Clean ? 'DONE ✅' : 'PARTIAL ⚠️';
        const a = dashboard.accounts[index];
        await sendTelegramMessage(
            `🔄 <b>MODE 6: ${m6Status}</b>\n` +
            `👤 ${a?.name || name}\n` +
            `───────────────────\n` +
            `💰 CC: <code>${ccBalance.toFixed(4)}</code>\n` +
            `💵 USDCx: <code>${m6Usdcx.toFixed(4)}</code>${m6Usdcx < M6_USDCX_DUST ? ' ✅' : ' ⚠️'}\n` +
            `🪙 CETH: <code>${m6Ceth.toFixed(10)}</code>${m6Ceth < M6_CETH_DUST ? ' ✅' : ' ⚠️'}\n` +
            `🔄 Swaps: ${totalSwaps}`
        );

        dashboard.update(index, { status: m6Clean ? 'm6 done ✅' : 'm6 partial ⚠️', totalSwaps });
        return; // Auto stop

    } else if (swapMode === 7) {
        // ════════════════════════════════════════════════════
        // MODE 7: STUCK ORDER — cek order sangkut (PROCESSING)
        //   dan tunggu sampai balance masuk → done
        //
        // Flow:
        //   1. Cek active order per wallet
        //   2. Kalau ada order PROCESSING → poll infinite sampai terminal
        //   3. Accept pending offers (multiple rounds)
        //   4. Wallet confirmations (postConfirmV2, etc)
        //   5. Tunggu balance masuk (CC/USDCx/CETH berubah)
        //   6. Kirim Telegram notif tiap 10 menit
        //   7. Done → auto stop
        // ════════════════════════════════════════════════════

        log('\n' + '═'.repeat(55));
        log('🔍 MODE 7: STUCK ORDER CHECKER — cek & resolve order sangkut');
        log('═'.repeat(55));

        dashboard.update(index, { status: 'm7: checking' });

        // Capture initial balances for comparison
        let m7InitialCC = ccBalance;
        let m7InitialUsdcx = getHoldingBal(holdingsCache, USDCX_ASSET_KEYS);
        let m7InitialCeth = getHoldingBal(holdingsCache, CETH_ASSET_KEYS);

        log('💰 Initial: CC:' + m7InitialCC.toFixed(4) + ' USDCx:' + m7InitialUsdcx.toFixed(4) + ' CETH:' + m7InitialCeth.toFixed(10));

        // ── Phase 1: Check for active/stuck orders ──
        let m7StuckSinceMs = 0;
        let m7LastTelegramMin = 0;
        let m7ResolveRound = 0;
        let m7StuckOrderId = null;
        let m7StuckStatus = '';
        let m7HadStuckOrder = false;

        const TERMINAL_STATES = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];

        while (true) {
            m7ResolveRound++;

            // Ensure tokens are fresh
            try {
                await session.ensureFreshTokens(walletApi, swapApi, log);
            } catch { /* ignore */ }

            // ── 1. Check for active swap orders ──
            let hasActiveOrder = false;
            try {
                const activeOrder = await getActiveOrderWithRetry(swapApi, session.swapToken, log);
                if (activeOrder?.orderId && !TERMINAL_STATES.includes(activeOrder.status)) {
                    hasActiveOrder = true;
                    m7HadStuckOrder = true;
                    m7StuckOrderId = activeOrder.orderId;
                    m7StuckStatus = activeOrder.status;

                    if (!m7StuckSinceMs) m7StuckSinceMs = Date.now();
                    const stuckMin = Math.round((Date.now() - m7StuckSinceMs) / 60000);

                    log('⏳ Order: ' + shortId(activeOrder.orderId) + ' (' + activeOrder.status + ') stuck ' + stuckMin + 'm');
                    dashboard.update(index, { status: 'm7: order stuck ' + stuckMin + 'm' });

                    // Try to resolve via polling
                    try {
                        await resolveActiveOrder(ctx);
                    } catch { /* ignore */ }

                    // Re-check if resolved
                    try {
                        const recheck = await swapApi.getOrderStatus(session.swapToken, activeOrder.orderId);
                        if (TERMINAL_STATES.includes(recheck.status)) {
                            const resolvedMin = Math.round((Date.now() - m7StuckSinceMs) / 60000);
                            log('✅ Order ' + shortId(activeOrder.orderId) + ' → ' + recheck.status + ' (' + resolvedMin + 'm)');
                            hasActiveOrder = false;

                            // Telegram: order resolved
                            const a = dashboard.accounts[index];
                            await sendTelegramMessage(
                                `✅ <b>Mode 7: Order Resolved</b>\n` +
                                `👤 ${a?.name || name}\n` +
                                `───────────────────\n` +
                                `📋 Order: <code>${shortId(activeOrder.orderId)}</code> → ${recheck.status}\n` +
                                `⏱ Stuck selama: ${resolvedMin} menit\n` +
                                `✅ Order selesai!`
                            );
                        }
                    } catch { /* still checking */ }

                    // Telegram update every 10 minutes while stuck
                    if (hasActiveOrder) {
                        const currentStuckMin = Math.round((Date.now() - m7StuckSinceMs) / 60000);
                        if (currentStuckMin >= m7LastTelegramMin + 10) {
                            m7LastTelegramMin = currentStuckMin;
                            const a = dashboard.accounts[index];
                            await sendTelegramMessage(
                                `⏳ <b>Mode 7: Order Stuck</b>\n` +
                                `👤 ${a?.name || name}\n` +
                                `───────────────────\n` +
                                `📋 Order: <code>${shortId(activeOrder.orderId)}</code> (${activeOrder.status})\n` +
                                `💰 CC: <code>${ccBalance.toFixed(4)}</code>\n` +
                                `⏱ Stuck: ${currentStuckMin} menit\n` +
                                `⏳ Nunggu order selesai...`
                            );
                        }
                    }
                } else if (activeOrder?.orderId) {
                    log('✅ Order ' + shortId(activeOrder.orderId) + ' already ' + activeOrder.status);
                }
            } catch {
                // No active order or API error — good
            }

            // ── 2. Wallet-side confirmations ──
            try { await signAndFinaliseDelegations(walletApi, session, log); } catch { /* ignore */ }
            try { await walletApi.getRegisterStatus(session.walletToken); } catch { /* ignore */ }

            // ── 3. Check expired outgoing offers (refund path) ──
            try {
                const expired = await walletApi.getOutgoingExpired(session.walletToken);
                if (expired?.offers?.length > 0) {
                    log('📬 Found ' + expired.offers.length + ' expired offers');
                }
            } catch { /* ignore */ }

            // ── 4. Accept pending offers (3 rounds) ──
            for (let oa = 0; oa < 3; oa++) {
                try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
                await sleep(3);
            }

            // ── 5. Refresh balance ──
            let m7CurrentCC = ccBalance;
            let m7CurrentUsdcx = m7InitialUsdcx;
            let m7CurrentCeth = m7InitialCeth;
            try {
                const { holdings: rh } = await session.withRetry(
                    () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                );
                holdingsCache = rh || holdingsCache;
                m7CurrentCC = getHoldingBal(rh, CC_ASSET_KEYS);
                m7CurrentUsdcx = getHoldingBal(rh, USDCX_ASSET_KEYS);
                m7CurrentCeth = getHoldingBal(rh, CETH_ASSET_KEYS);
                ccBalance = m7CurrentCC;
                dashboard.update(index, { cc: m7CurrentCC, usdcx: m7CurrentUsdcx, ceth: m7CurrentCeth });
            } catch { /* cached */ }

            // ── 6. Check if we can exit ──
            if (!hasActiveOrder) {
                // No active order — check if balance has changed (funds landed)
                const ccChanged = Math.abs(m7CurrentCC - m7InitialCC) > 0.01;
                const usdcxChanged = Math.abs(m7CurrentUsdcx - m7InitialUsdcx) > 0.01;
                const cethChanged = Math.abs(m7CurrentCeth - m7InitialCeth) > 0.000001;
                const balanceChanged = ccChanged || usdcxChanged || cethChanged;

                if (m7HadStuckOrder && balanceChanged) {
                    // Had a stuck order and balance changed → funds landed!
                    log('✅ Balance berubah! CC:' + m7InitialCC.toFixed(4) + '→' + m7CurrentCC.toFixed(4) +
                        ' USDCx:' + m7InitialUsdcx.toFixed(4) + '→' + m7CurrentUsdcx.toFixed(4) +
                        ' CETH:' + m7InitialCeth.toFixed(10) + '→' + m7CurrentCeth.toFixed(10));
                    break;
                } else if (m7HadStuckOrder && !balanceChanged) {
                    // Order resolved but balance hasn't changed yet → keep polling for funds
                    if (m7ResolveRound % 5 === 0) {
                        log('⏳ Order resolved tapi balance belum berubah, nunggu funds landing... (' + m7ResolveRound + ')');
                    }
                    dashboard.update(index, { status: 'm7: waiting funds' });
                } else if (!m7HadStuckOrder && m7ResolveRound >= 3) {
                    // No stuck order found after 3 checks → wallet is clean
                    log('✅ Tidak ada order sangkut, wallet clean!');
                    break;
                }
            }

            // ── 7. Escalating wait interval ──
            const interval = m7ResolveRound <= 15 ? 30
                : m7ResolveRound <= 30 ? 60
                    : m7ResolveRound <= 45 ? 120
                        : 180;

            if (m7ResolveRound % 10 === 0) {
                log('💰 Status: CC:' + m7CurrentCC.toFixed(4) + ' USDCx:' + m7CurrentUsdcx.toFixed(4) + ' CETH:' + m7CurrentCeth.toFixed(10) + ' (round ' + m7ResolveRound + ')');
            }

            await sleep(interval);
        }

        // ── Final: One more round of offer acceptance + balance refresh ──
        log('\n📩 Final offer acceptance...');
        for (let fa = 0; fa < 3; fa++) {
            try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
            await sleep(3);
        }

        // Final balance refresh
        let m7FinalCC = ccBalance;
        let m7FinalUsdcx = 0;
        let m7FinalCeth = 0;
        try {
            const { holdings: fh } = await session.withRetry(
                () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
            );
            holdingsCache = fh || holdingsCache;
            m7FinalCC = getHoldingBal(fh, CC_ASSET_KEYS);
            m7FinalUsdcx = getHoldingBal(fh, USDCX_ASSET_KEYS);
            m7FinalCeth = getHoldingBal(fh, CETH_ASSET_KEYS);
            ccBalance = m7FinalCC;
            dashboard.update(index, { cc: m7FinalCC, usdcx: m7FinalUsdcx, ceth: m7FinalCeth });
        } catch { /* cached */ }

        // ── Report ──
        log('\n' + '═'.repeat(55));
        log('📊 MODE 7 RESULT');
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        log('💰 CC     : ' + m7InitialCC.toFixed(4) + ' → ' + m7FinalCC.toFixed(4));
        log('💵 USDCx  : ' + m7InitialUsdcx.toFixed(4) + ' → ' + m7FinalUsdcx.toFixed(4));
        log('🪙 CETH   : ' + m7InitialCeth.toFixed(10) + ' → ' + m7FinalCeth.toFixed(10));
        if (m7StuckOrderId) {
            log('📋 Order  : ' + shortId(m7StuckOrderId) + ' → resolved');
        }
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        log(m7HadStuckOrder ? '✅ Order sangkut resolved & balance landed!' : '✅ Tidak ada order sangkut');

        // Telegram final notification
        const m7Status = m7HadStuckOrder ? 'RESOLVED ✅' : 'CLEAN ✅';
        const a7 = dashboard.accounts[index];
        const m7StuckDuration = m7StuckSinceMs ? Math.round((Date.now() - m7StuckSinceMs) / 60000) : 0;
        await sendTelegramMessage(
            `🔍 <b>Mode 7: ${m7Status}</b>\n` +
            `👤 ${a7?.name || name}\n` +
            `───────────────────\n` +
            `💰 CC: <code>${m7InitialCC.toFixed(4)}</code> → <code>${m7FinalCC.toFixed(4)}</code>\n` +
            `💵 USDCx: <code>${m7InitialUsdcx.toFixed(4)}</code> → <code>${m7FinalUsdcx.toFixed(4)}</code>\n` +
            `🪙 CETH: <code>${m7InitialCeth.toFixed(10)}</code> → <code>${m7FinalCeth.toFixed(10)}</code>\n` +
            (m7StuckOrderId ? `📋 Order: <code>${shortId(m7StuckOrderId)}</code> → resolved (${m7StuckDuration}m)\n` : '') +
            (m7HadStuckOrder ? '✅ Order sangkut resolved & balance landed!' : '✅ Tidak ada order sangkut, wallet clean!')
        );

        await refreshAccountData(ctx);
        dashboard.update(index, { status: 'm7 done ✅', totalSwaps });
        log('🏁 Mode 7 finished!');
        return; // Auto stop

    } else if (swapMode === 1 || swapMode === 2) {
        // ════════════════════════════════════════════════════
        // PING-PONG ENGINE (Mode 1: CC↔USDCx, Mode 2: CC↔CETH)
        //
        // tx_per_cycle  → jumlah TX per window (dari config)
        // cooldown / TX → rate_limit_wait_seconds ÷ tx_per_cycle
        //
        // Contoh config:
        //   tx_per_cycle: 2, rate_limit_wait_seconds: 3600
        //   → 2 TX/jam, jeda 30 menit per TX
        //   → TX1: CC→USDCx  ⏳30m  TX2: USDCx→CC  ⏳30m  (next window)
        //
        //   tx_per_cycle: 3, rate_limit_wait_seconds: 3600
        //   → 3 TX/jam, jeda 20 menit per TX
        //   → TX1 ⏳20m  TX2 ⏳20m  TX3 ⏳20m  (next window)
        // ════════════════════════════════════════════════════
        const ppPairB = swapMode === 1 ? pair_usdcx : pair_ceth;
        const ppAssetKeys = swapMode === 1 ? USDCX_ASSET_KEYS : CETH_ASSET_KEYS;
        const ppMinBal = swapMode === 1 ? 1 : 0.0005;
        const ppLabel = swapMode === 1 ? 'USDCx' : 'CETH';
        const ppDecimals = swapMode === 1 ? 4 : 10;
        activePairMode = swapMode === 1 ? 'USDCX' : 'CETH';

        // ── Baca tx_per_cycle dari config (default 2) ──
        const txPerCycle = config.swap.tx_per_cycle ?? 2;
        const ppCooldownSec = Math.floor(rateLimitWaitSec / txPerCycle);
        const ppCooldownMin = Math.round(ppCooldownSec / 60);

        log(`⚡ Mode ${swapMode} Ping-Pong: ${txPerCycle} TX/window | cooldown ${ppCooldownMin}m per TX`);

        let ppWindow = 1;
        while (ppWindow <= rounds) {
            log('\n' + '═'.repeat(55));
            log(`🔁 WINDOW #${ppWindow}/${rounds} [${ppLabel} Ping-Pong | ${txPerCycle}TX | ${ppCooldownMin}m/TX]`);
            log('═'.repeat(55));

            for (let txIdx = 0; txIdx < txPerCycle; txIdx++) {
                await session.ensureFreshTokens(walletApi, swapApi, log);

                try {
                    const { holdings: h } = await session.withRetry(
                        () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                    );
                    ccBalance = getHoldingBal(h, CC_ASSET_KEYS);
                    holdingsCache = h || holdingsCache;
                } catch { /* cached */ }
                try { await acceptPendingOffers(ctx); } catch { /* ignore */ }

                const pairBBal = getHoldingBal(holdingsCache, ppAssetKeys);
                dashboard.update(index, {
                    cc: ccBalance,
                    usdcx: getHoldingBal(holdingsCache, USDCX_ASSET_KEYS),
                    ceth: getHoldingBal(holdingsCache, CETH_ASSET_KEYS),
                });

                if (ccBalance >= rewardThreshold) {
                    log('🎉 Reward landed! CC(' + ccBalance.toFixed(2) + ') >= ' + rewardThreshold);
                    if (config.auto_send?.enabled) {
                        const ar = await autoSendCC(ctx);
                        if (ar && ar.holdings && !ar.error) {
                            holdingsCache = ar.holdings;
                            ccBalance = ar.ccBalance;
                        }
                    }
                    if (ccBalance >= rewardThreshold) {
                        log('⏸ CC(' + ccBalance.toFixed(2) + ') masih >= ' + rewardThreshold + ' → pausing');
                        dashboard.update(index, { status: 'reward-landed', swap: false });
                        return;
                    }
                    log('▶️ CC(' + ccBalance.toFixed(2) + ') < ' + rewardThreshold + ' setelah auto-send → lanjut swap');
                }

                log(`\n📌 TX ${txIdx + 1}/${txPerCycle} | CC: ${ccBalance.toFixed(4)} | ${ppLabel}: ${pairBBal.toFixed(ppDecimals)}`);

                let stepFailed = false;
                const stepLabel = `${ppWindow}-${txIdx + 1}`;

                if (pairBBal >= ppMinBal) {
                    // Punya pair B → swap B→CC
                    log(`📍 ${ppLabel}(${pairBBal.toFixed(ppDecimals)}) → CC`);
                    const s = await doSwapStep(stepLabel, ppPairB, pair_a, pairBBal);
                    if (!s) { stepFailed = true; }
                    else { ccBalance = s.ccBalance; }
                } else {
                    // Punya CC → swap CC→B
                    const swapAmt = await fetchDynamicMinSwap(swapApi, log);
                    if (ccBalance < swapAmt) {
                        log(`❌ CC(${ccBalance.toFixed(2)}) < min(${swapAmt.toFixed(2)}), skip TX`);
                        stepFailed = true;
                    } else {
                        log(`📍 CC(${ccBalance.toFixed(4)}) → ${ppLabel}`);
                        const s = await doSwapStep(stepLabel, pair_a, ppPairB, swapAmt);
                        if (!s) { stepFailed = true; }
                        else { ccBalance = s.ccBalance; }
                    }
                }

                if (stepFailed) {
                    log(`⚠️ TX ${txIdx + 1}/${txPerCycle} gagal, tunggu 60s...`);
                    dashboard.update(index, { status: `failed TX ${txIdx + 1}/${txPerCycle}` });
                    await sleep(60);
                    // lanjut TX berikutnya dalam window yang sama (tidak reset window)
                    continue;
                }

                // ── Cooldown per TX (termasuk setelah TX terakhir) ──
                // Cooldown setelah TX terakhir = jeda sebelum window berikutnya
                log(`\n⏳ Cooldown TX ${txIdx + 1}/${txPerCycle}: ${ppCooldownMin} menit...`);
                dashboard.update(index, { status: `cd ${ppCooldownMin}m (TX ${txIdx + 1}/${txPerCycle})` });
                await sleep(ppCooldownSec);
                log(`✅ Cooldown selesai`);
            }

            log(`✅ Window #${ppWindow}/${rounds} selesai`);
            ppWindow++;
        }

    } else {
        // ════════════════════════════════════════════════════
        // TRIANGULAR ENGINE (Mode 3: 3TX, Mode 4: Configurable, Mode 8: 4-step Extended)
        // Mode 3/4: CC → USDCx → CETH → CC (3-step circular)
        // Mode 8:   CC → USDCx → CETH → USDCx → CC (4-step, CETH↔CC via USDCx)
        // ════════════════════════════════════════════════════
        const schedule = swapMode === 3
            ? [2, 1]
            : (config.swap.swaps_per_window_schedule || [2, 3]);
        const totalTxPerCycle = schedule.reduce((a, b) => a + b, 0);

        // NOTE: ENABLE_MODE4_TOPUP_RESCUE & ENABLE_MODE4_HELPER di-set di bagian atas file

        const CHAIN = swapMode === 8 ? [
            { from: pair_a, to: pair_usdcx },      // CC → USDCx
            { from: pair_usdcx, to: pair_ceth },    // USDCx → CETH
            { from: pair_ceth, to: pair_usdcx },    // CETH → USDCx
            { from: pair_usdcx, to: pair_a },       // USDCx → CC
        ] : [
            { from: pair_a, to: pair_usdcx },
            { from: pair_usdcx, to: pair_ceth },
            { from: pair_ceth, to: pair_a },
        ];
        const chainLen = CHAIN.length;

        function detectChainPos(h) {
            const cBal = getHoldingBal(h, CETH_ASSET_KEYS);
            const uBal = getHoldingBal(h, USDCX_ASSET_KEYS);
            if (swapMode === 8) {
                if (cBal >= 0.0005) return 2; // CETH→USDCx
                if (uBal >= 1) return 1;      // USDCx→CETH (lanjut chain forward, sama kayak mode 4)
                return 0;
            }
            if (cBal >= 0.0005) return 2;
            if (uBal >= 1) return 1;
            return 0;
        }

        async function getSwapAmtForPos(pos, h) {
            const idx = pos % chainLen;
            if (swapMode === 8) {
                if (idx === 0) return await fetchDynamicMinSwap(swapApi, log);
                if (idx === 1) return getHoldingBal(h, USDCX_ASSET_KEYS);
                if (idx === 2) return getHoldingBal(h, CETH_ASSET_KEYS);
                return getHoldingBal(h, USDCX_ASSET_KEYS); // idx === 3: USDCx→CC
            }
            if (idx === 0) return await fetchDynamicMinSwap(swapApi, log);
            if (idx === 1) return getHoldingBal(h, USDCX_ASSET_KEYS);
            return getHoldingBal(h, CETH_ASSET_KEYS);
        }

        function getMinBalForPos(pos) {
            const idx = pos % chainLen;
            if (swapMode === 8) {
                if (idx === 0) return 0;
                if (idx === 1) return 1;      // USDCx
                if (idx === 2) return 0.0005; // CETH
                return 1;                     // USDCx (idx === 3)
            }
            if (idx === 0) return 0;
            if (idx === 1) return 1;
            return 0.0005;
        }

        let cycle = 1;
        let isRetry = false;
        let retryChainPos = -1; // preserve chainPos on retry to avoid double-swap
        let rebatesBefore = 0;
        let rccCycleBefore = 0;
        let ccCycleStart = 0;
        let firstSwapMs = 0;

        // ── Resume from saved state (survive restart) ──
        const accState = getAccState(index);
        if (accState.firstSwapMs && accState.firstSwapMs > 0) {
            const savedElapsedSec = Math.floor((Date.now() - accState.firstSwapMs) / 1000);
            const targetSec = ENABLE_ADAPTIVE_RATE_LIMIT
                ? adaptiveRL.getCooldownSeconds()      // adaptive, bukan fixed
                : (rateLimitWaitSec + 180);            // fixed 60m + 3m buffer (seperti normal.js)
            if (savedElapsedSec < targetSec) {
                const remainSec = targetSec - savedElapsedSec;
                const remainMin = Math.round(remainSec / 60);
                const elapsedMin = Math.round(savedElapsedSec / 60);
                log('\n💾 [State Resume] Last swap ' + elapsedMin + 'm ago, waiting ' + remainMin + 'm more (target ' + Math.round(targetSec / 60) + 'm)');
                dashboard.update(index, { status: 'resume-wait ' + remainMin + 'm' });
                await sleep(remainSec);
                log('✅ Resume cooldown done, starting fresh cycle');
            } else {
                log('💾 [State Resume] Last swap ' + Math.round(savedElapsedSec / 60) + 'm ago — cooldown clear, starting immediately');
            }
            // Clear saved state after resume
            accState.firstSwapMs = 0;
            saveSwapState();
        }
        let recoveryAttempts = 0; // track recovery retries to avoid infinite loop
        const MAX_RECOVERY_ATTEMPTS = 5;

        let stuckSinceMs = 0; // timestamp when cc-stuck was first detected

        while (cycle <= rounds) {
            await session.ensureFreshTokens(walletApi, swapApi, log);

            // On retry: resolve stuck orders first, so funds return to wallet before balance check
            if (isRetry) {
                log('🔍 Retry: resolving stuck orders & polling offers...');
                dashboard.update(index, { status: 'retry resolving...' });
                try {
                    await session.ensureFreshTokens(walletApi, swapApi, log);
                    await resolveActiveOrder(ctx);
                } catch { /* ignore */ }
                // Poll offers multiple times — solver may deliver funds with delay
                for (let offerPoll = 0; offerPoll < 3; offerPoll++) {
                    await sleep(5);
                    try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
                }
            }

            try {
                const { holdings: h } = await session.withRetry(
                    () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                );
                ccBalance = getHoldingBal(h, CC_ASSET_KEYS);
                holdingsCache = h || holdingsCache;
            } catch { /* cached */ }
            try { await acceptPendingOffers(ctx); } catch { /* ignore */ }

            let usdcxBal = getHoldingBal(holdingsCache, USDCX_ASSET_KEYS);
            let cethBal = getHoldingBal(holdingsCache, CETH_ASSET_KEYS);
            dashboard.update(index, { cc: ccBalance, usdcx: usdcxBal, ceth: cethBal });

            if (ccBalance >= rewardThreshold) {
                log('🎉 Reward landed! CC(' + ccBalance.toFixed(2) + ') >= ' + rewardThreshold);
                if (config.auto_send?.enabled) {
                    const ar = await autoSendCC(ctx);
                    if (ar && ar.holdings && !ar.error) {
                        holdingsCache = ar.holdings;
                        ccBalance = ar.ccBalance;
                        usdcxBal = getHoldingBal(holdingsCache, USDCX_ASSET_KEYS);
                        cethBal = getHoldingBal(holdingsCache, CETH_ASSET_KEYS);
                    }
                }
                if (ccBalance >= rewardThreshold) {
                    log('⏸ CC(' + ccBalance.toFixed(2) + ') masih >= ' + rewardThreshold + ' → pausing');
                    dashboard.update(index, { status: 'reward-landed', swap: false });
                    return;
                }
                log('▶️ CC(' + ccBalance.toFixed(2) + ') < ' + rewardThreshold + ' setelah auto-send → lanjut cycle');
            }

            if (!isRetry) rebatesBefore = await fetchPendingRebates();
            if (!isRetry) rccCycleBefore = parseFloat(dashboard.accounts[index]?.rcc) || 0;

            log('\n' + '═'.repeat(55));
            log('🔁 SIKLUS #' + cycle + '/' + rounds + ' ' + (isRetry ? '(RETRY)' : '') + ' [' + totalTxPerCycle + 'TX: batch ' + schedule.join('+') + ']');
            log('═'.repeat(55));
            log('💰 CC: ' + ccBalance.toFixed(4) + ' | USDCx: ' + usdcxBal.toFixed(4) + ' | CETH: ' + cethBal.toFixed(10));
            log('🟣 rCC Before: ' + rccCycleBefore.toFixed(4) + ' | Rebates: ' + rebatesBefore.toFixed(4) + ' CC');

            // Per-leg reward tracking (real-time from rebates delta)
            let legRewards = swapMode === 8 ? [0, 0, 0, 0] : [0, 0, 0]; // per-leg reward tracking
            // Track actual CC sent/received for accurate spread loss calculation
            // spreadLoss = total CC sent (pos 0) - total CC received back (pos 2)
            let totalCcSent = 0;     // CC amount sent in CC→USDCx steps
            let totalCcReceived = 0; // CC amount received in CETH→CC steps

            let chainPos;
            const posNames = swapMode === 8 ? ['CC→USDCx', 'USDCx→CETH', 'CETH→USDCx', 'USDCx→CC'] : ['CC→USDCx', 'USDCx→CETH', 'CETH→CC'];

            if (isRetry && retryChainPos >= 0) {
                // On retry, re-detect actual chain position from CURRENT balances
                // instead of blindly trusting retryChainPos.
                // Example: retryChainPos=1 (USDCx→CETH) but USDCx=0 and CETH exists
                //   → should detect pos=2 (CETH→CC), not retry pos=1 which will fail
                const actualPos = detectChainPos(holdingsCache);
                if (actualPos !== retryChainPos % chainLen) {
                    log('📍 Resume posisi ' + actualPos + ': ' + posNames[actualPos] + ' (retry, re-detected from balance)');
                    // Adjust chainPos to match actual balance state while preserving cycle offset
                    chainPos = Math.floor(retryChainPos / chainLen) * chainLen + actualPos;
                } else {
                    chainPos = retryChainPos;
                    log('📍 Resume posisi ' + (chainPos % chainLen) + ': ' + posNames[chainPos % chainLen] + ' (retry)');
                }
            } else {
                // ── Recovery Phase: convert leftover intermediate balances back to CC ──
                // This ensures every new cycle starts at position 0 (CC→USDCx)
                // and ends back at CC for accurate P/L calculation
                const detectedPos = detectChainPos(holdingsCache);
                let recoveryComplete = true;
                if (detectedPos !== 0) {
                    log('📍 Detected leftover at pos ' + detectedPos + ': ' + posNames[detectedPos] + ' → recovering to CC first');
                    let recoveryPos = detectedPos;
                    while (recoveryPos % chainLen !== 0) {
                        const rStep = CHAIN[recoveryPos % chainLen];
                        let rAmt = await getSwapAmtForPos(recoveryPos, holdingsCache);
                        const rMin = getMinBalForPos(recoveryPos);
                        if (rAmt < rMin) {
                            const rDec = rStep.from.asset === 'CETH' ? 10 : 4;
                            log('⚠️ Recovery: ' + rStep.from.label + '(' + rAmt.toFixed(rDec) + ') < min(' + rMin + ')');

                            if (!ENABLE_MODE4_TOPUP_RESCUE) {
                                log('⏭️ Top-up rescue OFF, skip recovery');
                                recoveryComplete = false;
                                recoveryAttempts = MAX_RECOVERY_ATTEMPTS;
                                break;
                            }

                            log('⚠️ top-up CC→' + rStep.from.label);

                            // ── AUTO TOP-UP: swap CC → pair to boost above minimum (flat 25 CC) ──
                            const topUpAmount = config.swap.min_amount || 25;
                            const ccNeeded = topUpAmount + ccReserve;
                            if (ccBalance >= ccNeeded) {
                                log('🔄 Top-up: ' + topUpAmount.toFixed(2) + ' CC → ' + rStep.from.label);
                                const topUpTo = rStep.from.asset === 'USDCX' ? pair_usdcx : pair_ceth;
                                const topResult = await doSwapStep('T' + (recoveryPos % chainLen), pair_a, topUpTo, topUpAmount);
                                if (topResult) {
                                    try {
                                        const { holdings: th } = await session.withRetry(
                                            () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                                        );
                                        ccBalance = getHoldingBal(th, CC_ASSET_KEYS);
                                        holdingsCache = th || holdingsCache;
                                        rAmt = await getSwapAmtForPos(recoveryPos, holdingsCache);
                                        dashboard.update(index, {
                                            cc: ccBalance,
                                            usdcx: getHoldingBal(holdingsCache, USDCX_ASSET_KEYS),
                                            ceth: getHoldingBal(holdingsCache, CETH_ASSET_KEYS),
                                        });
                                        log('✅ Top-up OK: ' + rStep.from.label + ' now ' + rAmt.toFixed(rDec) + ' | CC: ' + ccBalance.toFixed(2));
                                    } catch { /* use cached */ }
                                } else {
                                    log('❌ Top-up failed, skip recovery');
                                    recoveryComplete = false;
                                    recoveryAttempts = MAX_RECOVERY_ATTEMPTS;
                                    break;
                                }
                            } else {
                                log('⚠️ CC too low (' + ccBalance.toFixed(2) + ' < ' + ccNeeded.toFixed(2) + '), skip recovery');
                                recoveryComplete = false;
                                recoveryAttempts = MAX_RECOVERY_ATTEMPTS;
                                break;
                            }
                        }
                        const rResult = await doSwapStep('R' + (recoveryPos % chainLen), rStep.from, rStep.to, rAmt);
                        if (!rResult) {
                            // Swap failed — likely "CC amount below minimum" due to price change
                            // Try top-up CC → pair, then retry swap ALL → CC
                            log('⚠️ Recovery swap failed');
                            if (!ENABLE_MODE4_TOPUP_RESCUE || lastSwapFailReason !== 'belowMinimum') {
                                log('⏭️ ' + (lastSwapFailReason !== 'belowMinimum' ? 'Not below minimum (' + lastSwapFailReason + ')' : 'Rescue OFF') + ', skip');
                                recoveryComplete = false;
                                recoveryAttempts = MAX_RECOVERY_ATTEMPTS;
                                break;
                            }
                            log('📉 API: below minimum → attempting top-up rescue...');
                            const topUpAmt = config.swap.min_amount || 25;
                            const ccNeed = topUpAmt + ccReserve;
                            if (ccBalance >= ccNeed) {
                                log('🔄 Rescue top-up: ' + topUpAmt.toFixed(2) + ' CC → ' + rStep.from.label);
                                const topTo = rStep.from.asset === 'USDCX' ? pair_usdcx : pair_ceth;
                                const tRes = await doSwapStep('T' + (recoveryPos % chainLen), pair_a, topTo, topUpAmt);
                                if (tRes) {
                                    // Refresh and retry the recovery swap
                                    try {
                                        const { holdings: th2 } = await session.withRetry(
                                            () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                                        );
                                        ccBalance = getHoldingBal(th2, CC_ASSET_KEYS);
                                        holdingsCache = th2 || holdingsCache;
                                        rAmt = await getSwapAmtForPos(recoveryPos, holdingsCache);
                                        dashboard.update(index, {
                                            cc: ccBalance,
                                            usdcx: getHoldingBal(holdingsCache, USDCX_ASSET_KEYS),
                                            ceth: getHoldingBal(holdingsCache, CETH_ASSET_KEYS),
                                        });
                                    } catch { /* cached */ }
                                    log('🔄 Retry: swap ALL ' + rStep.from.label + '(' + rAmt.toFixed(rStep.from.asset === 'CETH' ? 10 : 4) + ') → CC');
                                    const retryResult = await doSwapStep('R' + (recoveryPos % chainLen), rStep.from, rStep.to, rAmt);
                                    if (!retryResult) {
                                        log('❌ Retry also failed, skip');
                                        recoveryComplete = false;
                                        recoveryAttempts = MAX_RECOVERY_ATTEMPTS;
                                        break;
                                    }
                                    // Success — continue to next recovery step
                                } else {
                                    log('❌ Top-up failed, skip recovery');
                                    recoveryComplete = false;
                                    recoveryAttempts = MAX_RECOVERY_ATTEMPTS;
                                    break;
                                }
                            } else {
                                log('⚠️ CC too low for rescue (' + ccBalance.toFixed(2) + ' < ' + ccNeed.toFixed(2) + ')');
                                recoveryComplete = false;
                                recoveryAttempts = MAX_RECOVERY_ATTEMPTS;
                                break;
                            }
                        }
                        recoveryPos++;
                        // Refresh balances after recovery step
                        try {
                            const { holdings: rh } = await session.withRetry(
                                () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                            );
                            ccBalance = getHoldingBal(rh, CC_ASSET_KEYS);
                            usdcxBal = getHoldingBal(rh, USDCX_ASSET_KEYS);
                            cethBal = getHoldingBal(rh, CETH_ASSET_KEYS);
                            holdingsCache = rh || holdingsCache;
                            dashboard.update(index, { cc: ccBalance, usdcx: usdcxBal, ceth: cethBal });
                        } catch { /* cached */ }
                    }
                    if (recoveryComplete) {
                        log('✅ Recovery done, CC: ' + ccBalance.toFixed(4));
                        recoveryAttempts = 0; // reset counter on success
                    } else {
                        recoveryAttempts++;
                        if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
                            log('⚠️ Recovery failed ' + MAX_RECOVERY_ATTEMPTS + 'x, proceeding from pos 0 anyway');
                            recoveryAttempts = 0;
                            // Fall through to start cycle — will likely fail at CC check but that's OK
                        } else {
                            log('⚠️ Recovery incomplete (' + recoveryAttempts + '/' + MAX_RECOVERY_ATTEMPTS + '), retry in 60s...');
                            dashboard.update(index, { status: 'recovery-wait 60s' });
                            await sleep(60);
                            continue; // restart while(cycle) loop
                        }
                    }
                }
                chainPos = 0; // Always start new cycle from CC→USDCx
                log('📍 Start posisi 0: ' + posNames[0]);
            }

            // Capture ccCycleStart AFTER recovery (so it reflects actual CC at cycle start)
            if (!isRetry) {
                ccCycleStart = ccBalance;
                firstSwapMs = 0; // reset, will be set on first successful swap
            }

            // Save firstSwapMs to state on each cycle start
            if (firstSwapMs > 0) {
                accState.firstSwapMs = firstSwapMs;
                saveSwapState();
            }
            let stepFailed = false;
            let stepCounter = 0;

            // On retry: calculate how many steps to skip (steps already completed)
            // chainPos is set to actual position (may differ from retryChainPos if re-detected)
            // We need to skip all steps before that position
            const stepsToSkip = (isRetry && chainPos >= 0) ? chainPos : 0;

            for (let batchIdx = 0; batchIdx < schedule.length && !stepFailed; batchIdx++) {
                const batchSize = schedule[batchIdx];

                // Calculate global step range for this batch
                let batchStartGlobal = 0;
                for (let b = 0; b < batchIdx; b++) batchStartGlobal += schedule[b];
                const batchEndGlobal = batchStartGlobal + batchSize;

                // If entire batch was already done in previous attempt, skip it
                if (batchEndGlobal <= stepsToSkip) {
                    stepCounter += batchSize;
                    continue;
                }

                // How many steps in THIS batch to skip
                const batchStepsDone = Math.max(0, stepsToSkip - batchStartGlobal);
                const stepsRemaining = batchSize - batchStepsDone;
                log('\n📦 Batch ' + (batchIdx + 1) + '/' + schedule.length + ' (' + stepsRemaining + (batchStepsDone > 0 ? '/' + batchSize + ' remaining' : ' TX') + ')');

                for (let s = 0; s < batchSize && !stepFailed; s++) {
                    // Skip steps already completed — DO NOT advance chainPos here
                    // chainPos is already set correctly by retryChainPos or recovery
                    if (s < batchStepsDone) {
                        stepCounter++;
                        // NOTE: chainPos is NOT incremented here!
                        // It was already set to the correct resume position
                        continue;
                    }
                    stepCounter++;
                    const step = CHAIN[chainPos % chainLen];

                    // Refresh balance before each step
                    try {
                        const { holdings: h } = await session.withRetry(
                            () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                        );
                        ccBalance = getHoldingBal(h, CC_ASSET_KEYS);
                        usdcxBal = getHoldingBal(h, USDCX_ASSET_KEYS);
                        cethBal = getHoldingBal(h, CETH_ASSET_KEYS);
                        holdingsCache = h || holdingsCache;
                    } catch { /* cached */ }

                    let swapAmount = await getSwapAmtForPos(chainPos, holdingsCache);
                    const minBal = getMinBalForPos(chainPos);

                    // Check minimum balance
                    if (chainPos % chainLen === 0) {
                        if (ccBalance < swapAmount) {
                            // ── Auto-adjust: jika CC di atas raw minimum (25.5) tapi di bawah dynamic min,
                            // kurangi swap amount ke ccBalance - reserve supaya tetap bisa swap
                            const rawMin = dynamicMinSwap.lastRawMin || config.swap.min_amount || 25;
                            const autoAdjustFloor = rawMin + 0.5; // minimal 25.5 CC
                            const adjustedAmount = Math.floor((ccBalance - ccReserve) * 10000) / 10000;

                            if (adjustedAmount >= autoAdjustFloor) {
                                log('⚡ CC(' + ccBalance.toFixed(2) + ') < min(' + swapAmount.toFixed(2) + ') → auto-adjust to ' + adjustedAmount.toFixed(4) + ' CC (floor: ' + autoAdjustFloor.toFixed(1) + ')');
                                swapAmount = adjustedAmount;
                            } else {
                                log('❌ CC(' + ccBalance.toFixed(2) + ') < min(' + swapAmount.toFixed(2) + ') & below auto-adjust floor(' + autoAdjustFloor.toFixed(1) + '), skip');

                                // ── Cek apakah ada stuck order beneran via API ──
                                // Kalau ada active order → dana bakal balik sendiri, fokus resolve
                                // Kalau gak ada active order → CC emang kurang, minta helper
                                if (ENABLE_MODE4_HELPER) {
                                    let hasRealStuckOrder = false;
                                    try {
                                        await session.ensureFreshTokens(walletApi, swapApi, log);
                                        const activeOrd = await getActiveOrderWithRetry(swapApi, session.swapToken, log);
                                        const TERMINAL = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
                                        if (activeOrd?.orderId && !TERMINAL.includes(activeOrd.status)) {
                                            hasRealStuckOrder = true;
                                            log('📋 Active order found: ' + shortId(activeOrd.orderId) + ' (' + activeOrd.status + ') → resolve dulu, skip helper');
                                        } else {
                                            log('🔍 No active order (or already terminal) → wallet butuh CC top-up');
                                        }
                                    } catch (apiErr) {
                                        log('⚠️ getActiveOrder failed after retries: ' + (apiErr.message || apiErr) + ' → skip helper check this cycle');
                                    }

                                    if (!hasRealStuckOrder) {
                                        // Gak ada stuck order → CC emang low, butuh top-up dari wallet lain
                                        // Pakai swapAmount (dynamicMin) sebagai target supaya cukup buat swap
                                        const ccNeeded = Math.ceil(swapAmount - ccBalance + ccReserve + 1);
                                        const alreadyRegistered = consolCoordinator.needsHelp.find(h => h.index === index && !h.resolved);
                                        if (ccNeeded > 0 && !alreadyRegistered) {
                                            consolCoordinator.needsHelp.push({
                                                index, partyId: session.partyId,
                                                amountNeeded: ccNeeded, resolved: false, claimed: false
                                            });
                                            log('📢 No stuck order + CC low → need ' + ccNeeded + ' CC help (CC:' + ccBalance.toFixed(2) + ' target:' + swapAmount.toFixed(2) + ')');
                                        } else if (alreadyRegistered) {
                                            log('💤 Helper already registered for this account (need ' + alreadyRegistered.amountNeeded + ' CC, claimed:' + alreadyRegistered.claimed + ')');
                                        } else {
                                            log('⚠️ ccNeeded=' + ccNeeded + ' (not positive), skip helper');
                                        }
                                    }
                                }

                                stepFailed = true;
                                break;
                            }
                        }
                    } else {
                        if (swapAmount < minBal) {
                            const dec = step.from.asset === 'CETH' ? 10 : 4;
                            log('⚠️ ' + step.from.label + '(' + swapAmount.toFixed(dec) + ') < min, skip');
                            stepFailed = true;
                            break;
                        }
                    }

                    const result = await doSwapStep(stepCounter, step.from, step.to, swapAmount);
                    if (!result) {
                        // Step failed — only rescue on belowMinimum + toggle ON
                        if (chainPos % chainLen !== 0 && lastSwapFailReason === 'belowMinimum' && ENABLE_MODE4_TOPUP_RESCUE) {
                            log('📉 API: below minimum → attempting rescue top-up...');
                            const rescueAmt = config.swap.min_amount || 25;
                            const rescueReserve = config.swap.cc_reserve ?? 0.1;
                            if (ccBalance >= rescueAmt + rescueReserve) {
                                const rescueTo = step.from.asset === 'USDCX' ? pair_usdcx : pair_ceth;
                                const rescueResult = await doSwapStep('T' + (chainPos % chainLen), pair_a, rescueTo, rescueAmt);
                                if (rescueResult) {
                                    // Refresh balance and retry original step
                                    try {
                                        const { holdings: rh } = await session.withRetry(
                                            () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                                        );
                                        ccBalance = getHoldingBal(rh, CC_ASSET_KEYS);
                                        holdingsCache = rh || holdingsCache;
                                        swapAmount = await getSwapAmtForPos(chainPos, holdingsCache);
                                        dashboard.update(index, {
                                            cc: ccBalance,
                                            usdcx: getHoldingBal(holdingsCache, USDCX_ASSET_KEYS),
                                            ceth: getHoldingBal(holdingsCache, CETH_ASSET_KEYS),
                                        });
                                    } catch { /* cached */ }
                                    const dec = step.from.asset === 'CETH' ? 10 : 4;
                                    log('🔄 Retry step: ' + swapAmount.toFixed(dec) + ' ' + step.from.label + ' → ' + step.to.label);
                                    const retryRes = await doSwapStep(stepCounter, step.from, step.to, swapAmount);
                                    if (retryRes) {
                                        if (!firstSwapMs) firstSwapMs = Date.now();
                                        ccBalance = retryRes.ccBalance;
                                        usdcxBal = retryRes.usdcxBal;
                                        cethBal = retryRes.cethBal;
                                        chainPos++;
                                        continue; // success, continue to next step
                                    }
                                }
                            }
                            log('❌ Rescue failed, marking step as failed');
                        } else if (chainPos % chainLen !== 0) {
                            log('⚠️ Step failed [' + lastSwapFailReason + '] — ' + (lastSwapFailReason !== 'belowMinimum' ? 'not below minimum' : 'rescue OFF'));
                        }
                        stepFailed = true;
                        break;
                    }

                    // Track timestamp of first successful swap (for rolling window cooldown)
                    if (!firstSwapMs) {
                        firstSwapMs = Date.now();
                        if (ENABLE_ADAPTIVE_RATE_LIMIT) {
                            adaptiveRL.recordSuccess(firstSwapMs); // record gap dari cycle sebelumnya
                            log('📊 Adaptive RL: ' + adaptiveRL.getStatus());
                        }
                    }

                    ccBalance = result.ccBalance;
                    usdcxBal = result.usdcxBal;
                    cethBal = result.cethBal;
                    // Track CC sent/received for spread loss
                    if (chainPos % chainLen === 0) {
                        // CC→USDCx: track CC yang keluar
                        totalCcSent += swapAmount;
                    } else if (chainPos % chainLen === chainLen - 1) {
                        // Last step → CC: track CC yang balik
                        totalCcReceived += parseFloat(result.result?.receiveAmount || 0);
                    }
                    // Accumulate per-leg reward
                    if (result.stepReward > 0) {
                        legRewards[chainPos % chainLen] += result.stepReward;
                    }
                    chainPos++;
                }

                // Cooldown between batches (not after last batch, skip for mode 8 — test rate limit)
                if (!stepFailed && batchIdx < schedule.length - 1 && swapMode !== 8) {
                    const cdMin = Math.round(cooldownBetweenBatches / 60);
                    log('\n⏳ Cooldown antar batch: ' + cdMin + ' menit...');
                    dashboard.update(index, { status: 'cooldown ' + cdMin + 'm' });
                    await sleep(cooldownBetweenBatches);
                    log('✅ Cooldown selesai');
                } else if (!stepFailed && batchIdx < schedule.length - 1 && swapMode === 8) {
                    log('\n⚡ Mode 8: skip cooldown antar batch, lanjut langsung...');
                }
            }

            // Handle step failure → retry same cycle
            if (stepFailed) {
                // Use autoAdjustFloor + ccReserve to match the EXACT condition in the "below floor" check:
                // adjustedAmount = (ccBalance - ccReserve) must >= autoAdjustFloor
                // So wallet is stuck when: ccBalance < autoAdjustFloor + ccReserve
                const rawMin4stuck = dynamicMinSwap.lastRawMin || config.swap.min_amount || 25;
                const stuckFloor = rawMin4stuck + 0.5 + (config.swap.cc_reserve ?? 0.1);
                const isPos0Stuck = (chainPos % chainLen === 0) && ccBalance < stuckFloor;

                if (isPos0Stuck) {
                    if (!stuckSinceMs) stuckSinceMs = Date.now();

                    // ── INFINITE UNSTICK: poll terus sampai balance masuk ──
                    // CC udah dikirim keluar, dana PASTI balik (swap result / refund).
                    // Gak pernah skip — tunggu sampai resolved.
                    log('🔧 CC-stuck: infinite polling sampai balance masuk...');

                    let unstuck = false;
                    let pollRound = 0;
                    let lastTelegramMin = 0;
                    let helpRegistered = false;

                    // ── Cek stuck order via API, bukan heuristic pair balance ──
                    // Ada active order → dana pasti balik, fokus resolve, skip helper
                    // Gak ada active order → CC emang kurang, minta helper top-up
                    if (ENABLE_MODE4_HELPER) {
                        let hasRealStuckOrder = false;
                        try {
                            await session.ensureFreshTokens(walletApi, swapApi, log);
                            const activeOrd = await getActiveOrderWithRetry(swapApi, session.swapToken, log);
                            const TERMINAL = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
                            if (activeOrd?.orderId && !TERMINAL.includes(activeOrd.status)) {
                                hasRealStuckOrder = true;
                                log('📋 Stuck order: ' + shortId(activeOrd.orderId) + ' (' + activeOrd.status + ') → resolve dulu, skip helper');
                            }
                        } catch (e4) {
                            log('⚠️ getActiveOrder retry exhausted: ' + (e4.message || e4) + ' → continue unstick polling');
                        }

                        if (hasRealStuckOrder) {
                            log('🔧 Fokus resolve stuck order, dana bakal balik sendiri...');
                        } else {
                            // Gak ada stuck order → CC emang low, butuh top-up
                            const swapAmt0 = dynamicMinSwap.lastRawMin || 25;
                            const ccNeeded = Math.ceil(swapAmt0 - ccBalance + 2);
                            if (ccNeeded > 0 && !consolCoordinator.needsHelp.find(h => h.index === index && !h.resolved)) {
                                consolCoordinator.needsHelp.push({
                                    index, partyId: session.partyId,
                                    amountNeeded: ccNeeded, resolved: false, claimed: false
                                });
                                helpRegistered = true;
                                log('📢 No stuck order + CC low → need ' + ccNeeded + ' CC help (CC:' + ccBalance.toFixed(2) + ')');
                            }
                        }
                    }

                    while (!unstuck) {
                        pollRound++;
                        const stuckMin = Math.round((Date.now() - stuckSinceMs) / 60000);

                        // Escalating interval: 30s → 60s → 120s → 180s
                        const interval = pollRound <= 15 ? 30
                            : pollRound <= 30 ? 60
                                : pollRound <= 45 ? 120
                                    : 180;

                        dashboard.update(index, { status: `cc-stuck ${stuckMin}m (#${pollRound})` });

                        // 1. Resolve active swap orders
                        try {
                            await session.ensureFreshTokens(walletApi, swapApi, log);
                            await resolveActiveOrder(ctx);
                        } catch { /* ignore */ }

                        // 2. Wallet-side confirmations
                        try { await signAndFinaliseDelegations(walletApi, session, log); } catch { /* ignore */ }
                        try { await walletApi.getRegisterStatus(session.walletToken); } catch { /* ignore */ }

                        // 3. Expired outgoing offers (refund path)
                        try {
                            const expired = await walletApi.getOutgoingExpired(session.walletToken);
                            if (expired?.offers?.length > 0) {
                                log('📬 Found ' + expired.offers.length + ' expired offers, processing...');
                            }
                        } catch { /* ignore */ }

                        // 4. Accept pending offers (multiple attempts)
                        for (let offerAttempt = 0; offerAttempt < 3; offerAttempt++) {
                            try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
                            await sleep(3);
                        }

                        // 5. Check balance
                        try {
                            const { holdings: uh } = await session.withRetry(
                                () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                            );
                            const newCC = getHoldingBal(uh, CC_ASSET_KEYS);
                            const newUsdcx = getHoldingBal(uh, USDCX_ASSET_KEYS);
                            const newCeth = getHoldingBal(uh, CETH_ASSET_KEYS);
                            holdingsCache = uh || holdingsCache;
                            ccBalance = newCC;
                            dashboard.update(index, { cc: newCC, usdcx: newUsdcx, ceth: newCeth });

                            // Harus match sama stuckFloor: rawMin + 0.5 + ccReserve
                            // supaya gak loop stuck→unstuck→stuck
                            const unstuckFloor = (dynamicMinSwap.lastRawMin || 25) + 0.5 + (config.swap.cc_reserve ?? 0.1);
                            if (newCC >= unstuckFloor) {
                                log('✅ CC unstuck! CC:' + newCC.toFixed(2) + ' >= floor:' + unstuckFloor.toFixed(1) + ' (stuck ' + stuckMin + 'm, poll ' + pollRound + ')');
                                unstuck = true;
                                break;
                            }
                            if (newUsdcx >= 1 || newCeth >= 0.0005) {
                                log('✅ Funds arrived as intermediate! USDCx:' + newUsdcx.toFixed(4) + ' CETH:' + newCeth.toFixed(10) + ' (stuck ' + stuckMin + 'm)');
                                unstuck = true;
                                break;
                            }

                            if (pollRound % 5 === 0) {
                                log('⏳ Still stuck CC:' + newCC.toFixed(2) + ' USDCx:' + newUsdcx.toFixed(4) + ' CETH:' + newCeth.toFixed(10) + ' (' + stuckMin + 'm, #' + pollRound + ')');
                            }
                        } catch { /* cached */ }

                        // 6. Telegram update setiap 10 menit
                        const currentStuckMin = Math.round((Date.now() - stuckSinceMs) / 60000);
                        if (currentStuckMin >= lastTelegramMin + 10) {
                            lastTelegramMin = currentStuckMin;
                            const a = dashboard.accounts[index];
                            await sendTelegramMessage(
                                `⏳ <b>CC-STUCK UPDATE</b>\n` +
                                `👤 ${a?.name || name}\n` +
                                `───────────────────\n` +
                                `💰 CC: <code>${ccBalance.toFixed(4)}</code> (min: ${(dynamicMinSwap.lastRawMin || 25).toFixed(2)})\n` +
                                `⏱ Stuck selama: ${currentStuckMin} menit\n` +
                                `🔄 Poll round: ${pollRound}\n` +
                                `⏳ Infinite polling... nunggu balance masuk`
                            );
                        }

                        await sleep(interval);
                    }

                    // Unstuck! Notify + retry
                    const a = dashboard.accounts[index];
                    const resolvedStuckMin = stuckSinceMs ? Math.round((Date.now() - stuckSinceMs) / 60000) : 0;
                    stuckSinceMs = 0;
                    await sendTelegramMessage(
                        `🔓 <b>Stuck Resolved!</b>\n` +
                        `👤 ${a?.name || name}\n` +
                        `───────────────────\n` +
                        `💰 CC: <code>${(a?.cc ?? ccBalance).toFixed(4)}</code>\n` +
                        `💵 USDCx: <code>${(a?.usdcx ?? 0).toFixed(4)}</code>\n` +
                        `🪙 CETH: <code>${(a?.ceth ?? 0).toFixed(10)}</code>\n` +
                        `⏱ Stuck selama: ${resolvedStuckMin} menit\n` +
                        `✅ Balance sudah masuk!`
                    );
                    // Mark help request as resolved if we got unstuck
                    if (helpRegistered) {
                        const myReq = consolCoordinator.needsHelp.find(h => h.index === index && !h.resolved);
                        if (myReq) myReq.resolved = true;
                    }

                    isRetry = true;
                    retryChainPos = chainPos;
                    continue;
                } else {
                    log('⚠️ Step gagal, tunggu 60s sebelum retry...');
                    dashboard.update(index, { status: 'failed retry cy' });
                }

                isRetry = true;
                retryChainPos = chainPos;
                await sleep(60);
                continue;
            }
            stuckSinceMs = 0; // reset stuck timer on success

            // ── Thorough balance refresh after cycle completion ──
            // The final step (CETH→CC) may not have settled yet
            // Poll balance with offer acceptance to capture the returned CC
            log('\n💰 Refreshing final balance...');
            for (let settleAttempt = 0; settleAttempt < 10; settleAttempt++) {
                await sleep(settleAttempt < 5 ? 5 : 10); // longer wait for later attempts
                try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
                try {
                    const { holdings: fh } = await session.withRetry(
                        () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
                    );
                    const newCC = getHoldingBal(fh, CC_ASSET_KEYS);
                    const newUsdcx = getHoldingBal(fh, USDCX_ASSET_KEYS);
                    const newCeth = getHoldingBal(fh, CETH_ASSET_KEYS);
                    holdingsCache = fh || holdingsCache;

                    // Settled = CC sudah naik (CC return landed) DAN intermediate balances cleared
                    // Harus BOTH: kalau cuma CETH=0 tapi CC belum naik, berarti CC return belum landing
                    const ccIncreased = newCC > ccBalance + 0.01;
                    const pairsCleared = newUsdcx < 0.01 && newCeth < 0.00001;

                    if (ccIncreased && pairsCleared) {
                        ccBalance = newCC;
                        usdcxBal = newUsdcx;
                        cethBal = newCeth;
                        dashboard.update(index, { cc: ccBalance, usdcx: usdcxBal, ceth: cethBal });
                        log('✅ Balance settled: CC:' + ccBalance.toFixed(4) + ' USDCx:' + usdcxBal.toFixed(4) + ' CETH:' + cethBal.toFixed(10));
                        break;
                    } else if (ccIncreased && !pairsCleared) {
                        // CC naik tapi masih ada sisa pair (partial settle)
                        ccBalance = newCC;
                        usdcxBal = newUsdcx;
                        cethBal = newCeth;
                        dashboard.update(index, { cc: ccBalance, usdcx: usdcxBal, ceth: cethBal });
                        log('⚡ Partial settle: CC increased but pairs not cleared. CC:' + ccBalance.toFixed(4));
                        // Continue polling for full settlement
                    } else if (!ccIncreased && pairsCleared) {
                        // CETH/USDCx cleared but CC belum naik → CC return belum landing, keep polling
                        log('⏳ Pairs cleared but CC return not yet landed (' + (settleAttempt + 1) + '/10)...');
                    }
                    ccBalance = newCC;
                    usdcxBal = newUsdcx;
                    cethBal = newCeth;
                    dashboard.update(index, { cc: ccBalance, usdcx: usdcxBal, ceth: cethBal });
                } catch { /* continue */ }
                if (settleAttempt < 9 && settleAttempt >= 5) {
                    log('⏳ Waiting for balance settle (' + (settleAttempt + 1) + '/10)...');
                }
            }

            // ── P/L Calculation ──
            let rebatesAfter = rebatesBefore;
            for (let rp = 1; rp <= 5; rp++) {
                const val = await fetchPendingRebates();
                if (val > rebatesBefore) {
                    rebatesAfter = val;
                    log('🎁 Rebates updated: ' + val.toFixed(4) + ' CC (poll ' + rp + ')');
                    break;
                }
                if (rp < 5) {
                    log('⏳ Rebates belum update (' + rp + '/5), tunggu 30s...');
                    await sleep(30);
                }
            }

            // rCC balance after cycle
            const rccCycleAfter = parseFloat(dashboard.accounts[index]?.rcc) || 0;
            const rccGainCycle = rccCycleAfter - rccCycleBefore;

            // P/L Calculation — use rCC gain as the reward metric
            const spreadLoss = totalCcSent > 0 ? Math.max(0, totalCcSent - totalCcReceived) : Math.max(0, ccCycleStart - ccBalance);
            const rewardGain = rccGainCycle > 0 ? rccGainCycle : (rebatesAfter - rebatesBefore);
            const netPL = rewardGain - spreadLoss;
            const plIcon = netPL >= 0 ? '✅' : '❌';

            log('\n📊 SIKLUS #' + cycle + ' SELESAI');
            log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            log('💰 CC Awal       : ' + ccCycleStart.toFixed(4));
            log('💰 CC Akhir      : ' + ccBalance.toFixed(4));
            if (totalCcSent > 0) {
                log('📤 CC Sent       : ' + totalCcSent.toFixed(4) + ' CC');
                log('📥 CC Received   : ' + totalCcReceived.toFixed(4) + ' CC');
            }
            log('📉 Spread Loss   : -' + spreadLoss.toFixed(4) + ' CC');
            log('🟣 rCC Before    : ' + rccCycleBefore.toFixed(4) + ' rCC');
            log('🟣 rCC After     : ' + rccCycleAfter.toFixed(4) + ' rCC');
            log('🟢 rCC Gained    : +' + rccGainCycle.toFixed(4) + ' rCC');
            if (rebatesAfter > rebatesBefore) {
                log('🟡 Pending CC    : ' + rebatesAfter.toFixed(4) + ' CC (belum convert)');
            }

            // ── Fix per-leg reward: API batches rebates, jadi early legs sering 0.
            // Redistribute unaccounted reward supaya leg breakdown match total reward.
            const legSum = legRewards.reduce((a, b) => a + b, 0);
            if (rewardGain > 0 && legSum < rewardGain) {
                const unaccounted = rewardGain - legSum;
                const zeroLegs = legRewards.filter(r => r === 0).length;
                if (zeroLegs > 0) {
                    // Distribute evenly to legs that showed 0 (API belum update pas step itu)
                    const perLeg = unaccounted / zeroLegs;
                    for (let li = 0; li < legRewards.length; li++) {
                        if (legRewards[li] === 0) legRewards[li] = perLeg;
                    }
                } else {
                    // All legs have some reward → add remainder to last leg
                    legRewards[legRewards.length - 1] += unaccounted;
                }
            }

            if (legRewards.some(r => r > 0)) {
                const _legLabels = swapMode === 8
                    ? ['CC→USDCx', 'USDCx→CETH', 'CETH→USDCx', 'USDCx→CC']
                    : ['CC→USDCx', 'USDCx→CETH', 'CETH→CC'];
                legRewards.forEach((r, i) => {
                    const _p = i < legRewards.length - 1 ? '├' : '└';
                    log('  ' + _p + ' ' + _legLabels[i].padEnd(10) + ': +' + r.toFixed(4) + ' rCC');
                });
            }
            log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            log(plIcon + ' Net P/L: ' + (netPL >= 0 ? '+' : '') + netPL.toFixed(4) + ' CC (' + (netPL >= 0 ? 'UNTUNG' : 'RUGI') + ')');

            await sendCycleNotification(ctx, cycle, rounds, {
                ccCycleStart, ccCycleEnd: ccBalance, spreadLoss, totalCcSent, totalCcReceived,
                rebatesBefore, rebatesAfter, rewardGain, netPL,
                stepFailed, totalSwaps, legRewards,
                rccBefore: rccCycleBefore, rccAfter: rccCycleAfter,
            });

            isRetry = false;
            retryChainPos = -1;

            // Cooldown antar siklus: adaptive (learned) atau fixed (rate_limit_wait_seconds + 3m buffer)
            if (cycle < rounds) {
                const swapRef = firstSwapMs || Date.now();
                const elapsedSec = Math.floor((Date.now() - swapRef) / 1000);
                const targetSec = ENABLE_ADAPTIVE_RATE_LIMIT
                    ? adaptiveRL.getCooldownSeconds()  // auto-learned
                    : (rateLimitWaitSec + 180);        // fixed 60m + 3m buffer (seperti normal.js)
                const remainingSec = Math.max(60, targetSec - elapsedSec); // min 60s
                const remainingMin = Math.round(remainingSec / 60);
                const elapsedMin = Math.round(elapsedSec / 60);
                const targetMin = Math.round(targetSec / 60);
                if (ENABLE_ADAPTIVE_RATE_LIMIT) {
                    log('\n⏳ Adaptive cooldown: ' + elapsedMin + 'm elapsed, tunggu ' + remainingMin + 'm (target ' + targetMin + 'm, learned from API)');
                    dashboard.update(index, { status: 'cooldown ' + remainingMin + 'm (adaptive)' });
                } else {
                    log('\n⏳ Swap pertama ' + elapsedMin + 'm lalu, tunggu ' + remainingMin + 'm (target ' + targetMin + 'm dari swap pertama)...');
                    dashboard.update(index, { status: 'cycle-wait ' + remainingMin + 'm' });
                }

                // ── Save state: record firstSwapMs so restart can resume cooldown ──
                accState.firstSwapMs = swapRef;
                accState.cycle = cycle;
                saveSwapState();
                log('💾 State saved: firstSwapMs=' + new Date(swapRef).toLocaleTimeString() + ', cycle=' + cycle);

                // ── Mode 4 Helper: donate CC to stuck wallets during cooldown ──
                const donorThreshold = (dynamicMinSwap.lastRawMin || 25) + 15; // need enough CC to keep farming
                if (ENABLE_MODE4_HELPER && ccBalance > donorThreshold) {
                    const helpReqs = consolCoordinator.needsHelp.filter(h => !h.resolved && !h.claimed && h.index !== index);
                    for (const helpReq of helpReqs) {
                        if (helpReq.claimed || helpReq.resolved) continue;
                        const maxDonate = Math.floor(ccBalance - donorThreshold);
                        const donateAmt = Math.min(helpReq.amountNeeded + 2, maxDonate);
                        if (donateAmt < 1) continue;

                        helpReq.claimed = true;
                        log('💸 [Mode4 Helper] Donating ' + donateAmt + ' CC to Acc #' + (helpReq.index + 1));
                        dashboard.update(index, { status: 'helping Acc#' + (helpReq.index + 1) });

                        try {
                            const ccAdminId = getInstrumentAdminId(holdingsCache, '0x0');
                            const rawPrep = await session.withRetry(() => walletApi.prepareTransfer(session.walletToken, {
                                instrumentAdminId: ccAdminId,
                                instrumentId: 'Amulet',
                                receiverPartyId: helpReq.partyId,
                                amount: String(donateAmt),
                                reason: 'mode4-help',
                                appName: 'swap-v1',
                                metadata: {},
                            }), 'wallet', walletApi, swapApi, log);

                            const cmdId = rawPrep.command_id || rawPrep.commandId;
                            const prepTx = rawPrep.prepared_tx_b64 || rawPrep.preparedTxB64;
                            const hashScheme = rawPrep.hashing_scheme_version || rawPrep.hashingSchemeVersion || 'HASHING_SCHEME_VERSION_V2';
                            const hash64 = rawPrep.hash_b64 || rawPrep.hashB64;

                            if (prepTx && hash64) {
                                const sig = signMessage(session.keyPair.privateKey, Buffer.from(hash64, 'base64'));
                                await session.withRetry(() => walletApi.executeTransaction(session.walletToken, {
                                    commandId: cmdId, preparedTxB64: prepTx,
                                    signatureB64: toBase64(sig),
                                    hashingSchemeVersion: hashScheme,
                                }), 'wallet', walletApi, swapApi, log);

                                for (let ts = 0; ts < 15; ts++) {
                                    await sleep(3);
                                    try {
                                        const st = await walletApi.getTransferStatus(session.walletToken, cmdId);
                                        if (st.status === 'success') break;
                                    } catch { /* continue */ }
                                }

                                ccBalance -= donateAmt;
                                dashboard.update(index, { cc: ccBalance });
                                log('✅ Donated ' + donateAmt + ' CC to Acc #' + (helpReq.index + 1));
                                helpReq.resolved = true;

                                await sendTelegramMessage(
                                    `💸 <b>CC Donation (Mode4)</b>\n` +
                                    `👤 ${dashboard.accounts[index]?.name || name} → Acc #${helpReq.index + 1}\n` +
                                    `💰 Sent: <code>${donateAmt}</code> CC | Remaining: <code>${ccBalance.toFixed(2)}</code>`
                                );
                            }
                        } catch (err) {
                            log('⚠️ Mode4 donate failed: ' + formatError(err));
                            helpReq.claimed = false;
                        }

                        if (ccBalance <= donorThreshold) break;
                    }
                    dashboard.update(index, { status: 'cycle-wait ' + remainingMin + 'm' });
                }

                await sleep(remainingSec);
                log('✅ Cooldown selesai, mulai siklus baru');

                // ── Clear saved state after cooldown completes ──
                accState.firstSwapMs = 0;
                saveSwapState();
            }
            cycle++;
        }
    }

    // ── Final Cleanup ──
    dashboard.update(index, { status: 'final cleanup' });
    await session.ensureFreshTokens(walletApi, swapApi, log);
    try {
        const { holdings: h } = await session.withRetry(
            () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
        );
        holdingsCache = h || holdingsCache;
        const finalUsdcx = getHoldingBal(h, USDCX_ASSET_KEYS);
        const finalCeth = getHoldingBal(h, CETH_ASSET_KEYS);

        if (finalUsdcx >= 1) {
            log('💱 Final: ' + finalUsdcx.toFixed(4) + ' USDCx → CC');
            await doSwapStep('F1', pair_usdcx, pair_a, finalUsdcx);
        }
        if (finalCeth >= 0.0005) {
            log('💱 Final: ' + finalCeth.toFixed(10) + ' CETH → CC');
            await doSwapStep('F2', pair_ceth, pair_a, finalCeth);
        }
    } catch (err) {
        log('⚠️ Final cleanup: ' + formatError(err));
    }

    await refreshAccountData(ctx);
    log('🏁 Done! ' + totalSwaps + ' swaps across ' + rounds + ' siklus');
    dashboard.update(index, { status: 'done', totalSwaps });

}

// ── Accept Pending Offers ────────────────────────────────────────────────

async function acceptPendingOffers(ctx) {
    const { session, walletApi, swapApi, log, ax } = ctx;

    let offers = [];
    const OFFER_WAITS = [2, 3];
    for (let attempt = 1; attempt <= OFFER_WAITS.length; attempt++) {
        try {
            const result = await session.withRetry(
                () => walletApi.getOffers(session.walletToken), 'wallet', walletApi, swapApi, log
            );
            offers = result.offers || [];
            if (offers.length > 0) break;
        } catch { /* ignore */ }
        if (attempt < OFFER_WAITS.length) await sleep(OFFER_WAITS[attempt - 1]);
    }

    if (!offers.length) return;

    log(`📩 ${offers.length} offer(s)`);

    for (const offer of offers) {
        const contractId = offer.contract_id || offer.contractId;
        const commandId = offer.command_id || offer.commandId;
        const instrumentId = offer.instrument_id || offer.instrumentId || 'USDCx';
        const amount = offer.amount || '?';

        try {
            const preparedTxB64 = offer.prepared_tx_b64 || offer.preparedTxB64;
            const hashB64 = offer.hash_b64 || offer.hashB64;

            if (preparedTxB64 && hashB64) {
                const signature = signMessage(session.keyPair.privateKey, Buffer.from(hashB64, 'base64'));
                await session.withRetry(() => walletApi.executeTransaction(session.walletToken, {
                    commandId, preparedTxB64,
                    signatureB64: toBase64(signature),
                    hashingSchemeVersion: offer.hashing_scheme_version || 'HASHING_SCHEME_VERSION_V2',
                }), 'wallet', walletApi, swapApi, log);
                log(`✅ Accept ${amount} ${instrumentId}`);
            } else if (contractId) {
                let rawPrepare = null;
                for (const ep of ['/offer/accept/prepare', '/offers/accept/prepare', '/offers/accept']) {
                    try {
                        const authH = { ...BASE_HEADERS, Authorization: `Bearer ${session.walletToken}` };
                        rawPrepare = (await ax.post(`${BACKEND}${ep}`, {
                            contract_id: contractId, party_id: session.partyId
                        }, { headers: authH })).data;
                        break;
                    } catch (e) {
                        if (e.response?.status !== 404) continue;
                    }
                }

                if (rawPrepare) {
                    const pTx = rawPrepare.prepared_tx_b64 || rawPrepare.preparedTxB64;
                    const pH = rawPrepare.hash_b64 || rawPrepare.hashB64;
                    if (pTx && pH) {
                        const signature = signMessage(session.keyPair.privateKey, Buffer.from(pH, 'base64'));
                        await session.withRetry(() => walletApi.executeTransaction(session.walletToken, {
                            commandId: rawPrepare.command_id || rawPrepare.commandId,
                            preparedTxB64: pTx,
                            signatureB64: toBase64(signature),
                            hashingSchemeVersion: rawPrepare.hashing_scheme_version || rawPrepare.hashingSchemeVersion || 'HASHING_SCHEME_VERSION_V2',
                        }), 'wallet', walletApi, swapApi, log);
                        log(`✅ Accept ${amount} ${instrumentId}`);
                    }
                }
            }
        } catch (err) {
            log(`❌ Offer: ${formatError(err)}`);
        }
    }
}

// ── Execute Single Swap ──────────────────────────────────────────────────

async function executeSwap(ctx, { fromChain, fromAsset, toChain, toAsset, amount, fromLabel, toLabel, instrumentAdminId }, opts = {}) {
    const { session, walletApi, swapApi, log } = ctx;
    const { pollTimeoutMinutes } = opts;

    try {
        const _dec = (toAsset === 'CETH' || fromAsset === 'CETH') ? 10 : 4;
        log(`📋 Quote ${parseFloat(amount).toFixed(_dec)} ${fromLabel}→${toLabel}...`);
        const quote = await swapApi.getQuote(fromChain, fromAsset, toChain, toAsset, amount);
        log(`💱 ${parseFloat(quote.sendAmount).toFixed(_dec)}→${parseFloat(quote.receiveAmount).toFixed(_dec)} @${parseFloat(quote.rate).toFixed(_dec)}`);

        let orderId = generateOrderId();
        log(`📝 Order ${shortId(orderId)}`);
        let order;

        const refreshQuote = async () => {
            const newQuote = await swapApi.getQuote(fromChain, fromAsset, toChain, toAsset, amount);
            Object.assign(quote, newQuote);
            return newQuote;
        };

        try {
            order = await session.withRetry(
                () => swapApi.createOrder(session.swapToken, orderId, quote.quoteId, session.partyId),
                'swap', walletApi, swapApi, log,
                {
                    onRateLimitRetry: async ({ attempt, delay }) => {
                        // Setelah 429 wait, quote pasti expired → refresh
                        await session.ensureFreshTokens(walletApi, swapApi, log);
                        await refreshQuote();
                        orderId = generateOrderId();
                        log(`♻️ Rate limit ${delay}s → fresh quote + order ${shortId(orderId)} (#${attempt})`);
                    }
                }
            );
        } catch (createErr) {
            const errStatus = createErr.response?.status;
            const errDetail = String(createErr.response?.data?.detail || createErr.response?.data?.message || '');

            // Handle 422 "Account setup not complete"
            if (errStatus === 422 && errDetail.includes('Account setup not complete')) {
                log(`⏳ Account setup not complete, retrying createOrder with delays...`);
                let setupRetrySuccess = false;
                for (let setupRetry = 1; setupRetry <= 10; setupRetry++) {
                    log(`⏳ Setup retry ${setupRetry}/10, wait 30s...`);
                    await sleep(30);
                    try {
                        await session.ensureFreshTokens(walletApi, swapApi, log);
                        const freshQuote = await swapApi.getQuote(fromChain, fromAsset, toChain, toAsset, amount);
                        Object.assign(quote, freshQuote);
                        const freshOrderId = generateOrderId();
                        order = await swapApi.createOrder(session.swapToken, freshOrderId, freshQuote.quoteId, session.partyId);
                        orderId = freshOrderId;
                        log(`✅ Order ${shortId(orderId)} (setup retry #${setupRetry})`);
                        setupRetrySuccess = true;
                        break;
                    } catch (setupErr) {
                        const setupMsg = String(setupErr.response?.data?.detail || setupErr.response?.data?.message || '');
                        if (setupErr.response?.status === 422 && setupMsg.includes('Account setup not complete')) {
                            log(`⏳ Still pending... (${setupRetry}/10)`);
                            continue;
                        }
                        // Different error — re-throw to outer handler
                        throw setupErr;
                    }
                }
                if (!setupRetrySuccess) {
                    // Exhausted 10 retries (~5 min) — soft restart this account
                    log(`🔄 Setup still pending after 10 retries → soft restart`);
                    const softErr = new Error('SETUP_TIMEOUT');
                    softErr.response = { status: 500 };
                    throw softErr;
                }
            }
            // Handle 409 conflict (active order exists)
            else if (errStatus === 409) {
                const errData = createErr.response?.data;
                let staleId = errData?.message?.match(/ord_\w+/)?.[0]
                    || JSON.stringify(errData).match(/ord_\w+/)?.[0]
                    || null;
                if (!staleId) {
                    try {
                        const active = await getActiveOrderWithRetry(swapApi, session.swapToken, log, 3, 3);
                        staleId = active?.orderId;
                    } catch { /* ignore */ }
                }
                if (!staleId) throw createErr;

                log(`⚠️ Active order ${shortId(staleId)}, resolving...`);

                let cancelled = false;
                try {
                    await swapApi.cancelOrder(session.swapToken, staleId);
                    cancelled = true;
                    log(`🚫 Cancelled ${shortId(staleId)}`);
                } catch { /* wait */ }

                if (!cancelled) {
                    const TERMINAL = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
                    let pollN = 0;
                    while (true) {
                        await sleep(10);
                        pollN++;
                        if (pollN % 6 === 0) await session.ensureFreshTokens(walletApi, swapApi, log);
                        try {
                            const check = await swapApi.getOrderStatus(session.swapToken, staleId);
                            log(`🔄 ${shortId(staleId)} → ${check.status}`);
                            if (TERMINAL.includes(check.status)) break;
                        } catch (pollErr) {
                            if (pollErr.response?.status === 401) {
                                await session.refreshSwapToken(swapApi, log);
                                continue;
                            }
                            break;
                        }
                    }
                }

                await acceptPendingOffers(ctx);
                await sleep(2);
                const newQuote = await swapApi.getQuote(fromChain, fromAsset, toChain, toAsset, amount);
                Object.assign(quote, newQuote);
                order = await swapApi.createOrder(session.swapToken, orderId, newQuote.quoteId, session.partyId);
            }
            // Handle generic 422 (not setup-related)
            // ── Fast path: quote expired → fetch fresh quote IMMEDIATELY, no delay ──
            // ── Slow path: escalating retry 15/30/60s for other 422 reasons        ──
            else if (errStatus === 422 || errStatus === 410 || errStatus >= 500) {
                const errMsg = createErr.response?.data?.detail || createErr.response?.data?.message || 'Unknown';
                const errMsgStr = typeof errMsg === 'object' ? JSON.stringify(errMsg) : String(errMsg);
                log(`⚠️ [${errStatus}] ${errMsgStr}`);

                // Detect quote-expired / quote-invalid (no delay needed, just fetch new quote)
                // 410 Gone = always quote expired
                const isQuoteExpired = errStatus === 410
                    || /quote.*(expired|invalid|not.?found|stale)/i.test(errMsgStr)
                    || /expired.*quote/i.test(errMsgStr);

                if (isQuoteExpired) {
                    log(`⚡ Quote expired → fetch fresh quote immediately (step lanjut, tidak restart)...`);
                    try {
                        await session.ensureFreshTokens(walletApi, swapApi, log);
                        const freshQuote = await swapApi.getQuote(fromChain, fromAsset, toChain, toAsset, amount);
                        Object.assign(quote, freshQuote);
                        const freshOrderId = generateOrderId();
                        order = await swapApi.createOrder(session.swapToken, freshOrderId, freshQuote.quoteId, session.partyId);
                        orderId = freshOrderId;
                        log(`✅ Order ${shortId(orderId)} (fresh quote → lanjut step)`);
                        // order berhasil dibuat → fall-through ke prepareTransfer, tidak restart
                    } catch (freshErr) {
                        // Fast path gagal → fall into escalating retry below
                        log(`⚠️ Fresh quote retry gagal: ${formatError(freshErr)}, escalating...`);
                    }
                }

                // ── Escalating retry (only if order still not set) ──
                if (!order) {
                    const rejectedDelays = config.retry?.server_rejected_delays || [15, 30, 60];
                    const max422Retries = config.retry?.max_422_retries ?? 3;
                    for (let rejAttempt = 0; rejAttempt < max422Retries; rejAttempt++) {
                        const delay = getEscalatingDelay(rejAttempt, rejectedDelays);
                        log(`⏳ [${errStatus}] wait ${delay}s (#${rejAttempt + 1}/${max422Retries})`);
                        await sleep(delay);
                        try {
                            await session.ensureFreshTokens(walletApi, swapApi, log);
                            const newQuote = await swapApi.getQuote(fromChain, fromAsset, toChain, toAsset, amount);
                            Object.assign(quote, newQuote);
                            const newOrderId = generateOrderId();
                            order = await swapApi.createOrder(session.swapToken, newOrderId, newQuote.quoteId, session.partyId);
                            orderId = newOrderId;
                            log(`✅ Order ${shortId(orderId)} (retry)`);
                            break;
                        } catch (retryErr) {
                            const retryStatus = retryErr.response?.status;
                            if (retryStatus === 422 || retryStatus === 410 || retryStatus >= 500) {
                                const retryRaw = retryErr.response?.data;
                                let retryMsg = retryRaw?.detail || retryRaw?.message || '';
                                // Filter HTML responses (504/502 from CloudFront)
                                if (!retryMsg) {
                                    const rawStr = typeof retryRaw === 'string' ? retryRaw : '';
                                    retryMsg = rawStr.includes('<html') || rawStr.includes('<!DOCTYPE')
                                        ? 'Gateway error (HTML response)'
                                        : (typeof retryRaw === 'object' ? JSON.stringify(retryRaw) : (rawStr.slice(0, 80) || 'Unknown'));
                                }
                                log(`⚠️ [${retryStatus}] ${retryMsg}`);
                                if (String(retryMsg).includes('Account setup not complete')) {
                                    await waitForAccountSetup(swapApi, session.swapToken, session.partyId, log);
                                }
                                if (rejAttempt >= max422Retries - 1) {
                                    log(`🔄 [${retryStatus}] ${max422Retries}x failed → soft restart`);
                                    const softRestartErr = new Error('422_SOFT_RESTART');
                                    softRestartErr.response = { status: 500 };
                                    throw softRestartErr;
                                }
                                continue;
                            }
                            throw retryErr;
                        }
                    }
                    // If loop finished without order being set, trigger soft restart
                    if (!order) {
                        log(`🔄 [${errStatus}] exhausted retries → soft restart`);
                        const softRestartErr = new Error('422_SOFT_RESTART');
                        softRestartErr.response = { status: 500 };
                        throw softRestartErr;
                    }
                }
            } else {
                throw createErr;
            }
        }

        log(`✅ Order ${shortId(orderId)} created`);

        const instrumentId = ASSET_TO_INSTRUMENT[fromAsset] || fromAsset;
        log(`📦 Transfer ${order.requiredAmount} ${instrumentId}`);
        let rawPrepare = null;
        for (let retry = 0; retry < 3; retry++) {
            try {
                rawPrepare = await session.withRetry(() => walletApi.prepareTransfer(session.walletToken, {
                    instrumentAdminId: instrumentAdminId || '',
                    instrumentId,
                    receiverPartyId: order.deposit.address,
                    amount: order.requiredAmount,
                    reason: orderId,
                    appName: 'swap-v1',
                    metadata: {},
                }), 'wallet', walletApi, swapApi, log);
                break;
            } catch (prepErr) {
                const msg = prepErr.response?.data?.detail || prepErr.response?.data?.message || prepErr.message;
                const msgStr = typeof msg === 'object' ? JSON.stringify(msg) : String(msg);
                if (msgStr.includes('No holdings') && retry < 2) {
                    await sleep(15);
                    continue;
                }
                throw prepErr;
            }
        }

        const commandId = rawPrepare.command_id || rawPrepare.commandId;
        const preparedTxB64 = rawPrepare.prepared_tx_b64 || rawPrepare.preparedTxB64;
        const hashingSchemeVersion = rawPrepare.hashing_scheme_version || rawPrepare.hashingSchemeVersion || 'HASHING_SCHEME_VERSION_V2';
        const hashB64 = rawPrepare.hash_b64 || rawPrepare.hashB64;

        if (!preparedTxB64 || !hashB64) {
            log('❌ Missing prepared_tx_b64 or hash_b64');
            return false;
        }

        log('✍️ Signing & executing transfer...');
        const signature = signMessage(session.keyPair.privateKey, Buffer.from(hashB64, 'base64'));
        await session.withRetry(() => walletApi.executeTransaction(session.walletToken, {
            commandId, preparedTxB64,
            signatureB64: toBase64(signature),
            hashingSchemeVersion,
        }), 'wallet', walletApi, swapApi, log);

        // Poll transfer/status until confirmed (HAR flow)
        log('⏳ Waiting for deposit confirmation...');
        for (let ts = 0; ts < 20; ts++) {
            await sleep(3);
            try {
                const txStatus = await walletApi.getTransferStatus(session.walletToken, commandId);
                if (txStatus.status === 'success') {
                    log('✅ Deposit confirmed on-chain');
                    break;
                }
            } catch { /* continue polling */ }
        }

        log('📊 Polling order status...');

        await sleep(3);
        const finalStatus = await pollOrderStatus(ctx, orderId, pollTimeoutMinutes, toAsset);

        if (finalStatus === 'COMPLETED' || finalStatus === 'WALLET_CONFIRMED') {
            log('🎉 Swap completed!');
            if (finalStatus === 'WALLET_CONFIRMED') {
                for (let cooldown = 0; cooldown < 6; cooldown++) {
                    await sleep(5);
                    try {
                        const { status } = await swapApi.getOrderStatus(session.swapToken, orderId);
                        const TERMINAL = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
                        if (TERMINAL.includes(status)) break;
                    } catch { break; }
                }
            }
            await acceptPendingOffers(ctx);

            // Fetch final order data for TX details
            let userTxId = '', solverTxId = '', fee = 0;
            try {
                const orderData = await swapApi.getOrderStatus(session.swapToken, orderId);
                userTxId = orderData.userTxId || orderData.user_tx_id || orderData.depositTxId || '';
                solverTxId = orderData.solverTxId || orderData.solver_tx_id || orderData.withdrawTxId || '';
                fee = parseFloat(orderData.fee || orderData.networkFee || 0);
            } catch { /* skip */ }

            return {
                receiveAmount: quote.receiveAmount,
                sendAmount: quote.sendAmount,
                rate: quote.rate,
                orderId, commandId,
                slippageBps: 200,
                userTxId, solverTxId, fee,
            };
        } else if (finalStatus === 'TIMEOUT') {
            log(`⚠️ Timeout ${pollTimeoutMinutes}m`);
            try { await swapApi.cancelOrder(session.swapToken, orderId); } catch { /* ignore */ }
            return false;
        } else {
            log(`❌ Swap: ${finalStatus}`);
            return false;
        }

    } catch (err) {
        const errMsg = formatError(err);
        log(`❌ ${errMsg}`);
        // Return error info for caller to handle
        return { error: true, code: err.response?.status || err.code, message: err.response?.data?.detail || err.response?.data?.message || err.message };
    }
}

// ── Poll Order Status ────────────────────────────────────────────────────

async function pollOrderStatus(ctx, orderId, maxMinutes = 0, toAsset = null) {
    const { session, walletApi, swapApi, log } = ctx;
    const TERMINAL = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
    let lastStatus = '';
    let pollCount = 0;
    let stuckSince = 0;
    const ICONS = { COMPLETED: '✅', FAILED: '❌', CANCELLED: '🚫', FUNDED: '💰', EXECUTING: '⚙️', PROCESSING: '🔄', WITHDRAWING: '📤', AWAITING_DEPOSIT: '⏳' };
    const maxPolls = maxMinutes > 0 ? Math.ceil(maxMinutes * 60 / 5) : Infinity;

    let preSwapBalance = null;
    if (toAsset) {
        try {
            const { holdings = {} } = await session.withRetry(
                () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
            );
            const assetNames = toAsset === '0x0' ? ['Amulet', 'CC (Amulet)', 'CC'] : toAsset === 'CETH' ? ['cETH', 'CETH'] : ['USDCx', 'USDCX'];
            for (const n of assetNames) {
                if (holdings[n]?.balance != null) { preSwapBalance = holdings[n].balance; break; }
            }
            preSwapBalance = preSwapBalance || 0;
        } catch { preSwapBalance = 0; }
    }

    async function walletSideCheck() {
        if (!toAsset) return false;
        try {
            const offerResult = await session.withRetry(
                () => walletApi.getOffers(session.walletToken), 'wallet', walletApi, swapApi, log
            );
            if ((offerResult.offers?.length || 0) > 0) {
                try { await acceptPendingOffers(ctx); } catch { /* ignore */ }
                return true;
            }

            const { holdings = {} } = await session.withRetry(
                () => walletApi.getBalance(session.walletToken), 'wallet', walletApi, swapApi, log
            );
            const assetNames = toAsset === '0x0' ? ['Amulet', 'CC (Amulet)', 'CC'] : toAsset === 'CETH' ? ['cETH', 'CETH'] : ['USDCx', 'USDCX'];
            let currentBalance = 0;
            for (const n of assetNames) {
                if (holdings[n]?.balance != null) { currentBalance = holdings[n].balance; break; }
            }
            if (preSwapBalance != null && currentBalance > preSwapBalance + 0.01) return true;

            try {
                const historyData = await session.withRetry(
                    () => walletApi.getHistory(session.walletToken), 'wallet', walletApi, swapApi, log
                );
                const transfers = historyData.transfers || historyData.history || historyData || [];
                if (Array.isArray(transfers) && transfers.length > 0) {
                    const recent = transfers[0];
                    const isIncoming = recent.direction === 'INCOMING' || recent.type === 'RECEIVE'
                        || recent.receiver_party_id === session.partyId
                        || recent.receiverPartyId === session.partyId;
                    if (isIncoming) {
                        const transferAge = Date.now() - new Date(recent.created_at || recent.createdAt || recent.timestamp || 0).getTime();
                        if (transferAge < 5 * 60 * 1000) return true;
                    }
                }
            } catch { /* not critical */ }
        } catch { /* ignore */ }
        return false;
    }

    let consecutiveNetErrors = 0;
    const MAX_CONSECUTIVE_NET_ERRORS = 10;

    while (pollCount < maxPolls) {
        try {
            const { status } = await retryOnNetwork(
                () => swapApi.getOrderStatus(session.swapToken, orderId),
                { maxRetries: 3, baseDelay: 3, label: 'pollStatus', log }
            );
            consecutiveNetErrors = 0; // reset on success

            if (status !== lastStatus) {
                const icon = ICONS[status] || '⏳';
                log(`${icon} Status: ${status} (${pollCount * 5}s)`);
                lastStatus = status;
                stuckSince = pollCount;
            }

            if (status === 'CANCELLED' || status === 'FAILED') {
                if (await walletSideCheck()) return 'WALLET_CONFIRMED';
                return status;
            }
            if (TERMINAL.includes(status)) return status;

            const stuckDuration = pollCount - stuckSince;
            if (toAsset && stuckDuration >= 3 && stuckDuration % 2 === 0) {
                if (await walletSideCheck()) return 'WALLET_CONFIRMED';
            }
        } catch (err) {
            if (err.response?.status === 401) {
                await session.refreshSwapToken(swapApi, log);
                continue;
            }
            // Network error that survived retryOnNetwork retries
            consecutiveNetErrors++;
            const errDetail = formatError(err);
            log(`⚠️ Poll error (${consecutiveNetErrors}/${MAX_CONSECUTIVE_NET_ERRORS}): ${errDetail}`);

            // Check wallet early if we're getting repeated errors
            if (consecutiveNetErrors >= 3 && consecutiveNetErrors % 2 === 1) {
                if (await walletSideCheck()) {
                    log(`✅ Wallet confirmed despite poll errors`);
                    return 'WALLET_CONFIRMED';
                }
            }

            if (consecutiveNetErrors >= MAX_CONSECUTIVE_NET_ERRORS) {
                log(`❌ Too many poll errors, final wallet check...`);
                if (await walletSideCheck()) return 'WALLET_CONFIRMED';
                throw err; // propagate to trigger runAccount restart
            }
            await sleep(10); // extra wait on network error
        }
        pollCount++;
        await sleep(5);
    }

    return 'TIMEOUT';
}

// ── Proxy IP Logger (runs at startup) ───────────────────────────────────

async function fetchAndLogProxyIps(accounts) {
    const proxied = accounts.filter(a => a.proxy);
    if (!proxied.length) return;

    console.log(chalk.gray('  🌐 Fetching proxy IPs...'));
    const IP_ENDPOINTS = [
        { url: 'https://api.ipify.org?format=json', extract: r => r.data?.ip },
        { url: 'https://api4.my-ip.io/ip.json', extract: r => r.data?.ip },
        { url: 'https://ipinfo.io/json', extract: r => r.data?.ip },
        { url: 'https://api.ipify.org', extract: r => String(r.data).trim() },
    ];

    async function getIp(proxyUrl) {
        const agentOpts = { keepAlive: true, timeout: 20000 };
        const httpsAgent = new HttpsProxyAgent(proxyUrl, agentOpts);
        const httpAgent = new HttpProxyAgent(proxyUrl, agentOpts);
        const ax = axios.create({ httpAgent, httpsAgent, proxy: false, timeout: 20000 });
        for (const ep of IP_ENDPOINTS) {
            try {
                const r = await ax.get(ep.url);
                const ip = ep.extract(r);
                if (ip && ip.includes('.')) return ip;
            } catch { /* try next */ }
        }
        return 'FAILED';
    }

    const lines = [];
    for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        if (acc.proxy) {
            const ip = await getIp(acc.proxy);
            lines.push(ip);
            console.log(chalk.gray(`    ${acc.name}: ${chalk.cyan(ip)}`));
        } else {
            lines.push('no-proxy');
            console.log(chalk.gray(`    ${acc.name}: no proxy`));
        }
    }

    // Write to proxy_ips.txt (overwrite each run)
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const header = `# Run: ${timestamp}\n`;
    writeFileSync(new URL('./proxy_ips.txt', import.meta.url), header + lines.join('\n') + '\n', 'utf-8');
    console.log(chalk.gray(`  ✅ Proxy IPs saved to proxy_ips.txt\n`));
}


// ── Menu Selection ───────────────────────────────────────────────────────

async function showMenu() {
    const defaultMode = config.swap?.swap_mode ?? 4;
    const schedule = config.swap?.swaps_per_window_schedule || [2, 3];
    const cdMin = Math.round((config.swap?.cooldown_seconds ?? 1320) / 60);
    const rlSec = config.swap?.rate_limit_wait_seconds ?? 1860;
    const txPerCycle = config.swap?.tx_per_cycle ?? 2;
    const totalTx = schedule.reduce((a, b) => a + b, 0);
    const ppCooldownMin = Math.round(rlSec / txPerCycle / 60); // per-TX cooldown for Mode 1/2

    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });

        console.log('');
        console.log(chalk.cyan.bold('  ╔══════════════════════════════════════════════════════╗'));
        console.log(chalk.cyan.bold('  ║') + chalk.white.bold('        🤖 CANTOR8 BOT V2 — PILIH MODE SWAP         ') + chalk.cyan.bold('║'));
        console.log(chalk.cyan.bold('  ╠══════════════════════════════════════════════════════╣'));
        console.log(chalk.cyan.bold('  ║') + chalk.green('  1. ') + chalk.white(`CC ↔ USDCx   (${txPerCycle}TX/window, cd ${ppCooldownMin}m/TX)          `) + chalk.cyan.bold('║'));
        console.log(chalk.cyan.bold('  ║') + chalk.green('  2. ') + chalk.white(`CC ↔ CETH    (${txPerCycle}TX/window, cd ${ppCooldownMin}m/TX)          `) + chalk.cyan.bold('║'));
        console.log(chalk.cyan.bold('  ║') + chalk.green('  3. ') + chalk.white('Triangular   (CC→USDCx→CETH→CC) 3TX      ') + chalk.cyan.bold('║'));
        console.log(chalk.cyan.bold('  ║') + chalk.green('  4. ') + chalk.white('Extended     (' + totalTx + 'TX/cycle, batch ' + schedule.join('+') + ', cd ' + cdMin + 'm)  ') + chalk.cyan.bold('║'));
        console.log(chalk.cyan.bold('  ║') + chalk.green('  5. ') + chalk.yellow('Consolidate  (USDCx+CETH → CC, auto stop) ') + chalk.cyan.bold('║'));
        console.log(chalk.cyan.bold('  ║') + chalk.green('  6. ') + chalk.yellow('Smart Consol (detect+topup→CC, auto stop) ') + chalk.cyan.bold('║'));
        console.log(chalk.cyan.bold('  ║') + chalk.green('  7. ') + chalk.magenta('Stuck Order  (cek order sangkut, auto stop)') + chalk.cyan.bold('║'));
        console.log(chalk.cyan.bold('  ║') + chalk.green('  8. ') + chalk.white('Extended4Step(CC→U→CETH→U→CC, ' + totalTx + 'TX)   ') + chalk.cyan.bold('║'));
        console.log(chalk.cyan.bold('  ╠══════════════════════════════════════════════════════╣'));
        console.log(chalk.cyan.bold('  ║') + chalk.gray('  Default: [' + defaultMode + '] — tekan Enter = pakai default      ') + chalk.cyan.bold('║'));
        console.log(chalk.cyan.bold('  ╚══════════════════════════════════════════════════════╝'));
        console.log('');

        rl.question(chalk.yellow('  Pilih mode (1-8): '), (answer) => {
            rl.close();
            const mode = parseInt(answer) || defaultMode;
            if (mode >= 1 && mode <= 8) {
                resolve(mode);
            } else {
                console.log(chalk.red('  ⚠️ Invalid, using default: ' + defaultMode));
                resolve(defaultMode);
            }
        });
    });
}
// ── Main Entry Point ─────────────────────────────────────────────────────

// Parse CLI args: --mode <n>, --silent
function parseCliArgs() {
    const argv = process.argv.slice(2);
    const opts = { mode: null, silent: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--mode' || a === '-m') opts.mode = parseInt(argv[++i]);
        else if (a === '--silent' || a === '--no-menu') opts.silent = true;
    }
    return opts;
}

async function main() {
    const accounts = config.accounts || [];

    if (!accounts.length) {
        console.error(chalk.red('❌ No accounts configured in config.json'));
        process.exit(1);
    }

    const cliArgs = parseCliArgs();

    process.stdout.write('\x1B[H\x1B[2J');
    console.log(chalk.cyan.bold(`  🤖 CANTOR8 MULTI-ACCOUNT BOT V2 — ${accounts.length} account(s)\n`));

    // ── Mode Selection ──
    if (cliArgs.mode !== null && !isNaN(cliArgs.mode) && cliArgs.mode >= 1 && cliArgs.mode <= 8) {
        swapMode = cliArgs.mode;
        console.log(chalk.gray(`  [CLI] --mode ${swapMode}`));
    } else if (cliArgs.silent) {
        swapMode = config.swap?.swap_mode ?? 4;
        console.log(chalk.gray(`  [CLI] --silent → mode ${swapMode} (from config)`));
    } else {
        swapMode = await showMenu();
    }
    activePairMode = 'USDCX';

    const _txPerCycle = config.swap.tx_per_cycle ?? 2;
    const _rlSec = config.swap.rate_limit_wait_seconds ?? 1860;
    const _ppCdMin = Math.round(_rlSec / _txPerCycle / 60);
    const _schedule = config.swap.swaps_per_window_schedule || [2, 3];
    const _cdMin = Math.round((config.swap.cooldown_seconds ?? 1320) / 60);
    const _rlMin = Math.round(_rlSec / 60);
    const modeNames = {
        1: `CC ↔ USDCx Ping-Pong (${_txPerCycle}TX/window, ${_ppCdMin}m/TX)`,
        2: `CC ↔ CETH  Ping-Pong (${_txPerCycle}TX/window, ${_ppCdMin}m/TX)`,
        3: 'Triangular (CC→USDCx→CETH→CC) 3TX',
        4: 'Extended (' + String(_schedule.reduce((a, b) => a + b, 0)) + 'TX/cycle, batch ' + _schedule.join('+') + ', cd ' + _cdMin + 'm)',
        5: 'Consolidate (USDCx+CETH → CC, auto stop)',
        6: 'Smart Consol (detect+topup→CC, auto stop)',
        7: 'Stuck Order (cek order sangkut, tunggu balance, auto stop)',
        8: 'Extended4Step (' + String(_schedule.reduce((a, b) => a + b, 0)) + 'TX/cycle, CC→USDCx→CETH→USDCx→CC)',
    };
    console.log(chalk.green.bold('\n  ✅ Mode ' + swapMode + ': ' + modeNames[swapMode]));
    if (swapMode === 1 || swapMode === 2) {
        console.log(chalk.gray(`  ⏳ Cooldown: ${_ppCdMin}m per TX | window=${_rlMin}m | tx_per_cycle=${_txPerCycle}\n`));
    } else {
        console.log(chalk.gray('  ⏳ Cooldown: batch=' + _cdMin + 'm | siklus=' + _rlMin + 'm\n'));
    }
    await fetchAndLogProxyIps(accounts);

    dashboard.init(accounts);
    dashboard.startAutoRefresh();
    startDashboardPush();

    // Stagger account starts with random delay to prevent ECONNRESET stampede and detection
    const STAGGER_MIN_SEC = config.stagger_min_seconds ?? 5;
    const STAGGER_MAX_SEC = config.stagger_max_seconds ?? 60;

    // Calculate cumulative delays for each account
    const staggerDelays = accounts.map((_, i) => {
        if (i === 0) return 0; // First account starts immediately
        // Random delay for each subsequent account
        return getRandomDelay(STAGGER_MIN_SEC, STAGGER_MAX_SEC);
    });

    // Log stagger plan
    console.log(chalk.gray(`  📋 Stagger plan:`));
    let cumulativeDelay = 0;
    staggerDelays.forEach((delay, i) => {
        cumulativeDelay += delay;
        console.log(chalk.gray(`     Acc ${i + 1}: starts after ${formatDelayTime(cumulativeDelay)}`));
    });
    console.log('');

    const results = await Promise.allSettled(
        accounts.map((acc, i) => {
            // Calculate cumulative delay for this account
            const totalDelay = staggerDelays.slice(0, i + 1).reduce((a, b) => a + b, 0);
            return new Promise(resolve => {
                setTimeout(async () => {
                    try {
                        const result = await runAccount(acc, i);
                        resolve(result);
                    } catch (err) {
                        resolve(Promise.reject(err));
                    }
                }, totalDelay * 1000);
            });
        })
    );

    // Final push before stopping
    await pushToDashboard();
    stopDashboardPush();
    dashboard.stop();

    const ok = results.filter(r => r.status === 'fulfilled').length;
    const fail = results.filter(r => r.status === 'rejected').length;
    console.log(chalk.bold.green(`\n  ✅ All done: ${ok} ok, ${fail} fail\n`));
}

main();
