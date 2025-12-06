const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session); // LA LIGNE MAGIQUE QUI MANQUAIT
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware personnalisés
const { authMiddleware, requireAuth, requireAdmin } = require('./middleware/auth');

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Trop de requêtes depuis cette IP, veuillez réessayer dans 15 minutes - Powered by KermHost.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

app.use(compression());

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:", "http:", "blob:"],
      connectSrc: ["'self'", "https://api.supabase.co", "https://api.heroku.com", "https://api.resend.com", "ws:", "wss:"],
      frameSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      workerSrc: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(cors({
  origin: function(origin, callback) {
    const allowedOrigins = [
      process.env.CORS_ORIGIN,
      `http://localhost:${PORT}`,
      `http://127.0.0.1:${PORT}`
    ].filter(Boolean);
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));

// SESSION – VERSION FINALE QUI MARCHE À TOUS LES COUPS
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-ultra-long-et-securise-123456789',
  resave: false,
  saveUninitialized: false,
  store: new MemoryStore({
    checkPeriod: 86400000
  }),
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax'
  }
}));

if (process.env.NODE_ENV === 'production') {
  console.log('Utilisation de MemoryStore - Pour production réelle, utilisez Redis');
}

app.use(authMiddleware);
app.use('/api/', limiter);

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Maintenance
app.use(async (req, res, next) => {
  if (req.path.startsWith('/api') || ['/health', '/maintenance', '/favicon.ico'].includes(req.path)) return next();
  if (process.env.MAINTENANCE_MODE === 'true' && !req.path.includes('maintenance')) {
    return res.redirect('/maintenance');
  }
  next();
});

// Routes API
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', requireAdmin, require('./routes/admin'));
app.use('/api/bot', requireAuth, require('./routes/bot'));
app.use('/api/coin', requireAuth, require('./routes/coin'));
app.use('/api/user', requireAuth, require('./routes/user'));
app.use('/api/deploy', requireAuth, require('./routes/deploy'));

// Favicon & pages publiques
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon.ico')));
app.get('/', (req, res) => req.user ? res.redirect('/dashboard') : res.sendFile(path.join(__dirname, 'pages', 'index.html')));
app.get('/login', (req, res) => req.user ? res.redirect('/dashboard') : res.sendFile(path.join(__dirname, 'pages', 'login.html')));
app.get('/signup', (req, res) => req.user ? res.redirect('/dashboard') : res.sendFile(path.join(__dirname, 'pages', 'signup.html')));
app.get('/verify-mail', (_, res) => res.sendFile(path.join(__dirname, 'pages', 'verify-mail.html')));
app.get('/forgot-password', (req, res) => req.user ? res.redirect('/dashboard') : res.sendFile(path.join(__dirname, 'pages', 'forgot-password.html')));
app.get('/reset-password', (req, res) => req.user ? res.redirect('/dashboard') : res.sendFile(path.join(__dirname, 'pages', 'reset-password.html')));

// Dashboard & Admin
const sendDashboard = (file) => (req, res) => res.sendFile(path.join(__dirname, 'pages', 'dashboard', file));
const sendAdmin = (file) => (req, res) => res.sendFile(path.join(__dirname, 'pages', 'admin', file));

app.get('/dashboard', requireAuth, sendDashboard('index.html'));
app.get('/dashboard/bots', requireAuth, sendDashboard('bots.html'));
app.get('/dashboard/coins', requireAuth, sendDashboard('coins.html'));
app.get('/dashboard/invite', requireAuth, sendDashboard('invite.html'));
app.get('/dashboard/profile', requireAuth, sendDashboard('profile.html'));
app.get('/dashboard/request', requireAuth, sendDashboard('request.html'));

app.get('/admin', requireAdmin, sendAdmin('index.html'));
app.get('/admin/users', requireAdmin, sendAdmin('users.html'));
app.get('/admin/bot-request', requireAdmin, sendAdmin('bot-request.html'));
app.get('/admin/add-heroku', requireAdmin, sendAdmin('add-heroku.html'));
app.get('/admin/database', requireAdmin, sendAdmin('database.html'));
app.get('/admin/profile', requireAdmin, sendAdmin('profile.html'));
app.get('/admin/maintenance', requireAdmin, sendAdmin('maintenance.html'));

app.get('/maintenance', (_, res) => res.sendFile(path.join(__dirname, 'pages', 'maintenance.html')));

// 404 & erreurs
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'pages', '404.html'));
});

app.use((err, req, res, next) => {
  console.error('Erreur:', err);
  if (err.name === 'UnauthorizedError') return res.redirect('/login');
  if (err.name === 'ForbiddenError') return res.status(403).sendFile(path.join(__dirname, 'pages', '403.html'));
  res.status(500).sendFile(path.join(__dirname, 'pages', '500.html'));
});

// Démarrage
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  KermHost v2.0 démarré avec succès !
  Port: ${PORT} | Env: ${process.env.NODE_ENV || 'development'}
  URL: ${process.env.APP_URL || `http://localhost:${PORT}`}
  Prêt à recevoir des requêtes...
  `);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

module.exports = { app, server };
