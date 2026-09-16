#!/usr/bin/env python3
"""Genera las llaves JWT de Supabase (anon / service_role) para LiTT.

Las llaves son JWT HS256 firmados con JWT_SECRET (el mismo que usa gotrue).
Patrón de payload idéntico al del fixture de aceptación (role/iss/iat/exp);
en producción la vigencia es de 10 años.

Uso:
    JWT_SECRET=<hex> python3 supabase-jwt.py anon
    JWT_SECRET=<hex> python3 supabase-jwt.py service_role
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import time


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in ("anon", "service_role"):
        print("uso: JWT_SECRET=<hex> python3 supabase-jwt.py anon|service_role", file=sys.stderr)
        return 2
    secret = os.environ.get("JWT_SECRET", "")
    if len(secret) < 32:
        print("JWT_SECRET ausente o demasiado corto (<32 chars)", file=sys.stderr)
        return 2
    now = int(time.time())
    body = b64(b'{"alg":"HS256","typ":"JWT"}') + "." + b64(
        json.dumps(
            {"role": sys.argv[1], "iss": "supabase", "iat": now, "exp": now + 315360000}
        ).encode()
    )
    signature = hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()
    print(body + "." + b64(signature))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
