#!/bin/bash

# Script to publish varlock Docker image to GitHub Container Registry
set -e

# Configuration
REGISTRY="ghcr.io"
OWNER="dmno-dev"
IMAGE_NAME="varlock"
FULL_IMAGE_NAME="${REGISTRY}/${OWNER}/${IMAGE_NAME}"

# Get version from command line or fetch latest
VERSION=${1:-$(curl -s https://api.github.com/repos/dmno-dev/varlock/releases | jq -r '.[0].tag_name' | sed 's/varlock@//')}

echo "Publishing varlock Docker image version: $VERSION"
echo "Image name: ${FULL_IMAGE_NAME}"

# Check if GitHub CLI is installed and authenticated
if ! command -v gh &> /dev/null; then
    echo "Error: GitHub CLI (gh) is not installed."
    echo "Install it from: https://cli.github.com/"
    exit 1
fi

if ! gh auth status &> /dev/null; then
    echo "Error: You must be authenticated with GitHub CLI first."
    echo "Run: gh auth login"
    exit 1
fi

# Check if user has access to the organization
echo "Checking organization access..."
if ! gh api orgs/dmno-dev/members/$(gh api user --jq .login) &> /dev/null; then
    echo "Error: You don't have access to the dmno-dev organization."
    echo "You need to be a member of the organization with package write permissions."
    echo "Contact the organization admin to grant you access."
    exit 1
fi

# Login to GitHub Container Registry using GitHub CLI
echo "Authenticating with GitHub Container Registry..."
gh auth token | docker login ghcr.io -u $(gh api user --jq .login) --password-stdin

# Build the image
echo "Building Docker image..."
docker build --build-arg VARLOCK_VERSION=$VERSION -t ${FULL_IMAGE_NAME}:$VERSION .
docker build --build-arg VARLOCK_VERSION=$VERSION -t ${FULL_IMAGE_NAME}:latest .

# Test the image
echo "Testing the image..."
docker run --rm ${FULL_IMAGE_NAME}:$VERSION --version

# Push to GitHub Container Registry
echo "Pushing to GitHub Container Registry..."
if ! docker push ${FULL_IMAGE_NAME}:$VERSION; then
    echo "Error: Failed to push ${FULL_IMAGE_NAME}:$VERSION"
    echo "This might be due to insufficient permissions in the dmno-dev organization."
    echo "You need 'write:packages' permission in the organization."
    exit 1
fi

if ! docker push ${FULL_IMAGE_NAME}:latest; then
    echo "Error: Failed to push ${FULL_IMAGE_NAME}:latest"
    echo "This might be due to insufficient permissions in the dmno-dev organization."
    echo "You need 'write:packages' permission in the organization."
    exit 1
fi

echo "Successfully published ${FULL_IMAGE_NAME}:$VERSION and ${FULL_IMAGE_NAME}:latest"
echo ""
echo "You can now use:"
echo "  docker pull ${FULL_IMAGE_NAME}:latest"
echo "  docker run --rm -v \$(pwd):/work -w /work -e PWD=/work ${FULL_IMAGE_NAME}:latest load" 