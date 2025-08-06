#!/bin/bash

# Script to authenticate with GitHub Container Registry using GitHub CLI
set -e

echo "Authenticating with GitHub Container Registry..."

# Check if GitHub CLI is installed
if ! command -v gh &> /dev/null; then
    echo "Error: GitHub CLI (gh) is not installed."
    echo "Install it from: https://cli.github.com/"
    exit 1
fi

# Check if already authenticated with correct scopes
if gh auth status &> /dev/null; then
    echo "Checking current token scopes..."
    SCOPES=$(gh auth status --json tokenScopes | jq -r '.tokenScopes[]' | tr '\n' ' ')
    if [[ $SCOPES == *"write:packages"* ]]; then
        echo "Already authenticated with correct scopes (write:packages)."
    else
        echo "Current token missing 'write:packages' scope. Re-authenticating..."
        gh auth logout
        gh auth login --scopes write:packages
    fi
else
    echo "Please authenticate with GitHub CLI with package write permissions:"
    gh auth login --scopes write:packages
fi

# Login to GHCR using GitHub CLI
echo "Logging in to ghcr.io..."
gh auth token | docker login ghcr.io -u $(gh api user --jq .login) --password-stdin

echo "Successfully authenticated with GitHub Container Registry!"
echo ""
echo "You can now use:"
echo "  ./scripts/publish-docker.sh"
echo "  docker pull ghcr.io/dmno-dev/varlock:latest" 