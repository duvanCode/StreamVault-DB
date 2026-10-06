# 🚀 StreamVault DB - Streaming Backup & Restore Manager para Google Drive

Servicio automatizado y programado (Cron Job) para realizar copias de seguridad de bases de datos (**PostgreSQL** y **MySQL/MariaDB**) con **transmisión directa por streaming hacia Google Drive (Zero VPS Disk)**, auditoría de integridad y pruebas de restauración, con panel web diseñado con **Stitch** y preparado para despliegue en un clic con **Dokploy**.

---

## 🌟 Características Principales

1. **Streaming Directo a Google Drive (Zero-Disk Overhead)**:
   - Los comandos de volcado (`pg_dump` o `mysqldump`) transmiten directamente sus datos a la salida estándar (`stdout`).
   - Se comprimen en memoria al vuelo con `gzip` (`zlib`).
   - Se suben por fragmentos HTTP directamente a la API v3 de Google Drive.
   - **0 MB de archivos temporales en el disco duro del VPS**, ideal para VPS con almacenamiento limitado (10GB/20GB) sin riesgo de colapso de almacenamiento.

2. **Auditoría & Pruebas de Restauración de Integridad**:
   - **Nivel 1 - Verificación de Flujo & Checksum:** Descarga por streaming y valida el archivo `gzip` y la suma criptográfica SHA-256. Si el archivo está corrupto o incompleto, se detecta de inmediato.
   - **Nivel 2 - Inspección de Catálogo DDL/DML:** Analiza las sentencias SQL (`CREATE TABLE`, `INSERT`, `COPY`) sin guardar en disco para reportar el total de tablas respaldadas.
   - **Nivel 3 - Restauración Sandbox Efímera:** Opcionalmente restaura la copia en un esquema o base de datos temporal (`restore_test_<timestamp>`), valida que las tablas y registros existan, y destruye la base de pruebas automáticamente.

3. **Panel Web Moderno (Diseño Stitch)**:
   - Métricas en tiempo real: Total de respaldos, almacenamiento transferido a Drive, tasa de éxito y tasa de aprobación de pruebas.
   - Configuración visual de bases de datos (Host, Puerto, Base de datos, Usuario, Contraseña, SSL) con botón de **Probar Conexión**.
   - Configuración de Google Drive (Cuenta de Servicio JSON u OAuth2, ID de Carpeta) con botón de **Probar Conexión con Drive**.
   - Historial de respaldos con enlaces directos a Google Drive y disparador de **Auditoría de Integridad**.
   - Visor de registros de auditoría tipo terminal en tiempo real.

4. **Automatización Diaria (Cron)**:
   - Programación configurable mediante sintaxis estándar de Cron (por defecto: `0 2 * * *`, todos los días a las 2:00 AM).
   - Auto-verificación de integridad posterior a cada respaldo automático.

5. **Listo para Dokploy / VPS**:
   - `Dockerfile` basado en Alpine con clientes nativos `postgresql16-client` y `mysql-client`.
   - `docker-compose.yml` preconfigurado con persistencia de datos en `/app/data`.
   - Endpoint de salud `/api/health` para el monitoreo de Dokploy.

---

## 🏗️ Arquitectura de Streaming (Zero VPS Disk)

```
[ Base de Datos ] (PostgreSQL / MySQL)
        │  (stdout stream)
        ▼
   [ pg_dump / mysqldump ]
        │  (pipe en memoria)
        ▼
   [ Compresor Gzip al vuelo ]
        │  (pipe de fragmentos HTTP)
        ▼
[ Google Drive API v3 (files.create) ]
        │
   (Directo a la Nube - 0 bytes en disco local)
```

---

## 📋 Configuración de Google Drive

Para que el servicio pueda subir archivos automáticamente a tu Google Drive sin intervención humana, se recomienda una **Cuenta de Servicio (Service Account)**:

