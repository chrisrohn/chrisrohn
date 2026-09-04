"""Connect YouTube Music with Google's *device* OAuth flow — runs unattended inside GitHub Actions.

No terminal or DevTools needed on your machine: the workflow prints a short code, you open
https://www.google.com/device on any phone/browser, enter it, approve, and the workflow finishes by storing
the token as the YTMUSIC_OAUTH_JSON repository secret (via `gh secret set`, using ADMIN_PAT).

Requires a Google Cloud OAuth client of type "TV and Limited Input devices" with the YouTube Data API v3
enabled (see SETUP.md) → YTMUSIC_OAUTH_CLIENT_ID / YTMUSIC_OAUTH_CLIENT_SECRET.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time

from .util import log


def device_flow(client_id: str, client_secret: str, *, poll_budget_s: int = 900) -> dict:
    from ytmusicapi.auth.oauth.credentials import OAuthCredentials
    from ytmusicapi.auth.oauth.token import RefreshingToken

    creds = OAuthCredentials(client_id, client_secret)
    code = creds.get_code()
    url = code.get("verification_url") or "https://www.google.com/device"
    user_code = code["user_code"]
    interval = int(code.get("interval", 5))
    expires_in = int(code.get("expires_in", poll_budget_s))
    banner = "\n".join([
        "",
        "=" * 64,
        "  CONNECT YOUTUBE MUSIC",
        "",
        f"  1. On any phone or browser open:  {url}",
        f"  2. Enter this code:               {user_code}",
        "  3. Sign in with the Google account that owns your playlists and approve.",
        "",
        f"  Waiting up to {min(expires_in, poll_budget_s) // 60} minutes for approval...",
        "=" * 64,
        "",
    ])
    print(banner, flush=True)
    # also surface it in the Actions job summary so it's visible without opening logs
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(f"## Connect YouTube Music\n\nOpen **{url}** and enter code **`{user_code}`**, then approve.\n\n")

    deadline = time.time() + min(expires_in, poll_budget_s)
    while time.time() < deadline:
        time.sleep(interval)
        raw = creds.token_from_code(code["device_code"])
        err = raw.get("error")
        if not err and raw.get("access_token"):
            refresh_expires = raw.get("refresh_token_expires_in", raw["expires_in"])
            tok = RefreshingToken(
                credentials=creds,
                access_token=raw["access_token"],
                refresh_token=raw["refresh_token"],
                scope=raw["scope"],
                token_type=raw["token_type"],
                expires_in=refresh_expires,
            )
            tok.update(raw)
            return tok.as_dict()
        if err == "authorization_pending":
            print(".", end="", flush=True)
            continue
        if err == "slow_down":
            interval += 2
            continue
        raise SystemExit(f"OAuth device flow failed: {raw}")
    raise SystemExit("Timed out waiting for approval — run the workflow again.")


def store_secret(name: str, value: str, repo: str, token: str) -> None:
    env = dict(os.environ, GH_TOKEN=token)
    subprocess.run(["gh", "secret", "set", name, "--repo", repo, "--body", value], check=True, env=env)
    log.info("stored secret %s in %s", name, repo)


def main() -> int:
    cid = os.environ.get("YTMUSIC_OAUTH_CLIENT_ID")
    secret = os.environ.get("YTMUSIC_OAUTH_CLIENT_SECRET")
    if not cid or not secret:
        print("Missing YTMUSIC_OAUTH_CLIENT_ID / YTMUSIC_OAUTH_CLIENT_SECRET secrets (see SETUP.md step 3).", file=sys.stderr)
        return 2
    token = device_flow(cid, secret)
    print("\nApproved. Token obtained.", flush=True)
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    admin = os.environ.get("ADMIN_PAT")
    if repo and admin:
        store_secret("YTMUSIC_OAUTH_JSON", json.dumps(token), repo, admin)
        print("Saved as repository secret YTMUSIC_OAUTH_JSON. You're connected.")
    else:
        print("ADMIN_PAT not set, so the token was NOT stored. Add ADMIN_PAT (fine-grained PAT with Secrets: read & write) and re-run.", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
