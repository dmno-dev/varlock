<?php

declare(strict_types=1);

namespace Varlock\Laravel;

use Illuminate\Support\ServiceProvider;
use Varlock\Core\VarlockState;
use Varlock\Laravel\Console\StatusCommand;
use Varlock\Laravel\Logging\RedactSensitiveProcessor;

class VarlockServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // VarlockBootstrap::load() is called from bootstrap/app.php via
        // afterBootstrapping(LoadEnvironmentVariables::class, ...) so that
        // secrets are available BEFORE config files are parsed.
        // If it wasn't called yet (e.g. testing), do it now as fallback.
        if (VarlockState::getInstance()->getManifestItems() === []) {
            VarlockBootstrap::load($this->app->basePath());
        }

        $this->app->singleton(VarlockState::class, fn() => VarlockState::getInstance());
    }

    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->commands([StatusCommand::class]);
        }

        // Register Monolog processor for log redaction on the default channel's handler
        $logger = $this->app->make('log');
        $monolog = $logger->driver()->getLogger();
        if ($monolog instanceof \Monolog\Logger) {
            $monolog->pushProcessor(new RedactSensitiveProcessor());
        }
    }
}
