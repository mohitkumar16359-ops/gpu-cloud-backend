require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { Pool } = require('pg');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

try {
  const serviceAccount = require('./firebase-service-account.json'); 
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} catch (error) {
  console.log("❌ CRASH: Could not find 'firebase-service-account.json'.");
  process.exit(1); 
}

const app = express();
app.use(express.json());
app.use(cors());

// --- 1. USER AUTHENTICATION ---
const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
    next();
  } catch (error) {
    res.status(403).json({ error: 'Invalid token' });
  }
};

app.post('/api/auth/sync', verifyFirebaseToken, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO users (id, email, name, credit_balance) VALUES ($1, $2, $3, 0.00) ON CONFLICT (id) DO NOTHING`,
      [req.user.uid, req.user.email, req.user.name || 'New User']
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Database error" });
  }
});

// --- 2. HOST MACHINE ROUTES ---
// This is where the PC Owner's Agent talks to your server
app.post('/api/machines/register', async (req, res) => {
  const { host_id, gpu_name, vram_gb, hourly_rate } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO machines (host_id, gpu_name, vram_gb, hourly_rate, status, last_heartbeat) 
       VALUES ($1, $2, $3, $4, 'available', NOW()) RETURNING id`,
      [host_id, gpu_name, vram_gb, hourly_rate]
    );
    
    console.log(`\n💻 NEW SUPPLY ONLINE: A Host just connected an ${gpu_name}!`);
    res.json({ success: true, machine_id: result.rows[0].id });
  } catch (error) {
    console.error("\n❌ ERROR: Could not register machine.", error);
    res.status(500).json({ error: "Failed to register machine" });
  }
});

