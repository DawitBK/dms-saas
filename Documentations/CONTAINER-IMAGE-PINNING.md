# Container image pinning

`docker-compose.dev.yml` and `docker-compose.prod.yml` use explicit image
tags.  Neither file may use `latest` (or another moving channel tag).  This
makes a deploy reviewable and reproducible: an image changes only after an
intentional Compose change.

Run the guard locally before changing either Compose file:

```powershell
npm run containers:check-pins
```

The same command runs in CI. It rejects missing tags and known moving tags
(`latest`, `main`, `master`, `edge`, and `stable`).

## Updating an image

1. Check the publisher's release notes, supported platforms, and compatibility
   with the DMS version in this repository.
2. Replace the tag in both Compose files when the service exists in both.
3. Run `npm run containers:check-pins` and `docker compose -f
   docker-compose.dev.yml config`.
4. For a production update, execute the documented staging/backup/rollback
   procedure before changing the production host.

`dms-backend:release` and `dms-frontend:release` are deliberately named local
build artifacts created by the production Compose file. Registry artifacts
published by CI are identified only by commit SHA; CI does not publish a
`latest` alias.
