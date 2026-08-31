import Foundation
import SessionScoping

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

/// Who is asking, split into what the panel shows at rest and what it keeps behind
/// the disclosure.
///
/// The panel has to be readable in the second before a finger lands on the sensor,
/// so the resting state is one line naming the process and where it is running. The
/// full ancestry and the client's own decoration are still there for anyone who
/// wants them, one click away, because the detail is the evidence: it just should
/// not be what a routine unlock makes you read.
public struct PanelRequester: Equatable {
    /// The single line shown at rest. Derived from the peer process.
    public let summary: String
    /// Everything else, shown when the disclosure is opened.
    public let details: [PanelContextLine]
    /// The processes that lead to the caller, when the daemon could read them.
    /// This is what the panel draws; `summary` is the flattened form the audit
    /// log and the biometric prompt's reason line use.
    public let chain: ExecutionChain?

    public init(summary: String, details: [PanelContextLine] = [], chain: ExecutionChain? = nil) {
        self.summary = summary
        self.details = details
        self.chain = chain
    }

    public var hasDetails: Bool { !details.isEmpty }
}

/// A run of panel text, and whether it names something the machine reads.
///
/// Key names are drawn in a monospaced face, which is the panel's way of saying
/// "this is an identifier, exactly as written". Deciding that here rather than in
/// the view keeps the copy and its emphasis in one testable place.
public enum PanelTextSegment: Equatable {
    case plain(String)
    case code(String)

    public var text: String {
        switch self {
        case .plain(let text), .code(let text): return text
        }
    }
}

/// One row of the panel's key box: a key, the vault it lives in, and what the
/// client says it opens.
public struct PanelKeyRow: Equatable {
    /// The real key id. Never drawn when a friendlier name exists, but it is what
    /// the grant and the audit record are keyed by.
    public let keyId: String
    /// What the row calls this key.
    public let displayName: String
    /// The vault tag's label, or nil when a tag would only repeat the name.
    public let vaultLabel: String?
    /// The vault's `#rrggbb` identity colour, or nil for the default tint.
    public let vaultColor: String?
    /// How many values the client says this key covers.
    public let valueCount: Int?
    /// Those values, grouped by the file that defined them. Client-reported, and
    /// the row says so when it is opened.
    public let files: [UnlockValueFile]
    /// Anything that changes what approving this row means, e.g. a strict key.
    public let note: String?

    public init(
        keyId: String,
        displayName: String,
        vaultLabel: String? = nil,
        vaultColor: String? = nil,
        valueCount: Int? = nil,
        files: [UnlockValueFile] = [],
        note: String? = nil
    ) {
        self.keyId = keyId
        self.displayName = displayName
        self.vaultLabel = vaultLabel
        self.vaultColor = vaultColor
        self.valueCount = valueCount
        self.files = files
        self.note = note
    }

    /// What this key is called out loud, in the one-line sentence macOS builds
    /// for its own sheet.
    ///
    /// Never a key id: `varlock-default` is an implementation detail, and the
    /// default key has no name of its own worth saying, so its vault (when there
    /// is one) is the friendlier thing to name. Any other key is called what the
    /// user called it.
    public var spokenName: String {
        if keyId == UnlockPanelContent.defaultKeyId { return vaultLabel ?? displayName }
        return displayName
    }

    /// "12 values", or nil when the client said nothing about how many.
    public var valueCountLabel: String? {
        guard let valueCount, valueCount > 0 else { return nil }
        return valueCount == 1 ? "1 value" : "\(valueCount) values"
    }

    /// Whether there is anything to see when the row is opened.
    public var isExpandable: Bool {
        return files.contains { !$0.valueNames.isEmpty }
    }
}

/// Everything the panel needs to draw itself and to report a decision.
public struct PanelContent: Equatable {
    /// The heading, in runs, so key names can be drawn as identifiers.
    public let titleSegments: [PanelTextSegment]
    public let subtitle: String?
    /// Who is asking: one line at rest, the chain and the rest behind disclosures.
    public let requester: PanelRequester
    /// The key box: one row per key this approval covers.
    public let keyRows: [PanelKeyRow]
    /// Small print under the key box: what makes this approval unusual, if
    /// anything (an add-on to a live session, keys that ask every time).
    public let notes: [String]
    /// The quiet fact in the top bar. A standing truth about approvals, not
    /// something about this one request.
    public let factLine: String?
    /// How the client says varlock came to be running, which changes how the
    /// chain words its command line.
    public let invocationMode: UnlockInvocationMode?
    public let scopes: [SessionGrantScope]
    public let defaultScope: SessionGrantScope
    public let confirmButtonTitle: String
    public let cancelButtonTitle: String

