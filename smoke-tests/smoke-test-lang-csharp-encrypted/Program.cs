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
