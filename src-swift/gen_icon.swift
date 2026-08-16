// 生成 Mana App 图标：黑底 + 三行对齐块条（产品 UI 的微缩）
// 用法: swift gen_icon.swift <输出.png> [尺寸]
import AppKit

let size = CommandLine.arguments.count > 2 ? Int(CommandLine.arguments[2])! : 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let s = CGFloat(size)

let img = NSImage(size: NSSize(width: s, height: s))
img.lockFocus()
guard let ctx = NSGraphicsContext.current?.cgContext else { fatalError("no ctx") }

// macOS 圆角方形（近似 squircle，半径 ~22.4%）
let radius = s * 0.2237
let bgRect = CGRect(x: 0, y: 0, width: s, height: s)
let bgPath = CGPath(roundedRect: bgRect, cornerWidth: radius, cornerHeight: radius, transform: nil)
ctx.addPath(bgPath)
ctx.setFillColor(NSColor(calibratedRed: 0.067, green: 0.067, blue: 0.067, alpha: 1).cgColor)
ctx.fillPath()

// 三行块条：10 列对齐网格，左起填充
struct Row { let fill: Int; let color: NSColor }
let rows: [Row] = [
    Row(fill: 7, color: NSColor(calibratedWhite: 0.98, alpha: 1)),   // 近白
    Row(fill: 3, color: NSColor(calibratedWhite: 0.60, alpha: 1)),   // 灰
    Row(fill: 9, color: NSColor(calibratedRed: 1.0, green: 0.231, blue: 0.0, alpha: 1)), // 品牌橙
]
let cols = 10
let marginX = s * 0.24
let marginY = s * 0.27
let blockH = s * 0.088
let rowGap = s * 0.075
let cellW = (s - marginX * 2) / CGFloat(cols)
let blockW = cellW * 0.80
let blockR = blockH * 0.22

for (ri, row) in rows.enumerated() {
    let y = s - marginY - blockH - CGFloat(ri) * (blockH + rowGap)
    // 满格行的空位画极暗底块（终端“空槽”感）
    for c in 0..<cols {
        let x = marginX + CGFloat(c) * cellW + (cellW - blockW) / 2
        let r = CGRect(x: x, y: y, width: blockW, height: blockH)
        let p = CGPath(roundedRect: r, cornerWidth: blockR, cornerHeight: blockR, transform: nil)
        ctx.addPath(p)
        ctx.setFillColor(c < row.fill ? row.color.cgColor : NSColor(calibratedWhite: 0.16, alpha: 1).cgColor)
        ctx.fillPath()
    }
}

img.unlockFocus()

guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else { fatalError("encode") }
try png.write(to: URL(fileURLWithPath: out))
print("wrote \(out) (\(size)x\(size))")
