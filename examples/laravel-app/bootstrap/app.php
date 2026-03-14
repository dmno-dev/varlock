<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Bootstrap\LoadEnvironmentVariables;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;

$app = Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        //
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        //
    })->create();

// Varlock: run AFTER Dotenv loads .env but BEFORE config files are parsed.
// This ensures secrets resolved from external sources (1Password, Vault, etc.)
// are available when config/app.php calls env('APP_KEY'), etc.
$app->afterBootstrapping(LoadEnvironmentVariables::class, function () use ($app) {
    \Varlock\Laravel\VarlockBootstrap::load($app->basePath());
});

return $app;
