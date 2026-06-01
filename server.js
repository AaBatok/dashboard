import readline from 'readline';

/**
 * ╔══════════════════════════════════════════════════════╗
 * ║       🌐 CANTOR8 DASHBOARD SERVER V2                 ║
 * ║    Express + SSE Realtime + Command Center           ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * Features:
 *   - SSE (Server-Sent Events) → instant realtime updates (<100ms)
 *   - Command Center → send commands to bot from dashboard
 *   - In-memory data store (no database needed)
 *   - API key authentication for push endpoint
 *
 * Usage: node server.js
 * Access: http://localhost:3888
 */

import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Load .env.production if exists ───────────────────────────────────────
const envPath = join(__dirname, '.env.production');
if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf-8');
    envContent.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim();
            if (!process.env[key]) process.env[key] = val;
        }
    });
}

const PORT = parseInt(process.env.PORT || '3888');
const API_KEY = process.env.API_KEY || '';

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Serve static files — cek public/ dulu, fallback ke root folder
if (existsSync(join(__dirname, 'public'))) {
    app.use(express.static(join(__dirname, 'public')));
}
app.use(express.static(__dirname, {
    // Jangan serve file sensitif
    setHeaders: (res, filePath) => {
        const base = filePath.split(/[\\/]/).pop();
        if (['.env', '.env.production', 'accounts.json', 'config.json', 'proxy.txt', 'swap_state.json'].some(f => base === f || base.startsWith('.env'))) {
            res.status(403).end('Forbidden');
        }
    }
}));

// ── In-Memory Data Store ─────────────────────────────────────────────────
let latestData = null;
let pushHistory = [];
const MAX_HISTORY = 200;
let commandQueue = [];          // Commands from dashboard → bot
let pendingRefresh = false;     // Flag: dashboard wants balance refresh
let serverStartTime = Date.now();
let modalPerWallet = 65;        // Default modal CC per wallet, set via prompt

// ── SSE: Connected Clients ───────────────────────────────────────────────
const sseClients = new Set();

function broadcastSSE(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try { client.write(payload); } catch { sseClients.delete(client); }
    }
}

