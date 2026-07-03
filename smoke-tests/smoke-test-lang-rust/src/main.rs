mod env;

fn main() {
    let e = env::load().expect("failed to load env");
    assert_eq!(e.port, 8080);
    assert!(e.debug);
    assert!(env::SENSITIVE_KEYS.contains(&"SECRET"));
    println!("OK");
}
