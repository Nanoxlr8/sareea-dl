// Sareea DL native-messaging host. Original code.
//
// Chrome and Edge start this program, send ONE message on stdin (4-byte little-endian length + UTF-8 JSON)
// and read ONE reply from stdout in the same framing. The host checks who called it, relays the message
// to the running Sareea DL app over its named pipe (starting the app first when a download arrives and the
// app is not running), writes the reply and exits. The app does all the real validation of the download
// request; this relay only checks the caller, the frame and the message shape.
//
// Why a small .NET program and not the Electron exe itself: Electron's start-up writes a stray CR LF to
// stdout before any app code runs, which corrupts the length-prefixed stream the browser expects
// (details in docs/extension.md). This program starts in a few tens of milliseconds, needs nothing but
// the .NET Framework 4 that ships with Windows 10 and 11, and never writes to stdout except the reply.
//
// Nothing is logged or written to disk. Cookie and other header values are only ever held in memory for
// the length of one exchange and are never copied into a reply or an error text.
//
// Compiled by scripts/build-host.mjs (csc.exe from the .NET Framework). Constants come from Generated.cs.
// Language level: C# 5.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

static class Program
{
    const int MaxMessageBytes = 1024 * 1024; // what the browser may send us
    const int MaxReplyLineBytes = 64 * 1024; // what we accept back from the app
    const int PollMs = 120;
    const int HardLimitMs = 45000;

    // Test hooks: SAREEA_DL_HOST_READ_MS, _STARTUP_MS and _REPLY_MS shorten the waits in automated tests.
    static int ReadTimeoutMs = 10000;
    static int StartupWaitMs = 5000;
    static int ReplyTimeoutMs = 20000;

    static readonly string[] AddFields = new string[] { "type", "url", "fileName", "referrer", "pageUrl", "headers" };

    static int Main(string[] args)
    {
        Thread watchdog = new Thread(delegate() { Thread.Sleep(HardLimitMs); Environment.Exit(3); });
        watchdog.IsBackground = true;
        watchdog.Start();
        try
        {
            return Run(args);
        }
        catch (Exception)
        {
            return 1;
        }
    }

    static int Run(string[] args)
    {
        ReadIntEnv("SAREEA_DL_HOST_READ_MS", ref ReadTimeoutMs);
        ReadIntEnv("SAREEA_DL_HOST_STARTUP_MS", ref StartupWaitMs);
        ReadIntEnv("SAREEA_DL_HOST_REPLY_MS", ref ReplyTimeoutMs);

        // Who is calling? The browser passes the extension's origin as the first argument.
        string origin = null;
        foreach (string a in args)
        {
            if (a.StartsWith("chrome-extension://", StringComparison.Ordinal)) { origin = a; break; }
        }
        if (origin != Generated.AllowedOrigin)
        {
            WriteReply(false, "origin not allowed");
            return 2;
        }

        string text;
        string readError;
        if (!ReadOneMessage(out text, out readError))
        {
            WriteReply(false, readError);
            return 1;
        }

        Dictionary<string, object> msg;
        string type;
        string parseError = ParseMessage(text, out msg, out type);
        if (parseError != null)
        {
            WriteReply(false, parseError);
            return 1;
        }

        if (type == "open")
        {
            if (!StartApp())
            {
                WriteReply(false, "could not start Sareea DL");
                return 1;
            }
            WriteReply(true, null);
            return 0;
        }

        string pipe = PipeName();
        string id = "h-" + Process.GetCurrentProcess().Id.ToString() + "-" + DateTime.UtcNow.Ticks.ToString("x");
        string line = BridgeLine(type, msg, id);

        Attempt attempt = TryRelay(pipe, line, id, 1);
        if (attempt.Kind == AttemptKind.Unreachable && type == "add")
        {
            if (!StartApp())
            {
                WriteReply(false, "app-not-running");
                return 0;
            }
            Stopwatch clock = Stopwatch.StartNew();
            while (attempt.Kind == AttemptKind.Unreachable && clock.ElapsedMilliseconds < StartupWaitMs)
            {
                Thread.Sleep(PollMs);
                attempt = TryRelay(pipe, line, id, 1);
            }
        }

        if (attempt.Kind == AttemptKind.Unreachable) WriteReply(false, "app-not-running");
        else if (attempt.Kind == AttemptKind.Fail) WriteReply(false, attempt.Error);
        else WriteReply(attempt.Ok, attempt.Error);
        return 0;
    }

    // ------------------------------------------------------------------ framing

    static void ReadIntEnv(string name, ref int target)
    {
        string v = Environment.GetEnvironmentVariable(name);
        int n;
        if (!string.IsNullOrEmpty(v) && int.TryParse(v, out n) && n >= 50 && n <= 60000) target = n;
    }

