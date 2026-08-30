import Foundation

/// The `request-approval` op: ask the user to approve something, and report what
/// they said.
///
/// No key operation is attached and nothing is recorded. The caller (the proxy,
/// today) keeps its own record of what it was allowed to do, keyed by whatever
/// makes sense to it. All this op does is put a question on the trusted display
/// and hand back the answer, which keeps it usable for surfaces that have nothing
/// to do with encryption keys.
public struct ApprovalRequest: Equatable {
    public let title: String
    public let descriptionLines: [String]
    public let allowedScopes: [SessionGrantScope]
    public let defaultScope: SessionGrantScope
    /// Client-supplied context lines, drawn as secondary under the derived ones.
    public let clientContextLines: [String]
    /// Run a user-presence check after the approve click, on top of the panel.
    public let requireBiometric: Bool
    public let confirmButtonTitle: String

    public init(
        title: String,
        descriptionLines: [String],
        allowedScopes: [SessionGrantScope],
        defaultScope: SessionGrantScope,
        clientContextLines: [String] = [],
        requireBiometric: Bool = false,
        confirmButtonTitle: String = "Approve"
    ) {
        self.title = title
        self.descriptionLines = descriptionLines
        self.allowedScopes = allowedScopes
        self.defaultScope = defaultScope
        self.clientContextLines = clientContextLines
        self.requireBiometric = requireBiometric
        self.confirmButtonTitle = confirmButtonTitle
    }

    public enum ParseError: LocalizedError, Equatable {
        case missingTitle
        case noUsableScopes

        public var errorDescription: String? {
            switch self {
            case .missingTitle:
                return "An approval request needs a title"
            case .noUsableScopes:
                return "An approval request needs at least one of the scopes: once, session, duration"
            }
        }

        public var code: String {
            switch self {
            case .missingTitle: return "APPROVAL_MISSING_TITLE"
            case .noUsableScopes: return "APPROVAL_NO_SCOPES"
            }
        }
    }

    /// Caps on what a caller can put on the trusted display. A request that wants
    /// more than this is trimmed, not refused: the panel stays readable and the
    /// derived lines stay on screen.
    public static let maxTitleLength = 80
    public static let maxLineLength = 160
    public static let maxDescriptionLines = 6
    public static let maxContextLines = 4

    /// Read a `request-approval` payload off the wire.
    public static func from(payload: [String: Any]?) throws -> ApprovalRequest {
        guard let payload else { throw ParseError.missingTitle }
        guard let title = clean(payload["title"], limit: maxTitleLength) else {
            throw ParseError.missingTitle
        }

        let description = cleanList(payload["descriptionLines"], limit: maxDescriptionLines)
        let context = cleanList(payload["contextLines"], limit: maxContextLines)

        var scopes: [SessionGrantScope] = []
        if let raw = payload["allowedScopes"] as? [String] {
            // Keep the canonical order rather than the caller's, so the panel's
            // buttons never move around between requests.
            scopes = UnlockPlanner.fullScopes.filter { raw.contains($0.rawValue) }
            guard !scopes.isEmpty else { throw ParseError.noUsableScopes }
        } else {
            scopes = [.once]
        }

        let requestedDefault = SessionGrantScope(wireValue: payload["defaultScope"] as? String)
        let defaultScope = requestedDefault.flatMap { scopes.contains($0) ? $0 : nil } ?? scopes[0]

        return ApprovalRequest(
            title: title,
            descriptionLines: description,
            allowedScopes: scopes,
            defaultScope: defaultScope,
            clientContextLines: context,
            requireBiometric: (payload["requireBiometric"] as? NSNumber)?.boolValue ?? false,
            confirmButtonTitle: clean(payload["confirmLabel"], limit: 24) ?? "Approve"
        )
    }

    /// Panel content for this request. The derived lines are passed in by the
    /// daemon, which is the only side that can work them out.
    public func panelContent(requesterLines: [String]) -> PanelContent {
        var context: [PanelContextLine] = requesterLines.map { .derived($0) }
        context.append(contentsOf: clientContextLines.map { .clientSupplied($0) })
        return PanelContent(
            title: title,
            subtitle: descriptionLines.isEmpty ? nil : descriptionLines.joined(separator: "\n"),
            contextLines: context,
            itemGroups: [],
            scopes: allowedScopes,
            defaultScope: defaultScope,
            confirmButtonTitle: confirmButtonTitle
        )
    }

    static func clean(_ value: Any?, limit: Int) -> String? {
        guard let text = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            return nil
        }
        let flattened = text.components(separatedBy: .newlines).joined(separator: " ")
        return String(flattened.prefix(limit))
    }

    static func cleanList(_ value: Any?, limit: Int) -> [String] {
        guard let raw = value as? [Any] else { return [] }
        return raw.compactMap { clean($0, limit: maxLineLength) }.prefix(limit).map { $0 }
    }
}

/// The answer, as it goes back over the wire.
public struct ApprovalOutcome: Equatable {
    public let approved: Bool
    public let scope: SessionGrantScope
    public let durationMs: Int64?

    public init(approved: Bool, scope: SessionGrantScope, durationMs: Int64? = nil) {
        self.approved = approved
        self.scope = scope
        self.durationMs = durationMs
    }

    public init(decision: PanelDecision) {
        self.init(approved: decision.approved, scope: decision.scope, durationMs: decision.durationMs)
    }

    public func toDictionary() -> [String: Any] {
        var dict: [String: Any] = [
            "decision": approved ? "approved" : "denied",
            "scope": scope.rawValue,
        ]
        if approved, let durationMs, scope == .duration {
            dict["durationMs"] = durationMs
        }
        return dict
    }
}
