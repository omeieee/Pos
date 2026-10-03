# Reserved public IP for the API host: plan (not executed)

Status: **EXECUTED 2026-10-03 (about 17:50 UTC)**. The old ephemeral IP `138.2.67.89` was deleted and the reserved IP `sds-pos-api` = **`161.118.211.42`** (host `161-118-211-42.sslip.io`) was attached to private IP `10.0.0.43`. Caddy got its certificate and `/healthz` answers on the new host. Remaining by hand: GitHub variable `API_HOST` + Deploy web apps, UptimeRobot URL, `~/.ssh/config`. The text below is the plan as written before the swap.

Current state (from `infra/oracle/README.md`): VM `omeie_pos`, `ap-singapore-1`, ephemeral public IP `138.2.67.89` (object `publicip20260928193828`), API host `138-2-67-89.sslip.io`.

## 1. Findings from the Oracle documentation (read 2026-10-03)

| Question | Answer | Source |
|---|---|---|
| Can the existing ephemeral IP be converted to reserved and keep `138.2.67.89`? | **No.** "After you create a given public IP object, you can't change which type it is ... you can't convert the ephemeral public IP to a reserved public IP with address 203.0.113.2." | docs.oracle.com, *Public IP Addresses* (`Content/Network/Tasks/managingpublicIPs.htm`) |
| Can a reserved IP be attached while the ephemeral one is still there? | **No.** The private IP "must not have an ephemeral or reserved public IP object already assigned to it. If it does, first either delete the public ephemeral IP, or unassign the reserved public IP." | *Assigning a Reserved Public IP to a Private IP* (`reserved-public-ip-assign.htm`) |
| What happens to the old ephemeral address after deletion? | It is deleted and the address is **returned to Oracle's pool**. It cannot be claimed again, so `138.2.67.89` is gone for good once we delete it. | managingpublicIPs.htm; the same page says a reserved IP persists until you delete it |
| Does a reserved IP stay put? | Yes. It exists independently of the instance, and you can unassign and reassign it to another private IP in the same region at any time (also another VCN or AD). That is exactly what lets a rebuilt VM keep the address. | managingpublicIPs.htm |
| Is a reserved IP free on a running Always Free instance? | **Not confirmed from a primary Oracle page.** The pricing page, the Free Tier page and the Oracle release blog all returned HTTP 403 to our fetcher, and the docs pages that were readable make no cost statement. A web search surfaced the Oracle release announcement and third-party posts saying reserved public IPs have no charge, attached or not, and (third-party only) that the free tier allows 2 reserved IPs. Treat "free" as **likely but unverified**. The Always Free page confirms only that a public IP is optional for Always Free VMs. | web search; docs.oracle.com Always Free page |
| Idle reclamation | Unchanged by this plan: idle Always Free instances (7-day CPU p95 < 20% and network < 20%) may be reclaimed. A reserved IP is what makes the rebuild keep the same URL. | Always Free page |

**Conclusion: the address WILL change once** (to a new Oracle-chosen address, call it `NEW_IP`), and the old hostname `138-2-67-89.sslip.io` stops working at the moment the ephemeral IP is deleted. After that the address is stable for good.

### Verify the cost claim before the swap (owner, 2 minutes)
Do this first; if any step shows a charge, stop and tell Claude.
1. Console, Governance & Administration, **Limits, Quotas and Usage**, service **Virtual Cloud Network**, search "public ip". Note the reserved public IP limit for the region (expected to be at least 1).
2. Console, Billing, **Cost Analysis**, and the PAYG **budget alert** (docs/05 §3.1) must still be in place before you start.
3. After the swap, check Cost Analysis next day: no "Public IP" line. In the Oracle price list, the line item to look for is "Reserved Public IP"; the budget alert covers any surprise.
Risk if the claim is wrong: unknown but small (a public IP is typically cents per month at most, never a compute cost). The budget alert is the safety net. Never leave a reserved IP **unassigned** for long; if you must, delete it.

