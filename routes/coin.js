const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const supabase = require('../utils/database');
const EmailService = require('../utils/email');

// Récupérer les transactions de coins d'un utilisateur
router.get('/transactions', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, type } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('coin_transactions')
      .select(`
        *,
        sender:users!sender_id(email, username),
        receiver:users!receiver_id(email, username)
      `, { count: 'exact' })
      .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`);

    // Filtrer par type de transaction
    if (type) {
      query = query.eq('type', type);
    }

    const { data: transactions, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({
      transactions: transactions || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Erreur récupération transactions:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer le solde de coins
router.get('/balance', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    
    // Récupérer également les statistiques
    const { count: sentTransactions } = await supabase
      .from('coin_transactions')
      .select('*', { count: 'exact', head: true })
      .eq('sender_id', user.id);

    const { count: receivedTransactions } = await supabase
      .from('coin_transactions')
      .select('*', { count: 'exact', head: true })
      .eq('receiver_id', user.id);

    const { data: dailyClaims } = await supabase
      .from('coin_transactions')
      .select('created_at')
      .eq('receiver_id', user.id)
      .eq('type', 'daily')
      .order('created_at', { ascending: false })
      .limit(1);

    const lastClaimDate = dailyClaims && dailyClaims[0] 
      ? new Date(dailyClaims[0].created_at) 
      : null;

    const canClaimDaily = !lastClaimDate || 
      (new Date() - lastClaimDate) > 24 * 60 * 60 * 1000;

    res.json({
      balance: user.coins || 0,
      stats: {
        sent: sentTransactions || 0,
        received: receivedTransactions || 0,
        last_daily_claim: lastClaimDate,
        can_claim_daily: canClaimDaily
      }
    });
  } catch (error) {
    console.error('Erreur récupération solde:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Réclamer les coins quotidiens
router.post('/claim-daily', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const dailyReward = parseInt(process.env.COIN_DAILY_REWARD) || 10;

    // Vérifier la dernière réclamation
    const { data: lastClaim } = await supabase
      .from('coin_transactions')
      .select('created_at')
      .eq('receiver_id', userId)
      .eq('type', 'daily')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (lastClaim) {
      const lastClaimDate = new Date(lastClaim.created_at);
      const now = new Date();
      const hoursSinceLastClaim = (now - lastClaimDate) / (1000 * 60 * 60);

      if (hoursSinceLastClaim < 24) {
        const hoursRemaining = Math.ceil(24 - hoursSinceLastClaim);
        return res.status(400).json({ 
          error: `Vous avez déjà réclamé vos coins aujourd'hui. Réessayez dans ${hoursRemaining} heures.` 
        });
      }
    }

    // Créer la transaction
    await supabase
      .from('coin_transactions')
      .insert([{
        sender_id: null,
        receiver_id: userId,
        amount: dailyReward,
        type: 'daily',
        description: 'Réclamation quotidienne de coins'
      }]);

    // Mettre à jour le solde de l'utilisateur
    await supabase.rpc('increment_coins', {
      user_id: userId,
      amount: dailyReward
    });

    // Mettre à jour l'utilisateur dans la réponse
    const updatedUser = { ...req.user };
    updatedUser.coins = (updatedUser.coins || 0) + dailyReward;

    // Log d'activité
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: userId,
        action: 'CLAIM_DAILY_COINS',
        details: { amount: dailyReward }
      }]);

    res.json({
      message: `🎉 ${dailyReward} coins réclamés avec succès !`,
      coins_added: dailyReward,
      new_balance: updatedUser.coins,
      next_claim_available: new Date(Date.now() + 24 * 60 * 60 * 1000)
    });
  } catch (error) {
    console.error('Erreur réclamation coins:', error);
    res.status(500).json({ error: 'Erreur lors de la réclamation' });
  }
});

