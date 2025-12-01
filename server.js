const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https://files.catbox.moe", "https://cdnjs.cloudflare.com"]
    }
  }
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 heures
  }
}));

// Routes
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const botRoutes = require('./routes/bot');
const coinRoutes = require('./routes/coin');
const userRoutes = require('./routes/user');
const deployRoutes = require('./routes/deploy');

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/bot', botRoutes);
app.use('/api/coin', coinRoutes);
app.use('/api/user', userRoutes);
app.use('/api/deploy', deployRoutes);

// Pages routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'login.html'));
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'signup.html'));
});

app.get('/verify-mail', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'verify-mail.html'));
});

app.get('/forgot-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'forgot-password.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'dashboard', 'index.html'));
});

app.get('/dashboard/bots', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'dashboard', 'bots.html'));
});

app.get('/dashboard/coins', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'dashboard', 'coins.html'));
});

app.get('/dashboard/invite', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'dashboard', 'invite.html'));
});

app.get('/dashboard/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'dashboard', 'profile.html'));
});

app.get('/dashboard/request', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'dashboard', 'request.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'admin', 'index.html'));
});

app.get('/admin/users', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'admin', 'users.html'));
});

app.get('/admin/bot-request', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'admin', 'bot-request.html'));
});

app.get('/admin/add-heroku', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'admin', 'add-heroku.html'));
});

app.get('/admin/database', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'admin', 'database.html'));
});

app.get('/admin/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'admin', 'profile.html'));
});

app.get('/admin/maintenance', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'admin', 'maintenance.html'));
});

// 404 route
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'pages', '404.html'));
});

// Maintenance middleware
app.use((req, res, next) => {
  // Vérifier si le site est en maintenance
  // Cette logique devrait vérifier en base de données
  if (false) { // Remplacer par la vérification réelle
    return res.sendFile(path.join(__dirname, 'pages', 'maintenance.html'));
  }
  next();
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Une erreur est survenue!' });
});

app.listen(PORT, () => {
  console.log(`Serveur KermHost démarré sur le port ${PORT}`);
});
