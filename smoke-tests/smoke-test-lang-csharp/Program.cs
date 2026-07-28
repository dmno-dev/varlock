var e = Env.Load(); // call once, reuse

if (e.Port != 8080 || e.Debug != true)
{
    Console.Error.WriteLine("unexpected values");
    Environment.Exit(1);
}
// unset optional keys are null
if (e.OptionalUnset is not null)
{
    Console.Error.WriteLine("expected OptionalUnset to be null");
    Environment.Exit(1);
}
if (!Env.SensitiveKeys.Contains("SECRET"))
{
    Console.Error.WriteLine("SECRET not marked sensitive");
    Environment.Exit(1);
}

Console.WriteLine("OK");
