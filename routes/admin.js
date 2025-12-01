const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');
const supabase = require('../utils/database');
const HerokuService = require('../utils/heroku');
const EmailService = require('../utils/email');

// Toutes les routes admin nécessitent l'authentification et les privilèges admin
router.use(authMiddleware, adminMiddleware);

// Récupérer tous les utilisateurs avec filtres avancés
router.get('/users', async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      search = '', 
      role = '', 
      status = '',
      sortBy = 'created_at',
      sortOrder = 'desc'
    } = req.query;
    
    const offset = (page - 1) * limit;

    // Construire la requête avec filtres
    let query = supabase
      .from('users')
      .select('*', { count: 'exact' });

    // Filtrer par recherche
    if (search) {
      query = query.or(`email.ilike.%${search}%,username.ilike.%${search}%`);
    }

    // Filtrer par rôle
    if (role) {
      query = query.eq('role', role);
    }

    // Filtrer par statut de vérification
    if (status === 'verified') {
      query = query.eq('is_verified', true);
    } else if (status === 'pending') {
      query = query.eq('is_verified', false);
    }

    // Trier les résultats
    if (sortBy) {
      query = query.order(sortBy, { ascending: sortOrder === 'asc' });
    } else {
      query = query.order('created_at', { ascending: false });
    }

    // Exécuter la requête avec pagination
    const { data: users, error, count } = await query
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({
      users: users || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Erreur récupération utilisateurs:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer un utilisateur spécifique
router.get('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    // Ne pas renvoyer le mot de passe
    const { password_hash, ...userWithoutPassword } = user;

    res.json({ user: userWithoutPassword });
  } catch (error) {
    console.error('Erreur récupération utilisateur:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Mettre à jour un utilisateur
router.put('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { email, username, role, coins, is_verified } = req.body;

    // Vérifier que l'utilisateur existe
    const { data: existingUser, error: checkError } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .single();

    if (checkError || !existingUser) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    // Vérifier l'unicité de l'email si modifié
    if (email && email !== existingUser.email) {
      const { data: duplicateUser } = await supabase
        .from('users')
        .select('id')
        .eq('email', email)
        .neq('id', id)
        .single();

      if (duplicateUser) {
        return res.status(400).json({ error: 'Cet email est déjà utilisé' });
      }
    }

    // Préparer les mises à jour
    const updates = {};
    if (email) updates.email = email;
    if (username !== undefined) updates.username = username;
    if (role !== undefined) updates.role = role;
    if (coins !== undefined) updates.coins = parseInt(coins);
    if (is_verified !== undefined) updates.is_verified = is_verified;

    // Mettre à jour l'utilisateur
    const { data: user, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // Log d'activité
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: req.user.id,
        action: 'UPDATE_USER',
        details: { target_user_id: id, updates }
      }]);

    res.json({ 
      message: 'Utilisateur mis à jour',
      user 
    });
  } catch (error) {
    console.error('Erreur mise à jour utilisateur:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Supprimer un utilisateur
router.delete('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Ne pas permettre de se supprimer soi-même
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte' });
    }

    // Vérifier si l'utilisateur a des déploiements actifs
    const { data: activeDeployments } = await supabase
      .from('deployments')
      .select('id')
      .eq('user_id', id)
      .eq('status', 'active')
      .limit(1);

    if (activeDeployments && activeDeployments.length > 0) {
      return res.status(400).json({ 
        error: 'Impossible de supprimer : des déploiements actifs sont associés à cet utilisateur' 
      });
    }

    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', id);

    if (error) throw error;

    // Log d'activité
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: req.user.id,
        action: 'DELETE_USER',
        details: { target_user_id: id }
      }]);

    res.json({ message: 'Utilisateur supprimé' });
  } catch (error) {
    console.error('Erreur suppression utilisateur:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Ajouter des coins à un utilisateur
router.post('/users/:id/add-coins', async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, description } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Montant invalide' });
    }

    // Vérifier que l'utilisateur existe
    const { data: user, error: checkError } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .single();

    if (checkError || !user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    // Ajouter la transaction
    await supabase
      .from('coin_transactions')
      .insert([{
        sender_id: req.user.id,
        receiver_id: id,
        amount: parseInt(amount),
        type: 'admin',
        description: description || 'Ajout administrateur'
      }]);

    // Mettre à jour les coins de l'utilisateur
    await supabase.rpc('increment_coins', {
      user_id: id,
      amount: parseInt(amount)
    });

    // Log d'activité
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: req.user.id,
        action: 'ADD_COINS',
        details: { target_user_id: id, amount, description }
      }]);

    res.json({ message: `${amount} coins ajoutés à l'utilisateur` });
  } catch (error) {
    console.error('Erreur ajout coins:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Vérifier manuellement un utilisateur
router.post('/users/:id/verify', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: user, error: checkError } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .single();

    if (checkError || !user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    if (user.is_verified) {
      return res.status(400).json({ error: 'Utilisateur déjà vérifié' });
    }

    // Mettre à jour le statut de vérification
    await supabase
      .from('users')
      .update({
        is_verified: true,
        verification_code: null,
        verification_expires: null
      })
      .eq('id', id);

    // Envoyer un email de confirmation
    try {
      await EmailService.sendVerificationSuccessEmail(user.email);
    } catch (emailError) {
      console.error('Erreur envoi email:', emailError);
    }

    // Log d'activité
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: req.user.id,
        action: 'MANUAL_VERIFY_USER',
        details: { target_user_id: id, email: user.email }
      }]);

    res.json({ message: 'Utilisateur vérifié manuellement avec succès' });
  } catch (error) {
    console.error('Erreur vérification manuelle:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer les demandes de bots avec filtres
router.get('/bot-requests', async (req, res) => {
  try {
    const { 
      status = 'pending',
      page = 1,
      limit = 20,
      search = ''
    } = req.query;

    const offset = (page - 1) * limit;

    // Construire la requête
    let query = supabase
      .from('bots')
      .select(`
        *,
        user:users(email, username)
      `, { count: 'exact' });

    // Filtrer par statut
    if (status === 'approved') {
      query = query.eq('is_approved', true);
    } else if (status === 'pending') {
      query = query.eq('is_approved', false);
    }

    // Filtrer par recherche
    if (search) {
      query = query.or(`name.ilike.%${search}%,github_repo.ilike.%${search}%`);
    }

    // Pagination
    const { data: requests, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({
      requests: requests || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Erreur récupération demandes bots:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer une demande de bot spécifique
router.get('/bot-requests/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: request, error } = await supabase
      .from('bots')
      .select(`
        *,
        user:users(*)
      `)
      .eq('id', id)
      .single();

    if (error) throw error;

    if (!request) {
      return res.status(404).json({ error: 'Demande de bot non trouvée' });
    }

    res.json({ request });
  } catch (error) {
    console.error('Erreur récupération demande bot:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Approuver/rejeter un bot
router.post('/bot-requests/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { approve, reason } = req.body;

    const { data: bot, error } = await supabase
      .from('bots')
      .update({
        is_approved: approve,
        updated_at: new Date()
      })
      .eq('id', id)
      .select(`
        *,
        user:users(*)
      `)
      .single();

    if (error) throw error;

    // Envoyer un email au propriétaire du bot
    if (bot.user && bot.user.email) {
      try {
        if (approve) {
          await EmailService.sendBotApprovalEmail(bot.user.email, bot.name);
        } else {
          await EmailService.sendBotRejectionEmail(bot.user.email, bot.name, reason);
        }
      } catch (emailError) {
        console.error('Erreur envoi email:', emailError);
      }
    }

    // Log d'activité
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: req.user.id,
        action: approve ? 'APPROVE_BOT' : 'REJECT_BOT',
        details: { 
          bot_id: id, 
          bot_name: bot.name,
          owner_email: bot.user?.email,
          reason: reason || null
        }
      }]);

    res.json({ 
      message: approve ? 'Bot approuvé avec succès' : 'Bot rejeté',
      bot 
    });
  } catch (error) {
    console.error('Erreur approbation bot:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Supprimer une demande de bot
router.delete('/bot-requests/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Vérifier si le bot est déployé
    const { data: deployments } = await supabase
      .from('deployments')
      .select('id')
      .eq('bot_id', id)
      .eq('status', 'active')
      .limit(1);

    if (deployments && deployments.length > 0) {
      return res.status(400).json({ 
        error: 'Impossible de supprimer : ce bot est actuellement déployé' 
      });
    }

    const { error } = await supabase
      .from('bots')
      .delete()
      .eq('id', id);

    if (error) throw error;

    // Log d'activité
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: req.user.id,
        action: 'DELETE_BOT_REQUEST',
        details: { bot_id: id }
      }]);

    res.json({ message: 'Demande de bot supprimée' });
  } catch (error) {
    console.error('Erreur suppression demande bot:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Gérer la maintenance
router.get('/maintenance', async (req, res) => {
  try {
    const { data: maintenance, error } = await supabase
      .from('maintenance')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    res.json({ maintenance: maintenance || { is_active: false } });
  } catch (error) {
    console.error('Erreur récupération maintenance:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/maintenance', async (req, res) => {
  try {
    const { is_active, message, end_time } = req.body;

    const { data: maintenance, error } = await supabase
      .from('maintenance')
      .insert([{
        is_active,
        message,
        end_time: end_time ? new Date(end_time) : null
      }])
      .select()
      .single();

    if (error) throw error;

    // Log d'activité
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: req.user.id,
        action: 'UPDATE_MAINTENANCE',
        details: { is_active, message, end_time }
      }]);

    res.json({ 
      message: 'Maintenance mise à jour avec succès',
      maintenance 
    });
  } catch (error) {
    console.error('Erreur mise à jour maintenance:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Historique des maintenances
router.get('/maintenance/history', async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    const { data: history, error } = await supabase
      .from('maintenance')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (error) throw error;

    res.json({ history: history || [] });
  } catch (error) {
    console.error('Erreur récupération historique:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Forcer la désactivation de la maintenance
router.post('/maintenance/force-disable', async (req, res) => {
  try {
    // Désactiver toute maintenance active
    await supabase
      .from('maintenance')
      .update({ 
        is_active: false,
        updated_at: new Date()
      })
      .eq('is_active', true);

    // Créer une nouvelle entrée pour la désactivation
    const { data: maintenance, error } = await supabase
      .from('maintenance')
      .insert([{
        is_active: false,
        message: 'Maintenance désactivée manuellement par un administrateur',
        end_time: new Date()
      }])
      .select()
      .single();

    if (error) throw error;

    // Log d'activité
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: req.user.id,
        action: 'FORCE_DISABLE_MAINTENANCE',
        details: { method: 'manual' }
      }]);

    res.json({ 
      message: 'Maintenance désactivée avec succès',
      maintenance 
    });
  } catch (error) {
    console.error('Erreur désactivation maintenance:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Arrêter tous les bots (pour maintenance d'urgence)
router.post('/maintenance/stop-all-bots', async (req, res) => {
  try {
    // Récupérer tous les déploiements actifs
    const { data: activeDeployments, error: fetchError } = await supabase
      .from('deployments')
      .select('id, heroku_app_name, heroku_account_id')
      .eq('status', 'active');

    if (fetchError) throw fetchError;

    let stoppedCount = 0;
    let errors = [];

    // Pour chaque déploiement, récupérer le compte Heroku et arrêter l'application
    if (activeDeployments && activeDeployments.length > 0) {
      for (const deployment of activeDeployments) {
        try {
          // Récupérer le compte Heroku
          const { data: herokuAccount } = await supabase
            .from('heroku_accounts')
            .select('api_key')
            .eq('id', deployment.heroku_account_id)
            .single();

          if (herokuAccount && herokuAccount.api_key) {
            // Arrêter l'application Heroku
            const heroku = new HerokuService(herokuAccount.api_key);
            await heroku.deleteApp(deployment.heroku_app_name);
            
            // Mettre à jour le statut dans la base de données
            await supabase
              .from('deployments')
              .update({
                status: 'stopped',
                logs: 'Arrêté lors de la maintenance d\'urgence',
                updated_at: new Date()
              })
              .eq('id', deployment.id);

            // Décrémenter l'utilisation du compte Heroku
            await supabase
              .from('heroku_accounts')
              .update({ 
                used_count: supabase.raw('used_count - 1')
              })
              .eq('id', deployment.heroku_account_id);

            stoppedCount++;
          }
        } catch (deploymentError) {
          errors.push(`Déploiement ${deployment.id}: ${deploymentError.message}`);
          console.error(`Erreur arrêt déploiement ${deployment.id}:`, deploymentError);
        }
      }
    }

    // Log d'activité
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: req.user.id,
        action: 'EMERGENCY_STOP_ALL_BOTS',
        details: { 
          total_stopped: stoppedCount,
          total_attempted: activeDeployments?.length || 0,
          errors: errors.length > 0 ? errors : null
        }
      }]);

    res.json({
      message: `Arrêt d'urgence effectué : ${stoppedCount} bots arrêtés`,
      stats: {
        stopped: stoppedCount,
        attempted: activeDeployments?.length || 0,
        errors: errors.length
      },
      errors: errors.length > 0 ? errors : null
    });
  } catch (error) {
    console.error('Erreur arrêt d\'urgence bots:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Vider l'historique des maintenances
router.delete('/maintenance/clear-history', async (req, res) => {
  try {
    // Garder seulement les 50 dernières entrées
    const { data: allMaintenance, error: fetchError } = await supabase
      .from('maintenance')
      .select('id')
      .order('created_at', { ascending: false });

    if (fetchError) throw fetchError;

    if (allMaintenance && allMaintenance.length > 50) {
      const idsToKeep = allMaintenance.slice(0, 50).map(m => m.id);
      const idsToDelete = allMaintenance.slice(50).map(m => m.id);

      if (idsToDelete.length > 0) {
        const { error: deleteError } = await supabase
          .from('maintenance')
          .delete()
          .in('id', idsToDelete);

        if (deleteError) throw deleteError;
      }

      // Log d'activité
      await supabase
        .from('activity_logs')
        .insert([{
          user_id: req.user.id,
          action: 'CLEAR_MAINTENANCE_HISTORY',
          details: { 
            kept: idsToKeep.length,
            deleted: idsToDelete.length 
          }
        }]);

      res.json({
        message: `Historique nettoyé : ${idsToDelete.length} entrées supprimées, ${idsToKeep.length} conservées`,
        stats: {
          kept: idsToKeep.length,
          deleted: idsToDelete.length
        }
      });
    } else {
      res.json({
        message: 'L\'historique est déjà au minimum (50 entrées maximum)',
        stats: {
          kept: allMaintenance?.length || 0,
          deleted: 0
        }
      });
    }
  } catch (error) {
    console.error('Erreur vidage historique:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Notifier les utilisateurs d'une maintenance (simulé pour l'instant)
router.post('/maintenance/notify-users', async (req, res) => {
  try {
    const { message, end_time } = req.body;

    // Récupérer tous les utilisateurs vérifiés
    const { data: users, error } = await supabase
      .from('users')
      .select('email, is_verified')
      .eq('is_verified', true);

    if (error) throw error;

    // En production, vous voudriez envoyer des emails réels
    // Pour l'instant, on log juste l'action
    if (users && users.length > 0) {
      console.log(`Maintenance notification à ${users.length} utilisateurs :`, message);

      // Log d'activité
      await supabase
        .from('activity_logs')
        .insert([{
          user_id: req.user.id,
          action: 'MAINTENANCE_NOTIFICATION_SENT',
          details: { 
            users_notified: users.length,
            message: message,
            end_time: end_time 
          }
        }]);
    }

    res.json({
      message: `Notification envoyée à ${users?.length || 0} utilisateurs`,
      users_notified: users?.length || 0
    });
  } catch (error) {
    console.error('Erreur notification utilisateurs:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Vérifier automatiquement la fin des maintenances (cron job)
router.get('/maintenance/check-expired', async (req, res) => {
  try {
    const now = new Date();
    
    // Trouver les maintenances actives qui devraient être terminées
    const { data: expiredMaintenance, error } = await supabase
      .from('maintenance')
      .select('*')
      .eq('is_active', true)
      .lt('end_time', now.toISOString());

    if (error) throw error;

    let autoDisabled = 0;

    if (expiredMaintenance && expiredMaintenance.length > 0) {
      // Désactiver les maintenances expirées
      for (const maintenance of expiredMaintenance) {
        await supabase
          .from('maintenance')
          .update({ 
            is_active: false,
            updated_at: new Date()
          })
          .eq('id', maintenance.id);

        // Créer une nouvelle entrée pour la désactivation automatique
        await supabase
          .from('maintenance')
          .insert([{
            is_active: false,
            message: `Maintenance automatiquement désactivée (prévue pour : ${new Date(maintenance.end_time).toLocaleString()})`,
            end_time: now
          }]);

        autoDisabled++;
      }

      // Log d'activité
      await supabase
        .from('activity_logs')
        .insert([{
          user_id: req.user?.id || null,
          action: 'AUTO_DISABLE_EXPIRED_MAINTENANCE',
          details: { 
            disabled_count: autoDisabled,
            maintenance_ids: expiredMaintenance.map(m => m.id)
          }
        }]);
    }

    res.json({
      message: autoDisabled > 0 ? 
        `${autoDisabled} maintenance(s) désactivée(s) automatiquement` : 
        'Aucune maintenance à désactiver',
      auto_disabled: autoDisabled
    });
  } catch (error) {
    console.error('Erreur vérification maintenance expirée:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Statistiques du site
router.get('/stats', async (req, res) => {
  try {
    // Compteurs utilisateurs
    const { count: totalUsers } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    const { count: verifiedUsers } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('is_verified', true);

    const { count: adminUsers } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('role', 'admin');

    // Compteurs bots
    const { count: totalBots } = await supabase
      .from('bots')
      .select('*', { count: 'exact', head: true });

    const { count: approvedBots } = await supabase
      .from('bots')
      .select('*', { count: 'exact', head: true })
      .eq('is_approved', true);

    // Compteurs déploiements
    const { count: totalDeployments } = await supabase
      .from('deployments')
      .select('*', { count: 'exact', head: true });

    const { count: activeDeployments } = await supabase
      .from('deployments')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active');

    // Compteurs coins
    const { data: usersCoins } = await supabase
      .from('users')
      .select('coins');

    const totalCoinsSum = usersCoins?.reduce((sum, user) => sum + (user.coins || 0), 0) || 0;

    // Compteurs comptes Heroku
    const { count: totalHerokuAccounts } = await supabase
      .from('heroku_accounts')
      .select('*', { count: 'exact', head: true });

    const { count: activeHerokuAccounts } = await supabase
      .from('heroku_accounts')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true);

    // Calculer la capacité totale
    const { data: herokuAccounts } = await supabase
      .from('heroku_accounts')
      .select('max_deployments, used_count');

    let totalCapacity = 0;
    let usedCapacity = 0;
    let availableCapacity = 0;

    if (herokuAccounts) {
      herokuAccounts.forEach(account => {
        totalCapacity += account.max_deployments || 0;
        usedCapacity += account.used_count || 0;
      });
      availableCapacity = Math.max(0, totalCapacity - usedCapacity);
    }

    // Activité récente (24h)
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

    const { data: recentActivity } = await supabase
      .from('activity_logs')
      .select(`
        *,
        user:users(email, username)
      `)
      .gte('created_at', twentyFourHoursAgo.toISOString())
      .order('created_at', { ascending: false })
      .limit(15);

    // Nouveaux utilisateurs (7 derniers jours)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const { data: newUsersStats } = await supabase
      .from('users')
      .select('created_at')
      .gte('created_at', sevenDaysAgo.toISOString())
      .order('created_at');

    // Déploiements par jour (7 derniers jours)
    const { data: deploymentStats } = await supabase
      .from('deployments')
      .select('created_at, status')
      .gte('created_at', sevenDaysAgo.toISOString())
      .order('created_at');

    res.json({
      stats: {
        users: {
          total: totalUsers,
          verified: verifiedUsers,
          admins: adminUsers,
          newLast7Days: newUsersStats?.length || 0
        },
        bots: {
          total: totalBots,
          approved: approvedBots
        },
        deployments: {
          total: totalDeployments,
          active: activeDeployments
        },
        coins: {
          total: totalCoinsSum
        },
        heroku: {
          totalAccounts: totalHerokuAccounts,
          activeAccounts: activeHerokuAccounts,
          totalCapacity: totalCapacity,
          usedCapacity: usedCapacity,
          availableCapacity: availableCapacity,
          usagePercentage: totalCapacity > 0 ? Math.round((usedCapacity / totalCapacity) * 100) : 0
        }
      },
      recentActivity: recentActivity || [],
      newUsersStats: newUsersStats || [],
      deploymentStats: deploymentStats || []
    });
  } catch (error) {
    console.error('Erreur récupération statistiques:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Exporter les données
router.get('/export/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const { format = 'json', start_date, end_date } = req.query;

    let data;
    let filename;

    switch (type) {
      case 'users':
        const { data: users } = await supabase
          .from('users')
          .select('*')
          .order('created_at', { ascending: false });

        data = users || [];
        filename = `users_export_${new Date().toISOString().split('T')[0]}`;
        break;

      case 'bots':
        const { data: bots } = await supabase
          .from('bots')
          .select(`
            *,
            user:users(email, username)
          `)
          .order('created_at', { ascending: false });

        data = bots || [];
        filename = `bots_export_${new Date().toISOString().split('T')[0]}`;
        break;

      case 'deployments':
        const { data: deployments } = await supabase
          .from('deployments')
          .select(`
            *,
            user:users(email, username),
            bot:bots(name)
          `)
          .order('created_at', { ascending: false });

        data = deployments || [];
        filename = `deployments_export_${new Date().toISOString().split('T')[0]}`;
        break;

      case 'transactions':
        const { data: transactions } = await supabase
          .from('coin_transactions')
          .select(`
            *,
            sender:users!sender_id(email, username),
            receiver:users!receiver_id(email, username)
          `)
          .order('created_at', { ascending: false });

        data = transactions || [];
        filename = `transactions_export_${new Date().toISOString().split('T')[0]}`;
        break;

      default:
        return res.status(400).json({ error: 'Type d\'export non supporté' });
    }

    // Log d'activité
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: req.user.id,
        action: 'EXPORT_DATA',
        details: { type, format, data_count: data.length }
      }]);

    if (format === 'csv') {
      // Convertir en CSV
      const headers = Object.keys(data[0] || {}).join(',');
      const rows = data.map(item => 
        Object.values(item).map(value => 
          typeof value === 'string' ? `"${value.replace(/"/g, '""')}"` : value
        ).join(',')
      ).join('\n');
      
      const csv = `${headers}\n${rows}`;
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}.csv`);
      return res.send(csv);
    } else {
      // Format JSON par défaut
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}.json`);
      return res.json(data);
    }
  } catch (error) {
    console.error('Erreur export données:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Nettoyer la base de données (supprimer les données anciennes)
router.post('/cleanup', async (req, res) => {
  try {
    const { 
      days = 30,
      keep_logs = true,
      keep_inactive_users = false 
    } = req.body;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    let cleanupStats = {
      deletedUsers: 0,
      deletedBots: 0,
      deletedDeployments: 0,
      deletedLogs: 0
    };

    // Supprimer les utilisateurs inactifs non vérifiés
    if (!keep_inactive_users) {
      const { data: inactiveUsers } = await supabase
        .from('users')
        .select('id')
        .eq('is_verified', false)
        .lt('created_at', cutoffDate.toISOString());

      if (inactiveUsers && inactiveUsers.length > 0) {
        const { error } = await supabase
          .from('users')
          .delete()
          .in('id', inactiveUsers.map(u => u.id));

        if (!error) {
          cleanupStats.deletedUsers = inactiveUsers.length;
        }
      }
    }

    // Supprimer les logs anciens
    if (!keep_logs) {
      const { data: oldLogs } = await supabase
        .from('activity_logs')
        .select('id')
        .lt('created_at', cutoffDate.toISOString());

      if (oldLogs && oldLogs.length > 0) {
        const { error } = await supabase
          .from('activity_logs')
          .delete()
          .in('id', oldLogs.map(l => l.id));

        if (!error) {
          cleanupStats.deletedLogs = oldLogs.length;
        }
      }
    }

    // Log d'activité
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: req.user.id,
        action: 'DATABASE_CLEANUP',
        details: { days, cleanupStats }
      }]);

    res.json({
      message: 'Nettoyage de la base de données terminé',
      stats: cleanupStats
    });
  } catch (error) {
    console.error('Erreur nettoyage base de données:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Gérer les paramètres du site
router.get('/settings', async (req, res) => {
  try {
    // Récupérer les paramètres depuis .env et la base de données
    const settings = {
      app: {
        name: process.env.APP_NAME || 'KermHost',
        url: process.env.APP_URL,
        environment: process.env.NODE_ENV || 'development'
      },
      coins: {
        daily_reward: parseInt(process.env.COIN_DAILY_REWARD) || 10,
        referral_reward: parseInt(process.env.COIN_REFERRAL_REWARD) || 10,
        deployment_cost: 10 // Coût par défaut
      },
      heroku: {
        default_max_deployments: 5,
        max_deployments_per_account: 100
      },
      security: {
        session_duration: '24h',
        verification_expiry: '24h',
        reset_token_expiry: '1h'
      }
    };

    res.json({ settings });
  } catch (error) {
    console.error('Erreur récupération paramètres:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const { coin_rewards, heroku_settings, security_settings } = req.body;

    // Ici, vous pourriez sauvegarder les paramètres dans la base de données
    // Pour l'instant, on retourne simplement les paramètres mis à jour

    // Log d'activité
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: req.user.id,
        action: 'UPDATE_SETTINGS',
        details: { coin_rewards, heroku_settings, security_settings }
      }]);

    res.json({ 
      message: 'Paramètres mis à jour avec succès',
      settings: req.body
    });
  } catch (error) {
    console.error('Erreur mise à jour paramètres:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Routes pour la gestion des comptes Heroku
router.get('/heroku-accounts', async (req, res) => {
    try {
        const { data: accounts, error } = await supabase
            .from('heroku_accounts')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Calculer les statistiques
        let stats = {
            totalAccounts: 0,
            activeAccounts: 0,
            totalApps: 0,
            totalCapacity: 0,
            availableCapacity: 0
        };

        if (accounts) {
            accounts.forEach(account => {
                if (account.is_active) stats.activeAccounts++;
                stats.totalAccounts++;
                stats.totalApps += account.used_count || 0;
                stats.totalCapacity += account.max_deployments || 0;
                stats.availableCapacity += Math.max(0, (account.max_deployments || 0) - (account.used_count || 0));
            });
        }

        res.json({
            accounts: accounts || [],
            stats
        });
    } catch (error) {
        console.error('Erreur récupération comptes Heroku:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// Valider une clé API Heroku
router.post('/validate-heroku-key', async (req, res) => {
    try {
        const { email, api_key } = req.body;

        if (!email || !api_key) {
            return res.status(400).json({ error: 'Email et clé API requis' });
        }

        // Valider la clé API avec Heroku
        const isValid = await HerokuService.validateApiKey(api_key);
        
        if (!isValid) {
            return res.status(400).json({ error: 'Clé API Heroku invalide' });
        }

        // Vérifier si le compte existe déjà
        const { data: existingAccount } = await supabase
            .from('heroku_accounts')
            .select('id')
            .eq('email', email)
            .single();

        if (existingAccount) {
            return res.status(400).json({ error: 'Cet email est déjà utilisé' });
        }

        res.json({
            valid: true,
            message: 'Clé API valide',
            account_info: isValid
        });
    } catch (error) {
        console.error('Erreur validation clé API:', error);
        res.status(400).json({ error: 'Clé API Heroku invalide ou erreur de connexion' });
    }
});

// Ajouter un compte Heroku
router.post('/add-heroku-account', async (req, res) => {
    try {
        const { email, api_key, max_deployments, is_active } = req.body;

        if (!email || !api_key) {
            return res.status(400).json({ error: 'Email et clé API requis' });
        }

        if (!max_deployments || max_deployments < 1 || max_deployments > 100) {
            return res.status(400).json({ error: 'Limite d\'apps doit être entre 1 et 100' });
        }

        // Vérifier si le compte existe déjà
        const { data: existingAccount } = await supabase
            .from('heroku_accounts')
            .select('id')
            .eq('email', email)
            .single();

        if (existingAccount) {
            return res.status(400).json({ error: 'Cet email est déjà utilisé' });
        }

        // Ajouter le compte
        const { data: account, error } = await supabase
            .from('heroku_accounts')
            .insert([{
                email,
                api_key,
                max_deployments: parseInt(max_deployments),
                is_active: is_active !== false,
                used_count: 0
            }])
            .select()
            .single();

        if (error) throw error;

        // Log d'activité
        await supabase
            .from('activity_logs')
            .insert([{
                user_id: req.user.id,
                action: 'ADD_HEROKU_ACCOUNT',
                details: { email, max_deployments, is_active }
            }]);

        res.json({
            message: 'Compte Heroku ajouté avec succès',
            account
        });
    } catch (error) {
        console.error('Erreur ajout compte Heroku:', error);
        res.status(500).json({ error: 'Erreur lors de l\'ajout du compte' });
    }
});

// Récupérer un compte Heroku spécifique
router.get('/heroku-account/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const { data: account, error } = await supabase
            .from('heroku_accounts')
            .select('*')
            .eq('id', id)
            .single();

        if (error) throw error;

        if (!account) {
            return res.status(404).json({ error: 'Compte non trouvé' });
        }

        // Ne pas renvoyer la clé API complète pour des raisons de sécurité
        const { api_key, ...accountWithoutKey } = account;

        res.json({ account: accountWithoutKey });
    } catch (error) {
        console.error('Erreur récupération compte:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// Mettre à jour un compte Heroku
router.put('/update-heroku-account/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { email, api_key, max_deployments, is_active } = req.body;

        // Vérifier que le compte existe
        const { data: existingAccount, error: checkError } = await supabase
            .from('heroku_accounts')
            .select('*')
            .eq('id', id)
            .single();

        if (checkError || !existingAccount) {
            return res.status(404).json({ error: 'Compte non trouvé' });
        }

        // Vérifier les limites
        if (max_deployments && (max_deployments < 1 || max_deployments > 100)) {
            return res.status(400).json({ error: 'Limite d\'apps doit être entre 1 et 100' });
        }

        // Vérifier l'unicité de l'email si modifié
        if (email && email !== existingAccount.email) {
            const { data: duplicateAccount } = await supabase
                .from('heroku_accounts')
                .select('id')
                .eq('email', email)
                .neq('id', id)
                .single();

            if (duplicateAccount) {
                return res.status(400).json({ error: 'Cet email est déjà utilisé' });
            }
        }

        // Préparer les mises à jour
        const updates = {};
        if (email) updates.email = email;
        if (api_key) updates.api_key = api_key;
        if (max_deployments !== undefined) updates.max_deployments = parseInt(max_deployments);
        if (is_active !== undefined) updates.is_active = is_active;

        // Mettre à jour le compte
        const { data: account, error } = await supabase
            .from('heroku_accounts')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        // Log d'activité
        await supabase
            .from('activity_logs')
            .insert([{
                user_id: req.user.id,
                action: 'UPDATE_HEROKU_ACCOUNT',
                details: { account_id: id, updates }
            }]);

        res.json({
            message: 'Compte mis à jour avec succès',
            account
        });
    } catch (error) {
        console.error('Erreur mise à jour compte:', error);
        res.status(500).json({ error: 'Erreur lors de la mise à jour' });
    }
});

// Basculer le statut d'un compte
router.post('/toggle-heroku-account/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { is_active } = req.body;

        // Vérifier que le compte existe
        const { data: existingAccount, error: checkError } = await supabase
            .from('heroku_accounts')
            .select('*')
            .eq('id', id)
            .single();

        if (checkError || !existingAccount) {
            return res.status(404).json({ error: 'Compte non trouvé' });
        }

        // Mettre à jour le statut
        const { data: account, error } = await supabase
            .from('heroku_accounts')
            .update({
                is_active: is_active !== false,
                updated_at: new Date()
            })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        // Log d'activité
        await supabase
            .from('activity_logs')
            .insert([{
                user_id: req.user.id,
                action: 'TOGGLE_HEROKU_ACCOUNT',
                details: { account_id: id, new_status: is_active }
            }]);

        res.json({
            message: `Compte ${is_active ? 'activé' : 'désactivé'} avec succès`,
            account
        });
    } catch (error) {
        console.error('Erreur changement statut compte:', error);
        res.status(500).json({ error: 'Erreur lors du changement de statut' });
    }
});

// Supprimer un compte Heroku
router.delete('/delete-heroku-account/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Vérifier que le compte existe
        const { data: existingAccount, error: checkError } = await supabase
            .from('heroku_accounts')
            .select('*')
            .eq('id', id)
            .single();

        if (checkError || !existingAccount) {
            return res.status(404).json({ error: 'Compte non trouvé' });
        }

        // Vérifier si le compte est utilisé
        const { data: activeDeployments } = await supabase
            .from('deployments')
            .select('id')
            .eq('heroku_account_id', id)
            .eq('status', 'active')
            .limit(1);

        if (activeDeployments && activeDeployments.length > 0) {
            return res.status(400).json({ 
                error: 'Impossible de supprimer : des déploiements actifs utilisent ce compte' 
            });
        }

        // Supprimer le compte
        const { error } = await supabase
            .from('heroku_accounts')
            .delete()
            .eq('id', id);

        if (error) throw error;

        // Log d'activité
        await supabase
            .from('activity_logs')
            .insert([{
                user_id: req.user.id,
                action: 'DELETE_HEROKU_ACCOUNT',
                details: { account_email: existingAccount.email }
            }]);

        res.json({ message: 'Compte supprimé avec succès' });
    } catch (error) {
        console.error('Erreur suppression compte:', error);
        res.status(500).json({ error: 'Erreur lors de la suppression' });
    }
});

// Récupérer le compte Heroku le plus approprié pour un nouveau déploiement
router.get('/get-available-heroku-account', async (req, res) => {
    try {
        const { data: accounts, error } = await supabase
            .from('heroku_accounts')
            .select('*')
            .eq('is_active', true)
            .order('used_count', { ascending: true });

        if (error) throw error;

        // Trouver le premier compte avec de la capacité disponible
        const availableAccount = accounts.find(account => 
            (account.used_count || 0) < (account.max_deployments || 0)
        );

        if (!availableAccount) {
            return res.status(503).json({ 
                error: 'Aucun compte Heroku disponible. Ajoutez plus de comptes ou augmentez les limites.' 
            });
        }

        res.json({ account: availableAccount });
    } catch (error) {
        console.error('Erreur récupération compte disponible:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// Mettre à jour le compteur d'utilisation d'un compte
router.post('/update-heroku-usage/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { increment } = req.body;

        const { data: account, error } = await supabase
            .from('heroku_accounts')
            .select('used_count')
            .eq('id', id)
            .single();

        if (error) throw error;

        const newCount = Math.max(0, (account.used_count || 0) + (increment ? 1 : -1));

        await supabase
            .from('heroku_accounts')
            .update({ used_count: newCount })
            .eq('id', id);

        res.json({ success: true, newCount });
    } catch (error) {
        console.error('Erreur mise à jour utilisation:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// Dashboard admin avec données détaillées
router.get('/dashboard', async (req, res) => {
  try {
    // Récupérer les statistiques complètes
    const [usersStats, botsStats, deploymentStats, herokuStats, recentActivity] = await Promise.all([
      // Statistiques utilisateurs
      supabase
        .from('users')
        .select('created_at, is_verified, role', { count: 'exact' }),
      
      // Statistiques bots
      supabase
        .from('bots')
        .select('created_at, is_approved', { count: 'exact' }),
      
      // Statistiques déploiements
      supabase
        .from('deployments')
        .select('created_at, status', { count: 'exact' }),
      
      // Statistiques Heroku
      supabase
        .from('heroku_accounts')
        .select('max_deployments, used_count, is_active'),
      
      // Activité récente
      supabase
        .from('activity_logs')
        .select(`
          *,
          user:users(email, username)
        `)
        .order('created_at', { ascending: false })
        .limit(10)
    ]);

    // Traiter les données
    const dashboardData = {
      users: {
        total: usersStats.count || 0,
        verified: usersStats.data?.filter(u => u.is_verified).length || 0,
        admins: usersStats.data?.filter(u => u.role === 'admin').length || 0,
        newToday: usersStats.data?.filter(u => {
          const created = new Date(u.created_at);
          const today = new Date();
          return created.toDateString() === today.toDateString();
        }).length || 0
      },
      bots: {
        total: botsStats.count || 0,
        approved: botsStats.data?.filter(b => b.is_approved).length || 0,
        pending: botsStats.data?.filter(b => !b.is_approved).length || 0
      },
      deployments: {
        total: deploymentStats.count || 0,
        active: deploymentStats.data?.filter(d => d.status === 'active').length || 0,
        pending: deploymentStats.data?.filter(d => d.status === 'pending').length || 0,
        failed: deploymentStats.data?.filter(d => d.status === 'failed').length || 0
      },
      heroku: {
        totalAccounts: herokuStats.data?.length || 0,
        activeAccounts: herokuStats.data?.filter(h => h.is_active).length || 0,
        totalCapacity: herokuStats.data?.reduce((sum, h) => sum + (h.max_deployments || 0), 0) || 0,
        usedCapacity: herokuStats.data?.reduce((sum, h) => sum + (h.used_count || 0), 0) || 0,
        availableCapacity: herokuStats.data?.reduce((sum, h) => sum + Math.max(0, (h.max_deployments || 0) - (h.used_count || 0)), 0) || 0
      },
      recentActivity: recentActivity.data || []
    };

    res.json(dashboardData);
  } catch (error) {
    console.error('Erreur dashboard admin:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Routes pour la gestion de la base de données

// Récupérer les statistiques de la base de données
router.get('/database/stats', async (req, res) => {
  try {
    // Récupérer les informations sur les tables
    const { data: tables, error } = await supabase
      .from('information_schema.tables')
      .select('table_name')
      .eq('table_schema', 'public');

    if (error) throw error;

    // Compter les lignes dans chaque table principale
    const tablesData = [];
    
    // Tables principales à surveiller
    const mainTables = ['users', 'bots', 'deployments', 'coin_transactions', 'heroku_accounts', 'activity_logs'];
    
    for (const tableName of mainTables) {
      try {
        const { count, error: countError } = await supabase
          .from(tableName)
          .select('*', { count: 'exact', head: true });

        if (!countError) {
          tablesData.push({
            name: tableName,
            row_count: count || 0
          });
        }
      } catch (tableError) {
        console.error(`Erreur table ${tableName}:`, tableError);
      }
    }

    // Récupérer les informations de taille (nécessite des privilèges admin)
    let totalSize = 0;
    try {
      const { data: sizeData, error: sizeError } = await supabase
        .rpc('get_database_size');

      if (!sizeError && sizeData) {
        totalSize = sizeData.total_size || 0;
      }
    } catch (sizeError) {
      console.error('Erreur taille base de données:', sizeError);
    }

    // Récupérer le schéma des tables
    const tablesWithSchema = await Promise.all(
      tablesData.map(async (table) => {
        try {
          const { data: columns, error: columnsError } = await supabase
            .from('information_schema.columns')
            .select('column_name, data_type, is_nullable')
            .eq('table_name', table.name)
            .eq('table_schema', 'public');

          return {
            ...table,
            columns: columnsError ? [] : (columns || []).map(col => ({
              name: col.column_name,
              type: col.data_type,
              nullable: col.is_nullable === 'YES'
            }))
          };
        } catch (error) {
          return table;
        }
      })
    );

    res.json({
      stats: {
        totalTables: tables?.length || 0,
        totalSize: totalSize,
        userCount: tablesData.find(t => t.name === 'users')?.row_count || 0,
        botCount: tablesData.find(t => t.name === 'bots')?.row_count || 0,
        deploymentCount: tablesData.find(t => t.name === 'deployments')?.row_count || 0
      },
      tables: tablesWithSchema
    });
  } catch (error) {
    console.error('Erreur récupération stats DB:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Exécuter une requête SQL
router.post('/database/query', async (req, res) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Requête SQL requise' });
    }

    // Vérifier les requêtes dangereuses (optionnel - pour la sécurité)
    const dangerousPatterns = [
      /DROP\s+DATABASE/i,
      /DROP\s+TABLE/i,
      /DELETE\s+FROM/i,
      /TRUNCATE\s+TABLE/i
    ];

    const isDangerous = dangerousPatterns.some(pattern => pattern.test(query));
    
    if (isDangerous) {
      return res.status(400).json({ error: 'Requête SQL dangereuse détectée' });
    }

    // Exécuter la requête
    const startTime = Date.now();
    const { data, error } = await supabase.rpc('execute_sql', { sql_query: query });
    const executionTime = Date.now() - startTime;

    if (error) {
      console.error('Erreur exécution SQL:', error);
      return res.status(400).json({ error: error.message });
    }

    // Journaliser l'activité
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: req.user.id,
        action: 'EXECUTE_SQL_QUERY',
        details: { 
          query: query.substring(0, 200), // Limiter la taille
          execution_time: executionTime,
          result_count: data?.length || 0
        }
      }]);

    res.json({
      results: data || [],
      executionTime,
      message: data ? `Requête exécutée avec succès (${data.length} résultats)` : 'Requête exécutée avec succès'
    });
  } catch (error) {
    console.error('Erreur requête SQL:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Prévisualiser une table
router.get('/database/tables/:tableName/preview', async (req, res) => {
  try {
    const { tableName } = req.params;

    // Vérifier que la table existe
    const { data: tableExists } = await supabase
      .from('information_schema.tables')
      .select('table_name')
      .eq('table_name', tableName)
      .eq('table_schema', 'public')
      .single();

    if (!tableExists) {
      return res.status(404).json({ error: 'Table non trouvée' });
    }

    // Récupérer les premières lignes
    const { data, error } = await supabase
      .from(tableName)
      .select('*')
      .limit(50);

    if (error) throw error;

    res.json({ 
      table: tableName,
      data: data || [],
      count: data?.length || 0
    });
  } catch (error) {
    console.error('Erreur prévisualisation table:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Exporter une table
router.get('/database/tables/:tableName/export', async (req, res) => {
  try {
    const { tableName } = req.params;

    // Récupérer toutes les données de la table
    const { data, error } = await supabase
      .from(tableName)
      .select('*');

    if (error) throw error;

    // Journaliser l'export
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: req.user.id,
        action: 'EXPORT_TABLE',
        details: { table_name: tableName, row_count: data?.length || 0 }
      }]);

    // Retourner les données en JSON
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${tableName}_${new Date().toISOString().split('T')[0]}.json"`);
    res.json(data || []);
  } catch (error) {
    console.error('Erreur export table:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Vider une table
router.post('/database/tables/:tableName/truncate', async (req, res) => {
  try {
    const { tableName } = req.params;

    // Vérifier que ce n'est pas une table critique
    const criticalTables = ['users', 'bots', 'heroku_accounts'];
    if (criticalTables.includes(tableName)) {
      return res.status(400).json({ error: 'Cette table ne peut pas être vidée' });
    }

    // Compter les lignes avant suppression
    const { count: beforeCount } = await supabase
      .from(tableName)
      .select('*', { count: 'exact', head: true });

    // Vider la table (en utilisant DELETE car TRUNCATE n'est pas disponible via l'API)
    const { error } = await supabase
      .from(tableName)
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000'); // Toujours vrai pour tout supprimer

    if (error) throw error;

    // Journaliser l'action
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: req.user.id,
        action: 'TRUNCATE_TABLE',
        details: { table_name: tableName, rows_deleted: beforeCount || 0 }
      }]);

    res.json({ 
      message: `Table ${tableName} vidée avec succès`,
      rowsDeleted: beforeCount || 0
    });
  } catch (error) {
    console.error('Erreur vidage table:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Créer une sauvegarde
router.get('/database/backup', async (req, res) => {
  try {
    // Récupérer toutes les données de toutes les tables
    const tables = ['users', 'bots', 'deployments', 'coin_transactions', 'heroku_accounts', 'activity_logs', 'referrals', 'maintenance'];
    
    let backupData = {};
    
    for (const table of tables) {
      try {
        const { data, error } = await supabase
          .from(table)
          .select('*');

        if (!error && data) {
          backupData[table] = data;
        }
      } catch (tableError) {
        console.error(`Erreur table ${table}:`, tableError);
      }
    }

    // Ajouter des métadonnées
    const metadata = {
      backup_date: new Date().toISOString(),
      app_name: 'KermHost',
      version: '1.0.0',
      tables_backed_up: Object.keys(backupData)
    };

    backupData.metadata = metadata;

    // Journaliser la sauvegarde
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: req.user.id,
        action: 'CREATE_DATABASE_BACKUP',
        details: { tables_backed_up: Object.keys(backupData).length - 1 } // -1 pour metadata
      }]);

    // Retourner le fichier de sauvegarde
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="kermhost_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json"`);
    res.json(backupData);
  } catch (error) {
    console.error('Erreur sauvegarde:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Restaurer une sauvegarde
router.post('/database/restore', async (req, res) => {
  try {
    const backupFile = req.files?.backup;
    
    if (!backupFile) {
      return res.status(400).json({ error: 'Fichier de sauvegarde requis' });
    }

    // Parser le fichier JSON
    const backupData = JSON.parse(backupFile.data.toString('utf8'));
    
    if (!backupData.metadata || !backupData.metadata.app_name === 'KermHost') {
      return res.status(400).json({ error: 'Fichier de sauvegarde invalide' });
    }

    const { backup_before = true, drop_tables = false } = req.body;

    // Sauvegarder avant restauration si demandé
    if (backup_before) {
      // Ici vous pourriez créer une sauvegarde automatique
      console.log('Sauvegarde avant restauration demandée');
    }

    let restoreStats = {};

    // Restaurer chaque table
    for (const [tableName, data] of Object.entries(backupData)) {
      if (tableName === 'metadata') continue;

      try {
        // Supprimer les données existantes si demandé
        if (drop_tables) {
          const { error: deleteError } = await supabase
            .from(tableName)
            .delete()
            .neq('id', '00000000-0000-0000-0000-000000000000');

          if (deleteError) {
            console.error(`Erreur suppression table ${tableName}:`, deleteError);
            continue;
          }
        }

        // Insérer les nouvelles données par lots (pour éviter les limites)
        const batchSize = 100;
        for (let i = 0; i < data.length; i += batchSize) {
          const batch = data.slice(i, i + batchSize);
          const { error: insertError } = await supabase
            .from(tableName)
            .insert(batch);

          if (insertError) {
            console.error(`Erreur insertion batch table ${tableName}:`, insertError);
          }
        }

        restoreStats[tableName] = data.length;
      } catch (tableError) {
        console.error(`Erreur restauration table ${tableName}:`, tableError);
      }
    }

    // Journaliser la restauration
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: req.user.id,
        action: 'RESTORE_DATABASE_BACKUP',
        details: { restore_stats: restoreStats }
      }]);

    res.json({
      message: 'Base de données restaurée avec succès',
      stats: restoreStats
    });
  } catch (error) {
    console.error('Erreur restauration:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Estimer le nettoyage
router.get('/database/cleanup/estimate', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - parseInt(days));

    const stats = {};

    // Estimer les utilisateurs non vérifiés
    const { count: inactiveUsers } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('is_verified', false)
      .lt('created_at', cutoffDate.toISOString());

    stats.users = inactiveUsers || 0;

    // Estimer les logs anciens
    const { count: oldLogs } = await supabase
      .from('activity_logs')
      .select('*', { count: 'exact', head: true })
      .lt('created_at', cutoffDate.toISOString());

    stats.logs = oldLogs || 0;

    // Estimer les déploiements échoués
    const { count: failedDeployments } = await supabase
      .from('deployments')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'failed')
      .lt('created_at', cutoffDate.toISOString());

    stats.deployments = failedDeployments || 0;

    res.json(stats);
  } catch (error) {
    console.error('Erreur estimation nettoyage:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Nettoyer la base de données
router.post('/database/cleanup', async (req, res) => {
  try {
    const { 
      days = 30,
      cleanup_users = false,
      cleanup_logs = false,
      cleanup_deployments = false,
      keep_backup = true 
    } = req.body;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - parseInt(days));

    let cleanupStats = {
      usersDeleted: 0,
      logsDeleted: 0,
      deploymentsDeleted: 0
    };

    // Sauvegarder avant nettoyage si demandé
    if (keep_backup) {
      // Ici vous pourriez créer une sauvegarde automatique
      console.log('Sauvegarde avant nettoyage demandée');
    }

    // Nettoyer les utilisateurs non vérifiés
    if (cleanup_users) {
      const { data: usersToDelete } = await supabase
        .from('users')
        .select('id')
        .eq('is_verified', false)
        .lt('created_at', cutoffDate.toISOString());

      if (usersToDelete && usersToDelete.length > 0) {
        const { error } = await supabase
          .from('users')
          .delete()
          .in('id', usersToDelete.map(u => u.id));

        if (!error) {
          cleanupStats.usersDeleted = usersToDelete.length;
        }
      }
    }

    // Nettoyer les logs
    if (cleanup_logs) {
      const { data: logsToDelete } = await supabase
        .from('activity_logs')
        .select('id')
        .lt('created_at', cutoffDate.toISOString());

      if (logsToDelete && logsToDelete.length > 0) {
        const { error } = await supabase
          .from('activity_logs')
          .delete()
          .in('id', logsToDelete.map(l => l.id));

        if (!error) {
          cleanupStats.logsDeleted = logsToDelete.length;
        }
      }
    }

    // Nettoyer les déploiements échoués
    if (cleanup_deployments) {
      const { data: deploymentsToDelete } = await supabase
        .from('deployments')
        .select('id')
        .eq('status', 'failed')
        .lt('created_at', cutoffDate.toISOString());

      if (deploymentsToDelete && deploymentsToDelete.length > 0) {
        const { error } = await supabase
          .from('deployments')
          .delete()
          .in('id', deploymentsToDelete.map(d => d.id));

        if (!error) {
          cleanupStats.deploymentsDeleted = deploymentsToDelete.length;
        }
      }
    }

    // Journaliser le nettoyage
    await supabase
      .from('activity_logs')
      .insert([{
        user_id: req.user.id,
        action: 'DATABASE_CLEANUP',
        details: { days, cleanup_stats: cleanupStats }
      }]);

    res.json({
      message: 'Nettoyage terminé avec succès',
      stats: cleanupStats
    });
  } catch (error) {
    console.error('Erreur nettoyage:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
