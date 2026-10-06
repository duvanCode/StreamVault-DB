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
          fields: 'id, name, mimeType, capabilities, trashed',
          supportsAllDrives: true,
        });

        if (folderRes.data.trashed) {
          throw new Error(`The target folder ID "${config.folder_id}" is currently in the trash.`);
        }
        result.folderName = folderRes.data.name;

        // Check write permission
        if (folderRes.data.capabilities && !folderRes.data.capabilities.canAddChildren) {
          throw new Error(`The account (${result.account}) does not have permission to upload files to folder "${folderRes.data.name}". Please grant "Editor" or "Contributor" permissions.`);
        }
      } else {
        result.folderName = 'Root Drive';
      }

      result.ok = true;
      result.message = `Successfully connected to Google Drive (${result.account}) with target folder "${result.folderName}".`;
      return result;
    } catch (err) {
      result.ok = false;
      result.message = err.message || 'Failed to connect to Google Drive.';
      throw new Error(result.message);
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
