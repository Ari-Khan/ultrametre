const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { SerialPort } = require('serialport');
const { Connection, clusterApiUrl, PublicKey, Transaction, SystemProgram, Keypair, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const HTTP_PORT = 3000;
const SERIAL_PATH = 'COM5';
const SERIAL_BAUD = 9600;
const ROBOT_WALLET = new PublicKey('DsjJMaAxPoXARLsCW3uc3ThheAiy4b5ebUB7WzufDKwd');

let port = null;
let subscriptionId = null;
let running = false;
let sseClients = [];
let pendingTriggers = [];
let isStarting = false;
const AUTO_RECONNECT_INTERVAL_MS = parseInt(process.env.AUTO_RECONNECT_INTERVAL_MS || '5000', 10);

const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(payload));
}

function triggerRobot(item = {}) {
  const rawMsg = (item.msg || 'F');
  const msg = rawMsg.endsWith('\n') ? rawMsg : rawMsg + '\n';
  if (port && port.isOpen) {
    try {
      console.log('Writing to Robot:', msg.trim());
      port.write(msg);
      port.drain();
      broadcast('sent', { msg: msg.trim(), trigger: item.source || 'api', signature: item.signature || null });
      return true;
    } catch (e) {
      console.warn('Failed to write to robot:', e && e.message ? e.message : e);
      return false;
    }
  }
  return false;
}

