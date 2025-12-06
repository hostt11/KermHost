const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session); // LA SEULE ET UNIQUE BONNE DÉCLARATION
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

// Configuration de rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Trop de requêtes depuis cette IP, veuillez réessayer dans 15 minutes - Powered by KermHost.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// Middleware de compression
app.use(compression());

// Middleware Helmet pour la sécurité
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

// CORS configuration
app.use(cors({
  origin: function(origin, callback) {
    const allowedOrigins = [
      process.env.CORS_ORIGIN,
      `http://localhost:${PORT}`,
      `http://127.0.0.1:${PORT}`
    ].filter(Boolean);
    
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-CSRF-Token']
}));

// Parser middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));

// SESSION - VERSION CORRIGÉE ET FONCTIONNELLE SUR RENDER
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-tres-long-et-aleatoire',
  resave: false,
  saveUninitialized: false,
  store: new MemoryStore({
    checkPeriod: 86400000 // Nettoie les sessions expirées toutes les 24h
  }),
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// Avertissement en production (tu l'adores, il reste)
if (process.env.NODE_ENV === 'production') {
  console.log('Utilisation de MemoryStore - Pour production réelle, utilisez Redis');
}

// Middleware d'authentification global
app.use(authMiddleware);

// Rate limiting uniquement sur les routes API
app.use('/api/', limiter);

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'KermHost',
    version: '2.0.0',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Maintenance middleware
app.use(async (req, res, next) => {
  if (req.path.startsWith('/api') || req.path === '/health' || req.path === '/maintenance' || req.path === '/favicon.ico') {
    return next();
  }
  try {
    const isMaintenance = process.env.MAINTENANCE_MODE === 'true';
    if (isMaintenance && !req.path.includes('maintenance')) {
      return res.redirect('/maintenance');
    }
  } catch (error) {
    console.error('Erreur vérification maintenance:', error);
  }
  next();
});

// Routes API
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const botRoutes = require('./routes/bot');
const coinRoutes = require('./routes/coin');
const userRoutes = require('./routes/user');
const deployRoutes = require('./routes/deploy');

app.use('/api/auth', authRoutes);
app.use('/api/admin', requireAdmin, adminRoutes);
app.use('/api/bot', requireAuth, botRoutes);
app.use('/api/coin', requireAuth, coinRoutes);
app.use('/api/user', requireAuth, userRoutes);
app.use('/api/deploy', requireAuth, deployRoutes);

// Favicon
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon.ico')));

// Pages publiques
app.get('/', (req, res) => req.user ? res.redirect('/dashboard') : res.sendFile(path.join(__dirname, 'pages', 'index.html')));
app.get('/login', (req, res) => req.user ? res.redirect('/dashboard') : res.sendFile(path.join(__dirname, 'pages', 'login.html')));
app.get('/signup', (req, res) => req.user ? res.redirect('/dashboard') : res.sendFile(path.join(__dirname, 'pages', 'signup.html')));
app.get('/verify-mail', (req, res) => res.sendFile(path.join(__dirname, 'pages', 'verify-mail.html')));
app.get('/forgot-password', (req, res) => req.user ? res.redirect('/dashboard') : res.sendFile(path.join(__dirname, 'pages', 'forgot-password.html')));
app.get('/reset-password', (req, res) => req.user ? res.redirect('/dashboard') : res.sendFile(path.join(__dirname, 'pages', 'reset-password.html')));

// Dashboard (protégé)
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'pages', 'dashboard', 'index.html')));
app.get('/dashboard/bots', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'pages', 'dashboard', 'bots.html')));
app.get('/dashboard/coins', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'pages', 'dashboard', 'coins.html')));
app.get('/dashboard/invite', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'pages', 'dashboard', 'invite.html')));
app.get('/dashboard/profile', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'pages', 'dashboard', 'profile.html')));
app.get('/dashboard/request', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'pages', 'dashboard', 'request.html')));

// Admin (protégé)
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'pages', 'admin', 'index.html')));
app.get('/admin/users', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'pages', 'admin', 'users.html')));
app.get('/admin/bot-request', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'pages', 'admin', 'bot-request.html')));
app.get('/admin/add-heroku', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'pages', 'admin', 'add-heroku.html')));
app.get('/admin/database', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'pages', 'admin', 'database.html')));
app.get('/admin/profile', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'pages', 'admin', 'profile.html')));
app.get('/admin/maintenance', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'pages', 'admin', 'maintenance.html')));

// Page de maintenance
app.get('/maintenance', (req, res) => res.sendFile(path.join(__dirname, 'pages', 'maintenance.html')));

// 404
app.use((req, res) => {
  if (req.accepts('html')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(404).sendFile(path.join(__dirname, 'pages', '404.html'));
  } else if (req.accepts('json')) {
    res.status(404).json({ error: 'Ressource non trouvée', path: req.path });
  } else {
    res.status(404).type('txt').send('404 - Ressource non trouvée');
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Erreur globale:', err);
  if (err.name === 'UnauthorizedError') return req.accepts('html') ? res.redirect('/login') : res.status(401).json({ error: 'Non autorisé' });
  if (err.name === 'ForbiddenError') return req.accepts('html') ? res.status(403).sendFile(path.join(__dirname, 'pages', '403.html')) : res.status(403).json({ error: 'Accès interdit' });
  req.accepts('html') ? res.status(500).sendFile(path.join(__dirname, 'pages', '500.html')) : res.status(500).json({ error: 'Erreur interne' });
});

// Démarrage du serveur
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  KermHost v2.0 - Serveur démarré avec succès !
  Environnement: ${process.env.NODE_ENV || 'development'}
  Port: ${PORT}
  URL: ${process.env.APP_URL || `http://localhost:${PORT}`}
  Session Store: MemoryStore
  Prêt à recevoir des requêtes...
  `);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

module.exports = { app, server };
