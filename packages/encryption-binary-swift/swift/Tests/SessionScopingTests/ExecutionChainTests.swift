import XCTest
@testable import SessionScoping

/// What the panel shows about who is asking, against synthetic process trees.
///
/// The point of the chain is that one process name is not an answer. These
/// assert the parts a person actually reads: which hop is emphasised, what a
/// script running under an interpreter is called, what the daemon will and will
/// not claim about a signature, and that a tree it cannot read degrades to a
/// smaller answer rather than to no panel.
final class ExecutionChainTests: XCTestCase {
    /// A posture answer per pid, for the pids a test cares about.
    private struct FakePosture: PostureProbe {
        var facts: [pid_t: PeerPostureFacts] = [:]
        func posture(forPid pid: pid_t) -> PeerPostureFacts {
            return facts[pid] ?? .unreadable
        }
    }

    private static let signed = PeerPostureFacts(
        isTraced: false,
        hasHardenedRuntime: true,
        signatureValid: true,
        isReadable: true
    )

    /// Session records as an agent would have written them, by pid.
    private struct FakeSessionMetadata: AgentSessionMetadataReader {
        var records: [pid_t: AgentSessionMetadata] = [:]
        func metadata(for product: AgentProduct, pid: pid_t, processStartTime: Int) -> AgentSessionMetadata? {
            return records[pid]
        }
    }

    private func builder(
        _ procs: [FakeProc],
        ttyNames: [dev_t: String] = [:],
        posture: FakePosture = FakePosture(),
        sessionMetadata: AgentSessionMetadataReader = FakeSessionMetadata()
    ) -> ExecutionChainBuilder {
        return ExecutionChainBuilder(
            provider: FakeProcessProvider(procs, ttyNames: ttyNames),
            posture: posture,
            sessionMetadata: sessionMetadata
        )
    }

