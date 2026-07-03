mod env;

fn main() {
    // cached; loads once on first access
    assert_eq!(env::ENV.port, 8080);
    assert!(env::ENV.debug);
    assert!(env::SENSITIVE_KEYS.contains(&"SECRET"));
    println!("OK");
}
