import AppKit
import Foundation
import Darwin

let fm = FileManager.default
func command(_ binary: String, _ arguments: [String], environment: [String: String]? = nil) throws -> String {
    let p = Process(), out = Pipe(), err = Pipe()
    p.executableURL = URL(fileURLWithPath: binary); p.arguments = arguments
    p.standardOutput = out; p.standardError = err
    if let environment = environment { p.environment = environment }
    try p.run()
    let bytes = out.fileHandleForReading.readDataToEndOfFile()
    let errors = err.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    if p.terminationStatus != 0 { throw NSError(domain: "RecordMoney", code: Int(p.terminationStatus), userInfo: [NSLocalizedDescriptionKey: String(data: errors, encoding: .utf8) ?? "启动操作失败"]) }
    return String(data: bytes, encoding: .utf8) ?? ""
}
func request(_ url: URL, method: String = "GET", token: String? = nil) -> [String: Any]? {
    var req = URLRequest(url: url, timeoutInterval: 4); req.httpMethod = method
    if let token = token { req.setValue(token, forHTTPHeaderField: "X-Ledger-Token") }
    let done = DispatchSemaphore(value: 0)
    var value: [String: Any]?
    URLSession.shared.dataTask(with: req) { bytes, response, _ in
        if let r = response as? HTTPURLResponse, r.statusCode == 200, let bytes = bytes { value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] }
        done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 5)
    return value
}
func available(_ port: Int) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    if fd < 0 { return false }; defer { close(fd) }
    var addr = sockaddr_in(); addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(port).bigEndian; addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    return withUnsafePointer(to: &addr) { ptr in ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 } }
}
func alert(_ message: String) {
    NSApplication.shared.setActivationPolicy(.regular); NSApplication.shared.activate(ignoringOtherApps: true)
    let a = NSAlert(); a.messageText = "私人记账助手"; a.informativeText = message; a.addButton(withTitle: "好"); a.runModal()
}
if CommandLine.arguments.contains("--choose-folder") {
    NSApplication.shared.setActivationPolicy(.regular); NSApplication.shared.activate(ignoringOtherApps: true)
    let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.canCreateDirectories = true
    panel.message = "选择保存账本、配置与备份的文件夹"; panel.prompt = "选择"
    if panel.runModal() == .OK, let url = panel.url { print(url.path) }
    exit(0)
}
do {
    guard let resources = Bundle.main.resourceURL else { throw NSError(domain: "RecordMoney", code: 1) }
    let payload = resources.appendingPathComponent("payload")
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.4.0"
    let defaultHome = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/RecordMoney")
    let installOnly = CommandLine.arguments.contains("--install-only")
    let location: URL
    if installOnly, let index = CommandLine.arguments.firstIndex(of: "--destination"), CommandLine.arguments.count > index + 1 {
        location = URL(fileURLWithPath: CommandLine.arguments[index + 1], isDirectory: true)
    } else if installOnly { throw NSError(domain: "RecordMoney", code: 2, userInfo: [NSLocalizedDescriptionKey: "测试安装须指定独立目录"]) }
    else { location = defaultHome }
    let releases = location.appendingPathComponent("desktop"), installed = releases.appendingPathComponent(version)
    try fm.createDirectory(at: releases, withIntermediateDirectories: true)
    if !fm.fileExists(atPath: installed.path) {
        let staging = releases.appendingPathComponent(".stage-" + UUID().uuidString)
        do { try fm.copyItem(at: payload, to: staging); try fm.moveItem(at: staging, to: installed) }
        catch { try? fm.removeItem(at: staging); throw error }
    }
    var env = ProcessInfo.processInfo.environment
    env["LEDGER_POINTER_ROOT"] = location.path
    env["LEDGER_DIRECTORY_PICKER"] = installed.appendingPathComponent("bin/launcher").path
    let node = installed.appendingPathComponent("bin/node").path
    let info = try command(node, ["--input-type=module", "-e", "const {config}=await import(process.argv[1]); console.log(JSON.stringify({port:config.port,configured:!!config.appId&&!!config.appSecret&&!!config.aiKey&&!!config.model}));", installed.appendingPathComponent("script/build/config.js").absoluteString], environment: env)
    guard let bytes = info.data(using: .utf8), let parsed = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw NSError(domain: "RecordMoney", code: 3) }
    var port = parsed["port"] as? Int ?? 4317
    if installOnly { print("安装验收成功：" + installed.path); exit(0) }
    var url = URL(string: "http://127.0.0.1:\(port)")!
    let running = request(url.appendingPathComponent("api/bootstrap"))
    let ownService = running?["product"] as? String == "record-money" || (fm.fileExists(atPath: location.appendingPathComponent("script/build/server.js").path) && running?["csrf"] is String && running?["version"] is String)
    if ownService, running?["version"] as? String == version { NSWorkspace.shared.open(url); exit(0) }
    if ownService, let token = running?["csrf"] as? String {
        guard request(url.appendingPathComponent("api/backup"), method: "POST", token: token) != nil else { throw NSError(domain: "RecordMoney", code: 4, userInfo: [NSLocalizedDescriptionKey: "升级前备份失败。请在原网页完成备份后重试。原服务仍在运行。"] ) }
    } else if !available(port) {
        if parsed["configured"] as? Bool == true { throw NSError(domain: "RecordMoney", code: 5, userInfo: [NSLocalizedDescriptionKey: "已有账本的端口 \(port) 被其他程序占用，请先退出该程序再打开应用。"] ) }
        guard let free = (4317...4399).first(where: { available($0) }) else { throw NSError(domain: "RecordMoney", code: 6) }
        port = free; url = URL(string: "http://127.0.0.1:\(port)")!
    }
    let agents = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents")
    try fm.createDirectory(at: agents, withIntermediateDirectories: true)
    let label = "local.record-money.v01", domain = "gui/\(getuid())"
    let logs = location.appendingPathComponent("logs"); try fm.createDirectory(at: logs, withIntermediateDirectories: true)
    let plist: [String: Any] = ["Label": label, "ProgramArguments": ["/bin/sh", installed.appendingPathComponent("script/tools/run.sh").path],
        "WorkingDirectory": installed.path, "RunAtLoad": true, "KeepAlive": true, "ThrottleInterval": 10,
        "EnvironmentVariables": ["NODE_BINARY": node, "LEDGER_POINTER_ROOT": location.path, "LEDGER_DIRECTORY_PICKER": env["LEDGER_DIRECTORY_PICKER"]!, "PORT": String(port)],
        "StandardOutPath": logs.appendingPathComponent("stdout.log").path, "StandardErrorPath": logs.appendingPathComponent("stderr.log").path]
    let plistURL = agents.appendingPathComponent(label + ".plist")
    let oldPlist = try? Data(contentsOf: plistURL)
    let plistData = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    _ = try? command("/bin/launchctl", ["bootout", domain + "/" + label])
    do {
        try plistData.write(to: plistURL, options: .atomic); try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: plistURL.path)
        _ = try command("/bin/launchctl", ["bootstrap", domain, plistURL.path])
        for _ in 0..<40 { if request(url.appendingPathComponent("api/bootstrap"))?["product"] as? String == "record-money" { NSWorkspace.shared.open(url); exit(0) }; Thread.sleep(forTimeInterval: 0.5) }
        throw NSError(domain: "RecordMoney", code: 7, userInfo: [NSLocalizedDescriptionKey: "服务未成功启动，请检查 " + logs.path])
    } catch {
        _ = try? command("/bin/launchctl", ["bootout", domain + "/" + label])
        if let oldPlist = oldPlist { try? oldPlist.write(to: plistURL, options: .atomic); _ = try? command("/bin/launchctl", ["bootstrap", domain, plistURL.path]) }
        throw error
    }
} catch { alert(error.localizedDescription); exit(1) }
