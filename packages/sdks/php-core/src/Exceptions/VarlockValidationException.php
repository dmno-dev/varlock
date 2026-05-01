<?php

declare(strict_types=1);

namespace Varlock\Core\Exceptions;

class VarlockValidationException extends \RuntimeException
{
    /** @var array<string, string> */
    private array $validationErrors;

    public function __construct(array $errors)
    {
        $this->validationErrors = $errors;

        $message = "Varlock validation failed:\n";
        foreach ($errors as $key => $error) {
            $message .= "  - {$error}\n";
        }

        parent::__construct($message);
    }

    /** @return array<string, string> */
    public function getValidationErrors(): array
    {
        return $this->validationErrors;
    }
}
