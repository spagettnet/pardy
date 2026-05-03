#!/usr/bin/env bash
# Generate a self-signed cert covering localhost and the current LAN IP so
# phones can use the microphone (getUserMedia requires a secure context).
# Phones will see a "not trusted" warning the first time and have to tap
# "proceed" / "advanced → continue". After that, mic permission can prompt.

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="$ROOT/certs"
mkdir -p "$CERT_DIR"

KEY="$CERT_DIR/key.pem"
CRT="$CERT_DIR/cert.pem"

LAN_IP=$(node -e "const n=require('os').networkInterfaces();for(const v of Object.values(n))for(const i of v||[])if(i.family==='IPv4'&&!i.internal){console.log(i.address);process.exit(0)}console.log('127.0.0.1')")

cat > "$CERT_DIR/openssl.cnf" <<EOF
[req]
default_bits       = 2048
prompt             = no
default_md         = sha256
distinguished_name = dn
x509_extensions    = v3_req

[dn]
CN = pardy.local

[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = pardy.local
IP.1  = 127.0.0.1
IP.2  = $LAN_IP
EOF

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$KEY" -out "$CRT" \
  -days 365 -config "$CERT_DIR/openssl.cnf" >/dev/null 2>&1

echo "[gen-cert] wrote $KEY and $CRT (covers localhost + $LAN_IP)"
