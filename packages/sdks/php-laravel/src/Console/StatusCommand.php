<?php

declare(strict_types=1);

namespace Varlock\Laravel\Console;

use Illuminate\Console\Command;
use Varlock\Core\VarlockState;

class StatusCommand extends Command
{
    protected $signature = 'varlock:status';

    protected $description = 'Show loaded Varlock env vars with sensitive values redacted';

    public function handle(): int
    {
        $state = VarlockState::getInstance();
        $items = $state->getManifestItems();
        $values = $state->all();

        if (empty($items)) {
            $this->warn('No Varlock manifest loaded. Is VarlockBootstrap::load() called in bootstrap/app.php?');
            return 1;
        }

        $rows = [];
        foreach ($items as $key => $schema) {
            $value = $values[$key] ?? '<not set>';
            $display = $state->isSensitive($key) && $value !== '<not set>'
                ? '[REDACTED]'
                : (string) $value;

            $rows[] = [
                $key,
                $schema['type'] ?? 'string',
                ($schema['required'] ?? false) ? 'Yes' : 'No',
                ($schema['sensitive'] ?? false) ? 'Yes' : 'No',
                $display,
            ];
        }

        $this->table(['Key', 'Type', 'Required', 'Sensitive', 'Value'], $rows);

        return 0;
    }
}
