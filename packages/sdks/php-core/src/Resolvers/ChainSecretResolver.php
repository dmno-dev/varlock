<?php

declare(strict_types=1);

namespace Varlock\Core\Resolvers;

use Varlock\Core\Contracts\SecretResolverInterface;

/**
 * Tries multiple resolution strategies in order.
 *
 * Useful for fallback chains: try 1Password Connect first,
 * fall back to a process env var injected by the orchestrator.
 *
 *   SecretResolverFactory::register('1password', new ChainSecretResolver([
 *       new HttpSecretResolver(),           // try Connect API
 *       new EnvSecretResolver('OP_SECRET'), // fall back to orchestrator env
 *   ]));
 */
class ChainSecretResolver implements SecretResolverInterface
{
    /** @var SecretResolverInterface[] */
    private array $resolvers;

    public function __construct(array $resolvers)
    {
        $this->resolvers = $resolvers;
    }

    public function resolve(array $config): string
    {
        $lastException = null;

        foreach ($this->resolvers as $resolver) {
            try {
                return $resolver->resolve($config);
            } catch (\Throwable $e) {
                $lastException = $e;
            }
        }

        throw new \RuntimeException(
            'ChainSecretResolver: all resolvers failed. Last error: ' . $lastException?->getMessage(),
            0,
            $lastException,
        );
    }
}
