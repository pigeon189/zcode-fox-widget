#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Antigravity Native Sidecar Server for Gemini Hakimi Token & Rate-Limit Widget
(反重力哈基米记账内置 Sidecar 面板服务)
"""

import os
import re
import sys
import threading
import urllib.request
import json
import time
import glob
import ctypes
import ctypes.wintypes
import signal
import sqlite3
import urllib.parse
import subprocess
from datetime import datetime, timezone, timedelta
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

SIDE_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIR = os.path.abspath(os.path.join(SIDE_DIR, "..", ".."))
ASSETS_DIR = os.path.join(PLUGIN_DIR, "assets")
CONFIG_PATH = os.path.join(PLUGIN_DIR, "config", "config.json")
PID_FILE = os.path.join(PLUGIN_DIR, "config", "pet.pid")
PRICING_PATH = os.path.join(PLUGIN_DIR, "src", "Pricing.json")
QUOTES_PATH = os.path.join(ASSETS_DIR, "quotes.json")
WIDGET_PS1 = os.path.join(PLUGIN_DIR, "src", "HakimiWidget.ps1")

AGY_DIR = os.environ.get("ANTIGRAVITY_APP_DATA_DIR") or os.path.expanduser(r"~\.gemini\antigravity")
BRAIN_DIR = os.path.join(AGY_DIR, "brain")
DB_SUMMARIES = os.path.join(AGY_DIR, "conversation_summaries.db")
PRELOAD_JS_SDK = os.path.join(AGY_DIR, "lib", "node_modules", "sidecar_sdk", "preload.js")

TRANSCRIPT_CACHE = {}
DESKTOP_PET_PROC = None


def load_json(path, default):
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8-sig") as f:
                return json.load(f)
        except Exception:
            pass
    return default


def save_json(path, data):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def get_config():
    default_cfg = {
        "position_x": None,
        "position_y": None,
        "scale": 1.0,
        "bubble_scale": 1.0,
        "opacity": 1.0,
        "sound_enabled": True,
        "sound_volume": 0.8,
        "cache_sound_enabled": False,
        "speech_bubble_enabled": True,
        "topmost": True,
        "click_through": False,
        "follow_antigravity": True,
        "hide_with_antigravity": True,
        "auto_launch_desktop_pet": False,
        "active_model": "gemini-3.8-flash",
        "active_plan": "free",
        "antigravity_brain_path": BRAIN_DIR
    }
    cfg = load_json(CONFIG_PATH, default_cfg)
    for k, v in default_cfg.items():
        if k not in cfg:
            cfg[k] = v
    return cfg



CONV_MODEL_CACHE = {}

def get_conv_model(conv_id):
    if not conv_id:
        return None
    if conv_id in CONV_MODEL_CACHE:
        return CONV_MODEL_CACHE[conv_id]
    db_path = os.path.join(AGY_DIR, "conversations", f"{conv_id}.db")
    if os.path.exists(db_path):
        try:
            with open(db_path, "rb") as f:
                f.seek(max(0, os.path.getsize(db_path) - 120000))
                raw = f.read()
            if b"claude-opus" in raw or b"MODEL_PLACEHOLDER_M26" in raw or b"opus" in raw.lower():
                CONV_MODEL_CACHE[conv_id] = "claude-opus-5-5"
                return "claude-opus-5-5"
            if b"claude-sonnet" in raw or b"MODEL_PLACEHOLDER_M403" in raw or b"MODEL_PLACEHOLDER_M404" in raw or b"MODEL_PLACEHOLDER_M405" in raw or b"sonnet" in raw.lower():
                CONV_MODEL_CACHE[conv_id] = "claude-sonnet-5-5"
                return "claude-sonnet-5-5"
            if b"MODEL_PLACEHOLDER_M417" in raw or b"MODEL_PLACEHOLDER_M418" in raw or b"MODEL_PLACEHOLDER_M419" in raw or b"argon" in raw.lower():
                CONV_MODEL_CACHE[conv_id] = "gemini-4-argon"
                return "gemini-4-argon"
            if b"MODEL_PLACEHOLDER_M318" in raw or b"flash" in raw.lower() or b"gemini-3.8-flash" in raw:
                CONV_MODEL_CACHE[conv_id] = "gemini-3.8-flash"
                return "gemini-3.8-flash"
        except Exception:
            pass
    return detect_antigravity_active_model()

def detect_antigravity_active_model():
    pbtxt = os.path.join(AGY_DIR, "antigravity_state.pbtxt")
    if os.path.exists(pbtxt):
        try:
            with open(pbtxt, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
            m = re.search(r'last_selected_agent_model:\s*(\S+)', content)
            if m:
                val = m.group(1).strip('"\' ')
                if "M318" in val or "flash" in val.lower():
                    return "gemini-3.8-flash"
                if "M417" in val or "M418" in val or "M419" in val or "argon" in val.lower():
                    return "gemini-4-argon"
                if "M26" in val or "opus" in val.lower():
                    return "claude-opus-5-5"
                if "M403" in val or "M404" in val or "M405" in val or "sonnet" in val.lower():
                    return "claude-sonnet-5-5"
        except Exception:
            pass
    return "gemini-3.8-flash"

def get_pricing():
    default_pricing = {
        "usd_to_cny": 7.25,
        "default_model": "gemini-3.8-flash",
        "context_window": 1048576,
        "models": {
            "gemini-4-argon": {
                "display_name": "Gemini 4 Argon",
                "short_name": "4 Argon",
                "context_window": 1048576,
                "tiers": [{"hit": 0.1, "miss": 2.0, "out": 10.0}]
            },
            "gemini-3.8-flash": {
                "display_name": "Gemini 3.8 Flash",
                "short_name": "3.8 Flash",
                "context_window": 1048576,
                "tiers": [{"hit": 0.075, "miss": 0.75, "out": 3.75}]
            },
            "claude-opus-5-5": {
                "display_name": "Claude Opus 5.5",
                "short_name": "Opus 5.5",
                "context_window": 200000,
                "tiers": [{"hit": 0.2, "miss": 4.0, "out": 20.0}]
            },
            "claude-sonnet-5-5": {
                "display_name": "Claude Sonnet 5.5",
                "short_name": "Sonnet 5.5",
                "context_window": 200000,
                "tiers": [{"hit": 0.1, "miss": 2.0, "out": 10.0}]
            }
        },
        "limits": {
            "free": {"rpm": 15, "tpm": 1000000, "rpd": 1500},
            "tier1": {"rpm": 1000, "tpm": 4000000, "rpd": 10000}
        }
    }
    return load_json(PRICING_PATH, default_pricing)


def calculate_cost(inp, cache, out, model_key, pricing):
    models = pricing.get("models", {})
    if model_key not in models:
        model_key = pricing.get("default_model", "gemini-2.5-flash")
    m = models.get(model_key, {})
    rate = float(pricing.get("usd_to_cny", 7.25))
    tiers = m.get("tiers", [{"hit": 0.075, "miss": 0.75, "out": 3.75}])

    total_in = inp + cache
    selected = tiers[0]
    for t in tiers:
        max_in = t.get("maxIn")
        if max_in is None or total_in <= max_in:
            selected = t
            break
        selected = t

    miss_price = float(selected.get("miss", 0.75))
    hit_price = float(selected.get("hit", 0.075))
    out_price = float(selected.get("out", 3.75))

    cost_usd = (inp / 1e6) * miss_price + (cache / 1e6) * hit_price + (out / 1e6) * out_price
    no_cache_usd = ((inp + cache) / 1e6) * miss_price + (out / 1e6) * out_price
    savings_usd = max(0.0, no_cache_usd - cost_usd)

    return {
        "cost_usd": round(cost_usd, 5),
        "cost_cny": round(cost_usd * rate, 4),
        "savings_usd": round(savings_usd, 5),
        "savings_cny": round(savings_usd * rate, 4)
    }


def parse_iso_ts(ts_str):
    if not ts_str:
        return 0.0
    try:
        s = ts_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        return dt.timestamp()
    except Exception:
        return 0.0


def parse_transcript_file(filepath):
    try:
        st = os.stat(filepath)
    except OSError:
        return None

    cached = TRANSCRIPT_CACHE.get(filepath)
    if cached and cached["mtime"] == st.st_mtime and cached["size"] == st.st_size:
        return cached

    parts = os.path.normpath(filepath).split(os.sep)
    conv_id = ""
    if "brain" in parts:
        idx = parts.index("brain")
        if idx + 1 < len(parts):
            conv_id = parts[idx + 1]

    steps = []
    last_user_query = ""
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                if '"USER_INPUT"' in line or '"input_tokens"' in line:
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    if d.get("type") == "USER_INPUT":
                        c = (d.get("content") or "").strip()
                        if "<USER_REQUEST>" in c and "</USER_REQUEST>" in c:
                            c = c.split("<USER_REQUEST>", 1)[1].split("</USER_REQUEST>", 1)[0].strip()
                        if c:
                            last_user_query = c[:80]
                    elif d.get("input_tokens") is not None:
                        inp = int(d.get("input_tokens") or 0)
                        cache = int(d.get("cache_read_tokens") or 0)
                        out = int(d.get("output_tokens") or 0)
                        tot = inp + cache + out
                        hit_rate = round((cache / (inp + cache)) * 100, 1) if (inp + cache) > 0 else 0.0
                        created_at = d.get("created_at") or ""
                        ts = parse_iso_ts(created_at)
                        think_len = len(str(d.get("thinking") or ""))
                        steps.append({
                            "step_index": d.get("step_index", len(steps)),
                            "input_tokens": inp,
                            "cache_read_tokens": cache,
                            "output_tokens": out,
                            "total_tokens": tot,
                            "cache_hit_rate": hit_rate,
                            "created_at": created_at,
                            "ts": ts,
                            "thinking_len": think_len,
                            "query": last_user_query
                        })
    except Exception:
        pass

    entry = {
        "mtime": st.st_mtime,
        "size": st.st_size,
        "conv_id": conv_id,
        "steps": steps
    }
    TRANSCRIPT_CACHE[filepath] = entry
    return entry


def get_conversation_title(conv_id):
    if not conv_id or not os.path.exists(DB_SUMMARIES):
        return conv_id[:8] if conv_id else "当前会话"
    try:
        conn = sqlite3.connect(f"file:{DB_SUMMARIES}?mode=ro", uri=True, timeout=1.5)
        cur = conn.cursor()
        cur.execute("SELECT title FROM conversation_summaries WHERE conversation_id = ?", (conv_id,))
        row = cur.fetchone()
        conn.close()
        if row and row[0]:
            return row[0]
    except Exception:
        pass
    return conv_id[:8]


def _is_pid_alive(pid):
    if pid <= 0:
        return False
    try:
        SYNCHRONIZE = 0x00100000
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        h = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
        if not h:
            return False
        STILL_ACTIVE = 259
        exit_code = ctypes.c_ulong()
        ok = ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(exit_code))
        ctypes.windll.kernel32.CloseHandle(h)
        return bool(ok and exit_code.value == STILL_ACTIVE)
    except Exception:
        return False


def is_desktop_pet_running():
    global DESKTOP_PET_PROC
    if DESKTOP_PET_PROC is not None:
        if DESKTOP_PET_PROC.poll() is None:
            return True
        DESKTOP_PET_PROC = None
    if os.path.exists(PID_FILE):
        try:
            with open(PID_FILE, "r", encoding="ascii", errors="ignore") as f:
                pid = int(f.read().strip())
            if _is_pid_alive(pid):
                return True
        except Exception:
            pass
    return False


_LS_CACHE = {"port": 0, "csrf": "", "last_sync": 0.0, "quotas": {}, "detected_model": None}

def _discover_ls_candidates():
    found = []
    try:
        ps_cmd = (
            "Get-CimInstance Win32_Process -Filter \"Name LIKE 'language_server%'\" | ForEach-Object { "
            "$p = $_.ProcessId; $c = $_.CommandLine; "
            "if ($c -match '--csrf_token[=\\s]+([a-fA-F0-9\\-]+)') { "
            "$t = $Matches[1]; "
            "Get-NetTCPConnection -OwningProcess $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { "
            "Write-Output \"$($_.LocalPort)|$t\" } } }"
        )
        out = subprocess.check_output(
            ["powershell.exe", "-NoProfile", "-Command", ps_cmd],
            timeout=2.5,
            creationflags=0x08000000
        ).decode("utf-8", errors="ignore")
        for line in out.splitlines():
            if "|" in line:
                pt, tk = line.strip().split("|", 1)
                cand = (int(pt), tk.strip())
                if cand not in found:
                    found.append(cand)
    except Exception:
        pass
    return found


def _try_fetch_quotas_from_candidates(candidates, bridge_path):
    import math
    for port, csrf in candidates:
        sum_url = f"http://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary"
        sum_req = urllib.request.Request(
            sum_url,
            data=b"{}",
            headers={
                "Content-Type": "application/json",
                "Connect-Protocol-Version": "1",
                "x-codeium-csrf-token": csrf
            },
            method="POST"
        )
        try:
            with urllib.request.urlopen(sum_req, timeout=1.2) as resp:
                sdata = json.loads(resp.read().decode("utf-8"))
            groups = sdata.get("response", {}).get("groups", [])
            if groups:
                _LS_CACHE["port"] = port
                _LS_CACHE["csrf"] = csrf
                save_json(bridge_path, {"port": port, "csrf": csrf})
                bmap = {}
                for g in groups:
                    for b in g.get("buckets", []):
                        bid = str(b.get("bucketId") or "")
                        frac = float(b.get("remainingFraction") or 0.0)
                        pct = max(0, min(100, int(math.ceil(frac * 100.0))))
                        rtime = str(b.get("resetTime") or "")
                        win = str(b.get("window") or "")
                        rdisp = "重置 --:--"
                        if rtime:
                            try:
                                rdt = datetime.fromisoformat(rtime.replace("Z", "+00:00")).astimezone()
                                rdisp = "重置 " + (rdt.strftime("%m-%d %H:%M") if win == "weekly" else rdt.strftime("%H:%M"))
                            except Exception:
                                pass
                        bmap[bid] = {"pct": pct, "reset": rdisp}

                g5 = bmap.get("gemini-5h", {"pct": 100, "reset": "重置 --:--"})
                gw = bmap.get("gemini-weekly", {"pct": 100, "reset": "重置 --:--"})
                aw = bmap.get("gemini-argon-wtu-weekly", {"pct": 100, "reset": "重置 --:--"})
                c5 = bmap.get("3p-5h", {"pct": 100, "reset": "重置 --:--"})
                cw = bmap.get("3p-weekly", {"pct": 100, "reset": "重置 --:--"})

                quotas = {
                    "gemini-3.8-flash": {"pct_5h": g5["pct"], "reset_5h": g5["reset"], "pct_7d": gw["pct"], "reset_7d": gw["reset"]},
                    "gemini-4-argon": {"pct_5h": aw["pct"], "reset_5h": "同周限额", "pct_7d": aw["pct"], "reset_7d": aw["reset"]},
                    "claude-opus-5-5": {"pct_5h": c5["pct"], "reset_5h": c5["reset"], "pct_7d": cw["pct"], "reset_7d": cw["reset"]},
                    "claude-sonnet-5-5": {"pct_5h": c5["pct"], "reset_5h": c5["reset"], "pct_7d": cw["pct"], "reset_7d": cw["reset"]},
                }
                _LS_CACHE["quotas"] = quotas
                return quotas
        except Exception:
            if port == _LS_CACHE["port"]:
                _LS_CACHE["port"] = 0
                _LS_CACHE["csrf"] = ""
    return None


def fetch_live_antigravity_quotas():
    now = time.time()
    if now - _LS_CACHE["last_sync"] < 3.0 and _LS_CACHE["quotas"]:
        return _LS_CACHE["quotas"]
    _LS_CACHE["last_sync"] = now

    candidates = []
    if _LS_CACHE["port"] > 0 and _LS_CACHE["csrf"]:
        candidates.append((_LS_CACHE["port"], _LS_CACHE["csrf"]))
    bridge_path = os.path.join(PLUGIN_DIR, "config", "ls_bridge.json")
    if os.path.exists(bridge_path):
        try:
            b = load_json(bridge_path, {})
            if b.get("port") and b.get("csrf"):
                cand = (int(b["port"]), str(b["csrf"]))
                if cand not in candidates:
                    candidates.append(cand)
        except Exception:
            pass

    if candidates:
        res = _try_fetch_quotas_from_candidates(candidates, bridge_path)
        if res:
            return res

    fresh_candidates = [c for c in _discover_ls_candidates() if c not in candidates]
    if fresh_candidates:
        res = _try_fetch_quotas_from_candidates(fresh_candidates, bridge_path)
        if res:
            return res

    return _LS_CACHE["quotas"]


class _STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ("cb", ctypes.c_ulong),
        ("lpReserved", ctypes.c_wchar_p),
        ("lpDesktop", ctypes.c_wchar_p),
        ("lpTitle", ctypes.c_wchar_p),
        ("dwX", ctypes.c_ulong),
        ("dwY", ctypes.c_ulong),
        ("dwXSize", ctypes.c_ulong),
        ("dwYSize", ctypes.c_ulong),
        ("dwXCountChars", ctypes.c_ulong),
        ("dwYCountChars", ctypes.c_ulong),
        ("dwFillAttribute", ctypes.c_ulong),
        ("dwFlags", ctypes.c_ulong),
        ("wShowWindow", ctypes.c_ushort),
        ("cbReserved2", ctypes.c_ushort),
        ("lpReserved2", ctypes.c_void_p),
        ("hStdInput", ctypes.c_void_p),
        ("hStdOutput", ctypes.c_void_p),
        ("hStdError", ctypes.c_void_p),
    ]

class _PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("hProcess", ctypes.c_void_p),
        ("hThread", ctypes.c_void_p),
        ("dwProcessId", ctypes.c_ulong),
        ("dwThreadId", ctypes.c_ulong),
    ]


def start_desktop_pet():
    global DESKTOP_PET_PROC
    if is_desktop_pet_running():
        return True
    if not os.path.exists(WIDGET_PS1):
        return False
    try:
        # Always target interactive user desktop WinSta0\Default so the pet is visible even when Sidecar runs in exebox!
        si = _STARTUPINFOW()
        si.cb = ctypes.sizeof(_STARTUPINFOW)
        si.lpDesktop = "WinSta0\\Default"
        si.dwFlags = 0x00000001  # STARTF_USESHOWWINDOW
        si.wShowWindow = 0       # SW_HIDE console window
        pi = _PROCESS_INFORMATION()
        cmd = f'powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{WIDGET_PS1}"'
        cmd_buf = ctypes.create_unicode_buffer(cmd)
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        CREATE_NO_WINDOW = 0x08000000
        ok = ctypes.windll.kernel32.CreateProcessW(
            None,
            cmd_buf,
            None,
            None,
            False,
            CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
            None,
            PLUGIN_DIR,
            ctypes.byref(si),
            ctypes.byref(pi)
        )
        if ok:
            try:
                with open(PID_FILE, "w", encoding="ascii") as f:
                    f.write(str(pi.dwProcessId))
            except Exception:
                pass
            ctypes.windll.kernel32.CloseHandle(pi.hThread)
            ctypes.windll.kernel32.CloseHandle(pi.hProcess)
            return True
    except Exception:
        pass
    vbs = os.path.join(PLUGIN_DIR, "scripts", "Launch-Hakimi.vbs")
    if os.path.exists(vbs):
        try:
            subprocess.Popen(["wscript.exe", vbs], cwd=PLUGIN_DIR)
            return True
        except Exception:
            pass

    try:
        flags = 0x00000200
        DESKTOP_PET_PROC = subprocess.Popen(
            ["powershell.exe", "-STA", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", WIDGET_PS1],
            cwd=PLUGIN_DIR,
            creationflags=flags,
            close_fds=True
        )
        return True
    except Exception:
        return False



USER_MANUALLY_STOPPED = False


def _is_antigravity_process(pid):
    try:
        hProc = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if hProc:
            buf = ctypes.create_unicode_buffer(512)
            size = ctypes.wintypes.DWORD(512)
            ctypes.windll.kernel32.QueryFullProcessImageNameW(hProc, 0, buf, ctypes.byref(size))
            ctypes.windll.kernel32.CloseHandle(hProc)
            name = os.path.basename(buf.value).lower()
            return "antigravity" in name
    except Exception:
        pass
    return False


def has_antigravity_window():
    try:
        hdesk = ctypes.windll.user32.OpenDesktopW("Default", 0, False, 0x10000000)
        if not hdesk:
            hdesk = ctypes.windll.user32.OpenInputDesktop(0, False, 0x10000000)
        if not hdesk:
            return False

        found = [False]
        WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)

        def cb(hwnd, _):
            try:
                if not ctypes.windll.user32.IsWindow(hwnd):
                    return True
                is_vis = ctypes.windll.user32.IsWindowVisible(hwnd)
                is_ico = ctypes.windll.user32.IsIconic(hwnd)
                if not (is_vis or is_ico):
                    return True

                length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
                if length > 0:
                    buf = ctypes.create_unicode_buffer(length + 1)
                    ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
                    title = buf.value
                    if "Gemini Hakimi" not in title:
                        if "antigrav" in title.lower() or "反重力" in title:
                            found[0] = True
                            return False
                        pid = ctypes.wintypes.DWORD()
                        ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                        if pid.value > 0 and _is_antigravity_process(pid.value):
                            rect = (ctypes.c_int * 4)()
                            ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect))
                            w = rect[2] - rect[0]
                            h = rect[3] - rect[1]
                            if (w >= 300 and h >= 200) or is_ico:
                                found[0] = True
                                return False
            except Exception:
                pass
            return True

        ctypes.windll.user32.EnumDesktopWindows(hdesk, WNDENUMPROC(cb), 0)
        ctypes.windll.user32.CloseDesktop(hdesk)
        return found[0]
    except Exception:
        return False


def _companion_watcher_loop():
    r"""Background companion watcher that manages automatic desktop pet life-cycle."""
    global USER_MANUALLY_STOPPED
    while True:
        try:
            time.sleep(1.5)
            has_host = has_antigravity_window()
            if not has_host:
                # Host closed -> Reset manual stop so it auto-launches on next Antigravity start!
                USER_MANUALLY_STOPPED = False
            else:
                cfg = get_config()
                # If either auto-launch or companion follow is enabled
                if cfg.get("auto_launch_desktop_pet") or cfg.get("hide_with_antigravity"):
                    if not is_desktop_pet_running() and not USER_MANUALLY_STOPPED:
                        print("[HakimiCompanion] Antigravity window active, auto-launching desktop pet on WinSta0\\Default...", flush=True)
                        start_desktop_pet()
        except Exception:
            pass

def stop_desktop_pet():
    global DESKTOP_PET_PROC
    if DESKTOP_PET_PROC is not None:
        try:
            DESKTOP_PET_PROC.terminate()
        except Exception:
            pass
        DESKTOP_PET_PROC = None
    if os.path.exists(PID_FILE):
        try:
            with open(PID_FILE, "r", encoding="ascii", errors="ignore") as f:
                pid = int(f.read().strip())
            if _is_pid_alive(pid):
                os.kill(pid, signal.SIGTERM)
        except Exception:
            pass
        try:
            os.remove(PID_FILE)
        except Exception:
            pass
    return False


def collect_stats(requested_conv_id=None):
    cfg = get_config()
    pricing = get_pricing()
    detected_model = detect_antigravity_active_model()
    models_dict = pricing.get("models", {})
    active_model = cfg.get("active_model")
    if not active_model or active_model not in models_dict:
        active_model = detected_model if detected_model in models_dict else "gemini-3.8-flash"
    active_plan = cfg.get("active_plan", "free")
    fallback_info = {"display_name": active_model, "context_window": 1048576, "tiers": [{"hit": 0.075, "miss": 0.75, "out": 3.75}]}
    model_info = models_dict.get(active_model, fallback_info)
    ctx_window = int(model_info.get("context_window") or pricing.get("context_window") or 1048576)
    limits_cfg = pricing.get("limits", {}).get(active_plan, {"rpm": 15, "tpm": 1000000, "rpd": 1500})

    pattern = os.path.join(BRAIN_DIR, "*", ".system_generated", "logs", "transcript.jsonl")
    files = glob.glob(pattern)
    files.sort(key=lambda p: os.path.getmtime(p) if os.path.exists(p) else 0, reverse=True)

    now_utc = datetime.now(timezone.utc)
    today_utc_str = now_utc.strftime("%Y-%m-%d")
    today_local_str = datetime.now().strftime("%Y-%m-%d")
    now_ts = time.time()

    active_entry = None
    if requested_conv_id and requested_conv_id not in ("", "current", "null", "undefined"):
        target_path = os.path.join(BRAIN_DIR, requested_conv_id, ".system_generated", "logs", "transcript.jsonl")
        if os.path.exists(target_path):
            active_entry = parse_transcript_file(target_path)

    if active_entry is None and files:
        active_entry = parse_transcript_file(files[0])

    t_turns = 0
    t_inp = 0
    t_cache = 0
    t_out = 0
    rpm_count = 0
    tpm_tokens = 0

    featured_models = ["gemini-4-argon", "gemini-3.8-flash", "claude-opus-5-5", "claude-sonnet-5-5"]
    model_buckets = {mk: {"t5": 0, "tok5": 0, "t7": 0, "tok7": 0} for mk in featured_models}
    oldest_5h_ts = None
    oldest_7d_ts = None

    for fp in files:
        try:
            mtime = os.path.getmtime(fp)
        except OSError:
            continue
        if now_ts - mtime > 7 * 86400:
            break
        entry = parse_transcript_file(fp)
        if not entry:
            continue
        for s in entry["steps"]:
            c_str = s["created_at"][:10]
            if c_str in (today_utc_str, today_local_str):
                t_turns += 1
                t_inp += s["input_tokens"]
                t_cache += s["cache_read_tokens"]
                t_out += s["output_tokens"]
            ts = s["ts"]
            if ts > 0:
                age = now_ts - ts
                if age <= 60.0:
                    rpm_count += 1
                    tpm_tokens += s["total_tokens"]
                if age <= 7 * 86400:
                    if oldest_7d_ts is None or ts < oldest_7d_ts:
                        oldest_7d_ts = ts
                    eff_tok = s["input_tokens"] + s["output_tokens"] + int(s["cache_read_tokens"] * 0.08)
                    cid = entry.get("conv_id") or ""
                    attr_m = get_conv_model(cid) or detected_model
                    if attr_m in model_buckets:
                        model_buckets[attr_m]["t7"] += 1
                        model_buckets[attr_m]["tok7"] += eff_tok
                        if age <= 5 * 3600:
                            if oldest_5h_ts is None or ts < oldest_5h_ts:
                                oldest_5h_ts = ts
                            model_buckets[attr_m]["t5"] += 1
                            model_buckets[attr_m]["tok5"] += eff_tok

    today_cost = calculate_cost(t_inp, t_cache, t_out, active_model, pricing)
    today_hit_rate = round((t_cache / (t_inp + t_cache)) * 100, 1) if (t_inp + t_cache) > 0 else 0.0

    s_conv_id = active_entry["conv_id"] if active_entry else ""
    s_steps = active_entry["steps"] if active_entry else []
    s_inp = sum(x["input_tokens"] for x in s_steps)
    s_cache = sum(x["cache_read_tokens"] for x in s_steps)
    s_out = sum(x["output_tokens"] for x in s_steps)
    s_tot = s_inp + s_cache + s_out
    s_cost = calculate_cost(s_inp, s_cache, s_out, active_model, pricing)
    s_hit_rate = round((s_cache / (s_inp + s_cache)) * 100, 1) if (s_inp + s_cache) > 0 else 0.0

    if s_steps:
        last_s = s_steps[-1]
        lt_cost = calculate_cost(last_s["input_tokens"], last_s["cache_read_tokens"], last_s["output_tokens"], active_model, pricing)
        last_turn = {
            "step_index": last_s["step_index"],
            "input_tokens": last_s["input_tokens"],
            "cache_read_tokens": last_s["cache_read_tokens"],
            "output_tokens": last_s["output_tokens"],
            "total_tokens": last_s["total_tokens"],
            "cache_hit_rate": last_s["cache_hit_rate"],
            "cost_usd": lt_cost["cost_usd"],
            "cost_cny": lt_cost["cost_cny"],
            "savings_usd": lt_cost["savings_usd"],
            "savings_cny": lt_cost["savings_cny"],
            "created_at": last_s["created_at"]
        }
        cur_ctx = last_s["total_tokens"]
    else:
        last_turn = {
            "step_index": 0,
            "input_tokens": 0,
            "cache_read_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "cache_hit_rate": 0.0,
            "cost_usd": 0.0,
            "cost_cny": 0.0,
            "savings_usd": 0.0,
            "savings_cny": 0.0,
            "created_at": ""
        }
        cur_ctx = 0

    ctx_pct = round((cur_ctx / ctx_window) * 100, 1) if ctx_window > 0 else 0.0

    recent_turns = []
    for idx, st_item in enumerate(s_steps[-12:]):
        turn_num = max(1, len(s_steps) - len(s_steps[-12:]) + idx + 1)
        c_item = calculate_cost(st_item["input_tokens"], st_item["cache_read_tokens"], st_item["output_tokens"], active_model, pricing)
        recent_turns.append({
            "turn": turn_num,
            "step_index": st_item["step_index"],
            "input_tokens": st_item["input_tokens"],
            "cache_read_tokens": st_item["cache_read_tokens"],
            "output_tokens": st_item["output_tokens"],
            "total_tokens": st_item["total_tokens"],
            "cache_hit_rate": st_item["cache_hit_rate"],
            "cost_cny": c_item["cost_cny"],
            "savings_cny": c_item["savings_cny"],
            "query": st_item.get("query") or ""
        })
    recent_turns.reverse()

    tomorrow_utc = (now_utc + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    diff_sec = max(0, int((tomorrow_utc - now_utc).total_seconds()))
    rem_h = diff_sec // 3600
    rem_m = (diff_sec % 3600) // 60
    rem_s = diff_sec % 60
    reset_countdown = f"{rem_h:02d}:{rem_m:02d}:{rem_s:02d}"

    models_list = [
        {"id": k, "name": v.get("display_name", k), "note": v.get("note", "")}
        for k, v in pricing.get("models", {}).items()
    ]

    mult = float(limits_cfg.get("quota_multiplier", 5.0 if active_plan == "tier1" else 1.0))
    reset_5h_dt = datetime.fromtimestamp((oldest_5h_ts + 5 * 3600) if oldest_5h_ts else (now_ts + 5 * 3600))
    reset_5h_str = "重置 " + reset_5h_dt.strftime("%H:%M")
    reset_7d_dt = datetime.fromtimestamp((oldest_7d_ts + 7 * 86400) if oldest_7d_ts else (now_ts + 7 * 86400))
    reset_7d_str = "重置 " + reset_7d_dt.strftime("%m-%d %H:%M")

    live_quotas = fetch_live_antigravity_quotas()
    model_quotas = []
    active_5h = {"remaining_pct": 100, "used_turns": 0, "limit_turns": 1500, "reset_display": reset_5h_str}
    active_7d = {"remaining_pct": 100, "used_turns": 0, "limit_turns": 9000, "reset_display": reset_7d_str}

    for mk in featured_models:
        minfo = pricing.get("models", {}).get(mk)
        if not minfo:
            continue
        b = model_buckets.get(mk, {"t5": 0, "tok5": 0, "t7": 0, "tok7": 0})
        l5_t = max(1, int(round(int(minfo.get("quota_5h_turns", 1200)) * mult)))
        l5_tok = max(1, int(round(int(minfo.get("quota_5h_tokens", 45000000)) * mult)))
        l7_t = max(1, int(round(int(minfo.get("quota_weekly_turns", 7000)) * mult)))
        l7_tok = max(1, int(round(int(minfo.get("quota_weekly_tokens", 280000000)) * mult)))

        u5 = min(100, max(0, int(round(max((b["t5"] / l5_t) * 100.0, (b["tok5"] / l5_tok) * 100.0)))))
        u7 = min(100, max(0, int(round(max((b["t7"] / l7_t) * 100.0, (b["tok7"] / l7_tok) * 100.0)))))
        rem5 = max(0, 100 - u5)
        rem7 = max(0, 100 - u7)
        r5_str = reset_5h_str
        r7_str = reset_7d_str

        weekly_live_reset = next((v["reset"] for v in live_quotas.values() if v.get("is_weekly") and v.get("reset")), reset_7d_str)
        five_live_reset = next((v["reset"] for v in live_quotas.values() if not v.get("is_weekly") and v.get("reset")), reset_5h_str)
        r5_str = five_live_reset
        r7_str = weekly_live_reset
        if mk in live_quotas:
            lq = live_quotas[mk]
            if "pct_5h" in lq and "pct_7d" in lq:
                rem5 = int(lq["pct_5h"])
                r5_str = str(lq["reset_5h"])
                rem7 = int(lq["pct_7d"])
                r7_str = str(lq["reset_7d"])
            elif lq.get("is_weekly"):
                rem7 = int(lq["pct"])
                r7_str = str(lq["reset"])
                rem5 = 0 if rem7 == 0 else rem7
                r5_str = "同周限额"
            else:
                rem5 = int(lq["pct"])
                r5_str = str(lq["reset"])

        mq_item = {
            "id": mk,
            "name": minfo.get("display_name", mk),
            "short_name": minfo.get("short_name", mk),
            "badge": minfo.get("badge", "PRO"),
            "is_active": (mk == active_model),
            "five_hour_remaining_pct": rem5,
            "five_hour_used_turns": b["t5"],
            "five_hour_limit_turns": l5_t,
            "five_hour_reset": r5_str,
            "weekly_remaining_pct": rem7,
            "weekly_used_turns": b["t7"],
            "weekly_limit_turns": l7_t,
            "weekly_reset": r7_str
        }
        model_quotas.append(mq_item)
        if mk == active_model:
            active_5h = {"remaining_pct": rem5, "used_turns": b["t5"], "limit_turns": l5_t, "reset_display": r5_str}
            active_7d = {"remaining_pct": rem7, "used_turns": b["t7"], "limit_turns": l7_t, "reset_display": r7_str}

    return {
        "five_hour": active_5h,
        "weekly": active_7d,
        "model_quotas": model_quotas,
        "ok": True,
        "config": {
            "active_model": active_model,
            "active_model_name": model_info.get("display_name", active_model),
            "active_plan": active_plan,
            "sound_enabled": bool(cfg.get("sound_enabled", True)),
            "cache_sound_enabled": bool(cfg.get("cache_sound_enabled", False)),
            "speech_bubble_enabled": bool(cfg.get("speech_bubble_enabled", True)),
            "auto_launch_desktop_pet": bool(cfg.get("auto_launch_desktop_pet", False)),
            "follow_antigravity": bool(cfg.get("follow_antigravity", True)),
            "hide_with_antigravity": bool(cfg.get("hide_with_antigravity", True))
        },
        "models": models_list,
        "desktop_pet_running": is_desktop_pet_running(),
        "last_turn": last_turn,
        "session": {
            "conv_id": s_conv_id,
            "title": get_conversation_title(s_conv_id),
            "turns": len(s_steps),
            "input_tokens": s_inp,
            "cache_read_tokens": s_cache,
            "output_tokens": s_out,
            "total_tokens": s_tot,
            "cache_hit_rate": s_hit_rate,
            "current_context": cur_ctx,
            "context_pct": ctx_pct,
            "cost_usd": s_cost["cost_usd"],
            "cost_cny": s_cost["cost_cny"],
            "savings_usd": s_cost["savings_usd"],
            "savings_cny": s_cost["savings_cny"],
            "recent_turns": recent_turns
        },
        "today": {
            "turns": t_turns,
            "input_tokens": t_inp,
            "cache_read_tokens": t_cache,
            "output_tokens": t_out,
            "total_tokens": t_inp + t_cache + t_out,
            "cache_hit_rate": today_hit_rate,
            "cost_usd": today_cost["cost_usd"],
            "cost_cny": today_cost["cost_cny"],
            "savings_usd": today_cost["savings_usd"],
            "savings_cny": today_cost["savings_cny"]
        },
        "rate_limits": {
            "current_rpm": rpm_count,
            "max_rpm": int(limits_cfg.get("rpm", 15)),
            "current_tpm": tpm_tokens,
            "max_tpm": int(limits_cfg.get("tpm", 1000000)),
            "current_rpd": t_turns,
            "max_rpd": int(limits_cfg.get("rpd", 1500)),
            "context_window": ctx_window,
            "reset_countdown": reset_countdown
        }
    }


MIME_MAP = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml"
}


class HakimiSidecarHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def _send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Sidecar-Token")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path in ("/", "/ui.html"):
            ui_file = os.path.join(SIDE_DIR, "ui.html")
            if os.path.exists(ui_file):
                with open(ui_file, "rb") as f:
                    content = f.read()
                self.send_response(200)
                self._send_cors()
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(content)
                return

        if path == "/preload.js":
            content = b"// Sidecar preload bridge\n"
            if os.path.exists(PRELOAD_JS_SDK):
                try:
                    with open(PRELOAD_JS_SDK, "rb") as f:
                        content = f.read()
                except Exception:
                    pass
            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.end_headers()
            self.wfile.write(content)
            return

        if path == "/health":
            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "plugin": "gemini-hakimi-widget"}).encode("utf-8"))
            return

        if path == "/api/quotes":
            quotes = load_json(QUOTES_PATH, {})
            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(quotes, ensure_ascii=False).encode("utf-8"))
            return

        if path == "/api/stats":
            params = urllib.parse.parse_qs(parsed.query)
            cid = params.get("conversationId", [None])[0]
            data = collect_stats(cid)
            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))
            return

        if path.startswith("/assets/"):
            rel = path[len("/assets/"):].lstrip("/\\")
            full_path = os.path.abspath(os.path.join(ASSETS_DIR, rel))
            if full_path.startswith(os.path.abspath(ASSETS_DIR)) and os.path.isfile(full_path):
                ext = os.path.splitext(full_path)[1].lower()
                ctype = MIME_MAP.get(ext, "application/octet-stream")
                with open(full_path, "rb") as f:
                    data = f.read()
                self.send_response(200)
                self._send_cors()
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "public, max-age=3600")
                self.end_headers()
                self.wfile.write(data)
                return

        self.send_response(404)
        self._send_cors()
        self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8") if content_length > 0 else "{}"
        try:
            payload = json.loads(body) if body.strip() else {}
        except Exception:
            payload = {}

        if path == "/api/config":
            cfg = get_config()
            for k in ("active_model", "active_plan", "sound_enabled", "cache_sound_enabled", "speech_bubble_enabled", "auto_launch_desktop_pet", "follow_antigravity", "hide_with_antigravity"):
                if k in payload:
                    cfg[k] = payload[k]
            save_json(CONFIG_PATH, cfg)
            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(collect_stats(payload.get("conversationId")), ensure_ascii=False).encode("utf-8"))
            return

        if path == "/api/desktop-pet":
            global USER_MANUALLY_STOPPED
            action = payload.get("action", "toggle")
            running = is_desktop_pet_running()
            if action == "manual_exit" or action == "stop" or (action == "toggle" and running):
                USER_MANUALLY_STOPPED = True
                now_running = stop_desktop_pet()
            else:
                USER_MANUALLY_STOPPED = False
                now_running = start_desktop_pet()
            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "desktop_pet_running": now_running}).encode("utf-8"))
            return

        self.send_response(404)
        self._send_cors()
        self.end_headers()


def write_server_info(port):
    token = (
        os.environ.get("ANTIGRAVITY_SIDECAR_UI_TOKEN")
        or os.environ.get("ANTIGRAVITY_SIDECAR_AUTH_TOKEN")
        or os.environ.get("ANTIGRAVITY_SIDECAR_WEB_TOKEN")
    )
    info = {
        "host": "127.0.0.1",
        "port": port,
        "token": token,
        "pid": os.getpid()
    }
    candidates = [
        os.path.join(AGY_DIR, "sidecar_data", "gemini-hakimi-widget", "hakimi_panel", "data", "server_info.json"),
        os.path.join(AGY_DIR, "sidecar_data", "hakimi_panel", "data", "server_info.json")
    ]
    env_dir = os.environ.get("ANTIGRAVITY_EXECUTABLE_DATA_DIR")
    if env_dir:
        candidates.insert(0, os.path.join(env_dir, "server_info.json"))
    for p in candidates:
        try:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                json.dump(info, f, indent=2)
        except Exception:
            pass


def main():
    port_env = os.environ.get("ANTIGRAVITY_SIDECAR_WEB_PORT") or os.environ.get("PORT")
    port = int(port_env) if port_env else 39282

    cfg = get_config()
    if cfg.get("auto_launch_desktop_pet"):
        start_desktop_pet()

    # Start companion auto-revive watcher loop
    threading.Thread(target=_companion_watcher_loop, daemon=True).start()

    server = ThreadingHTTPServer(("127.0.0.1", port), HakimiSidecarHandler)
    write_server_info(port)
    if port != 54716:
        try:
            compat_srv = ThreadingHTTPServer(("127.0.0.1", 54716), HakimiSidecarHandler)
            threading.Thread(target=compat_srv.serve_forever, daemon=True).start()
            print("[HakimiSidecar] Also bound compatibility port 54716", flush=True)
        except Exception:
            pass
    print(f"[HakimiSidecar] Ready on http://127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
