// StreamVault DB Dashboard Client
document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const tabs = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  const btnRefresh = document.getElementById('btn-refresh');
  const toastContainer = document.getElementById('toast-container');

  // Stats Elements
  const statTotalBackups = document.getElementById('stat-total-backups');
  const statSuccessRate = document.getElementById('stat-success-rate');
  const statTotalBytes = document.getElementById('stat-total-bytes');
  const statCronSchedule = document.getElementById('stat-cron-schedule');
  const statTestPassRate = document.getElementById('stat-test-pass-rate');
  const statTestCount = document.getElementById('stat-test-count');
  const badgeDriveStatus = document.getElementById('badge-drive-status');

  // Tables & Selects
  const tableBackupsBody = document.getElementById('table-backups-body');
  const tableDbsBody = document.getElementById('table-dbs-body');
  const tableTestsBody = document.getElementById('table-tests-body');
  const selectDbManual = document.getElementById('select-db-manual');
  const btnTriggerBackup = document.getElementById('btn-trigger-backup');

  // Modals
  const modalDb = document.getElementById('modal-db');
  const btnOpenAddDb = document.getElementById('btn-open-add-db');
  const btnCloseDbModal = document.getElementById('btn-close-db-modal');
  const formDb = document.getElementById('form-db');
  const btnTestDbConn = document.getElementById('btn-test-db-conn');
  const dbTypeSelect = document.getElementById('db-type');
  const dbPortInput = document.getElementById('db-port');

  const modalLogs = document.getElementById('modal-logs');
  const btnCloseLogsModal = document.getElementById('btn-close-logs-modal');
  const btnCloseLogs = document.getElementById('btn-close-logs');
  const logsContent = document.getElementById('logs-content');

  // Google Drive Form
  const formGdrive = document.getElementById('form-gdrive');
  const gdriveAuthType = document.getElementById('gdrive-auth-type');
  const gdriveFolderId = document.getElementById('gdrive-folder-id');
  const gdriveSaJson = document.getElementById('gdrive-sa-json');
  const gdriveClientId = document.getElementById('gdrive-client-id');
  const gdriveClientSecret = document.getElementById('gdrive-client-secret');
  const gdriveRefreshToken = document.getElementById('gdrive-refresh-token');
  const sectionSaJson = document.getElementById('section-sa-json');
  const sectionOauth = document.getElementById('section-oauth');
  const btnTestGdrive = document.getElementById('btn-test-gdrive');
  const oauthRedirectUri = document.getElementById('oauth-redirect-uri');
  const btnCopyRedirectUri = document.getElementById('btn-copy-redirect-uri');
  const btnOauthConnect = document.getElementById('btn-oauth-connect');
  const oauthTokenStatus = document.getElementById('oauth-token-status');

  // Lock Screen Elements
  const lockScreenOverlay = document.getElementById('lock-screen-overlay');
  const formLockScreen = document.getElementById('form-lock-screen');
  const inputAccessKey = document.getElementById('input-access-key');
  const lockErrorAlert = document.getElementById('lock-error-alert');
  const lockErrorText = document.getElementById('lock-error-text');
  const btnToggleKeyVisibility = document.getElementById('btn-toggle-key-visibility');
  const iconEyeShow = document.getElementById('icon-eye-show');
  const iconEyeHide = document.getElementById('icon-eye-hide');
  const btnLockSession = document.getElementById('btn-lock-session');
  const btnUnlock = document.getElementById('btn-unlock');

  // Token management
  function getToken() {
    return localStorage.getItem('streamvault_token') || '';
  }

  function setToken(token) {
    if (token) localStorage.setItem('streamvault_token', token);
    else localStorage.removeItem('streamvault_token');
  }

  function getAuthHeaders() {
    const token = getToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      headers['x-access-key'] = token;
    }
    return headers;
  }

  async function authFetch(url, options = {}) {
    const headers = {
      ...getAuthHeaders(),
      ...(options.headers || {}),
    };

    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      // Show Lock Screen
      showLockScreen();
      throw new Error('Autenticación requerida.');
    }
    return res;
  }

  function showLockScreen() {
    lockScreenOverlay.classList.remove('hidden');
    inputAccessKey.value = '';
    inputAccessKey.focus();
    btnLockSession.style.display = 'inline-flex';
  }

  function hideLockScreen() {
    lockScreenOverlay.classList.add('hidden');
    lockErrorAlert.style.display = 'none';
  }

  // Toggle key visibility
  btnToggleKeyVisibility.addEventListener('click', () => {
    if (inputAccessKey.type === 'password') {
      inputAccessKey.type = 'text';
      iconEyeShow.style.display = 'none';
      iconEyeHide.style.display = 'block';
    } else {
      inputAccessKey.type = 'password';
      iconEyeShow.style.display = 'block';
      iconEyeHide.style.display = 'none';
    }
  });

  // Lock Screen submit
  formLockScreen.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = inputAccessKey.value.trim();
    if (!key) return;

    try {
      btnUnlock.disabled = true;
      btnUnlock.textContent = 'Verificando...';
      lockErrorAlert.style.display = 'none';

      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });

      const json = await res.json();
      if (json.success) {
        setToken(json.token || key);
        hideLockScreen();
        btnLockSession.style.display = 'inline-flex';
        showToast('Acceso autorizado.', 'success');
        refreshAll();
      } else {
        lockErrorText.textContent = json.error || 'Llave de acceso incorrecta.';
        lockErrorAlert.style.display = 'flex';
        inputAccessKey.select();
      }
    } catch (err) {
      lockErrorText.textContent = 'Error de conexión con el servidor.';
      lockErrorAlert.style.display = 'flex';
    } finally {
      btnUnlock.disabled = false;
      btnUnlock.textContent = 'Desbloquear Panel';
    }
  });

  // Lock button in header
  btnLockSession.addEventListener('click', () => {
    setToken('');
    showLockScreen();
    showToast('Sesión bloqueada.', 'info');
  });

  // Check auth requirements on boot
  async function checkAuthStatus() {
    try {
      const res = await fetch('/api/auth/status', {
        headers: getAuthHeaders(),
      });
      const data = await res.json();

      if (data.requiresAuth) {
        btnLockSession.style.display = 'inline-flex';
        if (!data.authenticated) {
          showLockScreen();
          return false;
        }
      } else {
        btnLockSession.style.display = 'none';
        hideLockScreen();
      }
      return true;
    } catch (err) {
      console.error('Error checking auth:', err);
      return false;
    }
  }

  // Helpers
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function formatDate(isoStr) {
    if (!isoStr) return '-';
    const d = new Date(isoStr);
    return d.toLocaleString('es-ES', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 4500);
  }

  // Tab Switching
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      tab.classList.add('active');
      const target = document.getElementById(tab.dataset.tab);
      if (target) target.classList.add('active');
    });
  });

  // DB Type port switch
  dbTypeSelect.addEventListener('change', () => {
    if (dbTypeSelect.value === 'mysql') {
      if (dbPortInput.value === '5432') dbPortInput.value = '3306';
    } else {
      if (dbPortInput.value === '3306') dbPortInput.value = '5432';
    }
  });

  // Google Drive Auth switcher
  gdriveAuthType.addEventListener('change', () => {
    if (gdriveAuthType.value === 'service_account') {
      sectionSaJson.style.display = 'block';
      sectionOauth.style.display = 'none';
    } else {
      sectionSaJson.style.display = 'none';
      sectionOauth.style.display = 'block';
    }
  });

  // Setup OAuth redirect URI input
  if (oauthRedirectUri) {
    oauthRedirectUri.value = `${window.location.origin}/api/gdrive/oauth/callback`;
  }

  // Copy OAuth redirect URI
  if (btnCopyRedirectUri) {
    btnCopyRedirectUri.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(oauthRedirectUri.value);
        showToast('URI copiada al portapapeles. Pégala en Google Cloud Console.', 'success');
      } catch (err) {
        oauthRedirectUri.select();
        document.execCommand('copy');
        showToast('URI copiada al portapapeles.', 'success');
      }
    });
  }

  // 1-Click OAuth Connect with Google
  if (btnOauthConnect) {
    btnOauthConnect.addEventListener('click', async () => {
      const clientId = gdriveClientId.value.trim();
      const clientSecret = gdriveClientSecret.value.trim();
      const folderId = gdriveFolderId.value.trim() || 'root';
      const redirectUri = oauthRedirectUri.value;

      if (!clientId) {
        showToast('Por favor introduce tu Client ID antes de conectar.', 'error');
        gdriveClientId.focus();
        return;
      }

      try {
        btnOauthConnect.disabled = true;
        btnOauthConnect.textContent = 'Iniciando autorización...';

        const res = await authFetch('/api/gdrive/oauth/url', {
          method: 'POST',
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            folder_id: folderId,
          }),
        });
        const json = await res.json();
        if (json.success && json.url) {
          const width = 600, height = 700;
          const left = window.screen.width / 2 - width / 2;
          const top = window.screen.height / 2 - height / 2;
          window.open(
            json.url,
            'google_oauth_popup',
            `width=${width},height=${height},top=${top},left=${left},status=no,resizable=yes`
          );
          showToast('Ventana de Google abierta. Selecciona tu cuenta y concede permisos.', 'info');
        } else {
          showToast('Error al preparar OAuth: ' + (json.error || 'Desconocido'), 'error');
        }
      } catch (err) {
        showToast('Error de conexión: ' + err.message, 'error');
      } finally {
        btnOauthConnect.disabled = false;
        btnOauthConnect.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/>
          </svg>
          Conectar con Google (1 Clic)
        `;
      }
    });
  }

  // Listen for popup callback message
  window.addEventListener('message', async (event) => {
    if (event.data && event.data.type === 'GDRIVE_OAUTH_SUCCESS') {
      if (oauthTokenStatus) {
        oauthTokenStatus.className = 'badge badge-success';
        oauthTokenStatus.textContent = 'Token Vinculado';
      }
      gdriveRefreshToken.placeholder = '•••••••••••••••• (Token Activo)';
      showToast('🎉 ¡Google Drive conectado exitosamente con tu cuenta personal!', 'success');
      await fetchGDriveConfig();
      await fetchStatus();
    }
  });

  // API Calls
  async function fetchStatus() {
    try {
      const res = await authFetch('/api/status');
      const data = await res.json();
      if (!data.success) return;

      statTotalBackups.textContent = data.stats.totalBackups;
      statSuccessRate.textContent = `Tasa de éxito: ${data.stats.successRate}% (${data.stats.successfulBackups} exitosos)`;
      statTotalBytes.textContent = formatBytes(data.stats.totalBytesUploaded);
      statCronSchedule.textContent = data.scheduler.activeSchedule;
      statTestPassRate.textContent = `${data.stats.testPassRate}%`;
      statTestCount.textContent = `${data.stats.totalRestoreTests} pruebas (${data.stats.passedRestoreTests} aprobadas)`;

      if (data.hasDriveConfig) {
        badgeDriveStatus.className = 'badge badge-success';
        badgeDriveStatus.innerHTML = '<span class="pulse-dot"></span> Google Drive Conectado';
      } else {
        badgeDriveStatus.className = 'badge badge-warning';
        badgeDriveStatus.innerHTML = '<span class="pulse-dot"></span> Configurar Google Drive';
      }
    } catch (err) {
      console.error('Error fetching status:', err);
    }
  }

  async function fetchDatabases() {
    try {
      const res = await authFetch('/api/db-configs');
      const json = await res.json();
      if (!json.success) return;

      const dbs = json.data;
      // Populate select dropdown
      selectDbManual.innerHTML = '<option value="">Seleccionar BD...</option>';
      dbs.forEach(db => {
        const opt = document.createElement('option');
        opt.value = db.id;
        opt.textContent = `${db.name} (${db.type.toUpperCase()} - ${db.database_name})`;
        selectDbManual.appendChild(opt);
      });

      // Populate Table
      if (dbs.length === 0) {
        tableDbsBody.innerHTML = `
          <tr>
            <td colspan="9" style="text-align: center; color: var(--text-muted); padding: 2rem;">
              No hay bases de datos configuradas todavía. Haz clic en "Agregar Base de Datos".
            </td>
          </tr>
        `;
        return;
      }

      tableDbsBody.innerHTML = dbs.map(db => `
        <tr>
          <td><strong>${db.name}</strong></td>
          <td><span class="badge ${db.type === 'postgres' ? 'badge-stream' : 'badge-warning'}">${db.type.toUpperCase()}</span></td>
          <td class="mono-cell">${db.host}:${db.port}</td>
          <td><code>${db.database_name}</code></td>
          <td>${db.username}</td>
          <td>${db.ssl ? '✅ Sí' : '❌ No'}</td>
          <td>${formatDate(db.last_tested_at)}</td>
          <td>
            ${db.test_status === 'SUCCESS' ? '<span class="badge badge-success">Conectado</span>' :
              db.test_status === 'FAILED' ? `<span class="badge badge-danger" title="${db.test_error || ''}">Error</span>` :
              '<span class="badge badge-warning">Sin probar</span>'}
          </td>
          <td>
            <div style="display: flex; gap: 0.4rem;">
              <button class="btn btn-secondary btn-sm btn-edit-db" data-id="${db.id}">Editar</button>
              <button class="btn btn-danger btn-sm btn-delete-db" data-id="${db.id}">Eliminar</button>
            </div>
          </td>
        </tr>
      `).join('');

      // Add listeners to actions
      document.querySelectorAll('.btn-edit-db').forEach(btn => {
        btn.addEventListener('click', () => editDb(btn.dataset.id));
      });
      document.querySelectorAll('.btn-delete-db').forEach(btn => {
        btn.addEventListener('click', () => deleteDb(btn.dataset.id));
      });
    } catch (err) {
      console.error('Error fetching databases:', err);
    }
  }

  async function fetchBackups() {
    try {
      const res = await authFetch('/api/backups?limit=50');
      const json = await res.json();
      if (!json.success) return;

      const backups = json.data;
      if (backups.length === 0) {
        tableBackupsBody.innerHTML = `
          <tr>
            <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 2rem;">
              Aún no se han generado copias de seguridad. Usa "Ejecutar Copia Ahora" para iniciar la primera transmisión.
            </td>
          </tr>
        `;
        return;
      }

      tableBackupsBody.innerHTML = backups.map(b => `
        <tr>
          <td><strong>${b.database_name}</strong> <span class="badge ${b.db_type === 'postgres' ? 'badge-stream' : 'badge-warning'} btn-sm">${b.db_type.toUpperCase()}</span></td>
          <td class="mono-cell">${b.filename}</td>
          <td><strong>${formatBytes(b.size_bytes)}</strong></td>
          <td>${b.duration_ms ? (b.duration_ms / 1000).toFixed(1) + 's' : '-'}</td>
          <td>
            ${b.status === 'SUCCESS' ? '<span class="badge badge-success">Subido a Drive</span>' :
              b.status === 'STREAMING' ? '<span class="badge badge-stream"><span class="pulse-dot"></span> Transmitiendo...</span>' :
              `<span class="badge badge-danger" title="${b.error_message || ''}">Falló</span>`}
          </td>
          <td class="mono-cell" title="${b.checksum_sha256 || ''}">
            ${b.checksum_sha256 ? b.checksum_sha256.substring(0, 10) + '...' : '-'}
          </td>
          <td>${formatDate(b.created_at)}</td>
          <td>
            <div style="display: flex; gap: 0.4rem;">
              ${b.gdrive_file_id ? `
                <a href="${b.gdrive_url || `https://drive.google.com/file/d/${b.gdrive_file_id}/view`}" target="_blank" class="btn btn-secondary btn-sm" title="Abrir en Google Drive">
                  Drive ↗
                </a>
                <button class="btn btn-primary btn-sm btn-verify-backup" data-id="${b.id}" title="Verificar Integridad & Restauración">
                  Auditar
                </button>
              ` : '-'}
            </div>
          </td>
        </tr>
      `).join('');

      document.querySelectorAll('.btn-verify-backup').forEach(btn => {
        btn.addEventListener('click', () => triggerIntegrityTest(btn.dataset.id));
      });
    } catch (err) {
      console.error('Error fetching backups:', err);
    }
  }

  async function fetchRestoreTests() {
    try {
      const res = await authFetch('/api/restore-tests?limit=50');
      const json = await res.json();
      if (!json.success) return;

      const tests = json.data;
      if (tests.length === 0) {
        tableTestsBody.innerHTML = `
          <tr>
            <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 2rem;">
              No se han ejecutado pruebas de integridad aún.
            </td>
          </tr>
        `;
        return;
      }

      tableTestsBody.innerHTML = tests.map(t => `
        <tr>
          <td>#${t.id}</td>
          <td class="mono-cell">${t.filename || `Backup #${t.backup_history_id}`}</td>
          <td><span class="badge badge-stream">${t.test_type}</span></td>
          <td>
            ${t.status === 'PASSED' ? '<span class="badge badge-success">100% Íntegro</span>' :
              t.status === 'RUNNING' ? '<span class="badge badge-stream"><span class="pulse-dot"></span> Ejecutando...</span>' :
              `<span class="badge badge-danger" title="${t.error_message || ''}">Falló</span>`}
          </td>
          <td><strong>${t.tables_verified || 0}</strong> tablas</td>
          <td>${t.duration_ms ? (t.duration_ms / 1000).toFixed(1) + 's' : '-'}</td>
          <td>${formatDate(t.created_at)}</td>
          <td>
            <button class="btn btn-secondary btn-sm btn-view-logs" data-id="${t.id}" data-logs="${encodeURIComponent(t.logs || t.error_message || '')}">
              Ver Registros
            </button>
          </td>
        </tr>
      `).join('');

      document.querySelectorAll('.btn-view-logs').forEach(btn => {
        btn.addEventListener('click', () => {
          const raw = decodeURIComponent(btn.dataset.logs);
          logsContent.textContent = raw || 'No hay registros detallados disponibles.';
          modalLogs.classList.add('open');
        });
      });
    } catch (err) {
      console.error('Error fetching restore tests:', err);
    }
  }

  async function fetchGDriveConfig() {
    try {
      const res = await authFetch('/api/gdrive-config');
      const json = await res.json();
      if (json.success && json.data) {
        const d = json.data;
        gdriveAuthType.value = d.auth_type || 'oauth';
        gdriveFolderId.value = d.folder_id || '';
        if (d.client_id) gdriveClientId.value = d.client_id;
        if (d.has_client_secret) gdriveClientSecret.placeholder = '•••••••••••••••• (Configurado)';
        if (d.has_oauth) {
          if (oauthTokenStatus) {
            oauthTokenStatus.className = 'badge badge-success';
            oauthTokenStatus.textContent = 'Token Vinculado';
          }
          gdriveRefreshToken.placeholder = '•••••••••••••••• (Token Activo)';
        } else {
          if (oauthTokenStatus) {
            oauthTokenStatus.className = 'badge badge-secondary';
            oauthTokenStatus.textContent = 'Sin Token';
          }
        }

        if (d.auth_type === 'service_account') {
          sectionSaJson.style.display = 'block';
          sectionOauth.style.display = 'none';
        } else {
          sectionSaJson.style.display = 'none';
          sectionOauth.style.display = 'block';
        }
      }
    } catch (err) {
      console.error('Error fetching Google Drive config:', err);
    }
  }

  async function refreshAll() {
    try {
      await Promise.all([
        fetchStatus(),
        fetchDatabases(),
        fetchBackups(),
        fetchRestoreTests(),
        fetchGDriveConfig()
      ]);
    } catch (e) {}
  }

  // Trigger Manual Backup
  btnTriggerBackup.addEventListener('click', async () => {
    const dbId = selectDbManual.value;
    if (!dbId) {
      showToast('Por favor selecciona una base de datos para respaldar.', 'error');
      return;
    }

    try {
      btnTriggerBackup.disabled = true;
      btnTriggerBackup.innerHTML = '<span class="pulse-dot"></span> Iniciando streaming...';
      showToast('Iniciando transmisión directa a Google Drive...', 'info');

      const res = await authFetch(`/api/backups/trigger/${dbId}`, { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        showToast(json.message, 'success');
        await fetchBackups();
        await fetchStatus();
      } else {
        showToast('Error: ' + json.error, 'error');
      }
    } catch (err) {
      showToast('Error al iniciar copia: ' + err.message, 'error');
    } finally {
      btnTriggerBackup.disabled = false;
      btnTriggerBackup.innerHTML = `
        <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        Ejecutar Copia Ahora
      `;
    }
  });

  // Trigger Integrity Test
  async function triggerIntegrityTest(backupId) {
    try {
      showToast(`Iniciando prueba de integridad para backup #${backupId}...`, 'info');
      const res = await authFetch(`/api/restore-tests/trigger/${backupId}`, { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        showToast('Auditoría iniciada. Revisa la pestaña Pruebas de Restauración.', 'success');
        // Switch to tab
        document.querySelector('[data-tab="tab-integrity"]').click();
        await fetchRestoreTests();
        await fetchStatus();
      } else {
        showToast('Error: ' + json.error, 'error');
      }
    } catch (err) {
      showToast('Error al auditar backup: ' + err.message, 'error');
    }
  }

  // Database Modal Handlers
  btnOpenAddDb.addEventListener('click', () => {
    formDb.reset();
    document.getElementById('db-id').value = '';
    document.getElementById('modal-db-title').textContent = 'Agregar Nueva Base de Datos';
    modalDb.classList.add('open');
  });

  btnCloseDbModal.addEventListener('click', () => modalDb.classList.remove('open'));

  async function editDb(id) {
    try {
      const res = await authFetch('/api/db-configs');
      const json = await res.json();
      const db = json.data.find(d => d.id === Number(id));
      if (!db) return;

      document.getElementById('db-id').value = db.id;
      document.getElementById('db-name').value = db.name;
      document.getElementById('db-type').value = db.type;
      document.getElementById('db-host').value = db.host;
      document.getElementById('db-port').value = db.port;
      document.getElementById('db-database').value = db.database_name;
      document.getElementById('db-user').value = db.username;
      document.getElementById('db-password').value = '';
      document.getElementById('db-ssl').checked = Boolean(db.ssl);

      document.getElementById('modal-db-title').textContent = 'Editar Base de Datos: ' + db.name;
      modalDb.classList.add('open');
    } catch (err) {
      showToast('Error al cargar datos: ' + err.message, 'error');
    }
  }

  async function deleteDb(id) {
    if (!confirm('¿Estás seguro de que deseas eliminar esta configuración de base de datos?')) return;
    try {
      const res = await authFetch(`/api/db-configs/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        showToast('Base de datos eliminada.', 'success');
        await fetchDatabases();
      } else {
        showToast('Error: ' + json.error, 'error');
      }
    } catch (err) {
      showToast('Error al eliminar: ' + err.message, 'error');
    }
  }

  // Save DB Form
  formDb.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('db-id').value;
    const payload = {
      name: document.getElementById('db-name').value,
      type: document.getElementById('db-type').value,
      host: document.getElementById('db-host').value,
      port: parseInt(document.getElementById('db-port').value, 10),
      database_name: document.getElementById('db-database').value,
      username: document.getElementById('db-user').value,
      password: document.getElementById('db-password').value,
      ssl: document.getElementById('db-ssl').checked,
    };

    try {
      const method = id ? 'PUT' : 'POST';
      const url = id ? `/api/db-configs/${id}` : '/api/db-configs';
      const res = await authFetch(url, {
        method,
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (json.success) {
        showToast('Base de datos guardada exitosamente.', 'success');
        modalDb.classList.remove('open');
        await fetchDatabases();
        await fetchStatus();
      } else {
        showToast('Error: ' + json.error, 'error');
      }
    } catch (err) {
      showToast('Error al guardar: ' + err.message, 'error');
    }
  });

  // Test DB Connection
  btnTestDbConn.addEventListener('click', async () => {
    const payload = {
      type: document.getElementById('db-type').value,
      host: document.getElementById('db-host').value,
      port: parseInt(document.getElementById('db-port').value, 10),
      database_name: document.getElementById('db-database').value,
      username: document.getElementById('db-user').value,
      password: document.getElementById('db-password').value,
      ssl: document.getElementById('db-ssl').checked,
    };

    if (!payload.host || !payload.database_name || !payload.username) {
      showToast('Por favor completa los campos principales antes de probar.', 'error');
      return;
    }

    try {
      btnTestDbConn.disabled = true;
      btnTestDbConn.textContent = 'Probando conexión...';
      const res = await authFetch('/api/db-configs/test', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (json.success) {
        showToast(`✅ Conexión exitosa (${json.result.latencyMs}ms)`, 'success');
      } else {
        showToast('❌ Falló la conexión: ' + json.error, 'error');
      }
    } catch (err) {
      showToast('Error al probar: ' + err.message, 'error');
    } finally {
      btnTestDbConn.disabled = false;
      btnTestDbConn.textContent = 'Probar Conexión';
    }
  });

  // Save Google Drive Form
  formGdrive.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      auth_type: gdriveAuthType.value,
      folder_id: gdriveFolderId.value.trim() || 'root',
      service_account_json: gdriveSaJson.value.trim(),
      client_id: gdriveClientId.value.trim(),
      client_secret: gdriveClientSecret.value.trim(),
      refresh_token: gdriveRefreshToken.value.trim(),
    };

    try {
      const res = await authFetch('/api/gdrive-config', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (json.success) {
        showToast('Credenciales de Google Drive guardadas exitosamente.', 'success');
        await fetchGDriveConfig();
        await fetchStatus();
      } else {
        showToast('Error: ' + json.error, 'error');
      }
    } catch (err) {
      showToast('Error al guardar credenciales: ' + err.message, 'error');
    }
  });

  // Test Google Drive
  btnTestGdrive.addEventListener('click', async () => {
    const payload = {
      auth_type: gdriveAuthType.value,
      folder_id: gdriveFolderId.value.trim() || 'root',
      service_account_json: gdriveSaJson.value.trim(),
      client_id: gdriveClientId.value.trim(),
      client_secret: gdriveClientSecret.value.trim(),
      refresh_token: gdriveRefreshToken.value.trim(),
    };

    try {
      btnTestGdrive.disabled = true;
      btnTestGdrive.textContent = 'Verificando Google Drive...';
      const res = await authFetch('/api/gdrive-config/test', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (json.success) {
        showToast(`✅ Conectado a Drive: ${json.result.folderName} (${json.result.account})`, 'success');
        await fetchStatus();
      } else {
        showToast('❌ ' + json.error, 'error');
      }
    } catch (err) {
      showToast('Error al verificar: ' + err.message, 'error');
    } finally {
      btnTestGdrive.disabled = false;
      btnTestGdrive.textContent = 'Probar Conexión con Drive';
    }
  });

  // Logs Modal Close
  btnCloseLogsModal.addEventListener('click', () => modalLogs.classList.remove('open'));
  btnCloseLogs.addEventListener('click', () => modalLogs.classList.remove('open'));

  // Refresh Button
  btnRefresh.addEventListener('click', async () => {
    showToast('Actualizando datos...', 'info');
    await refreshAll();
  });

  // Initial Boot with Auth Verification
  checkAuthStatus().then((authenticated) => {
    if (authenticated) {
      refreshAll();
    }
  });

  // Background Auto-Refresh every 6 seconds if authenticated
  setInterval(() => {
    if (!lockScreenOverlay.classList.contains('hidden')) return;
    fetchStatus();
    fetchBackups();
    fetchRestoreTests();
  }, 6000);
});
