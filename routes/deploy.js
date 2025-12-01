const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const supabase = require('../utils/database');
const HerokuService = require('../utils/heroku');

router.use(authMiddleware);

// Obtenir un compte Heroku disponible pour le déploiement
async function getAvailableHerokuAccount() {
    try {
        // Chercher d'abord les comptes avec le moins d'utilisation
        const { data: accounts, error } = await supabase
            .from('heroku_accounts')
            .select('*')
            .eq('is_active', true)
            .order('used_count', { ascending: true });

        if (error) throw error;

        if (!accounts || accounts.length === 0) {
            throw new Error('Aucun compte Heroku disponible');
        }

        // Trouver le premier compte avec de la capacité
        for (const account of accounts) {
            const currentUsage = account.used_count || 0;
            const maxDeployments = account.max_deployments || 5;
            
            if (currentUsage < maxDeployments) {
                return account;
            }
        }

        // Si tous les comptes sont pleins, utiliser celui avec le plus de capacité
        const sortedByCapacity = accounts.sort((a, b) => {
            const capacityA = (a.max_deployments || 0) - (a.used_count || 0);
            const capacityB = (b.max_deployments || 0) - (b.used_count || 0);
            return capacityB - capacityA;
        });

        return sortedByCapacity[0];
    } catch (error) {
        console.error('Erreur récupération compte Heroku:', error);
        throw error;
    }
}

// Mettre à jour le compteur d'utilisation d'un compte
async function updateHerokuUsage(accountId, increment = true) {
    try {
        const { data: account } = await supabase
            .from('heroku_accounts')
            .select('used_count')
            .eq('id', accountId)
            .single();

        if (!account) return;

        const newCount = increment ? 
            (account.used_count || 0) + 1 : 
            Math.max(0, (account.used_count || 0) - 1);

        await supabase
            .from('heroku_accounts')
            .update({ used_count: newCount })
            .eq('id', accountId);
    } catch (error) {
        console.error('Erreur mise à jour utilisation Heroku:', error);
    }
}

