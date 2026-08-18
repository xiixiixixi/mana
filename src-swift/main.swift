import Cocoa
import WebKit
import UserNotifications

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// MARK: - PasteWebView
class PasteWebView: WKWebView {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.contains(.command) && event.charactersIgnoringModifiers == "v" {
            guard let text = NSPasteboard.general.string(forType: .string) else { return false }
            let escaped = text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'").replacingOccurrences(of: "\n", with: "\\n").replacingOccurrences(of: "\r", with: "")
            evaluateJavaScript("var e=document.activeElement;if(e&&(e.tagName==='INPUT'||e.tagName==='TEXTAREA')){e.value+='\(escaped)';e.dispatchEvent(new Event('input',{bubbles:true}))}", completionHandler: nil)
            return true
        }
        if event.modifierFlags.contains(.command) && ["c","x","a"].contains(event.charactersIgnoringModifiers ?? "") { return super.performKeyEquivalent(with: event) }
        return super.performKeyEquivalent(with: event)
    }
}

// MARK: - Config（与 Node 端 .config.json 共享：通知阈值 + 菜单栏模式）
struct AppConfig {
    var notifyEnabled = true
    var warnPct = 20.0
    var criticalPct = 10.0
    var balanceWarn = 2.0
    var menubarMode = 2
    var attentionPct = 80.0

    static func load() -> AppConfig {
        var c = AppConfig()
        guard let url = configFileURL(), let data = try? Data(contentsOf: url) else { return c }
        guard let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return c }
        if let n = j["notify"] as? [String: Any] {
            if let v = n["enabled"] as? Bool { c.notifyEnabled = v }
            if let v = n["warnPct"] as? Double { c.warnPct = v }
            if let v = n["criticalPct"] as? Double { c.criticalPct = v }
            if let v = n["balanceWarn"] as? Double { c.balanceWarn = v }
        }
        if let u = j["ui"] as? [String: Any] {
            if let v = u["menubarMode"] as? Double { c.menubarMode = Int(v) }
            if let v = u["attentionPct"] as? Double { c.attentionPct = v }
        }
        return c
    }
}
func configFileURL() -> URL? {
    let resURL = URL(fileURLWithPath: Bundle.main.resourcePath!)
    let bundled = resURL.appendingPathComponent(".config.json")
    if FileManager.default.fileExists(atPath: bundled.path) { return bundled }
    // Dev mode: 项目根（与 server.js 同目录）
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    return root.appendingPathComponent(".config.json")
}

// MARK: - Status Items（锚点仪表 + 每平台一个指示）
// [仪表][Codex 30%][智谱 66%]…——各平台独立显示自己的最低剩余，互不顶替；
// 每个指示可被用户 cmd-拖动排序/移除（NSStatusItem 原生行为）
let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
if let button = statusItem.button {
    if let img = NSImage(systemSymbolName: "gauge", accessibilityDescription: "Mana") {
        img.isTemplate = true
        img.size = NSSize(width: 15, height: 15)
        button.image = img
    }
    button.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .bold)
    button.target = AppDelegate.shared
    button.action = #selector(AppDelegate.toggleMain)
    button.sendAction(on: [.leftMouseUp, .rightMouseUp])
}

