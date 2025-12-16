const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../utils/database');
const EmailService = require('../utils/email');

// Inscription - CORRIGÉ POUR LES RÉCOMPENSES
router.post('/signup', async (req, res) => {
  try {
    const { email, password, username, referralCode } = req.body;
    
    console.log(`🔍 Inscription: ${email}, code parrainage: ${referralCode}`);
    
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
    const referral_code = uuidv4().substring(0, 8).toUpperCase();
    
    let referred_by = null;
    let initialCoins = 10; // Coins de bienvenue
    let referrerData = null;

    // Vérifier le code de parrainage
    if (referralCode && referralCode.trim() !== '') {
      console.log(`🔎 Vérification code parrainage: ${referralCode}`);
      
      const { data: referrer } = await supabase
        .from('users')
        .select('id, email, username, coins')
        .eq('referral_code', referralCode)
        .single();

      if (referrer) {
        referred_by = referrer.id;
        referrerData = referrer;
        initialCoins = 20; // 10 + 10 de parrainage
        console.log(`✅ Parrain trouvé: ${referrer.email} (ID: ${referrer.id})`);
      } else {
        console.log(`❌ Code parrainage invalide: ${referralCode}`);
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

    console.log(`✅ Utilisateur créé: ${user.id}, coins initiaux: ${initialCoins}`);

    // Envoyer l'email de vérification
    await EmailService.sendVerificationEmail(email, verificationCode);

    // CORRECTION COMPLÈTE : Si parrainage, donner les coins AU PARRAIN AUSSI
    if (referred_by && referrerData) {
      console.log(`🎯 TRAITEMENT PARRAINAGE pour ${email}`);
      
      const referralReward = parseInt(process.env.COIN_REFERRAL_REWARD) || 10;
      
      // 1. Ajouter l'entrée de référence
      const { error: referralError } = await supabase
        .from('referrals')
        .insert([{
          referrer_id: referred_by,
          referred_id: user.id,
          reward_given: true
        }]);

      if (referralError) {
        console.error('❌ Erreur création referral:', referralError);
      } else {
        console.log(`✅ Referral créé: ${referred_by} -> ${user.id}`);
      }

      // 2. DONNER LES COINS AU PARRAIN
      console.log(`💰 Donner ${referralReward} coins au parrain ${referrerData.email}`);
      
      // Transaction pour le parrain
      const { error: transactionError } = await supabase
        .from('coin_transactions')
        .insert([{
          sender_id: null,
          receiver_id: referred_by,
          amount: referralReward,
          type: 'referral',
          description: `Parrainage de ${email}`
        }]);

      if (transactionError) {
        console.error('❌ Erreur transaction parrain:', transactionError);
      } else {
        console.log(`✅ Transaction parrain enregistrée`);
      }

      // Mettre à jour les coins du parrain MANUELLEMENT (sans rpc)
      const newCoinsForReferrer = (parseInt(referrerData.coins) || 0) + referralReward;
      
      const { error: updateError } = await supabase
        .from('users')
        .update({ 
          coins: newCoinsForReferrer,
          updated_at: new Date()
        })
        .eq('id', referred_by);

      if (updateError) {
        console.error('❌ Erreur mise à jour coins parrain:', updateError);
      } else {
        console.log(`✅ Parrain ${referrerData.email} a maintenant ${newCoinsForReferrer} coins (+${referralReward})`);
      }

      // 3. Transaction pour le parrainé (bonus de parrainage)
      await supabase
        .from('coin_transactions')
        .insert([{
          sender_id: null,
          receiver_id: user.id,
          amount: referralReward,
          type: 'referral_bonus',
          description: 'Bonus de parrainage'
        }]);

      console.log(`✅ Transaction bonus parrainé enregistrée`);

      // 4. Envoyer un email au parrain
      try {
        await EmailService.sendReferralRewardEmail(
          referrerData.email,
          referralReward,
          email
        );
        console.log(`✅ Email envoyé au parrain ${referrerData.email}`);
      } catch (emailError) {
        console.error('❌ Erreur envoi email parrain:', emailError);
      }

      // 5. Log complet
      console.log(`📊 RÉSUMÉ PARRAINAGE FINAL:`);
      console.log(`   👤 Parrainé ${email}: ${initialCoins} coins (10 base + 10 bonus)`);
      console.log(`   👥 Parrain ${referrerData.email}: +${referralReward} coins (total: ${newCoinsForReferrer})`);
      console.log(`   💰 Total distribué: ${initialCoins + referralReward} coins`);
    } else {
      console.log(`ℹ️  Pas de parrainage pour ${email}`);
    }

    res.status(201).json({ 
      message: 'Compte créé avec succès. Vérifiez votre email.',
      userId: user.id,
      coins: initialCoins,
      referred: referred_by ? true : false
    });
  } catch (error) {
    console.error('❌ Erreur inscription:', error);
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
      .maybeSingle();

    // Si l'utilisateur existe → on génère et envoie le code
    if (user) {
      const resetCode = Math.floor(100000 + Math.random() * 900000).toString();

      const { error: updateError } = await supabase
        .from('users')
        .update({
          reset_code: resetCode,
          reset_expires: new Date(Date.now() + 60 * 60 * 1000)
        })
        .eq('id', user.id);

      if (updateError) {
        console.error('Erreur mise à jour reset_code:', updateError);
      } else {
        try {
          await EmailService.sendPasswordResetCodeEmail(email, resetCode);
          console.log(`Code de réinitialisation envoyé à ${email} : ${resetCode}`);
        } catch (emailError) {
          console.error('Échec envoi email:', emailError);
        }
      }
    }

    return res.json({
      message: 'Si cet email est associé à un compte, un code de réinitialisation a été envoyé.'
    });

  } catch (error) {
    console.error('Erreur inattendue forgot-password:', error);
    return res.json({
      message: 'Si cet email est associé à un compte, un code de réinitialisation a été envoyé.'
    });
  }
});

// Reset password
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

// Vérifier code reset
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

// Déconnexion
router.post('/logout', async (req, res) => {
  try {
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
      supabase
        .from('deployments')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('status', 'active'),
      
      supabase
        .from('referrals')
        .select('id', { count: 'exact', head: true })
        .eq('referrer_id', user.id),
      
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
    res.json({ available: true });
  }
});

// Route pour vérifier un code de parrainage
router.get('/check-referral', async (req, res) => {
  try {
    const { code } = req.query;
    
    const { data: referrer, error } = await supabase
      .from('users')
      .select('id, email, username, coins')
      .eq('referral_code', code)
      .single();

    if (error || !referrer) {
      return res.status(404).json({ error: 'Code de parrainage invalide' });
    }
    
    res.json({ 
      referrer,
      reward_amount: parseInt(process.env.COIN_REFERRAL_REWARD) || 10
    });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// NOUVELLE ROUTE : Récupérer les données de parrainage (pour invite.html)
router.get('/referral-stats', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'Token manquant' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.userId;

    // Récupérer l'utilisateur
    const { data: user } = await supabase
      .from('users')
      .select('referral_code, coins, email, username')
      .eq('id', userId)
      .single();

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    // Compter les parrainages
    const { count: totalReferrals } = await supabase
      .from('referrals')
      .select('*', { count: 'exact', head: true })
      .eq('referrer_id', userId);

    // Récupérer les transactions de parrainage
    const { data: referralTransactions } = await supabase
      .from('coin_transactions')
      .select('amount, created_at')
      .eq('receiver_id', userId)
      .eq('type', 'referral');

    const totalCoinsEarned = referralTransactions?.reduce((sum, t) => sum + (t.amount || 0), 0) || 0;

    // Récupérer les parrainages avec détails
    const { data: referrals } = await supabase
      .from('referrals')
      .select(`
        *,
        referred_user:users!referred_id(email, created_at, is_verified)
      `)
      .eq('referrer_id', userId)
      .order('created_at', { ascending: false });

    // Calculer les récompenses en attente
    const pendingRewards = referrals?.filter(r => !r.reward_given).length || 0;

    // Statistiques avancées
    const conversionRate = totalReferrals > 0 ? Math.round((referrals?.length || 0) / totalReferrals * 100) : 0;
    
    // Moyenne par jour (30 derniers jours)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const { data: recentReferrals } = await supabase
      .from('referrals')
      .select('created_at')
      .eq('referrer_id', userId)
      .gte('created_at', thirtyDaysAgo.toISOString());

    const avgPerDay = recentReferrals?.length ? (recentReferrals.length / 30).toFixed(1) : 0;

    res.json({
      success: true,
      user: {
        referral_code: user.referral_code || 'N/A',
        total_coins: user.coins || 0,
        email: user.email,
        username: user.username
      },
      stats: {
        total_referrals: totalReferrals || 0,
        total_coins_earned: totalCoinsEarned,
        pending_rewards: pendingRewards,
        conversion_rate: conversionRate,
        avg_per_day: avgPerDay,
        rank: 1
      },
      referrals: referrals?.map(r => ({
        id: r.id,
        referred_email: r.referred_user?.email || 'Email non disponible',
        created_at: r.created_at,
        is_verified: r.referred_user?.is_verified || false,
        reward_given: r.reward_given || false,
        status: r.reward_given ? 'rewarded' : 'pending'
      })) || []
    });

  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token invalide ou expiré' });
    }
    
    console.error('Erreur récupération stats parrainage:', error);
    res.status(500).json({ 
      success: false,
      error: 'Erreur serveur'
    });
  }
});

module.exports = router;
