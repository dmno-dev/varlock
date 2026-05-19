<?php

declare(strict_types=1);

namespace Varlock\Core\Resolvers;

use Varlock\Core\Contracts\SecretResolverInterface;

/**
 * Resolves secrets from process environment variables — NOT from .env files.
 *
 * This is for container/CI environments where secrets are injected by the
 * orchestrator (Docker secrets, K8s secrets, CI env vars) into the process
 * environment. These never touch the filesystem.
 *
 * The resolve config can specify a custom env var name via the "envVar" key.
 * If not set, it uses a prefixed version of the manifest key:
 *
 *   VARLOCK_SECRET_DB_PASSWORD (prefix "VARLOCK_SECRET_" + key)
 *
 * This separation means:
 * - .env files contain ZERO secrets (safe for AI agents to read)
 * - Secrets exist only in process memory, injected by the host environment
 */
class EnvSecretResolver implements SecretResolverInterface
{
    private string $prefix;

    public function __construct(string $prefix = 'VARLOCK_SECRET_')
    {
        $this->prefix = $prefix;
    }

    public function resolve(array $config): string
    {
        // Allow explicit env var name override
        $envVar = $config['envVar'] ?? null;

        if ($envVar === null) {
            // Derive from the manifest key: DB_PASSWORD -> VARLOCK_SECRET_DB_PASSWORD
            $key = $config['key'] ?? null;
            if ($key === null) {
                throw new \RuntimeException(
                    'EnvSecretResolver: resolve config missing both "envVar" and "key".'
                );
            }
            $envVar = $this->prefix . $key;
        }

        // Read from real process env only (getenv), NOT from $_ENV/$_SERVER
        // which may be populated from .env files
        $value = getenv($envVar);

        if ($value === false || $value === '') {
            throw new \RuntimeException(
                "EnvSecretResolver: process env var '{$envVar}' is not set. "
                . 'Ensure it is injected by your orchestrator (Docker/K8s/CI).'
            );
        }

        return $value;
    }
}