## 2. What embeds `138-2-67-89.sslip.io` / `138.2.67.89`

Found by searching the repo. "Auto" means it follows the variable and needs no edit.

| # | Where | Value / mechanism | Action |
|---|---|---|---|
| 1 | VM `/opt/sds/.env` `API_HOST` (not in git) | Read by `infra/compose/docker-compose.yml`, used by `infra/compose/Caddyfile` site address `{$API_HOST}` | Edit, then `./dc up -d caddy`; Caddy fetches a new Let's Encrypt cert for the new name (port 80 and 443 must reach the VM: OCI security list and iptables are tied to the subnet and VM, not the public IP, so no change) |
| 2 | GitHub repo **variable** `API_HOST` | Feeds `deploy-web.yml` (`VITE_API_BASE_URL`, CSP `__API_HOST__` in `apps/pos-web/public/_headers` and `apps/liff-web/public/_headers`), `deploy-api.yml` smoke test, `external-check.yml` | Edit, then re-run **Deploy web apps** (CSP and API base are baked at build time) |
| 3 | `external-check.yml` | Resolves `API_HOST` at run time (`PUBLIC_IP`) | Auto |
| 4 | CORS (`CORS_ORIGINS`) | Lists the `pages.dev` origins only | **No change** |
| 5 | Cloudflare Pages env | No API host stored there; the build gets it from the GitHub variable | **No change** (a Pages rebuild via item 2 is enough) |
| 6 | GitHub **secrets** | Tailscale/Cloudflare tokens only; none holds the IP or host | **No change** |
| 7 | Tailscale (`sds-pos`), CI deploy over the tailnet | Uses the tailnet name, not the public IP | **No change**; a brief reconnect while the VM has no public IP |
| 8 | UptimeRobot monitor `https://138-2-67-89.sslip.io/readyz` | Third party | Edit URL |
| 9 | `~/.ssh/config` entry `pos-oracle` (`HostName 138.2.67.89`), break-glass only | Owner's laptop | Edit |
| 10 | **LINE webhook URL** (LINE Developers console) | Not set yet if P4 has not started; otherwise `https://<host>/…` | Do the IP swap **first**; set the webhook once, to the final host. If already set, update it after the new host answers, and press **Verify** |
| 11 | LIFF endpoint URLs | On `pages.dev` | **No change** |
| 12 | Supabase network restrictions / OCI IAM network sources, if the owner ever limited them to the VM's IP | Not documented in the repo as set | Check once; if a restriction names `138.2.67.89`, add `NEW_IP` before the swap |
| 13 | Docs in git | `infra/RUNBOOK.md` (lines 8, 12, 27-28, 242 + "IP changed"), `infra/SETUP.md` (lines 9, 123, 136, 155, 220, 250, 271), `infra/oracle/README.md` (IP + public-IP-type row), `docs/05-infrastructure.md` (hostname-stability checkbox), `docs/10-open-questions.md` ("stay ephemeral"), `docs/checkpoints/PHASE-02-cloud-skeleton.md`, `docs/decisions.md` D-10 (example hostname only) | Claude updates after the owner reports the new IP |

Rebuild note: with the IP reserved, `infra/RUNBOOK.md` "IP changed" no longer applies to a rebuild; the rebuild instead re-assigns the reserved IP to the new VM's private IP (section 6). `infra/compose/.env.example` carries a documentation placeholder IP, nothing to change.

## 3. Order of steps (minimum downtime, about 5 to 10 minutes of API downtime)

Choose a quiet time (closed shop). The web apps' offline outbox (docs/02) keeps orders typed during the gap; staff just see "offline" until the new build loads. Nothing is touched before step 4 that affects the live system.

