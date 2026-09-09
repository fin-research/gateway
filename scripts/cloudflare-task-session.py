"""Short-lived MCP provisioning credential, kept only in process memory.

Reads the account Root Token from Keychain solely for token management. JSON
commands on stdin can call Cloudflare APIs or run a child with the task token.
EOF/close revokes the token; never logs credential values or writes them to disk.
"""

import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import signal
import termios
import urllib.error
import urllib.request

ACCOUNT = "5cecc63c78acf8f5473f8745f4244448"
ZONE = "e0665efd9fd68d06cbb9ab68a13cc7c6"
BASE = "https://api.cloudflare.com/client/v4/"
ACCOUNT_PERMISSIONS = [
    "MCP Portals Write",
    "Access: Apps and Policies Write",
    "Access: Identity Providers Write",
    "Access: Organizations Read",
    "Access: Service Tokens Write",
    "Workers Scripts Write",
    "Workers Observability Write",
]
ZONE_PERMISSIONS = ["DNS Write", "Zone Read", "Workers Routes Write"]


def root_token():
    result = subprocess.run(
        [
            "/usr/bin/security",
            "find-generic-password",
            "-s",
            "eastmoney.cloudflare.root-token",
            "-a",
            "root",
            "-w",
            str(Path.home() / "Library/Keychains/login.keychain-db"),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode:
        raise RuntimeError("Keychain Root Token unavailable")
    return result.stdout.rstrip("\r\n")


def api(token, path, method="GET", body=None):
    request = urllib.request.Request(
        BASE + path,
        method=method,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "User-Agent": "eastmoney-mcp-provisioning",
            "Accept": "application/json",
        },
        data=None if body is None else json.dumps(body).encode(),
    )
    try:
        response = urllib.request.urlopen(request, timeout=45)
    except urllib.error.HTTPError as error:
        response = error
    payload = json.loads(response.read())
    if not 200 <= response.status < 300 or payload.get("success") is False:
        codes = [error.get("code") for error in payload.get("errors", [])]
        raise RuntimeError(
            f"Cloudflare {method} {path.split('?')[0]}: HTTP {response.status}, codes {codes}"
        )
    return payload.get("result", payload)


def clean(value):
    if isinstance(value, list):
        return [clean(item) for item in value]
    if isinstance(value, dict):
        return {
            key: (
                "[redacted]"
                if any(
                    part in key.lower()
                    for part in [
                        "secret",
                        "password",
                        "auth_credentials",
                        "access_token",
                        "refresh_token",
                        "cookie",
                        "authorization_url",
                        "auth_url",
                    ]
                )
                else clean(item)
            )
            for key, item in value.items()
        }
    return value


def main():
    if sys.stdin.isatty():
        settings = termios.tcgetattr(sys.stdin)
        settings[3] &= ~(termios.ECHO | termios.ICANON)
        termios.tcsetattr(sys.stdin, termios.TCSANOW, settings)
    root = root_token()
    status = api(root, f"accounts/{ACCOUNT}/tokens/verify")
    if status.get("status") != "active":
        raise RuntimeError("Account Root Token is not active")
    groups = api(root, f"accounts/{ACCOUNT}/tokens/permission_groups")

    def policy(names, scope, resource):
        selected = [
            {
                "id": next(
                    group["id"]
                    for group in groups
                    if group["name"] == name and scope in group["scopes"]
                )
            }
            for name in names
        ]
        return {
            "effect": "allow",
            "resources": {resource: "*"},
            "permission_groups": selected,
        }

    expiry = (
        datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=4)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")
    created = api(
        root,
        f"accounts/{ACCOUNT}/tokens",
        "POST",
        {
            "name": "eastmoney-mcp-portal-task",
            "expires_on": expiry,
            "policies": [
                policy(
                    ACCOUNT_PERMISSIONS,
                    "com.cloudflare.api.account",
                    "com.cloudflare.api.account." + ACCOUNT,
                ),
                policy(
                    ZONE_PERMISSIONS,
                    "com.cloudflare.api.account.zone",
                    "com.cloudflare.api.account.zone." + ZONE,
                ),
            ],
        },
    )
    token, token_id = created["value"], created["id"]
    del root, created
    print(
        json.dumps(
            {
                "taskTokenId": token_id,
                "expiresOn": expiry,
                "permissions": ACCOUNT_PERMISSIONS + ZONE_PERMISSIONS,
            }
        ),
        flush=True,
    )
    def terminate(_signal, _frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, terminate)
    try:
        for line in sys.stdin:
            try:
                command = json.loads(line)
                if command["op"] == "close":
                    break
                if command["op"] == "api":
                    result = api(
                        token,
                        command["path"],
                        command.get("method", "GET"),
                        command.get("body"),
                    )
                    print(json.dumps({"result": clean(result)}), flush=True)
                elif command["op"] == "run":
                    env = {
                        **os.environ,
                        **command.get("env", {}),
                        "CLOUDFLARE_API_TOKEN": token,
                        "CLOUDFLARE_ACCOUNT_ID": ACCOUNT,
                    }
                    result = subprocess.run(
                        command["args"],
                        cwd=command.get("cwd"),
                        env=env,
                        capture_output=True,
                        text=True,
                    )
                    print(
                        json.dumps(
                            {
                                "exitCode": result.returncode,
                                "stdout": result.stdout.replace(token, "[redacted]"),
                                "stderr": result.stderr.replace(token, "[redacted]"),
                            }
                        ),
                        flush=True,
                    )
                else:
                    raise RuntimeError("Unknown operation")
            except Exception as error:
                print(
                    json.dumps({"error": str(error).replace(token, "[redacted]")}),
                    flush=True,
                )
    finally:
        api(root_token(), f"accounts/{ACCOUNT}/tokens/{token_id}", "DELETE")
        print(json.dumps({"revokedTaskTokenId": token_id}), flush=True)


if __name__ == "__main__":
    main()
