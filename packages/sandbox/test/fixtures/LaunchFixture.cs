using System;
using System.IO;

static class LaunchFixture
{
    static void Main(string[] args)
    {
        if (args.Length == 1) File.WriteAllText(args[0], "launched");
    }
}
