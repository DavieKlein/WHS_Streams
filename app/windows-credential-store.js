// Remembers the D365 connection in Windows Credential Manager (DPAPI, per Windows user).
// PowerShell + inline C# P/Invoke; the secret travels in a process-scoped env var, never as an argument.
const { execFile } = require("child_process");

const supported = process.platform === "win32";

const PINVOKE = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class TlCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredWrite(ref CREDENTIAL c, int flags);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredRead(string t, int type, int flags, out IntPtr c);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr c);
  public static void Write(string target, string secret) {
    byte[] b = Encoding.Unicode.GetBytes(secret); var c = new CREDENTIAL(); c.Type = 1; c.TargetName = target; c.Persist = 2;
    c.CredentialBlobSize = b.Length; c.CredentialBlob = Marshal.AllocHGlobal(b.Length); Marshal.Copy(b, 0, c.CredentialBlob, b.Length);
    c.UserName = "stroomviewer";
    try { if (!CredWrite(ref c, 0)) throw new Exception("CredWrite failed: " + Marshal.GetLastWin32Error()); } finally { Marshal.FreeHGlobal(c.CredentialBlob); } }
  public static string Read(string target) {
    IntPtr p; if (!CredRead(target, 1, 0, out p)) return null;
    try { var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2); } finally { CredFree(p); } }
}
"@
`;

function runPowerShell(script, env) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 20000 },
      (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
  });
}

async function writeCredential(target, value) {
  if (!supported) throw new Error("Windows Credential Manager is only available on Windows.");
  await runPowerShell(PINVOKE + `[TlCred]::Write($env:TL_CRED_TARGET, $env:TL_CRED_VALUE)`, { TL_CRED_TARGET: target, TL_CRED_VALUE: value });
}

async function readCredential(target) {
  if (!supported) return null;
  const out = await runPowerShell(PINVOKE + `$v = [TlCred]::Read($env:TL_CRED_TARGET); if ($v) { [Console]::Out.Write($v) }`, { TL_CRED_TARGET: target });
  return out ? out : null;
}

module.exports = { supported, writeCredential, readCredential };
