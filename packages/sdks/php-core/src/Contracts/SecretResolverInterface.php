<?php

declare(strict_types=1);

namespace Varlock\Core\Contracts;

interface SecretResolverInterface
{
    /**
     * Resolve a secret value from an external secret manager.
     *
     * @param array $config The resolve config from the manifest item
     *                      (e.g. ['plugin' => '1password', 'vault' => '...', 'item' => '...'])
     * @return string The resolved secret value
     */
    public function resolve(array $config): string;
}
