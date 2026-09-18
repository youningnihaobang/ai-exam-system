// 扫描版 / 图片型 PDF 的本地 OCR（仅 macOS，使用系统 Vision 框架，无需联网）
// 用法: swift ocr.swift <file.pdf>
// 输出: 提取的纯文本（stdout）；有文本层直接读文本层，否则渲染后 OCR
import Foundation
import PDFKit
import Vision
import AppKit

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write("usage: ocr.swift <pdf>\n".data(using: .utf8)!)
    exit(2)
}
let path = CommandLine.arguments[1]
guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else {
    FileHandle.standardError.write("cannot open pdf\n".data(using: .utf8)!)
    exit(3)
}

func ocrPage(_ page: PDFPage) -> String {
    let bounds = page.bounds(for: .mediaBox)
    let targetWidth: CGFloat = 1800
    let scale = max(1.5, targetWidth / max(bounds.width, 1))
    let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)

    let image = NSImage(size: size)
    image.lockFocus()
    guard let ctx = NSGraphicsContext.current?.cgContext else { return "" }
    NSColor.white.setFill()
    ctx.fill(CGRect(origin: .zero, size: size))
    ctx.saveGState()
    ctx.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: ctx)
    ctx.restoreGState()
    image.unlockFocus()

    guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return "" }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return ""
    }
    let lines = (request.results as? [VNRecognizedTextObservation])?
        .compactMap { $0.topCandidates(1).first?.string } ?? []
    return lines.joined(separator: "\n")
}

var out: [String] = []
for i in 0..<doc.pageCount {
    guard let page = doc.page(at: i) else { continue }
    let text = page.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if text.count > 30 {
        out.append(text)
    } else {
        out.append(ocrPage(page))
    }
    FileHandle.standardError.write("[ocr] page \(i + 1)/\(doc.pageCount)\n".data(using: .utf8)!)
}
print(out.joined(separator: "\n\n"))
