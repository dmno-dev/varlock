var blob = Environment.GetEnvironmentVariable("__VARLOCK_ENV") ?? "";
if (!blob.StartsWith("varlock:v1:", StringComparison.Ordinal))
{
    Console.Error.WriteLine("expected an encrypted __VARLOCK_ENV blob");
    Environment.Exit(1);
}

var e = Env.Load(); // blob is encrypted by varlock run, decrypted here via _VARLOCK_ENV_KEY

if (e.Port != 8080 || e.Secret != "shhh")
{
    Console.Error.WriteLine("unexpected values");
    Environment.Exit(1);
}
if (!Env.SensitiveKeys.Contains("SECRET"))
{
    Console.Error.WriteLine("SECRET not marked sensitive");
    Environment.Exit(1);
}

Console.WriteLine("OK");
