"""Web Push from the sync to your phone's browser, end to end encrypted: the morning notification with the day's call.

Two small standards, on the `cryptography` package:
- RFC 8291 (message encryption, "aes128gcm"): the payload is encrypted to the browser's own key, so the push service
  in between (Google's, for Chrome) only ever carries ciphertext;
- RFC 8292 (VAPID): a signed token says the message comes from this sync, so only it can push to the subscription.

The VAPID key pair is made on the first run and kept in the encrypted state; its public half goes in status.json for
the app to subscribe with. Subscriptions arrive as a "push-subscribe" run and live in the store.
"""
from __future__ import annotations

import base64
import json
import os
import struct
import time
from collections.abc import Callable
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

CONTACT = "mailto:fitness-sync@users.noreply.github.com"   # VAPID's "sub": who to contact about this sender
TTL = 6 * 3600                                               # a morning call is stale by the afternoon


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _raw(pub: ec.EllipticCurvePublicKey) -> bytes:
    return pub.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def new_keys() -> dict:
    """A VAPID key pair: the private key as PEM (stays in the encrypted state), the public as the app needs it."""
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    return {"private": pem, "public": b64u(_raw(key.public_key()))}


def _hkdf(salt: bytes, ikm: bytes, info: bytes, n: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=n, salt=salt, info=info).derive(ikm)


def encrypt(payload: bytes, p256dh: str, auth: str, salt: bytes | None = None, server: ec.EllipticCurvePrivateKey | None = None) -> bytes:
    """RFC 8291 aes128gcm: one record, the header carrying the salt and our ephemeral public key."""
    ua_pub_raw = unb64u(p256dh)
    ua_pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub_raw)
    server = server or ec.generate_private_key(ec.SECP256R1())
    as_pub_raw = _raw(server.public_key())
    salt = salt or os.urandom(16)
    shared = server.exchange(ec.ECDH(), ua_pub)
    ikm = _hkdf(unb64u(auth), shared, b"WebPush: info\x00" + ua_pub_raw + as_pub_raw, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    body = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)   # \x02: the last (and only) record
    return salt + struct.pack(">IB", 4096, len(as_pub_raw)) + as_pub_raw + body


def vapid(endpoint: str, private_pem: str, now: float | None = None) -> str:
    """The Authorization header: an ES256 JWT for the push service's origin, valid 12 hours."""
    key = serialization.load_pem_private_key(private_pem.encode(), password=None)
    u = urlparse(endpoint)
    head = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    claims = b64u(json.dumps({"aud": f"{u.scheme}://{u.netloc}", "exp": int((now or time.time()) + 12 * 3600), "sub": CONTACT},
                             separators=(",", ":")).encode())
    r, s = decode_dss_signature(key.sign(f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256())))
    token = f"{head}.{claims}.{b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"
    return f"vapid t={token}, k={b64u(_raw(key.public_key()))}"


def _post(req: Request) -> int:
    try:
        with urlopen(req, timeout=20) as r:
            return r.status
    except Exception as e:   # HTTPError carries the push service's answer; anything else is a failed delivery
        return getattr(e, "code", 0) or 0


def send(sub: dict, message: dict, private_pem: str, post: Callable[[Request], int] = _post) -> int:
    """Push one message to one subscription; the HTTP status (201 delivered, 404 / 410 the subscription is gone)."""
    body = encrypt(json.dumps(message, separators=(",", ":")).encode(), sub["keys"]["p256dh"], sub["keys"]["auth"])
    req = Request(sub["endpoint"], data=body, method="POST", headers={
        "Authorization": vapid(sub["endpoint"], private_pem), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
        "TTL": str(TTL), "Urgency": "normal", "Topic": "today"})
    return post(req)
