// perch-capture — continuous scaled JPEG frames of the main display, on stdout.
//
// The obvious alternative is shelling out to `screencapture` per frame, but
// that spawns a process and encodes a full-resolution JPEG every time. This
// keeps one ScreenCaptureKit stream open instead: the scaling happens on the
// GPU, and frames the system marks as unchanged are dropped before they cost
// us an encode.
//
//   perch-capture [--width 1200] [--fps 6] [--quality 0.5]
//
// Framing on stdout is a 4-byte big-endian length followed by that many bytes
// of JPEG. Exits when stdout closes. Needs Screen Recording permission.

import Foundation
import ScreenCaptureKit
import CoreImage
import CoreMedia

func arg(_ name: String, _ fallback: Double) -> Double {
  let a = CommandLine.arguments
  guard let i = a.firstIndex(of: name), i + 1 < a.count else { return fallback }
  return Double(a[i + 1]) ?? fallback
}

let targetWidth = Int(arg("--width", 1200))
let fps = Int32(arg("--fps", 6))
let quality = arg("--quality", 0.5)

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
  private let ctx = CIContext(options: [.useSoftwareRenderer: false])
  private let rgb = CGColorSpaceCreateDeviceRGB()
  private let out = FileHandle.standardOutput

  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sb.isValid else { return }

    // Every vsync produces a sample; only ones marked .complete carry new
    // pixels. Skipping the rest is what keeps an idle desktop near-free.
    guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false)
            as? [[SCStreamFrameInfo: Any]],
          let raw = attachments.first?[.status] as? Int,
          SCFrameStatus(rawValue: raw) == .complete,
          let px = CMSampleBufferGetImageBuffer(sb) else { return }

    let image = CIImage(cvPixelBuffer: px)
    guard let jpeg = ctx.jpegRepresentation(of: image, colorSpace: rgb, options: [
      kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: quality,
    ]) else { return }

    var len = UInt32(jpeg.count).bigEndian
    let header = Data(bytes: &len, count: 4)
    do { try out.write(contentsOf: header + jpeg) } catch { exit(0) }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    FileHandle.standardError.write("capture stopped: \(error)\n".data(using: .utf8)!)
    exit(4)
  }
}

let capture = Capture()
// Held at file scope on purpose: an SCStream that only lives inside the Task
// is released the moment startCapture() returns, and capture stops silently.
var stream: SCStream?

Task {
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let display = content.displays.first else {
      FileHandle.standardError.write("no display\n".data(using: .utf8)!)
      exit(3)
    }

    let cfg = SCStreamConfiguration()
    let scale = Double(targetWidth) / Double(display.width)
    cfg.width = targetWidth
    cfg.height = (Int(Double(display.height) * scale) / 2) * 2
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: fps)
    cfg.pixelFormat = kCVPixelFormatType_32BGRA
    cfg.showsCursor = true
    cfg.queueDepth = 3

    // Report the point size of the display so the caller can map taps back to
    // screen coordinates without guessing at the Retina scale factor.
    FileHandle.standardError.write("display \(display.width)x\(display.height) -> \(cfg.width)x\(cfg.height)\n".data(using: .utf8)!)

    let s = SCStream(filter: SCContentFilter(display: display, excludingWindows: []),
                     configuration: cfg, delegate: capture)
    try s.addStreamOutput(capture, type: .screen,
                          sampleHandlerQueue: DispatchQueue(label: "perch.capture"))
    try await s.startCapture()
    stream = s
  } catch {
    FileHandle.standardError.write("capture failed: \(error)\n".data(using: .utf8)!)
    exit(3)
  }
}

signal(SIGPIPE, SIG_DFL)
dispatchMain()
