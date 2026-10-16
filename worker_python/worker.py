import os
import sys
import io
import time
import json
import asyncio
import logging
import ctypes
from typing import Optional

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# Enable Per-Monitor DPI awareness on Windows
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

u32 = ctypes.windll.user32

# Win32 Mouse Constants
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_ABSOLUTE = 0x8000

_INPUT_DESK_HANDLE = None

def attach_thread_to_input_desktop():
    """Attaches current thread to Windows interactive input desktop."""
    global _INPUT_DESK_HANDLE
    try:
        if not _INPUT_DESK_HANDLE:
            _INPUT_DESK_HANDLE = u32.OpenInputDesktop(0, False, 0x01FF)
        if _INPUT_DESK_HANDLE:
            u32.SetThreadDesktop(_INPUT_DESK_HANDLE)
    except Exception:
        pass

# Ensure main thread is attached
attach_thread_to_input_desktop()

def send_mouse_event(flags: int, x: int, y: int, data: int = 0):
    """Sends hardware mouse event with absolute coordinate mapping."""
    attach_thread_to_input_desktop()
    v_left = u32.GetSystemMetrics(76)   # SM_XVIRTUALSCREEN
    v_top = u32.GetSystemMetrics(77)    # SM_YVIRTUALSCREEN
    v_width = u32.GetSystemMetrics(78)  # SM_CXVIRTUALSCREEN
    v_height = u32.GetSystemMetrics(79) # SM_CYVIRTUALSCREEN
    if v_width <= 0 or v_height <= 0:
        v_left = 0
        v_top = 0
        v_width = u32.GetSystemMetrics(0) or 1920
        v_height = u32.GetSystemMetrics(1) or 1080

    norm_x = int((x - v_left) * 65536 / v_width)
    norm_y = int((y - v_top) * 65536 / v_height)

    u32.SetCursorPos(x, y)
    u32.mouse_event(flags | MOUSEEVENTF_ABSOLUTE, norm_x, norm_y, data, 0)


try:
    from mss import MSS
    HAS_MSS = True
except ImportError:
    HAS_MSS = False

from PIL import Image, ImageGrab
import pyautogui
import pyperclip
import websockets

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger("ScreenWorker")

# PyAutoGUI Optimizations
pyautogui.PAUSE = 0.001
pyautogui.FAILSAFE = False  # Avoid exception when moving to screen corners

# Key Translation Table: Browser event.key / event.code -> PyAutoGUI key name
BROWSER_KEY_MAP = {
    "Backspace": "backspace",
    "Tab": "tab",
    "Enter": "enter",
    "Escape": "esc",
    "Space": "space",
    "ArrowUp": "up",
    "ArrowDown": "down",
    "ArrowLeft": "left",
    "ArrowRight": "right",
    "Delete": "delete",
    "Home": "home",
    "End": "end",
    "PageUp": "pageup",
    "PageDown": "pagedown",
    "Insert": "insert",
    "CapsLock": "capslock",
    "ShiftLeft": "shiftleft",
    "ShiftRight": "shiftright",
    "ControlLeft": "ctrlleft",
    "ControlRight": "ctrlright",
    "AltLeft": "altleft",
    "AltRight": "altright",
    "MetaLeft": "winleft",
    "MetaRight": "winright",
    "F1": "f1", "F2": "f2", "F3": "f3", "F4": "f4",
    "F5": "f5", "F6": "f6", "F7": "f7", "F8": "f8",
    "F9": "f9", "F10": "f10", "F11": "f11", "F12": "f12",
}

def select_monitor(monitors):
    monitor_count = len(monitors) - 1
    if monitor_count < 1:
        return 0, monitors[0]

    configured_index = os.environ.get("WORKER_MONITOR", "").strip()
    if configured_index:
        try:
            monitor_index = int(configured_index)
        except ValueError:
            logger.warning("Invalid WORKER_MONITOR value; using monitor 1.")
            monitor_index = 1
    elif sys.stdin.isatty():
        print("Available screens:")
        for monitor_index, monitor in enumerate(monitors[1:], start=1):
            label = " (primary)" if monitor_index == 1 else ""
            print(
                f"  {monitor_index}: {monitor['width']}x{monitor['height']} "
                f"at ({monitor['left']}, {monitor['top']}){label}"
            )
        try:
            selection = input("Choose a screen to mirror [1]: ").strip()
            monitor_index = int(selection) if selection else 1
        except (EOFError, ValueError):
            logger.warning("Invalid screen selection; using monitor 1.")
            monitor_index = 1
    else:
        monitor_index = 1

    if not 1 <= monitor_index <= monitor_count:
        logger.warning("Monitor %d is unavailable; using monitor 1.", monitor_index)
        monitor_index = 1

    return monitor_index, monitors[monitor_index]

