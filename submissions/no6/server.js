// ARRA-MQ Auth Gateway Webhook Backend PoC (Node.js)
// Required dependencies: npm i express viem

const express = require('express');
const { recoverMessageAddress } = require('viem');

const app = express();
app.use(express.json());

// Acceptable time drift in seconds (prevents replay attacks)
const DRIFT_LIMIT = 30;

app.post('/api/auth', async (req, res) => {
  const { username, password, clientid, ipaddress } = req.body;
  
  if (!username || !password) {
    console.log(`[AUTH FAIL] Missing credentials for client: ${clientid}`);
    return res.status(400).json({ result: "deny" });
  }

  // Password structure: "timestamp:signature"
  const parts = password.split(':');
  if (parts.length < 2) {
    console.log(`[AUTH FAIL] Invalid password format for ${username}`);
    return res.status(400).json({ result: "deny" });
  }

  const timestampStr = parts[0];
  const signature = parts.slice(1).join(':'); // handle signatures that contain colons
  const timestamp = parseInt(timestampStr, 10);

  if (isNaN(timestamp)) {
    console.log(`[AUTH FAIL] Invalid timestamp format: ${timestampStr}`);
    return res.status(400).json({ result: "deny" });
  }

  // 1. Time-drift check (Stateless Replay Attack mitigation)
  const now = Math.floor(Date.now() / 1000);
  const drift = Math.abs(now - timestamp);
  if (drift > DRIFT_LIMIT) {
    console.log(`[AUTH FAIL] Time drift exceeded: ${drift}s (now: ${now}, client: ${timestamp})`);
    return res.status(400).json({ result: "deny" });
  }

  // 2. Signature verification
  const expectedMessage = `SIWE-MQTT Connect: ${username.toLowerCase()} at ${timestamp}`;
  try {
    const recoveredAddress = await recoverMessageAddress({
      message: expectedMessage,
      signature: signature
    });

    if (recoveredAddress.toLowerCase() === username.toLowerCase()) {
      console.log(`[AUTH SUCCESS] Client ${username} authenticated successfully.`);
      return res.status(200).json({ result: "allow", is_superuser: false });
    } else {
      console.log(`[AUTH FAIL] Recovered address ${recoveredAddress} does not match username ${username}`);
      return res.status(400).json({ result: "deny" });
    }
  } catch (error) {
    console.log(`[AUTH FAIL] Signature recovery error: ${error.message}`);
    return res.status(400).json({ result: "deny" });
  }
});

app.post('/api/acl', (req, res) => {
  const { username, topic, action } = req.body;
  
  if (!username || !topic) {
    return res.status(400).json({ result: "deny" });
  }

  const address = username.toLowerCase();
  
  // Dynamic Address-based topic routing
  // Allow Publish: device/<address>/telemetry or user/<address>/request
  // Allow Subscribe: device/<address>/commands or user/<address>/response
  if (action === 'publish') {
    if (topic === `device/${address}/telemetry` || topic === `user/${address}/request`) {
      return res.status(200).json({ result: "allow" });
    }
  } else if (action === 'subscribe') {
    if (topic === `device/${address}/commands` || topic === `user/${address}/response`) {
      return res.status(200).json({ result: "allow" });
    }
  }

  // Static bridging port ACL (prefix bridge/#)
  if (address === 'bridge-client' && topic.startsWith('bridge/')) {
    return res.status(200).json({ result: "allow" });
  }

  console.log(`[ACL DENY] Topic ${topic} action ${action} unauthorized for ${username}`);
  return res.status(400).json({ result: "deny" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ARRA-MQ Auth Gateway running on port ${PORT}`);
});
