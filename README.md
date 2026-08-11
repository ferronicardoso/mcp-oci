# mcp-oci

[![Docker Publish](https://github.com/ferronicardoso/mcp-oci/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/ferronicardoso/mcp-oci/actions/workflows/docker-publish.yml)
[![GHCR](https://img.shields.io/badge/ghcr.io-mcp--oci-2496ED?logo=docker&logoColor=white)](https://github.com/ferronicardoso/mcp-oci/pkgs/container/mcp-oci)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](package.json)

Production-oriented MCP server for Oracle Cloud Infrastructure (OCI), exposing Compute, Networking and Object Storage operations to MCP clients (Claude Desktop, VS Code Copilot, Cursor, and compatible hosts).

## Features

- Four authentication modes: config file (API key), inline API key, instance principal, and session token
- Per-call region override (`region` argument) on every Compute/Networking/Object Storage tool — query any OCI region without restarting the server
- Trimmed-by-default responses: list/get tools return a lean summary per resource instead of the full OCI SDK object (which can run 100+ fields deep, e.g. SSH keys and agent plugin configs on an instance); pass `raw=true` to get the untrimmed object
- Read-only enforcement independent of IAM policy: mutating tools can be blocked at the server level
- Compute instance discovery, VNIC inspection, and lifecycle actions
- Networking discovery: VCNs, subnets, security lists, NSGs, route tables
- Object Storage discovery and management: buckets and objects
- Environment-driven configuration for secure deployment

## Available Tools

| Tool | Mutating | Trimmed by default | Description |
|---|---|---|---|
| `list_regions` | No | — | Lists the tenancy's subscribed regions — resolves a name (e.g. "Vinhedo") to its region ID (e.g. `sa-vinhedo-1`) |
| `list_compartments` | No | — | Lists compartments by name and/or parent — resolves a name (e.g. "cpLinux") to its OCID |
| `list_instances` | No | Yes | Lists Compute instances in a compartment |
| `get_instance` | No | Yes | Returns details of a specific Compute instance |
| `list_vnic_attachments` | No | Yes | Lists VNIC attachments in a compartment/instance |
| `instance_action` | Yes | — | Performs START/STOP/SOFTSTOP/RESET/SOFTRESET/SENDDIAGNOSTICINTERRUPT on an instance |
| `list_vcns` | No | Yes | Lists Virtual Cloud Networks in a compartment |
| `get_vcn` | No | Yes | Returns details of a specific VCN |
| `list_subnets` | No | Yes | Lists subnets in a compartment/VCN |
| `list_security_lists` | No | Yes | Lists security lists in a compartment/VCN (rule counts only — use `raw=true` for the actual rules) |
| `list_network_security_groups` | No | Yes | Lists NSGs in a compartment/VCN |
| `list_route_tables` | No | Yes | Lists route tables in a compartment/VCN (route count only — use `raw=true` for the actual routes) |
| `get_namespace` | No | — | Returns the Object Storage namespace for the tenancy |
| `list_buckets` | No | Yes | Lists Object Storage buckets in a compartment |
| `get_bucket` | No | Yes | Returns details of a specific bucket |
| `list_objects` | No | — | Lists objects in a bucket, optional prefix filter (the SDK object here is already lean) |
| `create_bucket` | Yes | — | Creates an Object Storage bucket |
| `delete_object` | Yes | — | Deletes an object from a bucket |

Tools marked **Mutating** are rejected by the server when `OCI_READ_ONLY=true` (the default), regardless of IAM permissions — a second layer of least-privilege enforcement on top of your OCI policies.

Tools marked **Trimmed by default** accept a `raw` boolean argument (default `false`) — set `raw=true` to get the untrimmed OCI SDK object instead of the summary (id, name, state, and the handful of fields that matter day-to-day).

## Requirements

- Node.js 18+
- An OCI tenancy with credentials for one of the supported authentication modes
- Network connectivity from the MCP host to the OCI region endpoints

## Configuration

### Authentication mode

| Variable | Required | Default | Description |
|---|---|---|---|
| `OCI_AUTH_MODE` | No | `config` | `config` \| `apikey` \| `instance_principal` \| `session` |
| `OCI_READ_ONLY` | No | `true` | When `true`, blocks all mutating tools (see table above) |
| `OCI_REGION` | No | region from config/session | Default region when a tool call doesn't pass `region` (required in `apikey` mode) |

When a tool call omits `compartmentId`, it defaults to the tenancy root compartment (resolved from the auth provider). This doesn't work in `instance_principal` mode — the provider doesn't expose the tenancy OCID there, so `compartmentId` must be passed explicitly (use `list_compartments` to look it up by name first).

Compute, Networking and Object Storage resources are region-scoped in OCI. Every tool that touches them accepts an optional `region` argument (e.g. `sa-vinhedo-1`) to query a specific region without restarting the server; omitting it falls back to `OCI_REGION` or the config/session file's default region. `list_compartments` and `list_regions` are unaffected — compartments and region subscriptions are tenancy-wide, not regional.

### `config` mode (API key via `~/.oci/config`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `OCI_CONFIG_FILE` | No | `~/.oci/config` | Path to the OCI config file |
| `OCI_CONFIG_PROFILE` | No | `DEFAULT` | Profile name inside the config file |

### `session` mode (`oci session authenticate` token)

Uses the same `OCI_CONFIG_FILE` / `OCI_CONFIG_PROFILE` variables as `config` mode, pointing to a profile with a `security_token_file`.

### `apikey` mode (inline API key, no config file)

| Variable | Required | Description |
|---|---|---|
| `OCI_TENANCY_ID` | Yes | Tenancy OCID |
| `OCI_USER_ID` | Yes | User OCID |
| `OCI_FINGERPRINT` | Yes | API key fingerprint |
| `OCI_REGION` | Yes | Region ID (e.g. `sa-saopaulo-1`) |
| `OCI_PRIVATE_KEY` | Yes* | PEM private key content (`\n` escaped) |
| `OCI_PRIVATE_KEY_PATH` | Yes* | Path to the PEM private key file (alternative to `OCI_PRIVATE_KEY`) |
| `OCI_PRIVATE_KEY_PASSPHRASE` | No | Private key passphrase, if any |

\* Provide either `OCI_PRIVATE_KEY` or `OCI_PRIVATE_KEY_PATH`.

### `instance_principal` mode

No extra variables required — credentials are resolved from the instance metadata service. Only works when the MCP server itself runs on an OCI Compute instance (or OKE pod configured for it).

### Transport

| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_TRANSPORT` | No | `stdio` | Transport mode: `stdio` (default, for `npx`/Claude Desktop/VS Code) or `http` (Streamable HTTP, for Docker/remote clients such as n8n) |
| `MCP_HTTP_PORT` | No | `3003` | Port for the HTTP server (only used when `MCP_TRANSPORT=http`) |
| `MCP_HTTP_HOST` | No | `0.0.0.0` | Bind address for the HTTP server (only used when `MCP_TRANSPORT=http`) |

## Usage

### Run directly from GitHub

```bash
npx github:ferronicardoso/mcp-oci
```

### Claude Desktop configuration

`%APPDATA%\\Claude\\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "oci": {
      "command": "npx",
      "args": ["github:ferronicardoso/mcp-oci"],
      "env": {
        "OCI_AUTH_MODE": "config",
        "OCI_CONFIG_PROFILE": "DEFAULT",
        "OCI_COMPARTMENT_ID": "ocid1.compartment.oc1..xxxx",
        "OCI_READ_ONLY": "true"
      }
    }
  }
}
```

### VS Code MCP configuration

`.vscode/mcp.json`:

```json
{
  "servers": {
    "oci": {
      "command": "npx",
      "args": ["github:ferronicardoso/mcp-oci"],
      "env": {
        "OCI_AUTH_MODE": "config",
        "OCI_CONFIG_PROFILE": "DEFAULT",
        "OCI_COMPARTMENT_ID": "ocid1.compartment.oc1..xxxx",
        "OCI_READ_ONLY": "true"
      }
    }
  }
}
```

### Run with Docker (HTTP transport)

The published image runs in Streamable HTTP mode by default, for use as a remote MCP endpoint (e.g. from n8n's MCP Client Tool node or any Streamable HTTP-compatible client):

```bash
docker run -d --name mcp-oci \
  -p 3003:3003 \
  -e OCI_AUTH_MODE=apikey \
  -e OCI_TENANCY_ID=ocid1.tenancy.oc1..xxxx \
  -e OCI_USER_ID=ocid1.user.oc1..xxxx \
  -e OCI_FINGERPRINT=xx:xx:xx:xx \
  -e OCI_REGION=sa-saopaulo-1 \
  -e OCI_PRIVATE_KEY_PATH=/keys/oci_api_key.pem \
  -e OCI_COMPARTMENT_ID=ocid1.compartment.oc1..xxxx \
  -e OCI_READ_ONLY=true \
  -v /path/to/oci_api_key.pem:/keys/oci_api_key.pem:ro \
  ghcr.io/ferronicardoso/mcp-oci:latest
```

The MCP endpoint is then available at `http://localhost:3003/mcp`.

## Local Development

```bash
git clone https://github.com/ferronicardoso/mcp-oci
cd mcp-oci
npm install
npm run build
```

Start the compiled server:

```bash
npm start
```

## Build and Commit Workflow

This repository intentionally tracks `dist/` to support `npx github:user/repo` usage.

The project uses a Husky `pre-commit` hook to:
1. build TypeScript (`npm run build`)
2. stage generated artifacts (`git add dist`)

Manual fallback:

```bash
npm run build
git add dist
```

## Security Notes

- Never commit real credentials, private keys, or `.env` files.
- `OCI_READ_ONLY=true` is the default; only set it to `false` for environments that must run mutating operations, and prefer pairing it with a least-privilege IAM policy on the OCI side.
- Prefer `instance_principal` authentication when the server runs on OCI Compute/OKE — it avoids storing long-lived credentials entirely.
- For `apikey` mode, prefer mounting the private key file (`OCI_PRIVATE_KEY_PATH`) over passing raw key content via `OCI_PRIVATE_KEY`.
