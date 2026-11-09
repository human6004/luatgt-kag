#!/bin/sh
set -eu

if [ -z "${KAG_BROKER_DATABASE_ID:-}" ] && [ -z "${KAG_BROKER_SERVER_ID:-}" ]; then
    exec java "$@"
fi
if [ -z "${KAG_BROKER_DATABASE_ID:-}" ] || [ -z "${KAG_BROKER_SERVER_ID:-}" ]; then
    echo 'Read broker configuration unavailable.' >&2
    exit 1
fi
for secret in "${KAG_BROKER_PASSWORD_FILE:-}" "${KAG_BROKER_TOKEN_FILE:-}"; do
    if [ ! -f "$secret" ] || [ ! -r "$secret" ] || [ -L "$secret" ]; then
        echo 'Read broker configuration unavailable.' >&2
        exit 1
    fi
done

exec python -B - "$@" <<'PY'
import signal
import subprocess
import sys
import time

children = []
def stop(signum, frame):
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    children.append(subprocess.Popen(['java', *sys.argv[1:]]))
    children.append(subprocess.Popen([sys.executable, '-B', '-m', 'kag.http_api.read_broker']))
    while True:
        if any(child.poll() is not None for child in children):
            raise SystemExit(1)
        time.sleep(0.2)
except SystemExit:
    raise
except Exception:
    raise SystemExit('OpenSPG server unavailable.') from None
finally:
    for child in children:
        if child.poll() is None:
            child.terminate()
    deadline = time.monotonic()+5
    for child in children:
        try:
            child.wait(timeout=max(0.01, deadline-time.monotonic()))
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
PY