// ── SSE Endpoint ─────────────────────────────────────────────────────────
app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',     // Disable nginx buffering
    });

    // Send initial data immediately
    if (latestData) {
        res.write(`event: update\ndata: ${JSON.stringify(latestData)}\n\n`);
    } else {
        res.write(`event: status\ndata: ${JSON.stringify({ status: 'waiting', message: 'Menunggu data dari bot...' })}\n\n`);
    }

    // Heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => {
        try {
            res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now(), clients: sseClients.size })}\n\n`);
        } catch { clearInterval(heartbeat); sseClients.delete(res); }
    }, 30000);

    sseClients.add(res);
    console.log(`  📡 SSE client connected (total: ${sseClients.size})`);

    req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
        console.log(`  📡 SSE client disconnected (total: ${sseClients.size})`);
    });
});

// ── API: Receive Push from Bot ───────────────────────────────────────────
app.post('/api/push', (req, res) => {
    // Validate API key if set
    if (API_KEY && API_KEY !== 'ganti-dengan-api-key-kamu') {
        const reqKey = req.headers['x-api-key'] || req.query.key;
        if (reqKey !== API_KEY) {
            return res.status(401).json({ error: 'Invalid API key' });
        }
    }

    try {
        const body = req.body;
        body._receivedAt = new Date().toISOString();
        body._serverUptime = Math.floor((Date.now() - serverStartTime) / 1000);
        latestData = body;

        // Add to history for charts
        pushHistory.push({
            timestamp: body.timestamp || body._receivedAt,
            accounts: (body.accounts || []).map(a => ({
                name: a.name,
                cc: a.cc || 0,
                usdcx: a.usdcx || 0,
                ceth: a.ceth || 0,
                rcc: a.rcc || 0,
                totalSwaps: a.totalSwaps || 0,
                rank: a.rank || 0,
                monthReward: a.monthReward || 0,
            })),
            botUptime: body.botUptime || 0,
            totalAccounts: body.totalAccounts || 0,
        });
        while (pushHistory.length > MAX_HISTORY) pushHistory.shift();

        // 🚀 SSE: Broadcast to all connected clients INSTANTLY
        broadcastSSE('update', latestData);

        // Build response
        const response = { ok: true, received: true };

        // If dashboard requested refresh, tell the bot
        if (pendingRefresh) {
            response.refreshBalance = true;
            pendingRefresh = false;
        }

        // If there are pending commands, include them
        if (commandQueue.length > 0) {
            response.commands = commandQueue.splice(0);
        }

        res.json(response);
    } catch (err) {
        console.error('  ❌ Push parse error:', err.message);
        res.status(400).json({ error: 'Invalid payload' });
    }
});

// ── API: Get Latest Data (fallback polling) ──────────────────────────────
app.get('/api/data', (req, res) => {
    if (latestData) {
        res.json(latestData);
    } else {
        res.json({ accounts: [], message: 'Menunggu data dari bot...' });
    }
});

// ── API: Get History (for charts) ────────────────────────────────────────
app.get('/api/history', (req, res) => {
    res.json(pushHistory);
});

// ── API: Server Status ───────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        uptime: Math.floor((Date.now() - serverStartTime) / 1000),
        sseClients: sseClients.size,
        hasData: !!latestData,
        lastPush: latestData?._receivedAt || null,
        historyCount: pushHistory.length,
        pendingCommands: commandQueue.length,
    });
});

// ── Command Center: Send Commands to Bot ─────────────────────────────────
app.post('/api/command', (req, res) => {
    const { action, params } = req.body;
    if (!action) return res.status(400).json({ error: 'Missing action' });

    const cmd = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        action,
        params: params || {},
        timestamp: new Date().toISOString(),
    };

    commandQueue.push(cmd);
    console.log(`  🎮 Command queued: ${action}`);

    // Broadcast to SSE clients
    broadcastSSE('command_sent', cmd);

    res.json({ ok: true, commandId: cmd.id });
});

// ── Command Center: Request Balance Refresh ──────────────────────────────
app.post('/api/refresh', (req, res) => {
    pendingRefresh = true;
    console.log('  🔄 Balance refresh requested from dashboard');
    broadcastSSE('status', { type: 'refresh_requested' });
    res.json({ ok: true, message: 'Refresh akan dikirim ke bot pada push berikutnya' });
});

// ── API: Get Config (modal per wallet, etc) ─────────────────────────────
app.get('/api/config', (req, res) => {
    res.json({
        modalPerWallet: modalPerWallet,
    });
});

// ── Fallback: Serve index.html for SPA ───────────────────────────────────
app.get('*', (req, res) => {
    // Cek public/index.html dulu, kalau gak ada cek root
    const publicPath = join(__dirname, 'public', 'index.html');
    const rootPath = join(__dirname, 'index.html');
    if (existsSync(publicPath)) {
        res.sendFile(publicPath);
    } else if (existsSync(rootPath)) {
        res.sendFile(rootPath);
    } else {
        res.status(404).send('index.html tidak ditemukan. Taruh di folder yang sama dengan server.js atau di public/');
    }
});

// ── Startup: Ask Modal Per Wallet ────────────────────────────────────────
function askModal() {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        console.log('');
        console.log('  ╔══════════════════════════════════════════════════╗');
        console.log('  ║       💰 CETAK DUIT — DASHBOARD SETUP            ║');
        console.log('  ╚══════════════════════════════════════════════════╝');
        console.log('');

        rl.question('  Berapa modal CC per wallet? (default: 65): ', (answer) => {
            const val = parseFloat(answer);
            if (!isNaN(val) && val > 0) {
                modalPerWallet = val;
            }
            console.log(`  ✅ Modal per wallet: ${modalPerWallet} CC`);
            console.log('');
            rl.close();
            resolve();
        });
    });
}

// ── Start Server ─────────────────────────────────────────────────────────
async function startServer() {
    await askModal();

    app.listen(PORT, '0.0.0.0', () => {
        console.log('  ╔══════════════════════════════════════════════════╗');
        console.log('  ║       🌐 CANTOR8 DASHBOARD SERVER V2            ║');
        console.log('  ║    Express + SSE Realtime + Command Center      ║');
        console.log('  ╚══════════════════════════════════════════════════╝');
        console.log('');
        console.log(`  💰 Modal:       ${modalPerWallet} CC per wallet`);
        console.log(`  🌐 Dashboard:  http://localhost:${PORT}`);
        console.log(`  📡 SSE Stream:  http://localhost:${PORT}/api/stream`);
        console.log(`  📨 Bot Push:    http://<IP>:${PORT}/api/push`);
        console.log(`  🎮 Commands:    http://<IP>:${PORT}/api/command`);
        console.log(`  🔄 Refresh:     http://<IP>:${PORT}/api/refresh`);
        console.log(`  📊 Status:      http://<IP>:${PORT}/api/status`);
        console.log('');
        if (API_KEY && API_KEY !== 'ganti-dengan-api-key-kamu') {
            console.log(`  🔑 API Key:     ${API_KEY.slice(0, 4)}${'*'.repeat(API_KEY.length - 4)}`);
        } else {
            console.log('  ⚠️  API Key belum di-set (semua push diterima)');
        }
        console.log('');
    });
}

startServer();
