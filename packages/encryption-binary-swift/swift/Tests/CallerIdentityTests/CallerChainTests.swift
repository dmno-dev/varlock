import XCTest
import Darwin
import SessionScoping
@testable import CallerIdentity

/// Minimal process tree: pid -> (ppid, path)
private final class FakeProcesses: ProcessProvider {
    private let procs: [pid_t: (ppid: pid_t, path: String)]

    init(_ procs: [pid_t: (ppid: pid_t, path: String)]) {
        self.procs = procs
    }

    func info(for pid: pid_t) -> ProcSnapshot? {
        guard let p = procs[pid] else { return nil }
        return ProcSnapshot(pid: pid, ppid: p.ppid, tty: -1, startTime: 0)
    }

    func path(for pid: pid_t) -> String? { procs[pid]?.path }
    func environment(for pid: pid_t) -> [String: String]? { nil }
    func arguments(for pid: pid_t) -> [String]? { nil }
    func ttyName(forDevice dev: dev_t) -> String? { nil }
    func sessionLeader(for pid: pid_t) -> pid_t { 0 }
}

/// Signing info keyed by pid. Records which lookups went through the audit token.
private final class FakeSigning: CodeSigningInspector {
    private let byPid: [pid_t: CodeSigningInfo]
    private(set) var tokenLookups: [pid_t] = []
    private(set) var pidLookups: [pid_t] = []

    init(_ byPid: [pid_t: CodeSigningInfo]) {
        self.byPid = byPid
    }

    func signingInfo(auditToken: audit_token_t) -> CodeSigningInfo? {
        let pid = pid_t(bitPattern: auditToken.val.5)
        tokenLookups.append(pid)
        return byPid[pid]
    }

    func signingInfo(pid: pid_t) -> CodeSigningInfo? {
        pidLookups.append(pid)
        return byPid[pid]
    }
}

private func token(pid: pid_t) -> audit_token_t {
    var t = audit_token_t()
    t.val.5 = UInt32(bitPattern: pid)
    return t
}

private let varlockCli = CodeSigningInfo(
    kind: .developerId, identifier: "dev.varlock.cli", teamId: "BPHZUT9PGB",
    signerName: "Developer ID Application: DMNO Inc (BPHZUT9PGB)", hardenedRuntime: true
)
private let officialNode = CodeSigningInfo(
    kind: .developerId, identifier: "node", teamId: "HX7739G8FX",
    signerName: "Developer ID Application: Node.js Foundation (HX7739G8FX)", hardenedRuntime: true
)
private let zsh = CodeSigningInfo(
    kind: .applePlatform, identifier: "com.apple.zsh", teamId: nil, signerName: "Software Signing", hardenedRuntime: true
)

final class CallerChainTests: XCTestCase {
    func testPeerIsResolvedByAuditTokenAndAncestorsByPid() {
        let processes = FakeProcesses([
            300: (ppid: 200, path: "/opt/homebrew/bin/varlock"),
            200: (ppid: 100, path: "/bin/zsh"),
            100: (ppid: 1, path: "/Applications/Ghostty.app/Contents/MacOS/ghostty"),
        ])
        let signing = FakeSigning([300: varlockCli, 200: zsh])
        let chain = CallerChainBuilder(processes: processes, signing: signing)
            .chain(peerPid: 300, auditToken: token(pid: 300))

        XCTAssertEqual(chain.map(\.pid), [300, 200, 100])
        XCTAssertEqual(chain.map(\.name), ["varlock", "zsh", "ghostty"])
        XCTAssertEqual(chain.map(\.verifiedByAuditToken), [true, false, false])
        XCTAssertEqual(signing.tokenLookups, [300])
        XCTAssertEqual(signing.pidLookups, [200, 100])
        XCTAssertTrue(chain[0].signing?.isVarlock == true)
        XCTAssertNil(chain[2].signing)
    }

    func testPeerWithoutAuditTokenIsNotMarkedVerified() {
        let processes = FakeProcesses([300: (ppid: 1, path: "/usr/local/bin/node")])
        let signing = FakeSigning([300: officialNode])
        let chain = CallerChainBuilder(processes: processes, signing: signing)
            .chain(peerPid: 300, auditToken: nil)

        XCTAssertEqual(chain.count, 1)
        XCTAssertFalse(chain[0].verifiedByAuditToken)
        XCTAssertNil(chain[0].signing)
        // must not fall back to a pid lookup for the peer
        XCTAssertEqual(signing.pidLookups, [])
    }

    func testStopsAtLaunchdAndOnCycles() {
        let processes = FakeProcesses([
            30: (ppid: 20, path: "/a"),
            20: (ppid: 30, path: "/b"), // cycle back to the peer
        ])
        let chain = CallerChainBuilder(processes: processes, signing: FakeSigning([:]))
            .chain(peerPid: 30, auditToken: token(pid: 30))
        XCTAssertEqual(chain.map(\.pid), [30, 20])
    }

    func testDepthIsCapped() {
        var tree: [pid_t: (ppid: pid_t, path: String)] = [:]
        for pid in pid_t(2)...pid_t(100) { tree[pid] = (ppid: pid - 1, path: "/p\(pid)") }
        let chain = CallerChainBuilder(processes: FakeProcesses(tree), signing: FakeSigning([:]))
            .chain(peerPid: 100, auditToken: token(pid: 100))
        XCTAssertEqual(chain.count, CallerChainBuilder.maxDepth)
    }

    func testIsVarlockRequiresDeveloperIdTeamAndIdentifier() {
        XCTAssertTrue(varlockCli.isVarlock)
        XCTAssertFalse(officialNode.isVarlock)

        // right identifier, ad-hoc: anyone can produce this
        let adHoc = CodeSigningInfo(kind: .adHoc, identifier: "dev.varlock.cli", teamId: nil, signerName: nil, hardenedRuntime: true)
        XCTAssertFalse(adHoc.isVarlock)

        // right identifier, someone else's team
        let otherTeam = CodeSigningInfo(kind: .developerId, identifier: "dev.varlock.cli", teamId: "AAAAAAAAAA", signerName: nil, hardenedRuntime: true)
        XCTAssertFalse(otherTeam.isVarlock)

        // our team, untrusted chain claiming our team id
        let untrusted = CodeSigningInfo(kind: .untrustedCertificate, identifier: "dev.varlock.cli", teamId: "BPHZUT9PGB", signerName: nil, hardenedRuntime: true)
        XCTAssertFalse(untrusted.isVarlock)

        let enclave = CodeSigningInfo(kind: .developerId, identifier: "dev.varlock.enclave", teamId: "BPHZUT9PGB", signerName: nil, hardenedRuntime: true)
        XCTAssertTrue(enclave.isVarlock)
    }

    func testJSONShape() {
        let json = CallerProcess(pid: 42, path: "/opt/homebrew/bin/varlock", signing: varlockCli, verifiedByAuditToken: true).toJSON()
        XCTAssertEqual(json["pid"] as? Int, 42)
        XCTAssertEqual(json["name"] as? String, "varlock")
        XCTAssertEqual(json["verifiedByAuditToken"] as? Bool, true)
        let sig = json["signing"] as? [String: Any]
        XCTAssertEqual(sig?["kind"] as? String, "developer-id")
        XCTAssertEqual(sig?["teamId"] as? String, "BPHZUT9PGB")
        XCTAssertEqual(sig?["isVarlock"] as? Bool, true)
        XCTAssertEqual(sig?["hardenedRuntime"] as? Bool, true)
    }
}
