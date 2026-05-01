<?php

/**
 * Mock secret manager API for Varlock PoC demo.
 *
 * Simulates what 1Password Connect, HashiCorp Vault, or any
 * secrets HTTP API would return. In production, this would be
 * a real secret manager — the point is that secrets live here
 * (in memory, behind an API) and NEVER in .env files.
 *
 * Usage:
 *   php examples/mock-secret-server.php &
 *   # Server runs on http://localhost:9777
 *
 * The manifest points sensitive items at this endpoint.
 * The PHP SDK's HttpSecretResolver calls it at boot time.
 */

$secrets = [
    'APP_KEY' => 'base64:9McFRwiu6WCB21XjXdjz2b3njJCsnsVS6Qmz9FbdDGk=',
    'APP_SECRET' => 'whsec_a1b2c3d4e5f6g7h8i9j0',
    'DB_PASSWORD' => 'prod-db-P@ssw0rd!-2026-rotated',
];

$host = '127.0.0.1';
$port = 9777;

echo "Varlock mock secret server running on http://{$host}:{$port}\n";
echo "Serving " . count($secrets) . " secrets (APP_KEY, APP_SECRET, DB_PASSWORD)\n";
echo "Press Ctrl+C to stop.\n\n";

$server = stream_socket_server("tcp://{$host}:{$port}", $errno, $errstr);
if (!$server) {
    fwrite(STDERR, "Failed to start server: {$errstr} ({$errno})\n");
    exit(1);
}

while ($conn = stream_socket_accept($server, -1)) {
    $request = fread($conn, 4096);

    // Parse the request path
    preg_match('/GET\s+(\S+)/', $request, $matches);
    $path = $matches[1] ?? '/';

    $timestamp = date('H:i:s');

    if ($path === '/secrets') {
        $body = json_encode($secrets);
        $response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " . strlen($body) . "\r\n\r\n{$body}";
        echo "[{$timestamp}] 200 GET /secrets — returned all secrets\n";
    } elseif (preg_match('#^/secrets/(\w+)$#', $path, $m) && isset($secrets[$m[1]])) {
        $body = $secrets[$m[1]];
        $response = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: " . strlen($body) . "\r\n\r\n{$body}";
        echo "[{$timestamp}] 200 GET /secrets/{$m[1]}\n";
    } else {
        $body = '{"error": "not found"}';
        $response = "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: " . strlen($body) . "\r\n\r\n{$body}";
        echo "[{$timestamp}] 404 GET {$path}\n";
    }

    fwrite($conn, $response);
    fclose($conn);
}