1. Ve a [Google Cloud Console](https://console.cloud.google.com/).
2. Crea un proyecto (o usa uno existente) y habilita la **Google Drive API**.
3. Ve a **IAM y administración > Cuentas de servicio** y crea una nueva cuenta de servicio.
4. En la pestaña **Claves**, crea una nueva clave en formato **JSON** y descárgala.
5. Abre Google Drive en tu navegador, crea una carpeta (ej: `Backups DB`) y copia el **ID de la carpeta** de la URL (`drive.google.com/drive/folders/<ID_DE_CARPETA>`).
6. **Muy Importante:** Comparte esa carpeta de Drive con el correo de la cuenta de servicio (`ejemplo@tu-proyecto.iam.gserviceaccount.com`) otorgándole permisos de **Editor** o **Organizador**.
7. Pega el JSON y el ID de la carpeta en el panel web (pestaña Google Drive) o en el archivo `.env`.

---

## 🚢 Despliegue en VPS con Dokploy

### Opción A: Despliegue con Dokploy (Aplicación Dockerfile)
1. En tu panel de **Dokploy**, crea un nuevo **Proyecto** y añade una **Aplicación**.
2. Conecta tu repositorio de GitHub / Git donde tengas este proyecto.
3. Dokploy detectará automáticamente el archivo `Dockerfile`.
4. En el campo **Port** de la aplicación en Dokploy, coloca el puerto que desees exponer (ej: `3000`, `8080`, `5000`, etc.).
5. En la pestaña **Volúmenes (Volumes)**, crea un volumen persistente:
   - **Nombre / Host Path:** `job_db_data`
   - **Mount Path:** `/app/data`
6. En la pestaña **Environment**, define tus variables (o usa el archivo `.env`):
   ```env
   PORT=3000  # O el puerto que hayas configurado en el campo Port de Dokploy
   BACKUP_CRON=0 2 * * *
   TIMEZONE=America/Bogota
   ACCESS_KEY=clave_segura_de_acceso   # Llave única sin usuario
   GOOGLE_DRIVE_FOLDER_ID=1A2b3C4d5E...
   ```
7. En la pestaña **Dominios (Domains)**, asigna tu subdominio (ej: `backups.tudominio.com`) con HTTPS automático generado por Dokploy/Traefik.
8. Haz clic en **Deploy**. ¡Listo!

### Opción B: Despliegue con Docker Compose
Si prefieres usar la sección **Compose** de Dokploy o correrlo por consola en tu VPS:
```bash
# 1. Clonar repositorio
git clone <tu-repositorio>
cd JOB_DB

# 2. Configurar variables de entorno
cp .env.example .env
nano .env

# 3. Iniciar contenedor
docker compose up -d
```

---

## 💻 Ejecución en Desarrollo Local

```bash
# 1. Instalar dependencias
npm install

# 2. Iniciar servidor
npm start

# 3. Abrir en el navegador
http://localhost:3000
```

---

## 🛡️ Endpoints de la API REST

| Método | Endpoint | Descripción |
|---|---|---|
| `GET` | `/api/health` | Chequeo de salud del servicio (Dokploy Healthcheck) |
| `GET` | `/api/status` | Métricas y estado global del scheduler |
| `GET` | `/api/db-configs` | Listado de bases de datos configuradas |
| `POST` | `/api/db-configs` | Crear nueva configuración de base de datos |
| `POST` | `/api/db-configs/test` | Prueba de conexión a una base de datos |
| `GET` | `/api/gdrive-config` | Ver configuración actual de Google Drive |
| `POST` | `/api/gdrive-config` | Guardar credenciales de Google Drive |
| `POST` | `/api/gdrive-config/test`| Probar acceso y permisos a Google Drive |
| `GET` | `/api/backups` | Historial de copias de seguridad |
| `POST` | `/api/backups/trigger/:dbId` | Disparar copia de seguridad inmediata vía streaming |
| `GET` | `/api/restore-tests` | Historial de auditorías y pruebas de restauración |
| `POST` | `/api/restore-tests/trigger/:backupId` | Disparar prueba de integridad sobre un respaldo |
| `POST` | `/api/settings` | Actualizar cronograma o ajustes de retención |
