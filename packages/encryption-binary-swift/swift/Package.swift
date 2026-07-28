// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "VarlockEnclave",
    platforms: [
        .macOS(.v13),
    ],
    targets: [
        // Legacy SecKeychain ACL wrappers — deprecated APIs with no replacement.
        // Isolated in a separate target so we can suppress deprecation warnings
        // without affecting the rest of the codebase.
        .target(
            name: "KeychainLegacy",
            path: "Sources/KeychainLegacy",
            swiftSettings: [
                .unsafeFlags(["-suppress-warnings"]),
            ],
            linkerSettings: [
                .linkedFramework("Security"),
            ]
        ),
        // Pure session-scoping logic (TTY / process-tree identity), isolated in
        // its own library target so it can be unit tested with synthetic process
        // trees. All OS access goes through the `ProcessProvider` abstraction.
        .target(
            name: "SessionScoping",
            path: "Sources/SessionScoping"
        ),
        .executableTarget(
            name: "VarlockEnclave",
            dependencies: ["KeychainLegacy", "SessionScoping"],
            path: "Sources/VarlockEnclave",
            linkerSettings: [
                .linkedFramework("Security"),
                .linkedFramework("LocalAuthentication"),
                .linkedFramework("AppKit"),
            ]
        ),
        .testTarget(
            name: "SessionScopingTests",
            dependencies: ["SessionScoping"],
            path: "Tests/SessionScopingTests"
        ),
    ]
)
