import AppKit
import Foundation
import Vision

struct BoundingBox: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct Region: Codable {
    let text: String
    let confidence: Float
    let bbox: BoundingBox
}

struct Result: Codable {
    let text: String
    let regions: [Region]
    let confidence: Float
}

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: docket-vision-ocr <image>\n".utf8))
    exit(2)
}

do {
    let url = URL(fileURLWithPath: CommandLine.arguments[1])
    guard let image = NSImage(contentsOf: url),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        throw NSError(domain: "DocketVisionOCR", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unable to decode image"])
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["ko-KR", "en-US"]
    request.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])

    let regions = (request.results ?? []).compactMap { observation -> Region? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        return Region(
            text: candidate.string,
            confidence: candidate.confidence,
            bbox: BoundingBox(
                x: box.minX,
                y: 1.0 - box.maxY,
                width: box.width,
                height: box.height
            )
        )
    }.sorted {
        abs($0.bbox.y - $1.bbox.y) < min($0.bbox.height, $1.bbox.height) * 0.5
            ? $0.bbox.x < $1.bbox.x
            : $0.bbox.y < $1.bbox.y
    }

    let confidence = regions.isEmpty
        ? 0
        : regions.reduce(Float(0)) { $0 + $1.confidence } / Float(regions.count)
    let result = Result(
        text: regions.map(\.text).joined(separator: "\n"),
        regions: regions,
        confidence: confidence
    )
    FileHandle.standardOutput.write(try JSONEncoder().encode(result))
} catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
}
