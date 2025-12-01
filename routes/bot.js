const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const supabase = require('../utils/database');
const axios = require('axios');

// Route pour soumettre une demande de bot
router.post('/submit-request', authMiddleware, async (req, res) => {
  try {
    const { github_repo, cost } = req.body;
    const userId = req.user.id;

    // Valider le format du repo GitHub
    const repoRegex = /^[a-zA-Z0-9-_]+\/[a-zA-Z0-9-_]+$/;
    if (!repoRegex.test(github_repo)) {
      return res.status(400).json({ 
        error: 'Format invalide. Utilisez : username/repository' 
      });
    }

    // Valider le coût
    const parsedCost = parseInt(cost);
    if (isNaN(parsedCost) || parsedCost < 1) {
      return res.status(400).json({ 
        error: 'Le coût doit être un nombre positif' 
      });
    }

    // Vérifier si le repo existe et contient un fichier kerm.json
    try {
      const kermJsonUrl = `https://raw.githubusercontent.com/${github_repo}/main/kerm.json`;
      const response = await axios.get(kermJsonUrl);
      
      if (response.status !== 200) {
        return res.status(400).json({ 
          error: 'Fichier kerm.json introuvable dans le repository' 
        });
      }

      const kermJson = response.data;

      // Valider la structure du fichier kerm.json
      if (!kermJson['bot-name'] || !kermJson.description || !kermJson.env) {
        return res.status(400).json({ 
          error: 'Fichier kerm.json invalide. Vérifiez la structure.' 
        });
      }

      // Vérifier si le bot existe déjà
      const { data: existingBot } = await supabase
        .from('bots')
        .select('id')
        .eq('github_repo', github_repo)
        .single();

      if (existingBot) {
        return res.status(400).json({ 
          error: 'Ce bot a déjà été soumis' 
        });
      }

      // Créer la demande de bot
      const { data: bot, error } = await supabase
        .from('bots')
        .insert([{
          name: kermJson['bot-name'],
          description: kermJson.description,
          github_repo,
          owner_id: userId,
          owner_email: req.user.email,
          logo_url: kermJson.logo || null,
          documentation_url: kermJson['documentation-link'] || null,
          kerm_json: kermJson,
          cost: parsedCost,
          is_approved: false,
          is_active: true
        }])
        .select()
        .single();

      if (error) throw error;

      // Log d'activité
      await supabase
        .from('activity_logs')
        .insert([{
          user_id: userId,
          action: 'SUBMIT_BOT_REQUEST',
          details: { 
            bot_id: bot.id, 
            bot_name: bot.name,
            github_repo 
          }
        }]);

      res.json({
        message: 'Demande de bot soumise avec succès. En attente d\'approbation.',
        bot
      });

    } catch (error) {
      if (error.response && error.response.status === 404) {
        return res.status(400).json({ 
          error: 'Fichier kerm.json introuvable. Assurez-vous qu\'il existe dans le répertoire principal.' 
        });
      }
      throw error;
    }
  } catch (error) {
    console.error('Erreur soumission bot:', error);
    res.status(500).json({ error: 'Erreur lors de la soumission du bot' });
  }
});

