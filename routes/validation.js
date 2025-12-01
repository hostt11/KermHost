const validator = require('validator');

class ValidationService {
  // Valider une adresse email
  static validateEmail(email) {
    if (!email) {
      return { valid: false, error: 'Email requis' };
    }
    
    if (!validator.isEmail(email)) {
      return { valid: false, error: 'Format d\'email invalide' };
    }
    
    return { valid: true };
  }

  // Valider un mot de passe
  static validatePassword(password) {
    if (!password) {
      return { valid: false, error: 'Mot de passe requis' };
    }
    
    if (password.length < 6) {
      return { valid: false, error: 'Le mot de passe doit contenir au moins 6 caractères' };
    }
    
    // Optionnel : ajouter plus de règles de complexité
    if (!/[A-Z]/.test(password)) {
      return { valid: false, error: 'Le mot de passe doit contenir au moins une majuscule' };
    }
    
    if (!/[0-9]/.test(password)) {
      return { valid: false, error: 'Le mot de passe doit contenir au moins un chiffre' };
    }
    
    return { valid: true };
  }

  // Valider un nom d'utilisateur
  static validateUsername(username) {
    if (!username) {
      return { valid: false, error: 'Nom d\'utilisateur requis' };
    }
    
    if (username.length < 3) {
      return { valid: false, error: 'Le nom d\'utilisateur doit contenir au moins 3 caractères' };
    }
    
    if (username.length > 30) {
      return { valid: false, error: 'Le nom d\'utilisateur ne peut pas dépasser 30 caractères' };
    }
    
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
      return { valid: false, error: 'Le nom d\'utilisateur ne peut contenir que des lettres, chiffres, points, tirets et underscores' };
    }
    
