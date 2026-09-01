import Foundation

/// What of a varlock command line is worth putting on the panel.
///
/// The whole line is read from the kernel's copy of the process's argv, so all of
/// it is trustworthy. Not all of it is useful, and a line nobody reads protects
/// nobody, so this keeps the parts that change what is being asked for and drops
/// the parts that only change how the answer is printed:
///
///   ALWAYS the subcommand. "varlock" on its own says nothing; `varlock run` and
///   `varlock encrypt` are different requests.
///
///   KEEP what changes the trust picture: everything after `--` (the command that
///   will receive the values), which environment was selected, which env files
///   were named, and any filter narrowing what is loaded. Anything unrecognised
///   is kept too: silence about a flag we do not know is the wrong default when
///   the point of the line is to be evidence.
///
///   DROP presentation: output format, compactness, cache behaviour, verbosity,
///   colour. None of it changes which secrets go where.
///
/// Length is handled by eliding the MIDDLE rather than the tail, so
/// `varlock run -- npm run build` never loses the half that says who is being
/// handed the values.
public enum VarlockInvocation {
    /// Flags that carry no argument and say nothing about what is being asked
    /// for.
    static let droppedFlags: Set<String> = [
        "--agent", "--compact", "--show-all", "--include-internal", "--summary-stderr",
        "--clear-cache", "--skip-cache", "--cached", "--quiet", "--silent", "--verbose",
        "-v", "--color", "--no-color", "--json", "--pretty",
    ]

    /// Flags whose following token is their value, dropped as a pair.
    static let droppedFlagsWithValue: Set<String> = [
        "--format", "-f", "--summary-file", "--log-level",
    ]

    /// Trim a normalised varlock command line ("varlock", subcommand, args...).
    ///
    /// Only ever called on a line that already starts at `varlock`; the caller
    /// does that rewrite, since `bunx varlock load` and
    /// `/opt/homebrew/bin/varlock load` are the same act said three ways.
    public static func trimmed(_ tokens: [String]) -> [String] {
        var kept: [String] = []
        var index = 0
        while index < tokens.count {
            let token = tokens[index]
            // Everything past `--` belongs to the command being run, and none of
            // it is ours to judge.
            if token == "--" {
                kept.append(contentsOf: tokens[index...])
                break
            }
            let flag = token.split(separator: "=", maxSplits: 1).first.map(String.init) ?? token
            if droppedFlagsWithValue.contains(flag) {
                // "--format json" takes the next token with it; "--format=json"
                // carries its value already.
                index += token.contains("=") ? 1 : 2
                continue
            }
            if droppedFlags.contains(flag) {
                index += 1
                continue
            }
            kept.append(token)
            index += 1
        }
        return kept
    }

    /// The command a `varlock run` will start and hand the values to.
    ///
    /// That process does not exist yet, so it is in no chain and no ancestry. A
    /// panel that stopped at varlock would imply the values stop there too.
    public static func runTarget(_ tokens: [String]) -> String? {
        guard tokens.first == "varlock" else { return nil }
        guard let separator = tokens.firstIndex(of: "--") else { return nil }
        let target = tokens[tokens.index(after: separator)...]
        guard !target.isEmpty else { return nil }
        return target.joined(separator: " ")
    }

    /// Join a command line to fit, keeping the head and the `--` target.
    ///
    /// A tail truncation would cut off exactly the part worth reading, since the
    /// target is always last.
    public static func fit(_ tokens: [String], limit: Int) -> String {
        let line = tokens.joined(separator: " ")
        guard line.count > limit else { return line }

        guard let separator = tokens.firstIndex(of: "--") else {
            return String(line.prefix(limit - 1)) + "\u{2026}"
        }
        let head = tokens[..<separator].joined(separator: " ")
        let tail = tokens[separator...].joined(separator: " ")
        // Two things have to survive: enough of the head to name the subcommand,
        // and the target. When even that does not fit, the target is the half
        // that gets the room.
        let ellipsis = " \u{2026} "
        let headBudget = max(limit - tail.count - ellipsis.count, "varlock run".count)
        let shortHead = head.count > headBudget ? String(head.prefix(headBudget - 1)) + "\u{2026}" : head
        let joined = shortHead + ellipsis + tail
        guard joined.count > limit else { return joined }
        return String(joined.prefix(limit - 1)) + "\u{2026}"
    }
}
