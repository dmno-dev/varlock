import Foundation
import Darwin
import SessionScoping

/// How a process's code is signed, from most to least trustworthy.
public enum SignatureKind: String {
    /// Apple platform binary (shells, system tools)
    case applePlatform = "apple-platform"
    /// Developer ID Application certificate, the normal signature for software
    /// distributed outside the App Store (official Node.js builds, our CLI, ...)
    case developerId = "developer-id"
    /// Some other Apple-issued certificate (App Store, Apple Development)
    case appleIssued = "apple-issued"
    /// Signed with a certificate that does not chain to Apple (e.g. self-signed)
    case untrustedCertificate = "untrusted-certificate"
    /// Ad-hoc signature: no certificate, so no signer identity at all. Typical of
    /// Homebrew builds and locally compiled binaries.
    case adHoc = "ad-hoc"
    /// No code signature
    case unsigned
    /// A signature is present but the OS reports it invalid
    case invalid
}

/// Code-signing facts about one running process.
public struct CodeSigningInfo: Equatable {
    public let kind: SignatureKind
    /// Signing identifier (e.g. `dev.varlock.cli`). Set for any signed code.
    public let identifier: String?
    /// Team identifier from the leaf certificate. nil for ad-hoc/platform code.
    public let teamId: String?
    /// Leaf certificate summary, e.g. "Developer ID Application: DMNO Inc (BPHZUT9PGB)"
    public let signerName: String?
    public let hardenedRuntime: Bool

    public init(kind: SignatureKind, identifier: String?, teamId: String?, signerName: String?, hardenedRuntime: Bool) {
        self.kind = kind
        self.identifier = identifier
        self.teamId = teamId
        self.signerName = signerName
        self.hardenedRuntime = hardenedRuntime
    }

    /// True when this is a Developer ID signed varlock binary from our team.
    /// Identifier + team is only meaningful because the requirement check that
    /// produced `kind == .developerId` already anchored the chain at Apple.
    public var isVarlock: Bool {
        guard kind == .developerId, teamId == VarlockCodeIdentity.teamId, let identifier else { return false }
        return VarlockCodeIdentity.identifiers.contains(identifier)
    }
}

/// Our own signing identity. The identifiers are permanent: the CLI's comes from
/// packages/varlock/scripts/build-binaries.ts, the enclave's from build-swift.ts.
public enum VarlockCodeIdentity {
    public static let teamId = "BPHZUT9PGB"
    public static let cliIdentifier = "dev.varlock.cli"
    public static let enclaveIdentifier = "dev.varlock.enclave"
    public static let identifiers: Set<String> = [cliIdentifier, enclaveIdentifier]
}

/// Looks up code-signing facts for running processes. The live implementation
/// uses the Security framework; tests substitute a fake.
public protocol CodeSigningInspector {
    /// Signing info for the process behind an audit token. Bound to that exact
    /// process instance, so it cannot be confused by pid reuse.
    func signingInfo(auditToken: audit_token_t) -> CodeSigningInfo?
    /// Signing info by pid. Subject to pid reuse, so only for display.
    func signingInfo(pid: pid_t) -> CodeSigningInfo?
}

/// One process in a caller chain.
public struct CallerProcess {
    public let pid: pid_t
    public let path: String?
    public let signing: CodeSigningInfo?
    /// True only for the direct IPC peer, whose identity is resolved from the
    /// socket's audit token. Ancestors are looked up by pid and can in principle
    /// be a different process that reused the pid, so they are display-only.
    public let verifiedByAuditToken: Bool

    public var name: String? {
        guard let path else { return nil }
        return (path as NSString).lastPathComponent
    }

    public func toJSON() -> [String: Any] {
        var out: [String: Any] = [
            "pid": Int(pid),
            "verifiedByAuditToken": verifiedByAuditToken,
        ]
        if let path { out["path"] = path }
        if let name { out["name"] = name }
        if let signing {
            var sig: [String: Any] = [
                "kind": signing.kind.rawValue,
                "hardenedRuntime": signing.hardenedRuntime,
                "isVarlock": signing.isVarlock,
            ]
            if let v = signing.identifier { sig["identifier"] = v }
            if let v = signing.teamId { sig["teamId"] = v }
            if let v = signing.signerName { sig["signerName"] = v }
            out["signing"] = sig
        }
        return out
    }
}

/// Describes who is calling the daemon: the direct peer plus its ancestors.
///
/// This is informational. Access decisions stay with the binary-name allowlist
/// in PeerIdentity.swift, so npm installs (where the peer is `node` or `bun`,
/// signed by whoever built that runtime) keep working.
public struct CallerChainBuilder {
    /// Walking stops here even if the tree is deeper
    public static let maxDepth = 16

    private let processes: ProcessProvider
    private let signing: CodeSigningInspector

    public init(processes: ProcessProvider, signing: CodeSigningInspector) {
        self.processes = processes
        self.signing = signing
    }

    /// Build the chain starting at the direct peer. `peerPid` must be the pid
    /// carried by `auditToken`.
    public func chain(peerPid: pid_t, auditToken: audit_token_t?) -> [CallerProcess] {
        var result: [CallerProcess] = []
        let peerSigning = auditToken.flatMap { signing.signingInfo(auditToken: $0) }
        result.append(CallerProcess(
            pid: peerPid,
            path: processes.path(for: peerPid),
            signing: peerSigning,
            verifiedByAuditToken: peerSigning != nil
        ))

        var seen: Set<pid_t> = [peerPid]
        var current = peerPid
        while result.count < Self.maxDepth {
            // stop below launchd (pid 1) and the kernel (pid 0)
            guard let ppid = processes.info(for: current)?.ppid, ppid > 1, !seen.contains(ppid) else { break }
            seen.insert(ppid)
            result.append(CallerProcess(
                pid: ppid,
                path: processes.path(for: ppid),
                signing: signing.signingInfo(pid: ppid),
                verifiedByAuditToken: false
            ))
            current = ppid
        }
        return result
    }
}
