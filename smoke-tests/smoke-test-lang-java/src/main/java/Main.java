public class Main {
  public static void main(String[] args) {
    Env e = Env.load(); // call once, reuse

    if (e.port != 8080L || e.debug != true) {
      System.err.println("unexpected values");
      System.exit(1);
    }
    // unset optional keys are null
    if (e.optionalUnset != null) {
      System.err.println("expected optionalUnset to be null");
      System.exit(1);
    }
    if (!Env.SENSITIVE_KEYS.contains("SECRET")) {
      System.err.println("SECRET not marked sensitive");
      System.exit(1);
    }

    System.out.println("OK");
  }
}
