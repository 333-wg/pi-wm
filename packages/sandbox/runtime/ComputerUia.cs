// Windows UI Automation bridge. No SendInput, SetFocus or foreground activation.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

public static class ComputerUia
{
    [StructLayout(LayoutKind.Sequential)] struct CursorPoint { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint Size; public uint Tick; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out CursorPoint point);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput input);
    static uint InputTick() {
        var input = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
        if (!GetLastInputInfo(ref input)) throw new InvalidOperationException("Cannot observe desktop input state");
        return input.Tick;
    }
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    static bool TargetHasForeground(int processId) {
        uint foregroundProcess;
        GetWindowThreadProcessId(GetForegroundWindow(), out foregroundProcess);
        return foregroundProcess == processId;
    }
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1048576 };
    static readonly TreeWalker Walker = TreeWalker.ControlViewWalker;
    static readonly Dictionary<string, AutomationPattern> Patterns = new Dictionary<string, AutomationPattern> {
        { "invoke", InvokePattern.Pattern }, { "set_value", ValuePattern.Pattern },
        { "select", SelectionItemPattern.Pattern }, { "toggle", TogglePattern.Pattern },
        { "expand", ExpandCollapsePattern.Pattern }, { "collapse", ExpandCollapsePattern.Pattern }
    };

    static string Text(object value, int limit = 160)
    {
        string text = Convert.ToString(value) ?? "";
        return text.Length > limit ? text.Substring(0, limit) : text;
    }

    static Dictionary<string, object> Window(AutomationElement root)
    {
        var current = root.Current;
        using (var process = Process.GetProcessById(current.ProcessId))
            return new Dictionary<string, object> {
                { "id", current.NativeWindowHandle.ToString() }, { "pid", current.ProcessId },
                { "title", Text(current.Name) }, { "process", process.ProcessName },
                { "startedAt", process.StartTime.ToUniversalTime().Ticks.ToString() }
            };
    }

    static AutomationElement Root(Dictionary<string, object> expected)
    {
        long handle = Int64.Parse((string)expected["id"]);
        if (handle == 0) throw new InvalidOperationException("Invalid window handle");
        var root = AutomationElement.FromHandle(new IntPtr(handle));
        var current = Window(root);
        foreach (string key in new [] { "id", "pid", "process", "startedAt" })
            if (Convert.ToString(current[key]) != Convert.ToString(expected[key]))
                throw new InvalidOperationException("Window identity changed; list windows again");
        return root;
    }

    static Dictionary<string, object> Element(AutomationElement element)
    {
        var current = element.Current;
        if (current.IsPassword) return null;
        var actions = new List<string>();
        object pattern;
        foreach (var pair in Patterns)
        {
            if (!element.TryGetCurrentPattern(pair.Value, out pattern)) continue;
            if (pair.Key == "set_value" && ((ValuePattern)pattern).Current.IsReadOnly) continue;
            actions.Add(pair.Key);
        }
        var result = new Dictionary<string, object> {
            { "runtimeId", element.GetRuntimeId() }, { "name", Text(current.Name) },
            { "automationId", Text(current.AutomationId) }, { "controlType", current.ControlType.ProgrammaticName },
            { "enabled", current.IsEnabled }, { "offscreen", current.IsOffscreen }, { "actions", actions }
        };
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
        {
            var value = ((ValuePattern)pattern).Current.Value ?? "";
            result["value"] = Text(value, 2000);
            result["valueTruncated"] = value.Length > 2000;
            using (var hash = SHA256.Create())
                result["valueFingerprint"] = Convert.ToBase64String(hash.ComputeHash(Encoding.UTF8.GetBytes(value)));
        }
        if (element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern))
            result["toggleState"] = ((TogglePattern)pattern).Current.ToggleState.ToString();
        if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
            result["selected"] = ((SelectionItemPattern)pattern).Current.IsSelected;
        if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
            result["expandState"] = ((ExpandCollapsePattern)pattern).Current.ExpandCollapseState.ToString();
        return result;
    }

    // A bounded control-view traversal, not FindAll(Descendants) on an arbitrary app.
    static List<KeyValuePair<AutomationElement, Dictionary<string, object>>> ReadTree(AutomationElement root, out bool truncated)
    {
        var result = new List<KeyValuePair<AutomationElement, Dictionary<string, object>>>();
        var queue = new Queue<KeyValuePair<AutomationElement, int>>();
        queue.Enqueue(new KeyValuePair<AutomationElement, int>(root, 0));
        var time = Stopwatch.StartNew();
        int seen = 0;
        truncated = false;
        while (queue.Count > 0 && seen < 250 && time.ElapsedMilliseconds < 5000)
        {
            var item = queue.Dequeue();
            seen++;
            try
            {
                var data = Element(item.Key);
                if (data == null) continue; // Do not traverse password subtrees.
                data["depth"] = item.Value;
                result.Add(new KeyValuePair<AutomationElement, Dictionary<string, object>>(item.Key, data));
                if (item.Value >= 8) { truncated = true; continue; }
                var child = Walker.GetFirstChild(item.Key);
                while (child != null && seen + queue.Count < 250 && time.ElapsedMilliseconds < 5000)
                {
                    queue.Enqueue(new KeyValuePair<AutomationElement, int>(child, item.Value + 1));
                    child = Walker.GetNextSibling(child);
                }
                if (child != null) truncated = true;
            }
            catch (ElementNotAvailableException) { truncated = true; }
        }
        truncated |= queue.Count > 0;
        return result;
    }

    static object Inspect(Dictionary<string, object> target)
    {
        var root = Root(target);
        bool truncated;
        var tree = ReadTree(root, out truncated);
        return new { window = Window(root), elements = tree.Select(item => item.Value).ToArray(), truncated = truncated };
    }

    static bool ExpectedState(object pattern, string kind, string value, string previousToggle)
    {
        switch (kind)
        {
            case "set_value": return ((ValuePattern)pattern).Current.Value == value;
            case "select": return ((SelectionItemPattern)pattern).Current.IsSelected;
            case "toggle": return ((TogglePattern)pattern).Current.ToggleState.ToString() != previousToggle;
            case "expand": return ((ExpandCollapsePattern)pattern).Current.ExpandCollapseState == ExpandCollapseState.Expanded;
            case "collapse": return ((ExpandCollapsePattern)pattern).Current.ExpandCollapseState == ExpandCollapseState.Collapsed;
            default: return false;
        }
    }

    static object Act(Dictionary<string, object> request)
    {
        var target = (Dictionary<string, object>)request["window"];
        var expected = (Dictionary<string, object>)request["element"];
        var root = Root(target);
        bool truncated;
        var wantedId = ((object[])expected["runtimeId"]).Select(Convert.ToInt32).ToArray();
        var matches = ReadTree(root, out truncated).Where(item => ((int[])item.Value["runtimeId"]).SequenceEqual(wantedId)).ToArray();
        if (matches.Length != 1) throw new InvalidOperationException("Control is stale or outside the bounded tree; inspect again");
        var control = matches[0].Key;
        var current = Element(control);
        if (current == null) throw new InvalidOperationException("Protected control");
        foreach (string key in new [] { "name", "automationId", "controlType", "value", "valueFingerprint", "toggleState", "selected", "expandState" })
            if (expected.ContainsKey(key) && (!current.ContainsKey(key) || Convert.ToString(expected[key]) != Convert.ToString(current[key])))
                throw new InvalidOperationException("Control changed since inspection; inspect again");
        if (!(bool)current["enabled"]) throw new InvalidOperationException("Control is disabled");
        // An offscreen control may be virtualized or stale. Do not focus/scroll it implicitly.
        if ((bool)current["offscreen"]) throw new InvalidOperationException("Control is offscreen; no foreground fallback was attempted");
        string kind = (string)request["kind"];
        if (!Patterns.ContainsKey(kind)) throw new InvalidOperationException("Unsupported semantic action");
        object pattern;
        if (!control.TryGetCurrentPattern(Patterns[kind], out pattern))
            throw new InvalidOperationException("Control does not support this action; no mouse fallback was attempted");
        string value = request.ContainsKey("value") ? (string)request["value"] : null;
        if (kind == "set_value" && (value == null || value.Length > 2000 || value.Contains("\0")))
            throw new InvalidOperationException("Value must contain 0-2000 characters and no NUL");
        Root(target); // Recheck the process lifetime immediately before mutation.
        bool delivered = false;
        var foregroundBefore = GetForegroundWindow();
        var inputBefore = InputTick();
        bool targetWasForeground = TargetHasForeground(Convert.ToInt32(target["pid"]));
        CursorPoint cursorBefore;
        GetCursorPos(out cursorBefore);
        try
        {
            switch (kind)
            {
                case "invoke": ((InvokePattern)pattern).Invoke(); break;
                case "set_value":
                    if (((ValuePattern)pattern).Current.IsReadOnly) throw new InvalidOperationException("Control is read-only");
                    ((ValuePattern)pattern).SetValue(value); break;
                case "select": ((SelectionItemPattern)pattern).Select(); break;
                case "toggle": ((TogglePattern)pattern).Toggle(); break;
                case "expand": ((ExpandCollapsePattern)pattern).Expand(); break;
                case "collapse": ((ExpandCollapsePattern)pattern).Collapse(); break;
            }
            delivered = true;
            // Poll the native state, never repeat the mutation. Invoke has no generic postcondition.
            bool verifiable = kind != "invoke";
            bool matched = false;
            var wait = Stopwatch.StartNew();
            if (verifiable)
            {
                string previousToggle = current.ContainsKey("toggleState") ? (string)current["toggleState"] : "";
                do
                {
                    matched = ExpectedState(pattern, kind, value, previousToggle);
                    if (matched || wait.ElapsedMilliseconds >= 1500) break;
                    Thread.Sleep(50);
                } while (true);
            }
            else Thread.Sleep(120);
            var after = Inspect(target);
            bool inputChanged = InputTick() != inputBefore;
            bool inputInterference = inputChanged && (targetWasForeground || TargetHasForeground(Convert.ToInt32(target["pid"])));
            CursorPoint cursorAfter;
            GetCursorPos(out cursorAfter);
            return new { performed = true, verified = verifiable ? (object)matched : null,
                verification = verifiable ? (matched ? "expected_state_observed" : "expected_state_timeout") : "inspect_returned_state",
                outcome = inputInterference || (verifiable && !matched) ? "unknown" : "observed",
                inputChanged = inputChanged, inputInterference = inputInterference, waitedMs = wait.ElapsedMilliseconds, state = after,
                foregroundChanged = GetForegroundWindow() != foregroundBefore,
                targetActivated = GetForegroundWindow() != foregroundBefore && TargetHasForeground(Convert.ToInt32(target["pid"])),
                cursorMoved = cursorBefore.X != cursorAfter.X || cursorBefore.Y != cursorAfter.Y };
        }
        catch (Exception error)
        {
            CursorPoint cursorAfter;
            GetCursorPos(out cursorAfter);
            return new { performed = delivered ? (object)true : null, observationFailed = delivered, outcome = "unknown", error = Text(error.Message, 500),
                foregroundChanged = GetForegroundWindow() != foregroundBefore,
                targetActivated = GetForegroundWindow() != foregroundBefore && TargetHasForeground(Convert.ToInt32(target["pid"])),
                cursorMoved = cursorBefore.X != cursorAfter.X || cursorBefore.Y != cursorAfter.Y,
                guidance = "The provider call may have acted. Inspect current state; never replay this action blindly." };
        }
    }

    [MTAThread]
    public static int Main()
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            var input = new StringBuilder();
            int next;
            while ((next = Console.In.Read()) >= 0)
            {
                if (input.Length >= 262144) throw new InvalidOperationException("Request too large");
                input.Append((char)next);
            }
            var request = (Dictionary<string, object>)Json.DeserializeObject(input.ToString());
            object result;
            switch ((string)request["command"])
            {
                case "windows":
                    var windows = new List<Dictionary<string, object>>();
                    var list = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
                    for (int i = 0; i < list.Count && windows.Count < 80; i++)
                        try { if (list[i].Current.NativeWindowHandle != 0 && !list[i].Current.IsPassword) windows.Add(Window(list[i])); }
                        catch (Exception) { }
                    result = new { windows = windows }; break;
                case "inspect": result = Inspect((Dictionary<string, object>)request["window"]); break;
                case "action": result = Act(request); break;
                default: throw new InvalidOperationException("Unknown UI Automation command");
            }
            Console.WriteLine(Json.Serialize(new { ok = true, result = result }));
            return 0;
        }
        catch (Exception error)
        {
            Console.WriteLine(Json.Serialize(new { ok = false, error = Text(error.Message, 1000) }));
            return 1;
        }
    }
}
