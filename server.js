

require('dotenv').config(); // Must be at the very top

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const existsSync = require('fs').existsSync;
const mkdirSync = require('fs').mkdirSync;
const writeFileSync = require('fs').writeFileSync;
const readFileSync = require('fs').readFileSync;
const multer = require('multer');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;

// ── Middleware ─────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ── Razorpay Initialization (with graceful fallback) ───────────────────
let razorpay = null;
try {
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    console.log('✅ Razorpay initialized');
  } else {
    console.warn('⚠️ Razorpay keys missing – payment endpoints will run in MOCK mode');
  }
} catch (err) {
  console.error('❌ Failed to initialize Razorpay:', err.message);
}

// ── Data Management ─────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR);

const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const COUPONS_FILE = path.join(DATA_DIR, 'coupons.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

const loadData = (file) => {
  try {
    if (existsSync(file)) {
      const content = readFileSync(file, 'utf8');
      const data = JSON.parse(content || '[]');
      console.log(`Loaded ${data.length} items from ${path.basename(file)}`);
      return data;
    }
  } catch (e) { console.error(`Data Load Error (${file}):`, e.message); }
  return [];
};

const saveData = (file, data) => {
  try {
    writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) { console.error(`Save error (${file}):`, e.message); }
};

let products = loadData(PRODUCTS_FILE);
let users = loadData(USERS_FILE);
let coupons = loadData(COUPONS_FILE);
let orders = loadData(ORDERS_FILE);

// Helper for users (async file ops)
const usersFilePath = path.join(DATA_DIR, 'users.json');
async function readUsers() {
  try {
    const data = await fs.readFile(usersFilePath, 'utf8');
    return JSON.parse(data);
  } catch { return []; }
}
async function writeUsers(usersData) {
  await fs.writeFile(usersFilePath, JSON.stringify(usersData, null, 2));
}

// Simple auth middleware (replace with real session later)
const requireAuth = (req, res, next) => next();

// ──────────────────────────────── AUTH ROUTES ────────────────────────────────
app.post('/api/auth/signup', (req, res) => {
  const { name, email, password, phone } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ success: false, message: 'All fields are required.' });
  }
  if (users.find(u => u.email === email)) {
    return res.status(400).json({ success: false, message: 'Email already exists.' });
  }
  const newUser = { id: `user-${Date.now()}`, name, email, password, phone: phone || '', role: 'user' };
  users.push(newUser);
  saveData(USERS_FILE, users);
  res.status(201).json({ success: true, user: { id: newUser.id, name: newUser.name, email: newUser.email, role: newUser.role } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email && u.password === password);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Invalid email or password.' });
  }
  user.lastLogin = new Date().toISOString();
  saveData(USERS_FILE, users);
  res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.get('/api/admin/users', requireAuth, async (req, res) => {
  const usersList = await readUsers();
  res.json({ success: true, data: usersList });
});

app.delete('/api/admin/users/:id', requireAuth, async (req, res) => {
  let usersList = await readUsers();
  usersList = usersList.filter(u => u.id !== req.params.id);
  await writeUsers(usersList);
  res.json({ success: true });
});

// ──────────────────────────────── PRODUCT ROUTES ─────────────────────────────
const upload = multer({ dest: 'uploads/' });

app.get('/api/products', (req, res) => {
  res.json({ success: true, data: products, total: products.length });
});

app.get('/api/products/:id', (req, res) => {
  const product = products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
  res.json({ success: true, data: product });
});

app.post('/api/products', upload.single('image'), (req, res) => {
  const { name, category, price, originalPrice, description, badge, inStock, noOffers, applicableCoupon } = req.body;
  const imageUrl = req.file ? `http://localhost:${PORT}/uploads/${req.file.filename}` : '';
  const newProduct = {
    id: `prod-${Date.now()}`,
    name, category,
    price: Number(price),
    originalPrice: originalPrice ? Number(originalPrice) : null,
    image: imageUrl,
    description: description || '',
    badge: badge || '',
    inStock: inStock !== undefined ? (inStock === 'true' || inStock === true) : true,
    noOffers: noOffers === 'true' || noOffers === true,
    applicableCoupon: applicableCoupon || '',
    rating: 4.5,
    reviews: 0,
    reviewList: [],
    createdAt: new Date().toISOString(),
  };
  products = [newProduct, ...products];
  saveData(PRODUCTS_FILE, products);
  res.status(201).json({ success: true, data: newProduct });
});