    static bool ReadExactly(Stream s, byte[] buf, int count)
    {
        int off = 0;
        while (off < count)
        {
            int r = s.Read(buf, off, count - off);
            if (r <= 0) return false;
            off += r;
        }
        return true;
    }

    /// <summary>Reads one framed message from stdin within ReadTimeoutMs. Returns false with an error text.</summary>
    static bool ReadOneMessage(out string text, out string error)
    {
        string resultText = null;
        string resultError = "no message received";
        Thread reader = new Thread(delegate()
        {
            try
            {
                Stream stdin = Console.OpenStandardInput();
                byte[] head = new byte[4];
                if (!ReadExactly(stdin, head, 4)) { resultError = "incomplete message"; return; }
                uint len = (uint)(head[0] | (head[1] << 8) | (head[2] << 16) | (head[3] << 24));
                if (len == 0) { resultError = "empty message"; return; }
                if (len > MaxMessageBytes) { resultError = "message too large"; return; }
                byte[] body = new byte[len];
                if (!ReadExactly(stdin, body, (int)len)) { resultError = "incomplete message"; return; }
                try
                {
                    resultText = new UTF8Encoding(false, true).GetString(body);
                }
                catch (ArgumentException)
                {
                    resultError = "message is not valid UTF-8";
                }
            }
            catch (Exception)
            {
                resultError = "could not read the message";
            }
        });
        reader.IsBackground = true;
        reader.Start();
        if (!reader.Join(ReadTimeoutMs))
        {
            text = null;
            error = "no message received";
            return false;
        }
        text = resultText;
        error = resultError;
        return resultText != null;
    }

    static readonly object OutLock = new object();

    static void WriteFrame(string json)
    {
        byte[] body = Encoding.UTF8.GetBytes(json);
        byte[] head = new byte[4];
        head[0] = (byte)(body.Length & 0xff);
        head[1] = (byte)((body.Length >> 8) & 0xff);
        head[2] = (byte)((body.Length >> 16) & 0xff);
        head[3] = (byte)((body.Length >> 24) & 0xff);
        lock (OutLock)
        {
            try
            {
                Stream stdout = Console.OpenStandardOutput();
                stdout.Write(head, 0, 4);
                stdout.Write(body, 0, body.Length);
                stdout.Flush();
            }
            catch (IOException)
            {
                // the browser closed the pipe: nothing more to do
            }
        }
    }

    static void WriteReply(bool ok, string error)
    {
        Dictionary<string, object> r = new Dictionary<string, object>();
        r["v"] = 1;
        r["ok"] = ok;
        if (!ok && !string.IsNullOrEmpty(error)) r["error"] = error;
        WriteFrame(new JavaScriptSerializer().Serialize(r));
    }

    // ----------------------------------------------------------------- message

    /// <summary>Parses the extension's message. Only ping, open and add pass; no extra top-level fields.</summary>
    static string ParseMessage(string text, out Dictionary<string, object> msg, out string type)
    {
        msg = null;
        type = null;
        object raw;
        try
        {
            JavaScriptSerializer js = new JavaScriptSerializer();
            js.MaxJsonLength = MaxMessageBytes * 2;
            raw = js.DeserializeObject(text);
        }
        catch (Exception)
        {
            return "invalid JSON";
        }
        Dictionary<string, object> d = raw as Dictionary<string, object>;
        if (d == null) return "message must be a JSON object";
        object t;
        d.TryGetValue("type", out t);
        string ts = t as string;
        if (ts == "ping" || ts == "open")
        {
            foreach (string k in d.Keys) if (k != "type") return "unknown field " + Shorten(k);
        }
        else if (ts == "add")
        {
            foreach (string k in d.Keys) if (Array.IndexOf(AddFields, k) < 0) return "unknown field " + Shorten(k);
        }
        else
        {
            return "type must be \"ping\", \"open\" or \"add\"";
        }
        msg = d;
        type = ts;
        return null;
    }

    static string Shorten(string s)
    {
        return s.Length > 32 ? s.Substring(0, 32) : s;
    }

    /// <summary>The protocol-v1 request line for the app (docs/protocol.md): v and id are set here, never by the caller.</summary>
    static string BridgeLine(string type, Dictionary<string, object> msg, string id)
    {
        Dictionary<string, object> r = new Dictionary<string, object>();
        r["v"] = 1;
        r["id"] = id;
        r["type"] = type;
        if (type == "add")
        {
            foreach (KeyValuePair<string, object> kv in msg)
            {
                if (kv.Key != "type") r[kv.Key] = kv.Value;
            }
        }
        JavaScriptSerializer js = new JavaScriptSerializer();
        js.MaxJsonLength = MaxMessageBytes * 2;
        return js.Serialize(r);
    }

    // -------------------------------------------------------------------- pipe

