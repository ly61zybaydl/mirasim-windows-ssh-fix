using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace MirasimWindowsAskpass
{
    internal static class Program
    {
        private static string QuoteArgument(string value)
        {
            if (value == null) value = string.Empty;
            var result = new StringBuilder();
            result.Append('"');
            var backslashes = 0;
            foreach (var character in value)
            {
                if (character == '\\')
                {
                    backslashes += 1;
                    continue;
                }
                if (character == '"')
                {
                    result.Append('\\', backslashes * 2 + 1);
                    result.Append('"');
                    backslashes = 0;
                    continue;
                }
                result.Append('\\', backslashes);
                backslashes = 0;
                result.Append(character);
            }
            result.Append('\\', backslashes * 2);
            result.Append('"');
            return result.ToString();
        }

        private static int Main(string[] args)
        {
            try
            {
                var executable = Process.GetCurrentProcess().MainModule.FileName;
                var shimDirectory = Path.GetDirectoryName(executable);
                var resourcesDirectory = Directory.GetParent(shimDirectory).FullName;
                var applicationDirectory = Directory.GetParent(resourcesDirectory).FullName;
                var nodeExecutable = Path.Combine(applicationDirectory, "Mirasim.exe");
                var askpassScript = Path.Combine(resourcesDirectory, "askpass.cjs");
                if (!File.Exists(nodeExecutable) || !File.Exists(askpassScript)) return 1;

                var prompt = args.Length > 0 ? args[0] : string.Empty;
                var startInfo = new ProcessStartInfo
                {
                    FileName = nodeExecutable,
                    Arguments = QuoteArgument(askpassScript) + " " + QuoteArgument(prompt),
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                };
                startInfo.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
                using (var child = Process.Start(startInfo))
                {
                    var output = Console.OpenStandardOutput();
                    child.StandardOutput.BaseStream.CopyTo(output);
                    output.Flush();
                    child.WaitForExit();
                    return child.ExitCode;
                }
            }
            catch
            {
                return 1;
            }
        }
    }
}
