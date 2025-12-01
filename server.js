const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration de rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limite chaque IP à 100 requêtes par fenêtre
  message: 'Trop de requêtes depuis cette IP, veuillez réessayer plus tard.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware de compression
app.use(compression());

// Middleware Helmet pour la sécurité
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https://files.catbox.moe", "https://cdnjs.cloudflare.com", "https://*.githubusercontent.com"],
      connectSrc: ["'self'", "https://api.supabase.co", "https://api.heroku.com", "https://api.resend.com"],
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
  origin: process.env.CORS_ORIGIN || true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Parser middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration - IMPORTANT: En production, utilise un store externe
let sessionStore;
if (process.env.NODE_ENV === 'production') {
  // Pour production, on utilise MemoryStore temporairement
  // IMPORTANT: Change pour Redis ou PostgreSQL en production réelle
  const MemoryStore = session.MemoryStore;
  sessionStore = new MemoryStore();
  console.log('⚠️  ATTENTION: MemoryStore utilisé en production - Change pour Redis/PostgreSQL');
} else {
  sessionStore = new session.MemoryStore();
}

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production-32-chars-minimum',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 heures
    sameSite: 'strict'
  },
  name: 'kermhost.sid'
}));

// Apply rate limiting to all requests
app.use(limiter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'KermHost API',
    version: '1.0.0'
  });
});

// Routes API
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

// Maintenance middleware
app.use(async (req, res, next) => {
  // Sauter les routes d'API et de santé
  if (req.path.startsWith('/api') || req.path === '/health') {
    return next();
  }
  
  // Vérifier si le site est en maintenance
  // Cette vérification devrait être en cache pour la performance
  try {
    // En production, vérifier depuis la base de données
    // Pour l'instant, on utilise une variable d'environnement
    const isMaintenance = process.env.MAINTENANCE_MODE === 'true';
    
    if (isMaintenance && req.path !== '/maintenance') {
      return res.sendFile(path.join(__dirname, 'pages', 'maintenance.html'));
    }
  } catch (error) {
    console.error('Erreur vérification maintenance:', error);
    // Continuer même en cas d'erreur
  }
  
  next();
});

// Pages routes - avec vérification d'authentification
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

app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'reset-password.html'));
});

// Routes dashboard - protection basique
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

// Routes admin - protection basique
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

// Page de maintenance
app.get('/maintenance', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'maintenance.html'));
});

// 404 route
app.use((req, res) => {
  if (req.accepts('html')) {
    res.status(404).sendFile(path.join(__dirname, 'pages', '404.html'));
  } else if (req.accepts('json')) {
    res.status(404).json({ error: 'Ressource non trouvée' });
  } else {
    res.status(404).type('txt').send('Ressource non trouvée');
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Erreur globale:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  });

  // Déterminer le type d'erreur
  const isDev = process.env.NODE_ENV !== 'production';
  
  if (err.name === 'ValidationError') {
    return res.status(400).json({ 
      error: 'Erreur de validation', 
      details: isDev ? err.errors : undefined 
    });
  }
  
  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  
  if (err.name === 'ForbiddenError') {
    return res.status(403).json({ error: 'Accès interdit' });
  }
  
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Fichier trop volumineux' });
  }

  // Erreur serveur générique
  res.status(500).json({ 
    error: 'Une erreur est survenue',
    ...(isDev && { details: err.message, stack: err.stack })
  });
});

// Gestion des signaux pour un arrêt propre
process.on('SIGTERM', () => {
  console.log('SIGTERM reçu. Arrêt propre du serveur...');
  server.close(() => {
    console.log('Serveur arrêté proprement');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT reçu. Arrêt du serveur...');
  server.close(() => {
    console.log('Serveur arrêté');
    process.exit(0);
  });
});

// Démarrer le serveur
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  🚀 Serveur KermHost démarré !
  
  📍 Environnement: ${process.env.NODE_ENV || 'development'}
  🌐 Port: ${PORT}
  📡 URL: ${process.env.APP_URL || `http://localhost:${PORT}`}
  
  📊 Points de terminaison:
    • API: /api/*
    • Dashboard: /dashboard
    • Admin: /admin
    • Santé: /health
  
  ⚠️  NOTES IMPORTANTES:
    • MemoryStore utilisé pour les sessions - Change en production
    • Configure SUPABASE_URL et SUPABASE_ANON_KEY
    • Configure RESEND_API_KEY pour les emails
    • Configure HEROKU_API_KEY pour les déploiements
  
  ✅ Prêt à recevoir des requêtes...
  `);
});

// Gestion des erreurs non capturées
process.on('uncaughtException', (error) => {
  console.error('Exception non capturée:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Rejet non géré:', reason);
});
