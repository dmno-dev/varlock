<?php

use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return view('welcome');
});

Route::get('/varlock/status', function () {
    $state = \Varlock\Core\VarlockState::getInstance();
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

    return response()->json($result);
});

Route::get('/varlock/log-test', function () {
    $dbPassword = env('DB_PASSWORD', '(not set)');
    \Illuminate\Support\Facades\Log::info("Connecting to database with password: {$dbPassword}");

    return response()->json([
        'message' => 'Log entry written. Check storage/logs/laravel.log — the password should be redacted.',
    ]);
});

Route::get('/varlock/validation-test', function () {
    $state = \Varlock\Core\VarlockState::getInstance();
    $items = $state->getManifestItems();

    // Show what would fail if required vars were missing
    $requiredVars = [];
    foreach ($items as $key => $schema) {
        if ($schema['required'] ?? false) {
            $requiredVars[] = $key;
        }
    }

    return response()->json([
        'required_vars' => $requiredVars,
        'all_present' => true,
        'note' => 'If any required var were missing, VarlockBootstrap would throw VarlockValidationException at boot.',
    ]);
});
