"""Bundled local Postgres for development — no admin rights, no Docker needed.

Usage (from yzh-backend-pro, after every machine reboot):
    npm run db:start

What it does:
  1. Starts the user-space PostgreSQL in %LOCALAPPDATA%/yzh-isai-pgdata
     on 127.0.0.1:5433 (stable port, configured in postgresql.conf).
  2. Ensures the `yzh_music` database exists.
  3. Points DATABASE_URL in `.env` at it, so `npx prisma migrate dev`
     and `npm start` just work.

The server is started detached and keeps running after this exits.

One-time setup:  pip install pgserver  (only used for its binaries)
"""
import os
import pathlib
import socket
import subprocess
import sys
import time

PGDATA = pathlib.Path.home() / 'AppData' / 'Local' / 'yzh-isai-pgdata'
PORT = 5433
BACKEND_ENV = pathlib.Path(__file__).resolve().parent.parent / '.env'


def pg_bindir() -> pathlib.Path:
    try:
        import pgserver

        candidate = pathlib.Path(pgserver.__file__).parent / 'pginstall'
        if (candidate / 'bin' / 'pg_ctl.exe').exists():
            return candidate / 'bin'
        if (candidate / 'pg_ctl.exe').exists():
            return candidate
    except Exception as e:
        raise SystemExit(f'pgserver binaries not found ({e}). Run:  pip install pgserver')
    raise SystemExit('pgserver binaries not found. Run:  pip install pgserver')


def tcp_open() -> bool:
    try:
        s = socket.create_connection(('127.0.0.1', PORT), timeout=2)
        s.close()
        return True
    except OSError:
        return False


def main() -> None:
    bindir = pg_bindir()
    if tcp_open():
        print(f'Postgres already up on 127.0.0.1:{PORT}', flush=True)
    else:
        subprocess.run(
            [str(bindir / 'pg_ctl.exe'), '-D', str(PGDATA),
             '-l', str(pathlib.Path.home() / 'AppData' / 'Local' / 'Temp' / 'yzh-pg.log'),
             '-o', '-h "127.0.0.1"', 'start'],
            check=False,
        )
        for _ in range(30):
            if tcp_open():
                break
            time.sleep(1)
        if not tcp_open():
            raise SystemExit('Postgres did not start — see %TEMP%\\yzh-pg.log')
        print(f'Postgres started on 127.0.0.1:{PORT}', flush=True)

    env = dict(os.environ, PGPASSWORD='')
    r = subprocess.run(
        [str(bindir / 'psql.exe'), '-h', '127.0.0.1', '-p', str(PORT),
         '-U', 'postgres', '-d', 'postgres', '-c', 'CREATE DATABASE yzh_music'],
        env=env, capture_output=True, text=True,
    )
    if 'already exists' in (r.stderr or ''):
        print('database yzh_music already exists', flush=True)
    elif r.returncode == 0:
        print('created database yzh_music', flush=True)
    else:
        print('db ensure note:', (r.stderr or '').strip()[:200], flush=True)

    db_uri = f'postgresql://postgres:@127.0.0.1:{PORT}/yzh_music?schema=public'
    lines = BACKEND_ENV.read_text().splitlines() if BACKEND_ENV.exists() else []
    seen = False
    for i, line in enumerate(lines):
        if line.startswith('DATABASE_URL='):
            lines[i] = 'DATABASE_URL="' + db_uri + '"'
            seen = True
    if not seen:
        lines.append('DATABASE_URL="' + db_uri + '"')
    BACKEND_ENV.write_text('\n'.join(lines) + '\n')
    print('wrote DATABASE_URL to .env', flush=True)


if __name__ == '__main__':
    main()
