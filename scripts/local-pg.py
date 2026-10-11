"""Bundled local Postgres for development — no admin rights, no Docker needed.

Usage (from yzh-backend-pro, keep the terminal open):
    npm run db:start

What it does:
  1. Starts a user-space PostgreSQL (via the `pgserver` pip package) with
     data in %LOCALAPPDATA%/yzh-isai-pgdata (survives reboots).
  2. Ensures the `yzh_music` database exists.
  3. Points DATABASE_URL in `.env` at it, so `prisma migrate dev` and
     `npm start` just work.

Stop with Ctrl+C — the server shuts down cleanly.

One-time setup:  pip install pgserver
"""
import pathlib
import re
import sys
import time
import urllib.parse

try:
    import pgserver
except ImportError:
    print('pgserver is not installed. Run:  pip install pgserver', flush=True)
    sys.exit(1)

BACKEND_ENV = pathlib.Path(__file__).resolve().parent.parent / '.env'


def main() -> None:
    data_home = pathlib.Path.home() / 'AppData' / 'Local' / 'yzh-isai-pgdata'
    data_home.mkdir(parents=True, exist_ok=True)
    srv = pgserver.PostgresServer(data_home)
    srv.ensure_pgdata_inited()
    srv.ensure_postgres_running()
    uri = srv.get_uri()
    print('local Postgres is up: ' + uri, flush=True)

    try:
        srv.psql('CREATE DATABASE yzh_music')
        print('created database yzh_music', flush=True)
    except Exception as e:
        if 'already exists' in str(e):
            print('database yzh_music already exists', flush=True)
        else:
            raise

    parts = urllib.parse.urlsplit(uri)
    db_uri = urllib.parse.urlunsplit(
        (parts.scheme, parts.netloc, '/yzh_music', 'schema=public', '')
    )
    lines = BACKEND_ENV.read_text().splitlines() if BACKEND_ENV.exists() else []
    seen = False
    for i, line in enumerate(lines):
        if line.startswith('DATABASE_URL='):
            lines[i] = 'DATABASE_URL="' + db_uri + '"'
            seen = True
    if not seen:
        lines.append('DATABASE_URL="' + db_uri + '"')
    BACKEND_ENV.write_text('\n'.join(lines) + '\n')
    print('wrote DATABASE_URL to .env — run `npx prisma migrate dev`, then `npm start`', flush=True)
    print('leave this terminal open; Ctrl+C stops Postgres', flush=True)
    while True:
        time.sleep(3600)


if __name__ == '__main__':
    main()
