// Test double for "Sareea DL.exe": what the native host starts when the app is not running.
// It writes a marker file, opens the named pipe whose name is in <SAREEA_DL_TEST_DIR>\pipe-name.txt after a
// short delay, logs every request line to <dir>\requests.txt and answers {"v":1,"id":...,"ok":true}.
// It exits by itself after a few idle seconds. Test code only; compiled by test/host.test.ts.
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

static class FakeApp
{
    static void Main()
    {
        string dir = Environment.GetEnvironmentVariable("SAREEA_DL_TEST_DIR");
        if (string.IsNullOrEmpty(dir)) return;
        File.AppendAllText(Path.Combine(dir, "fake-app-started.txt"), "started\r\n");
        string pipe = File.ReadAllText(Path.Combine(dir, "pipe-name.txt")).Trim();
        Thread.Sleep(150);
        DateTime lastUse = DateTime.UtcNow;
        while ((DateTime.UtcNow - lastUse).TotalSeconds < 4)
        {
            using (NamedPipeServerStream server = new NamedPipeServerStream(pipe, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous))
            {
                IAsyncResult wait = server.BeginWaitForConnection(null, null);
                if (!wait.AsyncWaitHandle.WaitOne(500)) continue;
                server.EndWaitForConnection(wait);
                StringBuilder sb = new StringBuilder();
                byte[] buf = new byte[4096];
                while (sb.ToString().IndexOf('\n') < 0)
                {
                    int n = server.Read(buf, 0, buf.Length);
                    if (n <= 0) break;
                    sb.Append(Encoding.UTF8.GetString(buf, 0, n));
                }
                string line = sb.ToString().Split('\n')[0];
                File.AppendAllText(Path.Combine(dir, "requests.txt"), line + "\r\n");
                Match m = Regex.Match(line, "\"id\":\"([^\"]*)\"");
                byte[] reply = Encoding.UTF8.GetBytes("{\"v\":1,\"id\":\"" + (m.Success ? m.Groups[1].Value : "") + "\",\"ok\":true}\n");
                server.Write(reply, 0, reply.Length);
                server.Flush();
                server.WaitForPipeDrain();
                lastUse = DateTime.UtcNow;
            }
        }
    }
}
