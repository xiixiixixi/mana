func blocksText(_ pct: Double) -> String {
    let safePct = pct.isFinite ? min(max(pct, 0), 100) : 0
    let filled = Int((safePct / 10).rounded())
    return String(repeating: "█", count: filled) + String(repeating: "░", count: 10 - filled)
}

enum MenubarAnchorState: Equatable {
    case normal
    case warning
    case critical

    // Mana 的识别图形始终保持仪表盘；状态只通过颜色表达，避免警示时突然换图标。
    var symbolName: String { "gauge" }
}

func anchorState(_ pcts: [Double], warnPct: Double, criticalPct: Double) -> MenubarAnchorState {
    let safePcts = pcts.filter(\.isFinite).map { min(max($0, 0), 100) }
    guard let lowest = safePcts.min() else { return .normal }
    if lowest < criticalPct { return .critical }
    if lowest < warnPct { return .warning }
    return .normal
}
