import XCTest
@testable import IdentitySessions

/// The typed window, and the promise that it can never be illegal.
///
/// The sensor is armed while somebody is typing into this field, so every one of
/// these is really a statement about what a scan landing mid-word would grant.
final class CustomDurationTests: XCTestCase {
    func testNothingATyperCanDoProducesAnIllegalWindow() {
        // Empty, blank, nonsense and zero all read as the floor rather than as a
        // complaint. There is no error state to get stuck in, which is the whole
        // reason this is a clamp and not a validator.
        for text in ["", "   ", "abc", "0", "-4", "  0  "] {
            XCTAssertEqual(
                CustomDuration.parse(text, unit: .minutes),
                CustomDuration(amount: 1, unit: .minutes),
                "\(text) should read as the floor"
            )
        }
        // Past the cap reads as the cap, in whichever unit is showing.
        XCTAssertEqual(
            CustomDuration.parse("9999", unit: .minutes).milliseconds,
            SessionGrantTable.maxGrantMs
        )
        XCTAssertEqual(
            CustomDuration.parse("48", unit: .hours).milliseconds,
            SessionGrantTable.maxGrantMs
        )
        // A number too large to even be a number is still somebody asking for
        // more than the cap, and reads as the cap rather than as the floor.
        XCTAssertEqual(
            CustomDuration.parse("99999999999999999999999", unit: .hours).milliseconds,
            SessionGrantTable.maxGrantMs
        )
    }

    func testAPartialNumberIsAlwaysShorterThanTheOneBeingTyped() {
        // The property that makes it safe to grant whatever the field currently
        // holds: every prefix of a number somebody is typing is smaller than the
        // number, so a scan landing mid-word can only ever come out narrower.
        let target = "240"
        var previous: Int64 = 0
        for length in 1...target.count {
            let partial = CustomDuration.parse(String(target.prefix(length)), unit: .minutes)
            XCTAssertGreaterThanOrEqual(partial.milliseconds, previous)
            previous = partial.milliseconds
        }
        XCTAssertEqual(previous, CustomDuration(amount: 240, unit: .minutes).milliseconds)
    }

    func testSwitchingUnitsConvertsTheWindowRatherThanRereadingTheNumber() {
        // The mistake this exists to rule out: 90 minutes becoming 90 hours.
        XCTAssertEqual(
            CustomDuration(amount: 90, unit: .minutes).converted(to: .hours),
            CustomDuration(amount: 1, unit: .hours)
        )
        XCTAssertEqual(
            CustomDuration(amount: 2, unit: .hours).converted(to: .minutes),
            CustomDuration(amount: 120, unit: .minutes)
        )
        // A window that does not divide evenly rounds to the SHORTER neighbour,
        // so the rounding a unit switch does can only narrow a grant.
        XCTAssertEqual(
            CustomDuration(amount: 119, unit: .minutes).converted(to: .hours),
            CustomDuration(amount: 1, unit: .hours)
        )
        // Except below one whole unit, where there is no shorter answer left.
        XCTAssertEqual(
            CustomDuration(amount: 5, unit: .minutes).converted(to: .hours),
            CustomDuration(amount: 1, unit: .hours)
        )
        // And the cap holds across the switch in both directions.
        XCTAssertEqual(
            CustomDuration(amount: 720, unit: .minutes).converted(to: .hours),
            CustomDuration(amount: 12, unit: .hours)
        )
        XCTAssertEqual(
            CustomDuration(amount: 12, unit: .hours).converted(to: .minutes),
            CustomDuration(amount: 720, unit: .minutes)
        )
    }

    func testAValueComesBackInTheUnitThatSaysItMostPlainly() {
        // What a remembered window looks like when it returns: whole hours in
        // hours, everything else in minutes, so nothing comes back as a fraction
        // of something.
        XCTAssertEqual(
            CustomDuration.forMilliseconds(2_700_000),
            CustomDuration(amount: 45, unit: .minutes)
        )
        XCTAssertEqual(
            CustomDuration.forMilliseconds(7_200_000),
            CustomDuration(amount: 2, unit: .hours)
        )
        XCTAssertEqual(
            CustomDuration.forMilliseconds(5_400_000),
            CustomDuration(amount: 90, unit: .minutes)
        )
        // And a value past the cap comes back at the cap rather than as a rung
        // the grant table would clip.
        XCTAssertEqual(
            CustomDuration.forMilliseconds(999_999_999),
            CustomDuration(amount: 12, unit: .hours)
        )
    }

    func testTheRungAndTheSentenceSayTheSameThingInTwoRegisters() {
        XCTAssertEqual(DurationText.short(2_700_000), "45min")
        XCTAssertEqual(DurationText.prose(2_700_000), "45 minutes")
        XCTAssertEqual(DurationText.short(3_600_000), "1hr")
        XCTAssertEqual(DurationText.prose(3_600_000), "1 hour")
        XCTAssertEqual(DurationText.short(600_000), "10min")
        XCTAssertEqual(DurationText.prose(600_000), "10 minutes")
        XCTAssertEqual(DurationText.short(60_000), "1min")
        XCTAssertEqual(DurationText.prose(60_000), "1 minute")
    }

    func testTheFieldOpensOnSomethingShorterThanTheLongestPreset() {
        // An untouched control must not assert more than the row was already
        // offering, so somebody who picks the custom rung and then walks away is
        // never handed a longer window than the presets beside it.
        let longestPreset = DurationPreset.allCases.map { $0.milliseconds }.max() ?? 0
        XCTAssertLessThan(CustomDuration.unset.milliseconds, longestPreset)
        // And it is not a copy of a preset either, which would make the fresh
        // custom rung a duplicate of a rung to its left.
        XCTAssertFalse(DurationPreset.allCases.contains { $0.milliseconds == CustomDuration.unset.milliseconds })
    }

    func testTheLegacyPanelStatesTheWindowItReallyGrants() {
        // The panel used to say "Allowed for: once" over a note admitting "a few
        // minutes". The number now comes from the constant handed to macOS, and
        // it is an upper bound because the reuse is a ceiling, not a promise.
        XCTAssertEqual(
            LegacyDeviceKeyPanel.windowFactLine(reuse: 300),
            "Allowed for up to 5 minutes"
        )
        XCTAssertEqual(
            LegacyDeviceKeyPanel.windowFactLine(reuse: 60),
            "Allowed for up to 1 minute"
        )
        XCTAssertTrue(LegacyDeviceKeyPanel.formatNote(reuse: 300).contains("up to 5 minutes"))
    }
}
