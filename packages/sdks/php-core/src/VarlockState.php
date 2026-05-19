<?php

declare(strict_types=1);

namespace Varlock\Core;

class VarlockState
{
    private static ?self $instance = null;

    /** @var array<string, mixed> All resolved config values */
    private array $values = [];

    /** @var array<string, bool> Keys that are marked sensitive */
    private array $sensitiveKeys = [];

    /** @var array<string, array> Raw manifest items */
    private array $manifestItems = [];

    private function __construct() {}

    public static function getInstance(): self
    {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    public static function reset(): void
    {
        self::$instance = null;
    }

    public function initialize(array $values, array $sensitiveKeys, array $manifestItems): void
    {
        $this->values = $values;
        $this->sensitiveKeys = $sensitiveKeys;
        $this->manifestItems = $manifestItems;
    }

    public function get(string $key, mixed $default = null): mixed
    {
        return $this->values[$key] ?? $default;
    }

    public function all(): array
    {
        return $this->values;
    }

    public function isSensitive(string $key): bool
    {
        return isset($this->sensitiveKeys[$key]);
    }

    /**
     * Get all sensitive values (for redaction matching).
     *
     * @return string[]
     */
    public function getSensitiveValues(): array
    {
        $sensitiveValues = [];
        foreach ($this->sensitiveKeys as $key => $_) {
            $value = $this->values[$key] ?? null;
            if ($value !== null && $value !== '' && is_string($value)) {
                $sensitiveValues[] = $value;
            }
        }
        return $sensitiveValues;
    }

    public function getManifestItems(): array
    {
        return $this->manifestItems;
    }

    /**
     * Redact sensitive values from a string.
     */
    public function redact(string $input): string
    {
        return RedactionHelper::redact($input, $this->getSensitiveValues());
    }
}
