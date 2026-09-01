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

    /// Names for the tty devices these trees use.
    ///
    /// A default, because a device with no name is a machine whose `ttyname`
    /// failed, and session scoping falls back to the process tree there. A
    /// realistic terminal tree should never be testing that by accident.
    private static let ttyNames: [dev_t: String] = [16: "ttys004", 17: "ttys005"]

    override func setUp() {
        super.setUp()
        // The owning-package lookup is cached by resolved path. These tests write
        // manifests under a fresh directory every time, so nothing should carry
        // over; clearing makes that a property of the suite rather than of the
        // uuid generator.
        ExecutionChainBuilder.resetPackageCache()
    }

    private func builder(
        _ procs: [FakeProc],
        ttyNames: [dev_t: String] = ExecutionChainTests.ttyNames,
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
    ///
    /// The app holds no controlling tty, the way a windowed app does not: it owns
    /// the pty the shell below it is on. That is what makes the shell the session
    /// the grant attaches to.
    private var terminalTree: [FakeProc] {
        return [
            FakeProc(pid: 100, ppid: 1, path: "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
            FakeProc(pid: 200, ppid: 100, tty: 16, path: "/bin/zsh"),
            FakeProc(pid: 300, ppid: 200, tty: 16, path: "/opt/homebrew/bin/varlock"),
        ]
    }

    func testTheChainReadsFromTheLauncherDownToTheCaller() {
        let chain = builder(terminalTree).build(forPid: 300)

        XCTAssertEqual(chain.hops.map { $0.name }, ["iTerm2", "zsh", "varlock"])
        XCTAssertTrue(chain.hops[0].isLauncher)
        XCTAssertEqual(chain.hops[0].bundlePath, "/Applications/iTerm.app")
        // A plain single-bundle app: the outer walk finds nothing to walk out
        // to, and the evidence line is the bundle itself. It used to be the
        // directory the app sits in, which for anything in /Applications read
        // "/Applications" and answered nothing; WHICH copy of an app this is, is
        // the question the line exists for.
        XCTAssertEqual(chain.hops[0].path, "/Applications/iTerm.app")
        // The tty is stated once, on the session root, and nowhere else.
        XCTAssertEqual(Self.terminalMentions(chain), ["Terminal ttys004"])
        XCTAssertEqual(chain.sessionRootHop?.name, "zsh")
    }

    /// Every place the panel prints a tty id, in the order it draws them.
    ///
    /// The invariant this exists for: exactly one, on the row that owns it. A
    /// controlling terminal is inherited, so a second mention is the same fact
    /// twice, and a mention on the app that was launched is a fact that is not
    /// even true of it.
    private static func terminalMentions(_ chain: ExecutionChain) -> [String] {
        return chain.hops.flatMap { hop -> [String] in
            var drawn = [hop.name, hop.via, hop.invocation, hop.runTarget].compactMap { $0 }
            if let root = hop.sessionRoot { drawn.append(root.descriptionLine) }
            return drawn.filter { $0.contains("ttys") }
        }
    }

    func testATypedCommandHasNoActorAndSaysWhichSessionItIs() {
        let chain = builder(terminalTree).build(forPid: 300)

        // Nothing is bold. The values are for the command, the command is
        // varlock, and inventing a third party would be inventing information.
        XCTAssertTrue(chain.hops.allSatisfy { !$0.isImportant })
        XCTAssertTrue(chain.hops.first { $0.name == "varlock" }?.isMinor ?? false)
        // The session the grant would attach to is the shell on the tty, and it
        // is named the way the menu bar names it.
        XCTAssertEqual(chain.sessionRootHop?.name, "zsh")
        XCTAssertEqual(chain.sessionRootHop?.sessionRoot?.label, "Terminal ttys004")
        XCTAssertEqual(chain.sessionRootHop?.sessionRoot?.kind, .terminal)
        XCTAssertNil(chain.agentSession)
        // Exactly one, always: "This session" has one answer.
        XCTAssertEqual(chain.hops.filter { $0.isSessionRoot }.count, 1)
        XCTAssertEqual(chain.hops.map { $0.isInsideSession }, [false, false, true])
    }

    func testTheSessionRootIsTheHopTheGrantWouldAttachTo() {
        let procs = [
            FakeProc(pid: 100, ppid: 1, path: "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
            FakeProc(pid: 150, ppid: 100, tty: 16, path: "/Users/dev/.local/bin/claude"),
            FakeProc(pid: 200, ppid: 150, tty: 16, path: "/bin/zsh"),
            FakeProc(pid: 300, ppid: 200, tty: 16, path: "/opt/homebrew/bin/varlock"),
        ]
        let chain = builder(procs).build(forPid: 300)

        // The same process the scoper keys the grant by, found the same way.
        let scoped = SessionScoper(provider: FakeProcessProvider(procs, ttyNames: Self.ttyNames))
        XCTAssertEqual(chain.sessionRootHop?.pid, scoped.sessionAnchor(forPid: 300)?.pid)
        XCTAssertEqual(chain.sessionRootHop?.name, "claude")
        // The agent decorates that row rather than creating it.
        XCTAssertEqual(chain.agentSession?.productName, "Claude Code")
        // No shell is bold, and neither is varlock: nothing here qualifies.
        XCTAssertTrue(chain.hops.allSatisfy { !$0.isImportant })
        XCTAssertFalse(chain.sessionRootHop?.isMinor ?? true)
    }

    func testOnlyOneHopIsEmphasisedInAFullAgentChain() {
        let chain = builder([
            FakeProc(pid: 100, ppid: 1, path: "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
            FakeProc(pid: 200, ppid: 100, tty: 16, path: "/bin/zsh"),
            FakeProc(pid: 250, ppid: 200, tty: 16, path: "/Users/dev/.local/bin/claude"),
            FakeProc(pid: 260, ppid: 250, path: "/bin/bash", args: ["bash", "-c", "bun run agent.ts"]),
            FakeProc(pid: 300, ppid: 260, path: "/Users/dev/.bun/bin/bun", args: ["bun", "run", "agent.ts"]),
            FakeProc(pid: 400, ppid: 300, path: "/opt/homebrew/bin/varlock"),
        ]).build(forPid: 400)

        XCTAssertEqual(chain.hops.filter { $0.isImportant }.map { $0.name }, ["agent.ts"])
        XCTAssertEqual(chain.sessionRootHop?.agentSession?.productName, "Claude Code")
        // The shells either side of the agent stay minor, so they fold away.
        XCTAssertEqual(chain.collapsibleHops.map { $0.name }, ["zsh", "bash", "varlock"])
        // Nothing under the agent has a controlling terminal, so this session is
        // anchored on the process tree and there is no tty to state. The panel
        // used to state one anyway, borrowed off an ancestor and printed on the
        // app, which named a terminal the grant is not even scoped to.
        XCTAssertEqual(Self.terminalMentions(chain), [])
        XCTAssertEqual(chain.sessionRootHop?.sessionRoot?.kind, .processTree)
    }

    func testTheTtyIsSaidOnceByTheSessionRootUnderTmux() {
        // tmux: the server is the top of the chain and holds no tty of its own,
        // so the pane's shell is what "ttys005" actually names, and that shell is
        // where the grant attaches.
        let chain = builder([
            FakeProc(pid: 100, ppid: 1, path: "/opt/homebrew/bin/tmux"),
            FakeProc(pid: 200, ppid: 100, tty: 17, path: "/bin/zsh", env: ["TMUX": "/tmp/tmux-501/default,91,0"]),
            FakeProc(
                pid: 300,
                ppid: 200,
                tty: 17,
                path: "/opt/homebrew/bin/varlock",
                env: ["TMUX": "/tmp/tmux-501/default,91,0"]
            ),
        ], ttyNames: [17: "ttys005"]).build(forPid: 300)

        XCTAssertEqual(chain.hops.map { $0.name }, ["tmux", "zsh", "varlock"])
        XCTAssertEqual(chain.sessionRootHop?.name, "zsh")
        // The pane is its own session, and the multiplexer is named with it.
        XCTAssertEqual(Self.terminalMentions(chain), ["Terminal ttys005 (tmux)"])
        // tmux is a program rather than a shell, so it is what is running here.
        XCTAssertEqual(chain.hops.first { $0.isImportant }?.name, "tmux")
    }

    func testAScriptIsTheActorRatherThanTheInterpreterRunningIt() {
        let chain = builder([
            FakeProc(pid: 100, ppid: 1, path: "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
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
        // who is asking. So the row stays plain.
        XCTAssertEqual(hop?.name, "varlock")
        XCTAssertNil(hop?.via)
        XCTAssertNil(hop?.advisory)
        XCTAssertEqual(hop?.invocation, "varlock load")

        // But the row is NOT allowed to wear bun's signature. bun really is
        // signed with the Hardened Runtime here, and every word of that is about
        // bun: what this row names is a directory of JavaScript files that any
        // process running as the user can rewrite. This assertion used to read
        // `.signedHardened`, which is how `bunx varlock load` came to draw a
        // green shield and the word "signed" on a row labelled varlock.
        XCTAssertEqual(hop?.posture, .interpretedScript)
        // The signature is still reported, attached to what it is a signature of
        // and never separated from it.
        XCTAssertEqual(hop?.interpreterName, "bun")
        XCTAssertEqual(hop?.interpreterPosture, .signedHardened)
        // And the row says in words which varlock this is.
        XCTAssertEqual(hop?.runtimeForm, "varlock's JavaScript, run by bun, not the standalone binary")
        XCTAssertTrue(hop?.runtimeFormIsCaution ?? false)
    }

    func testACompiledVarlockSaysSoAndAnswersForItself() {
        let chain = builder([
            FakeProc(pid: 200, ppid: 1, path: "/bin/zsh"),
            FakeProc(
                pid: 300,
                ppid: 200,
                path: "/opt/homebrew/bin/varlock",
                args: ["/opt/homebrew/bin/varlock", "load"]
            ),
        ], posture: FakePosture(facts: [300: Self.signed])).build(forPid: 300)

        let hop = chain.hops.last
        // A self-contained binary is the one case where the kernel's answer is
        // about the code that will run, so the row keeps it.
        XCTAssertEqual(hop?.posture, .signedHardened)
        XCTAssertNil(hop?.interpreterName)
        XCTAssertEqual(hop?.runtimeForm, "the standalone varlock binary")
        XCTAssertFalse(hop?.runtimeFormIsCaution ?? true)
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
        // command line is not the one worth showing: the host's is. The host is
        // the program, not the shell that started it.
        XCTAssertEqual(chain.hostInvocation, "next dev")
        XCTAssertEqual(chain.hostProgram?.name, "next")
        // Output formatting says nothing about which secrets go where.
        XCTAssertEqual(chain.hops.last?.invocation, "varlock load")
    }

    func testAVarlockLineKeepsWhatChangesTheRequestAndDropsPresentation() {
        let line = ExecutionChainBuilder.invocation(from: [
            "/opt/homebrew/bin/varlock", "load",
            "--format", "json-full", "--compact", "--include-internal",
            "--env", "production", "--path", ".env.production",
        ])
        // Which environment and which file are the request; the rest is printing.
        XCTAssertEqual(line, "varlock load --env production --path .env.production")

        // The `=` form takes its value with it, and an unknown flag is kept:
        // staying quiet about something we do not recognise is the wrong default
        // for a line that exists to be evidence.
        XCTAssertEqual(
            ExecutionChainBuilder.invocation(from: ["varlock", "load", "--format=json", "--brand-new-flag"]),
            "varlock load --brand-new-flag"
        )
    }

    func testAVarlockRunNamesTheCommandThatReceivesTheValues() {
        let arguments = ["/opt/homebrew/bin/varlock", "run", "--format", "json", "--", "npm", "run", "build"]
        XCTAssertEqual(ExecutionChainBuilder.invocation(from: arguments), "varlock run -- npm run build")
        // The process that gets the values does not exist yet, so it is in no
        // ancestry: argv is the only place it can be read from.
        XCTAssertEqual(ExecutionChainBuilder.runTarget(from: arguments), "npm run build")
        XCTAssertNil(ExecutionChainBuilder.runTarget(from: ["varlock", "load"]))
        XCTAssertNil(ExecutionChainBuilder.runTarget(from: ["node", "server.js"]))
    }

    func testTheHostThatAutoLoadedVarlockIsTheActor() {
        let chain = builder([
            FakeProc(pid: 100, ppid: 1, path: "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
            FakeProc(pid: 200, ppid: 100, tty: 16, path: "/bin/zsh", args: ["-zsh"]),
            FakeProc(
                pid: 300,
                ppid: 200,
                tty: 16,
                path: "/usr/local/bin/node",
                args: ["node", "/app/node_modules/.bin/next", "dev"]
            ),
            FakeProc(
                pid: 400,
                ppid: 300,
                tty: 16,
                path: "/app/node_modules/.bin/varlock",
                args: ["/app/node_modules/.bin/varlock", "load"]
            ),
        ]).build(forPid: 400)

        // The values are for the dev server; varlock fetched them on its behalf.
        XCTAssertEqual(chain.hops.filter { $0.isImportant }.map { $0.name }, ["next"])
        // And the session is still the terminal it was started from.
        XCTAssertEqual(chain.sessionRootHop?.name, "zsh")
        XCTAssertEqual(chain.sessionRootHop?.sessionRoot?.label, "Terminal ttys004")
    }

    func testALongCommandLineKeepsTheSubcommandAndTheFirstArguments() {
        let long = ExecutionChainBuilder.invocation(from: ["varlock", "run"] + (0..<40).map { "--flag-\($0)" })
        XCTAssertTrue(long?.hasPrefix("varlock run --flag-0") ?? false)
        XCTAssertEqual(long?.count, ExecutionChainBuilder.maxVarlockInvocationLength)
        XCTAssertTrue(long?.hasSuffix("\u{2026}") ?? false)
        XCTAssertNil(ExecutionChainBuilder.invocation(from: []))
    }

    func testALongRunLineElidesTheMiddleAndKeepsTheTarget() {
        let long = ExecutionChainBuilder.invocation(
            from: ["varlock", "run", "--env", "staging"] + (0..<20).map { "--flag-\($0)" }
                + ["--", "npm", "run", "build"]
        )
        // The head says what was run and the tail says who receives the values.
        // Truncating the tail would drop exactly the half worth reading.
        XCTAssertTrue(long?.hasPrefix("varlock run --env staging") ?? false)
        XCTAssertTrue(long?.hasSuffix("-- npm run build") ?? false)
        XCTAssertTrue(long?.contains("\u{2026}") ?? false)
        XCTAssertLessThanOrEqual(long?.count ?? 0, ExecutionChainBuilder.maxVarlockInvocationLength)
    }

    func testEveryPostureSaysWhichOneItIs() {
        // Each answer gets its own word and its own shape. A blank space used to
        // stand for "we are not saying", which on a panel reads as "nothing to
        // report": the opposite fact.
        XCTAssertEqual(HopPosture.signedHardened.inlineLabel, "signed")
        XCTAssertEqual(HopPosture.signedOnly.inlineLabel, "unhardened")
        XCTAssertEqual(HopPosture.unsigned.inlineLabel, "unsigned")
        XCTAssertEqual(HopPosture.interpretedScript.inlineLabel, "not verified")
        XCTAssertEqual(HopPosture.unknown.inlineLabel, "unchecked")

        let shapes = Set(HopPosture.allAnswers.map(\.symbolName))
        XCTAssertEqual(shapes.count, HopPosture.allAnswers.count)
        // Only one answer reads as good news, and only one as a caution.
        XCTAssertEqual(HopPosture.allAnswers.filter(\.isVerified), [.signedHardened])
        XCTAssertEqual(HopPosture.allAnswers.filter(\.isCaution), [.interpretedScript])
    }

    func testEveryPostureSpellsOutWhatWasAndWasNotChecked() {
        for posture in HopPosture.allAnswers {
            let explanation = posture.explanation(subject: "\u{201C}varlock\u{201D}", interpreter: "bun")
            XCTAssertTrue(explanation.contains("varlock"), "\(posture) never names its subject")
            // The half people skip is the half that matters, so every one of
            // these has to say what it did NOT establish.
            XCTAssertTrue(
                explanation.lowercased().contains("not checked")
                    || explanation.lowercased().contains("nothing about"),
                "\(posture) does not say what was left unchecked"
            )
        }
        // The interpreted case names the interpreter, so the signature and the
        // thing it is a signature of can never be read as the same claim.
        XCTAssertTrue(
            HopPosture.interpretedScript
                .explanation(subject: "\u{201C}varlock\u{201D}", interpreter: "bun")
                .contains("bun")
        )
    }

    func testAnInterpreterWithNoScriptStaysItself() {
        let chain = builder([
            FakeProc(pid: 200, ppid: 1, path: "/bin/zsh"),
            FakeProc(pid: 300, ppid: 200, path: "/usr/local/bin/node", args: ["node", "--version"]),
        ]).build(forPid: 300)

        XCTAssertEqual(chain.hops.map { $0.name }, ["zsh", "node"])
        XCTAssertNil(chain.hops[1].via)
    }

    func testVarlockRunningAsAScriptIsStillNamedVarlock() {
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

        // node running varlock's own CLI is varlock, not a third-party script, so
        // it is not called out as somebody else's code and keeps its own name.
        XCTAssertEqual(chain.hops.last?.name, "varlock")
        // The generic "a script run by node" advisory is still suppressed: the
        // varlock row has its own, more specific line instead.
        XCTAssertNil(chain.hops.last?.advisory)
        XCTAssertEqual(
            chain.hops.last?.runtimeForm,
            "varlock's JavaScript, run by node, not the standalone binary"
        )
        // And the shell above it is still not what is running.
        XCTAssertFalse(chain.hops.first { $0.name == "zsh" }?.isImportant ?? true)
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
        XCTAssertEqual(chain.hops[2].posture, .signedOnly)
        XCTAssertEqual(chain.hops[0].posture, .unknown)

        // A readable status word with no valid signature is a fourth answer, and
        // saying "unhardened" for it would be describing the wrong failure.
        let unsigned = builder(
            terminalTree,
            posture: FakePosture(facts: [
                300: PeerPostureFacts(
                    isTraced: false,
                    hasHardenedRuntime: false,
                    signatureValid: false,
                    isReadable: true
                ),
            ])
        ).build(forPid: 300)
        XCTAssertEqual(unsigned.hops[2].posture, .unsigned)
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
        // The agent is not also the actor, the shell it started is not one, and
        // varlock is never one: this request has nothing to emphasise.
        XCTAssertTrue(chain.hops.allSatisfy { !$0.isImportant })
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

    func testAnExportedMarkerDoesNotPutTheAgentsNameOnSomeOtherProcess() {
        // The agent itself is out of reach (too far up, or not on the path we
        // walked) and what it exported into the shell is still there. That marker
        // travels to every descendant, so it says the request came from inside a
        // session and nothing about which process this is: `next dev` started by
        // an agent carries it too, and is not Claude Code.
        let chain = builder([
            FakeProc(pid: 200, ppid: 1, startTime: 1_700_000_500, path: "/bin/zsh", env: ["CLAUDECODE": "1"]),
            FakeProc(pid: 300, ppid: 200, path: "/opt/homebrew/bin/varlock", env: ["CLAUDECODE": "1"]),
        ]).build(forPid: 300)

        XCTAssertNil(chain.agentSession)
        // The session root is still drawn, because a grant still attaches to
        // something: the process the scoper anchored on, named as itself.
        XCTAssertEqual(chain.sessionRootHop?.pid, 200)
        XCTAssertEqual(chain.sessionRootHop?.name, "zsh")
        XCTAssertEqual(chain.sessionRootHop?.sessionRoot?.label, "Process 200")
    }

    func testAnEmptyMarkerIsNotASession() {
        let chain = builder([
            FakeProc(pid: 200, ppid: 1, path: "/bin/zsh", env: ["CLAUDECODE": "0"]),
            FakeProc(pid: 300, ppid: 200, path: "/opt/homebrew/bin/varlock", env: ["CLAUDECODE": ""]),
        ]).build(forPid: 300)

        XCTAssertNil(chain.agentSession)
    }

    // MARK: - Launchers nested inside a bigger app

    /// VS Code's integrated terminal, which is what most of this is for.
    ///
    /// Electron editors spawn the shell from a helper bundle buried inside the
    /// real app, so the process path names something nobody launched.
    private var vsCodeTree: [FakeProc] {
        return [
            FakeProc(
                pid: 100,
                ppid: 1,
                path: "/Applications/Visual Studio Code.app/Contents/Frameworks"
                    + "/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)"
            ),
            FakeProc(pid: 200, ppid: 100, tty: 16, path: "/bin/zsh"),
            FakeProc(
                pid: 300,
                ppid: 200,
                tty: 16,
                path: "/opt/homebrew/bin/varlock",
                args: ["/opt/homebrew/bin/varlock", "load"]
            ),
        ]
    }

    func testANestedHelperIsDrawnAsTheAppThatWasLaunched() {
        let chain = builder(vsCodeTree).build(forPid: 300)
        let launcher = chain.hops[0]

        // The name and the icon come from the outermost bundle. "Visual Studio
        // Code" beats the plist's own "Code" only because it is the fuller form
        // of the same name, which is what Finder and the Dock show.
        XCTAssertEqual(launcher.name, "Visual Studio Code")
        XCTAssertEqual(launcher.bundlePath, "/Applications/Visual Studio Code.app")
        // The helper is still said, once the chain is opened: honest, just not
        // the headline.
        XCTAssertEqual(
            launcher.path,
            "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app"
        )
        XCTAssertTrue(launcher.isLauncher)
        // A helper is a windowed app, not a command: it never becomes the actor.
        XCTAssertTrue(chain.hops.allSatisfy { !$0.isImportant })
    }

    func testTheTtyIsSaidOnceInAVSCodeTerminal() {
        let chain = builder(vsCodeTree).build(forPid: 300)

        XCTAssertEqual(chain.hops.map { $0.name }, ["Visual Studio Code", "zsh", "varlock"])
        // Was twice: once appended to the launcher's name, once in the session
        // root's own label. The launcher holds no controlling tty of its own.
        XCTAssertEqual(Self.terminalMentions(chain), ["Terminal ttys004"])
        XCTAssertEqual(chain.sessionRootHop?.name, "zsh")
        XCTAssertEqual(chain.sessionRootHop?.sessionRoot?.terminal, "Terminal ttys004")
    }

    func testEveryFlavourOfNestedHelperResolvesToItsOuterApp() {
        let cases: [(path: String, bundle: String, name: String)] = [
            (
                "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Renderer).app"
                    + "/Contents/MacOS/Cursor Helper (Renderer)",
                "/Applications/Cursor.app",
                "Cursor"
            ),
            (
                "/Users/dev/build/MyEditor.app/Contents/Frameworks/Electron Helper.app"
                    + "/Contents/MacOS/Electron Helper",
                "/Users/dev/build/MyEditor.app",
                "MyEditor"
            ),
        ]
        for testCase in cases {
            let chain = builder([
                FakeProc(pid: 100, ppid: 1, path: testCase.path),
                FakeProc(pid: 200, ppid: 100, tty: 16, path: "/bin/zsh"),
                FakeProc(pid: 300, ppid: 200, tty: 16, path: "/opt/homebrew/bin/varlock"),
            ]).build(forPid: 300)

            XCTAssertEqual(chain.hops[0].bundlePath, testCase.bundle, testCase.path)
            // The outer app may not be installed on the machine running this, so
            // the name falls back to the bundle's own file name, which is the
            // outer one either way.
            XCTAssertEqual(chain.hops[0].name, testCase.name, testCase.path)
            XCTAssertEqual(Self.terminalMentions(chain), ["Terminal ttys004"], testCase.path)
        }
    }

    func testAPlainAppIsUntouchedByTheWalkOutwards() {
        // One bundle in the path, so there is nothing to walk out to: the name
        // and the icon are read from exactly the bundle the process is in.
        for path in [
            "/Applications/iTerm.app/Contents/MacOS/iTerm2",
            "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
        ] {
            let chain = builder([
                FakeProc(pid: 100, ppid: 1, path: path),
                FakeProc(pid: 200, ppid: 100, tty: 16, path: "/bin/zsh"),
                FakeProc(pid: 300, ppid: 200, tty: 16, path: "/opt/homebrew/bin/varlock"),
            ]).build(forPid: 300)

            let expected = String(path[path.startIndex..<path.range(of: ".app/")!.lowerBound]) + ".app"
            XCTAssertEqual(chain.hops[0].bundlePath, expected)
            XCTAssertEqual(chain.hops[0].path, expected)
        }
    }

    func testTheFullerFormOfANameOnlyWinsWhenItIsTheSameName() {
        // "Visual Studio Code.app" carrying CFBundleName "Code": same name, more
        // of it, and the one Finder shows.
        XCTAssertTrue(ExecutionChainBuilder.isFullerForm("Visual Studio Code", of: "Code"))
        XCTAssertTrue(ExecutionChainBuilder.isFullerForm("Code Runner", of: "Code"))
        // A different name never loses to the file it happens to be stored in:
        // iTerm.app is called iTerm2 by the app itself.
        XCTAssertFalse(ExecutionChainBuilder.isFullerForm("iTerm", of: "iTerm2"))
        // Whole words only, so a name that merely contains the letters is not a
        // fuller form of anything.
        XCTAssertFalse(ExecutionChainBuilder.isFullerForm("Xcode", of: "code"))
        XCTAssertFalse(ExecutionChainBuilder.isFullerForm("Cursor", of: "Cursor"))
    }

    func testTheTtyIsSaidOnceInAnAgentChain() {
        let chain = builder(
            [
                FakeProc(pid: 100, ppid: 1, path: "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
                FakeProc(
                    pid: 150,
                    ppid: 100,
                    tty: 16,
                    startTime: 1_700_000_000,
                    path: "/Users/dev/.local/bin/claude"
                ),
                FakeProc(pid: 200, ppid: 150, tty: 16, path: "/bin/zsh"),
                FakeProc(pid: 300, ppid: 200, tty: 16, path: "/opt/homebrew/bin/varlock"),
            ],
            sessionMetadata: FakeSessionMetadata(records: [
                150: AgentSessionMetadata(title: "vault panel redesign", startTime: 1_700_000_042),
            ])
        ).build(forPid: 300)

        XCTAssertEqual(chain.sessionRootHop?.name, "claude")
        XCTAssertEqual(chain.agentSession?.title, "vault panel redesign")
        // The title says which conversation and the terminal says where it is
        // running. A title is not a substitute for the second: two sessions can
        // be called the same thing, and only one of them is on this tty.
        XCTAssertEqual(
            chain.sessionRootHop?.sessionRoot?.descriptionLine,
            "\u{201C}vault panel redesign\u{201D} \u{00B7} Terminal ttys004"
        )
        XCTAssertEqual(
            Self.terminalMentions(chain),
            ["\u{201C}vault panel redesign\u{201D} \u{00B7} Terminal ttys004"]
        )
    }

    func testASessionWithNoTitleIsStillNamedByItsTerminal() {
        let chain = builder(terminalTree).build(forPid: 300)
        XCTAssertEqual(chain.sessionRootHop?.sessionRoot?.descriptionLine, "Terminal ttys004")
        XCTAssertNil(chain.sessionRootHop?.sessionRoot?.quotedTitle)
    }

    func testASessionWithNoTerminalFallsBackToItsOwnName() {
        let chain = builder(
            [
                FakeProc(pid: 150, ppid: 1, startTime: 1_700_000_000, path: "/Users/dev/.local/bin/claude"),
                FakeProc(pid: 300, ppid: 150, path: "/opt/homebrew/bin/varlock"),
            ],
            sessionMetadata: FakeSessionMetadata(records: [
                150: AgentSessionMetadata(title: "nightly sweep", startTime: 1_700_000_042),
            ])
        ).build(forPid: 300)

        XCTAssertNil(chain.sessionRootHop?.sessionRoot?.terminal)
        // No tty to name, so the row falls back to the name this session goes by
        // in the menu bar. It never falls back to nothing.
        XCTAssertEqual(
            chain.sessionRootHop?.sessionRoot?.descriptionLine,
            "\u{201C}nightly sweep\u{201D} \u{00B7} Process 150"
        )
    }

    // MARK: - The script's own file

    /// A real directory with a real script in it, since resolving one means
    /// asking the file system whether it is there.
    private func scratchScript(named name: String) throws -> (directory: String, path: String) {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("chain-script-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent(name)
        FileManager.default.createFile(atPath: file.path, contents: Data("// script".utf8))
        // Resolved through the symlinks, because /var and /tmp are symlinks on
        // macOS and a package manager's `node_modules/.bin` entry is one too, so
        // the resolver follows them and a test has to compare what it produces.
        let resolved = (directory.path as NSString).resolvingSymlinksInPath
        return (resolved, (file.path as NSString).resolvingSymlinksInPath)
    }

    private func chainRunning(_ argument: String, in directory: String?, script: String) -> ExecutionChain {
        return builder([
            FakeProc(pid: 200, ppid: 1, path: "/bin/zsh"),
            FakeProc(
                pid: 300,
                ppid: 200,
                path: "/Users/dev/.bun/bin/bun",
                args: ["bun", "run", argument],
                cwd: directory
            ),
            FakeProc(pid: 400, ppid: 300, path: "/opt/homebrew/bin/varlock"),
        ]).build(forPid: 400)
    }

    func testAScriptGivenByAnAbsolutePathIsResolvedToItsFile() throws {
        let scratch = try scratchScript(named: "agent.ts")
        let chain = chainRunning(scratch.path, in: nil, script: scratch.path)

        let actor = chain.hops.first { $0.isImportant }
        XCTAssertEqual(actor?.name, "agent.ts")
        // The file itself, so the panel can ask the system what it looks like.
        // Asking about the extension instead would be asking an ambiguous
        // question: ".ts" is registered for MPEG transport streams too.
        XCTAssertEqual(actor?.scriptPath, scratch.path)
    }

    func testARelativeScriptIsResolvedAgainstTheProcessesOwnDirectory() throws {
        let scratch = try scratchScript(named: "agent.ts")
        let chain = chainRunning("./agent.ts", in: scratch.directory, script: scratch.path)

        XCTAssertEqual(chain.hops.first { $0.isImportant }?.scriptPath, scratch.path)
    }

    func testAScriptWithNoReadableDirectoryHasNoPathRatherThanAGuess() throws {
        let scratch = try scratchScript(named: "agent.ts")
        // The kernel would not say where this process was started, so a relative
        // argument names nothing we can point at. The panel draws a plain page.
        let chain = chainRunning("agent.ts", in: nil, script: scratch.path)

        let actor = chain.hops.first { $0.isImportant }
        XCTAssertEqual(actor?.name, "agent.ts")
        XCTAssertNil(actor?.scriptPath)
    }

    func testAScriptArgumentThatIsNotAFileResolvesToNothing() {
        let chain = chainRunning("/no/such/place/agent.ts", in: "/tmp", script: "")
        XCTAssertNil(chain.hops.first { $0.isImportant }?.scriptPath)
    }

    func testVarlocksOwnCliIsNeverTreatedAsSomebodysScript() throws {
        let scratch = try scratchScript(named: "varlock")
        let chain = builder([
            FakeProc(pid: 200, ppid: 1, path: "/bin/zsh"),
            FakeProc(
                pid: 300,
                ppid: 200,
                path: "/Users/dev/.bun/bin/bun",
                args: ["bunx", "varlock", "load"],
                cwd: scratch.directory
            ),
        ]).build(forPid: 300)

        // It is varlock, drawn with varlock's own mark, and not a third party's
        // file that happens to be sitting in the working directory.
        XCTAssertEqual(chain.hops.last?.name, "varlock")
        XCTAssertNil(chain.hops.last?.via)
        // The file IS resolved, though. It used to be skipped on the reasoning
        // that varlock does not need introducing to itself, which left the panel
        // unable to answer "which varlock is this" for a node_modules copy: the
        // whole question in the interpreted case.
        XCTAssertEqual(chain.hops.last?.scriptPath, scratch.path)
    }

    /// An installed npm package on disk, entered the way one really is:
    /// `<root>/node_modules/<directory>/bin/cli.js` with the package's manifest
    /// above it. `node_modules/.bin/<name>` is a symlink to that file, so what a
    /// runner hands the interpreter is this path, whose file name is `cli.js`
    /// and says nothing about which package it came from.
    private func installedPackage(
        manifestName: String,
        version: String = "1.17.1",
        directory: String = "varlock"
    ) throws -> String {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("chain-package-\(UUID().uuidString)")
        let packageRoot = root.appendingPathComponent("node_modules/\(directory)")
        try FileManager.default.createDirectory(
            at: packageRoot.appendingPathComponent("bin"),
            withIntermediateDirectories: true
        )
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let entry = packageRoot.appendingPathComponent("bin/cli.js")
        try Data("#!/usr/bin/env node\n".utf8).write(to: entry)
        try JSONSerialization
            .data(withJSONObject: ["name": manifestName, "version": version])
            .write(to: packageRoot.appendingPathComponent("package.json"))
        // /var and /tmp are symlinks on macOS and the resolver follows them, so
        // a test has to compare against what it will produce.
        return (entry.path as NSString).resolvingSymlinksInPath
    }

    /// `bunx varlock load` against an installed copy: bun with the resolved
    /// entry file in argv.
    private func bunxVarlockTree(entry: String) -> [FakeProc] {
        return [
            FakeProc(pid: 100, ppid: 1, path: "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
            FakeProc(pid: 200, ppid: 100, tty: 16, path: "/bin/zsh", args: ["-zsh"]),
            FakeProc(
                pid: 300,
                ppid: 200,
                tty: 16,
                path: "/Users/dev/.bun/bin/bun",
                args: ["bun", entry, "load"]
            ),
        ]
    }

    func testVarlocksVersionIsReadFromThePackageItCameOutOf() throws {
        let entry = try installedPackage(manifestName: "varlock", version: "1.17.1-dev")
        let chain = builder([
            FakeProc(pid: 200, ppid: 1, path: "/bin/zsh"),
            FakeProc(
                pid: 300,
                ppid: 200,
                path: "/Users/dev/.bun/bin/bun",
                args: ["bun", entry, "load"]
            ),
        ]).build(forPid: 300)

        // Read off disk by the daemon, so it is stated flatly. A build-type
        // suffix survives on purpose: a dev build is not the published artifact.
        XCTAssertEqual(chain.hops.last?.release, HopRelease(version: "1.17.1-dev", source: .readFromDisk))
        XCTAssertTrue(chain.hops.last?.release?.isPrerelease ?? false)
        XCTAssertEqual(chain.hops.last?.release?.displayValue, "1.17.1-dev")
        // The same manifest that gives the version gives the name. These two
        // used to be answered from different evidence, and the row read "cli.js"
        // with varlock's own version printed underneath it.
        XCTAssertEqual(chain.hops.last?.name, "varlock")
        // A version the client merely asserted always says who asserted it.
        XCTAssertEqual(
            HopRelease(version: "1.17.1", source: .clientReported).displayValue,
            "1.17.1 (reported by the caller)"
        )
    }

    func testAnInstalledVarlockIsRecognisedByThePackageItCameOutOf() throws {
        let entry = try installedPackage(manifestName: "varlock")
        let chain = builder(
            bunxVarlockTree(entry: entry),
            posture: FakePosture(facts: [300: Self.signed])
        ).build(forPid: 300)

        let hop = try XCTUnwrap(chain.hops.last)
        // `bunx varlock load` drew a row called "cli.js" and treated varlock as
        // somebody's stray node script. The file name is the one part of that
        // path that says nothing; the package it sits in says everything.
        XCTAssertEqual(hop.name, "varlock")
        XCTAssertTrue(hop.isVarlock)
        // Which is what puts varlock's own mark on the row rather than a
        // document icon, and what suppresses "via bun": bun is how varlock ships.
        XCTAssertNil(hop.via)
        // Normalised by varlock's own rule, so the line reads as the act a
        // person performed rather than as the file a runner resolved.
        XCTAssertEqual(hop.invocation, "varlock load")
        // varlock is never the actor. Nothing in this chain is bold, because the
        // values are for the command and the command is varlock itself.
        XCTAssertTrue(chain.hops.allSatisfy { !$0.isImportant })
        XCTAssertEqual(hop.release, HopRelease(version: "1.17.1", source: .readFromDisk))
        // And the row says which varlock this is, in words.
        XCTAssertEqual(hop.runtimeForm, "varlock's JavaScript, run by bun, not the standalone binary")
        XCTAssertTrue(hop.runtimeFormIsCaution)
    }

    func testRecognisingVarlockRestoresNoClaimAboutTheCodeItself() throws {
        let entry = try installedPackage(manifestName: "varlock")
        let chain = builder(
            bunxVarlockTree(entry: entry),
            posture: FakePosture(facts: [300: Self.signed])
        ).build(forPid: 300)

        let hop = try XCTUnwrap(chain.hops.last)
        // Knowing WHICH package these files came out of says nothing about
        // whether anyone signed them. They are ordinary JavaScript any process
        // running as the user can rewrite, and calling the row varlock must
        // never be a route back to a green shield on unsigned code.
        XCTAssertEqual(hop.posture, .interpretedScript)
        XCTAssertEqual(hop.interpreterName, "bun")
        XCTAssertEqual(hop.interpreterPosture, .signedHardened)

        let evidence = hop.evidence
        XCTAssertEqual(evidence.map(\.label), ["program", "interpreter", "version"])
        // The signature is stated beside the name of what it is a signature of,
        // and nowhere else. The program line carries no posture at all.
        XCTAssertEqual(evidence[0].value, entry)
        XCTAssertNil(evidence[0].posture)
        XCTAssertEqual(evidence[1].posture, .signedHardened)
        XCTAssertEqual(evidence[1].postureSubject, "\u{201C}bun\u{201D}")
    }

    func testAScriptFromSomebodyElsesPackageIsNotVarlock() throws {
        // The same shape exactly, down to the `bin/cli.js`, with a manifest that
        // says something else. Nothing about the path is evidence; the name in
        // the manifest is the whole test.
        let entry = try installedPackage(manifestName: "helpful-tools", directory: "helpful-tools")
        let chain = builder(
            bunxVarlockTree(entry: entry),
            posture: FakePosture(facts: [300: Self.signed])
        ).build(forPid: 300)

        let hop = try XCTUnwrap(chain.hops.last)
        XCTAssertEqual(hop.name, "cli.js")
        XCTAssertFalse(hop.isVarlock)
        XCTAssertEqual(hop.via, "via bun")
        // A third party's script IS the actor: it is what the values are for.
        XCTAssertTrue(hop.isImportant)
        XCTAssertEqual(hop.invocation, "cli.js load")
        XCTAssertEqual(
            hop.advisory,
            "a script run by bun: approval trusts this file, not the signed interpreter"
        )
        // Neither varlock's version line nor varlock's runtime line is drawn for
        // somebody else's package.
        XCTAssertNil(hop.release)
        XCTAssertNil(hop.runtimeForm)
        XCTAssertEqual(hop.posture, .interpretedScript)
    }

    func testAThirdPartyScriptWithNoPackageAroundItIsUnchanged() throws {
        let scratch = try scratchScript(named: "agent.ts")
        let chain = builder([
            FakeProc(pid: 200, ppid: 1, path: "/bin/zsh"),
            FakeProc(
                pid: 300,
                ppid: 200,
                path: "/usr/local/bin/node",
                args: ["node", scratch.path]
            ),
        ], posture: FakePosture(facts: [300: Self.signed])).build(forPid: 300)

        let hop = try XCTUnwrap(chain.hops.last)
        // No manifest anywhere above it, so the walk finds nothing and the hop
        // is what it always was: the bold actor, named after its own file.
        XCTAssertEqual(hop.name, "agent.ts")
        XCTAssertTrue(hop.isImportant)
        XCTAssertEqual(hop.via, "via node")
        XCTAssertEqual(hop.posture, .interpretedScript)
        XCTAssertNil(hop.release)
        XCTAssertNil(hop.runtimeForm)
    }

    func testTheCompiledBinaryHasNoPackageVersionToRead() {
        let chain = builder(terminalTree).build(forPid: 300)
        // Nothing is invented for it. The panel falls back to what the client
        // said and labels it, rather than the chain making something up.
        XCTAssertNil(chain.hops.last?.release)
        // A `varlock load` typed against the compiled binary is untouched by any
        // of this: no script to resolve, no package to read, and the name was
        // never in doubt.
        XCTAssertEqual(chain.hops.last?.name, "varlock")
        XCTAssertTrue(chain.hops.last?.isVarlock ?? false)
        XCTAssertNil(chain.hops.last?.interpreterName)
        XCTAssertEqual(chain.hops.last?.runtimeForm, "the standalone varlock binary")
    }

    func testEvidenceNamesTheProgramTheInterpreterAndTheVersion() throws {
        let scratch = try scratchScript(named: "varlock")
        let chain = builder([
            FakeProc(pid: 200, ppid: 1, path: "/bin/zsh"),
            FakeProc(
                pid: 300,
                ppid: 200,
                path: "/Users/dev/.bun/bin/bun",
                args: ["bun", scratch.path, "load"]
            ),
        ], posture: FakePosture(facts: [300: Self.signed])).build(forPid: 300)

        let evidence = try XCTUnwrap(chain.hops.last).evidence
        XCTAssertEqual(evidence.map(\.label), ["program", "interpreter"])
        XCTAssertEqual(evidence[0].value, scratch.path)
        XCTAssertTrue(evidence[0].isPath)
        // The signature rides on the interpreter's own line and nowhere else.
        XCTAssertNil(evidence[0].posture)
        XCTAssertEqual(evidence[1].value, "/Users/dev/.bun/bin/bun")
        XCTAssertEqual(evidence[1].posture, .signedHardened)
        XCTAssertEqual(evidence[1].postureSubject, "\u{201C}bun\u{201D}")
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
