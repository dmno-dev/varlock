<?php

declare(strict_types=1);

namespace Varlock\Core;

class RedactionHelper
{
    public const REDACTED = '[REDACTED]';

    /**
     * Replace all occurrences of sensitive values in a string.
     *
     * @param string   $input           The string to redact
     * @param string[] $sensitiveValues Values to replace
     */
    public static function redact(string $input, array $sensitiveValues): string
    {
        if (empty($sensitiveValues)) {
            return $input;
        }

        // Sort by length descending so longer values are replaced first
        // (prevents partial matches when one secret is a substring of another)
        usort($sensitiveValues, fn(string $a, string $b) => strlen($b) - strlen($a));

        return str_replace($sensitiveValues, self::REDACTED, $input);
    }
}
