#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
UNIT_FILE="$SCRIPT_DIR/vaults-rebalancer@.service"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0"
  exit 1
fi

WORK_DIR="$(grep -oP '(?<=WorkingDirectory=).*' "$UNIT_FILE")"
SERVICE_USER="$(grep -oP '(?<=User=).*' "$UNIT_FILE")"

# ── 1. Build ────────────────────────────────────────────────
echo "=== Building application ==="
sudo -u "$SERVICE_USER" bash -c "cd $WORK_DIR && pnpm i && pnpm run build"

# ── 2. Discover instances ───────────────────────────────────
mapfile -t instances < <(find "$WORK_DIR" -maxdepth 1 -name '.env-*' -printf '%f\n' | sed 's/^\.env-//' | sort)

if [[ ${#instances[@]} -eq 0 ]]; then
  echo "No .env-* files found in $WORK_DIR — nothing to enable."
  exit 0
fi

echo "Discovered instances: ${instances[*]}"

# ── 3. Assign health server ports ────────────────────────
BASE_PORT=8080
echo ""
echo "=== Assigning health server ports ==="
port_idx=0
for inst in "${instances[@]}"; do
  assigned_port=$((BASE_PORT + port_idx))
  env_file="$WORK_DIR/.env-${inst}"
  if grep -q '^HEALTH_SERVER_PORT=' "$env_file" 2>/dev/null; then
    sed -i "s/^HEALTH_SERVER_PORT=.*/HEALTH_SERVER_PORT=${assigned_port}/" "$env_file"
  else
    echo "HEALTH_SERVER_PORT=${assigned_port}" >> "$env_file"
  fi
  echo "  ${inst} → port ${assigned_port}"
  port_idx=$((port_idx + 1))
done

# ── 4. Systemd services ────────────────────────────────────
echo ""
echo "=== Installing systemd services ==="
cp "$UNIT_FILE" /etc/systemd/system/vaults-rebalancer@.service
systemctl daemon-reload

for inst in "${instances[@]}"; do
  systemctl enable --now "vaults-rebalancer@${inst}"
  echo "  enabled vaults-rebalancer@${inst}"
done

# ── 5. CLI helper scripts ──────────────────────────────────
echo ""
echo "=== Installing CLI tools ==="
install_cli() {
  local name="$1" body="$2"
  local path="/usr/local/bin/vaults-rebalancer-${name}"
  cat > "$path" <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail
WORK_DIR="$WORK_DIR"
${body}
SCRIPT
  chmod +x "$path"
  echo "  installed vaults-rebalancer-${name}"
}

# Helper: resolve instance list (args or all discovered)
RESOLVE_INSTANCES='
resolve_instances() {
  if [[ $# -gt 0 ]]; then
    echo "$@"
  else
    find "$WORK_DIR" -maxdepth 1 -name ".env-*" -printf "%f\n" | sed "s/^\.env-//" | sort
  fi
}
'

install_cli "logs" "${RESOLVE_INSTANCES}
instances=(\$(resolve_instances \"\$@\"))
units=()
for i in \"\${instances[@]}\"; do
  units+=(-u \"vaults-rebalancer@\${i}\")
done
journalctl \"\${units[@]}\" -f --no-hostname -o cat
"

install_cli "health" "${RESOLVE_INSTANCES}
instances=(\$(resolve_instances \"\$@\"))
for inst in \"\${instances[@]}\"; do
  port=\$(grep -oP '(?<=HEALTH_SERVER_PORT=)\\d+' \"\$WORK_DIR/.env-\${inst}\" 2>/dev/null || grep -oP '(?<=HEALTH_SERVER_PORT=)\\d+' \"\$WORK_DIR/.env\" 2>/dev/null || echo 8080)
  if curl -sf \"http://localhost:\${port}/health\" > /dev/null 2>&1; then
    echo \"  \${inst}: OK (:\${port})\"
  else
    echo \"  \${inst}: FAIL (:\${port})\"
  fi
done
"

install_cli "status" "${RESOLVE_INSTANCES}
instances=(\$(resolve_instances \"\$@\"))
for inst in \"\${instances[@]}\"; do
  systemctl status \"vaults-rebalancer@\${inst}\" --no-pager || true
  echo \"\"
done
"

install_cli "restart" "${RESOLVE_INSTANCES}
instances=(\$(resolve_instances \"\$@\"))
for inst in \"\${instances[@]}\"; do
  systemctl restart \"vaults-rebalancer@\${inst}\"
  echo \"  restarted vaults-rebalancer@\${inst}\"
done
"

# ── 6. Docker (for monitoring stack) ───────────────────────
echo ""
echo "=== Setting up monitoring stack ==="

if ! command -v docker &> /dev/null; then
  echo "Docker not found, installing..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  usermod -aG docker "$SERVICE_USER"
  echo "  Docker installed"
else
  echo "  Docker already installed"
fi

# ── 7. Firewall rules for Docker → host access ──────────
if command -v ufw &> /dev/null && ufw status | grep -q "active"; then
  echo ""
  echo "=== Configuring UFW for Docker bridge access ==="
  port_idx=0
  for inst in "${instances[@]}"; do
    assigned_port=$((BASE_PORT + port_idx))
    ufw allow from 172.16.0.0/12 to any port "${assigned_port}" proto tcp > /dev/null 2>&1
    echo "  allowed 172.16.0.0/12 → port ${assigned_port}"
    port_idx=$((port_idx + 1))
  done
  ufw allow from 172.16.0.0/12 to any port 9090 proto tcp > /dev/null 2>&1
  echo "  allowed 172.16.0.0/12 → port 9090 (Prometheus)"
  ufw reload > /dev/null 2>&1
fi

# ── 8. Generate Prometheus config with all instance targets ─
MONITORING_DIR="$WORK_DIR/monitoring"
mkdir -p "$MONITORING_DIR"

# Generate per-instance targets with asset labels
STATIC_CONFIGS=""
for inst in "${instances[@]}"; do
  port=$(grep -oP '(?<=HEALTH_SERVER_PORT=)\d+' "$WORK_DIR/.env-${inst}" 2>/dev/null \
      || grep -oP '(?<=HEALTH_SERVER_PORT=)\d+' "$WORK_DIR/.env" 2>/dev/null \
      || echo "8080")
  STATIC_CONFIGS="${STATIC_CONFIGS}
      - targets: [\"host.docker.internal:${port}\"]
        labels:
          asset: \"${inst}\""
done

cat > "$MONITORING_DIR/prometheus.yml" <<PROM
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: "rebalancer"
    static_configs:${STATIC_CONFIGS}
PROM

echo "  Generated prometheus.yml with per-asset targets"

# ── 9. Copy monitoring configs + dashboard ──────────────────
GRAFANA_PROV="$MONITORING_DIR/grafana/provisioning"
mkdir -p "$GRAFANA_PROV/datasources" "$GRAFANA_PROV/dashboards" "$MONITORING_DIR/dashboards"

cat > "$GRAFANA_PROV/datasources/prometheus.yml" <<DS
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    uid: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false
DS

cat > "$GRAFANA_PROV/dashboards/dashboards.yml" <<DP
apiVersion: 1
providers:
  - name: "default"
    orgId: 1
    folder: ""
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    options:
      path: /etc/grafana/dashboards
      foldersFromFilesStructure: false
DP

# Copy dashboard JSON from repo
cp "$REPO_DIR/grafana/rebalancer-dashboard.json" "$MONITORING_DIR/dashboards/"

cat > "$MONITORING_DIR/docker-compose.yml" <<DC
services:
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "127.0.0.1:9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus_data:/prometheus
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped

  grafana:
    image: grafana/grafana:latest
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      - GF_SECURITY_ADMIN_USER=admin
      - GF_SECURITY_ADMIN_PASSWORD=admin
      - GF_USERS_ALLOW_SIGN_UP=false
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer
      - GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH=/etc/grafana/dashboards/rebalancer-dashboard.json
    volumes:
      - ./grafana/provisioning:/etc/grafana/provisioning:ro
      - ./dashboards:/etc/grafana/dashboards:ro
      - grafana_data:/var/lib/grafana
    depends_on:
      - prometheus
    restart: unless-stopped

volumes:
  prometheus_data:
  grafana_data:
DC

# ── 10. Start monitoring ───────────────────────────────────
echo "  Starting Prometheus + Grafana..."
cd "$MONITORING_DIR"
sudo -u "$SERVICE_USER" docker compose up -d --pull always 2>/dev/null \
  || docker compose up -d --pull always

echo ""
echo "=== Setup complete ==="
echo ""
echo "Services:"
for inst in "${instances[@]}"; do
  port=$(grep -oP '(?<=HEALTH_SERVER_PORT=)\d+' "$WORK_DIR/.env-${inst}" 2>/dev/null \
      || grep -oP '(?<=HEALTH_SERVER_PORT=)\d+' "$WORK_DIR/.env" 2>/dev/null \
      || echo "8080")
  echo "  vaults-rebalancer@${inst}  →  http://localhost:${port}/health"
done
echo ""
echo "Monitoring:"
echo "  Grafana     →  http://localhost:3000  (admin/admin)"
echo "  Prometheus  →  http://localhost:9090"
echo ""
echo "CLI tools:"
echo "  vaults-rebalancer-logs              # tail all instances"
echo "  vaults-rebalancer-logs usdc         # tail specific instance"
echo "  vaults-rebalancer-health            # quick OK/FAIL check"
echo "  vaults-rebalancer-status            # detailed systemctl status"
echo "  vaults-rebalancer-restart           # restart all instances"
echo "  vaults-rebalancer-restart usdc      # restart specific instance"
