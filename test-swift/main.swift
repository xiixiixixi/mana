import Foundation

func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
}

expect(anchorState([], warnPct: 20, criticalPct: 10) == .normal, "no quota should keep the gauge icon")
expect(anchorState([20], warnPct: 20, criticalPct: 10) == .normal, "warning threshold should use strict less-than semantics")
expect(anchorState([19.9], warnPct: 20, criticalPct: 10) == .warning, "low quota should use the warning icon")
expect(anchorState([47.9, 9.9, 63.0], warnPct: 20, criticalPct: 10) == .critical, "the lowest quota should drive critical state")
expect(blocksText(0) == "░░░░░░░░░░", "zero percent should render ten empty cells")
expect(blocksText(100) == "██████████", "one hundred percent should render ten filled cells")
expect(blocksText(-5) == "░░░░░░░░░░", "block rendering should clamp negative input")
expect(blocksText(105) == "██████████", "block rendering should clamp input above one hundred")

print("Swift menubar logic: 8 tests passed")
