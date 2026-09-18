import unittest
import os
import sys
import tempfile
import subprocess
import time
from pathlib import Path
from unittest.mock import Mock, patch
from computer_windows import Desktop, Input, key_codes, map_point, target_image_size, PhysicalInputMonitor, INPUT_TAG, INPUT_BARRIER, settle_capture, discover_applications, open_application


class ComputerProtocolTests(unittest.TestCase):
    def test_visual_settling_waits_for_three_matches_and_bounds_animation(self):
        for changing in (False, True):
            now = [0.0]
            calls = [0]
            def capture():
                calls[0] += 1
                return calls[0] if changing else min(calls[0], 3)
            def sleep(seconds):
                now[0] += seconds
            value, observation = settle_capture(capture, lambda item: item, 800, lambda: now[0], sleep)
            self.assertEqual(observation["stable"], not changing)
            self.assertLessEqual(observation["waitedMs"], 800)
            self.assertEqual(observation["samples"], calls[0])
            self.assertEqual(value, calls[0] if changing else 3)

    def test_monitor_barrier_drains_pending_user_input(self):
        monitor = PhysicalInputMonitor()
        monitor.thread = Mock()
        monitor.thread.is_alive.return_value = True
        monitor.thread_id = 123
        user = Mock()
        def posted(_thread, message, _w, _l):
            self.assertEqual(message, INPUT_BARRIER)
            monitor.interrupted.set()
            monitor.barrier.set()
            return True
        user.PostThreadMessageW.side_effect = posted
        with patch("computer_windows.ctypes.WinDLL", return_value=user):
            with self.assertRaisesRegex(RuntimeError, "User input detected"):
                monitor.check(synchronize=True)

    def test_monitor_detects_missing_injected_events_and_dead_thread(self):
        monitor = PhysicalInputMonitor()
        monitor.thread = Mock()
        monitor.thread.is_alive.return_value = True
        monitor.thread_id = 123
        monitor.expected_agent_count = 2
        monitor.agent_count = 1
        user = Mock()
        user.PostThreadMessageW.side_effect = lambda *_: (monitor.barrier.set() or True)
        with patch("computer_windows.ctypes.WinDLL", return_value=user):
            with self.assertRaisesRegex(RuntimeError, "delivery could not be observed"):
                monitor.check(synchronize=True)
        monitor.thread.is_alive.return_value = False
        with self.assertRaisesRegex(RuntimeError, "monitor stopped"):
            monitor.check(synchronize=True)

    def test_monitor_barrier_failure_never_reports_success(self):
        monitor = PhysicalInputMonitor()
        monitor.thread = Mock()
        monitor.thread.is_alive.return_value = True
        monitor.thread_id = 123
        user = Mock()
        user.PostThreadMessageW.return_value = False
        with patch("computer_windows.ctypes.WinDLL", return_value=user):
            with self.assertRaisesRegex(RuntimeError, "did not synchronize"):
                monitor.check(synchronize=True)

    def test_action_receipt_distinguishes_not_started_from_partial_outcome(self):
        for started in (False, True):
            desktop = Desktop.__new__(Desktop)
            desktop.kernel = Mock()
            desktop.kernel.CreateMutexW.return_value = 1
            desktop.kernel.WaitForSingleObject.return_value = 0
            def fail(_request):
                desktop.mutation_started = started
                raise RuntimeError("interrupted")
            desktop.action = Mock(side_effect=fail)
            with patch("computer_windows.PhysicalInputMonitor"):
                receipt = desktop.run({"command": "action", "receiptVersion": 2})
            self.assertEqual(receipt["outcome"], "unknown" if started else "not_started")
            self.assertIs(receipt["performed"], None if started else False)
            desktop.action.assert_called_once()
            desktop.kernel.ReleaseMutex.assert_called_once()

    def test_legacy_host_cannot_mistake_an_unknown_receipt_for_success(self):
        desktop = Desktop.__new__(Desktop)
        desktop.kernel = Mock()
        desktop.kernel.CreateMutexW.return_value = 1
        desktop.kernel.WaitForSingleObject.return_value = 0
        desktop.action = Mock(side_effect=RuntimeError("input failed"))
        with patch("computer_windows.PhysicalInputMonitor"):
            with self.assertRaisesRegex(RuntimeError, "input failed"):
                desktop.run({"command": "action"})

    def test_global_input_tick_change_does_not_block_win_d(self):
        desktop = Desktop.__new__(Desktop)
        desktop.input_tick = Mock(return_value=101)
        desktop.user = Mock()
        desktop.user.GetAsyncKeyState.return_value = 0
        desktop.user.GetForegroundWindow.return_value = 42
        target = {"id": "42", "pid": 5, "process": "fixture.exe", "bounds": [0, 0, 800, 600]}
        desktop.window = Mock(return_value=target)
        desktop.check_target = Mock()
        desktop.send = Mock()
        desktop.action({"action": {"kind": "key", "key": "WIN+D"},
                        "snapshot": {"foreground": target, "inputTick": 100}})
        desktop.send.assert_called_once()
        self.assertEqual([event.ki.wVk for event in desktop.send.call_args.args[0]], [0x5B, 68, 68, 0x5B])

    def test_launch_uses_observed_shortcuts_and_rejects_changes_or_arbitrary_paths(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "Fixture.lnk"
            path.write_bytes(b"fixture-shortcut")
            (Path(root) / "not-an-app.ps1").write_text("ignored")
            inventory = discover_applications([root])
            self.assertEqual([app["name"] for app in inventory["apps"]], ["Fixture"])
            app = inventory["apps"][0]
            with patch("computer_windows.os.startfile", create=True) as start:
                self.assertEqual(open_application(app, [root])["outcome"], "launch_requested")
                start.assert_called_once_with(str(path), "open")
                path.write_bytes(b"changed-shortcut")
                self.assertEqual(open_application(app, [root])["outcome"], "not_started")
                self.assertEqual(open_application({"path": "cmd.exe", "fingerprint": "invented"}, [root])["outcome"], "not_started")
                self.assertEqual(start.call_count, 1)

    @unittest.skipUnless(sys.platform == "win32" and os.environ.get("WUMING_TEST_LAUNCH") == "1", "opt-in native launch fixture")
    def test_native_shell_opens_a_disposable_shortcut_without_keyboard_input(self):
        with tempfile.TemporaryDirectory(prefix="wuming-launch-") as root:
            exe = Path(root) / "fixture.exe"
            receipt = Path(root) / "launched.txt"
            shortcut = Path(root) / "Fixture.lnk"
            fixture = Path(__file__).resolve().parent.parent / "test" / "fixtures" / "LaunchFixture.cs"
            compiler = Path(os.environ["SystemRoot"]) / "Microsoft.NET" / "Framework64" / "v4.0.30319" / "csc.exe"
            subprocess.run([str(compiler), "/nologo", "/target:winexe", "/out:" + str(exe), str(fixture)],
                           check=True, capture_output=True, timeout=20, creationflags=subprocess.CREATE_NO_WINDOW)
            script = '$s = New-Object -ComObject WScript.Shell; $l = $s.CreateShortcut($env:WUMING_TEST_SHORTCUT); $l.TargetPath = $env:WUMING_TEST_EXE; $l.Arguments = [char]34 + $env:WUMING_TEST_RECEIPT + [char]34; $l.Save()'
            subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], check=True,
                           capture_output=True, timeout=20, creationflags=subprocess.CREATE_NO_WINDOW,
                           env={**os.environ, "WUMING_TEST_SHORTCUT": str(shortcut), "WUMING_TEST_EXE": str(exe), "WUMING_TEST_RECEIPT": str(receipt)})
            app = discover_applications([root])["apps"][0]
            self.assertEqual(open_application(app, [root])["outcome"], "launch_requested")
            deadline = time.monotonic() + 5
            while not receipt.exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertEqual(receipt.read_text(), "launched")

    def test_foreground_input_is_tagged_and_yields_to_user(self):
        desktop = Desktop.__new__(Desktop)
        desktop.user = Mock()
        desktop.user.GetAsyncKeyState.return_value = 0
        desktop.input_monitor = PhysicalInputMonitor()
        self.assertEqual(desktop.key(65).ki.dwExtraInfo, INPUT_TAG)
        self.assertEqual(desktop.mouse(2).mi.dwExtraInfo, INPUT_TAG)
        desktop.input_monitor.interrupted.set()
        with self.assertRaisesRegex(RuntimeError, "User input detected"):
            desktop.send([desktop.key(65), desktop.key(65, flags=2)])
        desktop.user.SendInput.assert_not_called()

    def test_upstream_resize_budget_and_portrait_symmetry(self):
        for width, height in [(1, 1), (800, 600), (1920, 1080), (3840, 2160), (3456, 2234), (2160, 3840), (8192, 8192)]:
            w, h = target_image_size(width, height)
            self.assertLessEqual(max(w, h), 1568)
            self.assertLessEqual(((w - 1) // 28 + 1) * ((h - 1) // 28 + 1), 1568)
            self.assertLessEqual(w, width)
            self.assertLessEqual(h, height)
            self.assertEqual((h, w), target_image_size(height, width))
            self.assertLessEqual(abs(h - w * height / width), 1)
        self.assertEqual(target_image_size(800, 600), (800, 600))
        with self.assertRaises(ValueError):
            target_image_size(0, 100)

    def test_partial_input_send_attempts_release(self):
        desktop = Desktop.__new__(Desktop)
        desktop.emergency = Mock()
        desktop.user = Mock()
        desktop.user.SendInput.return_value = 1
        with self.assertRaisesRegex(RuntimeError, "rejected input"):
            desktop.send([desktop.key(17), desktop.key(65), desktop.key(65, flags=2), desktop.key(17, flags=2)])
        self.assertEqual(desktop.user.SendInput.call_count, 2)
        cleanup = desktop.user.SendInput.call_args.args[1]
        self.assertEqual([event.ki.dwFlags for event in cleanup], [2, 2])

    def test_scaled_negative_origin(self):
        shot = {"width": 800, "height": 600, "screenWidth": 1600, "screenHeight": 1200, "left": -1600, "top": -200}
        self.assertEqual(map_point(400, 300, shot), (-800, 400))
        self.assertEqual(map_point(799, 599, shot), (-2, 998))
        for x, y in [(-1, 0), (800, 0), (0, 600), (True, 0), (1.5, 0)]:
            with self.assertRaises(ValueError):
                map_point(x, y, shot)

    def test_key_allowlist(self):
        self.assertEqual(key_codes("CTRL+A"), [0x11, 65])
        self.assertEqual(key_codes("ENTER"), [0x0D])
        for key in ["CTRL", "A+B", "CTRL+CTRL+A", "RUN:CMD", "", "CTRL+ALT+SHIFT+WIN+A"]:
            with self.assertRaises(ValueError):
                key_codes(key)

    def test_foreground_guard_and_identity(self):
        desktop = Desktop.__new__(Desktop)
        desktop.emergency = Mock()
        desktop.user = Mock()
        target = {"id": "42", "pid": 5, "process": "editor.exe", "bounds": [0, 0, 800, 600]}
        desktop.window = Mock(return_value=dict(target))
        desktop.user.GetForegroundWindow.return_value = 99
        with self.assertRaisesRegex(RuntimeError, "Foreground"):
            desktop.check_target(target)
        desktop.user.GetForegroundWindow.return_value = 42
        desktop.window.return_value["pid"] = 6
        with self.assertRaisesRegex(RuntimeError, "Target"):
            desktop.check_target(target)
        desktop.window.return_value = {**target, "bounds": [1, 0, 800, 600]}
        with self.assertRaisesRegex(RuntimeError, "moved"):
            desktop.check_target(target)

    def test_unicode_down_up_are_one_batch(self):
        desktop = Desktop.__new__(Desktop)
        desktop.user = Mock()
        desktop.user.GetForegroundWindow.return_value = 42
        desktop.user.GetAsyncKeyState.return_value = 0
        target = {"id": "42", "pid": 5, "process": "editor.exe", "bounds": [0, 0, 800, 600]}
        desktop.window = Mock(return_value=target)
        desktop.check_target = Mock()
        desktop.send = Mock()
        desktop.action({"action": {"kind": "type", "text": "\u4e2d\U0001f600"}, "snapshot": {"foreground": target}})
        self.assertEqual(desktop.send.call_count, 2)
        self.assertEqual([event.ki.dwFlags for event in desktop.send.call_args_list[0].args[0]], [4, 6])
        self.assertEqual([event.ki.dwFlags for event in desktop.send.call_args_list[1].args[0]], [4, 6, 4, 6])

    def test_refocus_only_approved_window_before_typing(self):
        desktop = Desktop.__new__(Desktop)
        desktop.user = Mock()
        desktop.user.GetForegroundWindow.return_value = 99
        desktop.user.GetAsyncKeyState.return_value = 0
        target = {"id": "42", "pid": 5, "process": "editor.exe", "bounds": [0, 0, 800, 600]}
        desktop.window = Mock(return_value=target)
        desktop.check_target = Mock()
        desktop.send = Mock()
        with patch("computer_windows.time.sleep"):
            desktop.action({"action": {"kind": "key", "key": "CTRL+A"}, "snapshot": {"foreground": target}, "restoreFocus": True})
        desktop.user.SetForegroundWindow.assert_called_once_with(42)
        events = desktop.send.call_args.args[0]
        self.assertEqual([event.ki.wVk for event in events], [17, 65, 65, 17])
        self.assertEqual([event.ki.dwFlags for event in events], [0, 0, 2, 2])

    def test_settings_grant_does_not_steal_focus_after_user_switches_windows(self):
        desktop = Desktop.__new__(Desktop)
        desktop.user = Mock()
        desktop.user.GetForegroundWindow.return_value = 99
        desktop.user.GetAsyncKeyState.return_value = 0
        target = {"id": "42", "pid": 5, "process": "editor.exe", "bounds": [0, 0, 800, 600]}
        desktop.window = Mock(return_value=target)
        desktop.check_target = Mock()
        desktop.send = Mock()
        with self.assertRaisesRegex(RuntimeError, "Foreground changed"):
            desktop.action({"action": {"kind": "key", "key": "CTRL+A"}, "snapshot": {"foreground": target}})
        desktop.user.SetForegroundWindow.assert_not_called()
        desktop.send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
