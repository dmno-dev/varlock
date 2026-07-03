<?php

require __DIR__ . '/Env.php';

$e = Env::load();

if ($e->PORT !== 8080 || $e->DEBUG !== true) {
    fwrite(STDERR, "unexpected values\n");
    exit(1);
}
if (!in_array('SECRET', Env::SENSITIVE_KEYS, true)) {
    fwrite(STDERR, "SECRET not marked sensitive\n");
    exit(1);
}

echo "OK\n";