// --- 3. RENTER ROUTES (The Marketplace) ---
// This sends the list of available GPUs to your website
app.get('/api/machines', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, gpu_name, vram_gb, hourly_rate 
       FROM machines 
       WHERE status = 'available' 
       ORDER BY hourly_rate ASC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error("\n❌ ERROR: Could not fetch marketplace data.", error);
    res.status(500).json({ error: "Failed to load machines" });
  }
});
// --- 4. RENTAL CHECKOUT ROUTE ---
app.post('/api/rentals/start', verifyFirebaseToken, async (req, res) => {
  const { machine_id } = req.body;
  const renter_id = req.user.uid;

  try {
    // 1. Check if the machine is actually still available
    const machineCheck = await pool.query(
      `SELECT status FROM machines WHERE id = $1`, [machine_id]
    );

    if (machineCheck.rows.length === 0 || machineCheck.rows[0].status !== 'available') {
      return res.status(400).json({ error: "Sorry, this GPU was just rented by someone else!" });
    }

    // 2. Mark the machine as rented
    await pool.query(
      `UPDATE machines SET status = 'rented' WHERE id = $1`, [machine_id]
    );

    // 3. Create the official rental receipt in the database
    await pool.query(
      `INSERT INTO rentals (renter_id, machine_id, start_time) VALUES ($1, $2, NOW())`,
      [renter_id, machine_id]
    );

    console.log(`\n🚀 RENTAL STARTED: User ${renter_id} rented Machine ${machine_id.slice(-6)}`);
    res.json({ success: true, message: "Sandbox provisioning started!" });

  } catch (error) {
    console.error("\n❌ ERROR: Could not process rental.", error);
    res.status(500).json({ error: "Server failed to start rental." });
  }
});
// --- 5. HOST AGENT STATUS CHECK ---
// The Go Agent calls this to see if it got rented
app.get('/api/machines/:id/status', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT status FROM machines WHERE id = $1`, [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });
    
    res.json({ status: result.rows[0].status });
  } catch (error) {
    res.status(500).json({ error: "Database error" });
  }
});
// --- 6. PAYMENT ROUTES (RAZORPAY) ---

// Step A: Create an Order (Invoice)
app.post('/api/payments/create-order', verifyFirebaseToken, async (req, res) => {
  try {
    const options = {
      amount: req.body.amount * 100, // Razorpay needs the amount in paise (e.g., 500 INR = 50000 paise)
      currency: "INR",
      receipt: `receipt_${Date.now()}`
    };
    const order = await razorpay.orders.create(options);
    res.json(order);
  } catch (error) {
    console.error("Error creating Razorpay order:", error);
    res.status(500).json({ error: "Failed to create order" });
  }
});

// Step B: Verify the Payment & Add Credits
app.post('/api/payments/verify', verifyFirebaseToken, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount_paid } = req.body;
  const userId = req.user.uid;

  // Verify the signature to prevent hackers from faking a payment
  const body = razorpay_order_id + "|" + razorpay_payment_id;
  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(body.toString())
    .digest("hex");

  if (expectedSignature === razorpay_signature) {
    try {
      // Payment is legit! Add the funds to the user's Supabase database account
      await pool.query(
        `UPDATE users SET credit_balance = credit_balance + $1 WHERE id = $2`,
        [amount_paid, userId]
      );
      console.log(`\n💰 PAYMENT SUCCESS: Added ₹${amount_paid} to user ${userId}`);
      res.json({ success: true });
    } catch (dbError) {
      console.error("Failed to update database balance", dbError);
      res.status(500).json({ error: "Payment verified but database failed." });
    }
  } else {
    res.status(400).json({ error: "Invalid payment signature" });
  }
});
// --- 7. ACTIVE RENTALS & BILLING ---

// A. Get the user's current active rental
// Fetch Renter's Active Session
app.get('/api/rentals/active', verifyFirebaseToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id as rental_id, r.start_time, m.id as machine_id, m.gpu_name, m.hourly_rate, m.connection_url 
       FROM rentals r JOIN machines m ON r.machine_id = m.id
       WHERE r.renter_id = $1 AND r.end_time IS NULL LIMIT 1`,
      [req.user.uid]
    );
    res.json(result.rows[0] || null);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch active rentals" });
  }
});
// NEW: Host Agent uploads the secure Ngrok URL
app.post('/api/machines/set-url', async (req, res) => {
  const { machine_id, url } = req.body;
  try {
    await pool.query(`UPDATE machines SET connection_url = $1 WHERE id = $2`, [url, machine_id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to save tunnel URL." });
  }
});
// B. Stop the rental and calculate the bill
app.post('/api/rentals/stop', verifyFirebaseToken, async (req, res) => {
  const { rental_id, machine_id } = req.body;
  const userId = req.user.uid;

  try {
    // 1. Get the start time and the hourly rate
    const rentalData = await pool.query(
      `SELECT r.start_time, m.hourly_rate FROM rentals r
       JOIN machines m ON r.machine_id = m.id
       WHERE r.id = $1 AND r.renter_id = $2`, 
      [rental_id, userId]
    );

    if (rentalData.rows.length === 0) return res.status(400).json({ error: "Rental not found." });

    const startTime = new Date(rentalData.rows[0].start_time);
    const hourlyRate = rentalData.rows[0].hourly_rate;
    const now = new Date();

    // 2. Calculate the exact cost based on minutes used
    const durationMs = now - startTime;
    const minutesUsed = Math.ceil(durationMs / (1000 * 60));
    const totalCost = (hourlyRate / 60) * minutesUsed;

    // 3. Subtract the cost from the user's balance
    await pool.query(
      `UPDATE users SET credit_balance = credit_balance - $1 WHERE id = $2`,
      [totalCost, userId]
    );

    // 4. Update the rental receipt and free the machine
    await pool.query(`UPDATE rentals SET end_time = NOW(), total_cost = $1 WHERE id = $2`, [totalCost, rental_id]);
    await pool.query(`UPDATE machines SET status = 'available' WHERE id = $1`, [machine_id]);

    console.log(`\n🛑 RENTAL ENDED: User charged ₹${totalCost.toFixed(2)} for ${minutesUsed} minutes.`);
    res.json({ success: true, cost: totalCost, minutes: minutesUsed });

  } catch (error) {
    console.error("Error stopping rental:", error);
    res.status(500).json({ error: "Failed to stop rental and process billing." });
  }
});
// C. Fetch Live User Balance
app.get('/api/users/balance', verifyFirebaseToken, async (req, res) => {
  try {
    const result = await pool.query(`SELECT credit_balance FROM users WHERE id = $1`, [req.user.uid]);
    res.json({ balance: result.rows[0].credit_balance });
  } catch (error) {
    res.status(500).json({ error: "Could not fetch balance" });
  }
});
// TURN ON THE SERVER (Cloud Ready)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}.`);
});
