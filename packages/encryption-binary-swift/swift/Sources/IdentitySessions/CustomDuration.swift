import Foundation

/// The duration a person types in, and the rules that keep it honest.
///
/// The ladder's fixed rungs cover the two windows most approvals want. This is
/// the rung for the one they do not: a number and the unit it is in, bounded at
/// both ends, with no way to express something the grant table would refuse.
///
/// Every rule here is a CLAMP, never an error. A security panel that can be put
/// into a state where nothing legal is selected is a panel that stops somebody
/// approving a read they meant to approve, and the reflex it teaches is to
/// hammer the field until the complaint goes away. So empty reads as the floor,
/// nonsense reads as the floor, and anything past the cap reads as the cap. The
/// field always holds a value the panel can act on truthfully, which is what
/// lets the sensor stay armed while somebody is typing into it.

/// The two units a window may be named in.
///
/// Two, not a menu of them. Minutes and hours span everything between the floor
/// and the 12h cap, and a third unit would only be a way of naming a window that
/// is not on offer.
public enum DurationUnit: String, CaseIterable, Equatable {
    case minutes = "min"
    case hours = "hr"

    /// How the unit is written beside a number, on the toggle and on the rung.
    public var suffix: String { rawValue }

    public var milliseconds: Int64 {
        switch self {
        case .minutes: return 60_000
        case .hours: return 3_600_000
        }
    }

    /// The cap, said in this unit: 720 minutes, or 12 hours. The same ceiling
    /// either way, so switching units can never be a way around it.
    public var maxAmount: Int64 { SessionGrantTable.maxGrantMs / milliseconds }

    /// The floor. Above zero, because a window of no time is not an approval,
    /// it is a refusal wearing one's clothes.
    public static let minAmount: Int64 = 1
}

/// A number and its unit, already clamped.
///
/// There is no way to hold an out-of-range one: the initialiser clamps, so every
/// value that exists is a window the daemon would actually grant. Callers never
/// have to ask whether the thing they are holding is valid.
public struct CustomDuration: Equatable {
    public let amount: Int64
    public let unit: DurationUnit

    public init(amount: Int64, unit: DurationUnit) {
        self.unit = unit
        self.amount = min(max(DurationUnit.minAmount, amount), unit.maxAmount)
    }

    public var milliseconds: Int64 { amount * unit.milliseconds }

    /// What the rung says once a value is set: `45min`, `2hr`.
    public var shortLabel: String { "\(amount)\(unit.suffix)" }

    /// Where the custom rung opens before anybody has set a value.
    ///
    /// Above the longest preset on purpose. The rung sits to the right of the
    /// presets, and a ladder whose fresh state reads left to right as ascending
    /// is the ladder the order is supposed to be telling you about. A value
    /// below `1hr` is perfectly allowed once chosen; it just is not what an
    /// untouched control should assert.
    public static let unset = CustomDuration(amount: 2, unit: .hours)

    /// Read whatever is in the field right now.
    ///
    /// Deliberately total. Empty, blank, `abc`, `0`, `-4`, `99999999999999999999`
    /// and `12 hours` all come back as a legal window rather than as a
    /// complaint: the leading digits are taken, everything else is dropped, and
    /// the result is clamped. A number too large for `Int64` reads as the cap,
    /// since that is the only thing somebody typing twenty digits can have
    /// meant.
    public static func parse(_ text: String, unit: DurationUnit) -> CustomDuration {
        let digits = text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .prefix { $0.isNumber }
        guard !digits.isEmpty else { return CustomDuration(amount: DurationUnit.minAmount, unit: unit) }
        guard let amount = Int64(digits) else { return CustomDuration(amount: unit.maxAmount, unit: unit) }
        return CustomDuration(amount: amount, unit: unit)
    }

    /// The same window said in the other unit.
    ///
    /// Converts the VALUE, never reinterprets the number: 90 minutes switched to
    /// hours is one hour, not ninety of them. Where the window does not divide
    /// evenly the shorter neighbour wins, so the rounding a unit switch does can
    /// only ever narrow a grant. Below one whole unit there is no shorter answer
    /// left and the floor applies, which is the one case where switching units
    /// lengthens a window; it is visible in the field the moment it happens.
    public func converted(to newUnit: DurationUnit) -> CustomDuration {
        guard newUnit != unit else { return self }
        return CustomDuration(amount: milliseconds / newUnit.milliseconds, unit: newUnit)
    }

    /// A duration in milliseconds, in the unit that says it most plainly.
    ///
    /// Whole hours come back as hours and everything else as minutes, so a
    /// remembered `2h` comes back reading `2hr` and a remembered `45min` comes
    /// back reading `45min` rather than as a fraction of something.
    public static func forMilliseconds(_ milliseconds: Int64) -> CustomDuration {
        let parts = DurationText.parts(milliseconds)
        return CustomDuration(amount: parts.amount, unit: parts.unit)
    }
}

/// A window, written down. Two registers, one rule for both.
public enum DurationText {
    /// The compact form a rung carries: `10min`, `1hr`, `45min`.
    public static func short(_ milliseconds: Int64) -> String {
        let parts = parts(milliseconds)
        return "\(parts.amount)\(parts.unit.suffix)"
    }

    /// The prose form the summary sentence uses: "10 minutes", "1 hour".
    ///
    /// Spelled out because that line is a sentence somebody reads, and `for 1hr`
    /// reads as a setting rather than as an answer to how long this lasts.
    public static func prose(_ milliseconds: Int64) -> String {
        let parts = parts(milliseconds)
        let noun: String
        switch parts.unit {
        case .minutes: noun = parts.amount == 1 ? "minute" : "minutes"
        case .hours: noun = parts.amount == 1 ? "hour" : "hours"
        }
        return "\(parts.amount) \(noun)"
    }

    /// Whole hours are said in hours; everything else is said in minutes,
    /// rounded to the nearest one and never down to nothing.
    static func parts(_ milliseconds: Int64) -> (amount: Int64, unit: DurationUnit) {
        let clamped = min(max(1, milliseconds), SessionGrantTable.maxGrantMs)
        let hour = DurationUnit.hours.milliseconds
        if clamped >= hour, clamped % hour == 0 {
            return (clamped / hour, .hours)
        }
        let minute = DurationUnit.minutes.milliseconds
        return (max(1, (clamped + minute / 2) / minute), .minutes)
    }
}
