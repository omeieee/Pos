#!/usr/bin/env bash
# Saap Don Sen POS — one-time (and re-runnable) host setup for the Oracle VM.
#
# Run by the OWNER from the laptop (repo root):
#   ssh pos-oracle 'sudo bash -s' < infra/oracle/bootstrap.sh
# Optional flags (env on the remote side):
#   ssh pos-oracle 'sudo INSTALL_FAIL2BAN=1 bash -s' < infra/oracle/bootstrap.sh
#
# Idempotent: every step checks before it changes anything. It never clones or
# downloads this (private) repo; CI copies the compose files to /opt/sds later.
#
# What it does (see infra/SETUP.md for the surrounding steps):
#   1. 2 GB swap file, low swappiness
#   2. unattended-upgrades (security) + reboot only Mondays 03:00-05:00 Asia/Bangkok
#   3. sshd: keys only, no root, no passwords
#   4. iptables: ACCEPT 80/443 before Oracle's REJECT rule (live + rules.v4)
#   5. Docker Engine + compose plugin, log rotation in daemon.json
#   6. Tailscale package (the owner runs `tailscale up` by hand, see SETUP.md)
#   7. `deploy` user in the docker group, /opt/sds owned by it
#   8. fail2ban (only with INSTALL_FAIL2BAN=1)
#
# The whole body is inside main() and stdin is detached first, because this
# script arrives on stdin: a child that reads stdin (apt, debconf) would
# otherwise eat the rest of the script.

set -euo pipefail

log() { printf '\n==> %s\n' "$*"; }

setup_swap() {
  log "Swap (2 GB)"
  if ! swapon --show=NAME --noheadings | grep -x /swapfile >/dev/null; then
    if [[ ! -f /swapfile ]]; then
      fallocate -l 2G /swapfile
      chmod 600 /swapfile
      mkswap /swapfile
    fi
    swapon /swapfile
  fi
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  printf 'vm.swappiness=10\n' > /etc/sysctl.d/90-sds-swap.conf
  sysctl -q -p /etc/sysctl.d/90-sds-swap.conf
}

setup_upgrades() {
  log "unattended-upgrades + Monday reboot window"
  # Never let the iptables-persistent package re-save live rules (Docker chains).
  echo 'iptables-persistent iptables-persistent/autosave_v4 boolean false' | debconf-set-selections
  echo 'iptables-persistent iptables-persistent/autosave_v6 boolean false' | debconf-set-selections
  apt-get update -q
  apt-get install -y -q unattended-upgrades ca-certificates curl gnupg iptables-persistent
  cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
  # unattended-upgrades itself never reboots; a timer below does, only on Mondays.
  cat > /etc/apt/apt.conf.d/52sds-unattended <<'EOF'
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
  cat > /etc/systemd/system/sds-reboot-if-required.service <<'EOF'
[Unit]
Description=Reboot if a package upgrade asked for it (SDS maintenance window)

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'if [ -f /var/run/reboot-required ]; then logger -t sds "reboot-required: rebooting in window"; systemctl reboot; fi'
EOF
  cat > /etc/systemd/system/sds-reboot-if-required.timer <<'EOF'
[Unit]
Description=SDS maintenance window: Mondays 03:00-05:00 Asia/Bangkok

[Timer]
OnCalendar=Mon *-*-* 03:00:00 Asia/Bangkok
RandomizedDelaySec=90min
Persistent=false

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now sds-reboot-if-required.timer
}

setup_sshd() {
  log "sshd: keys only"
  # sshd uses the FIRST value it reads; Ubuntu cloud images ship
  # 60-cloudimg-settings.conf, so ours must sort before it.
  cat > /etc/ssh/sshd_config.d/01-sds.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
X11Forwarding no
EOF
  sshd -t
  # Ubuntu 24.04 uses socket activation; reloading ssh.service re-reads config
  # for new connections without dropping the current one.
  systemctl reload ssh.service 2>/dev/null || systemctl restart ssh.service
}

