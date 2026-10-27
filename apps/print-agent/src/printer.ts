/**
 * Raw ESC/POS to the printer over LAN TCP (default port 9100) or Windows USB (`usbprint.sys`
 * device interface): no Windows spooler driver needed.
 * A job counts as sent when every byte has been handed to the network or USB port and closed
 * cleanly. A TCP/USB success does not prove paper came out (a printer can be out of paper while its
 * interface still answers); the optional status check narrows that gap on LAN.
 */
import { spawn } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import {
  concatBytes,
  isCoverOpenStatus,
  isOfflineStatus,
  isPaperEndStatus,
  statusQuery,
} from '@sds/escpos';
import type { PrintAckErrorCode } from '@sds/shared';

export class PrinterError extends Error {
  readonly code: PrintAckErrorCode;
  constructor(code: PrintAckErrorCode) {
    super(`Printer error: ${code}`);
    this.name = 'PrinterError';
    this.code = code;
  }
}

export interface PrinterTarget {
  host: string;
  port: number;
  usbPath?: string | null;
  timeoutMs: number;
  statusCheck: boolean;
}

export type SendToPrinter = (bytes: Uint8Array, target: PrinterTarget) => Promise<void>;

const OFFLINE_ERRORS = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'ECONNRESET',
  'EPIPE',
]);

const socketErrorCode = (error: NodeJS.ErrnoException): PrintAckErrorCode => {
  if (error.code && OFFLINE_ERRORS.has(error.code)) return 'PRINTER_OFFLINE';
  if (error.code === 'ETIMEDOUT') return 'TIMEOUT';
  return 'OTHER';
};

/** How long to wait for the printer to close its side after we are done, before closing for it. */
const CLOSE_GRACE_MS = 1_500;
const STATUS_WAIT_MS = 800;

/** Asks the three status questions; null means all clear or no (usable) answer. */
function readProblem(socket: Socket): Promise<PrintAckErrorCode | null> {
  return new Promise((resolve) => {
    const replies: number[] = [];
    const done = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      if (replies.length < 3) return resolve(null);
      const [printer, cause, paper] = replies as [number, number, number];
      if (isPaperEndStatus(paper)) return resolve('OUT_OF_PAPER');
      if (isOfflineStatus(printer))
        return resolve(isCoverOpenStatus(cause) ? 'COVER_OPEN' : 'PRINTER_OFFLINE');
      resolve(null);
    };
    const onData = (chunk: Buffer) => {
      replies.push(...chunk);
      if (replies.length >= 3) done();
    };
    const timer = setTimeout(done, STATUS_WAIT_MS);
    socket.on('data', onData);
    socket.write(concatBytes([statusQuery(1), statusQuery(2), statusQuery(4)]));
  });
}

