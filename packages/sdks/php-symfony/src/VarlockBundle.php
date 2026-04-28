<?php

declare(strict_types=1);

namespace Varlock\Symfony;

use Symfony\Component\HttpKernel\Bundle\AbstractBundle;
use Symfony\Component\DependencyInjection\ContainerBuilder;
use Symfony\Component\DependencyInjection\Loader\Configurator\ContainerConfigurator;
use Varlock\Symfony\Logging\RedactSensitiveProcessor;

class VarlockBundle extends AbstractBundle
{
    public function loadExtension(array $config, ContainerConfigurator $container, ContainerBuilder $builder): void
    {
        $container->services()
            ->set('varlock.log_processor', RedactSensitiveProcessor::class)
            ->tag('monolog.processor');
    }
}
