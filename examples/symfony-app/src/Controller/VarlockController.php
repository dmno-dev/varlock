<?php

declare(strict_types=1);

namespace App\Controller;

use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Attribute\Route;
use Varlock\Core\VarlockState;

class VarlockController
{
    #[Route('/varlock/status', name: 'varlock_status')]
    public function status(): JsonResponse
    {
        $state = VarlockState::getInstance();
        $items = $state->getManifestItems();
        $values = $state->all();

        $result = [];
        foreach ($items as $key => $schema) {
            $value = $values[$key] ?? null;
            $result[$key] = [
                'type' => $schema['type'] ?? 'string',
                'required' => $schema['required'] ?? false,
                'sensitive' => $schema['sensitive'] ?? false,
                'value' => $state->isSensitive($key) ? '[REDACTED]' : $value,
            ];
        }

        return new JsonResponse($result);
    }

    #[Route('/varlock/log-test', name: 'varlock_log_test')]
    public function logTest(): JsonResponse
    {
        $dbPassword = $_ENV['DB_PASSWORD'] ?? '(not set)';

        // This will be caught by the Monolog processor and redacted
        error_log("Connecting to database with password: {$dbPassword}");

        return new JsonResponse([
            'message' => 'Log entry written. Check var/log/dev.log — the password should be redacted in Monolog output.',
        ]);
    }
}
