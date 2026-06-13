# Deployment Modes

## Production

- `SCRAPING_ENABLED=true`
- `SCHEDULER_ENABLED=true`
- `SCHEDULED_SCRAPE_TIME_LOCAL=06:00`
- `TZ` set to the deployment timezone you want the container to use
- `MIGRATIONS_ENABLED=true` or according to your release policy
- writer database credentials
- `LOG_LEVEL=info`

The daily scheduler uses the backend process local time, so `06:00` means `06:00` in the timezone resolved inside the container. In the provided image and Compose setup, that comes from `TZ` plus Alpine `tzdata`.

Before the first deployment, you can initialize the target database and the read/write plus read-only roles with:

```bash
bash infra/init-db.sh --host localhost --admin-user postgres
```

The script prompts for the application user passwords if you do not pass them explicitly.

## Dev UI Validation

- `SCRAPING_ENABLED=false`
- `SCHEDULER_ENABLED=false`
- `MIGRATIONS_ENABLED=false`
- read-only database credentials
- `LOG_LEVEL=debug`

Use this mode when validating the web UI against real data without affecting the production database.

For this mode, use the read-only credentials created by `infra/init-db.sh`.

## Dev Scrape Sandbox

- `SCRAPING_ENABLED=true`
- `SCHEDULER_ENABLED=false` unless you explicitly want unattended runs
- `MIGRATIONS_ENABLED=true` if the sandbox owns its schema lifecycle
- writer credentials against a clone or temporary database
- `LOG_LEVEL=debug`

Never point a writable dev deployment at the production database.

For this mode, use a cloned or temporary database and the read/write credentials created by `infra/init-db.sh`.
