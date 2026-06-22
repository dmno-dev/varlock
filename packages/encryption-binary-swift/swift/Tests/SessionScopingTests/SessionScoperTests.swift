import XCTest
@testable import SessionScoping

/// Tests for the daemon's biometric session-scoping identity.
///
/// These encode the security invariants behind "why does varlock only prompt
/// once per logical session": the identity must collapse incidental process
/// fragmentation (fan-out PTYs) while keeping genuinely separate contexts
/// distinct (different tmux panes, different subtrees), and an LLM-session env
/// var must NEVER be trusted on its own to reproduce an anchored session.
final class SessionScoperTests: XCTestCase {

    private func scoper(_ procs: [FakeProc], ttyNames: [dev_t: String] = [:]) -> SessionScoper {
        return SessionScoper(provider: FakeProcessProvider(procs, ttyNames: ttyNames))
    }

    /// A no-TTY agent tree mirroring Claude Code:
    ///   Claude.app(100) → claude(200) → zsh(300) → bun peer(400)
    /// Scope resolves to the `claude` binary (200), skipping the ephemeral zsh.
    private func agentTree(peerEnv: [String: String]) -> [FakeProc] {
        return [
            FakeProc(pid: 100, ppid: 1, startTime: 1000, path: "/Applications/Claude.app/Contents/MacOS/Claude"),
            FakeProc(pid: 200, ppid: 100, startTime: 2000, path: "/usr/local/bin/claude"),
            FakeProc(pid: 300, ppid: 200, startTime: 3000, path: "/bin/zsh"),
            FakeProc(pid: 400, ppid: 300, startTime: 4000, path: "/usr/local/bin/bun", env: peerEnv),
        ]
    }

    // MARK: - No-TTY (GUI / agent) cases

    func testAgentSessionCombinesEnvWithProcessTreeAnchor() {
        let s = scoper(agentTree(peerEnv: ["CLAUDE_CODE_SESSION_ID": "VICTIM"]))
        XCTAssertEqual(
            s.sessionIdentifier(forPid: 400),
            "env:CLAUDE_CODE_SESSION_ID:VICTIM|ptree:200:2000"
        )
    }

    func testForgedDifferentEnvValueChangesIdentityButKeepsSameAnchor() {
        let victim = scoper(agentTree(peerEnv: ["CLAUDE_CODE_SESSION_ID": "VICTIM"]))
            .sessionIdentifier(forPid: 400)
        let forged = scoper(agentTree(peerEnv: ["CLAUDE_CODE_SESSION_ID": "ATTACKER"]))
            .sessionIdentifier(forPid: 400)

        XCTAssertNotEqual(forged, victim)
        // The env value is embedded literally — it narrows, it cannot merge.
        XCTAssertEqual(forged, "env:CLAUDE_CODE_SESSION_ID:ATTACKER|ptree:200:2000")
        // Both still share the SAME process-tree anchor.
        XCTAssertTrue(victim!.hasSuffix("|ptree:200:2000"))
        XCTAssertTrue(forged!.hasSuffix("|ptree:200:2000"))
    }

    func testProcessTreeAnchorIsComputedIndependentlyOfEnv() {
        // With no env var at all, the tree anchor must still be produced.
        let s = scoper(agentTree(peerEnv: [:]))
        XCTAssertEqual(s.sessionIdentifier(forPid: 400), "ptree:200:2000")
    }

    /// THE security case: forging the *real* victim env value from OUTSIDE the
    /// agent's subtree (peer reparented to launchd, no walkable ancestry) yields
    /// a bare `env:…` key with no anchor — a different bucket from the anchored
    /// victim, so it cannot piggyback on the warm session.
    func testForgedEnvFromOutsideSubtreeCannotReproduceAnchoredIdentity() {
        let sessionId = "bdd31854-ffcd-48ba-b861-c78a893b1dd5" // realistic unique session id
        let victim = scoper(agentTree(peerEnv: ["CLAUDE_CODE_SESSION_ID": sessionId]))
            .sessionIdentifier(forPid: 400)

        // Attacker: direct child of launchd (ppid 1), no tty, forging the value.
        let attackerTree = [
            FakeProc(pid: 400, ppid: 1, startTime: 9000, path: "/usr/local/bin/bun",
                     env: ["CLAUDE_CODE_SESSION_ID": sessionId]),
        ]
        let attacker = scoper(attackerTree).sessionIdentifier(forPid: 400)

        XCTAssertEqual(attacker, "env:CLAUDE_CODE_SESSION_ID:\(sessionId)") // bare, no anchor
        XCTAssertNotEqual(attacker, victim)
        XCTAssertTrue(victim!.contains("|ptree:"))
        XCTAssertFalse(attacker!.contains("|ptree:"))
    }