0. **Pre-checks** (owner): budget alert exists; cost check in section 1; item 12 checked; no LINE webhook configured yet (or accept updating it).
1. **Create the reserved IP, unassigned** (section 4A). It shows `NEW_IP`. Send it to Claude. No effect on production. Work out the new host: `NEW_IP` with dots replaced by dashes plus `.sslip.io` (for example `203.0.113.10` gives `203-0-113-10.sslip.io`). Check it resolves: `nslookup 203-0-113-10.sslip.io`.
2. **Pre-stage the VM file, no restart**: over Tailscale SSH edit `/opt/sds/.env`, set `API_HOST='<new-host>'`. Compose reads `.env` only at `up`, so the live Caddy keeps serving the old name. Keep a copy: `cp .env .env.bak-ip` (chmod 600).
3. Open the GitHub variable page and the Actions "Deploy web apps" page in tabs, ready to click.
4. **Swap** (section 4B): delete the ephemeral IP, assign the reserved IP to the same private IP. Downtime starts. The VM briefly has no public IP, so it has no outbound internet either; Tailscale reconnects after the assign.
5. On the VM: `cd /opt/sds && ./dc up -d caddy`, then `./dc ps` (caddy healthy) and `./dc logs --tail 30 caddy` (certificate obtained).
6. From the laptop: `curl -sS https://<new-host>/healthz` and `/readyz`. Downtime ends here for the API.
7. Set GitHub variable `API_HOST` = new host; run **Deploy web apps** (pos-web and liff-web); confirm green.
8. Run **External check** (workflow dispatch) and confirm green. Update UptimeRobot and `~/.ssh/config`.
9. Tell Claude the new IP and host; Claude updates the docs (item 13) and commits.
10. Only now, at P4: register the LINE webhook with the final host and press **Verify**.

Optional zero-downtime variant (not recommended, more moving parts): add a secondary private IP to the VNIC, configure it in the OS, attach the reserved IP to it, switch Caddy, then delete the ephemeral IP. It saves a few minutes of downtime but needs OS network changes on a 1 GB VM; the plain swap is cheaper and safer before go-live.

Let's Encrypt note: sslip.io is not on the Public Suffix List, so its shared rate limit applies (RUNBOOK). One new name is fine; do not repeat the swap many times in a row.

## 4. Owner steps

### 4A. Create the reserved IP (console)
1. Sign in to the Oracle Cloud console, region **Singapore (ap-singapore-1)**.
2. Navigation menu, **Networking**, under **IP management** choose **Reserved public IPs**.
3. **Reserve public IP address**. Name `sds-pos-api`; compartment `omeza25482548` (root); IP address source: leave the default Oracle pool. Tags: none.
4. **Reserve public IP address**. Copy the displayed address (`NEW_IP`). Leave it **unassigned**.

### 4B. Swap it onto the VM (console)
1. **Compute**, **Instances**, `omeie_pos`, tab **Networking**, **Attached VNICs**, click the primary VNIC (`omeie-vnic`), tab **IP administration**.
2. On the primary private IP `10.0.0.43`, **Actions** (three dots), **Edit**. Under **Public IP type** choose **No public IP**, **Update**. (This deletes the ephemeral IP `138.2.67.89`; **this is the point of no return for that address**.)
3. Same row, **Actions**, **Edit**. Under **Public IP type** choose **Reserved public IP**, **Select existing reserved IP address**, pick `sds-pos-api`, **Update**.
4. Confirm the VNIC page now lists `NEW_IP` as the public IP of `10.0.0.43`.

### 4C. Alternative: Cloud Shell / OCI CLI (same effect)
Open Cloud Shell in the console (already signed in as you). Replace the `<…>` values; get OCIDs from the console pages above or the list commands.
```bash
# find the VNIC and the private IP (OCIDs)
oci compute instance list-vnics --instance-id <INSTANCE_OCID>
oci network private-ip list --vnic-id <VNIC_OCID>
# the current ephemeral IP object
oci network public-ip get --private-ip-id <PRIVATE_IP_OCID>

# 1. create the reserved IP (unassigned); note "ip-address" and "id"
oci network public-ip create --compartment-id <COMPARTMENT_OCID> \
  --lifetime RESERVED --display-name sds-pos-api

# 2. SWAP: delete the ephemeral IP, then assign the reserved one
oci network public-ip delete --public-ip-id <EPHEMERAL_PUBLIC_IP_OCID>
oci network public-ip update --public-ip-id <RESERVED_PUBLIC_IP_OCID> \
  --private-ip-id <PRIVATE_IP_OCID>

# 3. check
oci network public-ip get --public-ip-id <RESERVED_PUBLIC_IP_OCID> \
  --query 'data.{ip:"ip-address",state:"lifecycle-state",assigned:"assigned-entity-type"}'
```
Syntax is from the Oracle task pages (`oci network public-ip create|delete|update`); run `--help` if a flag differs in your CLI version.