class RemoteScreenWorker:
    def __init__(self, relay_url: str, auth_key: str = ""):
        self.relay_url = relay_url
        self.auth_key = auth_key
        self.target_fps = 30
        self.jpeg_quality = 82
        self.scale = 1.0  # Full resolution by default for best quality
        self.zoom_wheel_remainder = 0.0
        self.scroll_wheel_remainder = 0.0
        self.running = True
        self.ws: Optional[websockets.WebSocketClientProtocol] = None

    def get_target_position(self, msg: dict, monitor: dict):
        left = monitor["left"]
        top = monitor["top"]
        width = monitor["width"]
        height = monitor["height"]
        norm_x = msg.get("x", 0.5)
        norm_y = msg.get("y", 0.5)
        target_x = max(left, min(left + width - 1, left + int(norm_x * width)))
        target_y = max(top, min(top + height - 1, top + int(norm_y * height)))
        return target_x, target_y

    def execute_input_event(self, msg: dict, monitor: dict):
        """Translates and triggers mouse/keyboard actions locally with Win32 API."""
        attach_thread_to_input_desktop()
        try:
            event_type = msg.get("type")

            if event_type == "mouse_move":
                target_x, target_y = self.get_target_position(msg, monitor)
                send_mouse_event(MOUSEEVENTF_MOVE, target_x, target_y)

            elif event_type == "mouse_down":
                target_x, target_y = self.get_target_position(msg, monitor)
                btn = msg.get("button", "left")
                flag = MOUSEEVENTF_LEFTDOWN if btn == "left" else MOUSEEVENTF_RIGHTDOWN if btn == "right" else MOUSEEVENTF_MIDDLEDOWN
                send_mouse_event(MOUSEEVENTF_MOVE | flag, target_x, target_y)
                logger.info("[MOUSE DOWN] %s at (%d, %d)", btn, target_x, target_y)

            elif event_type == "mouse_up":
                target_x, target_y = self.get_target_position(msg, monitor)
                btn = msg.get("button", "left")
                flag = MOUSEEVENTF_LEFTUP if btn == "left" else MOUSEEVENTF_RIGHTUP if btn == "right" else MOUSEEVENTF_MIDDLEUP
                send_mouse_event(MOUSEEVENTF_MOVE | flag, target_x, target_y)
                logger.info("[MOUSE UP] %s at (%d, %d)", btn, target_x, target_y)

            elif event_type == "click":
                target_x, target_y = self.get_target_position(msg, monitor)
                btn = msg.get("button", "left")
                flag_down = MOUSEEVENTF_LEFTDOWN if btn == "left" else MOUSEEVENTF_RIGHTDOWN if btn == "right" else MOUSEEVENTF_MIDDLEDOWN
                flag_up = MOUSEEVENTF_LEFTUP if btn == "left" else MOUSEEVENTF_RIGHTUP if btn == "right" else MOUSEEVENTF_MIDDLEUP
                send_mouse_event(MOUSEEVENTF_MOVE | flag_down, target_x, target_y)
                time.sleep(0.02)
                send_mouse_event(MOUSEEVENTF_MOVE | flag_up, target_x, target_y)
                logger.info("[CLICK] %s at (%d, %d)", btn, target_x, target_y)

            elif event_type == "double_click":
                target_x, target_y = self.get_target_position(msg, monitor)
                for _ in range(2):
                    send_mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_LEFTDOWN, target_x, target_y)
                    time.sleep(0.015)
                    send_mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_LEFTUP, target_x, target_y)
                    time.sleep(0.04)
                logger.info("[DOUBLE CLICK] at (%d, %d)", target_x, target_y)

            elif event_type == "scroll":
                target_x, target_y = self.get_target_position(msg, monitor)
                delta_y = float(msg.get("deltaY", 0))
                if delta_y != 0:
                    self.scroll_wheel_remainder -= (delta_y * 1.5)
                    wheel_delta = int(self.scroll_wheel_remainder / 120) * 120
                    if wheel_delta != 0:
                        self.scroll_wheel_remainder -= wheel_delta
                        send_mouse_event(MOUSEEVENTF_WHEEL, target_x, target_y, wheel_delta)
                    elif abs(self.scroll_wheel_remainder) >= 50:
                        step = 120 if self.scroll_wheel_remainder > 0 else -120
                        self.scroll_wheel_remainder = 0.0
                        send_mouse_event(MOUSEEVENTF_WHEEL, target_x, target_y, step)

            elif event_type == "zoom":
                target_x, target_y = self.get_target_position(msg, monitor)
                self.zoom_wheel_remainder += float(msg.get("delta", 0)) * 1.5
                wheel_delta = int(self.zoom_wheel_remainder / 120) * 120
                if wheel_delta:
                    self.zoom_wheel_remainder -= wheel_delta
                    pyautogui.keyDown("ctrl")
                    try:
                        send_mouse_event(MOUSEEVENTF_WHEEL, target_x, target_y, wheel_delta)
                    finally:
                        pyautogui.keyUp("ctrl")

            elif event_type == "key_down":
                key_code = msg.get("code")
                key_char = msg.get("key")
                mapped = BROWSER_KEY_MAP.get(key_code) or BROWSER_KEY_MAP.get(key_char)
                if mapped:
                    pyautogui.keyDown(mapped)
                    logger.info("[KEY DOWN] %s", mapped)
                elif key_char and len(key_char) == 1:
                    pyautogui.keyDown(key_char.lower())
                    logger.info("[KEY DOWN] %s", key_char)

            elif event_type == "key_up":
                key_code = msg.get("code")
                key_char = msg.get("key")
                mapped = BROWSER_KEY_MAP.get(key_code) or BROWSER_KEY_MAP.get(key_char)
                if mapped:
                    pyautogui.keyUp(mapped)
                    logger.info("[KEY UP] %s", mapped)
                elif key_char and len(key_char) == 1:
                    pyautogui.keyUp(key_char.lower())
                    logger.info("[KEY UP] %s", key_char)

            elif event_type == "special_key":
                action = msg.get("action")
                logger.info("[SPECIAL KEY] %s", action)
                if action == "win":
                    pyautogui.press("win")
                elif action == "esc":
                    pyautogui.press("esc")
                elif action == "tab":
                    pyautogui.press("tab")
                elif action == "enter":
                    pyautogui.press("enter")
                elif action == "alttab":
                    pyautogui.hotkey("alt", "tab")
                elif action == "ctrlc":
                    pyautogui.hotkey("ctrl", "c")
                elif action == "ctrlv":
                    pyautogui.hotkey("ctrl", "v")
                elif action == "ctrlaltdel":
                    logger.info("Ctrl+Alt+Del requested")

            elif event_type == "type_text":
                text = msg.get("text", "")
                if text:
                    logger.info("[TYPE TEXT] Length: %d chars", len(text))
                    pyperclip.copy(text)
                    pyautogui.hotkey("ctrl", "v")

            elif event_type == "set_settings":
                if "quality" in msg:
                    self.jpeg_quality = max(20, min(95, int(msg["quality"])))
                if "scale" in msg:
                    self.scale = max(0.4, min(1.0, float(msg["scale"])))
                if "fps" in msg:
                    self.target_fps = max(10, min(60, int(msg["fps"])))
                logger.info(
                    "Settings updated: Quality=%d%%, Scale=%.2f, TargetFPS=%d",
                    self.jpeg_quality, self.scale, self.target_fps
                )

        except Exception as e:
            logger.warning("Error processing input event %s: %s", msg.get("type"), e)

    async def receiver_loop(self, ws, monitor: dict):
        """Listens for remote control commands from Node relay."""
        try:
            async for raw_msg in ws:
                # Handle both text and binary WebSocket frames seamlessly
                if isinstance(raw_msg, (bytes, bytearray)):
                    raw_msg = raw_msg.decode("utf-8", errors="ignore")

                if isinstance(raw_msg, str):
                    try:
                        data = json.loads(raw_msg)
                        if data.get("type") == "ping":
                            await ws.send(json.dumps({"type": "pong"}))
                        else:
                            loop = asyncio.get_running_loop()
                            await loop.run_in_executor(None, self.execute_input_event, data, monitor)
                    except json.JSONDecodeError:
                        pass
        except websockets.exceptions.ConnectionClosed:
            logger.info("Receiver connection closed.")

    async def capture_stream_loop(self, ws, sct, monitor):
        """High-speed screen grabber & compressor with automatic fallback."""
        screen_w = monitor["width"]
        screen_h = monitor["height"]

        # Send initial screen geometry
        await ws.send(json.dumps({
            "type": "screen_info",
            "width": screen_w,
            "height": screen_h,
            "targetFps": self.target_fps
        }))

        loop = asyncio.get_running_loop()
        use_mss = HAS_MSS and sct is not None

        while self.running:
            start_time = time.perf_counter()

            # Grab screen frame
            def grab_and_compress():
                nonlocal use_mss
                attach_thread_to_input_desktop()
                img = None
                if use_mss:
                    try:
                        sct_img = sct.grab(monitor)
                        img = Image.frombytes("RGB", sct_img.size, sct_img.bgra, "raw", "BGRX")
                    except Exception as err:
                        logger.debug("MSS capture failed, trying ImageGrab: %s", err)
                        use_mss = False

                if img is None:
                    try:
                        img = ImageGrab.grab(
                            bbox=(
                                monitor["left"],
                                monitor["top"],
                                monitor["left"] + screen_w,
                                monitor["top"] + screen_h,
                            ),
                            all_screens=True,
                        )
                    except Exception as err:
                        logger.warning("Tela inacessivel temporariamente: %s", err)
                        time.sleep(0.4)
                        return None

                if self.scale < 0.99:
                    scaled_w = max(100, int(screen_w * self.scale))
                    scaled_h = max(100, int(screen_h * self.scale))
                    img = img.resize((scaled_w, scaled_h), Image.Resampling.BILINEAR)

                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=self.jpeg_quality, optimize=False)
                return buf.getvalue()

            jpeg_bytes = await loop.run_in_executor(None, grab_and_compress)

            if jpeg_bytes:
                try:
                    await ws.send(jpeg_bytes)
                except websockets.exceptions.ConnectionClosed:
                    break

            # Frame rate throttle
            elapsed = time.perf_counter() - start_time
            target_delay = 1.0 / self.target_fps
            sleep_time = max(0.001, target_delay - elapsed)
            await asyncio.sleep(sleep_time)

    async def run(self):
        """Main lifecycle with automatic reconnection."""
        logger.info("Starting Remote Screen Worker...")
        logger.info("Relay Server URL: %s", self.relay_url)

        # Select the monitor to capture
        sct_instance = None
        monitor = {"left": 0, "top": 0, "width": 1920, "height": 1080}
        monitor_index = 1

        if HAS_MSS:
            try:
                sct_instance = MSS()
                if len(sct_instance.monitors) > 1:
                    monitor_index, monitor = select_monitor(sct_instance.monitors)
            except Exception as e:
                logger.warning("Could not initialize MSS monitors: %s", e)

        # Fallback to pyautogui / screen metrics if monitor width is missing
        if not monitor.get("width"):
            w, h = pyautogui.size()
            monitor = {"left": 0, "top": 0, "width": w, "height": h}

        logger.info(
            "Screen target %d: %dx%d at (%d, %d)",
            monitor_index,
            monitor["width"],
            monitor["height"],
            monitor["left"],
            monitor["top"],
        )

        while self.running:
            try:
                logger.info("Connecting to Node relay server at %s...", self.relay_url)
                headers = {}
                if self.auth_key:
                    headers["x-worker-secret"] = self.auth_key
                    headers["X-Worker-Auth"] = self.auth_key
                    headers["Authorization"] = f"Bearer {self.auth_key}"

                connect_kwargs = {
                    "max_size": 10 * 1024 * 1024,
                    "ping_interval": 20,
                    "ping_timeout": 20
                }
                if headers:
                    # Support both websockets versions (extra_headers / additional_headers)
                    try:
                        connect_kwargs["additional_headers"] = headers
                    except Exception:
                        connect_kwargs["extra_headers"] = headers

                async with websockets.connect(self.relay_url, **connect_kwargs) as ws:
                    self.ws = ws
                    logger.info(">>> CONNECTED! Transmitting screen and receiving inputs in real time. <<<")

                    stream_task = asyncio.create_task(self.capture_stream_loop(ws, sct_instance, monitor))
                    receiver_task = asyncio.create_task(self.receiver_loop(ws, monitor))

                    done, pending = await asyncio.wait(
                        [stream_task, receiver_task],
                        return_when=asyncio.FIRST_COMPLETED
                    )
                    for task in pending:
                        task.cancel()

            except (websockets.exceptions.WebSocketException, OSError) as e:
                logger.warning("Connection lost (%s). Retrying in 2 seconds...", e)
                await asyncio.sleep(2)
            except Exception as e:
                logger.error("Unexpected error: %s. Retrying in 2 seconds...", e)
                await asyncio.sleep(2)

def main():
    import socket
    import urllib.parse

    base_url = os.environ.get("RELAY_URL", "ws://localhost:8080")
    worker_id = os.environ.get("WORKER_ID", f"worker-{socket.gethostname().lower()}")
    worker_name = os.environ.get("WORKER_NAME", f"Estação ({socket.gethostname()})")
    auth_key = os.environ.get("WORKER_SECRET", os.environ.get("WORKER_AUTH_KEY", ""))

    if len(sys.argv) > 1:
        relay_url = sys.argv[1]
    else:
        encoded_name = urllib.parse.quote(worker_name)
        params = ["role=worker", f"workerId={worker_id}", f"name={encoded_name}"]
        if auth_key:
            params.append(f"token={urllib.parse.quote(auth_key)}")
        relay_url = f"{base_url.rstrip('/')}/?{'&'.join(params)}"

    worker = RemoteScreenWorker(relay_url, auth_key=auth_key)
    try:
        asyncio.run(worker.run())
    except KeyboardInterrupt:
        logger.info("Worker stopped by user.")

if __name__ == "__main__":
    main()