iptables_allow() {
  local port="$1" rule_args pos
  rule_args=(-p tcp -m state --state NEW -m tcp --dport "$port" -j ACCEPT)
  # Live rule, inserted just before the first REJECT in INPUT.
  if ! iptables -C INPUT "${rule_args[@]}" 2>/dev/null; then
    pos="$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" && !found { print $1; found = 1 }')"
    if [[ -n "$pos" ]]; then
      iptables -I INPUT "$pos" "${rule_args[@]}"
    else
      iptables -A INPUT "${rule_args[@]}"
    fi
  fi
  # Persisted rule: edit rules.v4 as text instead of `netfilter-persistent save`,
  # so Docker's own chains are never frozen into the boot-time rules.
  local line="-A INPUT -p tcp -m state --state NEW -m tcp --dport ${port} -j ACCEPT"
  if ! grep -qxF -- "$line" /etc/iptables/rules.v4; then
    if grep -q '^-A INPUT -j REJECT' /etc/iptables/rules.v4; then
      sed -i "0,/^-A INPUT -j REJECT/s//${line//\//\\/}\n&/" /etc/iptables/rules.v4
    else
      echo "WARNING: no INPUT REJECT line in rules.v4; not editing it" >&2
    fi
  fi
}

setup_firewall() {
  log "iptables: allow 80/443"
  if [[ ! -f /etc/iptables/rules.v4 ]]; then
    echo "ERROR: /etc/iptables/rules.v4 missing (not an Oracle Ubuntu image?)" >&2
    exit 1
  fi
  iptables_allow 80
  iptables_allow 443
  # Port 22 stays as Oracle set it. The OCI security list is what closes it
  # to the internet once Tailscale SSH works (SETUP.md step order).
}

setup_docker() {
  log "Docker Engine + compose plugin"
  if ! command -v docker >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    # shellcheck disable=SC1091
    . /etc/os-release
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -q
    apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  local want tmp
  want='{
  "log-driver": "local",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}'
  tmp="$(mktemp)"
  printf '%s\n' "$want" > "$tmp"
  if ! cmp -s "$tmp" /etc/docker/daemon.json 2>/dev/null; then
    install -m 0644 "$tmp" /etc/docker/daemon.json
    systemctl restart docker
  fi
  rm -f "$tmp"
  systemctl enable --now docker
}

setup_tailscale() {
  log "Tailscale package"
  if ! command -v tailscale >/dev/null 2>&1; then
    # shellcheck disable=SC1091
    . /etc/os-release
    curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${VERSION_CODENAME}.noarmor.gpg" \
      -o /usr/share/keyrings/tailscale-archive-keyring.gpg
    curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${VERSION_CODENAME}.tailscale-keyring.list" \
      -o /etc/apt/sources.list.d/tailscale.list
    apt-get update -q
    apt-get install -y -q tailscale
  fi
  systemctl enable --now tailscaled
}

setup_deploy_user() {
  log "deploy user + /opt/sds"
  if ! id deploy >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash deploy
  fi
  passwd -l deploy >/dev/null   # no password login, ever
  usermod -aG docker deploy
  install -d -o deploy -g deploy -m 0750 /opt/sds
  if [[ -f /opt/sds/.env ]]; then
    chown deploy:deploy /opt/sds/.env
    chmod 600 /opt/sds/.env
  fi
}

setup_fail2ban() {
  if [[ "${INSTALL_FAIL2BAN:-0}" == "1" ]]; then
    log "fail2ban (sshd jail)"
    apt-get install -y -q fail2ban
    systemctl enable --now fail2ban
  fi
}

summary() {
  log "Summary"
  swapon --show
  free -m
  docker --version
  docker compose version
  tailscale version | sed -n '1p'
  tailscale status 2>/dev/null | sed -n '1,3p' || echo "tailscale: not logged in yet (run: sudo tailscale up --ssh --advertise-tags=tag:server)"
  iptables -L INPUT -n --line-numbers | sed -n '1,12p'
  id deploy
  ls -ld /opt/sds
  systemctl list-timers sds-reboot-if-required.timer --no-pager | sed -n '1,3p'
  echo
  echo "bootstrap: OK"
}

main() {
  exec </dev/null
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Run as root: ssh pos-oracle 'sudo bash -s' < infra/oracle/bootstrap.sh" >&2
    exit 1
  fi
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
  setup_swap
  setup_upgrades
  setup_sshd
  setup_firewall
  setup_docker
  setup_tailscale
  setup_deploy_user
  setup_fail2ban
  summary
}

main "$@"
