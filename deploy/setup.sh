#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNIT_FILE="$SCRIPT_DIR/rebalancer@.service"
BIN_DIR="/usr/local/bin"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0"
  exit 1
fi

cp "$UNIT_FILE" /etc/systemd/system/rebalancer@.service
systemctl daemon-reload

# rebalancer-logs [instance...] — tail logs for one, many, or all instances
cat > "$BIN_DIR/rebalancer-logs" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

instances=()
extra_args=()

for arg in "$@"; do
  if [[ "$arg" == -* ]]; then
    extra_args+=("$arg")
  else
    instances+=("$arg")
  fi
done

if [[ ${#instances[@]} -eq 0 ]]; then
  mapfile -t instances < <(systemctl list-units --type=service --plain --no-legend 'rebalancer@*' | awk '{print $1}' | sed 's/rebalancer@//;s/\.service//')
fi

if [[ ${#instances[@]} -eq 0 ]]; then
  echo "No rebalancer instances found."
  exit 1
fi

units=()
for inst in "${instances[@]}"; do
  units+=(-u "rebalancer@${inst}")
done

journalctl -f "${units[@]}" "${extra_args[@]}"
SCRIPT
chmod +x "$BIN_DIR/rebalancer-logs"

# rebalancer-health [instance...] — check health of instances
cat > "$BIN_DIR/rebalancer-health" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

instances=("$@")
if [[ ${#instances[@]} -eq 0 ]]; then
  mapfile -t instances < <(systemctl list-units --type=service --plain --no-legend 'rebalancer@*' | awk '{print $1}' | sed 's/rebalancer@//;s/\.service//')
fi

if [[ ${#instances[@]} -eq 0 ]]; then
  echo "No rebalancer instances found."
  exit 1
fi

for inst in "${instances[@]}"; do
  unit="rebalancer@${inst}.service"
  active=$(systemctl is-active "$unit" 2>/dev/null || true)
  if [[ "$active" == "active" ]]; then
    echo "[OK]   $inst"
  else
    echo "[FAIL] $inst ($active)"
  fi
done
SCRIPT
chmod +x "$BIN_DIR/rebalancer-health"

WORK_DIR="$(grep -oP '(?<=WorkingDirectory=).*' "$UNIT_FILE")"
mapfile -t instances < <(find "$WORK_DIR" -maxdepth 1 -name '.env.*' -printf '%f\n' | sed 's/^\.env\.//' | sort)

if [[ ${#instances[@]} -eq 0 ]]; then
  echo "No .env.* files found in $WORK_DIR — nothing to enable."
  exit 0
fi

echo "Discovered instances: ${instances[*]}"
for inst in "${instances[@]}"; do
  systemctl enable --now "rebalancer@${inst}"
  echo "  enabled rebalancer@${inst}"
done

echo ""
echo "Installed:"
echo "  /etc/systemd/system/rebalancer@.service"
echo "  $BIN_DIR/rebalancer-logs"
echo "  $BIN_DIR/rebalancer-health"
echo ""
echo "Commands:"
echo "  rebalancer-logs              # all instances"
echo "  rebalancer-logs usdc usdt    # specific instances"
echo "  rebalancer-health            # check all"
