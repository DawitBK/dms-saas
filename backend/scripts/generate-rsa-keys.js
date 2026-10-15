// Generates a FRESH RS256 keypair and prints the two base64 env values the
// backend expects (DEV_RSA_PRIVATE_KEY signs tokens, DEV_RSA_PUBLIC_KEY backs
// /.well-known/jwks.json). Run once per environment; never reuse dev keys in
// production.
//
// (This script previously printed a HARDCODED test keypair — anyone who used
// it for a real deployment was signing tokens with a publicly-known private
// key. It now generates a new 2048-bit pair on every run.)
import crypto from "node:crypto";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

console.log("# Fresh RS256 keypair — set in the backend environment:");
console.log("DEV_RSA_PRIVATE_KEY=" + Buffer.from(privateKey).toString("base64"));
console.log("DEV_RSA_PUBLIC_KEY=" + Buffer.from(publicKey).toString("base64"));
