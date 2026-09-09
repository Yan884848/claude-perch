// perch-input — mouse and keyboard injection for Perch's screen mode.
//
// cliclick covers most of this, but not scroll wheel events and not typing
// anything outside ASCII. Rather than depend on two tools, this posts every
// event through CoreGraphics directly.
//
//   perch-input pos
//   perch-input move   <x> <y>
//   perch-input click  <x> <y> [left|right|middle] [count]
//   perch-input drag   <x1> <y1> <x2> <y2>
//   perch-input scroll <x> <y> <dx> <dy>
//   perch-input type   <utf-8 text>
//   perch-input key    <name> [cmd,shift,alt,ctrl]
//
// Coordinates are screen points, origin top-left. Needs Accessibility.

import Foundation
import CoreGraphics

let src = CGEventSource(stateID: .hidSystemState)

func point(_ a: String, _ b: String) -> CGPoint {
  CGPoint(x: Double(a) ?? 0, y: Double(b) ?? 0)
}

func mouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton, clicks: Int64 = 1) {
  guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
  if clicks > 1 { e.setIntegerValueField(.mouseEventClickState, value: clicks) }
  e.post(tap: .cghidEventTap)
}

func buttonKind(_ name: String) -> (CGMouseButton, CGEventType, CGEventType) {
  switch name {
  case "right":  return (.right,  .rightMouseDown,  .rightMouseUp)
  case "middle": return (.center, .otherMouseDown,  .otherMouseUp)
  default:       return (.left,   .leftMouseDown,   .leftMouseUp)
  }
}

// A keyboard event with no virtual key, carrying the characters directly. This
// is what lets us type CJK, emoji, or anything else the layout can't reach.
func typeText(_ text: String) {
  for chunk in Array(text).chunked(into: 8) {
    var utf16 = Array(String(chunk).utf16)
    for down in [true, false] {
      guard let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down) else { continue }
      e.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
      e.post(tap: .cghidEventTap)
    }
    usleep(6000)
  }
}

let keyCodes: [String: CGKeyCode] = [
  "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
  "esc": 53, "escape": 53, "fwd-delete": 117, "home": 115, "end": 119,
  "pageup": 116, "pagedown": 121,
  "arrow-left": 123, "arrow-right": 124, "arrow-down": 125, "arrow-up": 126,
  "left": 123, "right": 124, "down": 125, "up": 126,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
  "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  // Full US layout, so any shortcut the user needs can be expressed.
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
  "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32,
  "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
  "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29,
  "-": 27, "=": 24, "[": 33, "]": 30, ";": 41, "'": 39, ",": 43, ".": 47, "/": 44, "\\": 42, "`": 50,
]

func flags(_ spec: String) -> CGEventFlags {
  var f: CGEventFlags = []
  for name in spec.split(separator: ",") {
    switch name {
    case "cmd", "command": f.insert(.maskCommand)
    case "shift":          f.insert(.maskShift)
    case "alt", "option":  f.insert(.maskAlternate)
    case "ctrl", "control": f.insert(.maskControl)
    case "fn":             f.insert(.maskSecondaryFn)
    default: break
    }
  }
  return f
}

extension Array {
  func chunked(into size: Int) -> [[Element]] {
    stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
  }
}

let a = CommandLine.arguments
guard a.count >= 2 else {
  FileHandle.standardError.write("usage: perch-input <pos|move|click|drag|scroll|type|key> ...\n".data(using: .utf8)!)
  exit(2)
}

switch a[1] {
case "pos":
  let p = CGEvent(source: nil)?.location ?? .zero
  print("\(Int(p.x)),\(Int(p.y))")

case "move" where a.count >= 4:
  mouse(.mouseMoved, point(a[2], a[3]), .left)

case "click" where a.count >= 4:
  let p = point(a[2], a[3])
  let (btn, down, up) = buttonKind(a.count > 4 ? a[4] : "left")
  let count = Int64(a.count > 5 ? (Int64(a[5]) ?? 1) : 1)
  mouse(.mouseMoved, p, .left)
  usleep(12000)
  for n in 1...max(count, 1) {
    mouse(down, p, btn, clicks: n)
    mouse(up, p, btn, clicks: n)
    if n < count { usleep(60000) }
  }

case "drag" where a.count >= 6:
  let from = point(a[2], a[3]), to = point(a[4], a[5])
  mouse(.mouseMoved, from, .left)
  mouse(.leftMouseDown, from, .left)
  // Interpolate: a single jump reads as a teleport and many views ignore it.
  let steps = 24
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    mouse(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * t,
                                     y: from.y + (to.y - from.y) * t), .left)
    usleep(8000)
  }
  mouse(.leftMouseUp, to, .left)

case "scroll" where a.count >= 6:
  mouse(.mouseMoved, point(a[2], a[3]), .left)
  usleep(8000)
  let dx = Int32(a[4]) ?? 0, dy = Int32(a[5]) ?? 0
  if let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel,
                     wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
    e.post(tap: .cghidEventTap)
  }

case "type" where a.count >= 3:
  typeText(a[2...].joined(separator: " "))

case "key" where a.count >= 3:
  guard let code = keyCodes[a[2].lowercased()] else {
    FileHandle.standardError.write("unknown key: \(a[2])\n".data(using: .utf8)!)
    exit(3)
  }
  let mods = flags(a.count > 3 ? a[3] : "")
  for down in [true, false] {
    guard let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { continue }
    // Assign only when there is something to assign: writing an empty set
    // wipes the flags CGEvent sets for us, and a plain keystroke posted with
    // zeroed flags is silently ignored — modifier combos still worked, which
    // is what made this look like "some buttons are dead".
    if !mods.isEmpty { e.flags = mods }
    e.post(tap: .cghidEventTap)
  }

default:
  FileHandle.standardError.write("bad arguments\n".data(using: .utf8)!)
  exit(2)
}

// CGEvent.post() hands the event off asynchronously. This process is short
// enough that exiting here would kill it before the window server delivers the
// last event — which looked like "modifier combos work, plain keys don't",
// because the unicode-typing path happens to sleep between chunks.
usleep(30000)