struct MenubarEntry {
    let id: String          // provider id
    let name: String        // 菜单栏显示名
    var pct: Double?        // 该平台全部额度/全部 key 的最低剩余%；余额型为 nil
    var balanceText: String // 余额型显示（如 ¥3.3k）
}
var providerItems: [String: NSStatusItem] = [:]
let menubarNames = [
    "codex": "Codex", "grok": "Grok", "github-copilot": "Copilot",
    "zhipu": "智谱", "minimax": "MiniMax", "kimi": "Kimi", "moonshot": "Moonshot",
    "deepseek": "DeepSeek", "openrouter": "OpenRouter", "siliconflow": "硅基",
]
func makeProviderItem() -> NSStatusItem {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let b = item.button {
        b.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .bold)
        b.target = AppDelegate.shared
        b.action = #selector(AppDelegate.toggleMain)
        b.sendAction(on: [.leftMouseUp, .rightMouseUp])
    }
    return item
}
func menubarColor(_ pct: Double?) -> NSColor {
    guard let p = pct else { return .labelColor }
    if p < 5 { return NSColor(red: 0.94, green: 0.27, blue: 0.27, alpha: 1) }
    if p < 20 { return NSColor(red: 0.91, green: 0.70, blue: 0.03, alpha: 1) }
    return .labelColor
}
func blocksText(_ pct: Double) -> String {
    let n = Int((pct / 10).rounded())
    return String(repeating: "█", count: n) + String(repeating: "░", count: 10 - n)
}
func compactBalance(_ v: Double) -> String {
    if v >= 10000 { return String(format: "%.1fw", v / 10000) }
    if v >= 1000 { return String(format: "%.1fk", v / 1000) }
    return String(format: "%.0f", v)
}
func applyMenubar(_ entries: [MenubarEntry]) {
    DispatchQueue.main.async {
        let cfg = AppConfig.load()
        if cfg.menubarMode == 1 { applyItems([]); return }
        // 注意力模式：刘海屏菜单栏空间极其有限（溢出项会被系统藏到刘海后），
        // 只有剩余低于 attentionPct 的平台才占一个菜单栏位；健康平台在 popover 看全貌
        let visible = entries.filter { e in
            if let p = e.pct { return p < cfg.attentionPct }
            return false // 余额型/无限型不常驻菜单栏（告警走系统通知）
        }
        applyItems(visible.sorted { ($0.pct ?? 100) < ($1.pct ?? 100) })
    }
}
func applyItems(_ visible: [MenubarEntry]) {
    let cfg = AppConfig.load()
    // 移除消失的平台
    let visibleIds = Set(visible.map { $0.id })
    for (id, item) in providerItems where !visibleIds.contains(id) {
        NSStatusBar.system.removeStatusItem(item)
        providerItems.removeValue(forKey: id)
    }
    for e in visible {
        var title = e.name
        if let p = e.pct {
            title += cfg.menubarMode == 3 ? " " + blocksText(p) : " \(Int(p))%"
        } else if !e.balanceText.isEmpty {
            title += " " + e.balanceText
        }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .bold),
            .foregroundColor: menubarColor(e.pct),
        ]
        if let item = providerItems[e.id] {
            item.button?.attributedTitle = NSAttributedString(string: title, attributes: attrs)
        } else {
            let item = makeProviderItem()
            item.button?.attributedTitle = NSAttributedString(string: title, attributes: attrs)
            providerItems[e.id] = item
        }
    }
}

// MARK: - Main Popover
let mainPopover = NSPopover()
mainPopover.behavior = .transient
mainPopover.animates = true
let mainWV = PasteWebView(frame: NSRect(x: 0, y: 0, width: 380, height: 700))
mainWV.setValue(false, forKey: "drawsBackground")
mainWV.loadHTMLString("""
<html><head><meta charset=\"UTF-8\"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#fafafa;color:#111;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}
.spinner{width:24px;height:24px;border:2px solid #e5e7eb;border-top-color:#111;border-radius:50%;animation:spin .6s linear infinite;margin:0 auto 14px}
@keyframes spin{to{transform:rotate(360deg)}}
p{color:#9ca3af;font-size:13px}
</style></head>
<body><div style=\"text-align:center\"><div class=\"spinner\"></div><p>正在启动 Mana…</p></div></body></html>
""", baseURL: nil)
mainPopover.contentViewController = { let vc = NSViewController(); vc.view = mainWV; return vc }()
mainPopover.contentSize = NSSize(width: 380, height: 700)

// MARK: - Settings Window
var settingsWindow: NSWindow?
func showSettings() {
    mainPopover.close()
    if let w = settingsWindow, w.isVisible { w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 560), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    w.title = "Mana Settings"; w.isReleasedWhenClosed = false; w.level = .floating
    w.collectionBehavior = [.canJoinAllSpaces, .stationary]
    let wv = PasteWebView(frame: NSRect(x: 0, y: 0, width: 380, height: 560))
    wv.setValue(false, forKey: "drawsBackground")
    wv.navigationDelegate = nav
    wv.uiDelegate = nav
    w.contentView = wv; w.center()
    wv.load(URLRequest(url: URL(string: "http://127.0.0.1:41119/settings.html")!))
    settingsWindow = w; w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
}