    func testAnchorlessShortEnvValueFailsClosed() {
        // A coarse / short env value with NO tty or process-tree anchor must NOT
        // scope a session on its own — defense-in-depth against a non-unique key.
        let s = scoper([
            FakeProc(pid: 400, ppid: 1, startTime: 9000, path: "/usr/local/bin/bun",
                     env: ["CLAUDE_CODE_SESSION_ID": "prod"]),
        ])
        XCTAssertNil(s.sessionIdentifier(forPid: 400))
    }

    func testShortEnvValueStillUsedWhenAnchored() {
        // With a real anchor present the length floor does NOT apply — the anchor
        // already provides uniqueness, so even a short value scopes fine.
        let s = scoper(agentTree(peerEnv: ["CLAUDE_CODE_SESSION_ID": "prod"]))
        XCTAssertEqual(s.sessionIdentifier(forPid: 400), "env:CLAUDE_CODE_SESSION_ID:prod|ptree:200:2000")
    }

    func testArgMentioningVarlockPathSubstringIsNotTreatedAsLauncher() {
        // A long-lived node whose argv merely CONTAINS a varlock-ish path as a
        // substring (a sibling `.../.bin/varlock-foo` passed to a flag) must not
        // be misclassified as an ephemeral varlock launcher and skipped.
        let s = scoper([
            FakeProc(pid: 100, ppid: 1, startTime: 1000, path: "/Applications/Foo.app/Contents/MacOS/Foo"),
            FakeProc(pid: 200, ppid: 100, startTime: 2000, path: "/opt/foo/foo-tool"),
            FakeProc(pid: 300, ppid: 200, startTime: 3000, path: "/usr/bin/node",
                     args: ["node", "/proj/server.js", "--ignore", "/proj/node_modules/.bin/varlock-foo"]),
            FakeProc(pid: 400, ppid: 300, startTime: 4000, path: "/usr/local/bin/bun"),
        ])
        // node stays the scope (it's a long-lived server, not a launcher).
        XCTAssertEqual(s.sessionIdentifier(forPid: 400), "ptree:300:3000")
    }

    func testUnknownPidYieldsNil() {
        let s = scoper(agentTree(peerEnv: [:]))
        XCTAssertNil(s.sessionIdentifier(forPid: 999))
    }

    func testNoTtyNoEnvNoAncestryYieldsNil() {
        let s = scoper([FakeProc(pid: 400, ppid: 1, startTime: 4000, path: "/usr/local/bin/bun")])
        XCTAssertNil(s.sessionIdentifier(forPid: 400))
    }

    func testShallowTreeScopesToAppRoot() {
        // codex-style: app root execs a shell directly as its child.
        let s = scoper([
            FakeProc(pid: 100, ppid: 1, startTime: 1000, path: "/opt/codex/codex"),
            FakeProc(pid: 200, ppid: 100, startTime: 2000, path: "/bin/sh"),
        ])
        XCTAssertEqual(s.sessionIdentifier(forPid: 200), "ptree:100:1000")
    }

    func testPackageManagerLaunchingVarlockIsSkippedToLongLivedAncestor() {
        // node is the scope candidate but its argv shows it's launching varlock,
        // so it's treated as an ephemeral wrapper and we walk up.
        let s = scoper([
            FakeProc(pid: 100, ppid: 1, startTime: 1000, path: "/Applications/Foo.app/Contents/MacOS/Foo"),
            FakeProc(pid: 200, ppid: 100, startTime: 2000, path: "/opt/foo/foo-tool"),
            FakeProc(pid: 300, ppid: 200, startTime: 3000, path: "/usr/bin/node",
                     args: ["node", "/proj/node_modules/.bin/varlock", "load"]),
            FakeProc(pid: 400, ppid: 300, startTime: 4000, path: "/usr/local/bin/bun"),
        ])
        XCTAssertEqual(s.sessionIdentifier(forPid: 400), "ptree:200:2000")
    }

    func testLongLivedNodeRemainsAValidScope() {
        // Same shape, but node is NOT launching varlock (e.g. a vite dev server),
        // so it stays the scope rather than being skipped as ephemeral.
        let s = scoper([
            FakeProc(pid: 100, ppid: 1, startTime: 1000, path: "/Applications/Foo.app/Contents/MacOS/Foo"),
            FakeProc(pid: 200, ppid: 100, startTime: 2000, path: "/opt/foo/foo-tool"),
            FakeProc(pid: 300, ppid: 200, startTime: 3000, path: "/usr/bin/node",
                     args: ["node", "/proj/server.js"]),
            FakeProc(pid: 400, ppid: 300, startTime: 4000, path: "/usr/local/bin/bun"),
        ])
        XCTAssertEqual(s.sessionIdentifier(forPid: 400), "ptree:300:3000")
    }

    // MARK: - TTY cases

