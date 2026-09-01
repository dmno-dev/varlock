import Foundation

/// Turns a session identifier back into something a person recognises.
///
/// Session ids are built to be stable and unforgeable, not readable: they carry
/// device numbers, start timestamps, and session UUIDs. The menu bar has to name
/// a session in a few words, so this reads the shapes `SessionScoper` produces
/// and says what each one is, dropping the parts that only exist to make the id
/// unique. The env-var forms deliberately lose their value: it identifies an
/// agent session and has no business being on screen.
public enum SessionLabel {
    /// A short name for one session, or a truncated id when the shape is unknown.
    public static func describe(sessionId: String) -> String {
        // "env:KEY:value|<anchor>": the anchor is the interesting half.
        if sessionId.hasPrefix("env:") {
            let parts = sessionId.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
            let envKey = envKeyName(String(parts[0]))
            if parts.count == 2, !parts[1].isEmpty {
                return "\(describe(sessionId: String(parts[1]))), \(envKey)"
            }
            return envKey
        }

        if let terminal = terminal(sessionId: sessionId) { return terminal }

        let fields = sessionId.split(separator: ":", omittingEmptySubsequences: false)
        switch fields.first {
        case "ptree":
            guard fields.count >= 2, !fields[1].isEmpty else { break }
            return "Process \(fields[1])"
        default:
            break
        }

        return truncated(sessionId)
    }

    /// The terminal a session is on, when it is on one: "Terminal ttys004", or
    /// "Terminal ttys005 (tmux)" inside a multiplexer.
    ///
    /// A tty id is stated exactly once in the panel, on the session-root row,
    /// and this is where that text comes from: read back out of the identifier
    /// the grant is keyed by, so the row a person reads and the session a grant
    /// attaches to can never name two different terminals.
    public static func terminal(sessionId: String) -> String? {
        // "env:KEY:value|<anchor>": the terminal, if any, is in the anchor half.
        if sessionId.hasPrefix("env:") {
            let parts = sessionId.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2, !parts[1].isEmpty else { return nil }
            return terminal(sessionId: String(parts[1]))
        }

        let fields = sessionId.split(separator: ":", omittingEmptySubsequences: false)
        guard fields.first == "tty", fields.count >= 2, !fields[1].isEmpty else { return nil }
        // A fourth field is the multiplexer signal, "TMUX=<socket>,<pid>,<id>".
        if fields.count >= 4, let multiplexer = multiplexerName(String(fields[3])) {
            return "Terminal \(fields[1]) (\(multiplexer))"
        }
        return "Terminal \(fields[1])"
    }

    /// "env:CLAUDE_CODE_SESSION_ID:abc123" -> "Claude Code session".
    private static func envKeyName(_ field: String) -> String {
        let parts = field.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count >= 2 else { return "agent session" }
        switch parts[1] {
        case "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID": return "Claude Code session"
        case "CODEX_THREAD_ID": return "Codex session"
        default: return "agent session"
        }
    }

    /// "TMUX=/private/tmp/tmux-501/default,123,0" -> "tmux".
    private static func multiplexerName(_ field: String) -> String? {
        guard let key = field.split(separator: "=", maxSplits: 1).first else { return nil }
        switch key {
        case "TMUX": return "tmux"
        case "STY": return "screen"
        case "ZELLIJ", "ZELLIJ_SESSION_NAME": return "zellij"
        default: return nil
        }
    }

    private static func truncated(_ sessionId: String, limit: Int = 28) -> String {
        guard sessionId.count > limit else { return sessionId }
        return String(sessionId.prefix(limit)) + "..."
    }
}
