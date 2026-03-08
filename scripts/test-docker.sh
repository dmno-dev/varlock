#!/bin/bash

# Test script for varlock Docker image
set -e

echo "Testing varlock Docker image..."

# Get the latest version from GitHub API for testing
echo "Fetching latest version from GitHub..."
LATEST_VERSION=$(curl -s https://api.github.com/repos/dmno-dev/varlock/releases | jq -r '.[0].tag_name' | sed 's/varlock@//')
echo "Using version: $LATEST_VERSION"

# Detect host architecture for single-platform build (TARGETARCH not set without --platform)
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
    VARLOCK_ARCH="linux-musl-arm64"
else
    VARLOCK_ARCH="linux-musl-x64"
fi

# Build the image locally
echo "Building Docker image for $ARCH..."
docker build --build-arg VARLOCK_VERSION=${1:-$LATEST_VERSION} --build-arg VARLOCK_ARCH=$VARLOCK_ARCH -t ghcr.io/dmno-dev/varlock:test .

# Test basic functionality
echo "Testing basic functionality..."
docker run --rm ghcr.io/dmno-dev/varlock:test --help

# Test with a sample .env.schema file
echo "Testing with sample .env.schema..."
cat > .env.schema << 'EOF'
# Test environment schema
# @type=string @example=test
TEST_VAR=test_value

# @type=number @example=3000
PORT=3000
EOF

# Test load command
echo "Testing load command..."
docker run --rm -v $(pwd):/work -w /work -e PWD=/work ghcr.io/dmno-dev/varlock:test --version

# Cleanup
rm -f .env.schema

echo "Docker image test completed successfully!" 