const cron = require('node-cron');
const storage = require('../db/storage');
const config = require('../config');
const DatabaseStreamer = require('./streamer');
const RestoreTestService = require('./restoreTest');

class SchedulerService {
  constructor() {
    this.cronTask = null;
    this.currentSchedule = config.BACKUP_CRON;
    this.isExecuting = false;
  }

  /**
   * Initializes the cron scheduler
   */
  start() {
    const savedCron = storage.getSetting('cron_schedule', config.BACKUP_CRON);
    this.reschedule(savedCron);
    console.log(`[Scheduler] Automated backup job scheduled with pattern: "${this.currentSchedule}" (timezone: ${config.TIMEZONE})`);
  }

  /**
   * Reschedules the cron job with a new expression
   */
  reschedule(newCronExpression) {
    if (!cron.validate(newCronExpression)) {
      throw new Error(`Invalid cron expression format: "${newCronExpression}"`);
    }

    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
    }

    this.currentSchedule = newCronExpression;
    storage.setSetting('cron_schedule', newCronExpression);

    this.cronTask = cron.schedule(
      newCronExpression,
      async () => {
        await this.runScheduledBackups();
      },
      {
        timezone: config.TIMEZONE,
      }
    );

    return {
      schedule: this.currentSchedule,
      nextRun: this.getNextRun(),
    };
  }

  /**
   * Runs backup cycle for all active configured databases
   */
  async runScheduledBackups() {
    if (this.isExecuting) {
      console.warn('[Scheduler] Previous scheduled backup job is still running. Skipping iteration.');
      return;
    }

    this.isExecuting = true;
    console.log(`[Scheduler] Starting scheduled automated backup run at ${new Date().toISOString()}...`);

    try {
      const activeDbs = storage.getDbConfigs().filter(d => d.is_active);
      if (activeDbs.length === 0) {
        console.log('[Scheduler] No active database configurations found to back up.');
        return;
      }

      const autoVerify = storage.getSetting('auto_verify_integrity', 'true') === 'true';

      for (const db of activeDbs) {
        console.log(`[Scheduler] Processing automated backup for: ${db.name} (${db.database_name})...`);
        try {
          const result = await DatabaseStreamer.streamBackup(db.id);
          console.log(`[Scheduler] Backup completed for ${db.name}: fileId=${result.fileId}`);

          if (autoVerify && result.id) {
            console.log(`[Scheduler] Auto-integrity verification starting for backup #${result.id}...`);
            try {
              await RestoreTestService.verifyBackupIntegrity(result.id);
              console.log(`[Scheduler] Auto-integrity verification PASSED for backup #${result.id}.`);
            } catch (vErr) {
              console.error(`[Scheduler] Auto-integrity verification FAILED for backup #${result.id}:`, vErr.message);
            }
          }
        } catch (err) {
          console.error(`[Scheduler] Error running scheduled backup for ${db.name}:`, err.message);
        }
      }
    } finally {
      this.isExecuting = false;
      console.log(`[Scheduler] Scheduled backup cycle completed at ${new Date().toISOString()}.`);
    }
  }

  /**
   * Calculates next run human-readable description
   */
  getNextRun() {
    // Basic approximation / description
    return `Active on cron: ${this.currentSchedule}`;
  }
}

module.exports = new SchedulerService();
