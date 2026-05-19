<?php

declare(strict_types=1);

namespace Varlock\Core;

class TypeCoercer
{
    /**
     * Coerce a string env value to the proper PHP type based on manifest schema.
     */
    public static function coerce(string $value, string $type): mixed
    {
        return match ($type) {
            'boolean', 'bool' => self::coerceBool($value),
            'number' => self::coerceNumber($value),
            'integer', 'int' => (int) $value,
            default => $value,
        };
    }

    /**
     * Coerce all values in a map based on their manifest types.
     *
     * @param array<string, string> $values  Resolved string values
     * @param array<string, array>  $items   Manifest items with type info
     * @return array<string, mixed> Coerced values
     */
    public static function coerceAll(array $values, array $items): array
    {
        $result = $values;

        foreach ($items as $key => $schema) {
            if (!isset($result[$key]) || $result[$key] === '') {
                continue;
            }
            $type = $schema['type'] ?? 'string';
            $result[$key] = self::coerce((string) $result[$key], $type);
        }

        return $result;
    }

    private static function coerceBool(string $value): bool
    {
        return in_array(strtolower($value), ['true', '1', 'yes'], true);
    }

    private static function coerceNumber(string $value): int|float
    {
        if (str_contains($value, '.')) {
            return (float) $value;
        }
        return (int) $value;
    }
}
