import XCTest
@testable import IdentitySessions
import SessionScoping

/// What the panel says about how varlock came to be running.
///
/// The command lines are the kernel's and the mode is the client's, and these
/// pin down what happens when the two tell different stories: the kernel wins,
/// and the disagreement is written down rather than smoothed over.
final class InvocationEvidenceTests: XCTestCase {
    private func chain(_ hops: [ExecutionHop]) -> ExecutionChain {
        return ExecutionChain(hops: hops)
    }

    private func varlockHop(invocation: String, runTarget: String? = nil) -> ExecutionHop {
        return ExecutionHop(
            pid: 400,
            name: "varlock",
            invocation: invocation,
            runTarget: runTarget,
            isRequester: true
        )
    }

    func testATypedCommandIsShownAsOne() {
        let note = InvocationEvidence.note(
            chain: chain([
                ExecutionHop(pid: 200, name: "zsh", invocation: "-zsh"),
                varlockHop(invocation: "varlock load"),
            ]),
            claimed: .cli
        )

        XCTAssertEqual(note.kind, .typed("varlock load"))
        XCTAssertEqual(note.lines, ["$ varlock load"])
        XCTAssertNil(note.disagreement)
    }

    func testARunSaysWhichCommandReceivesTheValues() {
        let note = InvocationEvidence.note(
            chain: chain([varlockHop(invocation: "varlock run -- npm run build", runTarget: "npm run build")]),
            claimed: .cli
        )

        XCTAssertEqual(note.target, "npm run build")
        XCTAssertEqual(note.lines, [
            "$ varlock run -- npm run build",
            "\u{21B3} npm run build receives these values",
        ])
    }

    func testAnAutoLoadNamesTheHostCommand() {
        let note = InvocationEvidence.note(
            chain: chain([
                ExecutionHop(pid: 200, name: "zsh", invocation: "-zsh"),
                ExecutionHop(pid: 300, name: "next", invocation: "next dev"),
                varlockHop(invocation: "varlock load"),
            ]),
            claimed: .autoLoad
        )

        // varlock's own line here is a command nobody typed, so the host's is the
        // one worth showing.
        XCTAssertEqual(note.kind, .hosted("next dev"))
        XCTAssertEqual(note.lines, ["auto-loaded inside next dev"])
        XCTAssertNil(note.disagreement)
    }

    func testALibraryInsideAHostIsHostedWhateverTheClientClaims() {
        // The peer is not varlock's CLI at all, so nobody typed varlock here.
        let note = InvocationEvidence.note(
            chain: chain([
                ExecutionHop(pid: 200, name: "zsh", invocation: "-zsh"),
                ExecutionHop(pid: 300, name: "vite.js", invocation: "vite dev", isRequester: true),
            ]),
            claimed: .cli
        )

        XCTAssertEqual(note.kind, .hosted("vite dev"))
        XCTAssertEqual(note.disagreement, "client claimed cli, but the peer is vite.js rather than varlock's CLI")
    }

    func testAnAutoLoadClaimWithNothingAboveItIsOverruled() {
        // A claim that cannot be true: the CLI's parent is a shell, so there is
        // no program that could have loaded it.
        let note = InvocationEvidence.note(
            chain: chain([
                ExecutionHop(pid: 100, name: "iTerm2", isLauncher: true),
                ExecutionHop(pid: 200, name: "zsh", invocation: "-zsh"),
                varlockHop(invocation: "varlock load"),
            ]),
            claimed: .autoLoad
        )

        XCTAssertEqual(note.kind, .typed("varlock load"))
        XCTAssertEqual(
            note.disagreement,
            "client claimed auto-load, but nothing above the CLI could have loaded it"
        )
    }

    func testNothingIsSaidWhenNothingCouldBeRead() {
        let note = InvocationEvidence.note(chain: .empty, claimed: .cli)
        XCTAssertEqual(note.kind, .unknown)
        XCTAssertTrue(note.lines.isEmpty)
    }

    func testAMissingClaimIsTreatedAsTyped() {
        // No mode reported at all: the kernel shows a varlock CLI, and inventing
        // a host it never named would be worse than saying what is there.
        let note = InvocationEvidence.note(
            chain: chain([varlockHop(invocation: "varlock load")]),
            claimed: nil
        )
        XCTAssertEqual(note.kind, .typed("varlock load"))
        XCTAssertNil(note.disagreement)
    }
}