// Envoyer des coins à un autre utilisateur
router.post('/send', authMiddleware, async (req, res) => {
  try {
    const { receiver_email, amount, description } = req.body;
    const senderId = req.user.id;
    const senderEmail = req.user.email;

    // Validation
    if (!receiver_email || !amount) {
      return res.status(400).json({ 
        error: 'Email du destinataire et montant requis' 
      });
    }

    const parsedAmount = parseInt(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ 
        error: 'Montant invalide' 
      });
    }

    if (parsedAmount > (req.user.coins || 0)) {
      return res.status(400).json({ 
        error: 'Solde insuffisant' 
      });
    }

    // Ne pas permettre d'envoyer à soi-même
    if (receiver_email === senderEmail) {
      return res.status(400).json({ 
        error: 'Vous ne pouvez pas vous envoyer des coins à vous-même' 
      });
    }

    // Trouver le destinataire
    const { data: receiver, error: receiverError } = await supabase
      .from('users')
      .select('*')
      .eq('email', receiver_email)
      .single();

    if (receiverError || !receiver) {
      return res.status(404).json({ 
        error: 'Destinataire non trouvé' 
      });
    }

    // Vérifier que le destinataire est vérifié
    if (!receiver.is_verified) {
      return res.status(400).json({ 
        error: 'Le destinataire doit avoir un compte vérifié' 
      });
    }

    // Créer la transaction
    await supabase
      .from('coin_transactions')
      .insert([{
        sender_id: senderId,
        receiver_id: receiver.id,
        amount: parsedAmount,
        type: 'transfer',
        description: description || `Transfert de ${parsedAmount} coins`
      }]);

    // Mettre à jour les soldes
    await supabase.rpc('increment_coins', {
      user_id: senderId,
      amount: -parsedAmount
    });

    await supabase.rpc('increment_coins', {
      user_id: receiver.id,
      amount: parsedAmount
    });

    // Envoyer un email au destinataire
    try {
      await EmailService.sendCoinTransferEmail(senderEmail, receiver_email, parsedAmount);
    } catch (emailError) {
      console.error('Erreur envoi email:', emailError);
    }

    // Log d'activité
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: senderId,
        action: 'SEND_COINS',
        details: { 
          receiver_id: receiver.id, 
          receiver_email: receiver_email,
          amount: parsedAmount 
        }
      }]);

    res.json({
      message: `✅ ${parsedAmount} coins envoyés à ${receiver_email}`,
      coins_sent: parsedAmount,
      new_balance: (req.user.coins || 0) - parsedAmount
    });
  } catch (error) {
    console.error('Erreur envoi coins:', error);
    res.status(500).json({ error: 'Erreur lors de l\'envoi des coins' });
  }
});

// Récupérer les statistiques de parrainage
router.get('/referral-stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Compter les parrainages
    const { count: totalReferrals } = await supabase
      .from('referrals')
      .select('*', { count: 'exact', head: true })
      .eq('referrer_id', userId);

    // Compter les parrainages récompensés
    const { count: rewardedReferrals } = await supabase
      .from('referrals')
      .select('*', { count: 'exact', head: true })
      .eq('referrer_id', userId)
      .eq('reward_given', true);

    // Récupérer les transactions de parrainage
    const { data: referralTransactions } = await supabase
      .from('coin_transactions')
      .select('*')
      .eq('receiver_id', userId)
      .eq('type', 'referral')
      .order('created_at', { ascending: false });

    const totalReferralCoins = referralTransactions?.reduce((sum, t) => sum + (t.amount || 0), 0) || 0;

    // Récupérer la liste des personnes parrainées
    const { data: referrals } = await supabase
      .from('referrals')
      .select(`
        *,
        referred_user:users!referred_id(email, username, created_at)
      `)
      .eq('referrer_id', userId)
      .order('created_at', { ascending: false });

    res.json({
      stats: {
        total_referrals: totalReferrals || 0,
        rewarded_referrals: rewardedReferrals || 0,
        pending_referrals: (totalReferrals || 0) - (rewardedReferrals || 0),
        total_coins_earned: totalReferralCoins,
        referral_reward: parseInt(process.env.COIN_REFERRAL_REWARD) || 10
      },
      referrals: referrals || []
    });
  } catch (error) {
    console.error('Erreur statistiques parrainage:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Générer un nouveau code de parrainage
router.post('/generate-referral-code', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { v4: uuidv4 } = require('uuid');

    // Générer un nouveau code unique
    const newCode = uuidv4().substring(0, 8).toUpperCase();

    // Mettre à jour le code de parrainage de l'utilisateur
    const { data: user, error } = await supabase
      .from('users')
      .update({
        referral_code: newCode,
        updated_at: new Date()
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;

    // Log d'activité
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: userId,
        action: 'GENERATE_REFERRAL_CODE',
        details: { new_code: newCode }
      }]);

    res.json({
      message: 'Nouveau code de parrainage généré',
      referral_code: newCode,
      referral_link: `${process.env.APP_URL}/signup?ref=${newCode}`
    });
  } catch (error) {
    console.error('Erreur génération code:', error);
    res.status(500).json({ error: 'Erreur lors de la génération du code' });
  }
});

// Récupérer le lien de parrainage
router.get('/referral-link', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    
    if (!user.referral_code) {
      // Générer un code si l'utilisateur n'en a pas
      const { v4: uuidv4 } = require('uuid');
      const newCode = uuidv4().substring(0, 8).toUpperCase();

      await supabase
        .from('users')
        .update({
          referral_code: newCode
        })
        .eq('id', user.id);

      user.referral_code = newCode;
    }

    const referralLink = `${process.env.APP_URL}/signup?ref=${user.referral_code}`;

    res.json({
      referral_code: user.referral_code,
      referral_link: referralLink,
      reward_amount: parseInt(process.env.COIN_REFERRAL_REWARD) || 10
    });
  } catch (error) {
    console.error('Erreur récupération lien:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;