### 4D. After the swap
Follow section 3 steps 5 to 9. Evidence Claude needs back from you: `NEW_IP`, the output of `curl -sS https://<new-host>/healthz`, the green Deploy web apps and External check run links.

## 5. Rollback

The old address cannot be restored (returned to Oracle's pool), so "rollback" means getting any working public IP again and re-pointing:
- **Reserved assign fails or the console refuses** (limit, permission): VM edit, **Public IP type: Ephemeral public IP**, Update. You get yet another new address `EPH_IP`; do section 3 steps 5 to 9 with it (the existing "IP changed" checklist in `infra/RUNBOOK.md`). Delete the unused reserved IP afterwards so nothing lingers.
- **Caddy cannot get a certificate** (rate limit or port 80 blocked): restore `/opt/sds/.env.bak-ip` only if the old IP still existed, which it does not after step 4B; instead wait for ACME retry or fall back to a DuckDNS name (RUNBOOK) and set `API_HOST` to it.
- **Pre-swap abort** (steps 0 to 3): delete the unassigned reserved IP (**Actions**, **Terminate**) and restore `/opt/sds/.env` from `.env.bak-ip` if you edited it. Nothing else has changed; production never noticed.
- **Any time later** the reserved IP can be moved: unassign it from the VNIC (or **Terminate** to give it up) and assign it to a rebuilt VM's private IP. Reserved IPs persist until deleted.

## 6. Rebuild after reclamation or termination (with the reserved IP in place)
New VM, `infra/oracle/bootstrap.sh`, then in the console attach `sds-pos-api` to the new VM's private IP (4B step 3; the new instance must be created with **no** public IP, or delete its ephemeral one first). The hostname and the LINE webhook stay the same, so "IP changed" is skipped. Add this to RUNBOOK rebuild step 6 when the swap is done.

## 7. If conversion is skipped (stay on the ephemeral IP)

- The ephemeral IP **survives reboot and stop/start** (checked 2026-09-29, `README.md`). It is lost on: terminate (incl. a rebuild after reclamation), VNIC detach, private-IP deletion, or setting "No public IP".
- Risk: after a rebuild the sslip.io name changes; every webhook call to LINE fails until you update the LINE webhook URL, `API_HOST` (GitHub and VM) and redeploy the web apps. Orders already on LINE keep waiting; customers see no replies. The RUNBOOK "IP changed" checklist is about 15 minutes, but the owner must notice first (UptimeRobot alerts to omeza25482548@gmail.com).
- Cheaper partial mitigations that keep it at ฿0: (a) a **DuckDNS** hostname with an update script on the VM, so the name stays and only the DNS record follows the IP (third-party dependency; RUNBOOK lists it as a fallback); (b) the end state in D-10, **a domain plus Cloudflare Tunnel**, makes the VM's IP irrelevant. Neither beats a reserved IP for the LINE webhook if the reserved IP is free.

## 8. Recommendation
Do the swap **once, now, before P4 registers the LINE webhook**, in a quiet window: about 10 minutes, one-time URL change, and afterwards the address survives any rebuild. Verify the "free" claim first (section 1 checks plus the budget alert) because Oracle's pricing page could not be read in this session. Keep the ephemeral IP only if the owner would rather wait for the domain and Cloudflare Tunnel.
