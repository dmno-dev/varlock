import Foundation
import Darwin

/// A plain-language description of the process that is asking for something.
///
/// This is the trust-bearing half of an approval panel: every line here is read
/// off the peer process by the daemon itself, so a caller cannot dress itself up
/// as something else. It goes through the same `ProcessProvider` abstraction as
/// session scoping, so it is testable against synthetic process trees.
public struct RequesterDescription: Equatable {
    /// Executable names from the connecting process outward, nearest first.
    public let processChain: [String]
    /// Controlling terminal device name, when there is one.
    public let terminalName: String?

    public init(processChain: [String], terminalName: String?) {
        self.processChain = processChain
        self.terminalName = terminalName
    }

    /// "node ← claude ← zsh", or a fallback when nothing could be read.
    public var chainSummary: String {
        return processChain.isEmpty ? "unknown process" : processChain.joined(separator: " ← ")
    }

    /// "Terminal ttys004" or "No terminal (background process)".
    public var sessionSummary: String {
        guard let terminalName else { return "No terminal (background process)" }
        return "Terminal \(terminalName)"
    }

    /// The lines a panel shows, most specific first.
    public var panelLines: [String] {
        return ["Requested by \(chainSummary)", sessionSummary]
    }

    /// The same facts on one line, for the authorization log:
    /// "node ← claude ← zsh (ttys004)".
    public var auditSummary: String {
        guard let terminalName else { return chainSummary }
        return "\(chainSummary) (\(terminalName))"
    }
}

public struct RequesterDescriber {
    /// How far up the tree to look. Deep enough to reach the app or shell that
    /// started things, short enough to stay readable on a panel.
    public static let maxChainLength = 5

    private let provider: ProcessProvider

    public init(provider: ProcessProvider) {
        self.provider = provider
    }

    public func describe(forPid pid: pid_t) -> RequesterDescription {
        var names: [String] = []
        var current = pid
        var terminal: String?

        for _ in 0..<Self.maxChainLength {
            guard let info = provider.info(for: current) else { break }
            if terminal == nil, info.tty > 0 {
                terminal = provider.ttyName(forDevice: info.tty)
            }
            if let name = processName(current) {
                // Collapse a repeated wrapper (a shell exec'ing a shell) so the
                // line says something rather than repeating itself.
                if names.last != name { names.append(name) }
            }
            guard let ppid = provider.info(for: current)?.ppid, ppid > 1 else { break }
            current = ppid
        }

        return RequesterDescription(processChain: names, terminalName: terminal)
    }

    private func processName(_ pid: pid_t) -> String? {
        guard let path = provider.path(for: pid) else { return nil }
        let name = (path as NSString).lastPathComponent
        return name.isEmpty ? nil : name
    }
}

/// Convenience wrapper using the live, OS-backed provider.
public func describeRequester(forPid pid: pid_t) -> RequesterDescription {
    return RequesterDescriber(provider: LiveProcessProvider()).describe(forPid: pid)
}
