# Production Apache TLS hardening — operator runbook

This repository now contains the hardened baseline in
`../apache/conf/extra/httpd-ssl.conf`: TLS 1.0/1.1 and weak cipher families are
disabled, HSTS and edge security headers are enabled, and Apache no longer
advertises its version. This file is the activation checklist for the Windows
server; it cannot be completed safely from a development checkout.

## Required operator actions

1. Back up the active Apache configuration and certificate files. Do not copy
   the development `server.crt`/`server.key` into production.
2. Obtain a CA-issued certificate for `portal.examplecorp.com` (for example with
   win-acme/ACME on the server). Install the certificate, private key, and any
   required intermediate chain in a directory readable only by the Apache
   service account.
3. Update `SSLCertificateFile`, `SSLCertificateKeyFile`, and, when supplied by
   the CA, `SSLCertificateChainFile` to the real certificate paths. The
   checked-in XAMPP `server.crt` is self-signed and is not an acceptable
   production identity.
4. Copy the reviewed TLS directives from this repository to the server's live
   `apache/conf/extra/httpd-ssl.conf`. Preserve the existing reverse-proxy
   routing rules.
5. From an elevated PowerShell prompt on the server, test before reload:

   ```powershell
   C:\xampp1\apache\bin\httpd.exe -t
   C:\xampp1\apache\bin\httpd.exe -k restart
   ```

6. Verify from a machine outside the server:

   ```powershell
   curl.exe -I https://portal.examplecorp.com/dms
   curl.exe -I http://portal.examplecorp.com/dms
   openssl s_client -connect portal.examplecorp.com:443 -servername portal.examplecorp.com -tls1_2
   ```

   Expect an HTTP-to-HTTPS redirect, a certificate chain trusted by the client,
   and `Strict-Transport-Security`, `X-Content-Type-Options`,
   `X-Frame-Options`, `Referrer-Policy`, and `Permissions-Policy` headers.

## Safety notes

- HSTS is intentionally set for `portal.examplecorp.com` only. Add
  `includeSubDomains` or browser preload only after every current and planned
  subdomain is HTTPS-ready; those choices cannot be quickly undone for clients.
- Arrange certificate renewal before expiry (ACME scheduled task plus a safe
  Apache reload) and alert on renewal failure. A manual certificate replacement
  is not a durable fix.
- The local checkout has `ServerRoot C:/xampp1/apache`, while this developer
  machine does not have that directory. Therefore `httpd -t` here correctly
  cannot validate the live layout; the server-side test in step 5 is required.
