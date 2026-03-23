<?php

declare(strict_types=1);

namespace Varlock\Core;

use Varlock\Core\Contracts\SecretResolverInterface;
use Varlock\Core\Resolvers\HttpSecretResolver;

class SecretResolverFactory
{
    /** @var array<string, SecretResolverInterface> */
    private static array $resolvers = [];

    /** @var bool Whether built-in resolvers have been registered */
    private static bool $builtInsRegistered = false;

    /**
     * Register a resolver for a given plugin name.
     */
    public static function register(string $pluginName, SecretResolverInterface $resolver): void
    {
        self::$resolvers[$pluginName] = $resolver;
    }

    /**
     * Register built-in resolvers for plugins that have no custom resolver.
     *
     * Scans the manifest items and registers the HttpSecretResolver for any
     * plugin that has an "endpoint" in its resolve config and isn't already
     * registered. This means manifests with HTTP-based resolve configs
     * work out of the box without manual registration.
     */
    public static function registerBuiltIns(array $items): void
    {
        if (self::$builtInsRegistered) {
            return;
        }
        self::$builtInsRegistered = true;

        $httpResolver = null;

        foreach ($items as $schema) {
            $resolve = $schema['resolve'] ?? null;
            if ($resolve === null) {
                continue;
            }

            $plugin = $resolve['plugin'] ?? null;
            if ($plugin === null || self::has($plugin)) {
                continue;
            }

            // If the resolve config has an endpoint, register the HTTP resolver
            if (isset($resolve['endpoint'])) {
                $httpResolver ??= new HttpSecretResolver();
                self::register($plugin, $httpResolver);
            }
        }
    }

    /**
     * Resolve a value using the appropriate plugin resolver.
     *
     * @param array  $resolveConfig The 'resolve' block from a manifest item
     * @param string $key           The manifest item key (passed through to the resolver)
     * @return string The resolved secret value
     * @throws \RuntimeException If no resolver is registered for the plugin
     */
    public static function resolve(array $resolveConfig, string $key = ''): string
    {
        $plugin = $resolveConfig['plugin'] ?? null;

        if ($plugin === null) {
            throw new \RuntimeException('Manifest resolve config missing "plugin" key.');
        }

        $resolver = self::$resolvers[$plugin] ?? null;

        if ($resolver === null) {
            throw new \RuntimeException(
                "No secret resolver registered for plugin '{$plugin}'. "
                . 'Register one via SecretResolverFactory::register() or ensure '
                . 'the resolve config includes an "endpoint" for automatic HTTP resolution.'
            );
        }

        // Inject the manifest key so resolvers can use it (e.g. EnvSecretResolver)
        $resolveConfig['key'] = $key;

        return $resolver->resolve($resolveConfig);
    }

    /**
     * Check if a resolver is registered for the given plugin.
     */
    public static function has(string $pluginName): bool
    {
        return isset(self::$resolvers[$pluginName]);
    }

    /**
     * Clear all registered resolvers (useful for testing).
     */
    public static function reset(): void
    {
        self::$resolvers = [];
        self::$builtInsRegistered = false;
    }
}
