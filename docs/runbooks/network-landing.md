# eez.dev network landing page

The optional static page in `landing/` links to two independent deployments:

| Host | Purpose | Server |
| --- | --- | --- |
| `eez.dev` | Network chooser | Mainnet server |
| `chiadox.eez.dev` | ChiadoX dashboard and APIs | Existing Chiado server |
| `rollupx.eez.dev` | RollupX dashboard and APIs | Existing mainnet server |

The page uses the dashboard's local brand assets and fonts, and ordinary HTTPS
links. It has no JavaScript, wallet connection, RPC calls or network detection.
It is built separately from the dashboard and needs no Node.js build or `.env`
changes. The optional Compose file has its own project and loopback port; running
it does not restart a node, dashboard, explorer, or Composer.

## Prepare on the mainnet server

Run from a checkout containing the reviewed landing-page revision. Check that
the `eez-network-landing` project and port 8090 are unused before first setup.
If necessary, export `EEZ_LANDING_PORT` to an unused loopback port and use that
same port in the gateway configuration.

```bash
docker compose -f docker-compose.landing.yml config --quiet
docker compose -f docker-compose.landing.yml up -d --build
curl --fail http://127.0.0.1:8090/healthz
curl --fail http://127.0.0.1:8090/
```

Only `landing/Dockerfile` builds; the existing dashboard Compose file and its
services are not selected. The container runs as the nginx user with a read-only
filesystem and temporary files under `/tmp`. Font license files are included
beside the local assets.

## Configure the domains before switching eez.dev

The commands below also cover the existing `rollupx-gateway` repository
(`compose.yaml`, `compose.validate.yaml`, `caddy/Caddyfile`). Its gateway uses
Linux host networking, so it can reach the landing container on host loopback.
Run gateway commands from that repository's root on the indicated server.
Before editing either gateway, preserve its private configuration outside the
checkout:

```bash
gateway_backup=$(mktemp -d "$HOME/rollupx-gateway-backup.XXXXXX")
cp -a caddy "$gateway_backup/caddy"
cp -p .env "$gateway_backup/.env"
```

1. Add `chiadox.eez.dev` DNS records pointing to the current Chiado server, and
   enable that hostname with a valid HTTPS certificate in its existing gateway.
   Keep its current `eez.dev` hostname working during DNS propagation. Update
   Chiado's public URL settings where necessary, preserving its existing chain
   identity, contracts, runtime data and operator settings.

   For `rollupx-gateway` on **the Chiado server**, set `PUBLIC_DOMAIN` in its
   existing `.env` to `chiadox.eez.dev`. Temporarily change the existing site
   block's opening line in `caddy/Caddyfile` from `{$PUBLIC_DOMAIN} {` to:

   ```caddy
   {$PUBLIC_DOMAIN}, eez.dev {
   ```

   This keeps both hostnames on the same Chiado routes during propagation.
   Validate before recreating only the gateway to load its changed environment:

   ```bash
   docker compose config --quiet
   docker compose -f compose.validate.yaml run --rm --no-deps validate
   docker compose up -d --no-deps --force-recreate gateway
   ```

   Preserve the existing Compose project, certificate volumes, upstreams and
   `.env.auth`. A reload alone cannot apply `.env` changes; recreating the
   gateway interrupts its existing WebSocket connections.
2. Check `https://chiadox.eez.dev/dashboard/`, its configuration, explorer and
   Composer endpoints directly. It must serve the same Chiado deployment that
   `eez.dev` currently serves. Do not switch the apex while this hostname fails.
3. Prepare HTTPS for `eez.dev` on the mainnet gateway. Caddy's automatic HTTPS can
   obtain its certificate after DNS points there; DNS-based ACME validation can
   prepare a certificate before cutover if uninterrupted HTTPS is required.
   Keep the mainnet server's existing `rollupx.eez.dev` site and certificate.
