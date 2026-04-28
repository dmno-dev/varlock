<?php

declare(strict_types=1);

namespace Varlock\Core\Resolvers;

use Varlock\Core\Contracts\SecretResolverInterface;

/**
 * Resolves secrets via HTTP API (e.g. 1Password Connect, HashiCorp Vault, custom API).
 *
 * Expected manifest resolve config:
 *   {
 *     "plugin": "1password",
 *     "endpoint": "http://localhost:8080/v1/vaults/{vault_id}/items/{item_id}",
 *     "field": "password",
 *     "headers": { "Authorization": "Bearer {{OP_CONNECT_TOKEN}}" }
 *   }
 *
 * - `endpoint`: the HTTP URL to call (GET request)
 * - `field`: optional JSON path to extract from the response (dot-notation)
 * - `headers`: optional headers; values containing {{ENV_VAR}} are expanded from env
 *
 * Responses are cached per endpoint+headers so multiple secrets from the same
 * API call (e.g. a batch endpoint returning all secrets) only make one request.
 */
class HttpSecretResolver implements SecretResolverInterface
{
    /** @var array<string, string> Response cache keyed by endpoint+headers hash */
    private array $responseCache = [];

    public function resolve(array $config): string
    {
        $endpoint = $config['endpoint'] ?? null;
        if ($endpoint === null) {
            throw new \RuntimeException('HttpSecretResolver: missing "endpoint" in resolve config.');
        }

        $headers = [];
        foreach ($config['headers'] ?? [] as $name => $value) {
            // Expand {{ENV_VAR}} references in header values from real env vars
            $expanded = preg_replace_callback('/\{\{(\w+)\}\}/', function ($matches) {
                $envVal = getenv($matches[1]);
                if ($envVal === false) {
                    throw new \RuntimeException(
                        "HttpSecretResolver: header references env var '{$matches[1]}' which is not set."
                    );
                }
                return $envVal;
            }, $value);
            $headers[] = "{$name}: {$expanded}";
        }

        // Cache key: same endpoint + same headers = same response
        $cacheKey = md5($endpoint . '|' . implode('|', $headers));
        $response = $this->responseCache[$cacheKey] ?? null;

        if ($response === null) {
            $context = stream_context_create([
                'http' => [
                    'method' => 'GET',
                    'header' => implode("\r\n", $headers),
                    'timeout' => 10,
                    'ignore_errors' => true,
                ],
            ]);

            $response = @file_get_contents($endpoint, false, $context);
            if ($response === false) {
                throw new \RuntimeException(
                    "HttpSecretResolver: failed to fetch secret from '{$endpoint}'."
                );
            }

            $this->responseCache[$cacheKey] = $response;
        }

        // If a field is specified, parse JSON and extract it
        $field = $config['field'] ?? null;
        if ($field !== null) {
            $data = json_decode($response, true);
            if (!is_array($data)) {
                throw new \RuntimeException(
                    "HttpSecretResolver: response from '{$endpoint}' is not valid JSON."
                );
            }
            return $this->extractField($data, $field, $endpoint);
        }

        return trim($response);
    }

    /**
     * Extract a value using dot-notation path (e.g. "fields.password.value").
     */
    private function extractField(array $data, string $path, string $endpoint): string
    {
        $segments = explode('.', $path);
        $current = $data;

        foreach ($segments as $segment) {
            if (!is_array($current) || !array_key_exists($segment, $current)) {
                throw new \RuntimeException(
                    "HttpSecretResolver: field '{$path}' not found in response from '{$endpoint}'."
                );
            }
            $current = $current[$segment];
        }

        if (!is_scalar($current)) {
            throw new \RuntimeException(
                "HttpSecretResolver: field '{$path}' resolved to a non-scalar value."
            );
        }

        return (string) $current;
    }
}
