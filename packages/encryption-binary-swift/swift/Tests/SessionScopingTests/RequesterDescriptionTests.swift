import XCTest
@testable import SessionScoping

/// The lines the approval panel treats as trustworthy.
///
/// They are only worth trusting if they come off the process tree, so these run
/// the describer against synthetic trees rather than whatever happens to be
/// running on the test machine.
final class RequesterDescriptionTests: XCTestCase {

    private func describe(_ procs: [FakeProc], ttyNames: [dev_t: String] = [:], pid: pid_t) -> RequesterDescription {
        return RequesterDescriber(provider: FakeProcessProvider(procs, ttyNames: ttyNames)).describe(forPid: pid)
    }

    func testChainReadsFromTheCallerOutward() {
        let description = describe([
            FakeProc(pid: 100, ppid: 200, tty: 16, path: "/usr/local/bin/node"),
            FakeProc(pid: 200, ppid: 300, tty: 16, path: "/opt/homebrew/bin/claude"),
            FakeProc(pid: 300, ppid: 1, tty: 16, path: "/bin/zsh"),
        ], ttyNames: [16: "ttys004"], pid: 100)

        XCTAssertEqual(description.processChain, ["node", "claude", "zsh"])
        XCTAssertEqual(description.chainSummary, "node ← claude ← zsh")
        XCTAssertEqual(description.terminalName, "ttys004")
        XCTAssertEqual(description.sessionSummary, "Terminal ttys004")
        XCTAssertEqual(description.panelLines, ["Requested by node ← claude ← zsh", "Terminal ttys004"])
    }

    func testNoTerminalSaysSoRatherThanGuessing() {
        let description = describe([
            FakeProc(pid: 100, ppid: 200, path: "/usr/local/bin/node"),
            FakeProc(pid: 200, ppid: 1, path: "/Applications/Cursor.app/Contents/MacOS/Cursor"),
        ], pid: 100)

        XCTAssertNil(description.terminalName)
        XCTAssertEqual(description.sessionSummary, "No terminal (background process)")
        XCTAssertEqual(description.processChain, ["node", "Cursor"])
    }

    func testChainStopsBeforeLaunchd() {
        let description = describe([
            FakeProc(pid: 100, ppid: 200, path: "/bin/varlock"),
            FakeProc(pid: 200, ppid: 1, path: "/bin/zsh"),
            FakeProc(pid: 1, ppid: 0, path: "/sbin/launchd"),
        ], pid: 100)
        XCTAssertEqual(description.processChain, ["varlock", "zsh"])
    }

    func testChainIsBounded() {
        var procs: [FakeProc] = []
        for index in 0..<20 {
            procs.append(FakeProc(pid: pid_t(100 + index), ppid: pid_t(101 + index), path: "/bin/proc\(index)"))
        }
        let description = describe(procs, pid: 100)
        XCTAssertEqual(description.processChain.count, RequesterDescriber.maxChainLength)
    }

    func testRepeatedWrapperNamesAreCollapsed() {
        let description = describe([
            FakeProc(pid: 100, ppid: 200, path: "/bin/zsh"),
            FakeProc(pid: 200, ppid: 300, path: "/bin/zsh"),
            FakeProc(pid: 300, ppid: 1, path: "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
        ], pid: 100)
        XCTAssertEqual(description.processChain, ["zsh", "iTerm2"])
    }

    func testUnknownProcessStillProducesUsableLines() {
        let description = describe([], pid: 999)
        XCTAssertEqual(description.chainSummary, "unknown process")
        XCTAssertEqual(description.panelLines.count, 2)
    }

    func testTerminalIsTakenFromTheNearestProcessThatHasOne() {
        let description = describe([
            FakeProc(pid: 100, ppid: 200, path: "/bin/node"),
            FakeProc(pid: 200, ppid: 1, tty: 21, path: "/bin/zsh"),
        ], ttyNames: [21: "ttys009"], pid: 100)
        XCTAssertEqual(description.terminalName, "ttys009")
    }
}