const USB_PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class SdsUsbPrinter {
    private static Guid GUID_DEVINTERFACE_USBPRINT = new Guid("28d78fad-5a12-11d1-ae5b-0000f803a8c2");
    private const int DIGCF_PRESENT = 0x02;
    private const int DIGCF_DEVICEINTERFACE = 0x10;

    [StructLayout(LayoutKind.Sequential)]
    public struct SP_DEVICE_INTERFACE_DATA {
        public int cbSize;
        public Guid InterfaceClassGuid;
        public int Flags;
        public IntPtr Reserved;
    }

    [DllImport("setupapi.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern IntPtr SetupDiGetClassDevs(ref Guid ClassGuid, IntPtr Enumerator, IntPtr hwndParent, int Flags);

    [DllImport("setupapi.dll", SetLastError = true)]
    public static extern bool SetupDiEnumDeviceInterfaces(IntPtr DeviceInfoSet, IntPtr DeviceInfoData, ref Guid InterfaceClassGuid, int MemberIndex, ref SP_DEVICE_INTERFACE_DATA DeviceInterfaceData);

    [DllImport("setupapi.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr DeviceInfoSet, ref SP_DEVICE_INTERFACE_DATA DeviceInterfaceData, IntPtr DeviceInterfaceDetailData, int DeviceInterfaceDetailDataSize, out int RequiredSize, IntPtr DeviceInfoData);

    [DllImport("setupapi.dll", SetLastError = true)]
    public static extern bool SetupDiDestroyDeviceInfoList(IntPtr DeviceInfoSet);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern SafeFileHandle CreateFile(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    public static List<string> FindPaths() {
        var list = new List<string>();
        var guid = GUID_DEVINTERFACE_USBPRINT;
        IntPtr hDevInfo = SetupDiGetClassDevs(ref guid, IntPtr.Zero, IntPtr.Zero, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
        if (hDevInfo == new IntPtr(-1)) return list;
        try {
            int index = 0;
            var data = new SP_DEVICE_INTERFACE_DATA();
            data.cbSize = Marshal.SizeOf(data);
            while (SetupDiEnumDeviceInterfaces(hDevInfo, IntPtr.Zero, ref guid, index, ref data)) {
                int reqSize = 0;
                SetupDiGetDeviceInterfaceDetail(hDevInfo, ref data, IntPtr.Zero, 0, out reqSize, IntPtr.Zero);
                IntPtr detail = Marshal.AllocHGlobal(reqSize);
                try {
                    Marshal.WriteInt32(detail, IntPtr.Size == 8 ? 8 : (4 + Marshal.SystemDefaultCharSize));
                    if (SetupDiGetDeviceInterfaceDetail(hDevInfo, ref data, detail, reqSize, out reqSize, IntPtr.Zero)) {
                        IntPtr pPath = new IntPtr(detail.ToInt64() + 4);
                        list.Add(Marshal.PtrToStringAuto(pPath));
                    }
                } finally {
                    Marshal.FreeHGlobal(detail);
                }
                index++;
            }
        } finally {
            SetupDiDestroyDeviceInfoList(hDevInfo);
        }
        return list;
    }

    public static void WriteBytes(string path, byte[] bytes) {
        using (SafeFileHandle handle = CreateFile(path, 0x40000000u, 3u, IntPtr.Zero, 3u, 0u, IntPtr.Zero)) {
            if (handle.IsInvalid) {
                int err = Marshal.GetLastWin32Error();
                throw new IOException("CreateFile failed: " + err, err);
            }
            using (var stream = new FileStream(handle, FileAccess.Write)) {
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush();
            }
        }
    }
}
"@

$b64 = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($b64)
$reqPath = $env:SDS_USB_PATH
if ([string]::IsNullOrWhiteSpace($reqPath) -or $reqPath -eq 'auto') {
    $paths = [SdsUsbPrinter]::FindPaths()
    if ($paths.Count -eq 0) {
        [Console]::Error.WriteLine('PRINTER_OFFLINE')
        exit 10
    }
    $reqPath = $paths[0]
}
try {
    [SdsUsbPrinter]::WriteBytes($reqPath, $bytes)
} catch {
    [Console]::Error.WriteLine('PRINTER_OFFLINE')
    exit 10
}
`;

export function sendToUsbPrinter(
  bytes: Uint8Array,
  usbPath: string,
  timeoutMs: number,
  runCommand?: { file: string; args: string[] },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cmd = runCommand ?? {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', USB_PS_SCRIPT],
    };
    const child = spawn(cmd.file, cmd.args, {
      env: { ...process.env, SDS_USB_PATH: usbPath },
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    let stderr = '';
    const settle = (error?: PrinterError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(new PrinterError('TIMEOUT'));
    }, timeoutMs);

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', () => settle(new PrinterError('OTHER')));
    child.on('close', (code) => {
      if (code === 0) return settle();
      if (code === 10 || stderr.includes('PRINTER_OFFLINE'))
        return settle(new PrinterError('PRINTER_OFFLINE'));
      settle(new PrinterError('OTHER'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(bytes).toString('base64'));
  });
}

export const sendToPrinter: SendToPrinter = (bytes, target) => {
  if (target.usbPath) {
    return sendToUsbPrinter(bytes, target.usbPath, target.timeoutMs);
  }
  return new Promise<void>((resolve, reject) => {
    const socket = connect({ host: target.host, port: target.port });
    socket.setNoDelay(true);
    let settled = false;
    let flushed = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const settle = (error?: PrinterError) => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      clearTimeout(graceTimer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const overall = setTimeout(() => settle(new PrinterError('TIMEOUT')), target.timeoutMs);

    socket.on('error', (error: NodeJS.ErrnoException) =>
      settle(new PrinterError(socketErrorCode(error))),
    );
    socket.on('close', () => settle(flushed ? undefined : new PrinterError('PRINTER_OFFLINE')));
    socket.once('finish', () => {
      flushed = true;
      graceTimer = setTimeout(() => settle(), CLOSE_GRACE_MS);
    });
    socket.once('connect', () => {
      void (async () => {
        if (target.statusCheck) {
          const problem = await readProblem(socket);
          if (problem) return settle(new PrinterError(problem));
        }
        socket.end(bytes);
      })();
    });
  });
};
