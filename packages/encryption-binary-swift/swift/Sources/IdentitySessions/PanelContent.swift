import Foundation

/// What the approval panel says, as data.
///
/// The daemon is the trusted display here, so the wording is decided in this
/// process and never taken from the caller verbatim. Splitting the content from
/// the AppKit view means the copy, the grouping, and the scope choices can all be
/// asserted in tests that never open a window.

/// One line of context about who is asking.
///
/// `derived` lines are facts the daemon read off the peer process itself, so they
/// are the ones a user can rely on. `clientSupplied` lines came over the socket
/// from the connecting varlock process: the peer is code-signature checked, but
/// the content is still decoration and is shown as secondary.
public enum PanelContextLine: Equatable {
    case derived(String)
    case clientSupplied(String)

    public var text: String {
        switch self {
        case .derived(let text), .clientSupplied(let text): return text
        }
    }

    public var isDerived: Bool {
        if case .derived = self { return true }
        return false
    }
}

/// A named group of things the approval covers (key ids, and whatever a generic
/// approval wants to list).
public struct PanelItemGroup: Equatable {
    /// nil for the main group, set for the "asks every time" group
    public let heading: String?
    public let items: [PanelItem]

    public init(heading: String?, items: [PanelItem]) {
        self.heading = heading
        self.items = items
    }
}

public struct PanelItem: Equatable {
    public let label: String
    /// e.g. "12 items". Client-supplied, so it is drawn as secondary detail.
    public let detail: String?

    public init(label: String, detail: String? = nil) {
        self.label = label
        self.detail = detail
    }
}

/// Everything the panel needs to draw itself and to report a decision.
public struct PanelContent: Equatable {
    public let title: String
    public let subtitle: String?
    /// Trust-bearing lines first, client-supplied decoration after.
    public let contextLines: [PanelContextLine]
    public let itemGroups: [PanelItemGroup]
    public let scopes: [SessionGrantScope]
    public let defaultScope: SessionGrantScope
    public let confirmButtonTitle: String
    public let cancelButtonTitle: String

    public init(
        title: String,
        subtitle: String? = nil,
        contextLines: [PanelContextLine] = [],
        itemGroups: [PanelItemGroup] = [],
        scopes: [SessionGrantScope],
        defaultScope: SessionGrantScope,
        confirmButtonTitle: String,
        cancelButtonTitle: String = "Cancel"
    ) {
        self.title = title
        self.subtitle = subtitle
        self.contextLines = contextLines
        self.itemGroups = itemGroups
        self.scopes = scopes
        self.defaultScope = defaultScope
        self.confirmButtonTitle = confirmButtonTitle
        self.cancelButtonTitle = cancelButtonTitle
    }

    /// Human label for a scope button. Plain words, no jargon.
    public static func scopeLabel(_ scope: SessionGrantScope) -> String {
        switch scope {
        case .session: return "This session"
        case .once: return "Once"
        case .duration: return "For a set time"
        }
    }
}

/// What the user chose.
public struct PanelDecision: Equatable {
    public let approved: Bool
    public let scope: SessionGrantScope
    public let durationMs: Int64?

    public init(approved: Bool, scope: SessionGrantScope, durationMs: Int64? = nil) {
        self.approved = approved
        self.scope = scope
        self.durationMs = durationMs
    }

    public static func denied(defaultScope: SessionGrantScope) -> PanelDecision {
        return PanelDecision(approved: false, scope: defaultScope, durationMs: nil)
    }
}

/// Reads the key ids out of an `unlock-session` payload.
///
/// Deliberately has no default. A caller that names no key has asked for
/// nothing, and quietly unlocking some other key on its behalf would hand it a
/// grant it never requested. The caller is told instead.
public enum UnlockRequestKeys {
    /// Both forms are accepted: `keyIds` for the normal batch, and `keyId` for a
    /// one-off caller. Blank entries are dropped, and the result is deduped and
    /// sorted so one unlock covers the same set however the caller ordered it.
    public static func from(payload: [String: Any]?) -> [String] {
        guard let payload else { return [] }
        var requested = (payload["keyIds"] as? [Any]) ?? []
        if let single = payload["keyId"] { requested.append(single) }

        var seen = Set<String>()
        var keyIds: [String] = []
        for value in requested {
            guard let keyId = value as? String else { continue }
            guard !keyId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            if seen.insert(keyId).inserted { keyIds.append(keyId) }
        }
        return keyIds.sorted()
    }
}

/// Client-supplied decoration for an unlock panel.
///
/// None of this is trusted. It only ever adds a line to the panel; it can never
/// change which keys are unlocked, which scopes are offered, or whether a prompt
/// happens at all.
public struct UnlockDisplayInfo: Equatable {
    public let projectName: String?
    public let projectPath: String?
    /// key id -> how many encrypted items the client says that key covers
    public let itemCounts: [String: Int]

