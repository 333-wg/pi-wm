"""Bounded Windows desktop operations. One JSON request/result per process.

Uses the same mss/Pillow + Win32 approach as cc-haha, with a deliberately
smaller protocol: no shell, clipboard access, held keys or arbitrary scripts.
"""
from __future__ import annotations

import base64
import ctypes
import io
import json
import math
import sys
import time
import threading
import hashlib
import os
from ctypes import wintypes


def target_image_size(width, height, px_per_token=28, max_px=1568, max_tokens=1568):
    """Port of cc-haha imageResize.ts, MIT, Copyright (c) 2026 cc-haha.

    Source commit: 0676c194e84b2da77c94d3992eadbf6e5eb9d7cb.
    See CC-HAHA-LICENSE.txt. This is a conservative sizing policy, not a
    guarantee that every model provider uses the same vision encoder.
    """
    def tokens(w, h):
        return ((w - 1) // px_per_token + 1) * ((h - 1) // px_per_token + 1)

    if min(width, height, px_per_token, max_px, max_tokens) < 1:
        raise ValueError("Image dimensions and resize limits must be positive")
    if width <= max_px and height <= max_px and tokens(width, height) <= max_tokens:
        return width, height
    if height > width:
        w, h = target_image_size(height, width, px_per_token, max_px, max_tokens)
        return h, w
    aspect_ratio = width / height
    lower, upper = 1, width
    # Match JavaScript Math.round for positive dimensions, not banker's rounding.
    def scaled_height(w):
        return max(math.floor(w / aspect_ratio + 0.5), 1)

    while lower + 1 < upper:
        middle = (lower + upper) // 2
        if middle <= max_px and tokens(middle, scaled_height(middle)) <= max_tokens:
            lower = middle
        else:
            upper = middle
    return lower, scaled_height(lower)


def integer(value, name, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"Invalid {name}")
    return value


def map_point(x, y, shot):
    integer(x, "x", 0, shot["width"] - 1)
    integer(y, "y", 0, shot["height"] - 1)
    return (
        shot["left"] + math.floor(x * shot["screenWidth"] / shot["width"]),
        shot["top"] + math.floor(y * shot["screenHeight"] / shot["height"]),
    )


KEYS = {"CTRL": 0x11, "ALT": 0x12, "SHIFT": 0x10, "WIN": 0x5B,
        "ENTER": 0x0D, "TAB": 0x09, "ESC": 0x1B, "SPACE": 0x20,
        "BACKSPACE": 0x08, "DELETE": 0x2E, "HOME": 0x24, "END": 0x23,
        "PAGEUP": 0x21, "PAGEDOWN": 0x22, "LEFT": 0x25, "UP": 0x26,
        "RIGHT": 0x27, "DOWN": 0x28}
KEYS.update({str(i): ord(str(i)) for i in range(10)})
KEYS.update({chr(i): i for i in range(65, 91)})
KEYS.update({f"F{i}": 0x6F + i for i in range(1, 13)})


def key_codes(value):
    if not isinstance(value, str):
        raise ValueError("Invalid key combination")
    names = value.upper().split("+")
    if not 1 <= len(names) <= 4 or len(set(names)) != len(names) or any(n not in KEYS for n in names):
        raise ValueError("Unknown key combination")
    if any(n not in ("CTRL", "ALT", "SHIFT", "WIN") for n in names[:-1]):
        raise ValueError("Only the last key may be a non-modifier")
    if names[-1] in ("CTRL", "ALT", "SHIFT", "WIN"):
        raise ValueError("A non-modifier key is required")
    return [KEYS[n] for n in names]


def discover_applications(roots=None):
    """Read installed Start Menu shortcuts; never interpret a model-supplied command."""
    if roots is None:
        roots = [os.path.join(base, "Microsoft", "Windows", "Start Menu", "Programs")
                 for base in (os.environ.get("APPDATA"), os.environ.get("PROGRAMDATA")) if base]
    apps = []
    visited = 0
    truncated = False
    seen = set()
    for root in roots:
        root = os.path.realpath(root)
        for directory, dirs, files in os.walk(root, followlinks=False):
            visited += 1
            if visited > 2000:
                return {"apps": apps, "truncated": True}
            depth = len(os.path.relpath(directory, root).split(os.sep))
            if depth >= 6:
                truncated |= bool(dirs)
                dirs[:] = []
            else:
                dirs.sort()
            for name in sorted(files):
                if not name.lower().endswith(".lnk"):
                    continue
                path = os.path.realpath(os.path.join(directory, name))
                if os.path.commonpath([path, root]) != root or path in seen:
                    continue
                try:
                    with open(path, "rb") as source:
                        data = source.read(1024 * 1024 + 1)
                    if len(data) > 1024 * 1024:
                        continue
                    fingerprint = hashlib.sha256(data).hexdigest()
                except OSError:
                    continue
                seen.add(path)
                apps.append({"name": name[:-4][:160], "path": path, "fingerprint": fingerprint})
                if len(apps) >= 300:
                    return {"apps": apps, "truncated": True}
    return {"apps": apps, "truncated": truncated}


def open_application(expected, roots=None):
    if not isinstance(expected, dict):
        raise ValueError("List applications before opening one")
    current = next((app for app in discover_applications(roots)["apps"]
                    if app["path"] == expected.get("path") and app["fingerprint"] == expected.get("fingerprint")), None)
    if current is None:
        return {"performed": False, "outcome": "not_started", "error": "Application shortcut changed; list applications again"}
    try:
        os.startfile(current["path"], "open")
        return {"performed": True, "outcome": "launch_requested", "name": current["name"],
                "guidance": "Launch requested, not verified. List windows to check the app opened; do not launch it again blindly."}
    except OSError as error:
        return {"performed": None, "outcome": "unknown", "error": str(error),
                "guidance": "Check current windows before deciding; do not repeat the launch blindly."}


class MouseInput(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class KeyboardInput(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.c_size_t)]


class InputData(ctypes.Union):
    _fields_ = [("mi", MouseInput), ("ki", KeyboardInput)]


class Input(ctypes.Structure):
    _anonymous_ = ("data",)
    _fields_ = [("type", wintypes.DWORD), ("data", InputData)]


class LastInputInfo(ctypes.Structure):
    _fields_ = [("size", wintypes.UINT), ("tick", wintypes.DWORD)]


INPUT_TAG = time.time_ns() & ((1 << (ctypes.sizeof(ctypes.c_size_t) * 8)) - 1)
INPUT_BARRIER = 0x8001


def settle_capture(capture, fingerprint, timeout_ms, clock=time.monotonic, sleep=time.sleep):
    """Bounded read-only observation, never replay the action being observed."""
    start = clock()
    value = capture()
    previous = fingerprint(value)
    same = 0
    samples = 1
    while (clock() - start) * 1000 < timeout_ms:
        sleep(min(0.1, max(0, timeout_ms / 1000 - (clock() - start))))
        value = capture()
        current = fingerprint(value)
        samples += 1
        same = same + 1 if current == previous else 0
        previous = current
        if same >= 3:
            break
    return value, {"stable": same >= 3, "waitedMs": round((clock() - start) * 1000), "samples": samples}


class PhysicalInputMonitor:
    """Observe input without suppressing it or recording keys; ignore only our tag."""
    def __init__(self):
        self.ready = threading.Event()
        self.interrupted = threading.Event()
        self.barrier = threading.Event()
        self.stopping = threading.Event()
        self.agent_count = 0
        self.expected_agent_count = 0
        self.error = None
        self.thread_id = None
        self.thread = threading.Thread(target=self._pump, daemon=True)

    def _pump(self):
        user = ctypes.WinDLL("user32", use_last_error=True)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        callback_type = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)

        class MouseHook(ctypes.Structure):
            _fields_ = [("pt", wintypes.POINT), ("mouseData", wintypes.DWORD),
                        ("flags", wintypes.DWORD), ("time", wintypes.DWORD), ("extra", ctypes.c_size_t)]

        class KeyHook(ctypes.Structure):
            _fields_ = [("vk", wintypes.DWORD), ("scan", wintypes.DWORD),
                        ("flags", wintypes.DWORD), ("time", wintypes.DWORD), ("extra", ctypes.c_size_t)]

        user.SetWindowsHookExW.argtypes = [ctypes.c_int, callback_type, wintypes.HINSTANCE, wintypes.DWORD]
        user.SetWindowsHookExW.restype = wintypes.HANDLE
        user.CallNextHookEx.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
        user.CallNextHookEx.restype = ctypes.c_ssize_t
        user.UnhookWindowsHookEx.argtypes = [wintypes.HANDLE]
        user.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
        user.GetMessageW.restype = ctypes.c_int
        user.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT, wintypes.UINT]
        kernel.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
        kernel.GetModuleHandleW.restype = wintypes.HMODULE
        handles = []

        def observe(structure):
            @callback_type
            def callback(code, message, address):
                try:
                    if code >= 0:
                        if ctypes.cast(address, ctypes.POINTER(structure)).contents.extra == INPUT_TAG:
                            self.agent_count += 1
                        else:
                            self.interrupted.set()
                except Exception as error:
                    self.error = error
                return user.CallNextHookEx(None, code, message, address)
            return callback

        callbacks = [observe(MouseHook), observe(KeyHook)]
        try:
            self.thread_id = kernel.GetCurrentThreadId()
            message = wintypes.MSG()
            user.PeekMessageW(ctypes.byref(message), None, 0, 0, 0)
            for hook_id, callback in zip((14, 13), callbacks):
                handle = user.SetWindowsHookExW(hook_id, callback, kernel.GetModuleHandleW(None), 0)
                if not handle:
                    raise RuntimeError("Cannot monitor user input; refusing foreground automation")
                handles.append(handle)
            self.ready.set()
            while not self.stopping.is_set():
                status = user.GetMessageW(ctypes.byref(message), None, 0, 0)
                if status == -1:
                    raise RuntimeError("User input monitor failed")
                if status == 0:
                    break
                if message.message == INPUT_BARRIER:
                    self.barrier.set()
        except Exception as error:
            self.error = error
            self.ready.set()
            self.barrier.set()
        finally:
            for handle in handles:
                user.UnhookWindowsHookEx(handle)

    def check(self, synchronize=False):
        if self.error:
            raise self.error
        if synchronize:
            if not self.thread_id or not self.thread.is_alive():
                raise RuntimeError("User input monitor stopped; input outcome cannot be trusted")
            self.barrier.clear()
            user = ctypes.WinDLL("user32", use_last_error=True)
            user.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
            if not user.PostThreadMessageW(self.thread_id, INPUT_BARRIER, 0, 0) or not self.barrier.wait(2):
                raise RuntimeError("User input monitor did not synchronize; inspect before continuing")
            if self.error:
                raise self.error
            if self.agent_count < self.expected_agent_count:
                raise RuntimeError("Input delivery could not be observed; inspect before continuing, do not repeat")
        if self.interrupted.is_set():
            raise RuntimeError("User input detected; foreground automation paused. Inspect before continuing; do not repeat the action.")

    def __enter__(self):
        self.thread.start()
        try:
            if not self.ready.wait(2):
                raise RuntimeError("User input monitor did not start; refusing foreground automation")
            self.check(synchronize=True)
        except Exception:
            self.__exit__()
            raise
        return self

    def __exit__(self, *_):
        self.stopping.set()
        if self.thread_id:
            user = ctypes.WinDLL("user32", use_last_error=True)
            user.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
            user.PostThreadMessageW(self.thread_id, 0x0012, 0, 0)
        self.thread.join(timeout=2)


