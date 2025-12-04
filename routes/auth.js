const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../utils/database');
const EmailService = require('../utils/email');

// Inscription - CORRIGÉE
router.post('/signup', async (req, res) => {
  try {
    console.log('📥 Requête signup reçue:', req.body);
    const { email, password, username, referralCode } = req.body;
    
    // Validation basique
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    // Vérifier si l'utilisateur existe déjà
    const { data: existingUser, error: checkError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .maybeSingle();

    if (checkError) {
      console.error('❌ Erreur vérification email:', checkError);
      return res.status(500).json({ error: 'Erreur serveur' });
    }

    if (existingUser) {
      return res.status(400).json({ error: 'Cet email est déjà utilisé' });
    }

    // Hasher le mot de passe
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Générer un code de vérification
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const referral_code = uuidv4().substring(0, 8).toUpperCase();
    
    let referred_by = null;
    let initialCoins = 10;

    // Vérifier le code de parrainage
    if (referralCode) {
      console.log('🔍 Vérification code parrainage:', referralCode);
      const { data: referrer } = await supabase
        .from('users')
        .select('id')
        .eq('referral_code', referralCode.toUpperCase())
        .single();

      if (referrer) {
        referred_by = referrer.id;
        initialCoins = 20;
        console.log('✅ Code parrainage valide, referrer:', referrer.id);
      }
    }

    // Créer l'utilisateur
    const { data: user, error } = await supabase
      .from('users')
      .insert([{
        email: email.toLowerCase().trim(),
        password_hash: passwordHash,
        username: username || email.split('@')[0],
        coins: initialCoins,
        referral_code: referral_code,
        referred_by,
        verification_code: verificationCode,
        verification_expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
        is_verified: false,
        role: 'user',
        created_at: new Date(),
        updated_at: new Date()
      }])
      .select()
      .single();

    if (error) {
      console.error('❌ Erreur création utilisateur:', error);
      return res.status(500).json({ error: 'Erreur lors de la création du compte' });
    }

    console.log('✅ Utilisateur créé:', user.id);

    // Si parrainage, créer l'entrée et donner les coins
    if (referred_by) {
      try {
        // Ajouter l'entrée de référence
        await supabase
          .from('referrals')
          .insert([{
            referrer_id: referred_by,
            referred_id: user.id,
            created_at: new Date()
          }]);

        // Donner les coins au parrain
        await supabase
          .from('coin_transactions')
          .insert([{
            sender_id: null,
            receiver_id: referred_by,
            amount: 10,
            type: 'referral',
            description: `Parrainage de ${email}`,
            created_at: new Date()
          }]);

        // Mettre à jour les coins du parrain
        await supabase
          .from('users')
          .update({ 
            coins: supabase.raw('coins + 10'),
            updated_at: new Date()
          })
          .eq('id', referred_by);

        console.log('✅ Parrainage enregistré');
      } catch (referralError) {
        console.error('❌ Erreur parrainage:', referralError);
        // Continuer même en cas d'erreur de parrainage
      }
    }

    // Envoyer l'email de vérification
    try {
      await EmailService.sendVerificationEmail(email, verificationCode);
      console.log('📧 Email de vérification envoyé à:', email);
    } catch (emailError) {
      console.error('❌ Erreur envoi email:', emailError);
      // Ne pas échouer l'inscription si l'email échoue
    }

    res.status(201).json({ 
      message: 'Compte créé avec succès. Vérifiez votre email.',
      userId: user.id 
    });

  } catch (error) {
    console.error('❌ Erreur inscription complète:', error);
    res.status(500).json({ error: 'Erreur lors de l\'inscription' });
  }
});

// Connexion - SIMPLIFIÉE
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Récupérer l'utilisateur
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    // Vérifier le mot de passe
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    // Générer le token JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'votre-secret-jwt',
      { expiresIn: '24h' }
    );

    res.json({
      token,
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
    console.error('Erreur connexion:', error);
    res.status(500).json({ error: 'Erreur lors de la connexion' });
  }
});

// Vérification d'email - SIMPLIFIÉE
router.post('/verify', async (req, res) => {
  try {
    const { email, code } = req.body;

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
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

    // Marquer comme vérifié
    const { error: updateError } = await supabase
      .from('users')
      .update({
        is_verified: true,
        verification_code: null,
        verification_expires: null,
        updated_at: new Date()
      })
      .eq('id', user.id);

    if (updateError) {
      throw updateError;
    }

    res.json({ message: 'Compte vérifié avec succès' });
  } catch (error) {
    console.error('Erreur vérification:', error);
    res.status(500).json({ error: 'Erreur lors de la vérification' });
  }
});

