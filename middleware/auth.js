const jwt = require('jsonwebtoken');
const supabase = require('../utils/database');

const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1] || req.session.token;
    
    if (!token) {
      return res.status(401).json({ error: 'Authentification requise' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Récupérer l'utilisateur depuis la base de données
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Utilisateur non trouvé' });
    }

    if (!user.is_verified && req.path !== '/verify' && req.path !== '/resend-verification') {
      return res.status(403).json({ error: 'Veuillez vérifier votre email' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token invalide' });
  }
};

module.exports = authMiddleware;
