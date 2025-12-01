const { Resend } = require('resend');
require('dotenv').config();

const resend = new Resend(process.env.RESEND_API_KEY);

class EmailService {
  static async sendVerificationEmail(email, verificationCode) {
    try {
      const { data, error } = await resend.emails.send({
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_FROM}>`,
        to: [email],
        subject: 'Vérification de votre compte KermHost',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center;">
              <h1 style="color: white; margin: 0;">KermHost</h1>
            </div>
            <div style="padding: 20px;">
              <h2>Vérification de votre compte</h2>
              <p>Merci de vous être inscrit sur KermHost. Utilisez le code suivant pour vérifier votre compte :</p>
              <div style="background: #f0f0f0; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 5px; margin: 20px 0;">
                ${verificationCode}
              </div>
              <p>Ce code expirera dans 24 heures.</p>
              <p>Si vous n'avez pas créé de compte, veuillez ignorer cet email.</p>
            </div>
            <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #666;">
              <p>&copy; 2025 KermHost. Tous droits réservés.</p>
            </div>
          </div>
        `
      });
      
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Erreur d\'envoi d\'email:', error);
      throw error;
    }
  }

  static async sendPasswordResetEmail(email, resetToken) {
    try {
      const resetUrl = `${process.env.APP_URL}/reset-password?token=${resetToken}`;
      
      const { data, error } = await resend.emails.send({
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_FROM}>`,
        to: [email],
        subject: 'Réinitialisation de votre mot de passe KermHost',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center;">
              <h1 style="color: white; margin: 0;">KermHost</h1>
            </div>
            <div style="padding: 20px;">
              <h2>Réinitialisation du mot de passe</h2>
              <p>Vous avez demandé à réinitialiser votre mot de passe. Cliquez sur le lien ci-dessous :</p>
              <div style="text-align: center; margin: 20px 0;">
                <a href="${resetUrl}" style="background: #667eea; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">
                  Réinitialiser mon mot de passe
                </a>
              </div>
              <p>Si vous n'avez pas demandé de réinitialisation, veuillez ignorer cet email.</p>
              <p>Ce lien expirera dans 1 heure.</p>
            </div>
            <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #666;">
              <p>&copy; 2025 KermHost. Tous droits réservés.</p>
            </div>
          </div>
        `
      });
      
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Erreur d\'envoi d\'email:', error);
      throw error;
    }
  }

  static async sendCoinTransferEmail(senderEmail, receiverEmail, amount) {
    try {
      const { data, error } = await resend.emails.send({
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_FROM}>`,
        to: [receiverEmail],
        subject: 'Transfert de coins reçu - KermHost',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center;">
              <h1 style="color: white; margin: 0;">KermHost</h1>
            </div>
            <div style="padding: 20px;">
              <h2>Transfert de coins reçu</h2>
              <p>Vous avez reçu <strong>${amount} coins</strong> de ${senderEmail}.</p>
              <div style="background: #f0f0f0; padding: 15px; text-align: center; margin: 20px 0;">
                <p style="font-size: 18px; margin: 0;">Montant : ${amount} coins</p>
              </div>
              <p>Vous pouvez maintenant utiliser ces coins pour déployer vos bots.</p>
            </div>
            <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #666;">
              <p>&copy; 2025 KermHost. Tous droits réservés.</p>
            </div>
          </div>
        `
      });
      
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Erreur d\'envoi d\'email:', error);
      throw error;
    }
  }

  // Email de confirmation de vérification manuelle
  static async sendVerificationSuccessEmail(email) {
    try {
      const { data, error } = await resend.emails.send({
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_FROM}>`,
        to: [email],
        subject: 'Compte vérifié avec succès - KermHost',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center;">
              <h1 style="color: white; margin: 0;">KermHost</h1>
            </div>
            <div style="padding: 20px;">
              <h2>Votre compte a été vérifié avec succès !</h2>
              <p>Votre compte KermHost a été vérifié manuellement par un administrateur.</p>
              <div style="background: #f0f0f0; padding: 15px; text-align: center; margin: 20px 0; border-radius: 10px;">
                <p style="margin: 0; font-size: 16px; font-weight: bold;">Vous pouvez maintenant accéder à toutes les fonctionnalités du site !</p>
              </div>
              <p>Connectez-vous pour commencer à déployer vos bots WhatsApp.</p>
              <div style="text-align: center; margin: 20px 0;">
                <a href="${process.env.APP_URL}/login" style="background: #667eea; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">
                  Se connecter
                </a>
              </div>
            </div>
            <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #666;">
              <p>&copy; 2025 KermHost. Tous droits réservés.</p>
            </div>
          </div>
        `
      });
      
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Erreur envoi email vérification:', error);
      throw error;
    }
  }

  // Email d'approbation de bot
  static async sendBotApprovalEmail(email, botName) {
    try {
      const { data, error } = await resend.emails.send({
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_FROM}>`,
        to: [email],
        subject: 'Votre bot a été approuvé - KermHost',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center;">
              <h1 style="color: white; margin: 0;">KermHost</h1>
            </div>
            <div style="padding: 20px;">
              <h2>Félicitations ! Votre bot a été approuvé</h2>
              <p>Votre bot <strong>"${botName}"</strong> a été examiné et approuvé par notre équipe.</p>
              <div style="background: #f0f0f0; padding: 15px; text-align: center; margin: 20px 0; border-radius: 10px;">
                <p style="margin: 0; font-size: 16px; font-weight: bold;">Votre bot est maintenant disponible pour le déploiement par tous les utilisateurs !</p>
              </div>
              <p>Les utilisateurs peuvent maintenant déployer votre bot sur leurs serveurs Heroku.</p>
              <p>Vous recevrez des coins pour chaque déploiement effectué par d'autres utilisateurs.</p>
              <div style="text-align: center; margin: 20px 0;">
                <a href="${process.env.APP_URL}/dashboard" style="background: #667eea; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">
                  Voir mon dashboard
                </a>
              </div>
            </div>
            <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #666;">
              <p>&copy; 2025 KermHost. Tous droits réservés.</p>
            </div>
          </div>
        `
      });
      
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Erreur envoi email approbation bot:', error);
      throw error;
    }
  }

  // Email de rejet de bot
  static async sendBotRejectionEmail(email, botName, reason) {
    try {
      const { data, error } = await resend.emails.send({
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_FROM}>`,
        to: [email],
        subject: 'Votre bot a été rejeté - KermHost',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center;">
              <h1 style="color: white; margin: 0;">KermHost</h1>
            </div>
            <div style="padding: 20px;">
              <h2>Votre bot n'a pas été approuvé</h2>
              <p>Votre bot <strong>"${botName}"</strong> a été examiné par notre équipe mais n'a pas été approuvé.</p>
              ${reason ? `
                <div style="background: #fff3cd; padding: 15px; border-left: 4px solid #ffc107; margin: 20px 0;">
                  <p style="margin: 0; color: #856404;"><strong>Raison :</strong> ${reason}</p>
                </div>
              ` : ''}
              <p>Vous pouvez :</p>
              <ul style="line-height: 1.6;">
                <li>Corriger les problèmes mentionnés ci-dessus</li>
                <li>Resoumettre votre bot pour réexamen</li>
                <li>Consulter notre documentation pour les exigences</li>
              </ul>
              <div style="text-align: center; margin: 20px 0;">
                <a href="${process.env.APP_URL}/dashboard/request" style="background: #667eea; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">
                  Resoumettre mon bot
                </a>
              </div>
            </div>
            <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #666;">
              <p>&copy; 2025 KermHost. Tous droits réservés.</p>
            </div>
          </div>
        `
      });
      
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Erreur envoi email rejet bot:', error);
      throw error;
    }
  }

  // Email de notification de maintenance
  static async sendMaintenanceEmail(email, message, endTime) {
    try {
      const { data, error } = await resend.emails.send({
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_FROM}>`,
        to: [email],
        subject: 'Maintenance programmée - KermHost',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center;">
              <h1 style="color: white; margin: 0;">KermHost</h1>
            </div>
            <div style="padding: 20px;">
              <h2>Maintenance programmée</h2>
              <p>Une maintenance est programmée pour la plateforme KermHost.</p>
              ${message ? `
                <div style="background: #fff3cd; padding: 15px; border-left: 4px solid #ffc107; margin: 20px 0;">
                  <p style="margin: 0; color: #856404;">${message}</p>
                </div>
              ` : ''}
              ${endTime ? `
                <p><strong>Fin prévue :</strong> ${new Date(endTime).toLocaleString()}</p>
              ` : ''}
              <p>Pendant cette période, le site pourrait être temporairement inaccessible.</p>
              <p>Nous nous excusons pour la gêne occasionnée et vous remercions de votre compréhension.</p>
            </div>
            <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #666;">
              <p>&copy; 2025 KermHost. Tous droits réservés.</p>
            </div>
          </div>
        `
      });
      
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Erreur envoi email maintenance:', error);
      throw error;
    }
  }

  // Email de bienvenue pour les nouveaux utilisateurs
  static async sendWelcomeEmail(email, username, referralCode) {
    try {
      const referralLink = `${process.env.APP_URL}/signup?ref=${referralCode}`;
      
      const { data, error } = await resend.emails.send({
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_FROM}>`,
        to: [email],
        subject: 'Bienvenue sur KermHost !',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center;">
              <h1 style="color: white; margin: 0;">KermHost</h1>
            </div>
            <div style="padding: 20px;">
              <h2>Bienvenue ${username} !</h2>
              <p>Merci de vous être inscrit sur KermHost, la plateforme d'hébergement de bots WhatsApp.</p>
              
              <div style="background: #f8f9fa; padding: 20px; border-radius: 10px; margin: 20px 0;">
                <h3 style="margin-top: 0;">Vos avantages :</h3>
                <ul style="line-height: 1.8;">
                  <li><strong>✅ 10 coins offerts</strong> pour commencer</li>
                  <li><strong>✅ +10 coins par jour</strong> en se connectant</li>
                  <li><strong>✅ +10 coins</strong> pour chaque ami parrainé</li>
                  <li><strong>✅ Déploiement gratuit</strong> de bots WhatsApp</li>
                  <li><strong>✅ Gestion facile</strong> depuis votre dashboard</li>
                </ul>
              </div>
              
              <div style="background: #e7f4e4; padding: 20px; border-radius: 10px; margin: 20px 0; border-left: 4px solid #28a745;">
                <h3 style="margin-top: 0; color: #155724;">Votre lien de parrainage :</h3>
                <p style="word-break: break-all; background: white; padding: 10px; border-radius: 5px; font-family: monospace;">
                  ${referralLink}
                </p>
                <p>Partagez ce lien pour gagner <strong>10 coins</strong> par ami inscrit !</p>
              </div>
              
              <div style="text-align: center; margin: 30px 0;">
                <a href="${process.env.APP_URL}/dashboard" style="background: #667eea; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-size: 16px; font-weight: bold;">
                  🚀 Commencer maintenant
                </a>
              </div>
            </div>
            <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #666;">
              <p>&copy; 2025 KermHost. Tous droits réservés.</p>
              <p style="font-size: 12px; margin-top: 10px;">
                <a href="${process.env.APP_URL}/unsubscribe" style="color: #666;">Se désinscrire</a> | 
                <a href="${process.env.APP_URL}/privacy" style="color: #666;">Politique de confidentialité</a>
              </p>
            </div>
          </div>
        `
      });
      
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Erreur envoi email de bienvenue:', error);
      throw error;
    }
  }
}

module.exports = EmailService;