// Déployer un bot
router.post('/deploy', async (req, res) => {
    try {
        const { botId, cost } = req.body;
        const userId = req.user.id;

        // Vérifier que l'utilisateur a assez de coins
        if (req.user.coins < cost) {
            return res.status(400).json({ error: 'Coins insuffisants' });
        }

        // Récupérer les informations du bot
        const { data: bot, error: botError } = await supabase
            .from('bots')
            .select('*')
            .eq('id', botId)
            .eq('is_approved', true)
            .single();

        if (botError || !bot) {
            return res.status(404).json({ error: 'Bot non trouvé ou non approuvé' });
        }

        // Obtenir un compte Heroku disponible
        const herokuAccount = await getAvailableHerokuAccount();
        if (!herokuAccount) {
            return res.status(503).json({ 
                error: 'Aucun serveur disponible. Contactez l\'administrateur.' 
            });
        }

        // Vérifier la capacité du compte
        if ((herokuAccount.used_count || 0) >= (herokuAccount.max_deployments || 5)) {
            return res.status(503).json({ 
                error: 'Capacité maximale atteinte sur ce serveur. Réessayez plus tard.' 
            });
        }

        // Initialiser le service Heroku
        const heroku = new HerokuService(herokuAccount.api_key);

        // Générer un nom d'app unique
        const appName = `kermhost-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Créer le déploiement en base de données
        const { data: deployment, error: deployError } = await supabase
            .from('deployments')
            .insert([{
                user_id: userId,
                bot_id: botId,
                status: 'pending',
                cost: cost,
                heroku_account_id: herokuAccount.id,
                env_variables: bot.kerm_json?.env ? {} : null,
                logs: 'Démarrage du déploiement...\n'
            }])
            .select(`
                *,
                bot:bots(*)
            `)
            .single();

        if (deployError) throw deployError;

        // Mettre à jour les coins de l'utilisateur
        await supabase
            .from('users')
            .update({ coins: req.user.coins - cost })
            .eq('id', userId);

        // Mettre à jour l'utilisation du compte Heroku
        await updateHerokuUsage(herokuAccount.id, true);

        // Journaliser la transaction de coins
        await supabase
            .from('coin_transactions')
            .insert([{
                sender_id: userId,
                receiver_id: null,
                amount: cost,
                type: 'deployment',
                description: `Déploiement de ${bot.name}`
            }]);

        // Démarrer le déploiement en arrière-plan
        deployToHeroku(deployment.id, appName, heroku, bot, herokuAccount);

        res.json({
            message: 'Déploiement démarré avec succès',
            deploymentId: deployment.id,
            appName: appName
        });
    } catch (error) {
        console.error('Erreur déploiement:', error);
        res.status(500).json({ error: 'Erreur lors du déploiement' });
    }
});

// Fonction de déploiement asynchrone
async function deployToHeroku(deploymentId, appName, heroku, bot, herokuAccount) {
    try {
        // Mettre à jour les logs
        await supabase
            .from('deployments')
            .update({ 
                logs: 'Création de l\'application Heroku...\n',
                heroku_app_name: appName
            })
            .eq('id', deploymentId);

        // 1. Créer l'application Heroku
        const app = await heroku.createApp(appName, 'eu');
        
        await supabase
            .from('deployments')
            .update({ 
                logs: 'Application créée. Déploiement depuis GitHub...\n',
                heroku_app_id: app.id
            })
            .eq('id', deploymentId);

        // 2. Déployer depuis GitHub
        const githubUrl = `https://github.com/${bot.github_repo}.git`;
        await heroku.deployFromGithub(appName, githubUrl);

        await supabase
            .from('deployments')
            .update({ 
                logs: 'Déploiement réussi. Configuration des variables d\'environnement...\n',
                status: 'configuring'
            })
            .eq('id', deploymentId);

        // 3. Configurer les variables d'environnement par défaut
        if (bot.kerm_json?.env) {
            const defaultEnvVars = {};
            Object.entries(bot.kerm_json.env).forEach(([key, config]) => {
                if (config.value) {
                    defaultEnvVars[key] = config.value;
                }
            });

            if (Object.keys(defaultEnvVars).length > 0) {
                await heroku.setConfigVars(appName, defaultEnvVars);
                
                // Enregistrer les variables par défaut
                await supabase
                    .from('deployments')
                    .update({ 
                        env_variables: defaultEnvVars,
                        logs: 'Variables d\'environnement configurées. Lancement de l\'application...\n'
                    })
                    .eq('id', deploymentId);
            }
        }

        // 4. Marquer comme actif
        await supabase
            .from('deployments')
            .update({ 
                status: 'active',
                logs: '✅ Déploiement terminé avec succès !\nL\'application est maintenant en ligne.',
                updated_at: new Date()
            })
            .eq('id', deploymentId);

        // Notifier l'utilisateur (email ou notification push)
        console.log(`Déploiement ${deploymentId} terminé avec succès`);

    } catch (error) {
        console.error('Erreur déploiement Heroku:', error);

        // Mettre à jour le statut en erreur
        await supabase
            .from('deployments')
            .update({ 
                status: 'failed',
                logs: `❌ Erreur lors du déploiement:\n${error.message}\n\nContactez l'administrateur.`
            })
            .eq('id', deploymentId);

        // Restituer les coins en cas d'échec
        const { data: deployment } = await supabase
            .from('deployments')
            .select('user_id, cost')
            .eq('id', deploymentId)
            .single();

        if (deployment) {
            await supabase.rpc('increment_coins', {
                user_id: deployment.user_id,
                amount: deployment.cost
            });
        }

        // Décrémenter l'utilisation du compte Heroku
        await updateHerokuUsage(herokuAccount.id, false);
    }
}

// Récupérer les déploiements d'un utilisateur
router.get('/user-deployments', async (req, res) => {
    try {
        const userId = req.user.id;

        const { data: deployments, error } = await supabase
            .from('deployments')
            .select(`
                *,
                bot:bots(*)
            `)
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Compter les environnements pour chaque bot
        const deploymentsWithEnvCount = deployments.map(deployment => {
            const envCount = deployment.bot?.kerm_json?.env ? 
                Object.keys(deployment.bot.kerm_json.env).length : 0;
            return {
                ...deployment,
                env_count: envCount
            };
        });

        res.json({ deployments: deploymentsWithEnvCount || [] });
    } catch (error) {
        console.error('Erreur récupération déploiements:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// Récupérer un déploiement spécifique
router.get('/deployment/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const { data: deployment, error } = await supabase
            .from('deployments')
            .select(`
                *,
                bot:bots(*)
            `)
            .eq('id', id)
            .eq('user_id', userId)
            .single();

        if (error) throw error;

        if (!deployment) {
            return res.status(404).json({ error: 'Déploiement non trouvé' });
        }

        res.json({ deployment });
    } catch (error) {
        console.error('Erreur récupération déploiement:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// Mettre à jour les variables d'environnement
router.put('/update-env/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { envVars } = req.body;
        const userId = req.user.id;

        // Vérifier que le déploiement appartient à l'utilisateur
        const { data: deployment, error: checkError } = await supabase
            .from('deployments')
            .select('bot:bots(cost, kerm_json), heroku_account_id')
            .eq('id', id)
            .eq('user_id', userId)
            .single();

        if (checkError || !deployment) {
            return res.status(404).json({ error: 'Déploiement non trouvé' });
        }

        // Vérifier que l'utilisateur a assez de coins
        const cost = deployment.bot.cost || 10;
        if (req.user.coins < cost) {
            return res.status(400).json({ error: 'Coins insuffisants' });
        }

        // Obtenir le compte Heroku
        const { data: herokuAccount } = await supabase
            .from('heroku_accounts')
            .select('api_key')
            .eq('id', deployment.heroku_account_id)
            .single();

        if (!herokuAccount) {
            return res.status(500).json({ error: 'Erreur serveur Heroku' });
        }

        // Initialiser le service Heroku
        const heroku = new HerokuService(herokuAccount.api_key);

        // Valider les variables d'environnement
        const botEnv = deployment.bot.kerm_json?.env || {};
        const validatedEnvVars = {};

        for (const [key, config] of Object.entries(botEnv)) {
            const value = envVars[key] || config.value || '';
            
            if (config.required !== false && !value) {
                return res.status(400).json({ 
                    error: `La variable "${key}" est obligatoire` 
                });
            }
            
            validatedEnvVars[key] = value;
        }

        // Mettre à jour les variables sur Heroku
        await heroku.setConfigVars(deployment.heroku_app_name, validatedEnvVars);

        // Redémarrer l'application
        await heroku.restartApp(deployment.heroku_app_name);

        // Mettre à jour la base de données
        await supabase
            .from('deployments')
            .update({
                env_variables: validatedEnvVars,
                updated_at: new Date()
            })
            .eq('id', id);

        // Débiter les coins
        await supabase
            .from('users')
            .update({ coins: req.user.coins - cost })
            .eq('id', userId);

        // Journaliser la transaction
        await supabase
            .from('coin_transactions')
            .insert([{
                sender_id: userId,
                receiver_id: null,
                amount: cost,
                type: 'deployment',
                description: `Mise à jour des variables pour ${deployment.bot.name}`
            }]);

        // Mettre à jour l'utilisateur dans le localStorage
        const updatedUser = { ...req.user, coins: req.user.coins - cost };

        res.json({
            message: 'Variables mises à jour avec succès',
            newCoins: updatedUser.coins
        });
    } catch (error) {
        console.error('Erreur mise à jour variables:', error);
        res.status(500).json({ error: 'Erreur lors de la mise à jour' });
    }
});

// Redémarrer un bot
router.post('/restart/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const { data: deployment, error } = await supabase
            .from('deployments')
            .select('heroku_app_name, heroku_account_id')
            .eq('id', id)
            .eq('user_id', userId)
            .single();

        if (error || !deployment) {
            return res.status(404).json({ error: 'Déploiement non trouvé' });
        }

        // Obtenir le compte Heroku
        const { data: herokuAccount } = await supabase
            .from('heroku_accounts')
            .select('api_key')
            .eq('id', deployment.heroku_account_id)
            .single();

        if (!herokuAccount) {
            return res.status(500).json({ error: 'Erreur serveur Heroku' });
        }

        // Redémarrer l'application
        const heroku = new HerokuService(herokuAccount.api_key);
        await heroku.restartApp(deployment.heroku_app_name);

        res.json({ message: 'Bot redémarré avec succès' });
    } catch (error) {
        console.error('Erreur redémarrage:', error);
        res.status(500).json({ error: 'Erreur lors du redémarrage' });
    }
});

// Supprimer un bot
router.delete('/delete/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const { data: deployment, error } = await supabase
            .from('deployments')
            .select('heroku_app_name, heroku_account_id, cost')
            .eq('id', id)
            .eq('user_id', userId)
            .single();

        if (error || !deployment) {
            return res.status(404).json({ error: 'Déploiement non trouvé' });
        }

        // Supprimer l'application Heroku
        const { data: herokuAccount } = await supabase
            .from('heroku_accounts')
            .select('api_key')
            .eq('id', deployment.heroku_account_id)
            .single();

        if (herokuAccount) {
            try {
                const heroku = new HerokuService(herokuAccount.api_key);
                await heroku.deleteApp(deployment.heroku_app_name);
            } catch (herokuError) {
                console.error('Erreur suppression Heroku:', herokuError);
                // Continuer même en cas d'erreur Heroku
            }
        }

        // Supprimer le déploiement de la base de données
        await supabase
            .from('deployments')
            .delete()
            .eq('id', id);

        // Décrémenter l'utilisation du compte Heroku
        await updateHerokuUsage(deployment.heroku_account_id, false);

        res.json({ message: 'Bot supprimé avec succès' });
    } catch (error) {
        console.error('Erreur suppression:', error);
        res.status(500).json({ error: 'Erreur lors de la suppression' });
    }
});

module.exports = router;