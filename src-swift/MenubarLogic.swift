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

// 多额度平台（智谱 5h/每月/MCP、Codex 5h/每周）在菜单栏需拆条区分展示。

// 分组键：去掉括号备注（「5小时窗口 (Pro)」→「5小时窗口」），多 key/多套餐的同种窗口合并
func quotaGroupKey(_ label: String) -> String {
    let base = label.split(separator: "(", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? label
    return base.trimmingCharacters(in: .whitespaces)
}

// 额度标签 → 菜单栏短标签：「智谱·5h」「智谱·MCP」「Codex·周」
func menubarTag(_ label: String) -> String {
    let l = label.lowercased()
    if l.contains("mcp") { return "MCP" }
    if l.contains("5h") || label.contains("5小时") { return "5h" }
    if label.contains("周") || l.contains("week") { return "周" }
    if label.contains("月") || l.contains("month") { return "月" }
    if label.contains("日") || l.contains("day") { return "日" }
    if l.contains("premium") { return "Pro" }
    // 兜底：去掉「额度/窗口」后缀词，取第一个词的前 3 个字符
    let core = label.replacingOccurrences(of: "额度", with: "")
        .replacingOccurrences(of: "窗口", with: "")
        .split { $0 == " " || $0 == "·" }
        .first.map(String.init) ?? "?"
    return String(core.prefix(3))
}
