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

// Ajouter ces routes dans routes/user.js

// Route pour mettre à jour le profil (remplacer update-profile)
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

// Route pour supprimer le compte
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

// Route pour récupérer les sessions (à simplifier)
router.get('/sessions', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Simuler des données de session (à adapter selon ta base)
    const sessions = [{
      id: 'current',
      user_agent: navigator?.userAgent || 'Appareil actuel',
      ip_address: '127.0.0.1',
      created_at: new Date().toISOString(),
      is_current: true
    }];

    res.json({ sessions });
  } catch (error) {
    console.error('Erreur récupération sessions:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer les statistiques personnelles de l'utilisateur
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const [
      botsCount,
      deploymentsCount,
      actionsCount,
      referralsCount,
      transactionsCount
    ] = await Promise.all([
      // Nombre de bots
      supabase
        .from('bots')
        .select('*', { count: 'exact', head: true })
        .eq('owner_id', userId),
      
      // Nombre de déploiements
      supabase
        .from('deployments')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId),
      
      // Nombre d'actions (logs)
      supabase
        .from('activity_logs')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId),
      
      // Nombre de parrainages
      supabase
        .from('referrals')
        .select('*', { count: 'exact', head: true })
        .eq('referrer_id', userId),
      
      // Nombre de transactions
      supabase
        .from('coin_transactions')
        .select('*', { count: 'exact', head: true })
        .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
    ]);

    res.json({
      totalBots: botsCount.count || 0,
      totalDeployments: deploymentsCount.count || 0,
      totalActions: actionsCount.count || 0,
      totalReferrals: referralsCount.count || 0,
      totalTransactions: transactionsCount.count || 0
    });
  } catch (error) {
    console.error('Erreur récupération statistiques:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer les sessions actives de l'utilisateur
router.get('/sessions', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: sessions, error } = await supabase
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Ajouter des informations de détection de navigateur
    const sessionsWithDetails = (sessions || []).map(session => {
      let device = 'Appareil inconnu';
      let location = 'Localisation inconnue';
      
      if (session.user_agent) {
        // Détection simple du navigateur
        if (session.user_agent.includes('Mobile')) {
          device = 'Mobile';
        } else if (session.user_agent.includes('Tablet')) {
          device = 'Tablette';
        } else {
          device = 'Ordinateur';
        }

        // Détection du navigateur
        if (session.user_agent.includes('Chrome')) {
          device += ' (Chrome)';
        } else if (session.user_agent.includes('Firefox')) {
          device += ' (Firefox)';
        } else if (session.user_agent.includes('Safari')) {
          device += ' (Safari)';
        } else if (session.user_agent.includes('Edge')) {
          device += ' (Edge)';
        }
      }

      // Vérifier si c'est la session actuelle
      const currentToken = req.headers.authorization?.split(' ')[1];
      const isCurrent = session.token === currentToken;

      return {
        ...session,
        device,
        location,
        is_current: isCurrent,
        last_active: session.created_at
      };
    });

    res.json({ sessions: sessionsWithDetails });
  } catch (error) {
    console.error('Erreur récupération sessions:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Terminer une session spécifique
router.delete('/sessions/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Vérifier que la session appartient à l'utilisateur
    const { data: session, error: checkError } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (checkError || !session) {
      return res.status(404).json({ error: 'Session non trouvée' });
    }

    // Supprimer la session
    const { error } = await supabase
      .from('sessions')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ message: 'Session terminée avec succès' });
  } catch (error) {
    console.error('Erreur suppression session:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer l'activité récente de l'utilisateur
router.get('/activity', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 20 } = req.query;

    const { data: activity, error } = await supabase
      .from('activity_logs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (error) throw error;

    res.json({ activity: activity || [] });
  } catch (error) {
    console.error('Erreur récupération activité:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Déconnecter toutes les sessions (sauf la courante)
router.post('/logout-all', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const currentToken = req.headers.authorization?.split(' ')[1];

    // Supprimer toutes les sessions sauf la courante
    const { error } = await supabase
      .from('sessions')
      .delete()
      .eq('user_id', userId)
      .neq('token', currentToken);

    if (error) throw error;

    res.json({ 
      message: 'Toutes les sessions ont été déconnectées',
      sessions_terminated: true
    });
  } catch (error) {
    console.error('Erreur déconnexion sessions:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// CORRECTION pour le changement de mot de passe (changer PUT en POST ou vice-versa)
// Le HTML utilise POST, donc changeons la route dans user.js de PUT à POST :
router.post('/change-password', authMiddleware, async (req, res) => {
  // Copie exacte de la fonction existante mais avec POST au lieu de PUT
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
