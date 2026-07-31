mod env;

fn main() {
    let e = env::load().expect("failed to load env"); // call once, reuse
    assert_eq!(e.port, 8080);
    assert!(e.debug);
    // unset optional keys deserialize to None
    assert!(e.optional_unset.is_none());
    assert!(env::SENSITIVE_KEYS.contains(&"SECRET"));
    println!("OK");
}
