import AppKit
import Foundation
import Darwin

func emitWake() {
    FileHandle.standardOutput.write(Data("wake\n".utf8))
}
let observer = NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
) { _ in emitWake() }
if CommandLine.arguments.contains("--self-test") {
    NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.didWakeNotification, object: nil)
    exit(0)
}
let parent = getppid()
let parentWatch = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
    if getppid() != parent { exit(0) }
}
RunLoop.main.run()