    return { valid: true };
  }

  // Valider un repository GitHub
  static validateGitHubRepo(repo) {
    if (!repo) {
      return { valid: false, error: 'Repository GitHub requis' };
    }
    
    const repoRegex = /^[a-zA-Z0-9-_]+\/[a-zA-Z0-9-_]+$/;
    if (!repoRegex.test(repo)) {
      return { valid: false, error: 'Format invalide. Utilisez : username/repository' };
    }
    
    return { valid: true };
  }

  // Valider un montant de coins
  static validateCoinAmount(amount) {
    if (!amount && amount !== 0) {
      return { valid: false, error: 'Montant requis' };
    }
    
    const parsedAmount = parseInt(amount);
    if (isNaN(parsedAmount)) {
      return { valid: false, error: 'Montant invalide' };
    }
    
    if (parsedAmount <= 0) {
      return { valid: false, error: 'Le montant doit être positif' };
    }
    
    if (parsedAmount > 1000000) {
      return { valid: false, error: 'Le montant est trop élevé' };
    }
    
    return { valid: true, amount: parsedAmount };
  }

  // Valider un code de vérification
  static validateVerificationCode(code) {
    if (!code) {
      return { valid: false, error: 'Code de vérification requis' };
    }
    
    if (!/^[0-9]{6}$/.test(code)) {
      return { valid: false, error: 'Le code doit contenir 6 chiffres' };
    }
    
    return { valid: true };
  }

  // Valider un code de parrainage
  static validateReferralCode(code) {
    if (!code) {
      return { valid: true }; // Le code de parrainage est optionnel
    }
    
    if (code.length < 6 || code.length > 20) {
      return { valid: false, error: 'Code de parrainage invalide' };
    }
    
    if (!/^[a-zA-Z0-9]+$/.test(code)) {
      return { valid: false, error: 'Code de parrainage invalide' };
    }
    
    return { valid: true };
  }

  // Valider un token JWT
  static validateJWT(token) {
    if (!token) {
      return { valid: false, error: 'Token manquant' };
    }
    
    // Vérification basique du format JWT
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Format de token invalide' };
    }
    
    return { valid: true };
  }

  // Valider des variables d'environnement
  static validateEnvVariables(envVars, requiredVars = []) {
    const errors = [];
    
    // Vérifier les variables requises
    requiredVars.forEach(varName => {
      if (!envVars[varName]) {
        errors.push(`${varName} est requis`);
      }
    });
    
    // Valider les valeurs (exemples)
    Object.entries(envVars).forEach(([key, value]) => {
      if (value && value.length > 1000) {
        errors.push(`${key} est trop long (max 1000 caractères)`);
      }
    });
    
    if (errors.length > 0) {
      return { valid: false, errors };
    }
    
    return { valid: true };
  }

  // Valider une URL
  static validateURL(url, fieldName = 'URL') {
    if (!url) {
      return { valid: false, error: `${fieldName} requis` };
    }
    
    if (!validator.isURL(url, { 
      require_protocol: true,
      protocols: ['http', 'https']
    })) {
      return { valid: false, error: `${fieldName} invalide` };
    }
    
    return { valid: true };
  }

  // Valider une date
  static validateDate(dateString, fieldName = 'Date') {
    if (!dateString) {
      return { valid: false, error: `${fieldName} requis` };
    }
    
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      return { valid: false, error: `${fieldName} invalide` };
    }
    
    if (date > new Date('2100-01-01')) {
      return { valid: false, error: `${fieldName} trop éloignée` };
    }
    
    return { valid: true, date };
  }

  // Valider un fichier kerm.json
  static validateKermJSON(kermJson) {
    const errors = [];
    
    if (!kermJson) {
      return { valid: false, errors: ['kerm.json est vide'] };
    }
    
    // Vérifier les champs requis
    if (!kermJson['bot-name']) {
      errors.push('bot-name est requis');
    }
    
    if (!kermJson.description) {
      errors.push('description est requise');
    }
    
    if (!kermJson.env || typeof kermJson.env !== 'object') {
      errors.push('env est requis et doit être un objet');
    } else {
      // Valider chaque variable d'environnement
      Object.entries(kermJson.env).forEach(([key, config]) => {
        if (!config.description) {
          errors.push(`Description manquante pour ${key}`);
        }
        
        if (config.required === true && !config.value) {
          errors.push(`Valeur requise manquante pour ${key}`);
        }
      });
    }
    
    // Valider l'URL du logo si présente
    if (kermJson.logo) {
      const logoValidation = this.validateURL(kermJson.logo, 'Logo URL');
      if (!logoValidation.valid) {
        errors.push(logoValidation.error);
      }
    }
    
    // Valider l'URL de documentation si présente
    if (kermJson['documentation-link']) {
      const docValidation = this.validateURL(kermJson['documentation-link'], 'Documentation link');
      if (!docValidation.valid) {
        errors.push(docValidation.error);
      }
    }
    
    if (errors.length > 0) {
      return { valid: false, errors };
    }
    
    return { valid: true, kermJson };
  }

  // Valider les données d'inscription
  static validateSignupData(data) {
    const errors = [];
    
    // Valider l'email
    const emailValidation = this.validateEmail(data.email);
    if (!emailValidation.valid) {
      errors.push(emailValidation.error);
    }
    
    // Valider le mot de passe
    const passwordValidation = this.validatePassword(data.password);
    if (!passwordValidation.valid) {
      errors.push(passwordValidation.error);
    }
    
    // Valider le nom d'utilisateur (optionnel)
    if (data.username) {
      const usernameValidation = this.validateUsername(data.username);
      if (!usernameValidation.valid) {
        errors.push(usernameValidation.error);
      }
    }
    
    // Valider le code de parrainage (optionnel)
    if (data.referralCode) {
      const referralValidation = this.validateReferralCode(data.referralCode);
      if (!referralValidation.valid) {
        errors.push(referralValidation.error);
      }
    }
    
    if (errors.length > 0) {
      return { valid: false, errors };
    }
    
    return { valid: true };
  }

  // Valider les données de connexion
  static validateLoginData(data) {
    const errors = [];
    
    // Valider l'email
    const emailValidation = this.validateEmail(data.email);
    if (!emailValidation.valid) {
      errors.push(emailValidation.error);
    }
    
    // Valider le mot de passe (vérification basique)
    if (!data.password) {
      errors.push('Mot de passe requis');
    }
    
    if (errors.length > 0) {
      return { valid: false, errors };
    }
    
    return { valid: true };
  }

  // Valider les données de réinitialisation de mot de passe
  static validateResetPasswordData(data) {
    const errors = [];
    
    // Valider l'email
    const emailValidation = this.validateEmail(data.email);
    if (!emailValidation.valid) {
      errors.push(emailValidation.error);
    }
    
    if (errors.length > 0) {
      return { valid: false, errors };
    }
    
    return { valid: true };
  }

  // Sanitizer pour prévenir les injections XSS
  static sanitizeInput(input) {
    if (typeof input === 'string') {
      // Échapper les caractères spéciaux HTML
      return validator.escape(input);
    }
    
    if (Array.isArray(input)) {
      return input.map(item => this.sanitizeInput(item));
    }
    
    if (typeof input === 'object' && input !== null) {
      const sanitized = {};
      Object.keys(input).forEach(key => {
        sanitized[key] = this.sanitizeInput(input[key]);
      });
      return sanitized;
    }
    
    return input;
  }

  // Valider et nettoyer les données utilisateur
  static cleanUserInput(input) {
    const cleaned = {};
    
    if (input.email) {
      cleaned.email = validator.normalizeEmail(input.email, {
        gmail_remove_dots: false,
        gmail_remove_subaddress: false,
        outlookdotcom_remove_subaddress: false,
        yahoo_remove_subaddress: false,
        icloud_remove_subaddress: false
      });
    }
    
    if (input.username) {
      cleaned.username = validator.trim(input.username);
      cleaned.username = validator.whitelist(cleaned.username, 'a-zA-Z0-9_.-');
    }
    
    // Nettoyer les autres champs
    Object.keys(input).forEach(key => {
      if (typeof input[key] === 'string' && !cleaned[key]) {
        cleaned[key] = validator.trim(input[key]);
      }
    });
    
    return cleaned;
  }
}

module.exports = ValidationService;