    public init(
        titleSegments: [PanelTextSegment],
        subtitle: String? = nil,
        requester: PanelRequester = PanelRequester(summary: ""),
        keyRows: [PanelKeyRow] = [],
        notes: [String] = [],
        factLine: String? = nil,
        invocationMode: UnlockInvocationMode? = nil,
        scopes: [SessionGrantScope],
        defaultScope: SessionGrantScope,
        confirmButtonTitle: String,
        cancelButtonTitle: String = "Deny"
    ) {
        self.titleSegments = titleSegments
        self.subtitle = subtitle
        self.requester = requester
        self.keyRows = keyRows
        self.notes = notes
        self.factLine = factLine
        self.invocationMode = invocationMode
        self.scopes = scopes
        self.defaultScope = defaultScope
        self.confirmButtonTitle = confirmButtonTitle
        self.cancelButtonTitle = cancelButtonTitle
    }

    /// Plain-text form, for a window title, a log line, or a test.
    public var title: String {
        return titleSegments.map { $0.text }.joined()
    }

    /// Human label for a scope button. Plain words, no jargon.
    public static func scopeLabel(_ scope: SessionGrantScope) -> String {
        switch scope {
        case .session: return "This session"
        case .once: return "Once"
        case .duration: return "For a set time"
        }
    }

    /// The one line macOS puts in its own sheet, as a verb phrase.
    ///
    /// macOS builds the sentence itself ("Varlock is trying to ..."), so this is
    /// only ever the tail of one. It is deliberately the shortest true thing:
    /// the panel is the surface that says who is asking and what they get, and
    /// repeating any of that on a sheet that covers the panel would be two
    /// voices telling the same story badly. Key ids never appear.
    public var presenceReason: String {
        return UnlockPanelContent.presenceReason(forRows: keyRows)
    }

    /// Where the values listed under a key row came from. Said out loud on the
    /// panel, because the daemon did not derive them and cannot vouch for them.
    public static let valueSourceFootnote = "Value names and files reported by the client"
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

/// Value names the client says one file defined.
///
/// Client-reported, and shown as such. The daemon has no way to know what an
/// env value is called, so this is the only source there is; it is drawn behind
/// a disclosure and labelled, rather than presented as something the daemon
/// verified.
public struct UnlockValueFile: Equatable {
    /// The file that defined these values. nil when the client did not say.
    public let path: String?
    public let valueNames: [String]

    public init(path: String?, valueNames: [String]) {
        self.path = path
        self.valueNames = valueNames
    }
}

/// What the client says one key is being asked to open.
///
/// Display only, and deliberately not bound into anything: none of it reaches
/// the crypto, and the daemon never checks it against what it holds. It exists
/// so the panel can answer "what do they get" beyond a bare key id.
public struct UnlockKeyDisplay: Equatable {
    public let valueCount: Int?
    public let files: [UnlockValueFile]
    /// The vault this key belongs to, once vaults exist. nil means the local one.
    public let vaultLabel: String?
    /// The vault's identity colour as `#rrggbb`, or nil for the default tint.
    public let vaultColor: String?

    public init(
        valueCount: Int? = nil,
        files: [UnlockValueFile] = [],
        vaultLabel: String? = nil,
        vaultColor: String? = nil
    ) {
        self.valueCount = valueCount
        self.files = files
        self.vaultLabel = vaultLabel
        self.vaultColor = vaultColor
    }

    /// Caps on how much a client can put in one key's row. A caller with more
    /// than this is trimmed rather than refused: the panel has to stay a panel.
    public static let maxFiles = 8
    public static let maxValueNames = 60
    static let maxValueNameLength = 64
    static let maxPathLength = 60
    static let maxVaultLabelLength = 32

    static func from(_ raw: Any?) -> UnlockKeyDisplay? {
        guard let raw = raw as? [String: Any] else { return nil }

        var files: [UnlockValueFile] = []
        var namesLeft = maxValueNames
        for entry in (raw["files"] as? [Any] ?? []).prefix(maxFiles) {
            guard let entry = entry as? [String: Any] else { continue }
            let names = (entry["valueNames"] as? [Any] ?? [])
                .compactMap { UnlockDisplayInfo.trimmedNonEmpty($0, limit: maxValueNameLength) }
                .prefix(namesLeft)
            guard !names.isEmpty else { continue }
            namesLeft -= names.count
            files.append(UnlockValueFile(
                path: UnlockDisplayInfo.trimmedNonEmpty(entry["path"], limit: maxPathLength),
                valueNames: Array(names)
            ))
            if namesLeft <= 0 { break }
        }

        let count = (raw["valueCount"] as? NSNumber)?.intValue
        return UnlockKeyDisplay(
            valueCount: (count ?? 0) > 0 ? count : nil,
            files: files,
            vaultLabel: UnlockDisplayInfo.trimmedNonEmpty(raw["vaultLabel"], limit: maxVaultLabelLength),
            vaultColor: hexColor(raw["vaultColor"])
        )
    }