// Récupérer les bots disponibles pour déploiement
router.get('/available', authMiddleware, async (req, res) => {
  try {
    const { data: bots, error } = await supabase
      .from('bots')
      .select(`
        *,
        owner:users(email)
      `)
      .eq('is_approved', true)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ bots: bots || [] });
  } catch (error) {
    console.error('Erreur récupération bots:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer les bots d'un utilisateur
router.get('/my-bots', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: bots, error } = await supabase
      .from('bots')
      .select(`
        *,
        deployments:deployments(count)
      `)
      .eq('owner_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Compter les déploiements pour chaque bot
    const botsWithStats = await Promise.all(
      (bots || []).map(async (bot) => {
        const { count: deploymentCount } = await supabase
          .from('deployments')
          .select('*', { count: 'exact', head: true })
          .eq('bot_id', bot.id);

        const { count: activeDeployments } = await supabase
          .from('deployments')
          .select('*', { count: 'exact', head: true })
          .eq('bot_id', bot.id)
          .eq('status', 'active');

        return {
          ...bot,
          stats: {
            total_deployments: deploymentCount || 0,
            active_deployments: activeDeployments || 0,
            total_coins_earned: (deploymentCount || 0) * (bot.cost || 0)
          }
        };
      })
    );

    res.json({ bots: botsWithStats });
  } catch (error) {
    console.error('Erreur récupération bots utilisateur:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer un bot spécifique
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: bot, error } = await supabase
      .from('bots')
      .select(`
        *,
        owner:users(email, username),
        deployments:deployments(count)
      `)
      .eq('id', id)
      .single();

    if (error) throw error;

    if (!bot) {
      return res.status(404).json({ error: 'Bot non trouvé' });
    }

    // Vérifier que l'utilisateur est le propriétaire ou que le bot est approuvé
    if (bot.owner_id !== req.user.id && !bot.is_approved) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    res.json({ bot });
  } catch (error) {
    console.error('Erreur récupération bot:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Mettre à jour un bot
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { cost, is_active } = req.body;

    // Vérifier que le bot existe et que l'utilisateur est le propriétaire
    const { data: existingBot, error: checkError } = await supabase
      .from('bots')
      .select('*')
      .eq('id', id)
      .eq('owner_id', req.user.id)
      .single();

    if (checkError || !existingBot) {
      return res.status(404).json({ error: 'Bot non trouvé ou accès non autorisé' });
    }

    // Préparer les mises à jour
    const updates = {};
    if (cost !== undefined) updates.cost = parseInt(cost);
    if (is_active !== undefined) updates.is_active = is_active;

    // Si le bot est approuvé, réinitialiser l'approbation en cas de modification
    if (Object.keys(updates).length > 0 && existingBot.is_approved) {
      updates.is_approved = false;
    }

    // Mettre à jour le bot
    const { data: bot, error } = await supabase
      .from('bots')
      .update({
        ...updates,
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
        action: 'UPDATE_BOT',
        details: { bot_id: id, updates }
      }]);

    res.json({ 
      message: 'Bot mis à jour avec succès',
      bot 
    });
  } catch (error) {
    console.error('Erreur mise à jour bot:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Supprimer un bot
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // Vérifier que le bot existe et que l'utilisateur est le propriétaire
    const { data: existingBot, error: checkError } = await supabase
      .from('bots')
      .select('*')
      .eq('id', id)
      .eq('owner_id', req.user.id)
      .single();

    if (checkError || !existingBot) {
      return res.status(404).json({ error: 'Bot non trouvé ou accès non autorisé' });
    }

    // Vérifier si le bot a des déploiements actifs
    const { data: activeDeployments } = await supabase
      .from('deployments')
      .select('id')
      .eq('bot_id', id)
      .eq('status', 'active')
      .limit(1);

    if (activeDeployments && activeDeployments.length > 0) {
      return res.status(400).json({ 
        error: 'Impossible de supprimer : des déploiements actifs utilisent ce bot' 
      });
    }

    // Supprimer le bot
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
        action: 'DELETE_BOT',
        details: { bot_id: id, bot_name: existingBot.name }
      }]);

    res.json({ message: 'Bot supprimé avec succès' });
  } catch (error) {
    console.error('Erreur suppression bot:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Synchroniser le fichier kerm.json d'un bot
router.post('/:id/sync', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // Vérifier que le bot existe et que l'utilisateur est le propriétaire
    const { data: existingBot, error: checkError } = await supabase
      .from('bots')
      .select('*')
      .eq('id', id)
      .eq('owner_id', req.user.id)
      .single();

    if (checkError || !existingBot) {
      return res.status(404).json({ error: 'Bot non trouvé ou accès non autorisé' });
    }

    // Récupérer le nouveau fichier kerm.json
    try {
      const kermJsonUrl = `https://raw.githubusercontent.com/${existingBot.github_repo}/main/kerm.json`;
      const response = await axios.get(kermJsonUrl);
      
      if (response.status !== 200) {
        return res.status(400).json({ 
          error: 'Fichier kerm.json introuvable' 
        });
      }

      const kermJson = response.data;

      // Valider la structure
      if (!kermJson['bot-name'] || !kermJson.description || !kermJson.env) {
        return res.status(400).json({ 
          error: 'Fichier kerm.json invalide' 
        });
      }

      // Mettre à jour le bot
      const { data: bot, error } = await supabase
        .from('bots')
        .update({
          name: kermJson['bot-name'],
          description: kermJson.description,
          logo_url: kermJson.logo || null,
          documentation_url: kermJson['documentation-link'] || null,
          kerm_json: kermJson,
          is_approved: false, // Réinitialiser l'approbation
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
          action: 'SYNC_BOT_CONFIG',
          details: { bot_id: id, bot_name: bot.name }
        }]);

      res.json({ 
        message: 'Configuration du bot synchronisée avec succès',
        bot 
      });

    } catch (error) {
      if (error.response && error.response.status === 404) {
        return res.status(400).json({ 
          error: 'Fichier kerm.json introuvable' 
        });
      }
      throw error;
    }
  } catch (error) {
    console.error('Erreur synchronisation bot:', error);
    res.status(500).json({ error: 'Erreur lors de la synchronisation' });
  }
});

// Vérifier si un repo GitHub contient un fichier kerm.json
router.post('/check-repo', authMiddleware, async (req, res) => {
  try {
    const { github_repo } = req.body;

    if (!github_repo) {
      return res.status(400).json({ error: 'Repository GitHub requis' });
    }

    // Valider le format
    const repoRegex = /^[a-zA-Z0-9-_]+\/[a-zA-Z0-9-_]+$/;
    if (!repoRegex.test(github_repo)) {
      return res.status(400).json({ 
        error: 'Format invalide. Utilisez : username/repository' 
      });
    }

    try {
      // Essayer de récupérer le fichier kerm.json
      const kermJsonUrl = `https://raw.githubusercontent.com/${github_repo}/main/kerm.json`;
      const response = await axios.get(kermJsonUrl);
      
      if (response.status === 200) {
        const kermJson = response.data;
        
        // Valider la structure de base
        if (!kermJson['bot-name'] || !kermJson.description || !kermJson.env) {
          return res.json({
            valid: false,
            error: 'Structure kerm.json invalide. Vérifiez les champs requis.'
          });
        }

        return res.json({
          valid: true,
          kerm_json: kermJson,
          message: 'Repository valide avec fichier kerm.json correct'
        });
      }
    } catch (error) {
      if (error.response && error.response.status === 404) {
        return res.json({
          valid: false,
          error: 'Fichier kerm.json introuvable. Assurez-vous qu\'il existe dans le répertoire principal.'
        });
      }
      throw error;
    }

  } catch (error) {
    console.error('Erreur vérification repo:', error);
    res.status(500).json({ error: 'Erreur lors de la vérification du repository' });
  }
});

module.exports = router;