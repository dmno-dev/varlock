<?php

declare(strict_types=1);

namespace Varlock\Core;

use Varlock\Core\Exceptions\VarlockValidationException;

class Validator
{
    /**
     * Validate resolved values against manifest schema rules.
     *
     * @param array<string, mixed> $values  Resolved env values (key => value)
     * @param array<string, array> $items   Manifest items (key => schema)
     * @return array<string, string> Errors keyed by env var name
     */
    public static function validate(array $values, array $items): array
    {
        $errors = [];

        foreach ($items as $key => $schema) {
            $value = $values[$key] ?? null;
            $required = $schema['required'] ?? false;

            if ($required && ($value === null || $value === '')) {
                $errors[$key] = "Required env var '{$key}' is missing or empty.";
                continue;
            }

            if ($value === null || $value === '') {
                continue;
            }

            $type = $schema['type'] ?? null;
            if ($type !== null) {
                $typeError = self::validateType($key, (string) $value, $type);
                if ($typeError !== null) {
                    $errors[$key] = $typeError;
                }
            }
        }

        return $errors;
    }

    /**
     * Validate and throw if errors exist.
     */
    public static function validateOrThrow(array $values, array $items): void
    {
        $errors = self::validate($values, $items);
        if (!empty($errors)) {
            throw new VarlockValidationException($errors);
        }
    }

    private static function validateType(string $key, string $value, string $type): ?string
    {
        return match ($type) {
            'string' => null,
            'number', 'integer', 'int' => is_numeric($value) ? null : "Env var '{$key}' must be numeric, got '{$value}'.",
            'boolean', 'bool' => in_array(strtolower($value), ['true', 'false', '1', '0', 'yes', 'no', ''], true)
                ? null
                : "Env var '{$key}' must be a boolean, got '{$value}'.",
            'email' => filter_var($value, FILTER_VALIDATE_EMAIL) !== false
                ? null
                : "Env var '{$key}' must be a valid email, got '{$value}'.",
            'url' => filter_var($value, FILTER_VALIDATE_URL) !== false
                ? null
                : "Env var '{$key}' must be a valid URL, got '{$value}'.",
            default => null, // Unknown types pass validation
        };
    }
}