    func testSimpleTtySession() {
        let s = scoper([
            FakeProc(pid: 10, ppid: 1, tty: 5, startTime: 50, path: "/bin/zsh", sid: 10),
            FakeProc(pid: 20, ppid: 10, tty: 5, startTime: 60, path: "/usr/local/bin/bun"),
        ], ttyNames: [5: "ttys005"])
        // Anchored to the session leader's start time (50), not the peer's (60).
        XCTAssertEqual(s.sessionIdentifier(forPid: 20), "tty:ttys005:50")
    }

    func testCliAgentCombinesEnvWithTtyAnchor() {
        // Claude Code CLI: has a TTY *and* the session env var → combined.
        let s = scoper([
            FakeProc(pid: 10, ppid: 1, tty: 5, startTime: 50, path: "/bin/zsh", sid: 10),
            FakeProc(pid: 20, ppid: 10, tty: 5, startTime: 60, path: "/usr/local/bin/bun",
                     env: ["CLAUDE_CODE_SESSION_ID": "VICTIM"]),
        ], ttyNames: [5: "ttys005"])
        XCTAssertEqual(s.sessionIdentifier(forPid: 20), "env:CLAUDE_CODE_SESSION_ID:VICTIM|tty:ttys005:50")
    }

    func testFanOutPtysCollapseToOuterShell() {
        // turbo/nx-style: two tasks under distinct per-task PTYs, same login shell.
        // Both must resolve to the SAME session (the outer shell's tty), so a
        // parallel command doesn't fragment into N biometric prompts.
        let procs = [
            FakeProc(pid: 10, ppid: 1, tty: 5, startTime: 50, path: "/bin/zsh", sid: 0), // sid 0 → start-time fallback
            FakeProc(pid: 20, ppid: 10, tty: 7, startTime: 60, path: "/opt/turbo"),
            FakeProc(pid: 30, ppid: 20, tty: 7, startTime: 70, path: "/usr/local/bin/bun"),
            FakeProc(pid: 21, ppid: 10, tty: 8, startTime: 61, path: "/opt/turbo"),
            FakeProc(pid: 31, ppid: 21, tty: 8, startTime: 71, path: "/usr/local/bin/bun"),
        ]
        let ttyNames: [dev_t: String] = [5: "ttys005", 7: "ttys007", 8: "ttys008"]
        let a = scoper(procs, ttyNames: ttyNames).sessionIdentifier(forPid: 30)
        let b = scoper(procs, ttyNames: ttyNames).sessionIdentifier(forPid: 31)
        XCTAssertEqual(a, "tty:ttys005:50")
        XCTAssertEqual(a, b)
    }

    func testMultiplexerPaneIsASessionBoundary() {
        // tmux: walk stops at the pane's outermost shell (carrying the same TMUX
        // value) and never crosses into the host shell that launched tmux.
        let s = scoper([
            FakeProc(pid: 10, ppid: 1, tty: 5, startTime: 50, path: "/bin/zsh", env: [:], sid: 10),
            FakeProc(pid: 20, ppid: 10, tty: 6, startTime: 60, path: "/bin/zsh",
                     env: ["TMUX": "/tmp/tmux-501/default,1,0"], sid: 20),
            FakeProc(pid: 30, ppid: 20, tty: 6, startTime: 70, path: "/usr/local/bin/bun",
                     env: ["TMUX": "/tmp/tmux-501/default,1,0"]),
        ], ttyNames: [5: "ttys005", 6: "ttys006"])
        XCTAssertEqual(
            s.sessionIdentifier(forPid: 30),
            "tty:ttys006:60:TMUX=/tmp/tmux-501/default,1,0"
        )
    }

    func testDistinctTmuxPanesGetDistinctSessions() {
        // Two panes (different TMUX session ids) under the same host must NOT
        // collapse — the multiplexer value keeps them apart.
        func pane(paneShell: pid_t, peer: pid_t, tmuxValue: String) -> [FakeProc] {
            [
                FakeProc(pid: paneShell, ppid: 10, tty: 6, startTime: 60, path: "/bin/zsh",
                         env: ["TMUX": tmuxValue], sid: paneShell),
                FakeProc(pid: peer, ppid: paneShell, tty: 6, startTime: 70, path: "/usr/local/bin/bun",
                         env: ["TMUX": tmuxValue]),
            ]
        }
        let host = FakeProc(pid: 10, ppid: 1, tty: 5, startTime: 50, path: "/bin/zsh", sid: 10)
        let ttyNames: [dev_t: String] = [5: "ttys005", 6: "ttys006"]

        let one = scoper([host] + pane(paneShell: 20, peer: 30, tmuxValue: "sock,1,0"), ttyNames: ttyNames)
            .sessionIdentifier(forPid: 30)
        let two = scoper([host] + pane(paneShell: 21, peer: 31, tmuxValue: "sock,1,1"), ttyNames: ttyNames)
            .sessionIdentifier(forPid: 31)
        XCTAssertNotEqual(one, two)
    }
}
