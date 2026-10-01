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
    // you: ubuntu (sudo = root) or deploy (docker group = root-equivalent) on the
    // server. "check" makes Tailscale ask you to re-confirm in the browser every
    // 12 h, so a stolen, logged-in laptop is not a standing root shell.
    { "action": "check", "src": ["autogroup:member"], "dst": ["tag:server"], "users": ["ubuntu", "deploy"] },
    // CI: only the deploy user, no human check (it runs unattended): must stay "accept"
    { "action": "accept", "src": ["tag:ci"], "dst": ["tag:server"], "users": ["deploy"] }
  ]
}
```
- With `check`, the first `ssh pos-ts` after 12 h prints a URL. Open it in the browser, approve, and the command continues. Scripts and Claude sessions that use SSH hit the same prompt.
- If you would rather have no prompts, set your own rule to `"accept"`; then anyone holding your logged-in laptop is root on the VM. The CI rule must stay `accept` either way.
- **This file is documentation: the live policy changes only when you paste it into the admin console and Save.** If you set up the policy earlier with `accept`, do that now (owner step, once).

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
   - This key can use Object Storage only, but with **your** permissions (it could delete every backup if the VM were compromised). Optional hardening: "H2" at the end of this file.

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
- **Require TLS (owner step, once; do it when the shop is closed, and keep this order):**
  1. Add **`?sslmode=require`** to the end of `DATABASE_URL` in `/opt/sds/.env` (the template already has it), then `ssh deploy@sds-pos '/opt/sds/dc up -d api backup'`.
  2. Check `curl -sS https://138-2-67-89.sslip.io/readyz` and that the next backup logs `OK` (or run `dc exec -T backup backup hourly`). If either fails, fix the URL before going on.
  3. Only then: Supabase → Project Settings → **Database** → SSL Configuration → turn **Enforce SSL on incoming connections** on, and repeat the two checks. (Turning it on first could cut off a client that still connects without TLS.)
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

- The **workflows already say `environment: production`** on the two jobs that use the Tailscale and Cloudflare secrets. Keep the four secrets above at repository level until "Optional hardening" (end of this file) says your GitHub plan can restrict that environment.
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
- **Expected:** the `plan`, `build` and `deploy` jobs are green, and the summary shows the commit and image tags.
  - The first run skips the pre-deploy backup only because there is no `/opt/sds/.deploy-state` yet (nothing deployed, nothing to back up). Every later deploy takes one, or stops if it cannot.
  - After this first manual run, deploys start by themselves when CI is green on `main` (see RUNBOOK "Deploys").
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
  2. once, outside opening hours, run `ssh deploy@sds-pos '/opt/sds/dc stop backup'` before a scheduled slot and wait until the check goes **Down** (slot + 30 min grace) and the email arrives. Don't restart before **slot + 55 min**: the Down fires at slot + grace, and a ping that lands near that moment (as happened on 2026-10-01 with a 45-min grace) leaves no Down email to prove anything. Check the Down in the check's **Log** tab as well as the inbox. Make sure the check is the one `HC_PING_URL` points at (it is named `sds-backup`, not the default "My First Check") and that the grace is really 30 min;
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

---

## Optional hardening (owner, after P2 is closed)

### H1. Whoever can run workflows on `main` is root on the VM
The deploy job signs in as `deploy`, and `deploy` is in the `docker` group, which is root-equivalent (RUNBOOK "Deploy trust model"). Controls that already work on any plan: deploys start only after green CI on `main` (or a manual run on `main`), and each runs the exact CI-verified commit. GitHub's stronger controls depend on your plan:

- **Check your plan** (GitHub → Settings → Billing and plans). GitHub's docs (checked 2026-09-29): for a **private** repo, environments with deployment-branch rules and environment secrets, and branch protection with required checks, need **GitHub Pro, Team or Enterprise**. On **Free** they are ignored, and `environment: production` in the workflows is only a label.
- **A paid plan costs money, so it is your decision.** Claude will not upgrade anything.
- **On Free:** keep the repo private with no collaborators, keep 2FA on your GitHub account, and set Settings → Actions → General → "Fork pull request workflows" to require approval.
- **On Pro/Team (or a public repo):**
  1. Settings → **Environments** → New environment `production` → Deployment branches and tags → **Selected branches** → `main`.
  2. Move `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` into that environment's secrets, then delete the repository-level copies. **Do this only if the plan supports it: on Free, environment secrets are ignored and the deploys would run with empty secrets.** The repository variables (`DEPLOY_ENABLED`, `API_HOST`, ...) stay where they are.
  3. Settings → **Branches** (or Rulesets) → protect `main`: require the status check **`check`** (the CI job) before merging. Changes then reach `main` through a pull request.
  4. Check: a manual **Deploy API** run started on `main` is green; deploy secrets are not readable from other branches.

### H2. Backup key with least privilege (free, ~15 min)
The key in `/opt/sds/.env` has all of your permissions. A key that can only create and read objects cannot be used to delete the backups. Do the steps in this order, so pruning never stops:
1. **Lifecycle rules first** (they replace the age-based pruning in `backup.sh`). OCI console → Object Storage → bucket `sds-backups` → **Lifecycle Policy Rules** → one **Delete** rule per prefix (Object name filter: prefix): `hourly/` after 2 days, `predeploy/` 14, `daily/` 31, `monthly/` 370. OCI needs this policy in the root compartment, or the rules do nothing: `Allow service objectstorage-ap-singapore-1 to manage object-family in tenancy`.
2. **A dedicated IAM user:** Identity → create user `sds-backup-writer` and group `sds-backup-writers` (add the user), then a policy in the root compartment (use the group-name form the console shows for your identity domain): `Allow group sds-backup-writers to manage objects in tenancy where all {target.bucket.name='sds-backups', any {request.permission='OBJECT_CREATE', request.permission='OBJECT_INSPECT', request.permission='OBJECT_READ'}}`. (Permission names checked in OCI's Object Storage policy reference on 2026-09-29; create = upload, inspect = list, read = download for restores.)
3. **New key:** as that user, generate a Customer Secret Key; put it in `/opt/sds/.env` (`OCI_S3_ACCESS_KEY_ID`, `OCI_S3_SECRET_ACCESS_KEY`), then `ssh deploy@sds-pos '/opt/sds/dc up -d backup'`. Prove it: `dc exec -T backup backup hourly`, `dc exec -T backup backup-list`, and one restore drill. Only then delete your own old key.
4. Expect `WARN: prune ... failed` lines in the backup log from then on. The key can't delete, so `backup.sh`'s own pruning is refused; the backup itself still succeeds. Not tested by Claude: verify step 3 before deleting the old key.
