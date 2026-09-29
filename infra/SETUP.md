# P2 setup checklist (owner)

The owner does these steps; Claude wrote the scripts. They are grouped into **rounds**, so you can do a whole round and then report back once.

**Rules for every step**
- **Never paste a secret into chat.** Secrets go only into GitHub → Settings → Secrets, or into `/opt/sds/.env` on the VM, typed with your own editor.
- "Tell Claude" lists the only things to send back: yes/no, public names and command output that has no secrets in it.
- Run the laptop commands in **Git Bash** from the repo root (`C:\omeie_code\project\Pos`). PowerShell's `<` and `|` into `ssh` can break the scripts.
- The public IP `138.2.67.89` appears in two places (see RUNBOOK "IP changed"): the GitHub variable `API_HOST` and `API_HOST` in `/opt/sds/.env`. The hostname is `138-2-67-89.sslip.io`.

---

## Round 1 — accounts and consoles (browser only, no VM changes)

### 1.1 Accounts (sign up with omeza25482548@gmail.com)
| Service | Free plan | Used for |
|---|---|---|
| [Tailscale](https://login.tailscale.com/start) | Personal | Admin SSH and CI deploys, with no public SSH port |
| [healthchecks.io](https://healthchecks.io) | Hobbyist | Alert when a backup is missed |
| [UptimeRobot](https://uptimerobot.com) | Free (5-min checks) | Alert when the API is down. Its `/readyz` checks also touch the DB |
| [Sentry](https://sentry.io) | Developer | API errors |

Install **Tailscale on the laptop** (and on your phone if you like) and log in with the same account.

### 1.2 Tailscale access policy (do this BEFORE the VM joins)
Admin console → **Access controls** → replace the policy with the one below → **Save**.

```jsonc
{
  "tagOwners": {
    "tag:server": ["autogroup:admin"],
    "tag:ci":     ["autogroup:admin"]
  },
  "grants": [
    // your own devices can reach everything on the tailnet
    { "src": ["autogroup:member"], "dst": ["*"], "ip": ["*"] },
    // GitHub Actions runners can only reach SSH on the server
    { "src": ["tag:ci"], "dst": ["tag:server"], "ip": ["tcp:22"] }
  ],
  "ssh": [
    // you: ubuntu (admin) or deploy on the server
    { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:server"], "users": ["ubuntu", "deploy"] },
    // CI: only the deploy user, no human check (it runs unattended)
    { "action": "accept", "src": ["tag:ci"], "dst": ["tag:server"], "users": ["deploy"] }
  ]
}
```
For extra safety you can change your own rule to `"action": "check"`. Tailscale will then ask you to re-confirm in the browser every 12 h. The CI rule must stay `accept`.

**Tell Claude:** "Tailscale policy saved".

### 1.3 Tailscale OAuth client for GitHub Actions
Admin console → **Settings → Trust credentials** (older consoles: **OAuth clients**) → **Generate / Add** →
- scope **Auth Keys: Write**;
- tag **`tag:ci`**.

Copy the **client ID** and **secret** straight into GitHub (step 1.8). Unlike an auth key, an OAuth client does not expire.

### 1.4 OCI: open 80/443 in the security list
OCI console → **Networking → Virtual cloud networks → `vcn-20260929-0215` → Subnets → `subnet-20260929-0215` → Security → Default Security List → Security rules → Add Ingress Rules**. Add two rules:

| Source CIDR | IP protocol | Destination port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

Leave the port 22 rule for now; it is removed in step 2.6.

### 1.5 OCI: backup bucket and S3 key
1. **Namespace:** click your profile (top right) → **Tenancy** → copy **Object storage namespace**. It is a short lowercase string, and it is not a secret.
2. **Bucket:** **Storage → Object Storage → Buckets** → region **Singapore** → compartment `omeza25482548` (root) → **Create bucket**:
   - name `sds-backups`;
   - Default storage tier **Standard**;
   - Encryption: Oracle-managed keys;
   - **Object versioning: Disabled**, so pruned dumps really go away and stay inside the 20 GB free.
   The bucket is private by default; keep it that way.
3. **Customer Secret Key:** profile → **My profile** → **Customer secret keys** → **Generate secret key**, name `sds-backup`.
   - The **secret** is shown only once. Put it straight into your editor for `/opt/sds/.env` (step 2.7), or into a text file on the USB drive.
   - The **Access key** appears in the list afterwards.
   - This key can use Object Storage only, but with **your** permissions. Optional hardening (later): a dedicated IAM user limited to this bucket.

**Tell Claude:** "bucket created, namespace is `<namespace>`" (the namespace is fine to share; the keys are not).

### 1.6 age key pair for backups (laptop)
In PowerShell: `winget install --id FiloSottile.age`, then open a new Git Bash:
```bash
age-keygen -o /e/sds-backup.agekey   # E: = the USB drive; use your drive letter
```
- It prints `Public key: age1...`. That public key goes into `/opt/sds/.env` as `AGE_RECIPIENT`. It is not secret.
- **Print** the file (it contains `AGE-SECRET-KEY-1...`) and keep the paper and the USB drive at home, apart from the laptop.
- Don't keep the private key on the laptop or the VM. **Without it, no backup can be read.**

### 1.7 healthchecks.io check
**Add Check** →
- name `sds-backup`;
- **Schedule: Cron** `5 0,5,10-23 * * *`;
- **Time zone** `Asia/Bangkok`;
- **Grace time** 30 minutes.

Integrations: email (default). Copy the **ping URL** for `.env` (`HC_PING_URL`). Treat it as a secret-ish value, because anyone with it can send fake pings.

### 1.8 Cloudflare token and account ID
- Dashboard → any page → **Account ID** (right column, or Workers & Pages overview) → copy.
- **My Profile → API Tokens → Create Token → Create Custom Token**:
  - name `github-pages-deploy`;
  - Permissions: **Account · Cloudflare Pages · Edit**;
  - Account resources: your account only.
  - Create, then copy the token.
- If a deploy later fails with an error about `/memberships`, edit the token and add **User · User Details · Read**.

The Pages projects `sds-pos` and `sds-order` are created by the workflow on its first run.

### 1.9 Supabase
- **Connection string:** Project → **Connect** → **Session pooler** (port **5432**, user `postgres.yejvrooxqdpynruwnegg`) → copy the URI and put in your DB password.
  - If the password contains `@ : / ? #`, URL-encode them (`@` → `%40`, `:` → `%3A`, `/` → `%2F`, `?` → `%3F`, `#` → `%23`).
  - **Not** the transaction pooler (6543), and **not** `db.yejvrooxqdpynruwnegg.supabase.co`, which is IPv6-only and unreachable from the VM.
- **Optional:** Project Settings → **Data API** → disable it. We don't use PostgREST; this removes a public surface.

### 1.10 GitHub secrets and variables
Repo → **Settings → Secrets and variables → Actions**.

| Kind | Name | Value |
|---|---|---|
| Secret | `TS_OAUTH_CLIENT_ID` | from 1.3 |
| Secret | `TS_OAUTH_SECRET` | from 1.3 |
| Secret | `CLOUDFLARE_API_TOKEN` | from 1.8 |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | from 1.8 |
| Variable | `API_HOST` | `138-2-67-89.sslip.io` |
| Variable | `DEPLOY_HOST` | `sds-pos` (the VM's Tailscale machine name, step 2.2) |
| Variable | `DEPLOY_ENABLED` | leave **unset** until step 3.1 |
| Variable | `WEB_DEPLOY_ENABLED` | leave **unset** until step 3.4 |

- The **database password is not needed in GitHub**: migrations run on the VM with `/opt/sds/.env`. Keep it out of GitHub unless a later workflow needs it.
- **No SSH deploy key is needed:** CI signs in through Tailscale SSH as `deploy` (policy in 1.2). If Tailscale SSH ever has to be turned off, the fallback is a dedicated ed25519 key in a `DEPLOY_SSH_KEY` secret; ask Claude to switch the workflow.

**Tell Claude (end of round 1):** "Round 1 done", plus anything that didn't match the steps.

---

## Round 2 — the VM (Git Bash on the laptop)

### 2.0 SSH shortcut (once)
If `ssh pos-oracle` doesn't work yet, add this to `~/.ssh/config` (Git Bash: `notepad ~/.ssh/config`). It refers to the key by path only:
```
Host pos-oracle
    HostName 138.2.67.89
    User ubuntu
    IdentityFile ~/.ssh/ssh-key-2026-09-28.key
    IdentitiesOnly yes
```
Test: `ssh pos-oracle 'uname -a'` should print a Linux line.

### 2.1 Bootstrap
```bash
ssh pos-oracle 'sudo bash -s' < infra/oracle/bootstrap.sh
```
It takes about 3–6 minutes. It is safe to run again. **Expected** last lines:
- swap `2G`;
- Docker and compose versions;
- `tailscale: not logged in yet`;
- the INPUT rules showing `dpt:80` and `dpt:443` **above** the `REJECT` line;
- `uid=...(deploy) ... groups=...docker`;
- `bootstrap: OK`.

It never downloads the repo. Your current SSH session is not dropped.

### 2.2 Join the VM to the tailnet
```bash
ssh pos-oracle
sudo tailscale up --ssh --advertise-tags=tag:server --hostname=sds-pos
```
- Open the printed URL in your browser and approve it.
- If it says the tag is not permitted, step 1.2 was not saved.
- Check: `tailscale status` lists `sds-pos` and your laptop.
- Turn on auto-updates: `sudo tailscale set --auto-update`. Security-only unattended-upgrades don't cover the Tailscale and Docker repos.

### 2.3 Key expiry off
Tailscale admin → **Machines → sds-pos** → the ⋯ menu → **Disable key expiry**. Tagged machines usually have it off already; confirm it says "Expiry disabled". A VM whose key expires silently drops off the tailnet.

### 2.4 Prove SSH over the tailnet (new terminal)
```bash
ssh ubuntu@sds-pos 'whoami; hostname'        # expect: ubuntu
ssh deploy@sds-pos 'whoami; docker ps'       # expect: deploy + an empty container list
```
No key is involved: Tailscale checks your tailnet login. Add a shortcut to `~/.ssh/config`:
```
Host pos-ts
    HostName sds-pos
    User ubuntu
```

### 2.5 Tell Claude: "tailnet SSH works"
**Only after 2.4 works**, go on to 2.6.

### 2.6 Close port 22 to the internet
OCI security list (as in 1.4) → **delete the ingress rule for TCP 22**. Then check:
```bash
ssh -o ConnectTimeout=10 pos-oracle true   # expect: timeout (public SSH closed)
ssh pos-ts true && echo tailnet-ok         # expect: tailnet-ok
```
**Break-glass** if Tailscale ever fails:
1. Re-add a TCP 22 ingress rule **from your current IP only** (`x.x.x.x/32`, see whatismyip.com). `ssh pos-oracle` then works again with your key, because sshd is still running. Remove the rule afterwards.
2. OCI console → Instance → **Console connection** (via Cloud Shell). It gives a serial console, where login needs a local password. The `ubuntu` user has none by default. Set one once with `sudo passwd ubuntu` if you want this path; SSH password login stays disabled either way.

### 2.7 Create `/opt/sds/.env`
```bash
ssh pos-ts 'sudo -u deploy tee /opt/sds/.env.example >/dev/null' < infra/compose/.env.example
ssh -t pos-ts 'sudo -u deploy cp -n /opt/sds/.env.example /opt/sds/.env; sudo chmod 600 /opt/sds/.env; sudo -u deploy nano /opt/sds/.env'
```
- Fill in every value from round 1. Keep the **single quotes** around each value.
- `API_HOST='138-2-67-89.sslip.io'`.
- `ACME_EMAIL` is your email.
- `SENTRY_DSN`: Sentry → create project (platform Node.js) → Client Keys → DSN. It may stay empty for now.

Check, without printing values:
```bash
ssh pos-ts 'sudo ls -l /opt/sds/.env; sudo file /opt/sds/.env; sudo grep -oE "^[A-Z_0-9]+=" /opt/sds/.env'
```
**Expected:**
- `-rw------- 1 deploy deploy`;
- `ASCII text` (it must **not** say `with CRLF line terminators`);
- the list of variable names.

**Tell Claude (end of round 2):** paste the bootstrap summary (it has no secrets) and the output of the check above.

---

## Round 3 — first deploys and checks

### 3.1 First API deploy
- GitHub → Variables → set `DEPLOY_ENABLED` = `true`.
- **Actions → Deploy API → Run workflow** (leave `image_tag` empty).
- **Expected:** both jobs green, and the summary shows the image tags.
  - The first run skips the pre-deploy backup, because the backup service isn't running yet.
  - Caddy gets its certificate on the first HTTPS request. The smoke test retries for about 1 minute.

Check from anywhere:
```bash
curl -sS https://138-2-67-89.sslip.io/healthz
ssh deploy@sds-pos '/opt/sds/dc ps'            # expect: api, caddy, backup all "healthy"
```

### 3.2 Let the workflow prune old images
GitHub → your profile → **Packages → pos-api → Package settings → Manage Actions access → Add repository** → this repo, role **Admin**. Do the same for **pos-backup**. Without this, the prune step only warns.

### 3.3 External check
**Actions → External check → Run workflow.** **Expected:** green:
- HTTPS OK;
- the issuer printed (should be Let's Encrypt);
- 80/443 open;
- 22, 3000, 5432 and 2019 closed.

### 3.4 Web apps
- Set the variable `WEB_DEPLOY_ENABLED` = `true`, then **Actions → Deploy web apps → Run workflow**.
- **Expected:** `https://sds-pos.pages.dev` and `https://sds-order.pages.dev` load.

This needs the backend agent's `apps/pos-web` and `apps/liff-web` to exist.

### 3.5 Monitors
- **UptimeRobot:** New monitor → HTTP(s) → `https://138-2-67-89.sslip.io/readyz` → every 5 min → alert to your email.
- **healthchecks.io:** after the next hh:05 during opening hours (or 05:05), the `sds-backup` check turns green.
- **Prove the missed-backup alert (exit criterion):**
  1. healthchecks.io → `sds-backup` → **Integrations** → email → **Test**, and confirm the email arrives;
  2. once, outside opening hours, run `ssh deploy@sds-pos '/opt/sds/dc stop backup'` before a scheduled slot and wait until the check goes **Down** (slot + 30 min grace) and the email arrives;
  3. then `ssh deploy@sds-pos '/opt/sds/dc up -d backup'`.
- **Sentry:** trigger nothing yet. The DSN in `.env` is enough; the API reports errors.

### 3.6 Prove the backup and restore (exit criterion)
1. List the objects (OCI console → bucket → Objects), or run:
   ```bash
   ssh deploy@sds-pos '/opt/sds/dc exec -T backup backup-list'
   ```
2. Run the restore drill with the USB key:
   ```bash
   ssh deploy@sds-pos '/opt/sds/run-restore-drill.sh' < /e/sds-backup.agekey
   ```
   **Expected:** a table of restored vs production row counts, `drizzle migrations: restored=N prod=N`, and `DRILL PASSED`.

### 3.7 Try a rollback once (exit criterion)
Follow RUNBOOK → **Rollback**, option B (redeploy an older sha), then deploy `main` again.

**Tell Claude (end of round 3):** the URLs of the green workflow runs, the `dc ps` output, the object listing and the drill output (none of these contain secrets).
