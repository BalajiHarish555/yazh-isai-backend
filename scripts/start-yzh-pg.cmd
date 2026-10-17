@echo off
REM Auto-start the user-space dev Postgres (port 5433) at user logon.
REM Idempotent: pg_ctl reports "already running" and exits if the DB is up.
"C:\Users\haris\AppData\Roaming\Python\Python312\site-packages\pgserver\pginstall\bin\pg_ctl.exe" -D "C:\Users\haris\AppData\Local\yzh-isai-pgdata" -l "C:\Users\haris\AppData\Local\Temp\yzh-pg.log" -o "-h 127.0.0.1" start
