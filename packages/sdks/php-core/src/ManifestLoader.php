<?php

declare(strict_types=1);

namespace Varlock\Core;

use Varlock\Core\Exceptions\ManifestNotFoundException;

class ManifestLoader
{
    public static function load(string $basePath): array
    {
        $manifestPath = rtrim($basePath, '/') . '/.varlock/manifest.json';

        if (!file_exists($manifestPath)) {
            throw new ManifestNotFoundException(
                "Varlock manifest not found at: {$manifestPath}. Run `varlock compile` to generate it."
            );
        }

        $contents = file_get_contents($manifestPath);
        $manifest = json_decode($contents, true, 512, JSON_THROW_ON_ERROR);

        if (!isset($manifest['items']) || !is_array($manifest['items'])) {
            throw new \RuntimeException('Invalid varlock manifest: missing "items" key.');
        }

        return $manifest;
    }
}
