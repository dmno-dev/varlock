import Foundation
import SessionScoping

/// How varlock came to be running, said plainly and always on screen.
///
/// Two situations that look alike on a panel are materially different: a person
/// typing `varlock load`, and some program loading varlock as it starts. In the
/// first the user is the one asking. In the second a build tool, a dev server, or
/// a test runner is, and the values are for that program. Leaving the reader to
/// infer which one they are in is leaving out the thing they most need.
///
/// The two halves of this have different standing, and the wording keeps them
/// apart:
///
///   - the COMMAND LINES are read from the kernel's copy of each process's argv.
///     Nothing the client sent can change them.
///   - the MODE (cli, auto-load, sdk) is client-reported over the socket, because
///     from inside a spawned CLI an auto-load and a typed command are the same
///     process with the same arguments. It is a claim, not a measurement.
///
/// Where the claim contradicts what the chain plainly shows, the chain wins and
/// the disagreement is recorded. A claim that cannot be checked is used as given;
/// one that can be, is.
public struct InvocationNote: Equatable {
    public enum Kind: Equatable {
        /// A person typed a varlock command. The string is that command line.
        case typed(String)
        /// varlock was loaded inside a host program, named by its own command.
        case hosted(String)
        /// Nothing could be read off the peer, so the panel says nothing rather
        /// than guessing.
        case unknown
    }

    public let kind: Kind
    /// For `varlock run`, the command that will be started and handed the values.
    public let target: String?
    /// Set when the client's claimed mode was overruled by the chain. For the
    /// debug log, never for the panel: the user gets the conclusion, not the
    /// argument.
    public let disagreement: String?

    public init(kind: Kind, target: String? = nil, disagreement: String? = nil) {
        self.kind = kind
        self.target = target
        self.disagreement = disagreement
    }

    /// The lines the panel draws under the varlock hop, in order.
    ///
    /// Always visible. This is not detail for whoever opens the chain; it is the
    /// answer to "what is this request", and the `$` is what says a person typed
    /// it.
    public var lines: [String] {
        switch kind {
        case .typed(let command):
            var lines = ["$ \(command)"]
            if let target {
                // The values do not stop at varlock: this command starts another
                // one and hands them over. That process is in no chain, because
                // it does not exist yet.
                lines.append("\u{21B3} \(target) receives these values")
            }
            return lines
        case .hosted(let host):
            return ["auto-loaded inside \(host)"]
        case .unknown:
            return []
        }
    }
}

public enum InvocationEvidence {
    /// What to say about this request, from the chain and the client's claim.
    public static func note(chain: ExecutionChain, claimed: UnlockInvocationMode?) -> InvocationNote {
        guard let requester = chain.hops.first(where: { $0.isRequester }) else {
            return InvocationNote(kind: .unknown)
        }

        // A shell on the other end of the socket is not a shape this daemon
        // speaks to: the peer is varlock's CLI or a program embedding it. Rather
        // than narrate a chain that cannot be right (a preview pointed at some
        // other pid, say), say nothing.
        guard !requester.isShell else {
            return InvocationNote(kind: .unknown)
        }

        // varlock running inside somebody else's process. Nobody typed that,
        // whatever the client said, and the command worth showing is the host's
        // own, which is the process on the other end of the socket.
        guard requester.isVarlock else {
            let disagreement = claimed == .cli
                ? "client claimed cli, but the peer is \(requester.name) rather than varlock's CLI"
                : nil
            guard let host = requester.invocation else {
                return InvocationNote(kind: .unknown, disagreement: disagreement)
            }
            return InvocationNote(kind: .hosted(host), disagreement: disagreement)
        }

        let typed = requester.invocation.map { InvocationNote.Kind.typed($0) } ?? .unknown
        guard let claimed, claimed.isHosted else {
            return InvocationNote(kind: typed, target: requester.runTarget)
        }
        if let host = chain.hostProgram?.invocation {
            return InvocationNote(kind: .hosted(host))
        }
        // Claimed as loaded by something, with nothing above the CLI that could
        // have loaded it. The chain is the better witness.
        return InvocationNote(
            kind: typed,
            target: requester.runTarget,
            disagreement: "client claimed \(claimed.rawValue), but nothing above the CLI could have loaded it"
        )
    }
}
