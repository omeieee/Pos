using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Saap Don Sen Print Agent")]
[assembly: AssemblyProduct("Saap Don Sen POS")]
[assembly: AssemblyDescription("Background supervisor for the Saap Don Sen POS kitchen print agent")]
[assembly: AssemblyVersion("1.0.0.0")]

namespace SaapDonSen
{
    internal static class Program
    {
        private const string MutexName = @"Local\SaapDonSenPrintAgentSupervisor";
        private static Process _child;
        private static IntPtr _jobHandle = IntPtr.Zero;
        private static readonly object _lock = new object();
        private static volatile bool _stopping;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo, int cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        private static void InitKillOnCloseJob()
        {
            try
            {
                _jobHandle = CreateJobObject(IntPtr.Zero, null);
                if (_jobHandle == IntPtr.Zero) return;
                var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(_jobHandle, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
            }
            catch { }
        }

        [STAThread]
        private static int Main(string[] args)
        {
            bool createdNew;
            using (var mutex = new Mutex(true, MutexName, out createdNew))
            {
                if (!createdNew)
                {
                    // Already running in the background; exit quietly so a second click does not duplicate.
                    return 0;
                }

                InitKillOnCloseJob();
                string exeDir = AppDomain.CurrentDomain.BaseDirectory;
                string workDir = FindAgentRoot(exeDir);
                string logFile = Path.Combine(workDir, "agent.log");

                AppDomain.CurrentDomain.ProcessExit += (_, __) => StopChild();
                Microsoft.Win32.SystemEvents.SessionEnding += (_, __) => StopChild();

                var worker = new Thread(() => SuperviseLoop(workDir, logFile))
                {
                    IsBackground = true,
                    Name = "PrintAgentSupervisor"
                };
                worker.Start();

                Application.Run();
                StopChild();
                return 0;
            }
        }

        private static string FindAgentRoot(string exeDir)
        {
            // If compiled into dist\SaapDonSenPrintAgent.exe, the parent directory has .env and dist\agent.mjs.
            string parent = Path.GetFullPath(Path.Combine(exeDir, ".."));
            if (File.Exists(Path.Combine(exeDir, "dist", "agent.mjs")))
                return exeDir;
            if (File.Exists(Path.Combine(parent, "dist", "agent.mjs")))
                return parent;
            return @"C:\Pos\apps\print-agent";
        }

        private static string FindNodeExe()
        {
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string candidate = Path.Combine(pf, "nodejs", "node.exe");
            if (File.Exists(candidate))
                return candidate;
            return "node.exe";
        }

        private static void SuperviseLoop(string workDir, string logFile)
        {
            string nodeExe = FindNodeExe();
            while (!_stopping)
            {
                try
                {
                    RotateLogIfNeeded(logFile);
                    var psi = new ProcessStartInfo
                    {
                        FileName = nodeExe,
                        Arguments = "--env-file-if-exists=.env dist/agent.mjs",
                        WorkingDirectory = workDir,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        StandardOutputEncoding = Encoding.UTF8,
                        StandardErrorEncoding = Encoding.UTF8
                    };

                    var proc = new Process { StartInfo = psi };
                    DataReceivedEventHandler onLine = (_, e) =>
                    {
                        if (!string.IsNullOrEmpty(e.Data))
                            AppendLog(logFile, e.Data);
                    };
                    proc.OutputDataReceived += onLine;
                    proc.ErrorDataReceived += onLine;

                    lock (_lock)
                    {
                        if (_stopping) return;
                        proc.Start();
                        if (_jobHandle != IntPtr.Zero)
                        {
                            try { AssignProcessToJobObject(_jobHandle, proc.Handle); } catch { }
                        }
                        _child = proc;
                    }

                    proc.BeginOutputReadLine();
                    proc.BeginErrorReadLine();
                    proc.WaitForExit();
                }
                catch (Exception ex)
                {
                    AppendLog(logFile, "{\"level\":\"error\",\"event\":\"supervisor.spawn_failed\",\"message\":\"" + ex.Message.Replace("\"", "'") + "\"}");
                }
                finally
                {
                    lock (_lock)
                    {
                        if (_child != null)
                        {
                            try { _child.Dispose(); } catch { }
                            _child = null;
                        }
                    }
                }

                if (_stopping) break;
                for (int i = 0; i < 30 && !_stopping; i++)
                    Thread.Sleep(100);
            }
        }

        private static void StopChild()
        {
            _stopping = true;
            lock (_lock)
            {
                if (_child != null)
                {
                    try
                    {
                        if (!_child.HasExited)
                            _child.Kill();
                    }
                    catch { }
                }
            }
            try { Application.Exit(); } catch { }
        }

        private static void RotateLogIfNeeded(string logFile)
        {
            try
            {
                var info = new FileInfo(logFile);
                if (info.Exists && info.Length > 1024 * 1024)
                {
                    string old = logFile + ".old";
                    if (File.Exists(old)) File.Delete(old);
                    File.Move(logFile, old);
                }
            }
            catch { }
        }

        private static void AppendLog(string logFile, string line)
        {
            try
            {
                lock (_lock)
                {
                    File.AppendAllText(logFile, line + Environment.NewLine, Encoding.UTF8);
                }
            }
            catch { }
        }
    }
}
