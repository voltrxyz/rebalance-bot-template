# Deploy

Systemd-based deployment for running multiple rebalancer instances (one per asset).

## Prerequisites

- Linux server with systemd
- Node.js installed at `/usr/bin/node`
- Project built (`npm run build`) at `/home/copilot/rebalancer`
- Base `.env` + per-asset `.env.<asset>` files in the project root

## Setup

```bash
sudo bash deploy/setup.sh
```

This will:
1. Install the `rebalancer@.service` systemd template
2. Install `rebalancer-logs` and `rebalancer-health` CLI tools
3. Auto-discover all `.env.*` files and enable a service for each

## How It Works

`rebalancer@.service` is a systemd [template unit](https://www.freedesktop.org/software/systemd/man/systemd.unit.html#Description). The `%i` placeholder resolves to the instance name passed after `@`.

For `rebalancer@usdc`:
- Loads `.env` (base config) then `.env.usdc` (asset overrides)
- Sets `ENV_FILE=.env.usdc` so the app's dotenv layering in `config.ts` works
- Auto-restarts on failure with 5s delay
- Starts on boot

## Commands

### Service management

```bash
# Start/stop a single instance
systemctl start rebalancer@usdc
systemctl stop rebalancer@usdc
systemctl restart rebalancer@usdc

# Enable/disable on boot
systemctl enable rebalancer@usdc
systemctl disable rebalancer@usdc

# Check status
systemctl status rebalancer@usdc
```

### Logs

```bash
rebalancer-logs              # tail all instances
rebalancer-logs usdc         # tail one instance
rebalancer-logs usdc usdt    # tail specific instances
rebalancer-logs usdc -n 100  # pass extra journalctl flags
```

### Health checks

```bash
rebalancer-health            # check all instances
rebalancer-health usdc usdt  # check specific instances
```

## Adding a New Asset

1. Create `.env.<asset>` in the project root
2. Run `systemctl enable --now rebalancer@<asset>` (or re-run `setup.sh`)

## Removing an Asset

```bash
systemctl disable --now rebalancer@<asset>
```
