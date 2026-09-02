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
    /// How many values the client says this key covers, across every source.
    public let valueCount: Int?
    /// Where those values live: env files, the value cache, whatever else comes
    /// later. Client-reported, and the row says so when it is opened.
    ///
    /// One list, not one list plus special cases. Everything a key protects is
    /// opened by the same grant, so everything a key protects is a peer here,
    /// and grouping by key is what carries that: when a key belongs to a vault,
    /// its sources come with it.
    public let sources: [UnlockValueSource]
    /// Anything that changes what approving this row means, e.g. a strict key.
    public let note: String?

    public init(
        keyId: String,
        displayName: String,
        vaultLabel: String? = nil,
        vaultColor: String? = nil,
        valueCount: Int? = nil,
        sources: [UnlockValueSource] = [],
        note: String? = nil
    ) {
        self.keyId = keyId
        self.displayName = displayName
        self.vaultLabel = vaultLabel
        self.vaultColor = vaultColor
        self.valueCount = valueCount
        self.sources = sources
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
    ///
    /// The client's own count wins where it sent one, because it knows what the
    /// key covers and a batch only knows what it is decrypting right now. Where
    /// it sent none, the sources are added up rather than left blank.
    public var valueCountLabel: String? {
        let total = valueCount ?? sources.reduce(0) { $0 + $1.itemCount }
        guard total > 0 else { return nil }
        return UnlockValueSource.valuesLabel(total)
    }

    /// What the row's trailing slot says.
    ///
    /// A row whose client said nothing about what it covers says exactly that.
    /// The alternative is a blank slot, which reads as "nothing much" on a panel
    /// whose whole job is to say what is being handed over, and a panel that
    /// looks authoritative while knowing nothing is worse than one that admits
    /// it.
    public var contentsLabel: String {
        return valueCountLabel ?? "contents not reported"
    }

    /// Whether the client said anything at all about what this key covers.
    public var reportsContents: Bool {
        return valueCountLabel != nil || !sources.isEmpty
    }

    /// Whether there is anything to see when the row is opened.
    public var isExpandable: Bool {
        return sources.contains { $0.isDrawable }
    }

    /// Where the open row's detail came from, said out loud because the daemon
    /// derived none of it.
    public var sourceFootnote: String {
        return sources.contains { $0.kind != .file }
            ? "Sources and contents reported by the client"
            : PanelContent.valueSourceFootnote
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
    /// Amber lines drawn on the session-root row: what is unusual about the
    /// session this request came from. Worked out where both halves are known,
    /// which is here: the session comes off the kernel, the project comes off the
    /// client, and neither side can answer on its own.
    public let sessionAdvisories: [String]
    /// Which build of varlock the client says it is, for the rows where the
    /// daemon could not establish it. Always drawn as a claim.
    public let reportedVarlockVersion: String?
    public let scopes: [SessionGrantScope]
    public let defaultScope: SessionGrantScope
    /// How much of each key an approval may cover. One entry means there is no
    /// choice to draw and the approval covers the whole key, as it always did.
    public let breadths: [SessionGrantBreadth]
    /// Which breadth the panel starts on.
    public let defaultBreadth: SessionGrantBreadth
    /// How many ciphertexts the narrow choice would cover. Daemon-counted.
    public let listedItemCount: Int
    /// How many distinct vaults this approval is over. One, until vaults exist.
    /// Only ever used to word things in the singular or the plural.
    public let vaultCount: Int
    /// Whether anything in this request has a source item scope cannot reach,
    /// which the panel has to say out loud rather than let a reader assume.
    public let hasUnlistableSource: Bool
    /// What the panel says about why it opened where it did, when there is
    /// something to say (a remembered narrowing, an unusual-looking request).
    public let selectionNote: String?
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
        sessionAdvisories: [String] = [],
        reportedVarlockVersion: String? = nil,
        scopes: [SessionGrantScope],
        defaultScope: SessionGrantScope,
        breadths: [SessionGrantBreadth] = [.wholeKey],
        defaultBreadth: SessionGrantBreadth = .wholeKey,
        listedItemCount: Int = 0,
        vaultCount: Int = 1,
        hasUnlistableSource: Bool = false,
        selectionNote: String? = nil,
        confirmButtonTitle: String,
        cancelButtonTitle: String = "Deny"
    ) {
        self.breadths = breadths
        self.defaultBreadth = defaultBreadth
        self.listedItemCount = listedItemCount
        self.vaultCount = vaultCount
        self.hasUnlistableSource = hasUnlistableSource
        self.selectionNote = selectionNote
        self.titleSegments = titleSegments
        self.subtitle = subtitle
        self.requester = requester
        self.keyRows = keyRows
        self.notes = notes
        self.factLine = factLine
        self.invocationMode = invocationMode
        self.sessionAdvisories = sessionAdvisories
        self.reportedVarlockVersion = reportedVarlockVersion
        self.scopes = scopes
        self.defaultScope = defaultScope
        self.confirmButtonTitle = confirmButtonTitle
        self.cancelButtonTitle = cancelButtonTitle
    }

    /// Plain-text form, for a window title, a log line, or a test.
    public var title: String {
        return titleSegments.map { $0.text }.joined()
    }

    /// The breadth control: one checkbox, ticked for the broad answer.
    ///
    /// A checkbox rather than a pair of buttons because there is a default here
    /// and the default is broad. Two equally weighted pills present a decision
    /// where there is really a setting, and they make the safe, ordinary answer
    /// look like something you have to pick.
    ///
    /// Worded in what it covers rather than in what it switches off. "Cover
    /// anything these vaults can open" is what the user gets; something like
    /// "auto approve other keys" describes the plumbing, and dresses the
    /// ordinary default as an automation convenience, which is the opposite of
    /// what it is.
    public static func breadthCheckboxLabel(vaultCount: Int) -> String {
        return vaultCount == 1
            ? "Cover anything this vault can open"
            : "Cover anything these vaults can open"
    }

    /// The whole answer in one sentence, under the controls.
    ///
    /// This is where the panel is honest about the list. Showing twelve named
    /// values and then opening a thirteenth is the failure this wording exists
    /// to prevent: under a broad approval the list is WHAT THE GRANT COVERS
    /// RIGHT NOW, not what defines it, and a person who reads only this line
    /// should not be surprised later. So the broad sentence names the vault as
    /// the thing being granted and puts the list inside it ("not just the 12
    /// listed"), rather than letting the list stand as the definition and
    /// hoping the reader works out that it is a snapshot.
    ///
    /// The narrow sentence can say "only", because there it really is the
    /// definition and the daemon enforces it.
    public static func selectionSummary(
        breadth: SessionGrantBreadth,
        itemCount: Int,
        vaultCount: Int = 1,
        scope: SessionGrantScope,
        durationLabel: String?
    ) -> String {
        let vaults = vaultCount == 1 ? "this vault" : "these vaults"
        let what: String
        switch breadth {
        case .listedItems:
            what = itemCount == 1
                ? "Covers only the 1 value listed above"
                : "Covers only the \(itemCount) values listed above"
        case .wholeKey:
            what = itemCount > 0
                ? "Covers anything \(vaults) can open, not just the \(itemCount) listed above"
                : "Covers anything \(vaults) can open"
        }
        let howLong: String
        switch scope {
        case .once: return "\(what), for this one read."
        case .session: howLong = "until this session ends"
        case .duration: howLong = "for \(durationLabel ?? DurationPreset.default.label)"
        }
        return "\(what), \(howLong)."
    }

    /// What the panel says when the narrow answer does not narrow everything.
    ///
    /// The value cache is never item scoped, so narrow means "only these FILE
    /// values, and the cache as a whole". Nobody who reads "covers only the 12
    /// values listed above" should walk away believing they restricted cache
    /// access, so the exception is stated next to the choice rather than as a
    /// footnote under the key rows.
    ///
    /// Deliberately says nothing about the checkbox. It is true in every state,
    /// including `once`, where the grant is narrow and no checkbox is drawn at
    /// all: a caveat that pointed at a control the reader cannot see would send
    /// them looking for it.
    public static let unlistableSourceNote =
        "The value cache is always covered as a whole: "
        + "it is machine-written and changes constantly."

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
    /// How much of each vault this answer opens. Defaults to the broad answer,
    /// so every caller that predates the choice keeps the behaviour it had.
    ///
    /// Under `once` this is always `listedItems`, whatever the checkbox last
    /// said, because the panel draws no checkbox there. See
    /// `ApprovalFlow.effectiveBreadth` for why.
    public let breadth: SessionGrantBreadth
    /// The breadth the USER chose, where they were given the choice.
    ///
    /// nil under `once`, and the difference is the whole point: `once` is a
    /// DURATION answer that implies a breadth for that one grant. It is not a
    /// statement about how broad this person likes their approvals, so it must
    /// not be written down as one. Somebody who picks "once" today and "this
    /// session" tomorrow should find the checkbox back at its own default, not
    /// still tightened by a decision they made about time.
    public let chosenBreadth: SessionGrantBreadth?

    public init(
        approved: Bool,
        scope: SessionGrantScope,
        durationMs: Int64? = nil,
        breadth: SessionGrantBreadth = .wholeKey,
        chosenBreadth: SessionGrantBreadth? = nil
    ) {
        self.approved = approved
        self.scope = scope
        self.durationMs = durationMs
        self.breadth = breadth
        self.chosenBreadth = chosenBreadth
    }

    /// The scope and its window as one value, for comparing and remembering.
    public var window: GrantWindow { GrantWindow(scope: scope, durationMs: durationMs) }

    public static func denied(
        defaultScope: SessionGrantScope,
        breadth: SessionGrantBreadth = .wholeKey
    ) -> PanelDecision {
        // A refusal teaches the preferences nothing, so it carries no choice.
        return PanelDecision(
            approved: false,
            scope: defaultScope,
            durationMs: nil,
            breadth: breadth,
            chosenBreadth: nil
        )
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

/// Reads the ciphertexts an unlock is being asked to cover.
///
/// `{ "items": { "<key id>": ["<base64 payload>", ...] } }`, and nothing else.
/// Not part of `display`, deliberately: everything in `display` is decoration
/// the daemon does not check, and this is the one thing a client sends that the
/// daemon turns into an enforced fact. Keeping them apart keeps that difference
/// visible in the payload as well as in the code.
///
/// Payloads, never digests. A digest the client computed would be a digest the
/// client chose, and an item-scoped grant would then cover whatever it felt
/// like. Hashing happens on this side or not at all.
public enum UnlockRequestItems {
    /// Caps on how much a caller can bind one grant to. A request over the cap
    /// is trimmed rather than refused, and a trimmed key simply cannot be
    /// narrowed: `UnlockPlanner` only offers item scope where every key's
    /// digests arrived, so the panel does not promise a narrowing it would then
    /// have to break.
    public static let maxItemsPerKey = 500
    public static let maxItemsTotal = 2000

    public static func from(payload: [String: Any]?) -> [String: Set<String>] {
        guard let raw = payload?["items"] as? [String: Any] else { return [:] }
        var out: [String: Set<String>] = [:]
        var budget = maxItemsTotal
        for (keyId, value) in raw {
            guard budget > 0, let list = value as? [Any] else { continue }
            var digests = Set<String>()
            for entry in list.prefix(min(maxItemsPerKey, budget)) {
                guard let text = entry as? String, let data = Data(base64Encoded: text) else { continue }
                digests.insert(GrantItemDigest.of(data))
            }
            guard !digests.isEmpty else { continue }
            budget -= digests.count
            out[keyId] = digests
        }
        return out
    }
}

/// One place the values behind a key come from.
///
/// An env file and varlock's value cache are the same kind of thing here, and
/// that is the point: one key means one grant, so everything that key opens
/// belongs in one list under it rather than in a list plus an exception. A new
/// kind of source is a new `Kind` and a label, and the panel draws it without
/// knowing what it is.
///
/// Client-reported, and shown as such. The daemon has no way to know what an
/// env value is called or what filled a cache, so this is the only account
/// there is; it is drawn behind a disclosure and labelled, rather than
/// presented as something the daemon verified.
public struct UnlockValueSource: Equatable {
    public enum Kind: String, Equatable {
        /// An env file, whose entries are the values it defined.
        case file
        /// Varlock's value cache, whose entries are what filled it.
        case cache

        /// What the panel calls a source of this kind when it has no path.
        var fallbackLabel: String {
            switch self {
            case .file: return "values"
            case .cache: return "value cache"
            }
        }

        /// Whether an item-scoped approval reaches inside this kind of source.
        ///
        /// A file's values are written by a person and change when that person
        /// changes them, so approving them one by one is a thing a person can
        /// mean. The value cache is not like that: it is machine-written, and
        /// every provider refresh rewrites an entry into a ciphertext nobody has
        /// ever seen. Item-scoping it would refuse the next read of a value that
        /// only changed because it was renewed on schedule, and the user would
        /// answer a panel per refresh for the rest of the day. A control that
        /// makes varlock unusable is not a control, so the cache is always
        /// covered as a whole and the panel says so.
        ///
        /// This lives on the kind rather than at the place the decision is
        /// enforced, so a source kind added later cannot quietly acquire the
        /// exemption by being handled somewhere that forgot to ask.
        public var isItemScopable: Bool {
            switch self {
            case .file: return true
            case .cache: return false
            }
        }
    }

    public let kind: Kind
    /// The file that defined these values. nil for anything that is not a file,
    /// and for a file the client did not name.
    public let path: String?
    /// What is inside: value names for a file, the providers that filled the
    /// cache for a cache.
    public let entries: [Entry]
    /// How many values this source contributes, when the entries summarise
    /// rather than enumerate. nil means the entries are the whole list.
    public let reportedItemCount: Int?

    public init(
        kind: Kind = .file,
        path: String? = nil,
        entries: [Entry] = [],
        reportedItemCount: Int? = nil
    ) {
        self.kind = kind
        self.path = path
        self.entries = entries
        self.reportedItemCount = reportedItemCount
    }

    /// One thing inside a source: an env value, or a provider that filled the
    /// cache and how much of it that provider accounts for.
    public struct Entry: Equatable {
        public let name: String
        /// How many values this entry stands for. nil when it stands for one
        /// and needs no number after it.
        public let count: Int?

        public init(name: String, count: Int? = nil) {
            self.name = name
            self.count = count
        }

        /// The chip's text: a bare name, or a name with what it accounts for.
        public var label: String {
            guard let count, count > 1 else { return name }
            return "\(name) \u{00B7} \(count)"
        }
    }

    /// How many values this source contributes.
    public var itemCount: Int {
        if let reportedItemCount { return reportedItemCount }
        return entries.reduce(0) { $0 + ($1.count ?? 1) }
    }

    /// The line above the chips: the source's own name and nothing else. nil
    /// for a file the client did not name, whose values are listed under no
    /// heading rather than under a made-up one.
    ///
    /// How much is in it is `headingCount`, drawn as a badge rather than said
    /// in words: a column of sources is read by comparing their sizes, and
    /// numerals compare at a glance where "8 values / 4 values / 12 values"
    /// has to be read three times.
    public var heading: String? {
        return path ?? (kind == .file ? nil : kind.fallbackLabel)
    }

    /// The number on the heading's badge, or nil when there is nothing to say.
    ///
    /// A source whose size is unknown draws no badge at all: an empty one would
    /// be a claim of its own, and a zero would be a wrong one.
    public var headingCount: Int? {
        guard heading != nil, itemCount > 0 else { return nil }
        return itemCount
    }

    /// Whether this source puts anything on the panel at all.
    public var isDrawable: Bool {
        return !entries.isEmpty || heading != nil
    }

    /// Whether an item-scoped approval reaches inside this source.
    public var isItemScopable: Bool { kind.isItemScopable }

    /// "1 value" / "12 values", in one place so every line that counts values
    /// counts them the same way.
    public static func valuesLabel(_ count: Int) -> String {
        return count == 1 ? "1 value" : "\(count) values"
    }
}

/// What the client says one key is being asked to open.
///
/// Display only, and deliberately not bound into anything: none of it reaches
/// the crypto, and the daemon never checks it against what it holds. It exists
/// so the panel can answer "what do they get" beyond a bare key id.
public struct UnlockKeyDisplay: Equatable {
    public let valueCount: Int?
    public let sources: [UnlockValueSource]
    /// The vault this key belongs to, once vaults exist. nil means the local one.
    public let vaultLabel: String?
    /// The vault's identity colour as `#rrggbb`, or nil for the default tint.
    public let vaultColor: String?

    /// The vault's stable id, which is the line a broad approval may not cross.
    ///
    /// Client-supplied like the rest of this type, and that is fine in the only
    /// direction it can act: an id is compared against the one a live grant was
    /// approved under, and any disagreement means a fresh panel. A caller can
    /// therefore cost itself a prompt by changing its mind about which vault a
    /// key is in, and cannot do anything else with it.
    ///
    /// Falls back to the vault label, and then to the local vault, so a caller
    /// that only names its vaults still gets a boundary between them.
    public var vaultId: String {
        if let declaredVaultId { return declaredVaultId }
        if let vaultLabel { return "label:" + vaultLabel.lowercased() }
        return VaultBoundary.localVaultId
    }

    private let declaredVaultId: String?

    public init(
        valueCount: Int? = nil,
        sources: [UnlockValueSource] = [],
        vaultLabel: String? = nil,
        vaultColor: String? = nil,
        vaultId: String? = nil
    ) {
        self.valueCount = valueCount
        self.sources = sources
        self.vaultLabel = vaultLabel
        self.vaultColor = vaultColor
        self.declaredVaultId = vaultId
    }

    /// Caps on how much a client can put in one key's row. A caller with more
    /// than this is trimmed rather than refused: the panel has to stay a panel.
    public static let maxSources = 8
    public static let maxEntries = 60
    static let maxEntryNameLength = 64
    static let maxPathLength = 60
    static let maxVaultLabelLength = 32

    static func from(_ raw: Any?) -> UnlockKeyDisplay? {
        guard let raw = raw as? [String: Any] else { return nil }

        var sources: [UnlockValueSource] = []
        var entriesLeft = maxEntries
        for raw in (raw["sources"] as? [Any] ?? []).prefix(maxSources) {
            guard let raw = raw as? [String: Any] else { continue }
            // An unrecognised kind is drawn as a file rather than dropped: a
            // source the panel cannot name is still a source it must not hide.
            let kind = UnlockValueSource.Kind(rawValue: (raw["kind"] as? String) ?? "") ?? .file
            let entries = (raw["entries"] as? [Any] ?? [])
                .compactMap { Self.entry($0) }
                .prefix(entriesLeft)
            let reported = (raw["itemCount"] as? NSNumber)?.intValue
            let source = UnlockValueSource(
                kind: kind,
                path: UnlockDisplayInfo.trimmedNonEmpty(raw["path"], limit: maxPathLength),
                entries: Array(entries),
                reportedItemCount: (reported ?? 0) > 0 ? reported : nil
            )
            guard source.isDrawable else { continue }
            entriesLeft -= entries.count
            sources.append(source)
            if entriesLeft <= 0 { break }
        }

        let count = (raw["valueCount"] as? NSNumber)?.intValue
        return UnlockKeyDisplay(
            valueCount: (count ?? 0) > 0 ? count : nil,
            sources: sources,
            vaultLabel: UnlockDisplayInfo.trimmedNonEmpty(raw["vaultLabel"], limit: maxVaultLabelLength),
            vaultColor: hexColor(raw["vaultColor"]),
            vaultId: UnlockDisplayInfo.trimmedNonEmpty(raw["vaultId"], limit: maxVaultLabelLength)
        )
    }

    /// One entry inside a source. A blank name is dropped; a count that is not a
    /// positive number is simply absent, which draws as a bare name.
    static func entry(_ raw: Any?) -> UnlockValueSource.Entry? {
        guard let raw = raw as? [String: Any] else { return nil }
        guard let name = UnlockDisplayInfo.trimmedNonEmpty(raw["name"], limit: maxEntryNameLength) else {
            return nil
        }
        let count = (raw["count"] as? NSNumber)?.intValue
        return UnlockValueSource.Entry(name: name, count: (count ?? 0) > 0 ? count : nil)
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
    /// Which build of varlock the client says it is.
    ///
    /// A claim, like everything else here, and drawn as one. It exists for the
    /// compiled binary, which carries no package the daemon can read a version
    /// out of; where varlock is running as JavaScript the daemon resolves the
    /// package itself and that answer wins.
    public let varlockVersion: String?

    public init(
        projectName: String? = nil,
        projectPath: String? = nil,
        itemCounts: [String: Int] = [:],
        keys: [String: UnlockKeyDisplay] = [:],
        invocationMode: UnlockInvocationMode? = nil,
        varlockVersion: String? = nil
    ) {
        self.projectName = projectName
        self.projectPath = projectPath
        self.itemCounts = itemCounts
        self.keys = keys
        self.invocationMode = invocationMode
        self.varlockVersion = varlockVersion
    }

    public var isEmpty: Bool {
        return projectName == nil && projectPath == nil && itemCounts.isEmpty && keys.isEmpty
            && invocationMode == nil && varlockVersion == nil
    }

    /// How many values a key covers, from either form the client sent.
    public func valueCount(forKey keyId: String) -> Int? {
        return keys[keyId]?.valueCount ?? itemCounts[keyId]
    }

    /// Which vault a key sits in, defaulting to the one implicit local vault
    /// every key is in until there are vaults to be in.
    public func vaultId(forKey keyId: String) -> String {
        return keys[keyId]?.vaultId ?? VaultBoundary.localVaultId
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
            invocationMode: UnlockInvocationMode(wireValue: display["invocationMode"] as? String),
            varlockVersion: ExecutionChainBuilder.versionText(display["varlockVersion"])
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
    ///   - preselection: where the two controls open, and why. Worked out in
    ///     `UnlockDefaults`, which is the one place that decision is made.
    public static func build(
        plan: UnlockPlan,
        requester: PanelRequester,
        display: UnlockDisplayInfo = UnlockDisplayInfo(),
        lockOn: SessionLockPolicy = .builtInDefault,
        preselection: UnlockPreselection? = nil
    ) -> PanelContent {
        var details = requester.details
        if let project = projectLine(display) {
            details.append(.clientSupplied(project))
        }
        let rows = plan.promptKeys.map { row(for: $0, display: display) }

        return PanelContent(
            titleSegments: titleSegments(for: plan),
            subtitle: projectSubtitle(display),
            requester: PanelRequester(
                summary: requester.summary,
                details: details,
                chain: requester.chain
            ),
            keyRows: rows,
            notes: notes(for: plan),
            factLine: factLine(plan: plan, lockOn: lockOn),
            invocationMode: display.invocationMode,
            sessionAdvisories: sessionAdvisories(
                session: requester.chain?.agentSession,
                projectPath: display.projectPath
            ),
            reportedVarlockVersion: display.varlockVersion,
            scopes: plan.offeredScopes,
            defaultScope: preselection?.window.scope ?? plan.defaultScope,
            breadths: plan.offeredBreadths,
            defaultBreadth: preselection?.breadth ?? plan.offeredBreadths.last ?? .wholeKey,
            listedItemCount: plan.listedItemCount,
            vaultCount: max(1, plan.vaultIds.count),
            // The caveat is only worth a line where the choice it qualifies is
            // actually on the panel.
            hasUnlistableSource: plan.offersBreadthChoice
                && (plan.hasUnlistableSource || rows.contains { row in row.sources.contains { !$0.isItemScopable } }),
            selectionNote: preselection?.note,
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
            sources: supplied?.sources ?? [],
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

    /// What is unusual about the agent session this request came from.
    ///
    /// Two things earn a line, and nothing else does:
    ///
    ///   - NOBODY IS WATCHING. A headless or print-mode agent has no person in
    ///     front of it, and "approve for this session" then means approving for
    ///     something that will keep going unobserved.
    ///   - THE AGENT IS SOMEWHERE ELSE. An agent working in one project asking to
    ///     open another project's secrets is exactly the shape this panel exists
    ///     to make visible. Both halves are needed to say it, and both are weak
    ///     on their own: the session's directory is the agent's own record of
    ///     itself, and the project is what the client said. So it is worded as an
    ///     observation and never as an accusation, and it never blocks anything.
    ///
    /// Silence when either side is missing. "The agent did not say where it is"
    /// is not evidence of anything.
    public static func sessionAdvisories(session: AgentSession?, projectPath: String?) -> [String] {
        guard let session else { return [] }
        var advisories: [String] = []
        if let unattended = session.unattendedNote { advisories.append(unattended) }
        if isWorkingOutside(session: session, projectPath: projectPath) {
            advisories.append("this session is working in \(abbreviated(session.workingDirectory ?? "")), "
                + "not in the project above")
        }
        return advisories
    }

    /// The second of those two, on its own.
    ///
    /// Split out because the preselection rules need the FACT and not the
    /// sentence. Reading it back out of the advisory text would tie what varlock
    /// preselects to how a line of copy happens to be worded, and the next
    /// person to improve that wording would silently turn a risk rule off.
    public static func isWorkingOutside(session: AgentSession?, projectPath: String?) -> Bool {
        guard let cwd = session?.workingDirectory, let projectPath else { return false }
        return !pathIsInside(cwd, of: projectPath)
    }

    /// Whether one path is the same directory as another or sits inside it.
    ///
    /// Compared on standardized, symlink-resolved paths, because the two sides
    /// arrive by different routes: `/tmp/x` and `/private/tmp/x` are the same
    /// directory, a worktree reached through a symlink is the same directory as
    /// the one it links to, and a panel that cried anomaly over either would be
    /// trained away inside a week. The comparison is on whole components, so
    /// `/a/project-two` is not inside `/a/project`.
    static func pathIsInside(_ path: String, of parent: String) -> Bool {
        let child = canonical(path)
        let root = canonical(parent)
        guard !child.isEmpty, !root.isEmpty else { return false }
        if child == root { return true }
        return child.hasPrefix(root == "/" ? root : root + "/")
    }

    /// The macOS firmlinks that make one directory reachable by two names.
    ///
    /// `resolvingSymlinksInPath` collapses these, but only for a path that
    /// exists, and neither of the paths being compared here is guaranteed to
    /// still be on disk by the time the panel draws. Stripping the prefix
    /// outright makes the comparison the same either way.
    static let privatePrefixes = ["/private/tmp", "/private/var", "/private/etc"]

    private static func canonical(_ path: String) -> String {
        var resolved = NSString(string: NSString(string: path).expandingTildeInPath)
            .resolvingSymlinksInPath
        resolved = NSString(string: resolved).standardizingPath
        for prefix in privatePrefixes where resolved == prefix || resolved.hasPrefix(prefix + "/") {
            resolved = String(resolved.dropFirst("/private".count))
            break
        }
        // `standardizingPath` already drops a trailing slash, but a caller can
        // hand us "/" and a root of "/" must not become "".
        if resolved.count > 1, resolved.hasSuffix("/") { resolved.removeLast() }
        return resolved
    }

    /// A path with the home directory folded back to `~`, for a line of prose.
    static func abbreviated(_ path: String) -> String {
        let home = NSHomeDirectory()
        guard !home.isEmpty, path.hasPrefix(home) else { return path }
        return "~" + path.dropFirst(home.count)
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
