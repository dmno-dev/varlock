<?php

declare(strict_types=1);

namespace Varlock\Core\Resolvers;

use Varlock\Core\Contracts\SecretResolverInterface;

/**
 * Resolves secrets using a user-provided callback.
 *
 * Useful for custom resolution logic, testing, or bridging to any SDK:
 *
 *   SecretResolverFactory::register('1password', new CallbackSecretResolver(
 *       fn(array $config) => MyVault::get($config['item'], $config['field'])
 *   ));
 */
class CallbackSecretResolver implements SecretResolverInterface
{
    /** @var \Closure(array): string */
    private \Closure $callback;

    public function __construct(\Closure $callback)
    {
        $this->callback = $callback;
    }

    public function resolve(array $config): string
    {
        return ($this->callback)($config);
    }
}
