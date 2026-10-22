# Deployment preparation — deferred

Deployment has not been performed. The app is prepared for one Node.js 24 application instance with persistent SQLite storage. The supported runtime is pinned in package.json, .nvmrc, Dockerfile and nixpacks.toml.

When hosting is chosen:

1. Run npm ci, npm audit --omit=dev, npm test and npm run test:browser on Node 24.
2. Use the Dockerfile or the documented Node runtime. It uses npm ci and runs as a non-root user.
3. Attach persistent storage at /data. Keep one application instance and one SQLite file on that storage. Do not use ephemeral or shared network storage for the running database.
4. Set NODE_ENV=production, DB_PATH=/data/paint_inventory.db, BACKUP_DIR=/data/backups, a strong JWT_SECRET and the initial ADMIN_PASSWORD. Configure the real HTTPS origin in CORS_ORIGIN and TRUST_PROXY=1 only behind a trusted reverse proxy.
5. Arrange an independent encrypted backup destination and verify a restore. See docs/RECOVERY.md. Local snapshots alone are not off-server recovery.
6. Enable HTTPS, automatic process restart, external health checks for /api/health, storage monitoring and hosting budget alerts. No paid service, monitoring subscription or destination is provisioned by these code changes.
7. Start with a fresh production database instead of uploading disposable development data. Create individual staff users and enter verified opening inventory.
8. Confirm that restart and redeploy preserve records, staff permissions work, simultaneous last-stock sales are safe, and backup health is green. Schedule updates outside trading hours: a single-instance setup may have short deployment downtime.

Leave ALLOW_SYSTEM_RESET unset in production. Keep credentials and database files out of the repository. A custom domain is optional. Choose a hosting service with persistent disks/volumes; free ephemeral services are unsuitable for this SQLite deployment. PostgreSQL migration is not necessary for the expected five-user workload and has not been implemented.
