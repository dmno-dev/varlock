<?php

declare(strict_types=1);

namespace Varlock\Symfony\Logging;

use Monolog\LogRecord;
use Monolog\Processor\ProcessorInterface;
use Varlock\Core\VarlockState;

class RedactSensitiveProcessor implements ProcessorInterface
{
    public function __invoke(LogRecord $record): LogRecord
    {
        $state = VarlockState::getInstance();
        $sensitiveValues = $state->getSensitiveValues();

        if (empty($sensitiveValues)) {
            return $record;
        }

        return $record->with(
            message: $state->redact($record->message),
        );
    }
}
