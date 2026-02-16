# Deploy

Systemd-based deployment for running multiple vaults-rebalancer instances (one per asset).

## Prerequisites

- Linux server with systemd
- Node.js and pnpm installed
- Base `.env` + per-asset `.env-<asset>` files in `/home/copilot/hubra-vaults-rebalancer`

## Setup

```bash
sudo bash deploy/setup.sh
```

This will:
1. Run `pnpm i && pnpm run build` (as `copilot` user)
2. Install the `vaults-rebalancer@.service` systemd template
3. Install CLI tools: `vaults-rebalancer-{logs,health,status,restart}`
4. Auto-discover all `.env-*` files and enable a service for each

## How It Works

`vaults-rebalancer@.service` is a systemd [template unit](https://www.freedesktop.org/software/systemd/man/systemd.unit.html#Description). The `%i` placeholder resolves to the instance name passed after `@`.

For `vaults-rebalancer@usdc`:
- Loads `.env` (base config) then `.env-usdc` (asset overrides)
- Sets `ENV_FILE=.env-usdc` so the app's dotenv layering in `config.ts` works
- Auto-restarts on failure with 5s delay
- Starts on boot

## Commands

### Logs

```bash
vaults-rebalancer-logs              # tail all instances
vaults-rebalancer-logs usdc         # tail one instance
vaults-rebalancer-logs usdc usdt    # tail specific instances
vaults-rebalancer-logs usdc -n 100  # pass extra journalctl flags
```

### Health check

```bash
vaults-rebalancer-health            # quick OK/FAIL for all
vaults-rebalancer-health usdc usdt  # specific instances
```

### Status

```bash
vaults-rebalancer-status            # detailed status for all
vaults-rebalancer-status usdc       # specific instance
```

### Restart

```bash
vaults-rebalancer-restart           # restart all instances
vaults-rebalancer-restart usdc      # restart specific instance
```

## Adding a New Asset

1. Create `.env-<asset>` in the project root
2. Run `systemctl enable --now vaults-rebalancer@<asset>` (or re-run `setup.sh`)

## Removing an Asset

```bash
systemctl disable --now vaults-rebalancer@<asset>
```