async function openPortWithRetries(portObj, attempts = 3, delay = 300) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      await new Promise((resolve, reject) => portObj.open((err) => err ? reject(err) : resolve()));
      return;
    } catch (e) {
      lastErr = e;
      const msg = (e && e.message) ? e.message.toLowerCase() : '';
      if (i < attempts - 1 && (msg.includes('access') || msg.includes('busy') || msg.includes('permission') || msg.includes('denied'))) {
        try { portObj.close(() => {}); } catch (e2) {}
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function closePortGracefully() {
  if (!port) return;
  return new Promise((resolve) => {
    try { port.removeAllListeners('data'); } catch (e) {}
    try { port.removeAllListeners('error'); } catch (e) {}
    try { port.removeAllListeners('close'); } catch (e) {}

    if (port.isOpen) {
      try {
        port.flush(() => {
          port.drain(() => {
            port.close((err) => {
              if (err) {
                try { port.destroy(); } catch (e) {}
                port = null;
                return resolve();
              }
              port = null;
              return resolve();
            });
          });
        });
      } catch (e) {
        try { port.destroy(); } catch (e2) {}
        port = null;
        return resolve();
      }
    } else {
      try {
        port.close(() => { port = null; return resolve(); });
      } catch (e) {
        try { port.destroy(); } catch (e2) {}
        port = null;
        return resolve();
      }
    }
  });
}

async function startBridge() {
  if (running) return { ok: true };
  // ensure any stale handle is cleaned
  if (port) {
    await closePortGracefully();
  }

  port = new SerialPort({ path: SERIAL_PATH, baudRate: SERIAL_BAUD, autoOpen: false });

  return new Promise(async (resolve) => {
    try {
      await openPortWithRetries(port, 3, 400);
    } catch (err) {
      try { await closePortGracefully(); } catch (e) {}
      return resolve({ ok: false, error: `Failed to open serial port: ${err && err.message ? err.message : err}` });
    }

    port.on('error', (err) => {
      console.error('Serial port error:', err && err.message ? err.message : err);
      broadcast('status', { running: false, error: err && err.message ? err.message : String(err) });
    });

    port.on('close', () => {
      console.warn('Serial port closed (event)');
      running = false;
      broadcast('status', { running: false });
    });

    try {
      port.set({ dtr: true, rts: true }, () => {
        setTimeout(() => {
          port.on('data', (chunk) => { broadcast('serial', { text: chunk.toString() }); });

          subscriptionId = connection.onAccountChange(ROBOT_WALLET, (info) => {
            console.log('Account change detected via Blockchain');
            triggerRobot();
          }, 'processed');

          running = true;
          broadcast('status', { running: true, port: SERIAL_PATH });

          // process any queued triggers now that the bridge is up
          processPendingTriggers();

          return resolve({ ok: true });
        }, 2000);
      });
    } catch (e) {
      try { await closePortGracefully(); } catch (ee) {}
      return resolve({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });
}

async function stopBridge() {
  // remove subscription immediately
  if (subscriptionId) {
    try { await connection.removeAccountChangeListener(subscriptionId); } catch (e) {}
    subscriptionId = null;
  }

  // always try to close port cleanly
  try { await closePortGracefully(); } catch (e) { console.warn('Error closing port during stop:', e && e.message ? e.message : e); }

  running = false;
  broadcast('status', { running: false });
  return { ok: true };
}

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

app.get('/bridge/status', (req, res) => res.json({ running, port: running ? SERIAL_PATH : null }));
app.post('/bridge/start', async (req, res) => res.json(await startBridge()));
app.post('/bridge/stop', async (req, res) => res.json(await stopBridge()));

app.post('/bridge/send', async (req, res) => {
  try {
    const { amount } = req.body;
    const keyPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
    const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, 'utf8')));
    const fromKeypair = Keypair.fromSecretKey(secretKey);
    
    // Check if we are sending to ourselves
    if (fromKeypair.publicKey.equals(ROBOT_WALLET)) {
        console.warn("Warning: Sending SOL to self. AccountChange might not fire.");
    }

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: fromKeypair.publicKey,
        toPubkey: ROBOT_WALLET,
        lamports: Math.round(parseFloat(amount) * LAMPORTS_PER_SOL),
      })
    );

    const signature = await sendAndConfirmTransaction(connection, transaction, [fromKeypair]);
    
    const triggerItem = { msg: 'F', source: 'api', signature, ts: Date.now() };
    const sent = triggerRobot(triggerItem);
    if (!sent) {
      pendingTriggers.push(triggerItem);
      broadcast('pending', { count: pendingTriggers.length });
    }
    
    res.json({ ok: true, signature, queued: pendingTriggers.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// endpoint to inspect pending triggers
app.get('/bridge/pending', (req, res) => {
  res.json({ count: pendingTriggers.length, items: pendingTriggers });
});

app.get('/bridge/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  sseClients.push(res);
  req.on('close', () => sseClients = sseClients.filter(c => c !== res));
});

// process queued triggers when serial becomes available
async function processPendingTriggers() {
  if (!port || !port.isOpen) return;
  while (pendingTriggers.length > 0) {
    const item = pendingTriggers.shift();
    try {
      const msg = (item.msg || 'F') + '\n';
      port.write(msg);
      await new Promise((res) => port.drain(res));
      broadcast('sent', { msg: msg.trim(), trigger: item.source || 'queued', signature: item.signature });
      await new Promise(res => setTimeout(res, 120));
    } catch (e) {
      console.error('Failed to process pending trigger, re-queuing', e && e.message ? e.message : e);
      pendingTriggers.unshift(item);
      break;
    }
  }
}

// auto-reconnect loop
let _reconnectTimer = null;
function startAutoReconnect() {
  if (_reconnectTimer) return;
  _reconnectTimer = setInterval(async () => {
    if (!running && !isStarting) {
      console.log('Auto-reconnect: attempting to start bridge...');
      isStarting = true;
      try { await startBridge(); } catch (e) { console.warn('Auto-reconnect failed:', e && e.message ? e.message : e); }
      isStarting = false;
    }
  }, AUTO_RECONNECT_INTERVAL_MS);
}
function stopAutoReconnect() { if (_reconnectTimer) { clearInterval(_reconnectTimer); _reconnectTimer = null; } }

const server = app.listen(HTTP_PORT, () => {
  console.log(`Dashboard: http://localhost:${HTTP_PORT}`);
  // start periodic auto-reconnect checks
  startAutoReconnect();
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${HTTP_PORT} is already in use. Set HTTP_PORT env var or stop the process using that port.`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});