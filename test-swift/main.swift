import Foundation

func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
}

expect(anchorState([], warnPct: 20, criticalPct: 10) == .normal, "no quota should keep the gauge icon")
expect(anchorState([20], warnPct: 20, criticalPct: 10) == .normal, "warning threshold should use strict less-than semantics")
expect(anchorState([19.9], warnPct: 20, criticalPct: 10) == .warning, "low quota should enter warning state")
expect(anchorState([47.9, 9.9, 63.0], warnPct: 20, criticalPct: 10) == .critical, "the lowest quota should drive critical state")
expect(MenubarAnchorState.normal.symbolName == "gauge", "normal state should keep the Mana gauge")
expect(MenubarAnchorState.warning.symbolName == "gauge", "warning state must keep the Mana gauge")
expect(MenubarAnchorState.critical.symbolName == "gauge", "critical state must keep the Mana gauge")
expect(blocksText(0) == "░░░░░░░░░░", "zero percent should render ten empty cells")
expect(blocksText(100) == "██████████", "one hundred percent should render ten filled cells")
expect(blocksText(-5) == "░░░░░░░░░░", "block rendering should clamp negative input")
expect(blocksText(105) == "██████████", "block rendering should clamp input above one hundred")
expect(quotaGroupKey("5小时窗口 (Pro)") == "5小时窗口", "group key should drop the parenthetical plan note")
expect(quotaGroupKey("MCP月度") == "MCP月度", "plain labels should pass through unchanged")
expect(menubarTag("5h 窗口") == "5h", "zhipu 5h window should map to the 5h tag")
expect(menubarTag("5小时窗口 (Pro)") == "5h", "codex 5-hour window should map to the 5h tag")
expect(menubarTag("MCP月度") == "MCP", "zhipu MCP monthly quota should map to the MCP tag")
expect(menubarTag("每周额度 (Pro)") == "周", "weekly quota should map to the weekly tag")
expect(menubarTag("每月额度") == "月", "monthly quota should map to the monthly tag")
expect(menubarTag("每日额度") == "日", "daily quota should map to the daily tag")
expect(menubarTag("每周总额度") == "周", "minimax weekly total should also map to the weekly tag")
expect(menubarTag("Token额度") == "Tok", "unknown labels should fall back to a short prefix")

print("Swift menubar logic: 20 tests passed")