    /// Only `#rrggbb` is accepted, so a colour cannot smuggle anything else onto
    /// the panel.
    static func hexColor(_ value: Any?) -> String? {
        guard let text = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        guard text.count == 7, text.hasPrefix("#") else { return nil }
        let digits = text.dropFirst()
        guard digits.allSatisfy({ $0.isHexDigit }) else { return nil }
        return "#" + digits.lowercased()
    }
}

/// How varlock came to be running, as the client reported it.
///
/// The daemon reads the command line off the kernel, which is the half worth
/// trusting, but a command line cannot say whether varlock was typed or
/// imported: an auto-load spawns the same CLI a person would. So the client says
/// which it was and the panel keeps the two apart, saying "auto-loaded inside"
/// rather than showing an internal command nobody typed.
public enum UnlockInvocationMode: String, Equatable {
    case cli
    case autoLoad = "auto-load"
    case sdk

    /// Whether varlock is running inside something rather than as a command.
    public var isHosted: Bool { self != .cli }

    public init?(wireValue: String?) {
        guard let wireValue, let parsed = UnlockInvocationMode(rawValue: wireValue) else { return nil }
        self = parsed
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
    /// key id -> what the client says that key covers, in detail
    public let keys: [String: UnlockKeyDisplay]
    /// How the client says varlock came to be running.
    public let invocationMode: UnlockInvocationMode?

    public init(
        projectName: String? = nil,
        projectPath: String? = nil,
        itemCounts: [String: Int] = [:],
        keys: [String: UnlockKeyDisplay] = [:],
        invocationMode: UnlockInvocationMode? = nil
    ) {
        self.projectName = projectName
        self.projectPath = projectPath
        self.itemCounts = itemCounts
        self.keys = keys
        self.invocationMode = invocationMode
    }

    public var isEmpty: Bool {
        return projectName == nil && projectPath == nil && itemCounts.isEmpty && keys.isEmpty
            && invocationMode == nil
    }

    /// How many values a key covers, from either form the client sent.
    public func valueCount(forKey keyId: String) -> Int? {
        return keys[keyId]?.valueCount ?? itemCounts[keyId]
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
        var keys: [String: UnlockKeyDisplay] = [:]
        if let raw = display["keys"] as? [String: Any] {
            for (keyId, value) in raw {
                guard let parsed = UnlockKeyDisplay.from(value) else { continue }
                keys[keyId] = parsed
            }
        }
        return UnlockDisplayInfo(
            projectName: trimmedNonEmpty(display["projectName"]),
            projectPath: trimmedNonEmpty(display["projectPath"]),
            itemCounts: counts,
            keys: keys,
            invocationMode: UnlockInvocationMode(wireValue: display["invocationMode"] as? String)
        )
    }

    /// Cap on any single client-supplied string, so a long value cannot push the
    /// derived lines off the panel.
    static let maxLength = 120

    static func trimmedNonEmpty(_ value: Any?, limit: Int = maxLength) -> String? {
        guard let text = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            return nil
        }
        // Collapse newlines so a multi-line value cannot fake extra panel lines.
        let flattened = text.components(separatedBy: .newlines).joined(separator: " ")
        return String(flattened.prefix(limit))
    }
}

/// Builds the unlock panel's content from a plan.
public enum UnlockPanelContent {
    /// The key every varlock install has, whose id is an implementation detail
    /// nobody should have to read off a panel.
    public static let defaultKeyId = "varlock-default"
    /// What that key is called out loud.
    public static let defaultKeyDisplayName = "local encryption"