    public init(projectName: String? = nil, projectPath: String? = nil, itemCounts: [String: Int] = [:]) {
        self.projectName = projectName
        self.projectPath = projectPath
        self.itemCounts = itemCounts
    }

    public var isEmpty: Bool {
        return projectName == nil && projectPath == nil && itemCounts.isEmpty
    }

    /// Read the optional `display` object from an `unlock-session` payload.
    /// Anything malformed is dropped rather than rejected: it is decoration.
    public static func from(payload: [String: Any]?) -> UnlockDisplayInfo {
        guard let display = payload?["display"] as? [String: Any] else { return UnlockDisplayInfo() }
        var counts: [String: Int] = [:]
        if let raw = display["itemCounts"] as? [String: Any] {
            for (keyId, value) in raw {
                guard let count = (value as? NSNumber)?.intValue, count > 0 else { continue }
                counts[keyId] = count
            }
        }
        return UnlockDisplayInfo(
            projectName: trimmedNonEmpty(display["projectName"]),
            projectPath: trimmedNonEmpty(display["projectPath"]),
            itemCounts: counts
        )
    }

    /// Cap on any single client-supplied string, so a long value cannot push the
    /// derived lines off the panel.
    static let maxLength = 120

    static func trimmedNonEmpty(_ value: Any?) -> String? {
        guard let text = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            return nil
        }
        // Collapse newlines so a multi-line value cannot fake extra panel lines.
        let flattened = text.components(separatedBy: .newlines).joined(separator: " ")
        return String(flattened.prefix(maxLength))
    }
}

/// Builds the unlock panel's content from a plan.
public enum UnlockPanelContent {
    /// - Parameters:
    ///   - plan: what still needs asking.
    ///   - requesterLines: lines the daemon derived from the peer process.
    ///   - display: client-supplied decoration.
    public static func build(
        plan: UnlockPlan,
        requesterLines: [String],
        display: UnlockDisplayInfo = UnlockDisplayInfo()
    ) -> PanelContent {
        var context: [PanelContextLine] = requesterLines.map { .derived($0) }
        if let project = projectLine(display) {
            context.append(.clientSupplied(project))
        }

        var groups: [PanelItemGroup] = []
        let standard = plan.standardPromptKeys
        if !standard.isEmpty {
            groups.append(PanelItemGroup(heading: nil, items: standard.map { item(for: $0, display: display) }))
        }
        let strict = plan.strictPromptKeys
        if !strict.isEmpty {
            groups.append(PanelItemGroup(
                heading: strict.count == plan.promptKeys.count ? "Asks every time" : "Asks every time, whatever you pick below",
                items: strict.map { item(for: $0, display: display) }
            ))
        }

        return PanelContent(
            title: title(for: plan),
            subtitle: subtitle(for: plan),
            contextLines: context,
            itemGroups: groups,
            scopes: plan.offeredScopes,
            defaultScope: plan.defaultScope,
            confirmButtonTitle: "Unlock"
        )
    }

    static func item(for key: RequestedKey, display: UnlockDisplayInfo) -> PanelItem {
        let count = key.itemCount ?? display.itemCounts[key.keyId]
        guard let count, count > 0 else { return PanelItem(label: key.keyId) }
        return PanelItem(label: key.keyId, detail: count == 1 ? "1 value" : "\(count) values")
    }

    static func title(for plan: UnlockPlan) -> String {
        let names = plan.promptKeys.map { $0.keyId }
        if plan.isDelta {
            if names.count == 1 {
                return "Also unlock \(names[0])?"
            }
            return "Also unlock \(names.count) more keys?"
        }
        if names.count == 1 {
            return "Unlock encryption key \(names[0])"
        }
        return "Unlock \(names.count) encryption keys"
    }

    static func subtitle(for plan: UnlockPlan) -> String? {
        var parts: [String] = []
        if plan.isDelta {
            let already = plan.coveredKeys.count
            parts.append(already == 1
                ? "This session already has 1 other key unlocked."
                : "This session already has \(already) other keys unlocked.")
        }
        if plan.isStrictOnly {
            parts.append("These keys are set to ask every time, so this unlock covers one read.")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    static func projectLine(_ display: UnlockDisplayInfo) -> String? {
        switch (display.projectName, display.projectPath) {
        case (let name?, let path?): return "Project: \(name) (\(path))"
        case (let name?, nil): return "Project: \(name)"
        case (nil, let path?): return "Project: \(path)"
        default: return nil
        }
    }
}
