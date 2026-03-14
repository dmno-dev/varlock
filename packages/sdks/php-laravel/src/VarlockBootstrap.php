<?php

declare(strict_types=1);

namespace Varlock\Laravel;

use Varlock\Core\ManifestLoader;
use Varlock\Core\SecretResolverFactory;
use Varlock\Core\TypeCoercer;
use Varlock\Core\Validator;
use Varlock\Core\VarlockState;

class VarlockBootstrap
{
    /**
     * Load varlock manifest, resolve secrets, validate, and populate env.
     *
     * Resolution priority per item:
     *   1. Existing env var (from .env or process environment)
     *   2. Secret resolver (1Password, Vault, HTTP API, etc.)
     *   3. Manifest default value
     *
     * This means .env files can contain ZERO secrets. Sensitive values
     * are resolved at runtime from external sources and never touch
     * the filesystem — making the codebase safe for AI agents.
     */
    public static function load(string $basePath): void
    {
        $manifest = ManifestLoader::load($basePath);
        $items = $manifest['items'];

        // Detect if Laravel config is cached — skip validation and secret resolution,
        // because cached config doesn't read env vars at runtime.
        $configCached = file_exists(rtrim($basePath, '/') . '/bootstrap/cache/config.php');

        if ($configCached) {
            // Still initialize state with manifest metadata for redaction/status,
            // but don't validate or resolve since env vars aren't used when cached.
            $sensitiveKeys = [];
            foreach ($items as $key => $schema) {
                if (!empty($schema['sensitive'])) {
                    $sensitiveKeys[$key] = true;
                }
            }
            VarlockState::getInstance()->initialize([], $sensitiveKeys, $items);
            return;
        }

        // Auto-register built-in resolvers (e.g. HTTP) for plugins found in manifest
        SecretResolverFactory::registerBuiltIns($items);

        $values = [];
        $sensitiveKeys = [];

        foreach ($items as $key => $schema) {
            // Priority: existing env > secret manager > manifest default
            $value = self::getExistingEnv($key);

            if ($value === null && isset($schema['resolve'])) {
                $value = SecretResolverFactory::resolve($schema['resolve'], $key);
            }

            if ($value === null && array_key_exists('default', $schema)) {
                $value = (string) $schema['default'];
            }

            if ($value !== null) {
                $values[$key] = $value;
            }

            if (!empty($schema['sensitive'])) {
                $sensitiveKeys[$key] = true;
            }
        }

        // Validate before coercion (validation works on string values)
        Validator::validateOrThrow($values, $items);

        // Coerce types for PHP-native access
        $coerced = TypeCoercer::coerceAll($values, $items);

        // Populate env so Laravel's env() helper and Dotenv see these values.
        // We write the string versions to env (env vars are always strings),
        // and store coerced versions in VarlockState.
        foreach ($values as $key => $value) {
            self::setEnv($key, (string) $value);
        }

        // Initialize state singleton
        VarlockState::getInstance()->initialize($coerced, $sensitiveKeys, $items);
    }

    private static function getExistingEnv(string $key): ?string
    {
        // Check in order: $_ENV, $_SERVER, getenv()
        if (isset($_ENV[$key]) && $_ENV[$key] !== '') {
            return $_ENV[$key];
        }
        if (isset($_SERVER[$key]) && $_SERVER[$key] !== '' && !is_array($_SERVER[$key])) {
            return (string) $_SERVER[$key];
        }
        $val = getenv($key);
        return ($val !== false && $val !== '') ? $val : null;
    }

    private static function setEnv(string $key, string $value): void
    {
        $_ENV[$key] = $value;
        $_SERVER[$key] = $value;
        putenv("{$key}={$value}");
    }
}
