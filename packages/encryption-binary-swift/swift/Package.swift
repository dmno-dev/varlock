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
        .executableTarget(
            name: "VarlockEnclave",
            dependencies: ["KeychainLegacy"],
            path: "Sources/VarlockEnclave",
            linkerSettings: [
                .linkedFramework("Security"),
                .linkedFramework("LocalAuthentication"),
                .linkedFramework("AppKit"),
            ]
        ),
    ]
)
