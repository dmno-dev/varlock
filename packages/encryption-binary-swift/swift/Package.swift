// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "VarlockEnclave",
    platforms: [
        .macOS(.v13),
    ],
    targets: [
        .executableTarget(
            name: "VarlockEnclave",
            path: "Sources/VarlockEnclave",
            linkerSettings: [
                .linkedFramework("Security"),
                .linkedFramework("LocalAuthentication"),
                .linkedFramework("AppKit"),
            ]
        ),
    ]
)
