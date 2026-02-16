#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNIT_FILE="$SCRIPT_DIR/vaults-rebalancer@.service"
if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0"
  exit 1
fi

WORK_DIR="$(grep -oP '(?<=WorkingDirectory=).*' "$UNIT_FILE")"

echo "Installing dependencies and building..."
sudo -u copilot bash -c "cd $WORK_DIR && pnpm i && pnpm run build"

cp "$UNIT_FILE" /etc/systemd/system/vaults-rebalancer@.service
systemctl daemon-reload

mapfile -t instances < <(find "$WORK_DIR" -maxdepth 1 -name '.env-*' -printf '%f\n' | sed 's/^\.env-//' | sort)

if [[ ${#instances[@]} -eq 0 ]]; then
  echo "No .env.* files found in $WORK_DIR — nothing to enable."
  exit 0
fi

echo "Discovered instances: ${instances[*]}"
for inst in "${instances[@]}"; do
  systemctl enable --now "vaults-rebalancer@${inst}"
  echo "  enabled vaults-rebalancer@${inst}"
done

echo ""
echo "Done. From $WORK_DIR run:"
echo "  ./logs              # tail all instances"
echo "  ./logs usdc         # tail specific instance"
echo "  ./health            # quick OK/FAIL check"
echo "  ./status            # detailed systemctl status"
echo "  ./restart           # restart all instances"
echo "  ./restart usdc      # restart specific instance"
