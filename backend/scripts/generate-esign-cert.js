// Generates a self-signed PKCS#12 signing certificate for the PAdES e-sign
// flattened copies and prints the two env values to set:
//   ESIGN_P12_B64=<base64 p12>
//   ESIGN_P12_PASSPHRASE=<passphrase>
//
//   node scripts/generate-esign-cert.js [--cn "Example Corp DMS"] [--years 5]
//
// Self-signed means PDF viewers show "signature valid, signer not trusted"
// until the cert (or a real org/CA-issued one) is added to their trust store —
// integrity/tamper-evidence works either way. Swap in a CA-issued PKCS#12 for
// full green-check trust.
import forge from "node-forge";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const cn = arg("cn", "Example Corp DMS Document Signing");
const years = Number(arg("years", "5"));

const keys = forge.pki.rsa.generateKeyPair(2048);
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = "01" + crypto.randomBytes(8).toString("hex");
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + years);

const attrs = [
  { name: "commonName", value: cn },
  { name: "organizationName", value: "Example Corp Trading PLC" },
  { name: "countryName", value: "ET" },
];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.setExtensions([
  { name: "basicConstraints", cA: false },
  { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
  { name: "extKeyUsage", emailProtection: true, clientAuth: false },
]);
cert.sign(keys.privateKey, forge.md.sha256.create());

const passphrase = crypto.randomBytes(24).toString("base64url");
const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, {
  algorithm: "3des",
  friendlyName: cn,
});
const p12b64 = Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary").toString("base64");

console.log("# Add to the backend environment (.env.prod):");
console.log(`ESIGN_P12_B64=${p12b64}`);
console.log(`ESIGN_P12_PASSPHRASE=${passphrase}`);
console.log(`# Certificate CN: ${cn} — valid until ${cert.validity.notAfter.toISOString().slice(0, 10)}`);
