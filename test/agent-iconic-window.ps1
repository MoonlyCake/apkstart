# Test the actual Win32 discovery logic against a scoped, synthetic Qt-shaped window.
param([string]$AgentPath = (Join-Path $PSScriptRoot '..\src\core\win\agent.ps1'))
$ErrorActionPreference = 'Stop'
$text = Get-Content -Raw -LiteralPath $AgentPath
$embedded = [regex]::Match($text, "(?s)@'\r?\n(.*?)\r?\n'@")
if (!$embedded.Success) { throw 'Missing embedded C#' }
$src = $embedded.Groups[1].Value.Replace('public class ApkAgent', 'public class ApkAgentIconicTest')
$src += @'

public static class IconicWindowFixture
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WindowClass
    {
        public uint Size, Style;
        public IntPtr Procedure;
        public int ClassExtra, WindowExtra;
        public IntPtr Instance, Icon, Cursor, Background;
        public string Menu, Name;
        public IntPtr SmallIcon;
    }
    delegate IntPtr WindowProc(IntPtr window, uint message, IntPtr wp, IntPtr lp);
    static readonly WindowProc Procedure = DefWindowProcW;
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern ushort RegisterClassExW(ref WindowClass data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr DefWindowProcW(IntPtr window, uint message, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int code);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr window);

    public static IntPtr Create(string suffix, string title, int width, int height, IntPtr owner)
    {
        var wc = new WindowClass {
            Size = (uint)Marshal.SizeOf(typeof(WindowClass)),
            Name = "ApkStartFixtureQWindowIcon" + suffix,
            Instance = GetModuleHandle(null),
            Procedure = Marshal.GetFunctionPointerForDelegate(Procedure),
        };
        if (RegisterClassExW(ref wc) == 0) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        var window = CreateWindowExW(0x80, wc.Name, title, 0x00CF0000, -2000, -2000,
            width, height, owner, IntPtr.Zero, wc.Instance, IntPtr.Zero);
        if (window == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return window;
    }

    public static void Minimize(IntPtr window)
    {
        ShowWindow(window, 7); // SW_SHOWMINNOACTIVE: neither a foreground nor a taskbar window.
        ShowWindow(window, 0); // Leaves the minimized state, like ApkStart's parked native surface.
    }
}
'@
Add-Type -TypeDefinition $src

$type = [ApkAgentIconicTest]
$flags = [System.Reflection.BindingFlags]'NonPublic, Static'
$find = $type.GetMethod('FindEmulator', $flags)
$scope = $type.GetMethod('SetScope', $flags)
$consent = $type.GetMethod('IsAdbConsentMainWindow', $flags)
function Discover([bool]$iconic) {
  if ($find.GetParameters().Length -eq 1) { return $find.Invoke($null, [object[]]@($true)) }
  return $find.Invoke($null, [object[]]@($true, $iconic))
}
function Check([bool]$ok, [string]$message) { if (!$ok) { throw $message } }

$main = $owned = $titled = $small = [IntPtr]::Zero
try {
  $processRoot = [System.IO.Path]::GetDirectoryName([System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
  $scope.Invoke($null, [object[]]@($processRoot))
  $main = [IconicWindowFixture]::Create('Main', 'Android Emulator - synthetic fixture', 604, 1085, [IntPtr]::Zero)
  $owned = [IconicWindowFixture]::Create('Owned', 'Android Emulator - owned tool', 680, 1100, $main)
  $titled = [IconicWindowFixture]::Create('ForeignTitle', 'Unrelated fixture', 680, 1100, [IntPtr]::Zero)
  $small = [IconicWindowFixture]::Create('Small', 'Android Emulator - small tool', 130, 110, [IntPtr]::Zero)
  foreach ($w in @($owned, $titled, $small)) { [IconicWindowFixture]::Minimize($w) }
  Check ((Discover $false) -eq $main) 'Normal owned surface not found'
  Check ($consent.Invoke($null, [object[]]@($main, [uint32]$PID))) 'Normal consent classifier rejected its main window'

  [IconicWindowFixture]::Minimize($main)
  Check ([IconicWindowFixture]::IsIconic($main)) 'Fixture must be minimized'
  Check ((Discover $false) -eq [IntPtr]::Zero) 'Strict discovery unexpectedly accepted a minimized surface'
  Check (!$consent.Invoke($null, [object[]]@($main, [uint32]$PID))) 'ADB consent must retain its strict client-size gate'
  Check ((Discover $true) -eq $main) 'DETACHED_REDISCOVERY_FAILED: eligible minimized 604x1085 window was not found'

  [IconicWindowFixture]::DestroyWindow($main) | Out-Null
  $main = $owned = [IntPtr]::Zero
  Check ((Discover $true) -eq [IntPtr]::Zero) 'Minimized fallback accepted an untitled or undersized window'

  $main = [IconicWindowFixture]::Create('Unscoped', 'Android Emulator - unscoped fixture', 604, 1085, [IntPtr]::Zero)
  [IconicWindowFixture]::Minimize($main)
  $scope.Invoke($null, [object[]]@(''))
  Check ((Discover $true) -eq [IntPtr]::Zero) 'Minimized fallback escaped emulator process scope'
  Write-Output 'AGENT_ICONIC_WINDOW_OK (604x1085; detached discovery only; consent/owner/title/size/scope preserved)'
} finally {
  foreach ($w in @($small, $titled, $owned, $main)) {
    if ($w -ne [IntPtr]::Zero) { [IconicWindowFixture]::DestroyWindow($w) | Out-Null }
  }
}