// MARK: - Nav Delegate
class Nav: NSObject, WKNavigationDelegate, WKUIDelegate {
    func webView(_ wv: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if a.request.url?.scheme == "mana" {
            let host = a.request.url?.host ?? ""
            let qs = a.request.url?.absoluteString ?? ""
            if host == "settings" { showSettings() }
            if host == "refresh" { DispatchQueue.global().async { self.reloadWithData(); refresh() } }
            if host == "notify-test" { postNotification(title: "Mana", body: "通知测试 · 阈值告警将出现在这里") }
            if host == "open", let r = qs.range(of: "url="),
               let u = qs[r.upperBound...].removingPercentEncoding,
               let url = URL(string: u) {
                NSWorkspace.shared.open(url)
            }
            if host == "copy", let r = qs.range(of: "text=") {
                let t = String(qs[r.upperBound...]).removingPercentEncoding ?? ""
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(t, forType: .string)
            }
            decisionHandler(.cancel); return
        }
        // Open external links in default browser
        if let host = a.request.url?.host, host != "127.0.0.1", host != "localhost" {
            NSWorkspace.shared.open(a.request.url!)
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webViewDidClose(_ webView: WKWebView) {
        // Handle window.close() in JS — close the containing NSWindow
        webView.window?.close()
    }
    func reloadWithData() {
        DispatchQueue.main.async {
            print("[mana] navigating to popover.html")
            mainWV.load(URLRequest(url: URL(string: "http://127.0.0.1:41119/popover.html")!))
        }
    }
}
let nav = Nav()
mainWV.navigationDelegate = nav
mainWV.uiDelegate = nav

// MARK: - Node
var node: Process?
func startNode() {
    let resURL = URL(fileURLWithPath: Bundle.main.resourcePath!)
    let bundledNode = resURL.appendingPathComponent("node")
    let bundledServer = resURL.appendingPathComponent("server.js")
    let proc = Process()
    // Bundled mode: everything in Resources/
    if FileManager.default.fileExists(atPath: bundledServer.path) {
        proc.executableURL = bundledNode
        proc.arguments = [bundledServer.path]
        proc.currentDirectoryURL = resURL
        proc.standardOutput = nil; proc.standardError = nil
        do { try proc.run(); node = proc; print("[mana] node started (bundled)") }
        catch { print("[mana] node start: \(error)") }
        return
    }
    // Dev mode: use source directory + system node
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    let nodePaths = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
    let nodePath = nodePaths.first { FileManager.default.fileExists(atPath: $0) }
    guard let nPath = nodePath else { print("[mana] node not found"); return }
    proc.executableURL = URL(fileURLWithPath: nPath)
    proc.arguments = [root.appendingPathComponent("server.js").path]
    proc.currentDirectoryURL = root
    proc.standardOutput = nil; proc.standardError = nil
    do { try proc.run(); node = proc; print("[mana] node started at \(nPath)") }
    catch { print("[mana] node start: \(error)") }
}


// MARK: - Refresh（统一”剩余”语义：与 services/remaining.js 同规则）
var timer: Timer?
func startRefresh() {
    timer = Timer.scheduledTimer(withTimeInterval: 180, repeats: true) { _ in refresh() }
    // 启动竞态保护：首次刷新时 Node 侧 provider 抓取可能未完成（失败的平台要等 300s 才补上），
    // 用 3/10/20/40s 密集重试收敛，之后交给 300s 常规节奏
    for delay in [3.0, 10.0, 20.0, 40.0] {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { refresh() }
    }
}
func refresh() {
    guard let url = URL(string: "http://127.0.0.1:41119/api/usage") else { return }
    URLSession.shared.dataTask(with: url) { d, _, e in
        guard let d = d, e == nil, let j = try? JSONSerialization.jsonObject(with: d) as? [String:Any],
              let ps = j["providers"] as? [[String:Any]] else { return } // 失败时保留上次的菜单栏状态
        var checks: [(name: String, label: String, q: [String: Any])] = []
        // 按平台聚合：每平台取其全部额度（含多 key 展开）的最低剩余%；余额型平台汇总余额
        struct Agg { var minPct: Double?; var balSum: Double?; var unit: String; var hasUnlimited = false }
        var agg: [String: Agg] = [:]
        var order: [String] = []
        for p in ps {
            guard let pid = p["id"] as? String, p["status"] as? String != "error" else { continue }
            let pName = p["name"] as? String ?? "?"
            let disp = (p["label"] as? String).map { "\(pName)·\($0)" } ?? pName
            if agg[pid] == nil { agg[pid] = Agg(minPct: nil, balSum: nil, unit: ""); order.append(pid) }
            for q in p["quotas"] as? [[String:Any]] ?? [] {
                var remPct: Double? = nil
                if let t = q["total"] as? Double, t > 0 {
                    if let u = q["used"] as? Double { remPct = (1 - u / t) * 100 }
                    else if let b = q["balance"] as? Double { remPct = b / t * 100 }
                }
                if let r = remPct {
                    let c = min(max(r, 0), 100)
                    agg[pid]!.minPct = min(agg[pid]!.minPct ?? c, c)
                } else if let b = q["balance"] as? Double {
                    agg[pid]!.balSum = (agg[pid]!.balSum ?? 0) + b
                    if agg[pid]!.unit.isEmpty { agg[pid]!.unit = q["unit"] as? String ?? "" }
                } else if q["unlimited"] as? Bool == true {
                    agg[pid]!.hasUnlimited = true
                }
                checks.append((disp, q["label"] as? String ?? "额度", q))
            }
        }
        let entries = order.map { pid -> MenubarEntry in
            let a = agg[pid]!
            let name = menubarNames[pid] ?? pid
            var bal = a.minPct == nil && a.balSum != nil ? (a.unit + compactBalance(a.balSum!)) : ""
            if a.minPct == nil && a.balSum == nil && a.hasUnlimited { bal = "∞" }
            return MenubarEntry(id: pid, name: name, pct: a.minPct, balanceText: bal)
        }
        applyMenubar(entries)
        checkNotifications(checks)
        NSLog("[tln] refresh: %d entries", entries.count)
    }.resume()
}

// MARK: - Notifications（阈值告警 + 去重 + 暂停）
// 权限懒申请：不在启动时弹窗（用户会反射性拒绝），首次真正需要发通知时才请求。
// 被拒绝过则引导去系统设置。
func postNotification(title: String, body: String) {
    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { s in
        switch s.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            fireNotification(title: title, body: body)
        case .notDetermined:
            center.requestAuthorization(options: [.alert, .sound]) { ok, err in
                if ok { fireNotification(title: title, body: body) }
                else { NSLog("[tln] notify auth denied: %@", err?.localizedDescription ?? "?") }
            }
        case .denied:
            DispatchQueue.main.async {
                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings")!)
            }
        @unknown default:
            break
        }
    }
}
private func fireNotification(title: String, body: String) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    content.interruptionLevel = .timeSensitive // 尽量穿透专注模式
    let req = UNNotificationRequest(identifier: "tln-\(UUID().uuidString)", content: content, trigger: nil)
    UNUserNotificationCenter.current().add(req) { err in
        if let err = err { NSLog("[tln] notify add failed: %@", err.localizedDescription) }
    }
}
func pauseUntil() -> TimeInterval {
    let ts = UserDefaults.standard.double(forKey: "tln.pauseUntil")
    return ts
}
func checkNotifications(_ checks: [(name: String, label: String, q: [String: Any])]) {
    let cfg = AppConfig.load()
    guard cfg.notifyEnabled else { return }
    if Date().timeIntervalSince1970 < pauseUntil() { return }
    // 授权未决定/被拒时不记录去重快照（否则授权完成前的阈值跨越会被白吃掉，
    // 用户授权后再也不触发——"通知一直不推"的一个根因）
    UNUserNotificationCenter.current().getNotificationSettings { s in
        NSLog("[tln] notify authStatus=%d checks=%d", s.authorizationStatus.rawValue, checks.count)
        switch s.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            checkNotificationsAuthorized(checks, cfg: cfg)
        case .notDetermined:
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .timeSensitive]) { ok, _ in
                if ok { checkNotificationsAuthorized(checks, cfg: cfg) }
            }
        case .denied:
            break
        @unknown default:
            break
        }
    }
}
private func checkNotificationsAuthorized(_ checks: [(name: String, label: String, q: [String: Any])], cfg: AppConfig) {
    let snapKey = "tln.notifySnap"
    var snap = UserDefaults.standard.dictionary(forKey: snapKey) as? [String: Int] ?? [:]
    var changed = false
    for c in checks {
        let key = "\(c.name)|\(c.label)"
        // tier: 0=ok 1=warn 2=critical（剩余越少 tier 越高；余额型用绝对阈值）
        var tier = 0
        var bodyText: String? = nil
        if let t = c.q["total"] as? Double, t > 0 {
            var remPct: Double? = nil
            if let u = c.q["used"] as? Double { remPct = (1 - u / t) * 100 }
            else if let b = c.q["balance"] as? Double { remPct = b / t * 100 }
            if let r = remPct {
                if r < cfg.criticalPct { tier = 2 } else if r < cfg.warnPct { tier = 1 }
                if tier > 0 { bodyText = "\(c.label) 剩余 \(Int(r))%" }
            }
        } else if let b = c.q["balance"] as? Double, b < cfg.balanceWarn {
            tier = 1
            let unit = c.q["unit"] as? String ?? ""
            bodyText = "\(c.label) 余额 \(unit)\(b)（低于 \(cfg.balanceWarn)）"
        }
        let prev = snap[key] ?? 0
        // 只在 tier 升高时通知；回升到 阈值+20 以上重新武装
        if tier > prev && tier > 0 && bodyText != nil {
            let resetText = (c.q["resetIn"] as? String).map { "，\($0)后重置" } ?? ""
            postNotification(title: c.name, body: bodyText! + resetText)
        }
        snap[key] = tier
        if snap[key] != prev { changed = true }
    }
    if changed { UserDefaults.standard.set(snap, forKey: snapKey) }
}

