const Heroku = require('heroku-client');
const axios = require('axios');

class HerokuService {
  constructor(apiKey) {
    this.heroku = new Heroku({ token: apiKey });
  }

  async createApp(appName, region = 'eu') {
    try {
      const app = await this.heroku.post('/apps', {
        body: {
          name: appName,
          region: region
        }
      });
      return app;
    } catch (error) {
      console.error('Erreur création app Heroku:', error);
      throw error;
    }
  }

  async deployFromGithub(appName, repoUrl, branch = 'main') {
    try {
      // Configuration du build depuis GitHub
      const build = await this.heroku.post(`/apps/${appName}/builds`, {
        body: {
          source_blob: {
            url: repoUrl,
            version: branch
          }
        }
      });
      return build;
    } catch (error) {
      console.error('Erreur déploiement Heroku:', error);
      throw error;
    }
  }

  async setConfigVars(appName, envVars) {
    try {
      const config = await this.heroku.patch(`/apps/${appName}/config-vars`, {
        body: envVars
      });
      return config;
    } catch (error) {
      console.error('Erreur configuration variables:', error);
      throw error;
    }
  }

  async getAppLogs(appName) {
    try {
      const logs = await this.heroku.get(`/apps/${appName}/log-sessions`, {
        headers: {
          Accept: 'application/vnd.heroku+json; version=3.log-drains'
        }
      });
      return logs;
    } catch (error) {
      console.error('Erreur récupération logs:', error);
      throw error;
    }
  }

  async restartApp(appName) {
    try {
      await this.heroku.delete(`/apps/${appName}/dynos`);
      return { success: true };
    } catch (error) {
      console.error('Erreur redémarrage app:', error);
      throw error;
    }
  }

  async deleteApp(appName) {
    try {
      await this.heroku.delete(`/apps/${appName}`);
      return { success: true };
    } catch (error) {
      console.error('Erreur suppression app:', error);
      throw error;
    }
  }

  async getAppInfo(appName) {
    try {
      const app = await this.heroku.get(`/apps/${appName}`);
      return app;
    } catch (error) {
      console.error('Erreur récupération info app:', error);
      throw error;
    }
  }

  static async validateApiKey(apiKey) {
    try {
      const response = await axios.get('https://api.heroku.com/account', {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/vnd.heroku+json; version=3'
        }
      });
      return response.data;
    } catch (error) {
      return null;
    }
  }
}

module.exports = HerokuService;