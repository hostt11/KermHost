const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const supabase = require('../utils/database');
const bcrypt = require('bcryptjs');

// Récupérer le profil de l'utilisateur
router.get('/profile', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    
    // Récupérer les statistiques supplémentaires
    const { count: deploymentsCount } = await supabase
      .from('deployments')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id);

    const { count: botsCount } = await supabase
      .from('bots')
      .select('*', { count: 'exact', head: true })
      .eq('owner_id', user.id);

    const { count: referralsCount } = await supabase
      .from('referrals')
      .select('*', { count: 'exact', head: true })
      .eq('referrer_id', user.id);

    // Récupérer l'historique des activités récentes
    const { data: recentActivity } = await supabase
      .from('activity_logs')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10);

    const profile = {
      ...user,
      stats: {
        deployments: deploymentsCount || 0,
        bots: botsCount || 0,
        referrals: referralsCount || 0,
        coins: user.coins || 0
      },
      recent_activity: recentActivity || []
    };

    res.json({ profile });
  } catch (error) {
    console.error('Erreur récupération profil:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Mettre à jour le profil
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const { username, email } = req.body;
    const userId = req.user.id;

    // Validation
    if (!username && !email) {
      return res.status(400).json({ 
        error: 'Aucune donnée à mettre à jour' 
      });
    }

    // Vérifier l'unicité de l'email si modifié
    if (email && email !== req.user.email) {
      const { data: existingUser } = await supabase
        .from('users')
        .select('id')
        .eq('email', email)
        .neq('id', userId)
        .single();

      if (existingUser) {
        return res.status(400).json({ 
          error: 'Cet email est déjà utilisé' 
        });
      }
    }

    // Préparer les mises à jour
    const updates = {};
    if (username !== undefined) updates.username = username;
    if (email) updates.email = email;

    // Mettre à jour l'utilisateur
    const { data: user, error } = await supabase
      .from('users')
      .update({
        ...updates,
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
        action: 'UPDATE_PROFILE',
        details: updates
      }]);

    res.json({
      message: 'Profil mis à jour avec succès',
      user
    });
  } catch (error) {
    console.error('Erreur mise à jour profil:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Changer le mot de passe
router.put('/change-password', authMiddleware, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    const userId = req.user.id;

    if (!current_password || !new_password) {
      return res.status(400).json({ 
        error: 'Mot de passe actuel et nouveau mot de passe requis' 
      });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ 
        error: 'Le nouveau mot de passe doit contenir au moins 6 caractères' 
      });
    }

    // Récupérer l'utilisateur avec le mot de passe hashé
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('password_hash')
      .eq('id', userId)
      .single();

    if (fetchError || !user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    // Vérifier le mot de passe actuel
    const validPassword = await bcrypt.compare(current_password, user.password_hash);
    if (!validPassword) {
      return res.status(400).json({ 
        error: 'Mot de passe actuel incorrect' 
      });
    }

    // Hasher le nouveau mot de passe
    const salt = await bcrypt.genSalt(parseInt(process.env.BCRYPT_SALT_ROUNDS));
    const newPasswordHash = await bcrypt.hash(new_password, salt);

    // Mettre à jour le mot de passe
    await supabase
      .from('users')
      .update({
        password_hash: newPasswordHash,
        updated_at: new Date()
      })
      .eq('id', userId);

    // Log d'activité
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: userId,
        action: 'CHANGE_PASSWORD'
      }]);

    res.json({ message: 'Mot de passe changé avec succès' });
  } catch (error) {
    console.error('Erreur changement mot de passe:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Supprimer le compte
router.delete('/account', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Vérifier si l'utilisateur a des déploiements actifs
    const { data: activeDeployments } = await supabase
      .from('deployments')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .limit(1);

    if (activeDeployments && activeDeployments.length > 0) {
      return res.status(400).json({ 
        error: 'Impossible de supprimer le compte : vous avez des déploiements actifs. Supprimez d\'abord vos bots.' 
      });
    }

    // Vérifier si l'utilisateur a des bots approuvés
    const { data: approvedBots } = await supabase
      .from('bots')
      .select('id')
      .eq('owner_id', userId)
      .eq('is_approved', true)
      .limit(1);

    if (approvedBots && approvedBots.length > 0) {
      return res.status(400).json({ 
        error: 'Impossible de supprimer le compte : vous avez des bots approuvés. Contactez l\'administrateur.' 
      });
    }

    // Supprimer l'utilisateur
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', userId);

    if (error) throw error;

    // Log d'activité (avec user_id null car l'utilisateur est supprimé)
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: null,
        action: 'DELETE_ACCOUNT',
        details: { user_id: userId, email: req.user.email }
      }]);

    res.json({ message: 'Compte supprimé avec succès' });
  } catch (error) {
    console.error('Erreur suppression compte:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer les notifications
router.get('/notifications', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Récupérer les notifications depuis les logs d'activité
    const { data: notifications } = await supabase
      .from('activity_logs')
      .select('*')
      .or(`user_id.eq.${userId},details->>target_user_id.eq.${userId}`)
      .order('created_at', { ascending: false })
      .limit(20);

    // Marquer les notifications non lues
    const notificationsWithStatus = (notifications || []).map(notification => ({
      ...notification,
      read: false, // À implémenter avec une table de notifications séparée
      type: determineNotificationType(notification.action)
    }));

    res.json({ notifications: notificationsWithStatus });
  } catch (error) {
    console.error('Erreur récupération notifications:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Fonction utilitaire pour déterminer le type de notification
function determineNotificationType(action) {
  const actionMap = {
    'ADD_COINS': 'coin',
    'SEND_COINS': 'coin',
    'CLAIM_DAILY_COINS': 'coin',
    'APPROVE_BOT': 'bot',
    'REJECT_BOT': 'bot',
    'DEPLOY_BOT': 'deployment',
    'UPDATE_DEPLOYMENT': 'deployment',
    'REFERRAL': 'referral',
    'VERIFY_ACCOUNT': 'account',
    'UPDATE_MAINTENANCE': 'system'
  };

  return actionMap[action] || 'system';
}

// Marquer les notifications comme lues
router.post('/notifications/read', authMiddleware, async (req, res) => {
  try {
    const { notification_ids } = req.body;

    // Ici, vous implémenteriez la logique pour marquer les notifications comme lues
    // Pour l'instant, on retourne simplement une confirmation

    res.json({ 
      message: 'Notifications marquées comme lues',
      read_count: notification_ids?.length || 0 
    });
  } catch (error) {
    console.error('Erreur marquage notifications:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer les paramètres de l'utilisateur
router.get('/settings', authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    // Récupérer les préférences de l'utilisateur
    // (à implémenter avec une table de préférences si nécessaire)

    const settings = {
      email_notifications: true,
      push_notifications: false,
      theme: 'dark',
      language: 'fr'
    };

    res.json({ settings });
  } catch (error) {
    console.error('Erreur récupération paramètres:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Mettre à jour les paramètres
router.put('/settings', authMiddleware, async (req, res) => {
  try {
    const { settings } = req.body;
    const userId = req.user.id;

    // Ici, vous sauvegarderiez les paramètres dans la base de données
    // Pour l'instant, on retourne simplement les paramètres mis à jour

    // Log d'activité
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: userId,
        action: 'UPDATE_SETTINGS',
        details: { settings }
      }]);

    res.json({
      message: 'Paramètres mis à jour avec succès',
      settings
    });
  } catch (error) {
    console.error('Erreur mise à jour paramètres:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;