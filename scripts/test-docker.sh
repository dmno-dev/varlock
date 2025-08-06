#!/bin/bash

# Test script for varlock Docker image
set -e

echo "Testing varlock Docker image..."

# Get the latest version from GitHub API for testing
echo "Fetching latest version from GitHub..."
LATEST_VERSION=$(curl -s https://api.github.com/repos/dmno-dev/varlock/releases | jq -r '.[0].tag_name' | sed 's/varlock@//')
echo "Using version: $LATEST_VERSION"

# Build the image locally
echo "Building Docker image..."
docker build --build-arg VARLOCK_VERSION=${1:-$LATEST_VERSION} -t varlock:test .

# Test basic functionality
echo "Testing basic functionality..."
docker run --rm varlock:test --help

# Test with a sample .env.schema file
echo "Testing with sample .env.schema..."
cat > test.env.schema << 'EOF'
# Test environment schema
# @type=string @example=test
TEST_VAR=test_value

# @type=number @example=3000
PORT=3000
EOF

# Test load command
echo "Testing load command..."
docker run --rm -v $(pwd):/work -w /work -e PWD=/work varlock:test load test.env.schema

# Cleanup
rm -f test.env.schema

echo "Docker image test completed successfully!" 