    /// - Parameters:
    ///   - plan: what still needs asking.
    ///   - requester: who is asking, as the daemon read it off the peer process.
    ///   - display: client-supplied decoration.
    ///   - lockOn: the lock policy this unlock would run under, for the top bar.
    public static func build(
        plan: UnlockPlan,
        requester: PanelRequester,
        display: UnlockDisplayInfo = UnlockDisplayInfo(),
        lockOn: SessionLockPolicy = .builtInDefault
    ) -> PanelContent {
        var details = requester.details
        if let project = projectLine(display) {
            details.append(.clientSupplied(project))
        }

        return PanelContent(
            titleSegments: titleSegments(for: plan),
            subtitle: projectSubtitle(display),
            requester: PanelRequester(
                summary: requester.summary,
                details: details,
                chain: requester.chain
            ),
            keyRows: plan.promptKeys.map { row(for: $0, display: display) },
            notes: notes(for: plan),
            factLine: factLine(plan: plan, lockOn: lockOn),
            invocationMode: display.invocationMode,
            scopes: plan.offeredScopes,
            defaultScope: plan.defaultScope,
            confirmButtonTitle: "Unlock"
        )
    }

    /// What one key's row says.
    ///
    /// The vault tag names the vault a key lives in. Without vaults there is only
    /// the local one, and a tag repeating the row's own name would be noise, so
    /// it is left off in that case.
    public static func row(for key: RequestedKey, display: UnlockDisplayInfo) -> PanelKeyRow {
        let supplied = display.keys[key.keyId]
        let name = displayName(forKeyId: key.keyId)
        let vaultLabel = supplied?.vaultLabel ?? defaultKeyDisplayName
        return PanelKeyRow(
            keyId: key.keyId,
            displayName: name,
            vaultLabel: vaultLabel == name ? nil : vaultLabel,
            vaultColor: supplied?.vaultColor,
            valueCount: key.itemCount ?? display.valueCount(forKey: key.keyId),
            files: supplied?.files ?? [],
            note: key.policy == .everyTime ? "asks every time" : nil
        )
    }

    /// The line macOS puts in its own sheet, for a set of key rows.
    public static func presenceReason(forRows rows: [PanelKeyRow]) -> String {
        let names = rows.map { $0.spokenName }
        switch names.count {
        case 0: return "unlock your encrypted values"
        case 1: return "unlock \(names[0])"
        case 2: return "unlock \(names[0]) and \(names[1])"
        default: return "unlock \(names.count) encryption keys"
        }
    }

    /// The same line for a bare list of keys, where there is no panel to take it
    /// from.
    public static func presenceReason(forKeyIds keyIds: [String], display: UnlockDisplayInfo) -> String {
        return presenceReason(forRows: keyIds.map { row(for: RequestedKey(keyId: $0), display: display) })
    }

    /// What a key is called on the panel.
    public static func displayName(forKeyId keyId: String) -> String {
        return keyId == defaultKeyId ? defaultKeyDisplayName : keyId
    }

    static func titleSegments(for plan: UnlockPlan) -> [PanelTextSegment] {
        let names = plan.promptKeys.map { displayName(forKeyId: $0.keyId) }
        let lead = plan.isDelta ? "Also unlock " : "Unlock "
        switch names.count {
        case 1:
            return [.plain(lead), .code(names[0])]
        case 2:
            return [.plain(lead), .code(names[0]), .plain(" and "), .code(names[1])]
        default:
            return [.plain("\(lead)\(names.count) encryption keys")]
        }
    }

    /// The hero's second line: which project is asking, as the client named it.
    static func projectSubtitle(_ display: UnlockDisplayInfo) -> String? {
        if let name = display.projectName { return "for \(name)" }
        guard let path = display.projectPath else { return nil }
        let leaf = (path as NSString).lastPathComponent
        return "for \(leaf.isEmpty ? path : leaf)"
    }

    static func notes(for plan: UnlockPlan) -> [String] {
        var notes: [String] = []
        if plan.isDelta {
            let already = plan.coveredKeys.count
            notes.append(already == 1
                ? "This session already has 1 other key unlocked."
                : "This session already has \(already) other keys unlocked.")
        }
        if plan.isStrictOnly {
            notes.append("These keys are set to ask every time, so this unlock covers one read.")
        }
        return notes
    }

    /// The standing fact in the top bar.
    ///
    /// Two things are always true of an unlock: it is recorded, and a session has
    /// a limit. Whichever one the panel is not already implying is the one worth
    /// saying, so an approval that cannot open a session talks about the record
    /// instead of about session limits it will never reach.
    static func factLine(plan: UnlockPlan, lockOn: SessionLockPolicy) -> String {
        guard plan.offeredScopes.contains(.session) else { return "Recorded to the audit log" }
        switch lockOn {
        case .screenLock: return "Sessions end on screen lock \u{00B7} 12h max"
        case .sleep: return "Sessions end on sleep \u{00B7} 12h max"
        case .never: return "Sessions last 12h at most"
        }
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