    /// <summary>Same name rule as the app: user name with unsafe characters replaced, at most 64, plus the test suffix.</summary>
    static string PipeName()
    {
        string user = Environment.UserName ?? "user";
        StringBuilder sb = new StringBuilder();
        foreach (char c in user)
        {
            bool safe = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
            sb.Append(safe ? c : '_');
        }
        string safeUser = sb.ToString();
        if (safeUser.Length > 64) safeUser = safeUser.Substring(0, 64);
        if (safeUser.Length == 0) safeUser = "user";
        return "sareea-dl-" + safeUser + TestSuffix();
    }

    static string TestSuffix()
    {
        string dir = Environment.GetEnvironmentVariable("SAREEA_DL_TEST_DIR");
        if (string.IsNullOrEmpty(dir) || !Path.IsPathRooted(dir)) return "";
        using (SHA1 sha = SHA1.Create())
        {
            byte[] h = sha.ComputeHash(Encoding.UTF8.GetBytes(dir.ToLowerInvariant()));
            StringBuilder hex = new StringBuilder();
            foreach (byte b in h) hex.Append(b.ToString("x2"));
            return "-test-" + hex.ToString().Substring(0, 10);
        }
    }

    enum AttemptKind { Unreachable, Reply, Fail }

    class Attempt
    {
        public AttemptKind Kind;
        public bool Ok;
        public string Error;
    }

    static Attempt Fail(string error)
    {
        Attempt a = new Attempt();
        a.Kind = AttemptKind.Fail;
        a.Error = error;
        return a;
    }

    /// <summary>One connect, request and reply. Unreachable means the pipe does not exist (the app is not running).</summary>
    static Attempt TryRelay(string pipe, string line, string id, int connectWaitMs)
    {
        NamedPipeClientStream client = new NamedPipeClientStream(".", pipe, PipeDirection.InOut, PipeOptions.None, TokenImpersonationLevel.Identification);
        try
        {
            try
            {
                client.Connect(connectWaitMs);
            }
            catch (TimeoutException)
            {
                Attempt u = new Attempt();
                u.Kind = AttemptKind.Unreachable;
                return u;
            }
            catch (Exception)
            {
                return Fail("could not connect to the app");
            }

            byte[] request = Encoding.UTF8.GetBytes(line + "\n");
            string replyLine = null;
            string replyError = "app did not answer in time";
            Thread io = new Thread(delegate()
            {
                try
                {
                    client.Write(request, 0, request.Length);
                    client.Flush();
                    MemoryStream acc = new MemoryStream();
                    byte[] buf = new byte[4096];
                    while (true)
                    {
                        int n = client.Read(buf, 0, buf.Length);
                        if (n <= 0) { replyError = "connection to the app was closed"; return; }
                        acc.Write(buf, 0, n);
                        if (acc.Length > MaxReplyLineBytes) { replyError = "reply too long"; return; }
                        byte[] all = acc.ToArray();
                        int nl = Array.IndexOf(all, (byte)'\n');
                        if (nl >= 0)
                        {
                            replyLine = Encoding.UTF8.GetString(all, 0, nl);
                            return;
                        }
                    }
                }
                catch (Exception)
                {
                    replyError = "connection to the app was lost";
                }
            });
            io.IsBackground = true;
            io.Start();
            if (!io.Join(ReplyTimeoutMs) || replyLine == null) return Fail(replyError);

            Dictionary<string, object> r = null;
            try { r = new JavaScriptSerializer().DeserializeObject(replyLine) as Dictionary<string, object>; }
            catch (Exception) { }
            if (r == null) return Fail("unreadable reply from the app");
            object v, rid, ok, err;
            r.TryGetValue("v", out v);
            r.TryGetValue("id", out rid);
            r.TryGetValue("ok", out ok);
            r.TryGetValue("error", out err);
            if (!(v is int) || (int)v != 1 || !(rid is string) || (string)rid != id || !(ok is bool))
                return Fail("unexpected reply from the app");

            Attempt a = new Attempt();
            a.Kind = AttemptKind.Reply;
            a.Ok = (bool)ok;
            string es = err as string;
            a.Error = es == null ? null : (es.Length > 200 ? es.Substring(0, 200) : es);
            return a;
        }
        finally
        {
            try { client.Dispose(); } catch (Exception) { }
        }
    }

    // --------------------------------------------------------------------- app

    /// <summary>
    /// Starts Sareea DL.exe from the folder this host lives in, in normal mode. If the app is already running
    /// the new copy just asks it to show its window and exits (single-instance lock in the app).
    /// ShellExecute is used so the new process does not inherit the browser's stdin and stdout handles.
    /// </summary>
    static bool StartApp()
    {
        try
        {
            string dir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            string exe = Path.Combine(dir, Generated.AppExeName);
            if (!File.Exists(exe)) return false;
            ProcessStartInfo psi = new ProcessStartInfo(exe);
            psi.UseShellExecute = true;
            psi.WorkingDirectory = dir;
            Process.Start(psi);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }
}
