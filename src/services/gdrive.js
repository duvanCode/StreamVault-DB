const { google } = require('googleapis');
const storage = require('../db/storage');

class GoogleDriveService {
  /**
   * Builds an authenticated Google Drive client
   * @param {Object} [overrideConfig]
   */
  static getClient(overrideConfig = null) {
    const config = overrideConfig || storage.getGDriveConfig();
    if (!config) {
      throw new Error('Google Drive configuration not found. Please configure Google Drive in Settings or .env');
    }

    let auth;
    if (config.auth_type === 'service_account') {
      let sa;
      if (typeof config.service_account_json === 'string') {
        try {
          sa = JSON.parse(config.service_account_json);
        } catch (e) {
          throw new Error('Invalid Service Account JSON format: ' + e.message);
        }
      } else {
        sa = config.service_account_json;
      }

      if (!sa || !sa.client_email || !sa.private_key) {
        throw new Error('Service Account JSON is missing client_email or private_key.');
      }

      auth = new google.auth.JWT({
        email: sa.client_email,
        key: sa.private_key.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/drive'],
      });
    } else if (config.auth_type === 'oauth') {
      if (!config.client_id || !config.client_secret || !config.refresh_token) {
        throw new Error('OAuth configuration missing client_id, client_secret, or refresh_token.');
      }

      const oauth2Client = new google.auth.OAuth2(
        config.client_id,
        config.client_secret
      );
      oauth2Client.setCredentials({
        refresh_token: config.refresh_token,
      });
      auth = oauth2Client;
    } else {
      throw new Error('Unsupported auth_type: ' + config.auth_type);
    }

    const drive = google.drive({ version: 'v3', auth });
    return { drive, config };
  }

