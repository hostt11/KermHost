const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../utils/database');
const EmailService = require('../utils/email');

// Inscription
router.post('/signup', async (req, res) => {
  try {
    const { email, password, username, referralCode } = req.body;
    
    // Vérifier si l'utilisateur existe déjà
    const { data: existingUser } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (existingUser) {
      return res.status(400).json({ error: 'Cet email est déjà utilisé' });
    }

    // Hasher le mot de passe
    const salt = await bcrypt.genSalt(parseInt(process.env.BCRYPT_SALT_ROUNDS));
    const passwordHash = await bcrypt.hash(password, salt);

    // Générer un code de vérification
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const referral_code = uuidv4().substring(0, 8);
    
    let referred_by = null;
    let initialCoins = 10; // Coins de bienvenue

    // Vérifier le code de parrainage
    if (referralCode) {
      const { data: referrer } = await supabase
        .from('users')
        .select('id')
        .eq('referral_code', referralCode)
        .single();

      if (referrer) {
        referred_by = referrer.id;
        initialCoins = 20; // 10 + 10 de parrainage
      }
    }

    // Créer l'utilisateur
    const { data: user, error } = await supabase
      .from('users')
      .insert([{
        email,
        password_hash: passwordHash,
        username,
        coins: initialCoins,
        referral_code: referral_code,
        referred_by,
        verification_code: verificationCode,
        verification_expires: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }])
      .select()
      .single();

    if (error) throw error;

    // Envoyer l'email de vérification
    await EmailService.sendVerificationEmail(email, verificationCode);

    // Si parrainage, créer l'entrée et donner les coins
    if (referred_by) {
      // Ajouter l'entrée de référence
      await supabase
        .from('referrals')
        .insert([{
          referrer_id: referred_by,
          referred_id: user.id
        }]);

      // Donner les coins au parrain
      await supabase
        .from('coin_transactions')
        .insert([{
          sender_id: null,
          receiver_id: referred_by,
          amount: parseInt(process.env.COIN_REFERRAL_REWARD),
          type: 'referral',
          description: `Parrainage de ${email}`
        }]);

      // Mettre à jour les coins du parrain
      await supabase.rpc('increment_coins', {
        user_id: referred_by,
        amount: parseInt(process.env.COIN_REFERRAL_REWARD)
      });
    }

    res.status(201).json({ 
      message: 'Compte créé avec succès. Vérifiez votre email.',
      userId: user.id 
    });
  } catch (error) {
    console.error('Erreur inscription:', error);
    res.status(500).json({ error: 'Erreur lors de l\'inscription' });
  }
});

// Connexion
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Récupérer l'utilisateur
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    // Vérifier le mot de passe
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    // Vérifier si le compte est vérifié
    if (!user.is_verified) {
      return res.status(403).json({ error: 'Veuillez vérifier votre email' });
    }

    // Générer le token JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Mettre à jour la dernière connexion
    await supabase
      .from('users')
      .update({ updated_at: new Date() })
      .eq('id', user.id);

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        coins: user.coins,
        referral_code: user.referral_code
      }
    });
  } catch (error) {
    console.error('Erreur connexion:', error);
    res.status(500).json({ error: 'Erreur lors de la connexion' });
  }
});

// Vérification d'email
router.post('/verify', async (req, res) => {
  try {
    const { email, code } = req.body;

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    if (user.is_verified) {
      return res.status(400).json({ error: 'Compte déjà vérifié' });
    }

    if (user.verification_code !== code) {
      return res.status(400).json({ error: 'Code de vérification incorrect' });
    }

    if (new Date() > new Date(user.verification_expires)) {
      return res.status(400).json({ error: 'Code de vérification expiré' });
    }

    // Marquer comme vérifié
    await supabase
      .from('users')
      .update({
        is_verified: true,
        verification_code: null,
        verification_expires: null
      })
      .eq('id', user.id);

    res.json({ message: 'Compte vérifié avec succès' });
  } catch (error) {
    console.error('Erreur vérification:', error);
    res.status(500).json({ error: 'Erreur lors de la vérification' });
  }
});

// Renvoyer le code de vérification
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    if (user.is_verified) {
      return res.status(400).json({ error: 'Compte déjà vérifié' });
    }

    // Générer un nouveau code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    await supabase
      .from('users')
      .update({
        verification_code: verificationCode,
        verification_expires: new Date(Date.now() + 24 * 60 * 60 * 1000)
      })
      .eq('id', user.id);

    // Envoyer l'email
    await EmailService.sendVerificationEmail(email, verificationCode);

    res.json({ message: 'Code de vérification renvoyé' });
  } catch (error) {
    console.error('Erreur renvoi vérification:', error);
    res.status(500).json({ error: 'Erreur lors du renvoi' });
  }
});

