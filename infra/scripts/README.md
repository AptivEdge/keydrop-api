# Infrastructure Scripts Guide

This directory contains the optional helper for initializing the Keydrop
Terraform backend. The deployment workflow is documented in
[`../../docs/infrastructure.md`](../../docs/infrastructure.md).

## Terraform backend initialization

### Dev backend initialization (`init-dev-backend.sh`)

Run this from the `infra` directory:

```bash
../scripts/init-dev-backend.sh
```

**What it does:**

- Checks prerequisites (Terraform, AWS CLI)
- Shows current AWS identity
- Initializes Terraform with dev.tfconfig
- Provides next steps for deployment

The helper does not create infrastructure, apply Terraform, or modify AWS
resources. Review a plan and apply it manually using the commands in the
infrastructure guide.