// MARK: - App Delegate
class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    static let shared = AppDelegate()
    func applicationDidFinishLaunching(_ n: Notification) {
        UNUserNotificationCenter.current().delegate = self
        startNode(); startRefresh()
        DispatchQueue.global().async {
            for _ in 0..<30 { Thread.sleep(forTimeInterval: 0.5); if let u = URL(string: "http://127.0.0.1:41119/api/providers"), let _ = try? Data(contentsOf: u) { break } }
            DispatchQueue.main.async { nav.reloadWithData() }
        }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        // 点击通知 → 打开 popover
        DispatchQueue.main.async { show() }
        completionHandler()
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
    func applicationWillTerminate(_ n: Notification) { node?.terminate(); timer?.invalidate() }
    func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows f: Bool) -> Bool { show(); return true }
    @objc func toggleMain() {
        if let e = NSApp.currentEvent, e.type == .rightMouseUp {
            let menu = NSMenu()
            let paused = Date().timeIntervalSince1970 < pauseUntil()
            let pauseItem = NSMenuItem(title: paused ? "恢复通知" : "暂停通知 1 小时", action: #selector(togglePause), keyEquivalent: "")
            pauseItem.target = AppDelegate.shared
            menu.addItem(pauseItem)
            menu.addItem(NSMenuItem.separator())
            menu.addItem(NSMenuItem(title: "Quit Mana", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
            if let b = statusItem.button { NSMenu.popUpContextMenu(menu, with: e, for: b) }
            return
        }
        if mainPopover.isShown { mainPopover.close() } else { show() }
    }
    @objc func togglePause() {
        let d = UserDefaults.standard
        if Date().timeIntervalSince1970 < d.double(forKey: "tln.pauseUntil") {
            d.set(0, forKey: "tln.pauseUntil")
        } else {
            d.set(Date().timeIntervalSince1970 + 3600, forKey: "tln.pauseUntil")
        }
    }
}
    func show() { if let b = statusItem.button { mainPopover.show(relativeTo: b.bounds, of: b, preferredEdge: .minY) } }
app.delegate = AppDelegate.shared
app.run()
