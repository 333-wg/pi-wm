using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Invisible, non-activating test surface. Only its controls are read by the test.
class FixtureWindow : Form
{
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get { var value = base.CreateParams; value.ExStyle |= 0x08000000; return value; }
    }
}

// UIA ValuePattern uses the provider's value setter, not keyboard messages.
// Discard keyboard input so this disposable fixture never records the user's typing.
class FixtureTextBox : TextBox
{
    protected override void WndProc(ref Message message)
    {
        if ((message.Msg >= 0x0100 && message.Msg <= 0x010F) || message.Msg == 0x0286) return;
        base.WndProc(ref message);
    }
}

static class ComputerUiaFixture
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);

    [STAThread]
    static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Console.OutputEncoding = new UTF8Encoding(false);
        var foreground = GetForegroundWindow();
        Point cursor;
        GetCursorPos(out cursor);
        var form = new FixtureWindow { Text = "Wuming UIA verification", Name = "UiaFixture", Width = 380, Height = 210,
            StartPosition = FormStartPosition.Manual, Location = new Point(80, 80), ShowInTaskbar = false, Opacity = 0 };
        var input = new FixtureTextBox { Name = "TestInput", AccessibleName = "Test input", Text = "initial", Left = 15, Top = 15, Width = 200, ImeMode = ImeMode.Disable };
        var delayed = new FixtureTextBox { Name = "DelayedInput", AccessibleName = "Delayed input", Text = "initial", Left = 225, Top = 15, Width = 110, ImeMode = ImeMode.Disable };
        bool updating = false;
        delayed.TextChanged += delegate {
            if (updating) return;
            var requested = delayed.Text;
            if (requested != "delayed-confirmation" && requested != "refused-value") return;
            updating = true;
            delayed.Text = "pending";
            updating = false;
            if (requested == "delayed-confirmation") {
                var apply = new Timer { Interval = 350 };
                apply.Tick += delegate {
                    apply.Stop();
                    updating = true;
                    delayed.Text = requested;
                    updating = false;
                    apply.Dispose();
                };
                apply.Start();
            }
        };
        var password = new FixtureTextBox { Name = "TestPassword", AccessibleName = "Password", Text = "fixture-secret-must-not-leak", UseSystemPasswordChar = true, Left = 15, Top = 45, ImeMode = ImeMode.Disable };
        var button = new Button { Name = "TestSave", AccessibleName = "Save fixture", Text = "Save fixture", Left = 15, Top = 80, Width = 130 };
        var label = new Label { Name = "TestResult", Text = "Not saved", Left = 15, Top = 120, Width = 220 };
        int activations = 0;
        form.Activated += delegate { activations++; };
        button.Click += delegate {
            File.WriteAllText(args[0], input.Text, new UTF8Encoding(false));
            label.Text = "Saved: " + input.Text;
            Point after;
            GetCursorPos(out after);
            File.WriteAllText(args[0] + ".evidence.json", new JavaScriptSerializer().Serialize(new {
                foregroundBefore = foreground.ToInt64().ToString(), foregroundAfter = GetForegroundWindow().ToInt64().ToString(),
                fixtureWindow = form.Handle.ToInt64().ToString(), activations = activations,
                cursorBefore = new { x = cursor.X, y = cursor.Y }, cursorAfter = new { x = after.X, y = after.Y }
            }));
        };
        form.Controls.AddRange(new Control[] { input, delayed, password, button, label });
        form.Shown += delegate {
            var process = Process.GetCurrentProcess();
            Console.WriteLine(new JavaScriptSerializer().Serialize(new {
                window = new { id = form.Handle.ToInt64().ToString(), pid = process.Id, process = process.ProcessName,
                    title = form.Text, startedAt = process.StartTime.ToUniversalTime().Ticks.ToString() },
                foreground = foreground.ToInt64().ToString(), cursor = new { x = cursor.X, y = cursor.Y }
            }));
        };
        var timer = new Timer { Interval = 60000 };
        timer.Tick += delegate { form.Close(); };
        timer.Start();
        Application.Run(form);
    }
}