app.put('/api/products/:id', upload.single('image'), (req, res) => {
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Product not found' });
  const updates = { ...req.body };
  if (updates.price) updates.price = Number(updates.price);
  if (updates.originalPrice) updates.originalPrice = Number(updates.originalPrice);
  if (updates.noOffers !== undefined) updates.noOffers = updates.noOffers === 'true' || updates.noOffers === true;
  if (updates.inStock !== undefined) updates.inStock = updates.inStock === 'true' || updates.inStock === true;
  if (req.file) updates.image = `http://localhost:${PORT}/uploads/${req.file.filename}`;
  else if (updates.imageUrl) updates.image = updates.imageUrl;
  products[idx] = { ...products[idx], ...updates, updatedAt: new Date().toISOString() };
  saveData(PRODUCTS_FILE, products);
  res.json({ success: true, data: products[idx] });
});

app.delete('/api/products/:id', (req, res) => {
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Product not found' });
  const deleted = products.splice(idx, 1);
  saveData(PRODUCTS_FILE, products);
  res.json({ success: true, data: deleted[0] });
});

// Review endpoints
app.post('/api/products/:id/review', (req, res) => {
  const { userName, rating, comment } = req.body;
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Product not found' });
  const product = products[idx];
  if (!product.reviewList) product.reviewList = [];
  const newReview = { id: Date.now().toString(), userName: userName || 'Anonymous', rating: Number(rating) || 5, comment: comment || '', date: new Date().toISOString() };
  product.reviewList = [newReview, ...product.reviewList];
  product.reviews = product.reviewList.length;
  const totalRating = product.reviewList.reduce((sum, r) => sum + r.rating, 0);
  product.rating = Number((totalRating / product.reviewList.length).toFixed(1));
  saveData(PRODUCTS_FILE, products);
  res.status(201).json({ success: true, data: newReview });
});

app.delete('/api/products/:id/review/:reviewId', (req, res) => {
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Product not found' });
  const product = products[idx];
  if (!product.reviewList) return res.status(404).json({ success: false });
  product.reviewList = product.reviewList.filter(r => r.id !== req.params.reviewId);
  product.reviews = product.reviewList.length;
  if (product.reviewList.length > 0) {
    const total = product.reviewList.reduce((s, r) => s + r.rating, 0);
    product.rating = Number((total / product.reviewList.length).toFixed(1));
  } else product.rating = 4.5;
  saveData(PRODUCTS_FILE, products);
  res.json({ success: true });
});

// ──────────────────────────────── COUPON ROUTES ──────────────────────────────
app.get('/api/coupons', (req, res) => {
  res.json({ success: true, data: coupons });
});

app.post('/api/coupons', (req, res) => {
  const { code, discount, type, expiryDate } = req.body;
  if (!code || !discount) return res.status(400).json({ success: false, message: 'Code and discount are required.' });
  const newCoupon = { id: Date.now().toString(), code: code.toUpperCase(), discount: Number(discount), type: type || 'percentage', expiryDate: expiryDate || null, createdAt: new Date().toISOString() };
  coupons = [newCoupon, ...coupons];
  saveData(COUPONS_FILE, coupons);
  res.status(201).json({ success: true, data: newCoupon });
});

app.post('/api/coupons/validate', (req, res) => {
  const coupon = coupons.find(c => c.code === req.body.code?.toUpperCase());
  if (!coupon) return res.status(404).json({ success: false, message: 'Invalid coupon code.' });
  if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date())
    return res.status(400).json({ success: false, message: 'Coupon expired.' });
  res.json({ success: true, data: coupon });
});

app.delete('/api/coupons/:id', (req, res) => {
  const idx = coupons.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false });
  coupons.splice(idx, 1);
  saveData(COUPONS_FILE, coupons);
  res.json({ success: true });
});

// ──────────────────────────────── ORDER ROUTES ───────────────────────────────
app.get('/api/orders', (req, res) => {
  res.json({ success: true, data: orders });
});