  /**
   * Generates Google OAuth 2.0 authorization URL
   * @param {Object} params
   * @param {string} params.clientId
   * @param {string} params.clientSecret
   * @param {string} params.redirectUri
   * @param {string} [params.state]
   */
  static generateAuthUrl({ clientId, clientSecret, redirectUri, state = '' }) {
    if (!clientId) {
      throw new Error('Client ID is required to generate Google OAuth URL.');
    }
    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret || '',
      redirectUri
    );

    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive',
      ],
      state,
    });
  }

  /**
   * Exchanges authorization code for OAuth tokens
   * @param {Object} params
   * @param {string} params.clientId
   * @param {string} params.clientSecret
   * @param {string} params.redirectUri
   * @param {string} params.code
   */
  static async exchangeCodeForTokens({ clientId, clientSecret, redirectUri, code }) {
    if (!clientId || !clientSecret || !code) {
      throw new Error('clientId, clientSecret, and code are required to exchange OAuth tokens.');
    }
    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      redirectUri
    );

    const { tokens } = await oauth2Client.getToken(code);
    return tokens;
  }

  /**
   * Tests the Google Drive connection and folder access
   */
  static async testConnection(customConfig = null) {
    const { drive, config } = this.getClient(customConfig);
    const result = {
      ok: false,
      folderId: config.folder_id,
      folderName: null,
      account: null,
      storageQuota: null,
      isSharedDrive: false,
      message: '',
    };

    try {
      // 1. Check API & Account status
      const aboutRes = await drive.about.get({
        fields: 'user, storageQuota',
      });
      result.account = aboutRes.data.user ? aboutRes.data.user.emailAddress : 'Authenticated';
      result.storageQuota = aboutRes.data.storageQuota || null;

      // 2. Check Folder access if folderId is provided
      if (config.folder_id && config.folder_id !== 'root') {
        const folderRes = await drive.files.get({
          fileId: config.folder_id,
          fields: 'id, name, mimeType, capabilities, trashed, driveId',
          supportsAllDrives: true,
        });

        if (folderRes.data.trashed) {
          throw new Error(`La carpeta especificada "${config.folder_id}" se encuentra en la papelera.`);
        }
        result.folderName = folderRes.data.name;
        result.isSharedDrive = Boolean(folderRes.data.driveId);

        // Check write permission
        if (folderRes.data.capabilities && !folderRes.data.capabilities.canAddChildren) {
          throw new Error(`La cuenta (${result.account}) no tiene permisos para agregar archivos a la carpeta "${folderRes.data.name}". Por favor concede permisos de "Editor" o "Gestor de contenido".`);
        }

        // 3. Proactive quota probe: Service Accounts have 0 quota on personal drives!
        if (config.auth_type === 'service_account' && !folderRes.data.driveId) {
          try {
            const probe = await drive.files.create({
              requestBody: {
                name: `.streamvault_probe_${Date.now()}.tmp`,
                parents: [config.folder_id],
              },
              media: {
                mimeType: 'text/plain',
                body: 'StreamVault connection probe',
              },
              fields: 'id',
              supportsAllDrives: true,
            });
            if (probe.data && probe.data.id) {
              await drive.files.delete({
                fileId: probe.data.id,
                supportsAllDrives: true,
              }).catch(() => {});
            }
          } catch (probeErr) {
            if (probeErr.message && probeErr.message.includes('Service Accounts do not have storage quota')) {
              throw new Error(
                'Las Cuentas de Servicio (Service Account) tienen 0 bytes de cuota y Google no permite subir archivos a carpetas personales de @gmail.com. ' +
                'Solución: Si usas una cuenta de Gmail personal, cambia el método a "OAuth 2.0" y conecta tu cuenta. Si usas Google Workspace, mueve la carpeta a una "Unidad Compartida" (Shared Drive).'
              );
            }
            throw probeErr;
          }
        }
      } else {
        result.folderName = 'Root Drive';
      }

      result.ok = true;
      result.message = `Conectado exitosamente a Google Drive (${result.account}) en la carpeta "${result.folderName}".`;
      return result;
    } catch (err) {
      result.ok = false;
      let msg = err.message || 'Error al conectar con Google Drive.';
      if (msg.includes('Service Accounts do not have storage quota')) {
        msg = 'Las Cuentas de Servicio tienen 0 bytes de cuota en carpetas personales (@gmail.com). Para cuentas personales, utiliza OAuth 2.0. Para cuentas corporativas, usa una Unidad Compartida (Shared Drive).';
      }
      result.message = msg;
      throw new Error(msg);
    }
  }

  /**
   * Uploads a stream directly to Google Drive without touching the VPS disk
   * @param {Object} params
   * @param {string} params.name - filename
   * @param {stream.Readable} params.stream - input stream (e.g. pg_dump | gzip)
   * @param {string} [params.mimeType] - MIME type ('application/gzip')
   * @param {string} [params.folderId] - target folder ID
   */
  static async uploadStream({ name, stream, mimeType = 'application/gzip', folderId = null }) {
    const { drive, config } = this.getClient();
    const targetFolder = folderId || config.folder_id;

    const requestBody = {
      name,
      mimeType,
    };

    if (targetFolder && targetFolder !== 'root') {
      requestBody.parents = [targetFolder];
    }

    try {
      const res = await drive.files.create(
        {
          requestBody,
          media: {
            mimeType,
            body: stream,
          },
          fields: 'id, name, size, webViewLink, webContentLink, createdTime, md5Checksum',
          supportsAllDrives: true,
        },
        {
          // Infinite timeout & body size for large database dumps
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        }
      );

      return res.data;
    } catch (err) {
      if (err.message && err.message.includes('Service Accounts do not have storage quota')) {
        throw new Error(
          'Google Drive rechazó la subida: Las cuentas de servicio (Service Accounts) tienen 0 bytes de cuota y NO pueden subir archivos a carpetas personales de @gmail.com.\n\n' +
          'SOLUCIÓN:\n' +
          '1. Si usas cuenta personal @gmail.com: Cambia el método de autenticación a "OAuth 2.0" en la pestaña Google Drive y conecta tu cuenta.\n' +
          '2. Si usas Google Workspace: Mueve la carpeta a una "Unidad Compartida" (Shared Drive) y agrega el correo de la cuenta de servicio como "Gestor de contenido".'
        );
      }
      throw err;
    }
  }

  /**
   * Downloads a backup file as a readable stream for integrity verification or restoration
   * @param {string} fileId
   */
  static async downloadStream(fileId) {
    const { drive } = this.getClient();

    const res = await drive.files.get(
      {
        fileId,
        alt: 'media',
        supportsAllDrives: true,
      },
      {
        responseType: 'stream',
      }
    );

    return res.data;
  }

  /**
   * Retrieves file metadata
   */
  static async getFileMetadata(fileId) {
    const { drive } = this.getClient();
    const res = await drive.files.get({
      fileId,
      fields: 'id, name, size, mimeType, md5Checksum, createdTime, webViewLink',
      supportsAllDrives: true,
    });
    return res.data;
  }

  /**
   * Deletes a file from Google Drive
   */
  static async deleteFile(fileId) {
    const { drive } = this.getClient();
    await drive.files.delete({
      fileId,
      supportsAllDrives: true,
    });
    return true;
  }

  /**
   * Lists files in the configured folder
   */
  static async listFiles(folderId = null, pageSize = 20) {
    const { drive, config } = this.getClient();
    const targetFolder = folderId || config.folder_id;

    let q = 'trashed = false';
    if (targetFolder && targetFolder !== 'root') {
      q += ` and '${targetFolder}' in parents`;
    }

    const res = await drive.files.list({
      q,
      pageSize,
      fields: 'files(id, name, size, mimeType, createdTime, webViewLink, md5Checksum)',
      orderBy: 'createdTime desc',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    return res.data.files || [];
  }
}

module.exports = GoogleDriveService;