class Desktop:
    def __init__(self):
        if sys.platform != "win32":
            raise RuntimeError("Computer Use requires Windows")
        self.user = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "GetForegroundWindow": ([], wintypes.HWND),
            "GetWindowThreadProcessId": ([wintypes.HWND, ctypes.POINTER(wintypes.DWORD)], wintypes.DWORD),
            "GetWindowTextW": ([wintypes.HWND, wintypes.LPWSTR, ctypes.c_int], ctypes.c_int),
            "GetWindowRect": ([wintypes.HWND, ctypes.POINTER(wintypes.RECT)], wintypes.BOOL),
            "IsWindowVisible": ([wintypes.HWND], wintypes.BOOL),
            "IsIconic": ([wintypes.HWND], wintypes.BOOL),
            "SetForegroundWindow": ([wintypes.HWND], wintypes.BOOL),
            "ShowWindow": ([wintypes.HWND, ctypes.c_int], wintypes.BOOL),
            "WindowFromPoint": ([wintypes.POINT], wintypes.HWND),
            "GetAncestor": ([wintypes.HWND, wintypes.UINT], wintypes.HWND),
            "SendInput": ([wintypes.UINT, ctypes.POINTER(Input), ctypes.c_int], wintypes.UINT),
            "GetAsyncKeyState": ([ctypes.c_int], ctypes.c_short),
            "GetLastInputInfo": ([ctypes.POINTER(LastInputInfo)], wintypes.BOOL),
        }
        for name, (args, result) in signatures.items():
            fn = getattr(self.user, name)
            fn.argtypes, fn.restype = args, result
        self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        self.kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        self.kernel.CreateMutexW.restype = wintypes.HANDLE
        self.kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self.kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
        self.user.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        self.user.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))

    def window(self, hwnd):
        pid = wintypes.DWORD()
        self.user.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        title = ctypes.create_unicode_buffer(1024)
        self.user.GetWindowTextW(hwnd, title, len(title))
        rect = wintypes.RECT()
        self.user.GetWindowRect(hwnd, ctypes.byref(rect))
        path = ctypes.create_unicode_buffer(32768)
        size = wintypes.DWORD(len(path))
        process = self.kernel.OpenProcess(0x1000, False, pid.value)
        if process:
            try:
                self.kernel.QueryFullProcessImageNameW(process, 0, path, ctypes.byref(size))
            finally:
                self.kernel.CloseHandle(process)
        return {"id": str(hwnd or 0), "pid": pid.value, "title": title.value,
                "process": path.value, "bounds": [rect.left, rect.top, rect.right, rect.bottom]}

    def windows(self):
        result = []
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        @callback_type
        def collect(hwnd, _):
            if self.user.IsWindowVisible(hwnd):
                window = self.window(hwnd)
                if window["title"] and window["process"]:
                    result.append(window)
            return len(result) < 100

        self.user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
        self.user.EnumWindows(collect, 0)
        return result

    def emergency(self):
        monitor = getattr(self, "input_monitor", None)
        if monitor:
            monitor.check()
        if all(self.user.GetAsyncKeyState(key) & 0x8000 for key in (0x11, 0x12, 0x7B)):
            raise RuntimeError("Emergency stop: Ctrl+Alt+F12")

    def input_tick(self):
        state = LastInputInfo(ctypes.sizeof(LastInputInfo), 0)
        if not self.user.GetLastInputInfo(ctypes.byref(state)):
            raise RuntimeError("Cannot read desktop input state")
        return state.tick

    def check_target(self, target, foreground=True):
        self.emergency()
        current = self.window(int(target["id"]))
        if not target["process"] or any(current[k] != target[k] for k in ("pid", "process")):
            raise RuntimeError("Target window changed; take a new screenshot")
        if foreground and str(self.user.GetForegroundWindow() or 0) != target["id"]:
            raise RuntimeError("Foreground window changed; take a new screenshot")
        if foreground and current["bounds"] != target["bounds"]:
            raise RuntimeError("Window moved; take a new screenshot")
        return current

    def send(self, events):
        self.emergency()
        self.mutation_started = True
        batch = (Input * len(events))(*events)
        sent = self.user.SendInput(len(batch), batch, ctypes.sizeof(Input))
        monitor = getattr(self, "input_monitor", None)
        if monitor:
            monitor.expected_agent_count += sent
        if sent != len(batch):
            # A partial send must not leave a synthetic modifier/button held.
            releases = [e for e in events if (e.type == 1 and e.ki.dwFlags & 2) or
                        (e.type == 0 and e.mi.dwFlags & (0x0004 | 0x0010))]
            if releases:
                cleanup = (Input * len(releases))(*releases)
                self.user.SendInput(len(cleanup), cleanup, ctypes.sizeof(Input))
            raise RuntimeError("Windows rejected input (possibly an elevated or protected window)")

    def mouse(self, flags, x=0, y=0, data=0):
        return Input(type=0, mi=MouseInput(x, y, data & 0xFFFFFFFF, flags, 0, INPUT_TAG))

    def key(self, vk, scan=0, flags=0):
        return Input(type=1, ki=KeyboardInput(vk, scan, flags, 0, INPUT_TAG))

    def move_event(self, x, y):
        left, top = self.user.GetSystemMetrics(76), self.user.GetSystemMetrics(77)
        width, height = self.user.GetSystemMetrics(78), self.user.GetSystemMetrics(79)
        return self.mouse(0x0001 | 0x8000 | 0x4000,
                          round((x - left) * 65535 / max(1, width - 1)),
                          round((y - top) * 65535 / max(1, height - 1)))

    def capture(self, monitor, settle_ms=0):
        import mss
        from PIL import Image
        before = self.user.GetForegroundWindow()
        input_tick = self.input_tick()
        target = self.window(before)
        with mss.mss() as screen:
            integer(monitor, "monitor", 1, len(screen.monitors) - 1)
            display = screen.monitors[monitor]
            raw, observation = settle_capture(lambda: screen.grab(display), lambda raw: raw.rgb, settle_ms)
            image = Image.frombytes("RGB", raw.size, raw.rgb)
        image = image.resize(target_image_size(image.width, image.height), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, format="PNG")
        if before != self.user.GetForegroundWindow() or self.window(before) != target:
            raise RuntimeError("Foreground changed during capture; retry the screenshot")
        return {"image": base64.b64encode(output.getvalue()).decode("ascii"),
                "width": image.width, "height": image.height,
                "left": display["left"], "top": display["top"],
                "screenWidth": display["width"], "screenHeight": display["height"],
                "monitor": monitor, "foreground": target, "observation": observation, "inputTick": input_tick,
                "windows": self.windows()}

    def action(self, request):
        action, shot = request["action"], request["snapshot"]
        target = shot["foreground"]
        # Global last-input ticks also change for passive mouse movement and input
        # injected by other software. Validate the target and monitor this action
        # instead of treating every change since the screenshot as a takeover.
        if any(self.user.GetAsyncKeyState(key) & 0x8000 for key in (0x10, 0x11, 0x12, 0x5B, 0x5C, 1, 2, 4)):
            raise RuntimeError("Release the mouse buttons and modifier keys before desktop input")
        if action["kind"] == "focus":
            target = next((w for w in shot["windows"] if w["id"] == action.get("windowId")), None)
            if target is None:
                raise ValueError("Unknown window; take a new screenshot")
            self.check_target(target, foreground=False)
            hwnd = int(target["id"])
            self.mutation_started = True
            if self.user.IsIconic(hwnd):
                self.user.ShowWindow(hwnd, 9)
            self.user.SetForegroundWindow(hwnd)
            time.sleep(0.15)
            if self.user.GetForegroundWindow() != hwnd:
                raise RuntimeError("Windows refused foreground focus")
            return
        if action["kind"] in ("click", "double_click", "right_click", "scroll"):
            import mss
            with mss.mss() as screen:
                monitor = integer(shot["monitor"], "monitor", 1, len(screen.monitors) - 1)
                current = screen.monitors[monitor]
                if any(current[key] != shot[field] for key, field in
                       (("left", "left"), ("top", "top"), ("width", "screenWidth"), ("height", "screenHeight"))):
                    raise RuntimeError("Display layout changed; take a new screenshot")
        # An explicit approval can take focus. Settings-preauthorized actions
        # must instead yield when the user switches to a different window.
        self.check_target(target, foreground=False)
        if self.window(int(target["id"]))["bounds"] != target["bounds"]:
            raise RuntimeError("Window moved; take a new screenshot")
        if str(self.user.GetForegroundWindow() or 0) != target["id"]:
            if request.get("restoreFocus") is not True:
                raise RuntimeError("Foreground changed; take a new screenshot before input")
            self.mutation_started = True
            self.user.SetForegroundWindow(int(target["id"]))
            time.sleep(0.15)
        self.check_target(target)
        kind = action["kind"]
        if kind in ("click", "double_click", "right_click", "scroll"):
            x, y = map_point(action.get("x"), action.get("y"), shot)
            under = self.user.WindowFromPoint(wintypes.POINT(x, y))
            if str(self.user.GetAncestor(under, 2) or 0) != target["id"]:
                raise RuntimeError("Point is outside the captured foreground window")
            events = [self.move_event(x, y)]
            if kind == "scroll":
                amount = integer(action.get("amount"), "amount", -10, 10)
                events.append(self.mouse(0x0800, data=amount * 120))
            else:
                down, up = (0x0008, 0x0010) if kind == "right_click" else (0x0002, 0x0004)
                events.extend([self.mouse(down), self.mouse(up)] * (2 if kind == "double_click" else 1))
            self.check_target(target)
            self.send(events)
        elif kind == "key":
            codes = key_codes(action.get("key"))
            extended = {0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2E, 0x5B}
            self.send([self.key(c, flags=1 if c in extended else 0) for c in codes] +
                      [self.key(c, flags=2 | (1 if c in extended else 0)) for c in reversed(codes)])
        elif kind == "type":
            text = action.get("text")
            if not isinstance(text, str) or not 1 <= len(text) <= 2000 or "\x00" in text:
                raise ValueError("Text must contain 1-2000 characters and no NUL")
            # Each Unicode character is an atomic down/up batch, even if killed.
            for character in text:
                self.check_target(target)
                encoded = character.encode("utf-16-le")
                events = []
                for i in range(0, len(encoded), 2):
                    scan = int.from_bytes(encoded[i:i + 2], "little")
                    events.extend([self.key(0, scan, 4), self.key(0, scan, 6)])
                self.send(events)
        else:
            raise ValueError("Unsupported desktop action")

    def run(self, request):
        lock = self.kernel.CreateMutexW(None, False, "Local\\WumingComputerUseInput")
        if not lock:
            raise RuntimeError("Cannot create desktop control lock")
        acquired = False
        try:
            acquired = self.kernel.WaitForSingleObject(lock, 0) in (0, 0x80)
            if not acquired:
                raise RuntimeError("Another process is controlling the desktop")
            if request["command"] == "screenshot":
                return self.capture(request.get("monitor", 1), integer(request.get("settleMs", 0), "settleMs", 0, 3000))
            if request["command"] == "applications":
                return discover_applications()
            if request["command"] == "open_application":
                return open_application(request.get("application"))
            if request["command"] == "action":
                self.mutation_started = False
                try:
                    with PhysicalInputMonitor() as monitor:
                        self.input_monitor = monitor
                        self.action(request)
                        # Drain hook callbacks before reporting success (cc-haha barrier design).
                        monitor.check(synchronize=True)
                        input_tick = self.input_tick()
                        monitor.check(synchronize=True)
                    return {"performed": True, "outcome": "input_sent", "verification": "requires_observation", "inputTick": input_tick}
                except Exception as error:
                    # Older running hosts expect failed actions to exit nonzero.
                    if request.get("receiptVersion") != 2:
                        raise
                    return {"performed": None if self.mutation_started else False,
                            "outcome": "unknown" if self.mutation_started else "not_started",
                            "error": str(error), "guidance": "Control paused. Observe current state before deciding; do not replay input."}
            raise ValueError("Unknown desktop command")
        finally:
            if acquired:
                self.kernel.ReleaseMutex(lock)
            self.kernel.CloseHandle(lock)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        request = json.loads(sys.stdin.buffer.read(65537))
        if request.get("command") == "probe":
            import mss
            from PIL import Image
            if sys.platform != "win32":
                raise RuntimeError("Computer Use requires Windows")
            result = {"ready": True}
        else:
            result = Desktop().run(request)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=True))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=True))
        sys.exit(1)


if __name__ == "__main__":
    main()