app.get('/api/users/:userId/orders', (req, res) => {
  const userOrders = orders.filter(o => o.userId === req.params.userId);
  res.json({ success: true, data: userOrders });
});

app.post('/api/orders', (req, res) => {
  const { userId, userName, items, subtotal, discount, total, couponCode, paymentMethod, paymentDetails } = req.body;
  if (!items || items.length === 0) return res.status(400).json({ success: false, message: 'No items' });
  // Simulate card decline for specific card
  if (paymentMethod === 'Card' && paymentDetails?.number === '1111222233334444')
    return res.status(400).json({ success: false, message: 'Card declined by bank.' });
  if (paymentMethod === 'Card' && paymentDetails?.cvv === '000')
    return res.status(400).json({ success: false, message: 'Invalid CVV.' });
  const newOrder = {
    id: 'ORD-' + Date.now().toString().slice(-6) + Math.floor(Math.random() * 100),
    userId, userName, items, subtotal, discount, total, couponCode: couponCode || null,
    paymentMethod: paymentMethod || 'Card', paymentDetails: paymentDetails || null,
    status: 'Paid', createdAt: new Date().toISOString()
  };
  orders = [newOrder, ...orders];
  saveData(ORDERS_FILE, orders);
  res.status(201).json({ success: true, data: newOrder });
});

app.patch('/api/orders/:id/status', (req, res) => {
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false });
  orders[idx].status = req.body.status;
  saveData(ORDERS_FILE, orders);
  res.json({ success: true });
});

app.delete('/api/orders/:id', (req, res) => {
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false });
  orders.splice(idx, 1);
  saveData(ORDERS_FILE, orders);
  res.json({ success: true });
});

// ──────────────────────────────── MOCK / REAL PAYMENT ROUTES ─────────────────
// Determine if we are in mock mode (no valid Razorpay keys)
const mockMode = !process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET;
if (mockMode) {
  console.log('🔧 Running in MOCK PAYMENT mode – no real charges will be made');
} else {
  console.log('✅ Real Razorpay mode – payments will be processed');
}

// Create order endpoint
app.post('/api/create-order', async (req, res) => {
  if (mockMode) {
    const { amount, currency } = req.body;
    console.log(`[MOCK] Creating order for ₹${amount}`);
    return res.json({
      id: `mock_order_${Date.now()}`,
      amount: amount * 100,
      currency: currency || 'INR',
      receipt: `receipt_${Date.now()}`
    });
  }

  // Real Razorpay order creation
  try {
    const { amount, currency, receipt } = req.body;
    const options = {
      amount: amount * 100,
      currency: currency || 'INR',
      receipt: receipt || `receipt_${Date.now()}`,
    };
    const order = await razorpay.orders.create(options);
    res.json(order);
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Verify payment endpoint
app.post('/api/verify-payment', (req, res) => {
  if (mockMode) {
    console.log('[MOCK] Verifying payment – always successful');
    return res.json({ success: true, message: 'Mock payment verified' });
  }

  // Real verification logic
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');
    if (expectedSignature === razorpay_signature) {
      res.json({ success: true, message: 'Payment verified' });
    } else {
      res.status(400).json({ success: false, message: 'Invalid signature' });
    }
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Webhook endpoint (real only, but we can keep it available)
app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (mockMode) {
    console.log('[MOCK] Webhook received – ignoring');
    return res.status(200).send('Mock webhook received');
  }

  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];
    const expectedSignature = crypto.createHmac('sha256', webhookSecret).update(req.body).digest('hex');
    if (expectedSignature === signature) {
      const event = JSON.parse(req.body);
      if (event.event === 'payment.captured') {
        console.log(`Payment captured for order: ${event.payload.payment.entity.order_id}`);
      }
      res.status(200).send('Webhook received');
    } else {
      res.status(400).send('Invalid signature');
    }
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Internal server error');
  }
});

// ──────────────────────────────── HEALTH CHECK ──────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Caballero API running ✓', timestamp: new Date().toISOString() });
});

// ──────────────────────────────── START SERVER ──────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🤠 Caballero Backend running at http://localhost:${PORT}`);
});
