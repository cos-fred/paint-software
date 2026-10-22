# Backup and recovery

The application creates a verified snapshot at normal startup and every hour. Automatic jobs do not run in NODE_ENV=test. Back Up Now and Download Backup are administrator-only controls. A successful local backup does not prove that an independent copy exists; check both timestamps in Settings.

Set BACKUP_DIR to a writable persistent directory. Default: a backups folder next to DB_PATH. BACKUP_KEEP defaults to 168, and accepts 2–1000. Pruning only touches files matching the application's own snapshot naming pattern; unrelated files are preserved.

## Encryption and independent copies

Generate a 32-byte encryption key using node -e "console.log(require('crypto').randomBytes(32).toString('hex'))". Save its 64-character hexadecimal output as BACKUP_ENCRYPTION_KEY in the server environment and in a separate password manager. Backups then use AES-256-GCM and have a .db.enc extension. Losing the key makes encrypted backups unrecoverable. Authentication tags detect a wrong key or modified contents.

Choose either or both:

- BACKUP_MIRROR_DIR: an independently mounted backup destination outside BACKUP_DIR. The app copies a verified encrypted snapshot there once per UTC day and keeps 30 daily files. A different directory on the same disk does not provide independent recovery.
- BACKUP_REMOTE_URL: an HTTPS endpoint accepting an authenticated PUT of the encrypted snapshot. BACKUP_REMOTE_TOKEN is sent as an Authorization: Bearer header. X-Backup-Filename identifies the snapshot; the receiver must store versions and enforce retention. A generic S3 bucket URL is not sufficient unless a compatible authenticated receiver is configured.

Uploads do not follow redirects and the destination must resolve only to public addresses. If WEBHOOK_ALLOWED_HOSTS is set, include the backup endpoint's exact hostname. A pre-reset or manual backup forces an independent copy even if today's copy already succeeded. Backups are single-flight to avoid overlapping writes. No independent destination is configured by default; choose and verify it when hosting is arranged.

## Restore procedure

1. Stop the application before switching any active database. Keep the old database and its WAL/SHM files together for investigation. Do not copy only an active SQLite main file as a backup.
2. Obtain a verified .db or .db.enc snapshot. For encrypted files, set BACKUP_ENCRYPTION_KEY to the key used when that snapshot was created.
3. Run npm run restore -- PATH-TO-BACKUP PATH-TO-NEW-DATABASE. The destination must not exist, nor may its WAL/SHM files exist. The command never overwrites an existing database.
4. The tool decrypts if necessary, checks SQLite integrity, checks foreign keys and verifies required application tables. An invalid snapshot is rejected.
5. With the app still stopped, point DB_PATH to that new file, then start the app. Check login, stock counts, recent sales and net revenue before admitting users.
6. After recovery, make and verify a new backup. Investigate any original failure before deleting retained evidence.

An automated test restores snapshots, reads records from the restored database, rejects damaged/wrong-key files, checks retention and exercises the CLI. The API concurrency tests also verify that a sale and complete reversal restore exactly the original stock. Off-server disaster recovery still depends on the actual destination being configured and tested after deployment.

## Failure handling

Failures appear in server logs, the Settings backup panel and a system alert. If a backup fails, check free disk space, permissions, the encryption key format, destination access and any upload endpoint response. Local backups can succeed while the independent upload fails; both states are visible. A failed required pre-reset snapshot prevents reset. For an hourly schedule, an unrecoverable machine loss can still lose work since the most recent independent copy; choose more frequent independent copies if that recovery window is too large.
