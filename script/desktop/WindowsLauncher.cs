using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

internal static class RecordMoney
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly string DefaultHome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RecordMoney");
    static readonly object LogLock = new object();
    static volatile bool Stopping;
    static Process Child;
    static int Port;
    static string Runtime, Installed, Version;
    static SafeFileHandle Job;

    [StructLayout(LayoutKind.Sequential)] struct JobLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedJobLimits {
        public JobLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(SafeFileHandle job, int information, ref ExtendedJobLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);

    static string Argument(string[] args, string name, string fallback)
    {
        int index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : fallback;
    }
    // Windows process argument quoting, including trailing backslashes in folder paths.
    static string Quote(string value)
    {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); result.Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static string Identity(string home)
    {
        using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(
            WindowsIdentity.GetCurrent().User.Value + "|" + Path.GetFullPath(home).ToUpperInvariant()))).Replace("-", "").Substring(0, 32);
    }
    static ProcessStartInfo NodeInfo(string installed, string arguments, string home)
    {
        var info = new ProcessStartInfo(Path.Combine(installed, "bin", "node.exe"), arguments);
        info.UseShellExecute = false; info.CreateNoWindow = true; info.WorkingDirectory = installed;
        info.RedirectStandardOutput = true; info.RedirectStandardError = true;
        info.StandardOutputEncoding = Encoding.UTF8; info.StandardErrorEncoding = Encoding.UTF8;
        info.EnvironmentVariables["LEDGER_POINTER_ROOT"] = home;
        info.EnvironmentVariables["LEDGER_HOST"] = "127.0.0.1";
        info.EnvironmentVariables["LEDGER_DIRECTORY_PICKER"] = Path.Combine(installed, "bin", "RecordMoney.exe");
        foreach (string key in new[] { "LEDGER_DATA_DIR", "LEDGER_LOGS_DIR", "PORT", "LEDGER_WEB_PORT" }) info.EnvironmentVariables.Remove(key);
        return info;
    }
    static Dictionary<string, object> Config(string installed, string home)
    {
        string script = "const {config,dataDir,logsDir}=await import(process.argv[1]);console.log(JSON.stringify({port:config.port,configured:!!config.appId&&!!config.appSecret&&!!config.aiBaseUrl&&!!config.aiKey&&!!config.model,dataDir,logsDir}));";
        string uri = new Uri(Path.Combine(installed, "script", "build", "config.js")).AbsoluteUri;
        using (var process = Process.Start(NodeInfo(installed, "--input-type=module -e " + Quote(script) + " " + Quote(uri), home))) {
            string output = process.StandardOutput.ReadToEnd(); string error = process.StandardError.ReadToEnd(); process.WaitForExit();
            if (process.ExitCode != 0) throw new Exception("无法读取配置，请检查安装文件。" + error.Substring(0, Math.Min(300, error.Length)));
            return Json.Deserialize<Dictionary<string, object>>(output);
        }
    }
    static Dictionary<string, object> Http(int port, string path, string token = null)
    {
        var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + path);
        request.Timeout = 15000; request.ReadWriteTimeout = 15000; request.Proxy = null;
        if (token != null) { request.Method = "POST"; request.ContentLength = 0; request.Headers["X-Ledger-Token"] = token; }
        using (var response = request.GetResponse()) using (var stream = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            return Json.Deserialize<Dictionary<string, object>>(stream.ReadToEnd());
    }
    static Dictionary<string, object> Control(string home, string action)
    {
        try {
            using (var pipe = new NamedPipeClientStream(".", "RecordMoney-" + Identity(home), PipeDirection.InOut)) {
                pipe.Connect(1000);
                using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true))
                using (var reader = new StreamReader(pipe, Encoding.UTF8, false, 1024, true)) {
                    writer.AutoFlush = true; writer.WriteLine(action);
                    return Json.Deserialize<Dictionary<string, object>>(reader.ReadLine());
                }
            }
        } catch { return null; }
    }
    static void Stop(string home)
    {
        if (Control(home, "stop") == null) return;
        for (int i = 0; i < 40; i++) { if (Control(home, "status") == null) return; Thread.Sleep(250); }
        throw new Exception("后台服务尚未停止，请稍后再试。");
    }
    static bool Available(int port)
    {
        var socket = new TcpListener(IPAddress.Loopback, port);
        try { socket.Start(); return true; } catch { return false; } finally { socket.Stop(); }
    }
    static void CopyDirectory(string source, string target)
    {
        Directory.CreateDirectory(target);
        foreach (string path in Directory.GetFiles(source)) File.Copy(path, Path.Combine(target, Path.GetFileName(path)));
        foreach (string path in Directory.GetDirectories(source)) CopyDirectory(path, Path.Combine(target, Path.GetFileName(path)));
    }
    static string PackageVersion(string installed)
    {
        return Convert.ToString(Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(installed, "script", "package.json")))["version"]);
    }
    static void Open(int port) { Process.Start(new ProcessStartInfo("http://127.0.0.1:" + port) { UseShellExecute = true }); }
    static void LaunchService(string installed, string home, int port)
    {
        string exe = Path.Combine(installed, "bin", "RecordMoney.exe");
        var info = new ProcessStartInfo(exe, "--serve --destination " + Quote(home) + " --port " + port);
        info.UseShellExecute = false; info.CreateNoWindow = true; info.WorkingDirectory = installed;
        // The background process must not retain the launching terminal's output pipes.
        info.RedirectStandardOutput = true; info.RedirectStandardError = true; info.RedirectStandardInput = true;
        using (var process = Process.Start(info)) {
            for (int i = 0; i < 80; i++) {
                var status = Control(home, "status");
                if (status != null && Convert.ToInt32(status["port"]) == port) {
                    try {
                        var bootstrap = Http(port, "/api/bootstrap");
                        if (Convert.ToString(bootstrap["version"]) == PackageVersion(installed) && Convert.ToInt32(bootstrap["pid"]) == Convert.ToInt32(status["childPid"])) return;
                    } catch { }
                }
                if (process.HasExited) break;
                Thread.Sleep(250);
            }
        }
        Stop(home); throw new Exception("服务没有成功启动，请查看存储目录中的logs文件夹。");
    }
    static void Install(string[] args)
    {
        bool isolated = Array.IndexOf(args, "--headless") >= 0 || Array.IndexOf(args, "--install-only") >= 0;
        string home = Path.GetFullPath(Argument(args, "--destination", DefaultHome));
        if (isolated && Array.IndexOf(args, "--destination") < 0) throw new Exception("测试安装必须指定独立目录。");
        string payload = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "payload");
        if (!Directory.Exists(payload)) payload = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
        string version = PackageVersion(payload), releases = Path.Combine(home, "desktop"), installed = Path.Combine(releases, version);
        Directory.CreateDirectory(releases);
        if (!Directory.Exists(installed)) {
            string staging = Path.Combine(releases, ".stage-" + Guid.NewGuid());
            try { CopyDirectory(payload, staging); Directory.Move(staging, installed); }
            catch { if (Directory.Exists(staging)) Directory.Delete(staging, true); throw; }
        }
        var config = Config(installed, home);
        if (Array.IndexOf(args, "--install-only") >= 0) { Console.WriteLine(Json.Serialize(new { installed = installed, version = version })); return; }
        var old = Control(home, "status");
        if (old != null && new System.Version(Convert.ToString(old["version"])) >= new System.Version(version)) {
            var bootstrap = Http(Convert.ToInt32(old["port"]), "/api/bootstrap");
            if (Convert.ToInt32(bootstrap["pid"]) != Convert.ToInt32(old["childPid"])) throw new Exception("后台服务尚未就绪，请检查端口或稍后重试。");
            if (!isolated) Open(Convert.ToInt32(old["port"])); return;
        }
        int port = Convert.ToInt32(config["port"]);
        if (isolated && Array.IndexOf(args, "--port") >= 0) port = int.Parse(Argument(args, "--port", "4317"));
        if (old != null) {
            port = Convert.ToInt32(old["port"]);
            var bootstrap = Http(port, "/api/bootstrap");
            if (Convert.ToInt32(bootstrap["pid"]) != Convert.ToInt32(old["childPid"])) throw new Exception("端口不是当前账本服务，升级已取消。");
            Http(port, "/api/backup", Convert.ToString(bootstrap["csrf"]));
            Stop(home);
        } else if (!Available(port)) {
            if (Convert.ToBoolean(config["configured"])) throw new Exception("账本端口已被其他程序占用，请先关闭该程序。");
            while (port < 4399 && !Available(port)) port++;
            if (!Available(port)) throw new Exception("没有可用的本机端口。");
        }
        try { LaunchService(installed, home, port); }
        catch { if (old != null) LaunchService(Convert.ToString(old["installed"]), home, Convert.ToInt32(old["port"])); throw; }
        if (!isolated) {
            string exe = Path.Combine(installed, "bin", "RecordMoney.exe");
            using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
                key.SetValue("RecordMoney", Quote(exe) + " --serve --destination " + Quote(home) + " --port " + port);
            CreateShortcut(exe); Open(port);
        }
    }
    static void CreateShortcut(string exe)
    {
        var type = Type.GetTypeFromProgID("WScript.Shell"); var shell = Activator.CreateInstance(type);
        var shortcut = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell,
            new object[] { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "私人记账助手.lnk") });
        shortcut.GetType().InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { exe });
        shortcut.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, new object[0]);
    }
    static void Log(string path, string line)
    {
        if (line == null) return;
        lock (LogLock) { try { File.AppendAllText(path, line + Environment.NewLine, Encoding.UTF8); } catch { } }
    }
    static void Serve(string[] args)
    {
        Runtime = Path.GetFullPath(Argument(args, "--destination", DefaultHome));
        Installed = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..")); Version = PackageVersion(Installed);
        Port = int.Parse(Argument(args, "--port", "4317"));
        using (var mutex = new Mutex(false, "Local\\RecordMoney-Service-" + Identity(Runtime))) {
            bool owned; try { owned = mutex.WaitOne(0); } catch (AbandonedMutexException) { owned = true; }
            if (!owned) return;
            // Closing the supervisor also closes its child, including after a forced termination.
            Job = CreateJobObject(IntPtr.Zero, null);
            var limits = new ExtendedJobLimits(); limits.Basic.Flags = 0x2000;
            if (Job.IsInvalid || !SetInformationJobObject(Job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedJobLimits)))) throw new Exception("无法建立后台进程管理。");
            var pipeThread = new Thread(PipeLoop); pipeThread.IsBackground = true; pipeThread.Start();
            var worker = new Thread(ServerLoop); worker.IsBackground = true; worker.Start();
            Application.EnableVisualStyles();
            using (var icon = new NotifyIcon()) {
                icon.Icon = SystemIcons.Application; icon.Text = "私人记账助手"; icon.Visible = true;
                var menu = new ContextMenuStrip();
                menu.Items.Add("打开账本", null, delegate { Open(Port); });
                menu.Items.Add("停止服务", null, delegate { Stopping = true; Application.Exit(); });
                menu.Items.Add("关闭登录自启并停止", null, delegate {
                    using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true)) if (key != null) key.DeleteValue("RecordMoney", false);
                    Stopping = true; Application.Exit();
                });
                icon.ContextMenuStrip = menu; icon.DoubleClick += delegate { Open(Port); };
                Application.Run(); icon.Visible = false;
            }
            Stopping = true; KillChild(); worker.Join(5000); Job.Dispose(); mutex.ReleaseMutex();
        }
    }
    static void KillChild() { try { if (Child != null && !Child.HasExited) Child.Kill(); } catch { } }
    static void PipeLoop()
    {
        var security = new PipeSecurity(); security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
        while (!Stopping) {
            try {
                using (var pipe = new NamedPipeServerStream("RecordMoney-" + Identity(Runtime), PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None, 4096, 4096, security)) {
                    pipe.WaitForConnection();
                    using (var reader = new StreamReader(pipe, Encoding.UTF8, false, 1024, true))
                    using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true)) {
                        string action = reader.ReadLine();
                        int childPid = 0; try { if (Child != null && !Child.HasExited) childPid = Child.Id; } catch { }
                        writer.AutoFlush = true; writer.WriteLine(Json.Serialize(new { port = Port, version = Version, installed = Installed, pid = Process.GetCurrentProcess().Id, childPid = childPid }));
                        if (action == "stop") { Stopping = true; KillChild(); Application.Exit(); }
                    }
                }
            } catch { if (!Stopping) Thread.Sleep(250); }
        }
    }
    static void ServerLoop()
    {
        while (!Stopping) {
            string logs = Path.Combine(Runtime, "logs");
            try {
                var config = Config(Installed, Runtime); logs = Convert.ToString(config["logsDir"]); Directory.CreateDirectory(logs);
                if (Convert.ToBoolean(config["configured"])) Port = Convert.ToInt32(config["port"]);
                var info = NodeInfo(Installed, Quote(Path.Combine(Installed, "script", "build", "server.js")), Runtime);
                info.EnvironmentVariables["PORT"] = Port.ToString();
                using (var process = new Process()) {
                    process.StartInfo = info; Child = process;
                    process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { Log(Path.Combine(logs, "stdout.log"), e.Data); };
                    process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { Log(Path.Combine(logs, "stderr.log"), e.Data); };
                    process.Start();
                    if (!AssignProcessToJobObject(Job, process.Handle)) { process.Kill(); throw new Exception("无法管理后台进程。"); }
                    process.BeginOutputReadLine(); process.BeginErrorReadLine();
                    if (Stopping) KillChild(); process.WaitForExit();
                    if (!Stopping && process.ExitCode != 75) Thread.Sleep(3000);
                }
            } catch { Directory.CreateDirectory(logs); Log(Path.Combine(logs, "stderr.log"), "无法启动后台服务，请检查安装文件或端口。"); Thread.Sleep(3000); }
        }
    }
    [STAThread]
    static int Main(string[] args)
    {
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }
        try {
            if (Array.IndexOf(args, "--choose-folder") >= 0) {
                using (var picker = new FolderBrowserDialog()) { picker.Description = "选择保存账本、配置与备份的文件夹";
                    if (picker.ShowDialog() == DialogResult.OK) Console.WriteLine(picker.SelectedPath); } return 0;
            }
            if (Array.IndexOf(args, "--stop") >= 0) { Stop(Argument(args, "--destination", DefaultHome)); return 0; }
            if (Array.IndexOf(args, "--status") >= 0) { Console.WriteLine(Json.Serialize(Control(Argument(args, "--destination", DefaultHome), "status"))); return 0; }
            if (Array.IndexOf(args, "--serve") >= 0) { Serve(args); return 0; }
            string home = Argument(args, "--destination", DefaultHome);
            using (var mutex = new Mutex(false, "Local\\RecordMoney-Install-" + Identity(home))) {
                bool owned; try { owned = mutex.WaitOne(60000); } catch (AbandonedMutexException) { owned = true; }
                if (!owned) throw new Exception("另一个安装正在运行，请稍后再试。");
                try { Install(args); } finally { mutex.ReleaseMutex(); }
            }
            return 0;
        } catch (Exception error) {
            if (Array.IndexOf(args, "--headless") >= 0 || Array.IndexOf(args, "--install-only") >= 0 || Array.IndexOf(args, "--serve") >= 0) Console.Error.WriteLine(error.Message);
            else MessageBox.Show(error.Message, "私人记账助手", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