    /// iTerm2 -> zsh -> varlock: the plain terminal case.
    private var terminalTree: [FakeProc] {
        return [
            FakeProc(pid: 100, ppid: 1, tty: 16, path: "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
            FakeProc(pid: 200, ppid: 100, tty: 16, path: "/bin/zsh"),
            FakeProc(pid: 300, ppid: 200, tty: 16, path: "/opt/homebrew/bin/varlock"),
        ]
    }

    func testTheChainReadsFromTheLauncherDownToTheCaller() {
        let chain = builder(terminalTree, ttyNames: [16: "ttys004"]).build(forPid: 300)

        XCTAssertEqual(chain.hops.map { $0.name }, ["iTerm2", "zsh", "varlock"])
        XCTAssertTrue(chain.hops[0].isLauncher)
        XCTAssertEqual(chain.hops[0].bundlePath, "/Applications/iTerm.app")
        // The terminal goes on the row a person recognises, which is the app.
        XCTAssertEqual(chain.hops[0].terminalName, "ttys004")
        XCTAssertNil(chain.hops[1].terminalName)
    }

    func testAPlainShellIsTheActorWhenNothingElseIs() {
        let chain = builder(terminalTree).build(forPid: 300)
        // varlock is always in the chain, being the process that connected, and
        // is never the answer to "who is asking".
        XCTAssertEqual(chain.hops.first { $0.isImportant }?.name, "zsh")
        XCTAssertTrue(chain.hops.last { $0.name == "varlock" }?.isMinor ?? false)
    }

    func testAScriptIsTheActorRatherThanTheInterpreterRunningIt() {
        let chain = builder([
            FakeProc(pid: 100, ppid: 1, tty: 16, path: "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
            FakeProc(pid: 200, ppid: 100, tty: 16, path: "/bin/zsh"),
            FakeProc(
                pid: 300,
                ppid: 200,
                tty: 16,
                path: "/Users/dev/.bun/bin/bun",
                args: ["bun", "run", "scripts/agent.ts"]
            ),
            FakeProc(pid: 400, ppid: 300, tty: 16, path: "/opt/homebrew/bin/varlock"),
        ], posture: FakePosture(facts: [300: Self.signed])).build(forPid: 400)

        let actor = chain.hops.first { $0.isImportant }
        XCTAssertEqual(actor?.name, "agent.ts")
        XCTAssertEqual(actor?.via, "via bun")
        // The interpreter's own signature is real and says nothing about the
        // script it was handed, so the panel refuses to launder one into the other.
        XCTAssertEqual(actor?.posture, .interpretedScript)
        // The warning belongs to that hop, and is drawn under it rather than in
        // a legend the reader would have to match back up to a row.
        XCTAssertEqual(
            actor?.advisory,
            "a script run by bun: approval trusts this file, not the signed interpreter"
        )
        XCTAssertNil(chain.hops.first { $0.name == "zsh" }?.advisory)
    }

    func testTheCallersOwnCommandLineIsReadFromTheKernel() {
        let chain = builder([
            FakeProc(pid: 200, ppid: 1, path: "/bin/zsh", args: ["-zsh"]),
            FakeProc(
                pid: 300,
                ppid: 200,
                path: "/opt/homebrew/bin/varlock",
                args: ["/opt/homebrew/bin/varlock", "run", "--", "next", "dev"]
            ),
        ]).build(forPid: 300)

        // Named by what was typed, not by where the binary happened to live.
        XCTAssertEqual(chain.hops.last?.invocation, "varlock run -- next dev")
        // Only one hop is the process that connected, and only that one's
        // command line is drawn.
        XCTAssertEqual(chain.hops.map { $0.isRequester }, [false, true])
    }

    func testVarlockIsNamedPlainlyHoweverItWasStarted() {
        let chain = builder([
            FakeProc(pid: 200, ppid: 1, path: "/bin/zsh"),
            FakeProc(
                pid: 300,
                ppid: 200,
                path: "/Users/dev/.bun/bin/bun",
                args: ["bunx", "varlock", "load"]
            ),
        ], posture: FakePosture(facts: [300: Self.signed])).build(forPid: 300)

        let hop = try? XCTUnwrap(chain.hops.last)
        // "varlock via bun" is true and useless: bun is how varlock ships, not
        // who is asking. The interpreter stays in the path, which the expanded
        // chain shows.
        XCTAssertEqual(hop?.name, "varlock")
        XCTAssertNil(hop?.via)
        XCTAssertNil(hop?.advisory)
        XCTAssertEqual(hop?.posture, .signedHardened)
        XCTAssertEqual(hop?.invocation, "varlock load")
    }

    func testTheHostCommandIsFoundForAVarlockLoadedInsideSomethingElse() {
        let chain = builder([
            FakeProc(pid: 100, ppid: 1, path: "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
            FakeProc(pid: 200, ppid: 100, path: "/bin/zsh", args: ["-zsh"]),
            FakeProc(
                pid: 300,
                ppid: 200,
                path: "/usr/local/bin/node",
                args: ["node", "/app/node_modules/.bin/next", "dev"]
            ),
            FakeProc(
                pid: 400,
                ppid: 300,
                path: "/app/node_modules/.bin/varlock",
                args: ["/app/node_modules/.bin/varlock", "load", "--format", "json-full"]
            ),
        ]).build(forPid: 400)

        // An auto-load runs the same CLI a person would, so varlock's own
        // command line is not the one worth showing: the host's is.
        XCTAssertEqual(chain.hostInvocation, "next dev")
        XCTAssertEqual(chain.hops.last?.invocation, "varlock load --format json-full")
    }

    func testALongCommandLineKeepsTheSubcommandAndTheFirstArguments() {
        let long = ExecutionChainBuilder.invocation(from: ["varlock", "run"] + (0..<40).map { "--flag-\($0)" })
        XCTAssertTrue(long?.hasPrefix("varlock run --flag-0") ?? false)
        XCTAssertEqual(long?.count, ExecutionChainBuilder.maxInvocationLength)
        XCTAssertTrue(long?.hasSuffix("\u{2026}") ?? false)
        XCTAssertNil(ExecutionChainBuilder.invocation(from: []))
    }

    func testOnlyACheckedSignatureGetsAWord() {
        XCTAssertEqual(HopPosture.signedHardened.inlineLabel, "signed")
        // Nothing to say about a hop we could not vouch for. Silence is honest;
        // a word would read as a verdict.
        XCTAssertNil(HopPosture.unhardened.inlineLabel)
        XCTAssertNil(HopPosture.unknown.inlineLabel)
        XCTAssertNil(HopPosture.interpretedScript.inlineLabel)
    }

    func testAnInterpreterWithNoScriptStaysItself() {
        let chain = builder([
            FakeProc(pid: 200, ppid: 1, path: "/bin/zsh"),
            FakeProc(pid: 300, ppid: 200, path: "/usr/local/bin/node", args: ["node", "--version"]),
        ]).build(forPid: 300)

        XCTAssertEqual(chain.hops.map { $0.name }, ["zsh", "node"])
        XCTAssertNil(chain.hops[1].via)
    }

    func testVarlockRunningAsAScriptIsStillNotTheActor() {
        let chain = builder([
            FakeProc(pid: 100, ppid: 1, path: "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
            FakeProc(pid: 200, ppid: 100, path: "/bin/zsh"),
            FakeProc(
                pid: 300,
                ppid: 200,
                path: "/usr/local/bin/node",
                args: ["node", "/project/node_modules/.bin/varlock", "run"]
            ),
        ]).build(forPid: 300)

        XCTAssertEqual(chain.hops.first { $0.isImportant }?.name, "zsh")
    }

    func testSignatureIsReportedOnlyWhenItWasActuallyRead() {
        let chain = builder(
            terminalTree,
            posture: FakePosture(facts: [
                200: Self.signed,
                300: PeerPostureFacts(
                    isTraced: false,
                    hasHardenedRuntime: false,
                    signatureValid: true,
                    isReadable: true
                ),
            ])
        ).build(forPid: 300)

        XCTAssertEqual(chain.hops[1].posture, .signedHardened)
        // Signed but not hardened is not the same claim, and an unreadable
        // process is no claim at all.
        XCTAssertEqual(chain.hops[2].posture, .unhardened)
        XCTAssertEqual(chain.hops[0].posture, .unknown)
    }

    func testAShortChainShowsEverythingAndALongOneFoldsTheBoringHops() {
        let short = builder(terminalTree).build(forPid: 300)
        XCTAssertFalse(short.collapsesWhenResting)
        XCTAssertEqual(short.restingHops.count, 3)

        let long = builder([
            FakeProc(pid: 100, ppid: 1, path: "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
            FakeProc(pid: 200, ppid: 100, path: "/bin/zsh"),
            FakeProc(pid: 300, ppid: 200, path: "/Users/dev/.bun/bin/bun", args: ["bun", "agent.ts"]),
            FakeProc(pid: 400, ppid: 300, path: "/opt/homebrew/bin/varlock"),
        ]).build(forPid: 400)

        XCTAssertTrue(long.collapsesWhenResting)
        // The launcher and the actor always stay; the plumbing folds away.
        XCTAssertEqual(long.restingHops.map { $0.name }, ["iTerm2", "agent.ts"])
        XCTAssertEqual(long.expanderLabel, "2 more steps (zsh, varlock)")
    }

    func testAnAgentSessionIsNamedByItsProductAndWhenItStarted() {
        let chain = builder([
            FakeProc(pid: 100, ppid: 1, path: "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
            FakeProc(
                pid: 150,
                ppid: 100,
                startTime: 1_700_000_000,
                path: "/Users/dev/.local/bin/claude",
                args: ["claude"]
            ),
            FakeProc(pid: 200, ppid: 150, path: "/bin/zsh"),
            FakeProc(pid: 300, ppid: 200, path: "/opt/homebrew/bin/varlock"),
        ]).build(forPid: 300)

        XCTAssertEqual(chain.agentSession?.productName, "Claude Code")
        XCTAssertEqual(chain.sessionRootHop?.pid, 150)
        // No record on disk, so the process start is the best answer there is.
        XCTAssertEqual(chain.agentSession?.startTime, 1_700_000_000)
        XCTAssertNil(chain.agentSession?.title)
    }

    func testTheSessionIsAHopWhereItActuallySitsInTheAncestry() {
        let chain = builder([
            FakeProc(pid: 100, ppid: 1, path: "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
            FakeProc(pid: 150, ppid: 100, startTime: 1_700_000_000, path: "/Users/dev/.local/bin/claude"),
            FakeProc(pid: 200, ppid: 150, path: "/bin/zsh"),
            FakeProc(pid: 300, ppid: 200, path: "/opt/homebrew/bin/varlock"),
        ]).build(forPid: 300)

        XCTAssertEqual(chain.hops.map { $0.isSessionRoot }, [false, true, false, false])
        // Everything started by the agent reads as inside its session; the app
        // that launched the agent does not.
        XCTAssertEqual(chain.hops.map { $0.isInsideSession }, [false, false, true, true])
        // The agent is not also the actor: what is running is what it started.
        XCTAssertEqual(chain.hops.first { $0.isImportant }?.name, "zsh")
    }

    func testTheSessionHopIsNeverFoldedAway() {
        let chain = builder([
            FakeProc(pid: 100, ppid: 1, path: "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
            FakeProc(pid: 150, ppid: 100, path: "/Users/dev/.local/bin/claude"),
            FakeProc(pid: 200, ppid: 150, path: "/bin/zsh"),
            FakeProc(pid: 300, ppid: 200, path: "/Users/dev/.bun/bin/bun", args: ["bun", "agent.ts"]),
            FakeProc(pid: 400, ppid: 300, path: "/opt/homebrew/bin/varlock"),
        ]).build(forPid: 400)

        XCTAssertTrue(chain.collapsesWhenResting)
        XCTAssertEqual(chain.restingHops.map { $0.name }, ["iTerm2", "claude", "agent.ts"])
        XCTAssertEqual(chain.expanderLabel, "2 more steps (zsh, varlock)")
    }

    func testTheSessionTitleComesFromTheAgentsOwnRecord() {
        let chain = builder(
            [
                FakeProc(pid: 150, ppid: 1, startTime: 1_700_000_000, path: "/Users/dev/.local/bin/claude"),
                FakeProc(pid: 300, ppid: 150, path: "/opt/homebrew/bin/varlock"),
            ],
            sessionMetadata: FakeSessionMetadata(records: [
                150: AgentSessionMetadata(title: "vault panel redesign", startTime: 1_700_000_042),
            ])
        ).build(forPid: 300)

        XCTAssertEqual(chain.agentSession?.title, "vault panel redesign")
        // The agent's own record of when the session began beats the process
        // start, since a session can outlive the process that opened it.
        XCTAssertEqual(chain.agentSession?.startTime, 1_700_000_042)
    }

    func testAnAgentSessionIsFoundThroughTheEnvironmentItExported() {
        // The agent itself is out of reach (too far up, or not on the path we
        // walked), but what it exported into the shell is still there.
        let chain = builder([
            FakeProc(pid: 200, ppid: 1, startTime: 1_700_000_500, path: "/bin/zsh", env: ["CLAUDECODE": "1"]),
            FakeProc(pid: 300, ppid: 200, path: "/opt/homebrew/bin/varlock", env: ["CLAUDECODE": "1"]),
        ]).build(forPid: 300)

        XCTAssertEqual(chain.agentSession?.productName, "Claude Code")
        // The topmost process carrying the marker is the one nearest the agent,
        // so its start time is the closest thing to the session's.
        XCTAssertEqual(chain.sessionRootHop?.pid, 200)
    }

    func testAnEmptyMarkerIsNotASession() {
        let chain = builder([
            FakeProc(pid: 200, ppid: 1, path: "/bin/zsh", env: ["CLAUDECODE": "0"]),
            FakeProc(pid: 300, ppid: 200, path: "/opt/homebrew/bin/varlock", env: ["CLAUDECODE": ""]),
        ]).build(forPid: 300)

        XCTAssertNil(chain.agentSession)
    }

    func testAProcessTheDaemonCannotReadDegradesToAnEmptyChain() {
        let chain = builder([]).build(forPid: 999)
        XCTAssertTrue(chain.isEmpty)
        XCTAssertNil(chain.agentSession)
        XCTAssertNil(chain.expanderLabel)
    }

    func testAWalkThatRunsOutOfTimeStopsWhereItGot() {
        // A clock that jumps past the deadline on its first check: the chain
        // comes back short rather than the panel coming back late.
        var ticks = 0
        let slow = ExecutionChainBuilder(
            provider: FakeProcessProvider(terminalTree, ttyNames: [:]),
            posture: FakePosture(),
            clock: {
                ticks += 1
                return Date(timeIntervalSince1970: ticks == 1 ? 0 : 10)
            }
        )
        let chain = slow.build(forPid: 300)
        XCTAssertEqual(chain.hops.map { $0.name }, ["varlock"])
        XCTAssertNil(chain.agentSession)
    }
}
