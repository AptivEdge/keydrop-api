#!/bin/bash

# Initialize the Keydrop Terraform dev backend.

set -e

echo "🚀 Initializing Terraform dev backend..."

# Check if we're in the infra directory
if [ ! -f "dev.tfconfig" ]; then
    echo "❌ Error: dev.tfconfig not found. Please run this script from the infra directory."
    exit 1
fi

# Check if Terraform is installed
if ! command -v terraform &> /dev/null; then
    echo "❌ Error: Terraform is not installed. Please install Terraform first."
    exit 1
fi

# Check if AWS CLI is configured
if ! aws sts get-caller-identity &> /dev/null; then
    echo "❌ Error: AWS CLI is not configured. Please run 'aws configure' first."
    exit 1
fi

# Show current AWS identity
echo "🔑 Current AWS identity:"
aws sts get-caller-identity

# Show dev backend configuration
echo "📋 Dev backend configuration:"
cat dev.tfconfig

# Initialize Terraform with dev backend
echo "🔧 Initializing Terraform..."
terraform init -backend-config=dev.tfconfig

# Verify initialization
echo "✅ Terraform initialization completed!"
echo "🎉 Dev backend initialized successfully!"
echo "💡 Next steps:"
echo "   1. Run: terraform plan -var-file=dev.tfvars"
echo "   2. Review the plan before applying it"
echo "   3. Run: terraform apply <reviewed-plan-file>"
