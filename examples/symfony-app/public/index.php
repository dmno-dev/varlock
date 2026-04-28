<?php

use App\Kernel;

require_once dirname(__DIR__).'/vendor/autoload_runtime.php';

return function (array $context) {
    // Varlock: bootstrap after runtime has loaded .env
    \Varlock\Symfony\VarlockBootstrap::load(dirname(__DIR__));

    return new Kernel($context['APP_ENV'], (bool) $context['APP_DEBUG']);
};
