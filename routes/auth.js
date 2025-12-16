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
    
    // Validation
    if (!email || !password || !username) {
      return res.status(400).json({ error: 'Email, mot de passe et nom d\'utilisateur requis' });
    }

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
    let referralEntry = null;

    // Vérifier le code de parrainage
    if (referralCode) {
      const { data: referrer } = await supabase
        .from('users')
        .select('id, email, is_verified')
        .eq('referral_code', referralCode)
        .eq('is_verified', true)
        .single();

      if (referrer) {
        referred_by = referrer.id;
        initialCoins = 20; // 10 + 10 de parrainage
        
        // Créer l'entrée de référence (reward_given sera false jusqu'à vérification)
        referralEntry = {
          referrer_id: referrer.id,
          referred_email: email,
          reward_given: false,
          status: 'pending'
        };
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
        verification_expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
        is_verified: false
      }])
      .select()
      .single();

    if (error) throw error;

    // Si parrainage, créer l'entrée maintenant qu'on a l'ID
    if (referralEntry && referred_by && user) {
      await supabase
        .from('referrals')
        .insert([{
          referrer_id: referralEntry.referrer_id,
          referred_id: user.id,
          referred_email: referralEntry.referred_email,
          reward_given: false,
          status: 'pending'
        }]);
    }

    // Envoyer l'email de vérification
    await EmailService.sendVerificationEmail(email, verificationCode);

    // Log d'activité
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: user.id,
        action: 'SIGNUP',
        details: { 
          email,
          referred_by: referred_by ? 'oui' : 'non',
          initial_coins: initialCoins
        }
      }]);

    res.status(201).json({ 
      message: 'Compte créé avec succès. Vérifiez votre email.',
      userId: user.id,
      verificationRequired: true
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
      return res.status(403).json({ 
        error: 'Veuillez vérifier votre email',
        needsVerification: true,
        email: user.email
      });
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
        referral_code: user.referral_code,
        is_verified: user.is_verified
      }
    });
  } catch (error) {
    console.error('Erreur connexion:', error);
    res.status(500).json({ error: 'Erreur lors de la connexion' });
  }
});

// Vérification d'email avec bonus de parrainage
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
        verification_expires: null,
        updated_at: new Date()
      })
      .eq('id', user.id);

    // VÉRIFICATION IMPORTANTE : Donner le bonus de parrainage si applicable
    if (user.referred_by) {
      try {
        const referralReward = parseInt(process.env.COIN_REFERRAL_REWARD) || 10;
        
        // 1. Mettre à jour l'entrée de référence
        await supabase
          .from('referrals')
          .update({
            reward_given: true,
            status: 'completed',
            completed_at: new Date()
          })
          .eq('referred_id', user.id)
          .eq('referrer_id', user.referred_by);

        // 2. Donner les coins au parrain
        await supabase
          .from('coin_transactions')
          .insert([{
            sender_id: null,
            receiver_id: user.referred_by,
            amount: referralReward,
            type: 'referral',
            description: `Parrainage de ${user.email}`
          }]);

        // 3. Mettre à jour les coins du parrain
        await supabase.rpc('increment_coins', {
          user_id: user.referred_by,
          amount: referralReward
        });

        // 4. Notifier le parrain par email
        const { data: referrer } = await supabase
          .from('users')
          .select('email')
          .eq('id', user.referred_by)
          .single();

        if (referrer && referrer.email) {
          await EmailService.sendReferralBonusEmail(referrer.email, user.email, referralReward);
        }

        console.log(`✅ Bonus parrainage donné: ${referralReward} coins à ${user.referred_by} pour ${user.email}`);
      } catch (referralError) {
        console.error('Erreur attribution bonus parrainage:', referralError);
        // Ne pas bloquer la vérification si le bonus échoue
      }
    }

    // Envoyer email de confirmation
    await EmailService.sendVerificationSuccessEmail(user.email);

    res.json({ 
      message: 'Compte vérifié avec succès',
      bonus: user.referred_by ? 'Bonus de parrainage attribué' : null
    });
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
        verification_expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
        updated_at: new Date()
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
          reset_expires: new Date(Date.now() + 60 * 60 * 1000), // 1 heure
          updated_at: new Date()
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

    // Récupérer les statistiques de parrainage
    const referralsCount = await supabase
      .from('referrals')
      .select('*', { count: 'exact', head: true })
      .eq('referrer_id', user.id);

    // Récupérer les transactions
    const transactions = await supabase
      .from('coin_transactions')
      .select('*')
      .or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`)
      .order('created_at', { ascending: false })
      .limit(5);

    res.json({
      user: {
        ...user,
        stats: {
          total_referrals: referralsCount.count || 0
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
      .select('id, email, username, is_verified')
      .eq('referral_code', code)
      .eq('is_verified', true)
      .single();

    if (error || !referrer) {
      return res.status(404).json({ error: 'Code de parrainage invalide ou parrain non vérifié' });
    }
    
    res.json({ 
      referrer,
      bonus: parseInt(process.env.COIN_REFERRAL_REWARD) || 10
    });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// NOUVELLE ROUTE : Récupérer les statistiques détaillées de parrainage
router.get('/referral-stats-detailed', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'Token manquant' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Récupérer les références
    const { data: referrals, error } = await supabase
      .from('referrals')
      .select('*, referred_user:users!referred_id(email, created_at)')
      .eq('referrer_id', decoded.userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Erreur récupération références:', error);
      return res.status(500).json({ error: 'Erreur serveur' });
    }

    // Récupérer les transactions de parrainage
    const { data: referralTransactions } = await supabase
      .from('coin_transactions')
      .select('amount, created_at')
      .eq('receiver_id', decoded.userId)
      .eq('type', 'referral')
      .order('created_at', { ascending: false });

    // Calculer les statistiques
    const totalReferrals = referrals?.length || 0;
    const totalCoinsEarned = referralTransactions?.reduce((sum, t) => sum + (t.amount || 0), 0) || 0;
    const pendingRewards = referrals?.filter(r => !r.reward_given).length || 0;

    // Calculer les références ce mois-ci
    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthlyReferrals = referrals?.filter(r => 
      new Date(r.created_at) >= firstDayOfMonth
    ).length || 0;

    res.json({
      stats: {
        total_referrals: totalReferrals,
        total_coins_earned: totalCoinsEarned,
        pending_rewards: pendingRewards,
        monthly_referrals: monthlyReferrals,
        conversion_rate: totalReferrals > 0 ? Math.round((totalReferrals - pendingRewards) / totalReferrals * 100) : 0
      },
      referrals: referrals || [],
      rank: calculateRank(totalReferrals)
    });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token invalide ou expiré' });
    }
    
    console.error('Erreur statistiques parrainage:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Fonction pour calculer le rang
function calculateRank(totalReferrals) {
  if (totalReferrals >= 50) return 1;
  if (totalReferrals >= 25) return 2;
  if (totalReferrals >= 15) return 3;
  if (totalReferrals >= 10) return 4;
  if (totalReferrals >= 5) return 5;
  if (totalReferrals >= 3) return 10;
  if (totalReferrals >= 1) return 20;
  return 50;
}

module.exports = router;
