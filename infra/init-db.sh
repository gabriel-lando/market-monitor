#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash infra/init-db.sh [options]

Creates the market-monitor database plus two login roles:
  - one read/write role intended for migrations and normal app writes
  - one read-only role intended for UI validation or read-only deployments

Connection options use normal libpq environment variables when available:
  PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE

Additional script-specific password environment variables:
  MARKET_MONITOR_ADMIN_PASSWORD
  MARKET_MONITOR_RW_PASSWORD
  MARKET_MONITOR_RO_PASSWORD

Options:
  --host VALUE            PostgreSQL host. Defaults to PGHOST or localhost.
  --port VALUE            PostgreSQL port. Defaults to PGPORT or 5432.
  --admin-user VALUE      Admin user used to create roles and database. Defaults to PGUSER or postgres.
  --admin-db VALUE        Maintenance database to connect to. Defaults to PGDATABASE or postgres.
  --admin-password VALUE  Password for the admin user. If omitted, the script prompts securely unless provided by env.
  --db-name VALUE         Database name to create. Defaults to market_monitor.
  --rw-user VALUE         Read/write role name. Defaults to market_monitor_rw.
  --ro-user VALUE         Read-only role name. Defaults to market_monitor_ro.
  --rw-password VALUE     Password for the read/write role. If omitted, the script prompts securely.
  --ro-password VALUE     Password for the read-only role. If omitted, the script prompts securely.
  --help                  Show this help text.

Examples:
  bash infra/init-db.sh --host localhost --admin-user postgres
  bash infra/init-db.sh --db-name market_monitor_dev --rw-user mm_dev_rw --ro-user mm_dev_ro

Notes:
  - This script only grants privileges on the target database.
  - PostgreSQL may still allow these roles to connect to other databases if those databases grant CONNECT to PUBLIC.
    Tight "only this database" access across the whole server may require additional database ACL or pg_hba changes.
EOF
}

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 1
  fi
}

prompt_password() {
  local prompt_text="$1"
  local password

  while true; do
    read -rsp "$prompt_text: " password
    echo
    if [[ -n "$password" ]]; then
      printf '%s' "$password"
      return
    fi
    echo "Password cannot be empty." >&2
  done
}

psql_exec() {
  local database="$1"
  shift

  PGPASSWORD="${ADMIN_PASSWORD:-${PGPASSWORD:-}}" psql \
    --host "$HOST" \
    --port "$PORT" \
    --username "$ADMIN_USER" \
    --dbname "$database" \
    --no-password \
    --set ON_ERROR_STOP=1 \
    "$@"
}

HOST="${PGHOST:-localhost}"
PORT="${PGPORT:-5432}"
ADMIN_USER="${PGUSER:-postgres}"
ADMIN_DB="${PGDATABASE:-postgres}"
DB_NAME="market_monitor"
RW_USER="market_monitor_rw"
RO_USER="market_monitor_ro"
RW_PASSWORD="${MARKET_MONITOR_RW_PASSWORD:-}"
RO_PASSWORD="${MARKET_MONITOR_RO_PASSWORD:-}"
ADMIN_PASSWORD="${MARKET_MONITOR_ADMIN_PASSWORD:-${PGPASSWORD:-}}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      HOST="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --admin-user)
      ADMIN_USER="$2"
      shift 2
      ;;
    --admin-db)
      ADMIN_DB="$2"
      shift 2
      ;;
    --admin-password)
      ADMIN_PASSWORD="$2"
      shift 2
      ;;
    --db-name)
      DB_NAME="$2"
      shift 2
      ;;
    --rw-user)
      RW_USER="$2"
      shift 2
      ;;
    --ro-user)
      RO_USER="$2"
      shift 2
      ;;
    --rw-password)
      RW_PASSWORD="$2"
      shift 2
      ;;
    --ro-password)
      RO_PASSWORD="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_command psql

if [[ -z "$ADMIN_PASSWORD" ]]; then
  ADMIN_PASSWORD="$(prompt_password "Enter password for admin user ${ADMIN_USER}")"
fi

if [[ -z "$RW_PASSWORD" ]]; then
  RW_PASSWORD="$(prompt_password "Enter password for ${RW_USER}")"
fi

if [[ -z "$RO_PASSWORD" ]]; then
  RO_PASSWORD="$(prompt_password "Enter password for ${RO_USER}")"
fi

echo "Creating or updating roles ${RW_USER} and ${RO_USER}, and database ${DB_NAME}."

psql_exec "$ADMIN_DB" \
  --set=db_name="$DB_NAME" \
  --set=rw_user="$RW_USER" \
  --set=rw_password="$RW_PASSWORD" \
  --set=ro_user="$RO_USER" \
  --set=ro_password="$RO_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', :'rw_user', :'rw_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'rw_user')
\gexec

SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', :'rw_user', :'rw_password')
\gexec

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', :'ro_user', :'ro_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'ro_user')
\gexec

SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', :'ro_user', :'ro_password')
\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'db_name', :'rw_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name')
\gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', :'db_name', :'rw_user')
\gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db_name')
\gexec

SELECT format('GRANT CONNECT, TEMP ON DATABASE %I TO %I', :'db_name', :'rw_user')
\gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'ro_user')
\gexec
SQL

psql_exec "$DB_NAME" \
  --set=db_name="$DB_NAME" \
  --set=rw_user="$RW_USER" \
  --set=ro_user="$RO_USER" <<'SQL'
SELECT format('ALTER SCHEMA public OWNER TO %I', :'rw_user')
\gexec

REVOKE ALL ON SCHEMA public FROM PUBLIC;

SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'rw_user')
\gexec

SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'ro_user')
\gexec

SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO %I', :'rw_user')
\gexec

SELECT format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I', :'rw_user')
\gexec

SELECT format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', :'rw_user')
\gexec

SELECT format('GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I', :'ro_user')
\gexec

SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'ro_user')
\gexec

SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO %I', :'rw_user', :'rw_user')
\gexec

SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', :'rw_user', :'rw_user')
\gexec

SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I', :'rw_user', :'rw_user')
\gexec

SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON TABLES TO %I', :'rw_user', :'ro_user')
\gexec

SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', :'rw_user', :'ro_user')
\gexec
SQL

cat <<EOF

Database initialization completed.

Database:
  name: ${DB_NAME}

Roles:
  read/write: ${RW_USER}
  read-only:  ${RO_USER}

Suggested connection strings:
  writer: postgresql://${RW_USER}:***@${HOST}:${PORT}/${DB_NAME}
  reader: postgresql://${RO_USER}:***@${HOST}:${PORT}/${DB_NAME}

Important:
  These roles now have privileges only on ${DB_NAME}. If you need to prevent them from connecting to any other existing databases on the same PostgreSQL instance, you may also need to adjust database CONNECT privileges or pg_hba.conf at the server level.
EOF