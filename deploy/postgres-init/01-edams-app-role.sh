#!/bin/sh
# Runs once on first Postgres data-directory init (docker-entrypoint-initdb.d).
# Creates the least-privilege application role the API/worker connect as.
# Object-level grants + RLS policies come from the migrations (see
# 20260717000002-rls-app-role-sequence-update.sql and friends), which run as
# the postgres superuser via the `migrate` one-shot service.
set -eu

: "${EDAMS_APP_DB_PASSWORD:?EDAMS_APP_DB_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	DO \$\$
	BEGIN
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'edams_app') THEN
	    CREATE ROLE edams_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
	      PASSWORD '$(printf %s "$EDAMS_APP_DB_PASSWORD" | sed "s/'/''/g")';
	  END IF;
	END
	\$\$;
	GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO edams_app;
	GRANT USAGE ON SCHEMA public TO edams_app;
EOSQL

echo "edams_app role ready"
