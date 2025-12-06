const express = require('express');
const session = require('express-session');
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
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limite chaque IP à 100 requêtes par fenêtre
  message: 'Trop de requêtes depuis cette IP, veuillez réessayer dans 15 minutes😙 - Powered by KermHost.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Ne pas compter les requêtes réussies
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

// Session configuration
let sessionStore;
if (process.env.NODE_ENV === 'production') {
  // Pour production, utiliser MemoryStore temporairement
  const MemoryStore = require('memorystore')(session);
  sessionStore = new MemoryStore({
    checkPeriod: 86400000 // Nettoyer les entrées expirées chaque jour
  });
  console.log('⚠️  Utilisation de MemoryStore - Pour production réelle, utilisez Redis');
} else {
  const MemoryStore = session.MemoryStore;
  sessionStore = new MemoryStore();
}

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production-please-use-32-chars-minimum-here',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 heures
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
    domain: process.env.COOKIE_DOMAIN || 'localhost'
  },
  name: 'kermhost.sid'
}));

// Middleware d'authentification global
app.use(authMiddleware);

// Apply rate limiting to API requests only
app.use('/api/', limiter);

// Health check endpoint
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
  // Sauter les routes d'API, de santé et de maintenance
  if (req.path.startsWith('/api') || 
      req.path === '/health' || 
      req.path === '/maintenance' ||
      req.path === '/favicon.ico') {
    return next();
  }
  
  // Vérifier si le site est en maintenance
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
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon.ico'));
});

// Public pages (no auth required)
app.get('/', (req, res) => {
  if (req.user) {
    return res.redirect('/dashboard');
  }
  res.sendFile(path.join(__dirname, 'pages', 'index.html'));
});

app.get('/login', (req, res) => {
  if (req.user) {
    return res.redirect('/dashboard');
  }
  res.sendFile(path.join(__dirname, 'pages', 'login.html'));
});

app.get('/signup', (req, res) => {
  if (req.user) {
    return res.redirect('/dashboard');
  }
  res.sendFile(path.join(__dirname, 'pages', 'signup.html'));
});

app.get('/verify-mail', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'verify-mail.html'));
});

app.get('/forgot-password', (req, res) => {
  if (req.user) {
    return res.redirect('/dashboard');
  }
  res.sendFile(path.join(__dirname, 'pages', 'forgot-password.html'));
});

app.get('/reset-password', (req, res) => {
  if (req.user) {
    return res.redirect('/dashboard');
  }
  res.sendFile(path.join(__dirname, 'pages', 'reset-password.html'));
});

// Protected dashboard routes
app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'dashboard', 'index.html'));
});

app.get('/dashboard/bots', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'dashboard', 'bots.html'));
});

app.get('/dashboard/coins', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'dashboard', 'coins.html'));
});

app.get('/dashboard/invite', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'dashboard', 'invite.html'));
});

app.get('/dashboard/profile', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'dashboard', 'profile.html'));
});

app.get('/dashboard/request', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'dashboard', 'request.html'));
});

// Protected admin routes
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'admin', 'index.html'));
});

app.get('/admin/users', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'admin', 'users.html'));
});

app.get('/admin/bot-request', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'admin', 'bot-request.html'));
});

app.get('/admin/add-heroku', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'admin', 'add-heroku.html'));
});

app.get('/admin/database', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'admin', 'database.html'));
});

app.get('/admin/profile', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'admin', 'profile.html'));
});

app.get('/admin/maintenance', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'admin', 'maintenance.html'));
});

// Page de maintenance publique
app.get('/maintenance', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'maintenance.html'));
});

// 404 route avec cache control
app.use((req, res, next) => {
  if (req.accepts('html')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(404).sendFile(path.join(__dirname, 'pages', '404.html'));
  } else if (req.accepts('json')) {
    res.status(404).json({ 
      error: 'Ressource non trouvée',
      path: req.path,
      timestamp: new Date().toISOString()
    });
  } else {
    res.status(404).type('txt').send('404 - Ressource non trouvée');
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('🔴 Erreur globale:', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.path,
    method: req.method,
    user: req.user ? req.user.id : 'non authentifié',
    timestamp: new Date().toISOString()
  });

  const isDev = process.env.NODE_ENV !== 'production';
  
  // Types d'erreurs spécifiques
  if (err.name === 'ValidationError') {
    return res.status(400).json({ 
      error: 'Erreur de validation', 
      details: isDev ? err.errors : undefined 
    });
  }
  
  if (err.name === 'UnauthorizedError') {
    return req.accepts('html') 
      ? res.redirect('/login')
      : res.status(401).json({ error: 'Non autorisé' });
  }
  
  if (err.name === 'ForbiddenError') {
    return req.accepts('html')
      ? res.status(403).sendFile(path.join(__dirname, 'pages', '403.html'))
      : res.status(403).json({ error: 'Accès interdit' });
  }
  
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Fichier trop volumineux (max 10MB)' });
  }

  // Erreur serveur générique
  if (req.accepts('html')) {
    res.status(500).sendFile(path.join(__dirname, 'pages', '500.html'));
  } else {
    res.status(500).json({ 
      error: 'Une erreur interne est survenue',
      requestId: req.headers['x-request-id'] || Date.now().toString(36),
      ...(isDev && { message: err.message })
    });
  }
});

// Gestion des signaux pour un arrêt propre
const gracefulShutdown = (signal) => {
  console.log(`\n${signal} reçu. Arrêt propre du serveur...`);
  
  server.close(() => {
    console.log('✅ Serveur arrêté proprement');
    // Fermer les connexions à la base de données ici si nécessaire
    process.exit(0);
  });

  // Force shutdown après 10 secondes
  setTimeout(() => {
    console.error('⏰ Arrêt forcé après timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Démarrer le serveur
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  🚀 KermHost v2.0 - Serveur démarré avec succès !
  
  📍 Environnement: ${process.env.NODE_ENV || 'development'}
  🌐 Port: ${PORT}
  📡 URL: ${process.env.APP_URL || `http://localhost:${PORT}`}
  👤 Session Store: ${process.env.NODE_ENV === 'production' ? 'MemoryStore' : 'MemoryStore (dev)'}
  
  📊 Points de terminaison actifs:
    • 🌍 Public: /, /login, /signup
    • 🔐 Dashboard: /dashboard/*
    • ⚡ Admin: /admin/*
    • 🛠️  API: /api/*
    • ❤️  Santé: /health
  
  🔧 Configuration requise:
    ${!process.env.SESSION_SECRET ? '⚠️  SESSION_SECRET non défini' : '✅ SESSION_SECRET configuré'}
    ${!process.env.SUPABASE_URL ? '⚠️  SUPABASE_URL non défini' : '✅ SUPABASE configuré'}
    ${!process.env.JWT_SECRET ? '⚠️  JWT_SECRET non défini' : '✅ JWT configuré'}
  
  📝 Notes:
    • Pages HTML: ${fs.readdirSync(path.join(__dirname, 'pages')).length} fichiers
    • Routes API: ${fs.readdirSync(path.join(__dirname, 'routes')).length} fichiers
    • Maintenance mode: ${process.env.MAINTENANCE_MODE === 'true' ? 'ACTIF ⚠️' : 'INACTIF ✅'}
  
  ✅ Prêt à recevoir des requêtes...
  `);
});

// Gestion des erreurs non capturées
process.on('uncaughtException', (error) => {
  console.error('🔴 EXCEPTION NON CAPTURÉE:', error);
  // Ne pas quitter immédiatement, laisser le serveur gérer
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔴 REJET NON GÉRÉ:', reason);
});

// Export pour les tests
module.exports = { app, server };