// Renvoyer le code de vérification - SIMPLIFIÉ
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    // Générer un nouveau code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    await supabase
      .from('users')
      .update({
        verification_code: verificationCode,
        verification_expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
        updated_at: new Date()
      })
      .eq('id', user.id);

    // Envoyer l'email
    try {
      await EmailService.sendVerificationEmail(email, verificationCode);
    } catch (emailError) {
      console.error('Erreur envoi email:', emailError);
    }

    res.json({ message: 'Code de vérification renvoyé' });
  } catch (error) {
    console.error('Erreur renvoi vérification:', error);
    res.status(500).json({ error: 'Erreur lors du renvoi' });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    // Validation basique de l'email
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Veuillez entrer un email valide' });
    }

    // On cherche l'utilisateur sans déclencher d'erreur s'il n'existe pas
    const { data: user } = await supabase
      .from('users')
      .select('id, email')
      .eq('email', email.toLowerCase().trim())
      .maybeSingle(); // très important : pas d'erreur si rien trouvé

    // Si l'utilisateur existe → on génère et envoie le code
    if (user) {
      const resetCode = Math.floor(100000 + Math.random() * 900000).toString();

      const { error: updateError } = await supabase
        .from('users')
        .update({
          reset_code: resetCode,
          reset_expires: new Date(Date.now() + 60 * 60 * 1000) // 1 heure
        })
        .eq('id', user.id);

      if (updateError) {
        console.error('Erreur mise à jour reset_code:', updateError);
        // On ne plante pas → on cache l'erreur pour la sécurité
      } else {
        try {
          await EmailService.sendPasswordResetCodeEmail(email, resetCode);
          console.log(`Code de réinitialisation envoyé à ${email} : ${resetCode}`);
        } catch (emailError) {
          console.error('Échec envoi email (mais on cache):', emailError);
          // On ne dit rien → sécurité
        }
      }
    }

    // TOUJOURS la même réponse, même si l'email n'existe pas ou si l'envoi a échoué
    return res.json({
      message: 'Si cet email est associé à un compte, un code de réinitialisation a été envoyé.'
    });

  } catch (error) {
    console.error('Erreur inattendue forgot-password:', error);
    // Même en cas d'erreur serveur → même message neutre
    return res.json({
      message: 'Si cet email est associé à un compte, un code de réinitialisation a été envoyé.'
    });
  }
});

// Dans auth.js - Remplacer la fonction reset-password existante
router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, password } = req.body;

    // Validation
    if (!email || !code || !password) {
      return res.status(400).json({ error: 'Email, code et mot de passe requis' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });
    }

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

    // Vérifier l'expiration
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
        reset_expires: null,
        updated_at: new Date()
      })
      .eq('id', user.id);

    res.json({ message: 'Mot de passe réinitialisé avec succès' });
  } catch (error) {
    console.error('Erreur réinitialisation:', error);
    res.status(500).json({ error: 'Erreur lors de la réinitialisation' });
  }
});

// À ajouter dans auth.js
router.post('/verify-reset-code', async (req, res) => {
  try {
    const { email, code } = req.body;

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

    res.json({ valid: true, message: 'Code valide' });
  } catch (error) {
    console.error('Erreur vérification code:', error);
    res.status(500).json({ error: 'Erreur serveur' });
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

// Route pour vérifier si un email existe déjà
router.get('/check-email', async (req, res) => {
  try {
    const { email } = req.query;
    
    const { data: user, error } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (user) {
      return res.status(409).json({ error: 'Email déjà utilisé' });
    }
    
    res.json({ available: true });
  } catch (error) {
    res.json({ available: true }); // Par défaut disponible
  }
});

// Route pour vérifier un code de parrainage
router.get('/check-referral', async (req, res) => {
  try {
    const { code } = req.query;
    
    const { data: referrer, error } = await supabase
      .from('users')
      .select('id, email, username')
      .eq('referral_code', code)
      .single();

    if (error || !referrer) {
      return res.status(404).json({ error: 'Code de parrainage invalide' });
    }
    
    res.json({ referrer });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
