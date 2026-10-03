# Oracle Cloud VM — record

Facts about the production VM. **No secrets here.** The SSH private key is never stored in the repo (see `CLAUDE.md` rule 11).

Recorded 2026-09-29 from the owner's OCI console screenshots.

| Field | Value |
|---|---|
| Instance name | `omeie_pos` |
| State | Running |
| Launched | 2026-09-28 19:28:59 UTC |
| Region / AD / FD | `ap-singapore-1` / AD-1 / FD-1 |
| Compartment | `omeza25482548` (root) |
| Shape | **VM.Standard.E2.1.Micro** (AMD x86_64, cannot be resized) |
| OCPU / RAM | 1 OCPU shown (Always Free Micro is a 1/8-OCPU baseline with burst) / **1 GB** |
| Network bandwidth | 0.5 Gbps |
| Storage | Block storage only (boot volume) |
| Image | Canonical Ubuntu 24.04 (`Canonical-Ubuntu-24.04-2026.09.18-0`) |
| Login user | `ubuntu` |
| Public IP | `161.118.211.42` |
| VCN | `vcn-20260929-0215` |
| Subnet | `subnet-20260929-0215` (uses the default route table for the VCN) |
| Private IP | `10.0.0.43` |
| VNIC hostname / internal FQDN | `omeie-vnic` / `omeie-vnic.subnet09290228.vcn09290228.oraclevcn.com` |
| Network security groups | None. Firewall rules come from the **subnet's security list** plus the VM's own iptables |
| Public IP type | **Reserved** (`sds-pos-api`, swapped in 2026-10-03; the old ephemeral `138.2.67.89` is gone). It stays with the account until deleted and can be re-attached to a rebuilt VM's private IP (see [RESERVED-IP.md](RESERVED-IP.md) section 6). Never leave it unassigned for long |
| Capacity type | On-demand |
| Instance metadata service | Version 2 only |
| Account type | **Pay-As-You-Go** (owner-reported 2026-10-01; it was Free Tier before). Stay inside the Always Free limits: docs/05 §3.1 |
| OCID | `ocid1.instance…zwsljrj6nkjiycfphxdw7z24gicvhozic2rzzly7eime5dsxgltm6cwoka` (tail as shown in the console) |
| SSH key | `%USERPROFILE%\.ssh\ssh-key-2026-09-28.key` (+ `.pub`), moved out of the repo on 2026-09-29. Permissions: owner read-only. RSA 2048 |

## What this means for the plan
- **Path B** ([05-infrastructure](../../docs/05-infrastructure.md)): on the VM run the `api`, `caddy` (HTTPS on ports 80/443, D-10 interim) and `backup` containers (plus `ntfy` in P8). Postgres goes to **Supabase free**; create the project in the Singapore region to sit next to the VM.
- **1 GB RAM:**
  - add a 2 GB swap file;
  - cap the Node heap (e.g. `--max-old-space-size=384`);
  - build Docker images in GitHub Actions (amd64) and pull them from GHCR. Don't build on the VM.
- **Free Tier idle reclamation:** a Micro VM counts as idle if, over 7 days, CPU p95 < 20% and network < 20%. A light POS load may meet that. With Path B the VM holds **no data** (the database is on Supabase and backups are in OCI Object Storage), so if the VM is reclaimed, rebuilding it is a short scripted job (`infra/oracle/bootstrap.sh`, see `infra/RUNBOOK.md`) rather than a data loss. The account is now Pay-As-You-Go (owner-reported 2026-10-01), which costs ฿0 within Always Free, but Oracle's page states no PAYG exemption from idle reclamation, so the rebuild procedure stays important (docs/05 §3.1).

## SSH config entry (optional; add to `~/.ssh/config`)
```
Host pos-oracle
    HostName 161.118.211.42
    User ubuntu
    IdentityFile ~/.ssh/ssh-key-2026-09-28.key
    IdentitiesOnly yes
```