4. Adapt [the Caddy example](../../landing/eez.dev.caddy.example) to the
   mainnet gateway's existing Caddyfile. The public sites currently use Caddy;
   the static landing container uses nginx internally. The new site is intended
   for a gateway that reaches host loopback. Preserve the
   gateway's existing request-size limits, timeouts and other operator settings.
   A gateway on a Docker bridge needs an upstream address it can actually reach;
   its own `127.0.0.1` is not the Docker host.

   For `rollupx-gateway` on **the mainnet server**, keep
   `PUBLIC_DOMAIN=rollupx.eez.dev` and `UI_UPSTREAM` unchanged. Add the new
   `eez.dev` block at the **top level** of `caddy/Caddyfile`, after the existing
   block. Do not put it in `caddy/sites/`: those files are imported *inside*
   the RollupX site and accept path directives, not hostname blocks.

   With the landing checkout at `$HOME/eez-network-landing`, append the example
   once from the gateway checkout. If an `eez.dev` block already exists, edit
   that block instead of adding a duplicate:

   ```bash
   cat "$HOME/eez-network-landing/landing/eez.dev.caddy.example" >> caddy/Caddyfile
   ```

   These are local operator changes; preserve them when updating the gateway
   checkout. Do not replace its Caddyfile or existing enabled route files with
   examples from another deployment.
5. Validate the full gateway in its actual deployment and reload only that
   gateway. For `rollupx-gateway` on the mainnet server, no environment change is
   needed, so a reload applies the new site:

   ```bash
   docker compose config --quiet
   docker compose -f compose.validate.yaml run --rm --no-deps validate
   docker compose exec -T gateway caddy reload --config /etc/caddy/Caddyfile
   ```

   If the certificate is already available, preview before DNS cutover using
   the mainnet server's IP;
   otherwise these HTTPS checks follow DNS cutover and certificate issuance:

   ```bash
   curl --fail --resolve "eez.dev:443:${EEZ_MAINNET_IP}" https://eez.dev/
   curl --fail --resolve "eez.dev:443:${EEZ_MAINNET_IP}" \
     -H 'Content-Type: application/json' \
     --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
     https://eez.dev/composer/l2
   ```

   The first response must be the chooser. The second must still identify the
   **Chiado L2**, matching the response from `chiadox.eez.dev/composer/l2`.
   Also verify the existing `rollupx.eez.dev` dashboard and both new-page links.
6. Point the apex A/AAAA records to the mainnet server. If the DNS provider
   supports apex alias flattening, an alias to `rollupx.eez.dev` is another option.
   Do not leave an AAAA record pointing to the former server. Keep ChiadoX
   pointing to its separate machine. Test again after DNS propagation.
7. Once propagation is complete, remove the temporary `eez.dev` alias from the
   **Chiado server's** site header, restoring `{$PUBLIC_DOMAIN} {`. Keep
   `PUBLIC_DOMAIN=chiadox.eez.dev` in that server's `.env`. Validate and reload
   its gateway using the commands in step 5. The mainnet gateway continues to
   forward legacy apex paths to ChiadoX.

The previous homepage responds with a permanent redirect to `/dashboard/`.
Use `curl` to verify the new root without a browser's cached redirect; a browser
that retained that redirect may need its cache cleared to show the chooser.

### Existing eez.dev URLs

Wallets and bookmarks may still use `eez.dev/composer/*`, `/rpc/*`, `/dashboard/`
and `/explorer/`. The Caddy example serves the chooser only at `/` and its static
assets at `/network-assets/`. All other paths are reverse-proxied to ChiadoX,
preserving the request method, body and WebSocket upgrades. TLS to ChiadoX is
verified. Old RPC URLs must not start serving Ethereum/RollupX, and an HTTP
redirect is not a substitute for forwarding wallet JSON-RPC requests.

New visitors select their network explicitly. Existing deep links keep their
Chiado meaning; there is no automatic wallet network switch. Maintain this
forwarding while those legacy URLs are in use.

## Rollback and verification scope

Keep the previous gateway configuration and DNS records. Before an apex cutover,
removing the new virtual host affects only the preview. After cutover, restoring
the former apex DNS records returns traffic to the Chiado server; keep both
servers' certificates and legacy routes available through DNS propagation.
Stopping only the landing Compose project does not stop either network, but it
does make the chooser unavailable while the gateway still points to its port.

Local image, browser and gateway syntax checks validate the prepared files. They
do not establish that public DNS, certificates, the Chiado hostname or either
production gateway has been configured. Those checks must run on the target
servers during deployment.