// Dans auth.js - modifier la route POST /forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    // Générer un code à 6 chiffres au lieu d'un token JWT
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();

    await supabase
      .from('users')
      .update({
        reset_code: resetCode, // Nouveau champ à ajouter dans votre table users
        reset_expires: new Date(Date.now() + 60 * 60 * 1000) // 1 heure
      })
      .eq('id', user.id);

    // Envoyer l'email avec le code (modifier EmailService)
    await EmailService.sendPasswordResetCodeEmail(email, resetCode);

    res.json({ 
      message: 'Code de réinitialisation envoyé',
      // Ne pas renvoyer le code en production, c'est juste pour le debug
      code: process.env.NODE_ENV === 'development' ? resetCode : undefined
    });
  } catch (error) {
    console.error('Erreur mot de passe oublié:', error);
    res.status(500).json({ error: 'Erreur lors de la demande' });
  }
});

// Dans auth.js - modifier la route POST /reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, password } = req.body; // Ajouter email et code

    // Trouver l'utilisateur avec ce code
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .eq('reset_code', code)
      .single();

    if (error || !user) {
      return res.status(400).json({ error: 'Code ou email invalide' });
    }

    if (new Date() > new Date(user.reset_expires)) {
      return res.status(400).json({ error: 'Code expiré' });
    }

    // Hasher le nouveau mot de passe
    const salt = await bcrypt.genSalt(parseInt(process.env.BCRYPT_SALT_ROUNDS));
    const passwordHash = await bcrypt.hash(password, salt);

    // Mettre à jour le mot de passe et effacer le code
    await supabase
      .from('users')
      .update({
        password_hash: passwordHash,
        reset_code: null,
        reset_expires: null
      })
      .eq('id', user.id);

    res.json({ message: 'Mot de passe réinitialisé avec succès' });
  } catch (error) {
    console.error('Erreur réinitialisation:', error);
    res.status(500).json({ error: 'Erreur lors de la réinitialisation' });
  }
});

// Vérifier le token JWT (check)
router.get('/check', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'Token manquant' });
    }

    // Vérifier le token JWT
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Récupérer l'utilisateur depuis la base de données
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, username, role, coins, referral_code, is_verified')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Utilisateur non trouvé' });
    }

    res.json({
      valid: true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        coins: user.coins,
        referral_code: user.referral_code,
        is_verified: user.is_verified
      }
    });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token invalide ou expiré' });
    }
    
    console.error('Erreur vérification token:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Rafraîchir le token
router.post('/refresh-token', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token requis' });
    }

    // Vérifier le refresh token
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
    
    // Récupérer l'utilisateur
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, role')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Utilisateur non trouvé' });
    }

    // Générer un nouveau token
    const newToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token: newToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Refresh token invalide ou expiré' });
    }
    
    console.error('Erreur rafraîchissement token:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Déconnexion (côté serveur - invalider le token si nécessaire)
router.post('/logout', async (req, res) => {
  try {
    // Dans une implémentation plus avancée, vous pourriez blacklister le token
    // Pour l'instant, nous laissons le client supprimer le token localement
    
    res.json({ message: 'Déconnexion réussie' });
  } catch (error) {
    console.error('Erreur déconnexion:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer le profil utilisateur
router.get('/profile', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'Token manquant' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, username, role, coins, referral_code, is_verified, created_at, last_coin_claim')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    // Récupérer les statistiques de l'utilisateur
    const [deploymentsCount, referralsCount, transactions] = await Promise.all([
      // Nombre de déploiements actifs
      supabase
        .from('deployments')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('status', 'active'),
      
      // Nombre de parrainages
      supabase
        .from('referrals')
        .select('id', { count: 'exact', head: true })
        .eq('referrer_id', user.id),
      
      // Dernières transactions
      supabase
        .from('coin_transactions')
        .select('*')
        .or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`)
        .order('created_at', { ascending: false })
        .limit(5)
    ]);

    res.json({
      user: {
        ...user,
        stats: {
          active_deployments: deploymentsCount.count || 0,
          total_referrals: referralsCount.count || 0,
          recent_transactions: transactions.data || []
        }
      }
    });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token invalide ou expiré' });
    }
    
    console.error('Erreur récupération profil:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
