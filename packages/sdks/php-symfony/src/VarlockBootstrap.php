<?php

declare(strict_types=1);

namespace Varlock\Symfony;

use Varlock\Core\ManifestLoader;
use Varlock\Core\SecretResolverFactory;
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
     * Symfony stores all values as strings — env processors handle casting.
     */
    public static function load(string $basePath): void
    {
        $manifest = ManifestLoader::load($basePath);
        $items = $manifest['items'];

        // Auto-register built-in resolvers for plugins found in manifest
        SecretResolverFactory::registerBuiltIns($items);

        $values = [];
        $sensitiveKeys = [];

        foreach ($items as $key => $schema) {
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

        // Validate (string values only — Symfony processors handle casting)
        Validator::validateOrThrow($values, $items);

        // Populate env (strings only for Symfony compatibility)
        foreach ($values as $key => $value) {
            self::setEnv($key, (string) $value);
        }

        // Initialize state singleton (stores strings — Symfony handles types)
        VarlockState::getInstance()->initialize($values, $sensitiveKeys, $items);
    }

    private static function getExistingEnv(string $key): ?string
    {
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
