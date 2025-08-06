# Multi-stage build to create a minimal varlock image
FROM alpine:3.19 AS builder

# Install necessary tools for binary extraction
RUN apk add --no-cache curl tar gzip jq

# Download and extract the varlock binary
ARG VARLOCK_VERSION
ARG VARLOCK_ARCH=linux-x64

# Download the appropriate binary based on architecture
RUN if [ "$VARLOCK_VERSION" = "latest" ]; then \
        LATEST_VERSION=$(curl -s https://api.github.com/repos/dmno-dev/varlock/releases | jq -r '.[0].tag_name' | sed 's/varlock@//'); \
        curl -L -o varlock.tar.gz "https://github.com/dmno-dev/varlock/releases/download/varlock@${LATEST_VERSION}/varlock-${VARLOCK_ARCH}.tar.gz"; \
    else \
        curl -L -o varlock.tar.gz "https://github.com/dmno-dev/varlock/releases/download/varlock@${VARLOCK_VERSION}/varlock-${VARLOCK_ARCH}.tar.gz"; \
    fi && \
    tar -xzf varlock.tar.gz && \
    chmod +x varlock && \
    rm varlock.tar.gz

# Final stage - minimal image with just the binary
FROM alpine:3.19

# Install runtime dependencies if needed
RUN apk add --no-cache ca-certificates

# Copy the varlock binary from builder stage
COPY --from=builder /varlock /usr/local/bin/varlock

# Set working directory
WORKDIR /work

# Set the entrypoint
ENTRYPOINT ["/usr/local/bin/varlock"]

# Default command
CMD ["--help"] 